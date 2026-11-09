import { readFileSync } from 'node:fs';
import {
  API_BASE_URL,
  PROVIDER_ID,
  listModels,
  localizeUsage,
  readAllowance,
} from './lib/tokenharbor.mjs';

const TOKENHARBOR_ICON = `data:image/svg+xml;base64,${readFileSync(new URL('./tokenharbor.svg', import.meta.url)).toString('base64')}`;

const PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'TokenHarbor',
  options: { baseURL: API_BASE_URL },
  models: {
    'th-orchestra': {
      name: 'TH Orchestra',
      tool_call: true,
    },
  },
};

export default async function TokenHarborProviderPlugin(input = {}) {
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider[PROVIDER_ID] ??= structuredClone(PROVIDER);
    },

    auth: {
      provider: PROVIDER_ID,
      icon: TOKENHARBOR_ICON,
      options: [{
        key: 'english-usage',
        label: 'English usage text',
        labels: {
          zh: '英文用量文案',
          'zh-TW': '英文用量文字',
        },
        description: 'Show TokenHarbor usage text in English instead of Chinese.',
        descriptions: {
          zh: '开启后，TokenHarbor 用量卡片将显示英文文案。',
          'zh-TW': '啟用後，TokenHarbor 用量卡片會顯示英文文字。',
        },
        default: false,
      }],
      methods: [{
        type: 'api',
        label: 'TokenHarbor API key',
        placeholder: 'Paste your TokenHarbor API key',
      }],

      async loader(getAuth) {
        const auth = await getAuth();
        return auth?.type === 'api' && typeof auth.key === 'string'
          ? { apiKey: auth.key, baseURL: API_BASE_URL }
          : {};
      },

      async usage(getAuth) {
        let language = 'en';
        if (typeof input?.magpie?.option === 'function') {
          language = input.magpie.option(PROVIDER_ID, 'english-usage') === true ? 'en' : 'zh';
        }
        let auth;
        try {
          auth = await getAuth();
        } catch {
          return localizeUsage({ error: 'TokenHarbor API key is unavailable', windows: [] }, language);
        }
        if (auth?.type !== 'api' || typeof auth.key !== 'string' || auth.key.length === 0) {
          return localizeUsage({ error: 'TokenHarbor API key is missing', windows: [] }, language);
        }
        return localizeUsage(await readAllowance(auth.key), language);
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        return listModels(provider, auth);
      },
    },
  };
}
