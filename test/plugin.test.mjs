import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import TokenHarborProviderPlugin from '../index.mjs';

test('provider and package discovery expose the TokenHarbor icon', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const svg = await readFile(new URL('../tokenharbor.svg', import.meta.url), 'utf8');
  const packageIcon = pkg['magpie'].icon;

  assert.match(packageIcon, /^data:image\/svg\+xml;base64,/);
  assert.equal(hooks.auth.icon, packageIcon);
  assert.equal(Buffer.from(packageIcon.split(',')[1], 'base64').toString('utf8'), svg);
  assert.ok(pkg.files.includes('tokenharbor.svg'));
  assert.match(svg, /<title[^>]*>Rudder\.chat sail logo for-light<\/title>/);
  assert.match(svg, /<svg\b[^>]*width="808"[^>]*height="808"[^>]*viewBox="96 96 808 808"/);
  assert.match(svg, /<rect x="96" y="96" width="808" height="808" rx="150" fill="#F8F6F2"\/>/);
});
import { ALLOWANCE_URL, API_BASE_URL, PROVIDER_ID } from '../lib/tokenharbor.mjs';

const secretSentinel = 'synthetic-key-must-not-leak';
const quotaPayload = (overrides = {}) => ({
  plan_name: 'Pass Plus',
  on_plan: true,
  plan_used_pct: 37,
  plan_exhausted: false,
  used_pct: 18,
  exhausted: false,
  activated: true,
  period_started_at: '2026-11-09T00:00:00Z',
  period_ends_at: '2026-11-16T00:00:00Z',
  reset_at: '2026-11-16T00:00:00Z',
  models: ['model-free-a'],
  models_enabled: true,
  legacy_balance: 99,
  ...overrides,
});

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('exports a host provider, standard API-key login, loader, and Usage hook', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  assert.equal(typeof hooks.config, 'function');
  assert.equal(hooks.auth.provider, 'tokenharbor');
  assert.deepEqual(hooks.auth.methods[0], {
    type: 'api',
    label: 'TokenHarbor API key',
    placeholder: 'Paste your TokenHarbor API key',
  });

  const config = {};
  await hooks.config(config);
  assert.equal(config.provider.tokenharbor.name, 'TokenHarbor');
  assert.equal(config.provider.tokenharbor.npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider.tokenharbor.options.baseURL, 'https://tokenharbor.ai/v1');
  assert.deepEqual(config.provider.tokenharbor.models, {
    'th-orchestra': { name: 'TH Orchestra', tool_call: true },
  });

  const userConfig = { provider: { tokenharbor: { name: 'My TokenHarbor', options: { customOption: true }, models: { 'th-orchestra': { name: 'My Orchestra' }, customModel: { name: 'Custom model' } } } } };
  await hooks.config(userConfig);
  assert.equal(userConfig.provider.tokenharbor.name, 'My TokenHarbor');
  assert.equal(userConfig.provider.tokenharbor.npm, '@ai-sdk/openai-compatible');
  assert.equal(userConfig.provider.tokenharbor.options.baseURL, 'https://tokenharbor.ai/v1');
  assert.equal(userConfig.provider.tokenharbor.options.customOption, true);
  assert.deepEqual(userConfig.provider.tokenharbor.models['th-orchestra'], { name: 'My Orchestra', tool_call: true });
  assert.deepEqual(userConfig.provider.tokenharbor.models.customModel, { name: 'Custom model' });
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: 'api', key: secretSentinel })), {
    apiKey: secretSentinel,
    baseURL: 'https://tokenharbor.ai/v1',
  });
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: 'oauth' })), {});
});

test('Usage hook calls only the documented allowance endpoint and returns both quota windows', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  let request;
  const usage = await withFetch(async (url, options) => {
    request = { url, options };
    return jsonResponse(quotaPayload());
  }, () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));

  assert.equal(request.url, ALLOWANCE_URL);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.authorization, `Bearer ${secretSentinel}`);
  assert.equal(request.url.includes(secretSentinel), false);
  assert.equal(usage.plan, 'Pass Plus');
  assert.deepEqual(usage.windows.map(({ name, used, resetsAt, aside }) => ({ name, used, resetsAt, aside })), [
    { name: 'Pass Plus · 7 days', used: 37, resetsAt: '2026-11-16T00:00:00.000Z', aside: true },
    { name: 'Free models · 7 days', used: 18, resetsAt: '2026-11-16T00:00:00.000Z', aside: true },
  ]);
  assert.deepEqual(usage.windows[1].models, ['model-free-a']);
  assert.equal('balance' in usage, false);
  assert.equal(JSON.stringify(usage).includes('legacy_balance'), false);
  assert.equal(JSON.stringify(usage).includes(secretSentinel), false);
});

test('the documented exhaustion flags decide state even at rounded 100 percent', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const usage = await withFetch(async () => jsonResponse(quotaPayload({
    plan_used_pct: 100,
    plan_exhausted: false,
    used_pct: 7,
    exhausted: true,
  })), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));

  assert.equal(usage.windows[0].used, 100);
  assert.equal(usage.windows[0].display, '100% used · approximately 0% remaining · available');
  assert.equal(usage.windows[1].used, 7);
  assert.equal(usage.windows[1].display, '7% used · approximately 93% remaining · exhausted');
});

test('aside quota display includes approximate remaining percentage at zero usage', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const usage = await withFetch(async () => jsonResponse(quotaPayload({
    on_plan: false,
    used_pct: 0,
    exhausted: false,
  })), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].used, 0);
  assert.equal(usage.windows[0].aside, true);
  assert.equal(usage.windows[0].display, '0% used · approximately 100% remaining · available');
});

test('usage forwards the host abort signal and hides cancellation as stale output', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const controller = new AbortController();
  let receivedSignal;
  const result = await withFetch(async (_url, options) => {
    receivedSignal = options.signal;
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  }, () => hooks.auth.usage(
    async () => ({ type: 'api', key: secretSentinel }),
    undefined,
    { signal: controller.signal },
  ));

  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(result, { windows: [] });
});

test('one plugin instance reads the live English usage option and preserves quota semantics', async () => {
  let englishUsage = false;
  const hooks = await TokenHarborProviderPlugin({
    magpie: {
      option(provider, key) {
        assert.equal(provider, PROVIDER_ID);
        assert.equal(key, 'english-usage');
        return englishUsage;
      },
    },
  });
  const getAuth = async () => ({ type: 'api', key: secretSentinel });
  const read = (payload) => withFetch(async () => jsonResponse(payload), () => hooks.auth.usage(getAuth));

  assert.equal(hooks.auth.options[0].default, false);
  assert.equal(hooks.auth.options[0].labels.zh, '英文用量文案');
  assert.equal(hooks.auth.options[0].labels['zh-TW'], '英文用量文字');
  assert.ok(hooks.auth.options[0].descriptions.zh.includes('显示英文'));
  const chinese = await read(quotaPayload({
    plan_name: 'Agent Pass',
    plan_used_pct: 1,
    plan_exhausted: false,
    used_pct: 100,
    exhausted: true,
  }));
  assert.equal(chinese.windows[0].name, 'Agent Pass · 7 天');
  assert.equal(chinese.windows[0].display, '已用 1% · 约剩余 99% · 可用');
  assert.equal(chinese.windows[0].used, 1);
  assert.equal(chinese.windows[0].aside, true);
  assert.equal(chinese.windows[0].span, 604800);
  assert.equal(chinese.windows[0].resetsAt, '2026-11-16T00:00:00.000Z');
  assert.equal(chinese.windows[1].name, '免费模型 · 7 天');
  assert.equal(chinese.windows[1].display, '已用 100% · 约剩余 0% · 已耗尽');
  assert.deepEqual(chinese.windows[1].models, ['model-free-a']);
  assert.equal(chinese.windows[1].aside, true);

  englishUsage = true;
  const english = await read(quotaPayload({
    plan_name: 'Agent Pass',
    plan_used_pct: 1,
    plan_exhausted: false,
    used_pct: 100,
    exhausted: true,
  }));
  assert.equal(english.windows[0].name, 'Agent Pass · 7 days');
  assert.equal(english.windows[0].display, '1% used · approximately 99% remaining · available');
  assert.equal(english.windows[1].name, 'Free models · 7 days');
  assert.equal(english.windows[1].display, '100% used · approximately 0% remaining · exhausted');

  englishUsage = false;
  const chineseAgain = await read(quotaPayload({ plan_name: 'Agent Pass' }));
  assert.equal(chineseAgain.windows[0].name, 'Agent Pass · 7 天');

  const freeTier = await read(quotaPayload({
    on_plan: false,
    activated: true,
    models_enabled: true,
  }));
  assert.equal(freeTier.plan, '免费套餐');
  const noPlan = await read(quotaPayload({
    on_plan: false,
    activated: false,
    models_enabled: false,
  }));
  assert.equal(noPlan.plan, '没有活动套餐');
  const disabledModels = await read(quotaPayload({
    on_plan: false,
    activated: true,
    models_enabled: false,
  }));
  assert.equal(disabledModels.plan, '免费模型已停用');
  const unknownPlan = await read(quotaPayload({
    on_plan: undefined,
    activated: undefined,
    models_enabled: undefined,
  }));
  assert.equal(unknownPlan.plan, '套餐状态未知');
  assert.equal(unknownPlan.error, 'TokenHarbor 返回的额度数据不完整');
});

test('localized HTTP and network errors stay sanitized in both languages', async () => {
  let englishUsage = false;
  const hooks = await TokenHarborProviderPlugin({
    magpie: { option: () => englishUsage },
  });
  const getAuth = async () => ({ type: 'api', key: secretSentinel });
  const readFailure = (fetchImpl) => withFetch(fetchImpl, () => hooks.auth.usage(getAuth));

  const chineseHttp = await readFailure(async () => new Response('private body', { status: 403 }));
  assert.equal(chineseHttp.error, 'TokenHarbor 额度查询失败（HTTP 403）');
  const chineseNetwork = await readFailure(async () => { throw new Error(secretSentinel); });
  assert.equal(chineseNetwork.error, 'TokenHarbor 额度查询失败（网络错误）');
  englishUsage = true;
  const englishHttp = await readFailure(async () => new Response('private body', { status: 403 }));
  assert.equal(englishHttp.error, 'TokenHarbor quota request failed (HTTP 403)');
  const englishNetwork = await readFailure(async () => { throw new Error(secretSentinel); });
  assert.equal(englishNetwork.error, 'TokenHarbor quota request failed (network error)');
  for (const result of [chineseHttp, chineseNetwork, englishHttp, englishNetwork]) {
    assert.equal(JSON.stringify(result).includes(secretSentinel), false);
    assert.equal(JSON.stringify(result).includes('private body'), false);
  }
});

test('inactive or disabled free models do not create a free quota window', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const inactive = await withFetch(async () => jsonResponse(quotaPayload({
    on_plan: false,
    activated: false,
    models_enabled: true,
    used_pct: 0,
  })), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));
  assert.equal(inactive.plan, 'No active plan');
  assert.deepEqual(inactive.windows, []);
  assert.equal('balance' in inactive, false);

  const disabled = await withFetch(async () => jsonResponse(quotaPayload({
    on_plan: false,
    activated: true,
    models_enabled: false,
  })), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));
  assert.equal(disabled.plan, 'Free models disabled');
  assert.deepEqual(disabled.windows, []);
});

test('malformed quota fields stay unknown instead of becoming zero usage', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const usage = await withFetch(async () => jsonResponse(quotaPayload({
    plan_used_pct: 101,
    plan_exhausted: 'false',
    used_pct: null,
    exhausted: false,
  })), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));
  assert.equal(usage.error, 'TokenHarbor returned incomplete quota data');
  assert.deepEqual(usage.windows, []);
});

test('missing activation fields are reported as unknown rather than no plan', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const usage = await withFetch(async () => jsonResponse({
    plan_name: 'Pass Plus',
    plan_used_pct: 20,
    plan_exhausted: false,
  }), () => hooks.auth.usage(async () => ({ type: 'api', key: secretSentinel })));
  assert.equal(usage.plan, 'Unknown plan status');
  assert.equal(usage.error, 'TokenHarbor returned incomplete quota data');
  assert.deepEqual(usage.windows, []);
});

test('401, 403, and network failures return sanitized errors', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const getAuth = async () => ({ type: 'api', key: secretSentinel });

  const unauthorized = await withFetch(async () => new Response('private body must be discarded', { status: 401 }), () => hooks.auth.usage(getAuth));
  assert.equal(unauthorized.signIn, 'expired');
  assert.equal(unauthorized.error, 'TokenHarbor quota request failed (HTTP 401)');

  const forbidden = await withFetch(async () => new Response('private body must be discarded', { status: 403 }), () => hooks.auth.usage(getAuth));
  assert.equal(forbidden.signIn, undefined);
  assert.equal(forbidden.error, 'TokenHarbor quota request failed (HTTP 403)');

  const network = await withFetch(async () => { throw new Error(secretSentinel); }, () => hooks.auth.usage(getAuth));
  assert.equal(network.error, 'TokenHarbor quota request failed (network error)');
  for (const result of [unauthorized, forbidden, network]) {
    assert.equal(JSON.stringify(result).includes(secretSentinel), false);
    assert.equal(JSON.stringify(result).includes('private body'), false);
  }
});

test('model refresh uses only the OpenAI-compatible metadata endpoint and allowlists model fields', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const providerHook = hooks.provider;
  assert.equal(providerHook.id, PROVIDER_ID);
  const provider = { models: { 'model-a': { limit: { context: 1234 } } } };
  let request;
  const models = await withFetch(async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: [
      { id: 'model-a', name: 'Model A', owned_by: 'safe-to-ignore' },
      { id: 'model-b' },
      { id: 'model-a', name: 'Updated Model A' },
      { id: '', name: 'invalid' },
    ] });
  }, () => providerHook.id === PROVIDER_ID
    ? providerHook.models(provider, {
      auth: { type: 'api', key: secretSentinel },
    })
    : undefined);

  assert.equal(request.url, `${API_BASE_URL}/models`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.authorization, `Bearer ${secretSentinel}`);
  assert.equal(request.url.includes(secretSentinel), false);
  assert.deepEqual(models, {
    'model-a': { limit: { context: 1234 }, id: 'model-a', name: 'Updated Model A' },
    'model-b': { id: 'model-b', name: 'model-b' },
  });
  assert.equal(JSON.stringify(models).includes('owned_by'), false);
});

test('model refresh preserves cached models on unavailable metadata and expires only a rejected key', async () => {
  const hooks = await TokenHarborProviderPlugin({});
  const cached = { 'model-old': { id: 'model-old', name: 'Cached model' } };
  const getModels = (fetchImpl) => withFetch(fetchImpl, () => hooks.provider.models({ models: cached }, {
    auth: { type: 'api', key: secretSentinel },
  }));

  assert.equal(await getModels(async () => new Response('private body', { status: 403 })), cached);
  assert.equal(await getModels(async () => jsonResponse({ invalid: true })), cached);
  await assert.rejects(getModels(async () => new Response('private body', { status: 401 })), (error) => {
    assert.equal(error.signIn, 'expired');
    assert.equal(error.message.includes(secretSentinel), false);
    assert.equal(error.message.includes('private body'), false);
    return true;
  });
  assert.equal(await hooks.provider.models({ models: cached }, { auth: null }), cached);
});
