import { readFileSync } from 'node:fs';

const endpoint = 'https://tokenharbor.ai/api/cli/free-tier';
const filename = process.env.TOKENHARBOR_API_KEY_FILE;
let apiKey = process.env.TOKENHARBOR_API_KEY;

if (!apiKey && filename) {
  try {
    apiKey = readFileSync(filename, 'utf8').trim();
  } catch {
    process.stderr.write('Could not read TOKENHARBOR_API_KEY_FILE.\n');
    process.exit(2);
  }
}
if (!apiKey) {
  process.stderr.write('Set TOKENHARBOR_API_KEY_FILE or TOKENHARBOR_API_KEY to run this opt-in quota-only check.\n');
  process.exit(2);
}

let response;
try {
  response = await fetch(endpoint, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
} catch {
  process.stderr.write('Quota request failed (network error); response details were not recorded.\n');
  process.exit(1);
}

const allowedFields = [
  'plan_name',
  'on_plan',
  'plan_used_pct',
  'plan_exhausted',
  'used_pct',
  'exhausted',
  'activated',
  'period_started_at',
  'period_ends_at',
  'reset_at',
  'models',
  'models_enabled',
];
const safe = { status: response.status };

if (response.status === 401 || response.status === 403) {
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.stderr.write('Authentication or permission failed; no further authenticated attempt was made.\n');
  process.exit(2);
}
if (!response.ok) {
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.exit(1);
}

let payload;
try {
  payload = await response.json();
} catch {
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.stderr.write('Quota response was not valid JSON; response body was discarded.\n');
  process.exit(1);
}

if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.stderr.write('Quota response had an unexpected shape; response body was discarded.\n');
  process.exit(1);
}
for (const field of allowedFields) {
  if (!(field in payload)) continue;
  const value = payload[field];
  if (field === 'models') {
    if (Array.isArray(value)) safe[field] = value.filter((item) => typeof item === 'string').slice(0, 200);
  } else if (field.endsWith('_pct')) {
    if (Number.isInteger(value) && value >= 0 && value <= 100) safe[field] = value;
  } else if (['on_plan', 'plan_exhausted', 'exhausted', 'activated', 'models_enabled'].includes(field)) {
    if (typeof value === 'boolean') safe[field] = value;
  } else if (value === null || typeof value === 'string') {
    safe[field] = typeof value === 'string' ? value.slice(0, 120) : null;
  }
}
process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
