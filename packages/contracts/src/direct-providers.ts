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
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
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
      'gemini-3.8-pro',
      'gemini-3.8-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
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
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'Custom OpenAI-compatible API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.example.com/v1'),
    defaultModel: '',
    credentialId: 'provider.custom',
    supportsTools: true,
    models: [],
  },
};

export const DIRECT_PROVIDER_ORDER: readonly ProviderId[] = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'lmstudio',
  'openai-compatible',
];

/** Providers that run on the user's own machine or network: no API key is needed and nothing is billed. */
export const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['lmstudio']);

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

export function directProviderPreset(provider: ProviderId): DirectProviderPreset {
  return DIRECT_PROVIDER_PRESETS[provider];
}
