import assert from 'node:assert/strict';
import test from 'node:test';
import TokenHarborProviderPlugin from '../index.mjs';
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

  const userConfig = { provider: { tokenharbor: { name: 'My TokenHarbor' } } };
  await hooks.config(userConfig);
  assert.equal(userConfig.provider.tokenharbor.name, 'My TokenHarbor');
  assert.equal(await hooks.auth.loader(async () => ({ type: 'api', key: secretSentinel })).then((x) => x.apiKey), secretSentinel);
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
