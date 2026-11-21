import { z } from 'zod';
import { providerIdSchema, type ProviderId } from './primitives';

export type DirectProviderProtocol = 'responses' | 'chat-completions' | 'anthropic-messages' | 'google-generative-ai';

export interface DirectProviderPreset {
  // Provider presets keep desktop settings and runtime protocol selection in sync.
  id: ProviderId;
  displayName: string;
  protocol: DirectProviderProtocol;
  defaultBaseUrl: string;
  defaultModel: string;
  credentialId: string;
  supportsTools: boolean;
  models: readonly string[];
}

export const providerModelCatalogSchema = z
  .object({
    provider: providerIdSchema,
    models: z.array(z.string().trim().min(1).max(500)).max(2_000),
    source: z.enum(['live', 'preset']),
    fetchedAt: z.string().datetime(),
    error: z.string().max(2_000).nullable(),
    /** The context window each model reported, in tokens, when the server says (loaded size first, then the maximum). */
    contextLengths: z.record(z.string().min(1).max(500), z.number().int().positive()).optional(),
  })
  .strict();
export type ProviderModelCatalog = z.infer<typeof providerModelCatalogSchema>;

function providerUrl(hostAndPath: string): string {
  return `https://${hostAndPath}`;
}

const DEEPSEEK_MODEL_MIGRATIONS: Readonly<Record<string, string>> = {
  'deepseek-v3': 'deepseek-v4-pro',
  'deepseek-v3.1': 'deepseek-v4-pro',
  'deepseek-chat': 'deepseek-v4-pro',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
};

export function migrateDeepSeekModel(model: string): string {
  const trimmed = model.trim();
  return DEEPSEEK_MODEL_MIGRATIONS[trimmed.toLowerCase()] ?? trimmed;
}

export const DIRECT_PROVIDER_PRESETS: Readonly<Record<ProviderId, DirectProviderPreset>> = {
  openai: {
    id: 'openai',
    displayName: 'OpenAI Responses API',
    protocol: 'responses',
    defaultBaseUrl: providerUrl('api.openai.com/v1'),
    defaultModel: 'gpt-6-astra',
    credentialId: 'provider.openai',
    supportsTools: true,
    models: [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
    ],
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic Messages API',
    protocol: 'anthropic-messages',
    defaultBaseUrl: providerUrl('api.anthropic.com/v1'),
    defaultModel: 'claude-sonnet-5',
    credentialId: 'provider.anthropic',
    supportsTools: true,
    models: [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ],
  },
  google: {
    id: 'google',
    displayName: 'Google Gemini API',
    protocol: 'google-generative-ai',
    defaultBaseUrl: providerUrl('generativelanguage.googleapis.com/v1beta'),
    defaultModel: 'gemini-3.8-flash',
    credentialId: 'provider.google',
    supportsTools: true,
    models: [
      'gemini-4-argon',
      'gemini-3.8-pro',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
    ],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.deepseek.com'),
    defaultModel: 'deepseek-v4-pro',
    credentialId: 'provider.deepseek',
    supportsTools: true,
    models: [
      'deepseek-flash',
      'deepseek-v4-pro',
    ],
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('openrouter.ai/api/v1'),
    defaultModel: 'openai/gpt-6-astra',
    credentialId: 'provider.openrouter',
    supportsTools: true,
    models: [
      'openai/gpt-6-astra',
      'openai/gpt-6-astra-pro',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'anthropic/claude-opus-5.5',
      'anthropic/claude-fable-5.1',
      'google/gemini-3.8-flash',
      'x-ai/grok-4.20',
      'qwen/qwen3.8-max-0902',
      'deepseek/deepseek-v4.1-flash',
      'z-ai/glm-5.3',
      'meta/muse-spark-1.3',
    ],
  },
  zai: {
    id: 'zai',
    displayName: 'Z.AI (GLM)',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.z.ai/api/paas/v4'),
    defaultModel: 'glm-5.3',
    credentialId: 'provider.zai',
    supportsTools: true,
    models: [
      'glm-5.3',
      'glm-5.1',
      'glm-4.7',
    ],
  },
  moonshot: {
    id: 'moonshot',
    displayName: 'Moonshot (Kimi)',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.moonshot.ai/v1'),
    defaultModel: 'kimi-k3',
    credentialId: 'provider.moonshot',
    supportsTools: true,
    models: [
      'kimi-k3',
      'kimi-k2.6',
      'moonshot-v1-128k',
    ],
  },
  groq: {
    id: 'groq',
    displayName: 'Groq API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.groq.com/openai/v1'),
    defaultModel: 'llama-3.3-70b-versatile',
    credentialId: 'provider.groq',
    supportsTools: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.mistral.ai/v1'),
    defaultModel: 'mistral-large-latest',
    credentialId: 'provider.mistral',
    supportsTools: true,
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
  },
  xai: {
    id: 'xai',
    displayName: 'xAI API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.x.ai/v1'),
    defaultModel: 'grok-4.20',
    credentialId: 'provider.xai',
    supportsTools: true,
    models: [
      'grok-4.20',
      'grok-4.20-reasoning',
      'grok-4.20-fast',
      'grok-4.7',
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      'grok-build-0.1',
    ],
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.together.xyz/v1'),
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    credentialId: 'provider.together',
    supportsTools: true,
    models: [
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'Qwen/Qwen3.8-2.4T-A95B',
      'Qwen/Qwen3.8-Flash',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    ],
  },
  fireworks: {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.fireworks.ai/inference/v1'),
    defaultModel: 'accounts/fireworks/models/deepseek-v4p1-flash',
    credentialId: 'provider.fireworks',
    supportsTools: true,
    models: [
      'accounts/fireworks/models/deepseek-v4p1-flash',
      'accounts/fireworks/models/qwen3p8-max',
      'accounts/fireworks/models/glm-5p3',
      'accounts/fireworks/models/kimi-k3',
    ],
  },
  lmstudio: {
    id: 'lmstudio',
    displayName: 'LM Studio (local models)',
    protocol: 'chat-completions',
    // 127.0.0.1 rather than "localhost": on Windows "localhost" can resolve to IPv6 first, which LM Studio may not serve.
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    // Empty on purpose: the models are whatever the user has downloaded, listed live from the running server.
    defaultModel: '',
    credentialId: 'provider.lmstudio',
    supportsTools: true,
    models: [],
  },
  ollama: {
    id: 'ollama',
    displayName: 'Ollama (local models)',
    protocol: 'chat-completions',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    credentialId: 'provider.ollama',
    supportsTools: true,
    models: [],
  },
  llamacpp: {
    id: 'llamacpp',
    displayName: 'llama.cpp server (local models)',
    protocol: 'chat-completions',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: '',
    credentialId: 'provider.llamacpp',
    supportsTools: true,
    models: [],
  },
  vllm: {
    id: 'vllm',
    displayName: 'vLLM (local or self-hosted)',
    protocol: 'chat-completions',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: '',
    credentialId: 'provider.vllm',
    supportsTools: true,
    models: [],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'Gateway',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.example.com/v1'),
    defaultModel: '',
    credentialId: 'provider.custom',
    supportsTools: true,
    models: ['gateway/auto', 'gateway/coding', 'gateway/research', 'gateway/general', 'gateway/vision'],
  },
};

export const DIRECT_PROVIDER_ORDER: readonly ProviderId[] = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'openrouter',
  'zai',
  'moonshot',
  'groq',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'lmstudio',
  'ollama',
  'llamacpp',
  'vllm',
  'openai-compatible',
];

/** Providers that run on the user's own machine or network: no API key is needed and nothing is billed. */
export const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['lmstudio', 'ollama', 'llamacpp', 'vllm']);

export function isLocalProvider(provider: ProviderId): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

/** Sent as the bearer value when a local server wants one and the user stored none. LM Studio ignores it. */
export const LOCAL_PROVIDER_PLACEHOLDER_KEY = 'lm-studio';

/**
 * The model to select first from a local server's list: a coding model if one is downloaded, and never an
 * embedding model, which cannot chat.
 */
export function pickLocalModel(models: readonly string[]): string {
  const chat = models.filter((model) => !/embed/i.test(model));
  return chat.find((model) => /coder/i.test(model)) ?? chat.at(0) ?? '';
}

/**
 * How to get a local server answering, in that server's own words, for the Settings screen and for error messages.
 * `list` is the sentence about the Refresh button; `setup` is the paragraph under the provider.
 */
export function localProviderGuide(provider: ProviderId): { name: string; list: string; setup: string } | null {
  switch (provider) {
    case 'lmstudio':
      return {
        name: 'LM Studio',
        list: 'Refresh lists the models you have downloaded in LM Studio.',
        setup: 'Runs on your computer, so there is no key and nothing is billed. In LM Studio open the Developer tab, start the local server and load a model (for example Qwen2.5 Coder), then refresh here. Only add a key below if you switched on API-token protection in LM Studio.',
      };
    case 'ollama':
      return {
        name: 'Ollama',
        list: 'Refresh lists the models you have pulled in Ollama.',
        setup: 'Runs on your computer, so there is no key and nothing is billed. Start Ollama (the app, or `ollama serve`), pull a coding model with `ollama pull qwen2.5-coder`, then refresh here. Ollama listens on port 11434; change the address above if yours is elsewhere.',
      };
    case 'llamacpp':
      return {
        name: 'llama.cpp',
        list: 'Refresh lists the model the llama.cpp server has loaded.',
        setup: 'Runs on your computer, so there is no key and nothing is billed. Start `llama-server` with a model (for example `llama-server -m qwen2.5-coder.gguf`), then refresh here. It listens on port 8080 unless you passed --port. Only add a key below if you started it with --api-key.',
      };
    case 'vllm':
      return {
        name: 'vLLM',
        list: 'Refresh lists the models the vLLM server is serving.',
        setup: 'Runs on your own machine or network, so nothing is billed by a provider. Start the server (`vllm serve <model>`), then refresh here. It listens on port 8000 unless you passed --port. Only add a key below if you started it with --api-key.',
      };
    default:
      return null;
  }
}

export function directProviderPreset(provider: ProviderId): DirectProviderPreset {
  return DIRECT_PROVIDER_PRESETS[provider];
}
