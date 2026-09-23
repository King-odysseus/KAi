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
    defaultModel: '',
    credentialId: 'provider.openai',
    supportsTools: true,
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
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
    defaultModel: 'deepseek-chat',
    credentialId: 'provider.deepseek',
    supportsTools: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('openrouter.ai/api/v1'),
    defaultModel: 'openai/gpt-4o-mini',
    credentialId: 'provider.openrouter',
    supportsTools: true,
    models: [
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-r1',
      'x-ai/grok-3-beta',
      'qwen/qwen-2.5-coder-32b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-large',
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
    defaultModel: 'grok-3-mini',
    credentialId: 'provider.xai',
    supportsTools: true,
    models: ['grok-3-mini', 'grok-3', 'grok-2-vision-latest'],
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.together.xyz/v1'),
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    credentialId: 'provider.together',
    supportsTools: true,
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
    ],
  },
  fireworks: {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    protocol: 'chat-completions',
    defaultBaseUrl: providerUrl('api.fireworks.ai/inference/v1'),
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    credentialId: 'provider.fireworks',
    supportsTools: true,
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
      'accounts/fireworks/models/deepseek-r1',
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
