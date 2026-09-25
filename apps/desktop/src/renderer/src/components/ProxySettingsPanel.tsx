import { Check, KeyRound, Plus, RefreshCw, Route, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, CredentialStatus } from '@kai/contracts';
import { confirmDialog } from './AppDialog';

type ProxySettings = AppSettings['proxy'];
type ProviderEntry = ProxySettings['providers'][string];
type FallbackProvider = ProxySettings['fallbackProviders'][number];
type AgentBackend = ProxySettings['kimiConfig'];

interface ProxyPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  credentialId: string;
  modelMap: Record<string, string>;
}

const claudeAliases = [
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

const agentPlaceholderModels = ['gpt-5.5', 'qwen-proxy', 'qwen-coder-plus', 'kimi-for-coding', 'kimi-k2.6'];
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const CLAUDE_MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'];
const CODEX_MODELS = ['gpt-6-astra', 'gpt-5.5', ...DEEPSEEK_MODELS];
const QWEN_MODELS = ['qwen-coder-plus', 'qwen-proxy', ...DEEPSEEK_MODELS];
const KIMI_MODELS = ['kimi-for-coding', 'kimi-k2.6', ...DEEPSEEK_MODELS];

function mapAliases(model: string): Record<string, string> {
  return Object.fromEntries([...claudeAliases, ...agentPlaceholderModels].map((alias) => [alias, model]));
}

const PROXY_PRESETS: ProxyPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter (Auto Router)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    credentialId: 'provider.openrouter',
    modelMap: mapAliases('openrouter/auto'),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Flash (OpenAI)',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    credentialId: 'provider.deepseek',
    modelMap: mapAliases('deepseek-flash'),
  },
  {
    id: 'deepseek-anthropic',
    label: 'DeepSeek Flash (Anthropic pass-through)',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-flash',
    credentialId: 'provider.deepseek',
    modelMap: mapAliases('deepseek-flash'),
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT-6 Astra)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6-astra',
    credentialId: 'provider.openai',
    modelMap: mapAliases('gpt-6-astra'),
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    credentialId: 'provider.xai',
    modelMap: mapAliases('grok-3'),
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi (OpenAI)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    credentialId: 'provider.moonshot',
    modelMap: mapAliases('kimi-k2.6'),
  },
  {
    id: 'moonshot-anthropic',
    label: 'Moonshot / Kimi (Anthropic pass-through)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2.6',
    credentialId: 'provider.moonshot',
    modelMap: mapAliases('kimi-k2.6'),
  },
  {
    id: 'kimi-com',
    label: 'Kimi.com (OpenAI)',
    baseUrl: 'https://api.kimi.com/coding/v1',
    defaultModel: 'kimi-for-coding',
    credentialId: 'provider.kimi',
    modelMap: mapAliases('kimi-for-coding'),
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    credentialId: 'provider.groq',
    modelMap: mapAliases('llama-3.3-70b-versatile'),
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    credentialId: 'provider.together',
    modelMap: mapAliases('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder',
    credentialId: 'proxy.local',
    modelMap: mapAliases('qwen2.5-coder'),
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    credentialId: 'proxy.local',
    modelMap: mapAliases('local-model'),
  },
  {
    id: 'glm',
    label: 'Z.AI / GLM (Zhipu AI)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    defaultModel: 'glm-5.1',
    credentialId: 'provider.zai',
    modelMap: mapAliases('glm-5.1'),
  },
  {
    id: 'anthropic',
    label: 'Anthropic (pass-through)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: '',
    credentialId: 'provider.anthropic',
    modelMap: {},
  },
];

export function ProxySettingsPanel({
  settings,
  busy,
  credentialStatus,
  onSave,
  onSaveCredential,
  onClearCredential,
}: {
  settings: AppSettings;
  busy: boolean;
  credentialStatus: CredentialStatus;
  onSave: (update: { proxy: ProxySettings }) => Promise<void> | void;
  onSaveCredential: (id: string, value: string) => Promise<void> | void;
  onClearCredential: (id: string) => Promise<void> | void;
}): ReactNode {
  const [draft, setDraft] = useState(settings.proxy);
  const [presetId, setPresetId] = useState('deepseek');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings.proxy);
  }, [settings.proxy]);

  function patch(update: Partial<ProxySettings>): void {
    setSaved(false);
    setDraft((current) => ({ ...current, ...update }));
  }

  async function save(): Promise<void> {
    setError(null);
    try {
      await onSave({ proxy: draft });
      setSaved(true);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function applyPreset(): void {
    const preset = PROXY_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    patch({
      targetBaseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      credentialId: preset.credentialId,
      modelMap: preset.modelMap,
    });
  }

  function enableDualProviders(): void {
    const openaiModel = 'gpt-6-astra';
    const anthropicModel = 'claude-opus-5';
    patch({
      dualApiEnabled: true,
      modelRouting: true,
      providers: {
        ...draft.providers,
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          credentialId: 'provider.anthropic',
          format: 'anthropic',
          defaultModel: '',
          modelMap: Object.fromEntries(agentPlaceholderModels.map((model) => [model, anthropicModel])),
        },
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          credentialId: 'provider.openai',
          format: 'openai',
          defaultModel: '',
          modelMap: mapAliases(openaiModel),
        },
      },
    });
  }

  return (
    <section className="proxy-settings-panel">
      <div className="proxy-settings-heading">
        <div>
          <span className="eyebrow">Universal Agent Proxy</span>
          <h2>Proxy configuration</h2>
          <p>Configure the managed engine, routing rules, limits, diagnostics, and agent backends.</p>
        </div>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
          {saved ? <Check size={15} /> : <RefreshCw size={15} />}
          <span>{saved ? 'Saved' : 'Save and restart proxy'}</span>
        </button>
      </div>

      {error && <div className="proxy-error" role="alert">{error}</div>}

      <div className="proxy-settings-grid">
        <SettingsSection title="Credentials and vault" icon={<ShieldCheck size={16} />} wide>
          <CredentialCentre
            status={credentialStatus}
            initialId={draft.credentialId}
            busy={busy}
            onSave={onSaveCredential}
            onClear={onClearCredential}
          />
        </SettingsSection>

        <SettingsSection title="Agent profiles" icon={<KeyRound size={16} />} wide>
          <p className="settings-note">Each CLI keeps its own native sign-in. The proxy profile below controls only that agent’s routed runs; keys are credential IDs in the desktop vault.</p>
          <AgentProfiles
            draft={draft}
            patch={patch}
            credentialStatus={credentialStatus}
            busy={busy}
            onSaveCredential={onSaveCredential}
            onSaveProfile={save}
          />
        </SettingsSection>

        <SettingsSection title="Service and main provider" icon={<Route size={16} />}>
          <ToggleField
            label="Enable Universal Proxy"
            detail="Run the pinned proxy behind the authenticated KAI loopback gateway."
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />
          <div className="field-grid">
            <NumberField label="Port" value={draft.port} min={1024} max={65535} onChange={(port) => patch({ port })} />
            <TextField label="Target base URL" value={draft.targetBaseUrl} onChange={(targetBaseUrl) => patch({ targetBaseUrl })} />
            <TextField label="Default model" value={draft.defaultModel} onChange={(defaultModel) => patch({ defaultModel })} />
            <TextField label="Credential ID" value={draft.credentialId} onChange={(credentialId) => patch({ credentialId })} />
          </div>
          <div className="proxy-inline-controls">
            <label className="field">
              <span>Provider preset</span>
              <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
                {PROXY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button align-end" onClick={applyPreset}>
              <RefreshCw size={14} />
              <span>Apply preset</span>
            </button>
            <button type="button" className="secondary-button align-end" onClick={enableDualProviders}>
              <Route size={14} />
              <span>Use OpenAI + Claude for every agent</span>
            </button>
          </div>
          <JsonField
            label="Claude model map (JSON object)"
            value={draft.modelMap}
            onChange={(modelMap) => patch({ modelMap })}
          />
          <JsonField
            label="Custom upstream headers (JSON object)"
            value={draft.customHeaders}
            onChange={(customHeaders) => patch({ customHeaders })}
          />
        </SettingsSection>

        <SettingsSection title="Routing" icon={<Route size={16} />}>
          <ToggleField
            label="Model-name routing"
            detail="Use provider names and model rules to select an upstream."
            checked={draft.modelRouting}
            onChange={(modelRouting) => patch({ modelRouting })}
          />
          <ToggleField
            label="Dual API routing"
            detail="Enable named providers, model routes, and agent pins."
            checked={draft.dualApiEnabled}
            onChange={(dualApiEnabled) => patch({ dualApiEnabled })}
          />
          <ToggleField
            label="Route Claude Code"
            detail="Owned by the explicit Route action; startup does not silently change agent configs."
            checked={draft.routeClaudeCode}
            onChange={(routeClaudeCode) => patch({ routeClaudeCode })}
          />
          <NumberField
            label="Claude route expiry (epoch ms, 0 = none)"
            value={draft.routeClaudeCodeUntil}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            onChange={(routeClaudeCodeUntil) => patch({ routeClaudeCodeUntil })}
          />
          <ToggleField
            label="Route Codex"
            detail="Owned by the explicit Route action."
            checked={draft.routeCodex}
            onChange={(routeCodex) => patch({ routeCodex })}
          />
          <ToggleField
            label="Auto fallback on Claude usage limits"
            detail="Temporarily route Claude Code through the proxy when a usage-limit message is detected."
            checked={draft.autoFallbackEnabled}
            onChange={(autoFallbackEnabled) => patch({ autoFallbackEnabled })}
          />
          <NumberField
            label="Fallback window (hours)"
            value={draft.autoFallbackHours}
            min={1}
            max={24}
            onChange={(autoFallbackHours) => patch({ autoFallbackHours })}
          />
          <ListSection
            title="Custom model routes"
            empty="No custom model routes"
            onAdd={() => patch({ modelRoutes: [...draft.modelRoutes, { match: 'claude-*', provider: 'anthropic' }] })}
          >
            {draft.modelRoutes.map((route, index) => (
              <div className="proxy-list-row" key={`${index}-${route.match}`}>
                <TextField label="Model glob" value={route.match} onChange={(match) => patch({
                  modelRoutes: draft.modelRoutes.map((item, itemIndex) => itemIndex === index ? { ...item, match } : item),
                })} />
                <TextField label="Provider name" value={route.provider} onChange={(provider) => patch({
                  modelRoutes: draft.modelRoutes.map((item, itemIndex) => itemIndex === index ? { ...item, provider } : item),
                })} />
                <RemoveButton label={`Remove model route ${index + 1}`} onClick={() => patch({
                  modelRoutes: draft.modelRoutes.filter((_, itemIndex) => itemIndex !== index),
                })} />
              </div>
            ))}
          </ListSection>
          <AgentPins draft={draft} patch={patch} />
          <NamedProviders draft={draft} patch={patch} />
          <FallbackProviders draft={draft} patch={patch} />
        </SettingsSection>

        <SettingsSection title="Reliability" icon={<RefreshCw size={16} />}>
          <div className="field-grid">
            <NumberField label="Max retries" value={draft.retryConfig.maxRetries} min={0} max={10} onChange={(maxRetries) => patch({ retryConfig: { ...draft.retryConfig, maxRetries } })} />
            <NumberField label="Retry base delay (ms)" value={draft.retryConfig.baseDelayMs} min={100} max={30_000} onChange={(baseDelayMs) => patch({ retryConfig: { ...draft.retryConfig, baseDelayMs } })} />
            <NumberField label="Retry max delay (ms)" value={draft.retryConfig.maxDelayMs} min={1_000} max={120_000} onChange={(maxDelayMs) => patch({ retryConfig: { ...draft.retryConfig, maxDelayMs } })} />
            <NumberField label="Error threshold" value={draft.errorNotifyThreshold.count} min={1} max={100} onChange={(count) => patch({ errorNotifyThreshold: { ...draft.errorNotifyThreshold, count } })} />
            <NumberField label="Error window (minutes)" value={draft.errorNotifyThreshold.windowMinutes} min={1} max={1_440} onChange={(windowMinutes) => patch({ errorNotifyThreshold: { ...draft.errorNotifyThreshold, windowMinutes } })} />
            <NumberField label="Upstream timeout (ms)" value={draft.upstreamTimeoutMs} min={10_000} max={3_600_000} onChange={(upstreamTimeoutMs) => patch({ upstreamTimeoutMs })} />
            <NumberField label="Stall timeout (ms, 0 = off)" value={draft.stallTimeoutMs} min={0} max={3_600_000} onChange={(stallTimeoutMs) => patch({ stallTimeoutMs })} />
            <NumberField label="Max concurrent requests (0 = unlimited)" value={draft.maxConcurrentRequests} min={0} max={10_000} onChange={(maxConcurrentRequests) => patch({ maxConcurrentRequests })} />
            <NumberField label="Max requests per second (0 = off)" value={draft.rateLimit.maxRequestsPerSecond} min={0} max={10_000} onChange={(maxRequestsPerSecond) => patch({ rateLimit: { maxRequestsPerSecond } })} />
          </div>
        </SettingsSection>

        <SettingsSection title="Cost, history, logging, TLS" icon={<KeyRound size={16} />}>
          <div className="field-grid">
            <NumberField label="Daily budget (0 = off)" value={draft.costBudget.daily} min={0} max={1_000_000} onChange={(daily) => patch({ costBudget: { ...draft.costBudget, daily } })} />
            <NumberField label="Weekly budget (0 = off)" value={draft.costBudget.weekly} min={0} max={1_000_000} onChange={(weekly) => patch({ costBudget: { ...draft.costBudget, weekly } })} />
            <NumberField label="Monthly budget (0 = off)" value={draft.costBudget.monthly} min={0} max={1_000_000} onChange={(monthly) => patch({ costBudget: { ...draft.costBudget, monthly } })} />
            <TextField label="Budget currency" value={draft.costBudget.currency} onChange={(currency) => patch({ costBudget: { ...draft.costBudget, currency } })} />
            <SelectField label="Budget mode" value={draft.costBudget.mode} options={['warn', 'block']} onChange={(mode) => patch({ costBudget: { ...draft.costBudget, mode: mode as 'warn' | 'block' } })} />
            <NumberField label="History entries" value={draft.historyConfig.maxEntries} min={100} max={2000} onChange={(maxEntries) => patch({ historyConfig: { ...draft.historyConfig, maxEntries } })} />
            <NumberField label="Prompt snippet characters" value={draft.historyConfig.promptSnippetChars} min={100} max={2000} onChange={(promptSnippetChars) => patch({ historyConfig: { ...draft.historyConfig, promptSnippetChars } })} />
            <NumberField label="Replay entries" value={draft.historyConfig.maxReplayEntries} min={0} max={200} onChange={(maxReplayEntries) => patch({ historyConfig: { ...draft.historyConfig, maxReplayEntries } })} />
            <NumberField label="Log file size (MB)" value={draft.logging.maxFileSizeMB} min={1} max={1000} onChange={(maxFileSizeMB) => patch({ logging: { ...draft.logging, maxFileSizeMB } })} />
            <TextField label="Log directory" value={draft.logging.directory} onChange={(directory) => patch({ logging: { ...draft.logging, directory } })} />
            <TextField label="TLS certificate path" value={draft.tls.certPath} onChange={(certPath) => patch({ tls: { ...draft.tls, certPath } })} />
            <TextField label="TLS key path" value={draft.tls.keyPath} onChange={(keyPath) => patch({ tls: { ...draft.tls, keyPath } })} />
          </div>
          <ToggleField label="Prompt snippets in history" detail="Store bounded, redacted prompt previews." checked={draft.historyConfig.includePromptSnippet} onChange={(includePromptSnippet) => patch({ historyConfig: { ...draft.historyConfig, includePromptSnippet } })} />
          <ToggleField label="Persistent request logs" detail="Write rotating JSON-lines request records." checked={draft.logging.enabled} onChange={(enabled) => patch({ logging: { ...draft.logging, enabled } })} />
          <ToggleField label="HTTPS/TLS listener" detail="Serve the proxy over HTTPS; blank paths use a generated certificate." checked={draft.tls.enabled} onChange={(enabled) => patch({ tls: { ...draft.tls, enabled } })} />
        </SettingsSection>
      </div>

      <div className="proxy-settings-footer">
        <span className="settings-note">Saving restarts the managed proxy when it is running. Agent config files are only changed from the Routing tab.</span>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
          {saved ? <Check size={15} /> : <RefreshCw size={15} />}
          <span>{saved ? 'Saved' : 'Save and restart proxy'}</span>
        </button>
      </div>
    </section>
  );
}

function CredentialCentre({
  status,
  initialId,
  busy,
  onSave,
  onClear,
}: {
  status: CredentialStatus;
  initialId: string;
  busy: boolean;
  onSave: (id: string, value: string) => Promise<void> | void;
  onClear: (id: string) => Promise<void> | void;
}): ReactNode {
  const [id, setId] = useState(initialId);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setId(initialId);
  }, [initialId]);

  async function save(): Promise<void> {
    if (!id.trim() || !value.trim()) return;
    try {
      await onSave(id.trim(), value);
      setValue('');
      setMessage(`Stored ${id.trim()} in the OS vault.`);
    } catch (caught) {
      setMessage(messageOf(caught));
    }
  }

  async function clear(credentialId: string): Promise<void> {
    if (!(await confirmDialog({ title: 'Remove stored credential?', detail: `Remove the stored credential for ${credentialId}?`, confirmLabel: 'Remove credential', destructive: true }))) return;
    try {
      await onClear(credentialId);
      setMessage(`Removed ${credentialId}.`);
    } catch (caught) {
      setMessage(messageOf(caught));
    }
  }

  return (
    <div className="proxy-credential-centre">
      <p className="settings-note">
        UAP settings carry credential IDs only. Secret values stay in the desktop OS vault and are resolved when the proxy starts.
      </p>
      <div className="proxy-credential-form">
        <TextField label="Credential ID" value={id} onChange={setId} />
        <TextField label="Secret value" type="password" value={value} onChange={setValue} />
        <button
          type="button"
          className="secondary-button align-end"
          disabled={busy || !status.available || !id.trim() || !value.trim()}
          onClick={() => void save()}
        >
          <KeyRound size={14} />
          <span>Store secret</span>
        </button>
      </div>
      <div className="proxy-credential-list">
        {status.ids.map((credentialId) => (
          <div className="proxy-credential-row" key={credentialId}>
            <span className="mono truncate">{credentialId}</span>
            {credentialId === initialId && <em>Main provider</em>}
            <button
              type="button"
              className="icon-button danger-button"
              disabled={busy}
              aria-label={`Remove credential ${credentialId}`}
              title={`Remove credential ${credentialId}`}
              onClick={() => void clear(credentialId)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {status.ids.length === 0 && <div className="empty-list">No credentials stored for proxy providers</div>}
      </div>
      <span className={`settings-note ${message ? 'visible' : ''}`}>{message ?? (status.available ? 'OS vault available.' : 'OS vault is unavailable.')}</span>
    </div>
  );
}

function NamedProviders({ draft, patch }: { draft: ProxySettings; patch: (update: Partial<ProxySettings>) => void }): ReactNode {
  return (
    <ListSection title="Named providers" empty="No named providers" onAdd={() => patch({
      providers: { ...draft.providers, [`provider-${Object.keys(draft.providers).length + 1}`]: defaultProvider() },
    })}>
      {Object.entries(draft.providers).map(([name, provider]) => (
        <div className="proxy-provider-row" key={name}>
          <div className="proxy-list-row proxy-provider-main">
            <TextField label="Name" value={name} onChange={(nextName) => patch({ providers: renameProvider(draft.providers, name, nextName, provider) })} />
            <TextField label="Base URL" value={provider.baseUrl} onChange={(baseUrl) => patch({ providers: { ...draft.providers, [name]: { ...provider, baseUrl } } })} />
            <TextField label="Credential ID" value={provider.credentialId ?? ''} onChange={(credentialId) => patch({ providers: { ...draft.providers, [name]: withOptional(provider, 'credentialId', credentialId) } })} />
            <SelectField label="Format" value={provider.format} options={['auto', 'anthropic', 'openai']} onChange={(format) => patch({ providers: { ...draft.providers, [name]: { ...provider, format: format as ProviderEntry['format'] } } })} />
            <TextField label="Default model" value={provider.defaultModel ?? ''} onChange={(defaultModel) => patch({ providers: { ...draft.providers, [name]: withOptional(provider, 'defaultModel', defaultModel) } })} />
            <RemoveButton label={`Remove provider ${name}`} onClick={() => patch({ providers: omitRecord(draft.providers, name) })} />
          </div>
          <JsonField label="Provider model map" value={provider.modelMap} onChange={(modelMap) => patch({ providers: { ...draft.providers, [name]: { ...provider, modelMap } } })} />
        </div>
      ))}
    </ListSection>
  );
}

function FallbackProviders({ draft, patch }: { draft: ProxySettings; patch: (update: Partial<ProxySettings>) => void }): ReactNode {
  return (
    <ListSection title="Fallback providers" empty="No fallback providers" onAdd={() => patch({
      fallbackProviders: [...draft.fallbackProviders, { baseUrl: 'https://api.example.com/v1', defaultModel: '', modelMap: {} }],
    })}>
      {draft.fallbackProviders.map((provider, index) => (
        <div className="proxy-list-row" key={`${index}-${provider.baseUrl}`}>
          <TextField label="Base URL" value={provider.baseUrl} onChange={(baseUrl) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, { ...provider, baseUrl }) })} />
          <TextField label="Credential ID" value={provider.credentialId ?? ''} onChange={(credentialId) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, withOptional(provider, 'credentialId', credentialId)) })} />
          <TextField label="Default model" value={provider.defaultModel ?? ''} onChange={(defaultModel) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, withOptional(provider, 'defaultModel', defaultModel)) })} />
          <RemoveButton label={`Remove fallback ${index + 1}`} onClick={() => patch({ fallbackProviders: draft.fallbackProviders.filter((_, itemIndex) => itemIndex !== index) })} />
        </div>
      ))}
    </ListSection>
  );
}

function AgentPins({ draft, patch }: { draft: ProxySettings; patch: (update: Partial<ProxySettings>) => void }): ReactNode {
  const agents = ['claude', 'codex', 'kimi', 'qwen'];
  return (
    <div className="proxy-agent-pins">
      <strong>Agent pins</strong>
      <span className="settings-note">Pin an agent to a named provider when Dual API routing is enabled.</span>
      <div className="field-grid">
        {agents.map((agent) => (
          <TextField
            key={agent}
            label={`${agent} provider`}
            value={draft.agentRoutes[agent] ?? ''}
            onChange={(provider) => patch({
              agentRoutes: provider.trim()
                ? { ...draft.agentRoutes, [agent]: provider.trim() }
                : omitRecord(draft.agentRoutes, agent),
            })}
          />
        ))}
      </div>
    </div>
  );
}

function AgentBackendFields({ title, config, models, onChange }: { title: string; config: AgentBackend; models: string[]; onChange: (config: AgentBackend) => void }): ReactNode {
  return (
    <div className="proxy-agent-backend">
      <ToggleField label={title} detail="Use this backend for tagged requests from the agent." checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
      <TextField label="Base URL" value={config.baseUrl} onChange={(baseUrl) => onChange({ ...config, baseUrl })} />
      <TextField label="Credential ID" value={config.credentialId ?? ''} onChange={(credentialId) => onChange(withOptional(config, 'credentialId', credentialId))} />
      <ModelField label="Default model" value={config.defaultModel} options={models} onChange={(defaultModel) => onChange({ ...config, defaultModel })} />
      <ModelField label="Client relay model" value={config.configModel ?? ''} options={models} onChange={(configModel) => onChange(withOptional(config, 'configModel', configModel))} />
    </div>
  );
}

function AgentProfiles({
  draft, patch, credentialStatus, busy, onSaveCredential, onSaveProfile,
}: {
  draft: ProxySettings;
  patch: (update: Partial<ProxySettings>) => void;
  credentialStatus: CredentialStatus;
  busy: boolean;
  onSaveCredential: (id: string, value: string) => Promise<void> | void;
  onSaveProfile: () => Promise<void>;
}): ReactNode {
  const providerNames = Object.keys(draft.providers);
  const pin = (agent: string): string => draft.agentRoutes[agent] ?? '__shared__';
  const setPin = (agent: string, provider: string): void => patch({
    agentRoutes: provider === '__shared__'
      ? omitRecord(draft.agentRoutes, agent)
      : { ...draft.agentRoutes, [agent]: provider },
  });
  const providerPicker = (agent: string): ReactNode => (
    <label className="field">
      <span>Proxy provider</span>
      <select value={pin(agent)} onChange={(event) => setPin(agent, event.target.value)}>
        <option value="__shared__">Shared upstream</option>
        {providerNames.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  );
  const credentialState = (agent: string, backend?: AgentBackend): ReactNode => {
    const pinned = draft.agentRoutes[agent];
    const credentialId = backend?.enabled
      ? backend.credentialId
      : pinned
        ? draft.providers[pinned]?.credentialId
        : draft.credentialId;
    const ready = Boolean(credentialId && credentialStatus.ids.includes(credentialId));
    return <span className={`proxy-profile-credential ${ready ? 'ready' : 'missing'}`}>
      {ready ? `Proxy credential ready · ${credentialId}` : `Missing proxy credential · ${credentialId || 'choose a credential ID'}`}
    </span>;
  };
  const claudeProfile = draft.providers.claude ?? {
    baseUrl: 'https://api.deepseek.com/anthropic',
    credentialId: 'provider.deepseek',
    format: 'anthropic' as const,
    defaultModel: 'deepseek-flash',
    modelMap: {},
  };
  const updateClaudeProfile = (update: Partial<ProviderEntry>): void => patch({
    providers: { ...draft.providers, claude: { ...claudeProfile, ...update } },
    agentRoutes: { ...draft.agentRoutes, claude: 'claude' },
  });
  return (
    <div className="proxy-agent-profiles">
      <article className="proxy-agent-profile">
        <header><div><strong>Claude Code</strong><span>Native account or DeepSeek Anthropic proxy</span></div><button type="button" className="secondary-button compact" title="Save Claude proxy profile" disabled={busy} onClick={() => void onSaveProfile()}><Check size={14} /><span>Save</span></button></header>
        <p>Direct runs use your Claude login. Proxy runs use this saved Anthropic-compatible profile and preserve the KAI conversation context.</p>
        <div className="field-grid">
          <TextField label="Anthropic-compatible base URL" value={claudeProfile.baseUrl} onChange={(baseUrl) => updateClaudeProfile({ baseUrl })} />
          <ModelField label="Claude proxy model" value={claudeProfile.defaultModel ?? ''} options={CLAUDE_MODELS} onChange={(defaultModel) => updateClaudeProfile({ defaultModel })} />
          <TextField label="Vault credential ID" value={claudeProfile.credentialId ?? ''} onChange={(credentialId) => updateClaudeProfile({ credentialId })} />
        </div>
        <small className="settings-note">DeepSeek Anthropic endpoint: <code>https://api.deepseek.com/anthropic</code>. Select a DeepSeek model, save the API key below, then save this profile.</small>
        <ProfileCredentialStore credentialId={claudeProfile.credentialId ?? ''} label="DeepSeek API key" busy={busy} onSave={onSaveCredential} />
        {credentialState('claude')}
        <ToggleField label="Route Claude Code" detail="Enable only from an explicit route action; this does not change your native login." checked={draft.routeClaudeCode} onChange={(routeClaudeCode) => patch({ routeClaudeCode })} />
      </article>
      <article className="proxy-agent-profile">
        <header><div><strong>Codex</strong><span>Native account or override</span></div><button type="button" className="secondary-button compact" title="Save Codex proxy profile" disabled={busy} onClick={() => void onSaveProfile()}><Check size={14} /><span>Save</span></button></header>
        <p>Direct runs use the Codex login. Enable an override only when routed Codex traffic needs a different provider.</p>
        {providerPicker('codex')}
        {credentialState('codex', draft.codexConfig)}
        <details className="proxy-profile-details" open={draft.codexConfig.enabled}><summary>Dedicated Codex backend</summary><AgentBackendFields title="Use a dedicated Codex backend" config={draft.codexConfig} models={CODEX_MODELS} onChange={(codexConfig) => patch({ codexConfig })} /></details>
      </article>
      <article className="proxy-agent-profile">
        <header><div><strong>Qwen Code</strong><span>Native account or override</span></div><button type="button" className="secondary-button compact" title="Save Qwen proxy profile" disabled={busy} onClick={() => void onSaveProfile()}><Check size={14} /><span>Save</span></button></header>
        <p>Choose the shared provider or attach Qwen Code to its own OpenAI-compatible backend.</p>
        {providerPicker('qwen')}
        {credentialState('qwen', draft.qwenConfig)}
        <details className="proxy-profile-details" open={draft.qwenConfig.enabled}><summary>Dedicated Qwen backend</summary><AgentBackendFields title="Use a dedicated Qwen backend" config={draft.qwenConfig} models={QWEN_MODELS} onChange={(qwenConfig) => patch({ qwenConfig })} /></details>
      </article>
      <article className="proxy-agent-profile">
        <header><div><strong>Kimi Code</strong><span>Native account or override</span></div><button type="button" className="secondary-button compact" title="Save Kimi proxy profile" disabled={busy} onClick={() => void onSaveProfile()}><Check size={14} /><span>Save</span></button></header>
        <p>Choose the shared provider or attach Kimi Code to its own coding endpoint.</p>
        {providerPicker('kimi')}
        {credentialState('kimi', draft.kimiConfig)}
        <details className="proxy-profile-details" open={draft.kimiConfig.enabled}><summary>Dedicated Kimi backend</summary><AgentBackendFields title="Use a dedicated Kimi backend" config={draft.kimiConfig} models={KIMI_MODELS} onChange={(kimiConfig) => patch({ kimiConfig })} /></details>
      </article>
    </div>
  );
}

function ListSection({ title, empty, onAdd, children }: { title: string; empty: string; onAdd: () => void; children: ReactNode }): ReactNode {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="proxy-list-section">
      <div className="proxy-list-heading">
        <strong>{title}</strong>
        <button type="button" className="secondary-button" onClick={onAdd}><Plus size={14} /><span>Add</span></button>
      </div>
      {hasChildren ? <div className="proxy-list">{children}</div> : <div className="empty-list">{empty}</div>}
    </div>
  );
}

function SettingsSection({ title, icon, wide = false, children }: { title: string; icon: ReactNode; wide?: boolean; children: ReactNode }): ReactNode {
  return (
    <section className={`settings-section proxy-settings-section ${wide ? 'proxy-settings-wide' : ''}`}>
      <div className="section-title">{icon}<span>{title}</span></div>
      {children}
    </section>
  );
}

function TextField({ label, value, type = 'text', onChange }: { label: string; value: string; type?: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ModelField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }): ReactNode {
  const choices = Array.from(new Set([value, ...options].filter(Boolean)));
  return <label className="field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{choices.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>;
}

function ProfileCredentialStore({ credentialId, label, busy, onSave }: {
  credentialId: string;
  label: string;
  busy: boolean;
  onSave: (id: string, value: string) => Promise<void> | void;
}): ReactNode {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  async function store(): Promise<void> {
    if (!credentialId.trim() || !value.trim()) return;
    await onSave(credentialId.trim(), value);
    setValue('');
    setSaved(true);
  }
  return <div className="proxy-profile-secret">
    <TextField label={label} type="password" value={value} onChange={(next) => { setValue(next); setSaved(false); }} />
    <button type="button" className="secondary-button align-end" title="Save this API key securely in the OS vault" disabled={busy || !credentialId.trim() || !value.trim()} onClick={() => void store()}>
      <KeyRound size={14} /><span>{saved ? 'Key saved' : 'Save API key'}</span>
    </button>
  </div>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }): ReactNode {
  return <label className="field"><span>{label}</span><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function ToggleField({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  return <label className="toggle-row"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function JsonField<T extends Record<string, string>>({ label, value, onChange }: { label: string; value: T; onChange: (value: T) => void }): ReactNode {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <label className="field proxy-json-field">
      <span>{label}{invalid && <em>Invalid JSON</em>}</span>
      <textarea
        value={text}
        rows={4}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object.');
            onChange(parsed as T);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </label>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return <button type="button" className="icon-button danger-button proxy-remove-button" aria-label={label} title={label} onClick={onClick}><Trash2 size={14} /></button>;
}

function defaultProvider(): ProviderEntry {
  return { baseUrl: 'https://api.example.com/v1', format: 'auto', defaultModel: '', modelMap: {} };
}

function renameProvider(providers: ProxySettings['providers'], oldName: string, nextName: string, provider: ProviderEntry): ProxySettings['providers'] {
  const next: ProxySettings['providers'] = {};
  for (const [name, value] of Object.entries(providers)) {
    if (name === oldName) next[nextName || oldName] = provider;
    else next[name] = value;
  }
  return next;
}

function omitRecord<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

function withOptional<T extends object, K extends keyof T>(value: T, key: K, next: string): T {
  return next.trim() ? { ...value, [key]: next.trim() } : Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key)) as T;
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((candidate, candidateIndex) => candidateIndex === index ? value : candidate);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The proxy settings could not be saved.';
}
