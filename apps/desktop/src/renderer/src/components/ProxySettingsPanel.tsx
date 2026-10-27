// Configuration sections of the Universal Agent Proxy dashboard: the Agents, Providers and Advanced
// tabs. Layout, wording and field order follow ClaudeCode-Proxy `dashboard.html`; secrets are held
// in the desktop OS vault and the settings carry only their credential IDs.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ClipboardCopy, Download, KeyRound, RotateCcw, Upload, X } from 'lucide-react';
import type { CredentialStatus, ProxyAgentId, ProxyAgentRoute } from '@kai/contracts';
import { confirmDialog, promptDialog } from './AppDialog';
import { Pill } from './Pill';
import {
  AGENTS,
  AGENT_LABELS,
  CLAUDE_CLIENT_MODELS,
  MAIN_PRESET_OPTIONS,
  PRESETS,
  PROVIDER_LABELS,
  ROUTING_PROFILES,
  applyMainPreset,
  backendKey,
  catalogFor,
  CATALOG_DEFAULTS,
  describeCatalogModel,
  dualApiBadge,
  dualProviderMap,
  dualRouteNote,
  dualRoutePreview,
  modelLabel,
  modelSuggestions,
  presetKeyForUrl,
  presetsFor,
  type BackendAgent,
  type ProxyAgentBackend,
  type ProxyProviderEntry,
  type ProxySettings,
} from './proxy-dashboard-data';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
export interface ConfigTabProps {
  draft: ProxySettings;
  patch: (update: Partial<ProxySettings>) => void;
  save: (section: string, next?: ProxySettings) => void;
  savedSection: string | null;
  busy: boolean;
  credentialStatus: CredentialStatus;
  onSaveCredential: (id: string, value: string) => Promise<boolean | void> | void;
  onClearCredential: (id: string) => Promise<boolean | void> | void;
}

// ---- Agents tab -------------------------------------------------------------

export function AgentsTab(props: ConfigTabProps & {
  routes: ProxyAgentRoute[];
  openSection: ProxyAgentId | null;
  loginMode: boolean;
  onSaveAgentKey: (agent: ProxyAgentId, value: string) => void;
  onCopyEnv: (agent: ProxyAgentId) => void;
  onEnterLoginMode: () => void;
  onRestoreProxy: () => void;
  onLaunch: (agent: 'claude' | 'codex') => void;
}): ReactNode {
  const { draft, patch, save, savedSection, credentialStatus, routes, openSection } = props;

  const claudePreset = presetKeyForUrl('claude', draft.targetBaseUrl);
  return (
    <>
      <details className="section" open={openSection === 'claude' || undefined}>
        <summary><h2>Claude Code</h2><RouteBadge route={routes.find((route) => route.agentId === 'claude')} /></summary>
        <div className="details-body">
          <SaveRow label="Save Claude settings" saved={savedSection === 'agent:claude'} busy={props.busy} onSave={() => save('agent:claude')} />
          <p className="hint lead">Claude Code uses the main proxy backend. Choose the provider here or use the equivalent settings under Providers.</p>
          <PresetField
            agent="claude"
            value={claudePreset === 'custom' ? '' : claudePreset}
            onChange={(key) => patch(applyMainPreset(draft, key))}
          />
          <TextField label="Base URL" value={draft.targetBaseUrl} placeholder="https://api.anthropic.com" onChange={(targetBaseUrl) => patch({ targetBaseUrl })} />
          <div className="row">
            <div className="u-field">
              <KeyField
                label="API Key"
                credentialId={draft.credentialId}
                placeholder="sk-… (blank = Claude OAuth)"
                credentialStatus={credentialStatus}
                busy={props.busy}
                onSave={(value) => props.onSaveAgentKey('claude', value)}
              />
            </div>
            <div className="u-field w240">
              <ModelSelect label="Default model" providerKey={claudePreset} value={draft.defaultModel} onChange={(defaultModel) => patch({ defaultModel })} />
            </div>
          </div>
          <RouteDetails route={routes.find((route) => route.agentId === 'claude')} onCopyEnv={() => props.onCopyEnv('claude')} />
        </div>
      </details>

      {(['kimi', 'qwen', 'codex'] as const).map((agent) => (
        <BackendSection key={agent} {...props} agent={agent} open={openSection === agent} route={routes.find((route) => route.agentId === agent)} />
      ))}

      <div className="section">
        <h2>Claude Login</h2>
        <p className="hint lead">
          If Claude Code needs to authenticate (login / reset), the proxy will block it.
          Click below to temporarily disable the proxy and let Claude connect directly to Anthropic.
        </p>
        <div className="button-row">
          {props.loginMode
            ? <UiButton type="button" className="btn sec" disabled={props.busy} onClick={props.onRestoreProxy}><RotateCcw size={14} /> Restore Proxy</UiButton>
            : <UiButton type="button" className="btn" disabled={props.busy} onClick={props.onEnterLoginMode}><KeyRound size={14} /> Enter Claude Login Mode</UiButton>}
        </div>
        {props.loginMode && <p className="hint">Proxy disabled. Run <code>claude login</code> in your terminal, then click <strong>Restore Proxy</strong>.</p>}
      </div>

      <div className="section">
        <h2>Launch</h2>
        <p className="hint lead">Open Claude Code or Codex CLI in a new terminal with the proxy configured and ready to use.</p>
        <div className="button-row">
          <UiButton type="button" className="btn" disabled={props.busy} onClick={() => props.onLaunch('claude')}>Launch Claude Code</UiButton>
          <UiButton type="button" className="btn sec" disabled={props.busy} onClick={() => props.onLaunch('codex')}>Launch Codex</UiButton>
        </div>
      </div>
    </>
  );
}

const BACKEND_COPY: Record<BackendAgent, { toggle: string; hint: ReactNode; keyLabel: string; keyPlaceholder: string; urlPlaceholder: string }> = {
  kimi: {
    toggle: 'Route Kimi Code to its own backend',
    hint: <>When enabled, Kimi Code requests (model: <code>kimi-for-coding</code>) are forwarded to this backend instead of the main config above.</>,
    keyLabel: "API Key (leave blank to pass Kimi Code's OAuth token)",
    keyPlaceholder: '(blank = use Kimi OAuth)',
    urlPlaceholder: 'https://api.kimi.com/coding/v1',
  },
  qwen: {
    toggle: 'Route Qwen Code to its own backend',
    hint: <>When enabled, Qwen Code requests (model: <code>qwen-*</code>) are forwarded to this backend instead of the main config above.</>,
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-…',
    urlPlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  codex: {
    toggle: 'Route Codex to its own backend',
    hint: 'When enabled, Codex requests are forwarded to this backend instead of the main config above. Use this to give Codex its own API key / provider (e.g. OpenAI).',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-… (leave blank to pass through Codex auth)',
    urlPlaceholder: 'https://api.openai.com/v1',
  },
};

function BackendSection(props: ConfigTabProps & {
  agent: BackendAgent;
  open: boolean;
  route: ProxyAgentRoute | undefined;
  onSaveAgentKey: (agent: ProxyAgentId, value: string) => void;
  onCopyEnv: (agent: ProxyAgentId) => void;
}): ReactNode {
  const { agent, draft, patch, save, savedSection, credentialStatus } = props;
  const field = backendKey(agent);
  const backend = draft[field];
  const copy = BACKEND_COPY[agent];
  const presetKey = presetKeyForUrl(agent, backend.baseUrl);
  const update = (next: Partial<ProxyAgentBackend>): void => patch({ [field]: { ...backend, ...next } } as Partial<ProxySettings>);
  const name = agent === 'codex' ? 'Codex' : AGENT_LABELS[agent].split(' ')[0];
  return (
    <details className="section" open={props.open || undefined}>
      <summary><h2>{AGENT_LABELS[agent]}</h2><Pill tone={backend.enabled ? 'success' : 'neutral'}>{backend.enabled ? 'own backend' : 'main provider'}</Pill><RouteBadge route={props.route} /></summary>
      <div className="details-body">
        <SaveRow label={`Save ${name} settings`} saved={savedSection === `agent:${agent}`} busy={props.busy} onSave={() => save(`agent:${agent}`)} />
        <p className="hint lead">{copy.hint}</p>
        <div className="u-field u-toggle">
          <Checkbox id={`uap-${agent}-enabled`} checked={backend.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          <label htmlFor={`uap-${agent}-enabled`}>{copy.toggle}</label>
        </div>
        <div style={{ marginTop: 12 }}>
          <PresetField
            agent={agent}
            value={presetKey === 'custom' ? '' : presetKey}
            onChange={(key) => {
              const preset = presetsFor(agent)[key];
              if (!preset) return;
              update({
                baseUrl: preset.baseUrl,
                defaultModel: preset.defaultModel || backend.defaultModel,
                ...(preset.configModel ? { configModel: preset.configModel } : {}),
              });
            }}
          />
          <TextField label="Base URL" value={backend.baseUrl} placeholder={copy.urlPlaceholder} onChange={(baseUrl) => update({ baseUrl })} />
          <div className="row">
            <div className="u-field">
              <KeyField
                label={copy.keyLabel}
                credentialId={backend.credentialId || `agent.${agent}`}
                placeholder={copy.keyPlaceholder}
                credentialStatus={credentialStatus}
                busy={props.busy}
                onSave={(value) => props.onSaveAgentKey(agent, value)}
              />
            </div>
            <div className="u-field w240">
              <ModelSelect label={agent === 'codex' ? 'Upstream model' : 'Default model'} providerKey={presetKey} value={backend.defaultModel} onChange={(defaultModel) => update({ defaultModel })} />
            </div>
            {agent !== 'kimi' && (
              <div className="u-field w240">
                <TextField
                  label={agent === 'codex' ? 'Proxy relay model ⓘ' : 'Client relay model ⓘ'}
                  title={`The client-side model ID written to the ${name} config. It is a stable relay name; the proxy replaces it with the upstream model.`}
                  value={backend.configModel ?? ''}
                  placeholder={agent === 'codex' ? 'gpt-5.6-sol' : 'qwen-proxy'}
                  onChange={(configModel) => update(configModel.trim() ? { configModel: configModel.trim() } : { configModel: undefined })}
                />
              </div>
            )}
          </div>
          <TextField
            label="Vault credential ID"
            value={backend.credentialId ?? ''}
            placeholder={`agent.${agent}`}
            onChange={(credentialId) => update({ credentialId: credentialId.trim() || undefined })}
          />
        </div>
        <RouteDetails route={props.route} onCopyEnv={() => props.onCopyEnv(agent)} />
      </div>
    </details>
  );
}

function RouteBadge({ route }: { route: ProxyAgentRoute | undefined }): ReactNode {
  if (!route) return null;
  const label = !route.installed ? 'Unavailable' : route.route === 'proxy' ? 'Proxy' : route.route === 'misconfigured' ? 'Repair' : 'Direct';
  return <Pill tone={!route.installed ? 'error' : route.route === 'proxy' ? 'success' : route.route === 'misconfigured' ? 'warning' : 'neutral'}>{label}</Pill>;
}

function RouteDetails({ route, onCopyEnv }: { route: ProxyAgentRoute | undefined; onCopyEnv: () => void }): ReactNode {
  if (!route) return null;
  return (
    <>
      <dl className="agent-extra">
        <div><dt>Local endpoint</dt><dd title={route.localEndpoint}>{route.localEndpoint ?? '—'}</dd></div>
        <div><dt>Config files</dt><dd title={route.configSources.join(', ')}>{route.configSources.join(', ') || '—'}</dd></div>
        <div><dt>Last verified</dt><dd>{route.lastVerified ? `${route.lastVerified.success ? 'Passed' : 'Failed'} · ${new Date(route.lastVerified.timestamp).toLocaleString()}` : 'Not verified'}</dd></div>
        <div><dt>Credential</dt><dd>{route.credentialSource.replace(/-/g, ' ')}</dd></div>
      </dl>
      {route.restartRequired && <p className="hint"><AlertTriangle size={13} /> Restart the agent to apply its updated route.</p>}
      {route.warnings.map((warning) => <p className="hint" key={warning}><AlertTriangle size={13} /> {warning}</p>)}
      <div className="button-row" style={{ marginTop: 10 }}>
        <UiButton type="button" className="btn sec small" onClick={onCopyEnv} title="Copies the environment variables, including the key the proxy is checking right now. Paste them into a terminal before starting the agent.">
          Copy terminal setup
        </UiButton>
      </div>
      {/* The other way to use the proxy: this is the one that works for a terminal you open yourself, because the
          key is issued fresh every time KAI starts and only the environment carries it. */}
      <p className="hint">
        Paste what that copies into your terminal before starting {route.agentId === 'claude' ? 'Claude Code' : route.agentId === 'codex' ? 'Codex' : route.agentId}.
        The proxy checks a key that changes each time KAI starts, so the variables are the part that matters — a config
        file pointing at the address alone will be refused.
      </p>
    </>
  );
}

// ---- Providers tab ----------------------------------------------------------

export function ProvidersTab(props: ConfigTabProps & {
  claudeResetArmed: boolean;
  onOpenClaudeSettings: () => void;
  onResetClaude: () => void;
  onCancelReset: () => void;
  onExport: () => void;
  onImport: () => void;
  onCopyDiagnostics: () => void;
}): ReactNode {
  const { draft, patch, save, savedSection, credentialStatus } = props;
  const mainPreset = presetKeyForUrl('claude', draft.targetBaseUrl);
  return (
    <>
      <DualApiSection {...props} />

      <div className="section">
        <h2>Quick setup</h2>
        <p className="hint">Choose a setup to fill in the provider and model. Your saved API keys stay private.</p>
        <div className="button-row" style={{ marginTop: 10 }}>
          {ROUTING_PROFILES.map((profile) => (
            <UiButton type="button" className="profile-button" key={profile.id} onClick={() => patch(applyMainPreset(draft, profile.preset))}>
              <strong>{profile.label}</strong><span>{profile.description}</span>
            </UiButton>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Provider preset</h2>
        <div className="u-field">
          <label htmlFor="uap-provider-select">Select a provider to auto-fill all fields below</label>
          <Select id="uap-provider-select" value={mainPreset === 'custom' ? '' : mainPreset} onChange={(event) => { if (event.target.value) patch(applyMainPreset(draft, event.target.value)); }}>
            <option value="">— choose a provider —</option>
            {MAIN_PRESET_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </div>
      </div>

      <div className="section">
        <h2>Claude Code — Connection</h2>
        <TextField label="Base URL" value={draft.targetBaseUrl} placeholder="https://api.deepseek.com" onChange={(targetBaseUrl) => patch({ targetBaseUrl })} />
        <div className="row">
          <div className="u-field">
            <KeyField
              label="API Key"
              credentialId={draft.credentialId}
              placeholder="sk-… (leave blank for Claude OAuth)"
              credentialStatus={credentialStatus}
              busy={props.busy}
              onSave={(value) => void props.onSaveCredential(draft.credentialId, value)}
              onClear={() => void clearStored(draft.credentialId, props.onClearCredential)}
            />
          </div>
          <div className="u-field w240">
            <TextField label="Vault credential ID" value={draft.credentialId} onChange={(credentialId) => patch({ credentialId })} />
          </div>
          <div className="u-field w90">
            <NumberField label="Port" value={draft.port} min={1024} max={65535} onChange={(port) => patch({ port })} />
          </div>
        </div>
        <Toggle id="uap-enabled" label="Proxy enabled" checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
        {/*
          The Auto Fallback toggle and its hours field used to sit here, and neither was read by anything: turning it
          on changed nothing, and the hours were never consulted. The behaviour they describe does exist, but as a
          deliberate hand-off rather than an automatic one — when a subscription limit is reached the composer offers
          to continue through the proxy and shows the provider and budget before the first request. A control that
          promises a switch the app does not have is worse than no control, so it is gone rather than made automatic:
          skipping the card would skip the part that tells you what you are about to spend.
        */}
      </div>

      <div className="section">
        <h2>Custom Headers</h2>
        <KeyValueTable
          keyLabel="Header name"
          valueLabel="Value"
          addLabel="+ Add Header"
          value={draft.customHeaders}
          onChange={(customHeaders) => patch({ customHeaders })}
        />
        <p className="hint">Headers are added to all upstream API requests. Reserved headers (Authorization, Content-Type, etc.) are ignored.</p>
      </div>

      <div className="section">
        <h2>Credential centre</h2>
        <p className="hint">Credentials are stored in the OS vault. Only their IDs are shown here; settings carry the ID, never the secret.</p>
        <CredentialCentre {...props} />
      </div>

      <details className="section">
        <summary><h2>Fallback Providers</h2><span className="hint" style={{ margin: 0 }}>(tried in order on error)</span></summary>
        <div className="details-body">
          <table>
            <thead><tr><th style={{ width: 28 }}>#</th><th>Base URL</th><th>Vault credential ID</th><th>Default model</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {draft.fallbackProviders.map((provider, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td><UiTextInput type="text" value={provider.baseUrl} onChange={(event) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, { ...provider, baseUrl: event.target.value }) })} /></td>
                  <td><UiTextInput type="text" value={provider.credentialId ?? ''} placeholder="provider.example" onChange={(event) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, withOptional(provider, 'credentialId', event.target.value)) })} /></td>
                  <td><UiTextInput type="text" value={provider.defaultModel ?? ''} onChange={(event) => patch({ fallbackProviders: replaceAt(draft.fallbackProviders, index, withOptional(provider, 'defaultModel', event.target.value)) })} /></td>
                  <td><UiButton type="button" className="btn danger small" aria-label={`Remove fallback ${index + 1}`} onClick={() => patch({ fallbackProviders: draft.fallbackProviders.filter((_, i) => i !== index) })}><X size={13} /></UiButton></td>
                </tr>
              ))}
            </tbody>
          </table>
          <UiButton type="button" className="btn sec" style={{ marginTop: 8 }} onClick={() => patch({ fallbackProviders: [...draft.fallbackProviders, { baseUrl: 'https://api.example.com/v1', defaultModel: '', modelMap: {} }] })}>+ Add Fallback</UiButton>
          <p className="hint">When the primary provider or an earlier fallback returns an error (rate limit, server error, etc.), the proxy automatically tries the next fallback in order. Store each fallback's key in the Credential centre under its credential ID.</p>
        </div>
      </details>

      <div className="section">
        <h2>Claude Code — Models</h2>
        <div className="u-field">
          <ModelSelect label="Default model (fallback when no mapping matches)" providerKey={mainPreset} value={draft.defaultModel} onChange={(defaultModel) => patch({ defaultModel })} />
        </div>
        <div className="u-field">
          <label>Model map — Claude model → target model</label>
          <table className="map-table">
            <thead><tr><th>Claude model</th><th>Target model</th></tr></thead>
            <tbody>
              {CLAUDE_CLIENT_MODELS.map((model) => (
                <tr key={model}>
                  <td>{model}</td>
                  <td>
                    <UiTextInput
                      type="text"
                      value={draft.modelMap[model] ?? ''}
                      placeholder="(use default)"
                      onChange={(event) => {
                        const value = event.target.value.trim();
                        patch({ modelMap: value ? { ...draft.modelMap, [model]: value } : omitRecord(draft.modelMap, model) });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Leave blank to fall back to the default model above.</p>
        </div>
      </div>

      <div className="save-row sticky">
        <UiButton type="button" className="btn" disabled={props.busy} onClick={() => save('providers')}>Save</UiButton>
        <UiButton type="button" className="btn sec" onClick={props.onOpenClaudeSettings}>Open Claude Code Settings</UiButton>
        {props.claudeResetArmed ? (
          <span className="confirm-group">
            <span>Reset Claude Code?</span>
            <UiButton type="button" className="btn confirm" onClick={props.onResetClaude}>Confirm</UiButton>
            <UiButton type="button" className="btn sec" onClick={props.onCancelReset}>Cancel</UiButton>
          </span>
        ) : (
          <UiButton type="button" className="btn warn" onClick={props.onResetClaude}>Reset Claude Code</UiButton>
        )}
        <UiButton type="button" className="btn sec" onClick={props.onExport}><Upload size={14} /> Export Config</UiButton>
        <UiButton type="button" className="btn sec" onClick={props.onImport}><Download size={14} /> Import Config</UiButton>
        <UiButton type="button" className="btn sec" title="Copy config, version, and recent logs for bug reports" onClick={props.onCopyDiagnostics}><ClipboardCopy size={14} /> Copy Diagnostic Info</UiButton>
        {savedSection === 'providers' && <span className="saved">Saved — proxy restarting…</span>}
      </div>
    </>
  );
}

function DualApiSection(props: ConfigTabProps): ReactNode {
  const { draft, patch, save, savedSection, credentialStatus } = props;
  const anthropic = draft.providers.anthropic;
  const openai = draft.providers.openai;
  const anthropicModel = anthropic?.modelMap['gpt-5.6-sol'] ?? anthropic?.modelMap['gpt-5.5'] ?? CATALOG_DEFAULTS.anthropic;
  const openaiModel = openai?.modelMap['gpt-5.6-sol'] ?? openai?.modelMap['gpt-5.5'] ?? CATALOG_DEFAULTS.openai;

  function setDualProvider(name: 'anthropic' | 'openai', update: { presetKey?: string; model?: string; enable?: boolean }): void {
    const current = draft.providers[name];
    const presetKey = update.presetKey ?? (current ? presetKeyForUrl('claude', current.baseUrl) : name);
    const preset = PRESETS[presetKey] ?? PRESETS[name]!;
    const model = update.model ?? (name === 'anthropic' ? anthropicModel : openaiModel);
    const entry: ProxyProviderEntry = {
      baseUrl: preset.baseUrl,
      credentialId: current?.credentialId ?? `provider.${name}`,
      format: name,
      defaultModel: '',
      modelMap: dualProviderMap(name, model),
    };
    patch({ providers: update.enable === false ? omitRecord(draft.providers, name) : { ...draft.providers, [name]: entry } });
  }

  const pinOptions = ['anthropic', 'openai'].filter((name) => draft.providers[name]);
  const preview = dualRoutePreview(draft);
  return (
    <div className="section">
      <div className="section-title-row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <h2>Dual API — OpenAI + Claude</h2>
        <Pill tone="info">{dualApiBadge(draft)}</Pill>
      </div>
      <p className="hint lead">
        Give every agent both APIs. The proxy picks the upstream from the model name on each request and translates the formats,
        so one agent can mix Claude and GPT turns. Leave the keys blank to keep the single-provider setup below.
      </p>
      <Toggle id="uap-dual" label={<strong>Enable Dual API routing</strong>} checked={draft.dualApiEnabled} onChange={(dualApiEnabled) => patch({ dualApiEnabled })} />
      <p className="hint" style={{ margin: '2px 0 12px' }}>
        Master switch for everything below (model-name routing and per-agent pins). While off, each agent&apos;s own Backend Override
        (Qwen/Kimi/Codex section) always decides its upstream — pinning one agent here can never silently redirect a sibling agent
        that configured its own backend separately.
      </p>
      <SaveRow label="Save dual API settings" saved={savedSection === 'dual'} busy={props.busy} onSave={() => save('dual')} />
      <div style={{ marginTop: 12 }}>
        <Toggle id="uap-model-routing" label="Route by model name (claude-* → Anthropic, gpt-* → OpenAI)" checked={draft.modelRouting} onChange={(modelRouting) => patch({ modelRouting })} />
      </div>

      {(['anthropic', 'openai'] as const).map((name) => {
        const entry = draft.providers[name];
        const model = name === 'anthropic' ? anthropicModel : openaiModel;
        const credentialId = entry?.credentialId ?? `provider.${name}`;
        return (
          <div className="row" style={{ marginTop: name === 'anthropic' ? 12 : 0 }} key={name}>
            <div className="u-field">
              <label htmlFor={`uap-${name}-preset`}>{name === 'anthropic' ? 'Anthropic preset' : 'OpenAI preset'}</label>
              <Select id={`uap-${name}-preset`} value={entry ? presetKeyForUrl('claude', entry.baseUrl) : name} onChange={(event) => setDualProvider(name, { presetKey: event.target.value })}>
                <option value={name}>{name === 'anthropic' ? 'Anthropic API' : 'OpenAI API'}</option>
              </Select>
            </div>
            <div className="u-field">
              <KeyField
                label={name === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'}
                credentialId={credentialId}
                placeholder={name === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                credentialStatus={credentialStatus}
                busy={props.busy}
                onSave={(value) => {
                  void props.onSaveCredential(credentialId, value);
                  if (!entry) setDualProvider(name, {});
                }}
                onClear={entry ? () => setDualProvider(name, { enable: false }) : undefined}
                clearLabel="Remove provider"
              />
            </div>
            <div className="u-field w240">
              <label htmlFor={`uap-${name}-model`}>{name === 'anthropic' ? 'Claude model' : 'OpenAI model'}</label>
              <Select id={`uap-${name}-model`} value={model} onChange={(event) => setDualProvider(name, { model: event.target.value })}>
                {catalogFor(name).map((candidate) => <option key={candidate.id} value={candidate.id}>{modelLabel(candidate.id)}</option>)}
              </Select>
              <span className="hint">{describeCatalogModel(model)}</span>
            </div>
          </div>
        );
      })}

      <h3>Per-agent override</h3>
      <p className="hint lead">
        Leave on <strong>Auto</strong> to let the model name decide. Pinning forces an agent onto one API whatever model it asks for.
        Pins need the agent routed through its tagged base URL, which the Route buttons write for you.
      </p>
      <div className="row">
        {AGENTS.map((agent) => (
          <div className="u-field" key={agent}>
            <label htmlFor={`uap-pin-${agent}`}>{AGENT_LABELS[agent]}</label>
            <Select
              id={`uap-pin-${agent}`}
              value={draft.agentRoutes[agent] ?? ''}
              onChange={(event) => patch({ agentRoutes: event.target.value ? { ...draft.agentRoutes, [agent]: event.target.value } : omitRecord(draft.agentRoutes, agent) })}
            >
              <option value="">Auto</option>
              {[...new Set([...pinOptions, ...Object.keys(draft.providers), ...(draft.agentRoutes[agent] ? [draft.agentRoutes[agent]!] : [])])].map((name) => (
                <option key={name} value={name}>{name === 'anthropic' ? 'Anthropic' : name === 'openai' ? 'OpenAI' : name}</option>
              ))}
            </Select>
          </div>
        ))}
      </div>

      <h3>Effective routing</h3>
      <table className="data-table">
        <thead><tr><th>Agent</th><th>Asks for</th><th>Goes to</th><th>Model sent</th></tr></thead>
        <tbody>
          {preview.map((row) => (
            <tr key={row.agent}><td>{AGENT_LABELS[row.agent]}</td><td><code>{row.asks}</code></td><td>{row.destination}</td><td><code>{row.sent}</code></td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 8 }}>{dualRouteNote(draft, draft.port)}</p>
    </div>
  );
}

function CredentialCentre({ draft, busy, credentialStatus, onSaveCredential, onClearCredential }: ConfigTabProps): ReactNode {
  const [id, setId] = useState('');
  const [value, setValue] = useState('');
  const inUse = credentialUses(draft);
  return (
    <div style={{ fontSize: 13 }}>
      {credentialStatus.ids.map((credentialId) => (
        <div className="credential-row" key={credentialId}>
          <span className="ok-text"><Check size={13} /></span>
          <span className="mono">{credentialId}</span>
          {inUse[credentialId] && <em>{inUse[credentialId]}</em>}
          <UiButton type="button" className="btn danger small" disabled={busy} aria-label={`Remove credential ${credentialId}`} onClick={() => void clearStored(credentialId, onClearCredential)}>Remove</UiButton>
        </div>
      ))}
      {Object.keys(inUse).filter((credentialId) => !credentialStatus.ids.includes(credentialId)).map((credentialId) => (
        <div className="credential-row" key={credentialId}>
          <span className="err-text"><X size={13} /></span>
          <span className="mono">{credentialId}</span>
          <em>{inUse[credentialId]} · not stored</em>
        </div>
      ))}
      {credentialStatus.ids.length === 0 && Object.keys(inUse).length === 0 && <p className="empty">No credentials stored.</p>}
      <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="u-field"><TextField label="Credential ID" value={id} placeholder="provider.example" onChange={setId} /></div>
        <div className="u-field"><TextField label="Secret value" type="password" value={value} onChange={setValue} /></div>
        <div className="u-field" style={{ flex: '0 0 auto' }}>
          <UiButton
            type="button"
            className="btn sec"
            disabled={busy || !credentialStatus.available || !id.trim() || !value.trim()}
            onClick={() => { void onSaveCredential(id.trim(), value); setValue(''); }}
          >Store secret</UiButton>
        </div>
      </div>
      <p className="hint">{credentialStatus.available ? 'OS vault available.' : 'OS vault is unavailable — keys cannot be stored.'}</p>
    </div>
  );
}

function credentialUses(draft: ProxySettings): Record<string, string> {
  const uses: Record<string, string> = {};
  const add = (id: string | undefined, label: string): void => {
    if (!id) return;
    uses[id] = uses[id] ? `${uses[id]}, ${label}` : label;
  };
  add(draft.credentialId, 'Main provider');
  for (const agent of ['kimi', 'qwen', 'codex'] as const) {
    const backend = draft[backendKey(agent)];
    if (backend.enabled) add(backend.credentialId || `agent.${agent}`, AGENT_LABELS[agent]);
  }
  for (const [name, provider] of Object.entries(draft.providers)) add(provider.credentialId, `Provider ${name}`);
  draft.fallbackProviders.forEach((provider, index) => add(provider.credentialId, `Fallback ${index + 1}`));
  return uses;
}

async function clearStored(credentialId: string, onClear: (id: string) => Promise<boolean | void> | void): Promise<void> {
  if (!(await confirmDialog({ title: 'Remove stored credential?', detail: `Remove the stored credential for ${credentialId}?`, confirmLabel: 'Remove credential', destructive: true }))) return;
  await onClear(credentialId);
}

// ---- Advanced tab -----------------------------------------------------------

export function AdvancedTab(props: ConfigTabProps & {
  ready: boolean;
  tokenStored: boolean;
  dryRunBody: string;
  dryRunResult: unknown;
  onDryRunBody: (value: string) => void;
  onDryRun: () => void;
  onCopyToken: () => void;
  onRotateToken: () => void;
}): ReactNode {
  const { draft, patch, save, savedSection } = props;
  return (
    <>
      <details className="section" open>
        <summary><h2>Advanced</h2></summary>
        <div className="details-body">
          <div className="row">
            <div className="u-field"><NumberField label="Upstream timeout (ms)" value={draft.upstreamTimeoutMs} min={10_000} max={3_600_000} onChange={(upstreamTimeoutMs) => patch({ upstreamTimeoutMs })} /></div>
            <div className="u-field"><NumberField label="Max requests/sec (0=unlimited)" value={draft.rateLimit.maxRequestsPerSecond} min={0} max={10_000} onChange={(maxRequestsPerSecond) => patch({ rateLimit: { maxRequestsPerSecond } })} /></div>
            <div className="u-field"><NumberField label="Max concurrent (0=unlimited)" value={draft.maxConcurrentRequests} min={0} max={10_000} onChange={(maxConcurrentRequests) => patch({ maxConcurrentRequests })} /></div>
          </div>
          <Toggle id="uap-logging" label="Persistent request logging to file" checked={draft.logging.enabled} onChange={(enabled) => patch({ logging: { ...draft.logging, enabled } })} />
          <Toggle id="uap-tls" label="HTTPS (TLS) — requires cert/key paths below" checked={draft.tls.enabled} onChange={(enabled) => patch({ tls: { ...draft.tls, enabled } })} />
          <div className="row">
            <div className="u-field"><TextField label="TLS cert path (PEM)" value={draft.tls.certPath} placeholder="C:\Users\...\cert.pem" onChange={(certPath) => patch({ tls: { ...draft.tls, certPath } })} /></div>
            <div className="u-field"><TextField label="TLS key path (PEM)" value={draft.tls.keyPath} placeholder="C:\Users\...\key.pem" onChange={(keyPath) => patch({ tls: { ...draft.tls, keyPath } })} /></div>
          </div>
          <p className="hint">Generate certs: <code>openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj &quot;/CN=localhost&quot;</code></p>

          <h3>Reliability</h3>
          <div className="row">
            <div className="u-field"><NumberField label="Stall timeout (ms, 0 = off)" value={draft.stallTimeoutMs} min={0} max={3_600_000} onChange={(stallTimeoutMs) => patch({ stallTimeoutMs })} /></div>
            <div className="u-field"><NumberField label="Max retries" value={draft.retryConfig.maxRetries} min={0} max={10} onChange={(maxRetries) => patch({ retryConfig: { ...draft.retryConfig, maxRetries } })} /></div>
            <div className="u-field"><NumberField label="Retry base delay (ms)" value={draft.retryConfig.baseDelayMs} min={100} max={30_000} onChange={(baseDelayMs) => patch({ retryConfig: { ...draft.retryConfig, baseDelayMs } })} /></div>
            <div className="u-field"><NumberField label="Retry max delay (ms)" value={draft.retryConfig.maxDelayMs} min={1_000} max={120_000} onChange={(maxDelayMs) => patch({ retryConfig: { ...draft.retryConfig, maxDelayMs } })} /></div>
          </div>
          <div className="row">
            <div className="u-field"><NumberField label="Error notify threshold" value={draft.errorNotifyThreshold.count} min={1} max={100} onChange={(count) => patch({ errorNotifyThreshold: { ...draft.errorNotifyThreshold, count } })} /></div>
            <div className="u-field"><NumberField label="Error window (minutes)" value={draft.errorNotifyThreshold.windowMinutes} min={1} max={1_440} onChange={(windowMinutes) => patch({ errorNotifyThreshold: { ...draft.errorNotifyThreshold, windowMinutes } })} /></div>
            <div className="u-field"><TextField label="Log directory" value={draft.logging.directory} onChange={(directory) => patch({ logging: { ...draft.logging, directory } })} /></div>
            <div className="u-field"><NumberField label="Log file size (MB)" value={draft.logging.maxFileSizeMB} min={1} max={1_000} onChange={(maxFileSizeMB) => patch({ logging: { ...draft.logging, maxFileSizeMB } })} /></div>
          </div>

          <h3>Budgets and history</h3>
          <div className="row">
            <div className="u-field"><NumberField label="Daily budget (0 = off)" value={draft.costBudget.daily} min={0} max={1_000_000} onChange={(daily) => patch({ costBudget: { ...draft.costBudget, daily } })} /></div>
            <div className="u-field"><NumberField label="Weekly budget (0 = off)" value={draft.costBudget.weekly} min={0} max={1_000_000} onChange={(weekly) => patch({ costBudget: { ...draft.costBudget, weekly } })} /></div>
            <div className="u-field"><NumberField label="Monthly budget (0 = off)" value={draft.costBudget.monthly} min={0} max={1_000_000} onChange={(monthly) => patch({ costBudget: { ...draft.costBudget, monthly } })} /></div>
            <div className="u-field w90"><TextField label="Currency" value={draft.costBudget.currency} onChange={(currency) => patch({ costBudget: { ...draft.costBudget, currency } })} /></div>
            <div className="u-field w90">
              <label htmlFor="uap-budget-mode">Mode</label>
              <Select id="uap-budget-mode" value={draft.costBudget.mode} onChange={(event) => patch({ costBudget: { ...draft.costBudget, mode: event.target.value as 'warn' | 'block' } })}>
                <option value="warn">warn</option><option value="block">block</option>
              </Select>
            </div>
          </div>
          <div className="row">
            <div className="u-field"><NumberField label="History entries" value={draft.historyConfig.maxEntries} min={100} max={2_000} onChange={(maxEntries) => patch({ historyConfig: { ...draft.historyConfig, maxEntries } })} /></div>
            <div className="u-field"><NumberField label="Prompt snippet characters" value={draft.historyConfig.promptSnippetChars} min={100} max={2_000} onChange={(promptSnippetChars) => patch({ historyConfig: { ...draft.historyConfig, promptSnippetChars } })} /></div>
            <div className="u-field"><NumberField label="Replay entries" value={draft.historyConfig.maxReplayEntries} min={0} max={200} onChange={(maxReplayEntries) => patch({ historyConfig: { ...draft.historyConfig, maxReplayEntries } })} /></div>
          </div>
          <Toggle id="uap-snippets" label="Store redacted prompt snippets in history" checked={draft.historyConfig.includePromptSnippet} onChange={(includePromptSnippet) => patch({ historyConfig: { ...draft.historyConfig, includePromptSnippet } })} />
          <SaveRow label="Save advanced settings" saved={savedSection === 'advanced'} busy={props.busy} onSave={() => save('advanced')} />
        </div>
      </details>

      <details className="section">
        <summary><h2>Provider registry and model routes</h2></summary>
        <div className="details-body">
          <p className="hint lead">Named upstreams every agent can reach, and custom model→provider rules evaluated before the built-in ones. The extension keeps these in settings.json (<code>claudeProxy.providers</code>, <code>claudeProxy.modelRoutes</code>).</p>
          {Object.entries(draft.providers).map(([name, provider]) => (
            <div className="provider-block" key={name}>
              <div className="list-row">
                <TextField label="Name" value={name} onChange={(nextName) => patch({ providers: renameProvider(draft.providers, name, nextName, provider) })} />
                <TextField label="Base URL" value={provider.baseUrl} onChange={(baseUrl) => patch({ providers: { ...draft.providers, [name]: { ...provider, baseUrl } } })} />
                <TextField label="Vault credential ID" value={provider.credentialId ?? ''} onChange={(credentialId) => patch({ providers: { ...draft.providers, [name]: withOptional(provider, 'credentialId', credentialId) } })} />
                <div className="u-field" style={{ flex: '0 0 110px' }}>
                  <label>Format</label>
                  <Select value={provider.format} onChange={(event) => patch({ providers: { ...draft.providers, [name]: { ...provider, format: event.target.value as ProxyProviderEntry['format'] } } })}>
                    <option value="auto">auto</option><option value="anthropic">anthropic</option><option value="openai">openai</option>
                  </Select>
                </div>
                <UiButton type="button" className="btn danger small" aria-label={`Remove provider ${name}`} onClick={() => patch({ providers: omitRecord(draft.providers, name) })}><X size={13} /></UiButton>
              </div>
              <KeyValueTable keyLabel="Model" valueLabel="Sent as" addLabel="+ Add mapping" value={provider.modelMap} onChange={(modelMap) => patch({ providers: { ...draft.providers, [name]: { ...provider, modelMap } } })} />
            </div>
          ))}
          <UiButton type="button" className="btn sec" onClick={() => patch({ providers: { ...draft.providers, [`provider-${Object.keys(draft.providers).length + 1}`]: { baseUrl: 'https://api.example.com/v1', format: 'auto', defaultModel: '', modelMap: {} } } })}>+ Add provider</UiButton>

          <h3>Model routes</h3>
          {draft.modelRoutes.map((route, index) => (
            <div className="list-row" key={index}>
              <TextField label="Model glob" value={route.match} onChange={(match) => patch({ modelRoutes: replaceAt(draft.modelRoutes, index, { ...route, match }) })} />
              <TextField label="Provider name" value={route.provider} onChange={(provider) => patch({ modelRoutes: replaceAt(draft.modelRoutes, index, { ...route, provider }) })} />
              <UiButton type="button" className="btn danger small" aria-label={`Remove model route ${index + 1}`} onClick={() => patch({ modelRoutes: draft.modelRoutes.filter((_, i) => i !== index) })}><X size={13} /></UiButton>
            </div>
          ))}
          <UiButton type="button" className="btn sec" onClick={() => patch({ modelRoutes: [...draft.modelRoutes, { match: 'claude-*', provider: 'anthropic' }] })}>+ Add route</UiButton>
          <SaveRow label="Save registry" saved={savedSection === 'registry'} busy={props.busy} onSave={() => save('registry')} />
        </div>
      </details>

      <details className="section">
        <summary><h2>Dry Run / Preview</h2></summary>
        <div className="details-body">
          <p className="hint lead">Paste a request body to see how the proxy would translate it before sending.</p>
          <div className="u-field">
            <label htmlFor="uap-dry-run">Request body (JSON)</label>
            <Textarea id="uap-dry-run" rows={6} spellCheck={false} value={props.dryRunBody} onChange={(event) => props.onDryRunBody(event.target.value)} />
          </div>
          <UiButton type="button" className="btn sec" disabled={!props.ready || props.busy} onClick={props.onDryRun}>Preview Translation</UiButton>
          {props.dryRunResult !== null && <pre className="logbox">{JSON.stringify(props.dryRunResult, null, 2)}</pre>}
        </div>
      </details>

      <div className="section">
        <h2>Loopback access</h2>
        <p className="hint lead">KAI serves the proxy behind an authenticated loopback gateway. Agents routed by KAI receive this token automatically.</p>
        <div className="button-row">
          <UiButton type="button" className="btn sec" disabled={props.busy || !props.tokenStored} onClick={props.onCopyToken}>Copy access token</UiButton>
          <UiButton type="button" className="btn sec" disabled={props.busy} onClick={props.onRotateToken}>Rotate access token</UiButton>
        </div>
      </div>
    </>
  );
}

// ---- Shared fields ----------------------------------------------------------

export function ModelSelect({ label, providerKey, value, onChange, id }: {
  label: string;
  providerKey: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
}): ReactNode {
  const suggestions = modelSuggestions(providerKey);
  const values = value && !suggestions.includes(value) ? [value, ...suggestions] : suggestions;
  const generatedId = useId();
  const selectId = id ?? generatedId;
  return (
    <>
      <label htmlFor={selectId}>{label}</label>
      <Select
        id={selectId}
        value={value}
        onChange={(event) => {
          if (event.target.value !== '__custom__') {
            onChange(event.target.value);
            return;
          }
          void promptDialog({ title: 'Custom model', label: 'Enter the model ID/slug', initialValue: value })
            .then((entered) => { if (entered?.trim()) onChange(entered.trim()); });
        }}
      >
        {!value && <option value="">Provider default</option>}
        {values.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
        <option value="__custom__">Custom model…</option>
      </Select>
    </>
  );
}

function PresetField({ agent, value, onChange }: { agent: ProxyAgentId; value: string; onChange: (key: string) => void }): ReactNode {
  return (
    <div className="u-field">
      <label htmlFor={`uap-${agent}-preset`}>Preset</label>
      <Select id={`uap-${agent}-preset`} value={value} onChange={(event) => { if (event.target.value) onChange(event.target.value); }}>
        <option value="">— choose a preset —</option>
        {Object.keys(presetsFor(agent)).map((key) => <option key={key} value={key}>{PROVIDER_LABELS[key] ?? key}</option>)}
      </Select>
    </div>
  );
}

/** Password box that stores its value in the OS vault under `credentialId`. */
export function KeyField({ label, credentialId, placeholder, credentialStatus, busy, onSave, onClear, clearLabel = 'Clear stored key', id }: {
  label: string;
  credentialId: string;
  placeholder: string;
  credentialStatus: CredentialStatus;
  busy: boolean;
  onSave: (value: string) => void;
  onClear?: () => void;
  clearLabel?: string;
  id?: string;
}): ReactNode {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const stored = Boolean(credentialId && credentialStatus.ids.includes(credentialId));
  const generatedId = useId();
  const inputId = id ?? generatedId;
  useEffect(() => setSaved(false), [credentialId]);
  return (
    <>
      <label htmlFor={inputId}>{label}</label>
      <div className="agent-key-row">
        <UiTextInput
          id={inputId}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={stored ? `•••••••• stored in vault (${credentialId})` : placeholder}
          onChange={(event) => { setValue(event.target.value); setSaved(false); }}
        />
        <UiButton
          type="button"
          className="btn"
          disabled={busy || !credentialStatus.available || !value.trim()}
          onClick={() => { onSave(value.trim()); setValue(''); setSaved(true); }}
        >Save</UiButton>
        {onClear && (stored || clearLabel === 'Remove provider') && <UiButton type="button" className="btn sec" title={clearLabel} aria-label={clearLabel} disabled={busy} onClick={onClear}><X size={13} /></UiButton>}
        {saved && <span className="saved">Saved</span>}
      </div>
    </>
  );
}

function SaveRow({ label, saved, busy, onSave }: { label: string; saved: boolean; busy: boolean; onSave: () => void }): ReactNode {
  return (
    <div className="save-row" style={{ marginBottom: 12 }}>
      <UiButton type="button" className="btn" disabled={busy} onClick={onSave}>{label}</UiButton>
      {saved && <span className="saved">Saved — proxy restarting…</span>}
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: ReactNode; checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  return (
    <div className="u-field u-toggle">
      <Checkbox id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function TextField({ label, value, onChange, type = 'text', placeholder, title }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  title?: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="u-field">
      <label htmlFor={id} title={title}>{label}</label>
      <UiTextInput id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }): ReactNode {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <UiTextInput id={id} type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} />
    </>
  );
}

function KeyValueTable({ keyLabel, valueLabel, addLabel, value, onChange }: {
  keyLabel: string;
  valueLabel: string;
  addLabel: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}): ReactNode {
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value));
  useEffect(() => {
    // Only reset from props when they differ from the rows being edited, so a half-typed
    // row with an empty name survives the round trip through the settings draft.
    const current = Object.fromEntries(rows.filter(([name]) => name.trim()));
    if (JSON.stringify(current) !== JSON.stringify(value)) setRows(Object.entries(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = (next: Array<[string, string]>): void => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([name]) => name.trim()).map(([name, text]) => [name.trim(), text])));
  };
  return (
    <>
      <table>
        <thead><tr><th>{keyLabel}</th><th>{valueLabel}</th><th style={{ width: 40 }} /></tr></thead>
        <tbody>
          {rows.map(([name, text], index) => (
            <tr key={index}>
              <td><UiTextInput type="text" value={name} aria-label={`${keyLabel} ${index + 1}`} onChange={(event) => commit(replaceAt(rows, index, [event.target.value, text]))} /></td>
              <td><UiTextInput type="text" value={text} aria-label={`${valueLabel} ${index + 1}`} onChange={(event) => commit(replaceAt(rows, index, [name, event.target.value]))} /></td>
              <td><UiButton type="button" className="btn danger small" aria-label={`Remove row ${index + 1}`} onClick={() => commit(rows.filter((_, i) => i !== index))}><X size={13} /></UiButton></td>
            </tr>
          ))}
        </tbody>
      </table>
      <UiButton type="button" className="btn sec" style={{ marginTop: 8 }} onClick={() => setRows([...rows, ['', '']])}>{addLabel}</UiButton>
    </>
  );
}

function renameProvider(providers: ProxySettings['providers'], oldName: string, nextName: string, provider: ProxyProviderEntry): ProxySettings['providers'] {
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
