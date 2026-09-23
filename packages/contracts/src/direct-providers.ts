import type { ProviderId } from './primitives';

export type DirectProviderProtocol = 'responses' | 'chat-completions' | 'unsupported';

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

function providerUrl(hostAndPath: string): string {
  return `https://${hostAndPath}`;
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
    displayName: 'Anthropic API',
    protocol: 'unsupported',
    defaultBaseUrl: providerUrl('api.anthropic.com'),
    defaultModel: '',
    credentialId: 'provider.anthropic',
    supportsTools: false,
    models: [],
  },
  google: {
    id: 'google',
    displayName: 'Google Gemini API',
    protocol: 'unsupported',
    defaultBaseUrl: providerUrl('generativelanguage.googleapis.com'),
    defaultModel: '',
    credentialId: 'provider.google',
    supportsTools: false,
    models: [],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek API',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.deepseek.com'),
    defaultModel: 'deepseek-flash',
    credentialId: 'provider.deepseek',
    supportsTools: true,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
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
      'x-ai/grok-4.7',
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
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
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
    defaultModel: 'grok-4.7',
    credentialId: 'provider.xai',
    supportsTools: true,
    models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1'],
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
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'openai-compatible',
];

export function directProviderPreset(provider: ProviderId): DirectProviderPreset {
  return DIRECT_PROVIDER_PRESETS[provider];
}
