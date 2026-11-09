export const PROVIDER_ID = 'tokenharbor';
export const API_BASE_URL = 'https://tokenharbor.ai/v1';
export const ALLOWANCE_URL = 'https://tokenharbor.ai/api/cli/free-tier';
export const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const percentage = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

function cleanLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return label || fallback;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function modelIds(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    if (typeof item === 'string' && item.trim() && item.length <= 200) unique.add(item.trim());
  }
  return [...unique];
}

function quotaWindow({ name, usedPct, exhausted, resetsAt, models }) {
  const window = {
    name,
    used: usedPct,
    unit: '%',
    display: `${usedPct}% used · approximately ${100 - usedPct}% remaining · ${exhausted ? 'exhausted' : 'available'}`,
    span: SEVEN_DAYS_SECONDS,
    aside: true,
  };
  if (resetsAt) window.resetsAt = resetsAt;
  if (models?.length) window.models = models;
  return window;
}

export function parseAllowance(payload) {
  if (!record(payload)) {
    return { error: 'TokenHarbor returned invalid quota data', windows: [] };
  }

  const hasPlanStatus = typeof payload.on_plan === 'boolean';
  const hasActivationStatus = typeof payload.activated === 'boolean';
  const hasFreeModelStatus = typeof payload.models_enabled === 'boolean';
  const onPlan = payload.on_plan === true;
  const activated = payload.activated === true;
  const planName = cleanLabel(payload.plan_name, 'Pass');
  const resetsAt = timestamp(payload.reset_at) ?? timestamp(payload.period_ends_at);
  const windows = [];
  let incomplete = !hasPlanStatus || !hasActivationStatus || !hasFreeModelStatus;

  if (onPlan) {
    if (percentage(payload.plan_used_pct) && typeof payload.plan_exhausted === 'boolean') {
      windows.push(quotaWindow({
        name: `${planName} · 7 days`,
        usedPct: payload.plan_used_pct,
        exhausted: payload.plan_exhausted,
        resetsAt,
      }));
    } else {
      incomplete = true;
    }
  }

  if (activated && payload.models_enabled === true) {
    if (percentage(payload.used_pct) && typeof payload.exhausted === 'boolean') {
      windows.push(quotaWindow({
        name: 'Free models · 7 days',
        usedPct: payload.used_pct,
        exhausted: payload.exhausted,
        resetsAt,
        models: modelIds(payload.models),
      }));
    } else {
      incomplete = true;
    }
  }

  let plan;
  if (onPlan) plan = planName;
  else if (activated && payload.models_enabled === true) plan = 'Free tier';
  else if (activated) plan = 'Free models disabled';
  else if (!hasPlanStatus || !hasActivationStatus || !hasFreeModelStatus) plan = 'Unknown plan status';
  else plan = 'No active plan';

  return {
    plan,
    windows,
    ...(incomplete ? { error: 'TokenHarbor returned incomplete quota data' } : {}),
  };
}

export async function readAllowance(apiKey, fetchImpl = globalThis.fetch) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { error: 'TokenHarbor API key is missing', windows: [] };
  }
  if (typeof fetchImpl !== 'function') {
    return { error: 'TokenHarbor quota service is unavailable', windows: [] };
  }

  let response;
  try {
    response = await fetchImpl(ALLOWANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { error: 'TokenHarbor quota request failed (network error)', windows: [] };
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    return {
      ...(status === 401 ? { signIn: 'expired' } : {}),
      error: `TokenHarbor quota request failed (HTTP ${status})`,
      windows: [],
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { error: 'TokenHarbor returned invalid quota data', windows: [] };
  }
  return parseAllowance(payload);
}

export async function listModels(provider, auth, fetchImpl = globalThis.fetch) {
  const existing = record(provider?.models) ? provider.models : {};
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || auth.key.length === 0) return existing;
  if (typeof fetchImpl !== 'function') return existing;

  let response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${auth.key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return existing;
  }

  if (!response?.ok) {
    if (response?.status === 401) {
      throw Object.assign(new Error('TokenHarbor API key was rejected'), { signIn: 'expired' });
    }
    return existing;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return existing;
  }
  if (!record(payload) || !Array.isArray(payload.data)) return existing;

  const models = {};
  for (const item of payload.data) {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) continue;
    const id = item.id.trim();
    const prior = record(existing[id]) ? existing[id] : {};
    models[id] = {
      ...prior,
      id,
      name: cleanLabel(item.name, id),
    };
  }
  return Object.keys(models).length ? models : existing;
}
