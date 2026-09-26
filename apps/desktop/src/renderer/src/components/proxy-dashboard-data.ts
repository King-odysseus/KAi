// Presets, model catalogue and routing helpers for the Universal Agent Proxy dashboard.
// Mirrors ClaudeCode-Proxy `src/presets.ts`, `src/models.ts` and the tables in its
// `dashboard.html` so both dashboards offer the same choices and write the same config.
import type { AppSettings, ProxyAgentId } from '@kai/contracts';

export type ProxySettings = AppSettings['proxy'];
export type ProxyProviderEntry = ProxySettings['providers'][string];
export type ProxyAgentBackend = ProxySettings['kimiConfig'];
export type BackendAgent = 'kimi' | 'qwen' | 'codex';

export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  map?: Record<string, string>;
  configModel?: string;
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai';
  inputPrice: number;
  outputPrice: number;
  contextTokens: number;
  legacy?: boolean;
}

export const AGENTS: ProxyAgentId[] = ['claude', 'codex', 'kimi', 'qwen'];
/** Order the extension's Overview uses for its agent cards. */
export const OVERVIEW_AGENTS: ProxyAgentId[] = ['claude', 'qwen', 'kimi', 'codex'];

export const AGENT_LABELS: Record<ProxyAgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  qwen: 'Qwen Code',
};

export const AGENT_KINDS: Record<ProxyAgentId, string> = {
  claude: 'CLI + VS Code',
  qwen: 'CLI + VS Code Companion',
  kimi: 'CLI + extension',
  codex: 'CLI + VS Code',
};

export const AGENT_MARKS: Record<ProxyAgentId, string> = { claude: 'C', qwen: 'Q', kimi: 'K', codex: 'X' };

/** What each agent puts in the model field when routed through the proxy. */
export const AGENT_SENDS: Record<ProxyAgentId, string> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.5',
  kimi: 'kimi-for-coding',
  qwen: 'qwen-proxy',
};

export const CODEX_PROXY_MODEL = 'gpt-5.5';

/** Claude ids a Claude Code client may send; the model-map table lists these rows. */
export const CLAUDE_CLIENT_MODELS = [
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

/** Placeholder ids Codex, Qwen and Kimi send that a provider map must rewrite. */
export const AGENT_PLACEHOLDER_MODELS = [CODEX_PROXY_MODEL, 'qwen-proxy', 'qwen-coder-plus', 'kimi-for-coding', 'kimi-k2.6'];

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

const MODEL_LABELS: Record<string, string> = {
  'deepseek-flash': 'DeepSeek Flash 4.1',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash (retired — runs Flash 4.1)',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision (retired — runs Flash 4.1)',
};

export const CATALOG: CatalogModel[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', inputPrice: 5, outputPrice: 25, contextTokens: 1_000_000 },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', inputPrice: 10, outputPrice: 50, contextTokens: 1_000_000 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', inputPrice: 2, outputPrice: 10, contextTokens: 1_000_000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', inputPrice: 1, outputPrice: 5, contextTokens: 200_000 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', inputPrice: 5, outputPrice: 25, contextTokens: 1_000_000, legacy: true },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', inputPrice: 10, outputPrice: 50, contextTokens: 1_050_000 },
  { id: 'gpt-5.6-cyber', label: 'GPT-5.6 Cyber', provider: 'openai', inputPrice: 12.5, outputPrice: 75, contextTokens: 400_000 },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', inputPrice: 4, outputPrice: 20, contextTokens: 1_050_000 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai', inputPrice: 2, outputPrice: 12, contextTokens: 1_050_000 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', inputPrice: 0.2, outputPrice: 1.2, contextTokens: 1_050_000 },
];

export const CATALOG_DEFAULTS = { anthropic: 'claude-opus-5', openai: 'gpt-6-astra' } as const;

function mapEvery(target: string): Record<string, string> {
  return Object.fromEntries(CLAUDE_CLIENT_MODELS.map((model) => [model, target]));
}

function legacyMap(opus: string, sonnet: string, haiku: string, sonnet35 = sonnet, haiku35 = haiku, opus3 = opus): Record<string, string> {
  return {
    'claude-opus-4-7': opus,
    'claude-sonnet-4-6': sonnet,
    'claude-haiku-4-5-20251001': haiku,
    'claude-3-5-sonnet-20241022': sonnet35,
    'claude-3-5-haiku-20241022': haiku35,
    'claude-3-opus-20240229': opus3,
  };
}

/** Main-provider presets (`PRESET_MAP` in the extension). */
export const PRESETS: Record<string, ProviderPreset> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto', map: mapEvery('openrouter/auto') },
  deepseek: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', map: mapEvery('deepseek-flash') },
  deepseek_anthropic: { baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-flash', map: mapEvery('deepseek-flash') },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3', map: legacyMap('grok-3', 'grok-3-mini', 'grok-3-mini') },
  kimi: { baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.6', map: legacyMap('kimi-k2.6', 'kimi-k2.6', 'kimi-k2.6') },
  kimi_anthropic: { baseUrl: 'https://api.moonshot.ai/anthropic', defaultModel: 'kimi-k2.6', map: legacyMap('kimi-k2.6', 'kimi-k2.6', 'kimi-k2.6') },
  kimi_com: { baseUrl: 'https://api.kimi.com/coding/v1', defaultModel: 'kimi-k2.6', map: legacyMap('kimi-k2.6', 'kimi-k2.6', 'kimi-k2.6') },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', map: legacyMap('llama-3.3-70b-versatile', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant') },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    map: legacyMap('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.2-3B-Instruct-Turbo'),
  },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder', map: legacyMap('qwen2.5-coder:32b', 'qwen2.5-coder', 'llama3.2') },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model', map: legacyMap('local-model', 'local-model', 'local-model') },
  glm: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', defaultModel: 'glm-5.1', map: legacyMap('glm-5.1', 'glm-4.7', 'glm-4.7') },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-astra', map: mapEvery('gpt-6-astra') },
  anthropic: { baseUrl: 'https://api.anthropic.com', defaultModel: '', map: {} },
};

const QWEN_EXTRA: Record<string, ProviderPreset> = {
  qwen_dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-coder-plus' },
  ollama_qwen: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder' },
};

const CODEX_PRESETS: Record<string, ProviderPreset> = {
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-astra', configModel: CODEX_PROXY_MODEL },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto', configModel: CODEX_PROXY_MODEL },
  kimi: { baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.6', configModel: CODEX_PROXY_MODEL },
  kimi_com: { baseUrl: 'https://api.kimi.com/coding/v1', defaultModel: 'kimi-for-coding', configModel: CODEX_PROXY_MODEL },
  deepseek: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', configModel: CODEX_PROXY_MODEL },
  deepseek_anthropic: { baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-flash', configModel: CODEX_PROXY_MODEL },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3', configModel: CODEX_PROXY_MODEL },
  kimi_anthropic: { baseUrl: 'https://api.moonshot.ai/anthropic', defaultModel: 'kimi-k2.6', configModel: CODEX_PROXY_MODEL },
  anthropic: { baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-6', configModel: CODEX_PROXY_MODEL },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b', configModel: CODEX_PROXY_MODEL },
  together: { baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', configModel: CODEX_PROXY_MODEL },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2', configModel: CODEX_PROXY_MODEL },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model', configModel: CODEX_PROXY_MODEL },
  glm: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', defaultModel: 'glm-5.1', configModel: CODEX_PROXY_MODEL },
};

export const PROVIDER_LABELS: Record<string, string> = {
  main: 'Use main provider',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  deepseek_anthropic: 'DeepSeek Anthropic',
  xai: 'xAI Grok',
  kimi: 'Moonshot / Kimi',
  kimi_anthropic: 'Moonshot Anthropic',
  kimi_com: 'Kimi.com',
  groq: 'Groq',
  together: 'Together AI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  glm: 'Z.AI / GLM',
  anthropic: 'Anthropic',
  qwen_dashscope: 'DashScope Qwen',
  ollama_qwen: 'Ollama Qwen',
  openai: 'OpenAI',
  custom: 'Custom / current',
};

/** Long labels used by the "Provider preset" picker on the Providers tab. */
export const MAIN_PRESET_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'openrouter', label: 'OpenRouter (Auto Router)' },
  { id: 'deepseek', label: 'DeepSeek Flash 4.1 (OpenAI)' },
  { id: 'deepseek_anthropic', label: 'DeepSeek Flash 4.1 (Anthropic, pass‑through)' },
  { id: 'xai', label: 'xAI (Grok)' },
  { id: 'kimi', label: 'Moonshot / Kimi (OpenAI)' },
  { id: 'kimi_anthropic', label: 'Moonshot / Kimi (Anthropic, pass‑through)' },
  { id: 'kimi_com', label: 'Kimi.com (OpenAI)' },
  { id: 'groq', label: 'Groq' },
  { id: 'together', label: 'Together AI' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'lmstudio', label: 'LM Studio (local)' },
  { id: 'glm', label: 'Z.AI / GLM (Zhipu AI)' },
  { id: 'openai', label: 'OpenAI (GPT)' },
  { id: 'anthropic', label: 'Anthropic (default — pass-through)' },
];

export const ROUTING_PROFILES = [
  { id: 'cheap', label: 'Cheap', description: 'DeepSeek Flash for low-cost everyday work.', preset: 'deepseek' },
  { id: 'quality', label: 'Best quality', description: 'GPT-6 Astra for demanding work.', preset: 'openai' },
  { id: 'local', label: 'Local only', description: 'Ollama on this computer. No cloud provider is used.', preset: 'ollama' },
];

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openrouter: ['openrouter/auto', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-sonnet-4-6', 'openai/gpt-4o'],
  deepseek: DEEPSEEK_MODELS,
  deepseek_anthropic: DEEPSEEK_MODELS,
  xai: ['grok-3', 'grok-3-mini'],
  kimi: ['kimi-k2.6', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  kimi_anthropic: ['kimi-k2.6'],
  kimi_com: ['kimi-k2.6', 'kimi-for-coding'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.2-3B-Instruct-Turbo'],
  ollama: ['qwen2.5-coder', 'llama3.2', 'mistral'],
  lmstudio: ['local-model'],
  glm: ['glm-5.1', 'glm-4.7'],
  qwen_dashscope: ['qwen-coder-plus', 'qwen-max', 'qwen-plus'],
  ollama_qwen: ['qwen2.5-coder'],
};

export function catalogFor(provider: 'anthropic' | 'openai'): CatalogModel[] {
  return CATALOG.filter((model) => model.provider === provider);
}

/** Presets offered for one agent (`overviewProviderPresets` in the extension). */
export function presetsFor(agent: ProxyAgentId): Record<string, ProviderPreset> {
  if (agent === 'codex') return CODEX_PRESETS;
  if (agent === 'qwen') return { qwen_dashscope: QWEN_EXTRA.qwen_dashscope!, ...PRESETS, ollama_qwen: QWEN_EXTRA.ollama_qwen! };
  return PRESETS;
}

export function modelSuggestions(providerKey: string): string[] {
  if (providerKey === 'anthropic' || providerKey === 'openai') return catalogFor(providerKey).map((model) => model.id);
  return MODEL_SUGGESTIONS[providerKey] ?? [];
}

export function modelLabel(id: string): string {
  const model = CATALOG.find((candidate) => candidate.id === id);
  if (model) return `${model.label}${model.legacy ? ' (legacy)' : ''} — ${model.id}`;
  return MODEL_LABELS[id] ? `${MODEL_LABELS[id]} — ${id}` : id;
}

export function describeCatalogModel(id: string): string {
  const model = CATALOG.find((candidate) => candidate.id === id);
  if (!model) return '';
  return `$${model.inputPrice} in / $${model.outputPrice} out per Mtok · ${Math.round(model.contextTokens / 1000)}K context`;
}

export function normalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/** Preset key whose base URL matches, or 'custom'. */
export function presetKeyForUrl(agent: ProxyAgentId, baseUrl: string): string {
  const url = normalizedUrl(baseUrl);
  for (const [key, preset] of Object.entries(presetsFor(agent))) {
    if (normalizedUrl(preset.baseUrl) === url) return key;
  }
  return 'custom';
}

export function hostLabel(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return parsed.host + path;
  } catch {
    return value;
  }
}

export function backendKey(agent: BackendAgent): 'kimiConfig' | 'qwenConfig' | 'codexConfig' {
  return agent === 'kimi' ? 'kimiConfig' : agent === 'qwen' ? 'qwenConfig' : 'codexConfig';
}

/** The base URL, model and credential ID an agent's proxied traffic uses today. */
export function agentUpstream(draft: ProxySettings, agent: ProxyAgentId): {
  ownBackend: boolean;
  baseUrl: string;
  model: string;
  credentialId: string;
} {
  if (agent !== 'claude') {
    const backend = draft[backendKey(agent)];
    if (backend.enabled) {
      return { ownBackend: true, baseUrl: backend.baseUrl, model: backend.defaultModel, credentialId: backend.credentialId ?? '' };
    }
  }
  return { ownBackend: false, baseUrl: draft.targetBaseUrl, model: draft.defaultModel, credentialId: draft.credentialId };
}

/** Credential ID a key typed on an agent card is stored under. */
export function agentCredentialId(draft: ProxySettings, agent: ProxyAgentId): string {
  if (agent === 'claude') return draft.credentialId;
  const backend = draft[backendKey(agent)];
  return backend.credentialId || `agent.${agent}`;
}

/** Provider selector value for an agent card. */
export function agentProviderKey(draft: ProxySettings, agent: ProxyAgentId): string {
  const upstream = agentUpstream(draft, agent);
  if (agent !== 'claude' && !upstream.ownBackend) return 'main';
  return presetKeyForUrl(agent, upstream.baseUrl);
}

/** Apply a provider choice from an agent card (`applyOverviewProvider`). */
export function applyAgentProvider(draft: ProxySettings, agent: ProxyAgentId, key: string): ProxySettings {
  if (key === 'custom') return draft;
  if (agent === 'claude') {
    const preset = PRESETS[key];
    if (!preset) return draft;
    return applyMainPreset(draft, key);
  }
  const field = backendKey(agent);
  if (key === 'main') return { ...draft, [field]: { ...draft[field], enabled: false } };
  const preset = presetsFor(agent)[key];
  if (!preset) return draft;
  const next: ProxyAgentBackend = {
    ...draft[field],
    enabled: true,
    baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel || draft[field].defaultModel,
  };
  if (preset.configModel) next.configModel = preset.configModel;
  return { ...draft, [field]: next };
}

/** Apply a model choice from an agent card (`applyOverviewModel`). */
export function applyAgentModel(draft: ProxySettings, agent: ProxyAgentId, model: string): ProxySettings {
  const upstream = agentUpstream(draft, agent);
  if (!upstream.ownBackend || agent === 'claude') return { ...draft, defaultModel: model };
  const field = backendKey(agent as BackendAgent);
  return { ...draft, [field]: { ...draft[field], defaultModel: model } };
}

/** Fill the main provider fields from a preset; credential IDs follow the provider. */
export function applyMainPreset(draft: ProxySettings, key: string): ProxySettings {
  const preset = PRESETS[key];
  if (!preset) return draft;
  return {
    ...draft,
    targetBaseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel || draft.defaultModel,
    modelMap: preset.map ?? {},
    credentialId: credentialIdForPreset(key),
  };
}

export function credentialIdForPreset(key: string): string {
  if (key === 'ollama' || key === 'lmstudio' || key === 'ollama_qwen') return 'proxy.local';
  if (key === 'deepseek' || key === 'deepseek_anthropic') return 'provider.deepseek';
  if (key === 'kimi' || key === 'kimi_anthropic') return 'provider.moonshot';
  if (key === 'kimi_com') return 'provider.kimi';
  if (key === 'glm') return 'provider.zai';
  if (key === 'qwen_dashscope') return 'provider.dashscope';
  return `provider.${key}`;
}

/** Mirrors openAIModelMap/anthropicModelMap: rewrite only the ids the upstream cannot serve. */
export function dualProviderMap(provider: 'anthropic' | 'openai', chosen: string): Record<string, string> {
  const ids = provider === 'openai' ? [...CLAUDE_CLIENT_MODELS, ...AGENT_PLACEHOLDER_MODELS] : AGENT_PLACEHOLDER_MODELS;
  return Object.fromEntries(ids.map((id) => [id, chosen]));
}

export interface DualRouteRow {
  agent: ProxyAgentId;
  asks: string;
  destination: string;
  sent: string;
}

/** The "Effective routing" table under Dual API. */
export function dualRoutePreview(draft: ProxySettings): DualRouteRow[] {
  const providers = draft.providers;
  const masterOn = draft.dualApiEnabled;
  const routingOn = masterOn && draft.modelRouting;
  return AGENTS.map((agent) => {
    const asks = AGENT_SENDS[agent];
    let target = '';
    let why = '';
    const pinned = draft.agentRoutes[agent];
    if (masterOn && pinned && providers[pinned]) {
      target = pinned;
      why = 'pinned';
    } else if (routingOn) {
      if (asks.startsWith('claude-') && providers.anthropic) {
        target = 'anthropic';
        why = 'model rule';
      } else if (asks.startsWith('gpt-') && providers.openai) {
        target = 'openai';
        why = 'model rule';
      }
    }
    const entry = target ? providers[target] : undefined;
    const name = target === 'anthropic' ? 'Anthropic' : target === 'openai' ? 'OpenAI' : target;
    return {
      agent,
      asks,
      destination: entry ? `${name} (${why})` : "main provider / agent's own backend override",
      sent: entry ? entry.modelMap[asks] ?? asks : '—',
    };
  });
}

export function dualApiBadge(draft: ProxySettings): string {
  if (!draft.dualApiEnabled) return 'off';
  const count = ['anthropic', 'openai'].filter((name) => draft.providers[name]).length;
  return count === 2 ? 'both APIs' : count === 1 ? 'one API' : 'off';
}

export function dualRouteNote(draft: ProxySettings, port: number): string {
  const count = ['anthropic', 'openai'].filter((name) => draft.providers[name]).length;
  if (!draft.dualApiEnabled) return 'Dual API routing is off — every agent uses its own Backend Override or the main provider below.';
  if (count === 0) return 'No keys saved — every agent keeps using the main provider below.';
  if (!draft.modelRouting) return 'Model-name routing is off, so only pinned agents use these providers.';
  return `Agents reach these through their tagged URLs, e.g. http://127.0.0.1:${port}/a/qwen/v1`;
}
