import {
  API_BASE_URL,
  PROVIDER_ID,
  listModels,
  readAllowance,
} from './lib/tokenharbor.mjs';

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

export default async function TokenHarborProviderPlugin() {
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider[PROVIDER_ID] ??= structuredClone(PROVIDER);
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: 'api',
        label: 'TokenHarbor API key',
        placeholder: 'Paste your TokenHarbor API key',
      }],

      async loader(getAuth) {
        const auth = await getAuth();
        return auth?.type === 'api' && typeof auth.key === 'string'
          ? { apiKey: auth.key }
          : {};
      },

      async usage(getAuth) {
        let auth;
        try {
          auth = await getAuth();
        } catch {
          return { error: 'TokenHarbor API key is unavailable', windows: [] };
        }
        if (auth?.type !== 'api' || typeof auth.key !== 'string' || auth.key.length === 0) {
          return { error: 'TokenHarbor API key is missing', windows: [] };
        }
        return readAllowance(auth.key);
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
