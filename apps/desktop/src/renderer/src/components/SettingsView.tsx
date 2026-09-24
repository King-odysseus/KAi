import { Archive, ArchiveRestore, Check, Cloud, Cpu, Database, FolderInput, Gauge, KeyRound, Plug, Plus, RefreshCw, ServerCog, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { UpdatesPanel } from './UpdatesPanel';
import { CLI_MODEL_SUGGESTIONS, DIRECT_PROVIDER_ORDER, THEME_MODES, directProviderPreset } from '@kai/contracts';
import type { AppSettings, ConfigBackup, CredentialStatus, DataLocation, LogEntry, SettingsUpdate } from '@kai/contracts';
import { confirmDialog } from './AppDialog';

type McpServer = AppSettings['mcpServers'][number];
type HttpMcpServer = Extract<McpServer, { transport: 'http' }>;
type StdioMcpServer = Extract<McpServer, { transport: 'stdio' }>;
type McpServerPatch = Partial<HttpMcpServer> | Partial<StdioMcpServer>;

export function SettingsView({ settings, credentialStatus, dataLocations, logs, busy, onSave, onImportBrain, onSaveCredential, onClearCredential, onListBackups, onCreateBackup, onRestoreBackup, onDeleteBackup }: { settings: AppSettings; credentialStatus: CredentialStatus; dataLocations: DataLocation[]; logs: LogEntry[]; busy: boolean; onSave: (update: SettingsUpdate) => void; onImportBrain: () => void; onSaveCredential: (id: string, value: string) => void; onClearCredential: (id: string) => void; onListBackups: () => Promise<ConfigBackup[]>; onCreateBackup: (name?: string) => Promise<ConfigBackup>; onRestoreBackup: (id: string) => Promise<void>; onDeleteBackup: (id: string) => Promise<void> }): ReactNode {
  const [draft, setDraft] = useState(settings);
  const [credentialId, setCredentialId] = useState('provider.openai');
  const [credentialValue, setCredentialValue] = useState('');
  const [directCredentialValue, setDirectCredentialValue] = useState('');
  const [overwatchCredentialValue, setOverwatchCredentialValue] = useState('');
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [backupName, setBackupName] = useState('');
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    void refreshBackups();
  }, []);
  const directPreset = directProviderPreset(draft.directApi.provider);
  const overwatchCredentialReady = credentialStatus.ids.includes(draft.cognitive1.overwatch.credentialId);
  const setAgentModel = (agent: 'claude' | 'codex' | 'qwen' | 'gemini', value: string): void => {
    setDraft((current) => {
      const next = { ...current.agentModels };
      if (value.trim()) next[agent] = value.trim();
      else delete next[agent];
      return { ...current, agentModels: next };
    });
  };
  const updateMcpServer = (index: number, patch: McpServerPatch): void => {
    setDraft((current) => updateDraftMcpServer(current, index, patch));
  };
  const updateMcpServerTransport = (index: number, transport: McpServer['transport']): void => {
    setDraft((current) => updateDraftMcpServerTransport(current, index, transport));
  };
  const updateDirectProvider = (provider: AppSettings['directApi']['provider']): void => {
    const preset = directProviderPreset(provider);
    setCredentialId(preset.credentialId);
    setDraft((current) => ({
      ...current,
      directApi: {
        ...current.directApi,
        provider,
        baseUrl: preset.defaultBaseUrl,
        model: preset.defaultModel,
        credentialId: preset.credentialId,
      },
    }));
  };
  const updateOverwatchProvider = (provider: AppSettings['cognitive1']['overwatch']['provider']): void => {
    const preset = overwatchProviderPreset(provider);
    setDraft((current) => ({
      ...current,
      cognitive1: {
        ...current.cognitive1,
        overwatch: {
          ...current.cognitive1.overwatch,
          provider,
          baseUrl: preset.baseUrl,
          model: preset.model,
        },
      },
    }));
  };

  async function refreshBackups(): Promise<void> {
    setBackupsLoading(true);
    try {
      setBackups(await onListBackups());
      setBackupError(null);
    } catch (caught) {
      setBackupError(messageOf(caught));
    } finally {
      setBackupsLoading(false);
    }
  }

  async function createBackup(): Promise<void> {
    try {
      const backup = await onCreateBackup(backupName.trim() || undefined);
      setBackupName('');
      setBackups((current) => [backup, ...current.filter((item) => item.id !== backup.id)]);
      setBackupError(null);
    } catch (caught) {
      setBackupError(messageOf(caught));
    }
  }

  async function restoreBackup(backup: ConfigBackup): Promise<void> {
    if (!(await confirmDialog({ title: 'Restore configuration backup?', detail: `Restore "${backup.name}"? Current settings will be replaced.`, confirmLabel: 'Restore backup', destructive: true }))) return;
    try {
      await onRestoreBackup(backup.id);
      setBackupError(null);
    } catch (caught) {
      setBackupError(messageOf(caught));
    }
  }

  async function deleteBackup(backup: ConfigBackup): Promise<void> {
    if (!(await confirmDialog({ title: 'Delete configuration backup?', detail: `Delete "${backup.name}"?`, confirmLabel: 'Delete backup', destructive: true }))) return;
    try {
      await onDeleteBackup(backup.id);
      setBackups((current) => current.filter((item) => item.id !== backup.id));
      setBackupError(null);
    } catch (caught) {
      setBackupError(messageOf(caught));
    }
  }

  return (
    <div className="page-view settings-view">
      <PageHeader title="Settings" detail="App-owned configuration and local diagnostics" />
      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title"><Cpu size={17} /><span>Agent defaults</span></div>
          <div className="field-grid">
            <SelectField label="Agent" value={draft.defaultAgent} onChange={(value) => setDraft({ ...draft, defaultAgent: value as AppSettings['defaultAgent'] })} options={['codex', 'claude', 'qwen', 'gemini']} />
            <SelectField label="Route" value={draft.defaultRoute} onChange={(value) => setDraft({ ...draft, defaultRoute: value as AppSettings['defaultRoute'] })} options={['direct', 'proxy']} />
            <SelectField label="Autonomy" value={draft.defaultAutonomy} onChange={(value) => setDraft({ ...draft, defaultAutonomy: value as AppSettings['defaultAutonomy'] })} options={['plan', 'ask', 'autoEdit', 'full', 'custom']} />
            <SelectField label="Theme" value={draft.theme} onChange={(value) => setDraft({ ...draft, theme: value as AppSettings['theme'] })} options={THEME_MODES.map((item) => ({ value: item.id, label: item.label }))} />
            <NumberField label="Log entries" value={draft.logRetentionEntries} min={100} max={100000} onChange={(value) => setDraft({ ...draft, logRetentionEntries: value })} />
          </div>
          <label className="toggle-row"><span><strong>Diagnostics</strong><small>Store redacted local diagnostics</small></span><input type="checkbox" checked={draft.diagnosticsEnabled} onChange={(event) => setDraft({ ...draft, diagnosticsEnabled: event.target.checked })} /></label>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>CLI models</span></div>
            <p className="settings-note">The model each CLI agent is asked to use. Leave a field empty to keep that CLI's own default (for example the model in ~/.codex/config.toml).</p>
            <div className="field-grid">
              {(['claude', 'codex', 'qwen', 'gemini'] as const).map((agent) => (
                <label key={agent} className="field"><span>{agent} model</span><input value={draft.agentModels[agent] ?? ''} placeholder="CLI default" list={`cli-models-${agent}`} onChange={(event) => setAgentModel(agent, event.target.value)} /><datalist id={`cli-models-${agent}`}>{CLI_MODEL_SUGGESTIONS[agent].map((name) => <option key={name} value={name} />)}</datalist></label>
              ))}
            </div>
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>Tray and notifications</span></div>
            <NotificationToggle label="Hide to system tray on close" hint="Keeps KAI and running agents alive in the tray. Off by default." checked={draft.notifications.trayEnabled} onChange={(trayEnabled) => setDraft({ ...draft, notifications: { ...draft.notifications, trayEnabled } })} />
            <NotificationToggle label="Notify when a run finishes" hint="Skipped when that conversation is already on screen" checked={draft.notifications.onComplete} onChange={(onComplete) => setDraft({ ...draft, notifications: { ...draft.notifications, onComplete } })} />
            <NotificationToggle label="Notify when a run fails" hint="Includes the first line of the error" checked={draft.notifications.onFailure} onChange={(onFailure) => setDraft({ ...draft, notifications: { ...draft.notifications, onFailure } })} />
            <NotificationToggle label="Notify when approval is needed" hint="A tool is waiting for your decision" checked={draft.notifications.onApproval} onChange={(onApproval) => setDraft({ ...draft, notifications: { ...draft.notifications, onApproval } })} />
            <NotificationToggle label="Notify on budget warnings" hint="When a usage limit reaches 80% or 100%" checked={draft.notifications.onBudget} onChange={(onBudget) => setDraft({ ...draft, notifications: { ...draft.notifications, onBudget } })} />
          </div>
          <button type="button" className="primary-button align-end" disabled={busy} onClick={() => onSave({
            defaultAgent: draft.defaultAgent,
            defaultRoute: draft.defaultRoute,
            defaultAutonomy: draft.defaultAutonomy,
            theme: draft.theme,
            logRetentionEntries: draft.logRetentionEntries,
            diagnosticsEnabled: draft.diagnosticsEnabled,
            notifications: draft.notifications,
            agentModels: draft.agentModels,
            directApi: draft.directApi,
            mcpServers: draft.mcpServers,
            cognitive1: draft.cognitive1,
            proxy: draft.proxy,
          })}><Check size={16} /><span>Save settings</span></button>
        </section>

        <UpdatesPanel settings={settings} />

        <section className="settings-section">
          <div className="section-title"><Cloud size={17} /><span>Direct API</span></div>
          <label className="toggle-row"><span><strong>Enable direct API mode</strong><small>Uses a provider key from the OS vault</small></span><input type="checkbox" checked={draft.directApi.enabled} onChange={(event) => setDraft({ ...draft, directApi: { ...draft.directApi, enabled: event.target.checked } })} /></label>
          <div className="field-grid">
            <SelectField label="Provider" value={draft.directApi.provider} onChange={(value) => updateDirectProvider(value as AppSettings['directApi']['provider'])} options={DIRECT_PROVIDER_ORDER.map((id) => ({ value: id, label: directProviderPreset(id).displayName }))} />
            <TextField label="Model" value={draft.directApi.model} list="direct-api-models" onChange={(value) => setDraft({ ...draft, directApi: { ...draft.directApi, model: value } })} />
            <TextField label="Base URL" value={draft.directApi.baseUrl} onChange={(value) => setDraft({ ...draft, directApi: { ...draft.directApi, baseUrl: value } })} />
            <TextField label="Credential ID" value={draft.directApi.credentialId} onChange={(value) => setDraft({ ...draft, directApi: { ...draft.directApi, credentialId: value } })} />
          </div>
          <datalist id="direct-api-models">{directPreset.models.map((model) => <option key={model} value={model} />)}</datalist>
          <div className="credential-form">
            <TextField label="API key" value={directCredentialValue} type="password" onChange={setDirectCredentialValue} />
            <div className="button-row align-start">
              <button
                type="button"
                className="secondary-button"
                disabled={!directCredentialValue.trim() || !credentialStatus.available || busy}
                onClick={() => {
                  onSave({ directApi: draft.directApi });
                  onSaveCredential(draft.directApi.credentialId, directCredentialValue);
                  setDirectCredentialValue('');
                }}
              >
                <KeyRound size={15} />
                <span>Save key and use provider</span>
              </button>
              <span className="settings-note">{credentialStatus.ids.includes(draft.directApi.credentialId) ? 'Credential stored in the OS vault.' : 'No credential stored for this ID.'}</span>
            </div>
          </div>
          <p className="settings-note">{directPreset.protocol === 'responses' ? 'Uses the OpenAI Responses API. ' : 'Uses the OpenAI-compatible Chat Completions API. '}Assistant text streams into the workspace, and built-in project tools plus enabled MCP servers use the same approval rules.</p>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Plug size={17} /><span>MCP servers</span></div>
          <p className="settings-note">Connect local stdio or remote Streamable HTTP MCP servers to API mode. Secrets stay in the OS vault; the settings file stores credential IDs only.</p>
          <div className="mcp-server-list">
            {draft.mcpServers.map((server, index) => (
              <div className="mcp-server-row" key={server.id}>
                <div className="mcp-server-head">
                  <label className="mcp-enable"><input type="checkbox" checked={server.enabled} onChange={(event) => updateMcpServer(index, { enabled: event.target.checked })} /><span>{server.enabled ? 'Enabled' : 'Disabled'}</span></label>
                  <button type="button" className="icon-button compact" aria-label={`Remove ${server.name}`} onClick={() => setDraft({ ...draft, mcpServers: draft.mcpServers.filter((item) => item.id !== server.id) })}><Trash2 size={14} /></button>
                </div>
                <div className="field-grid">
                  <TextField label="Name" value={server.name} onChange={(value) => updateMcpServer(index, { name: value })} />
                  <SelectField label="Transport" value={server.transport} options={['stdio', 'http']} onChange={(value) => updateMcpServerTransport(index, value as McpServer['transport'])} />
                  {server.transport === 'stdio' ? (
                    <>
                      <TextField label="Command" value={server.command} onChange={(value) => updateMcpServer(index, { command: value })} />
                      <TextField label="Working directory" value={server.cwd ?? ''} onChange={(value) => updateMcpServer(index, { cwd: value || null })} />
                      <TextAreaField label="Arguments (one per line)" value={server.args.join('\n')} onChange={(value) => updateMcpServer(index, { args: value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })} />
                      <TextAreaField label="Credential environment (KEY=credential.id)" value={formatCredentialRefs(server.envCredentialIds)} onChange={(value) => updateMcpServer(index, { envCredentialIds: parseCredentialRefs(value) })} />
                    </>
                  ) : (
                    <>
                      <TextField label="Server URL" value={server.url} onChange={(value) => updateMcpServer(index, { url: value })} />
                      <TextAreaField label="Credential headers (Header=credential.id)" value={formatCredentialRefs(server.headerCredentialIds)} onChange={(value) => updateMcpServer(index, { headerCredentialIds: parseCredentialRefs(value) })} />
                    </>
                  )}
                </div>
              </div>
            ))}
            {draft.mcpServers.length === 0 && <div className="empty-list">No MCP servers configured</div>}
          </div>
          <div className="button-row align-start">
            <button type="button" className="secondary-button" onClick={() => setDraft({ ...draft, mcpServers: [...draft.mcpServers, newMcpServer('stdio')] })}><Plus size={15} /><span>Add local server</span></button>
            <button type="button" className="secondary-button" onClick={() => setDraft({ ...draft, mcpServers: [...draft.mcpServers, newMcpServer('http')] })}><Plus size={15} /><span>Add remote server</span></button>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title"><KeyRound size={17} /><span>Credentials</span></div>
          <div className={`vault-state ${credentialStatus.available ? 'ready' : 'unavailable'}`}><ShieldCheck size={18} /><div><strong>{credentialStatus.available ? 'OS vault available' : 'OS vault unavailable'}</strong><small>{credentialStatus.ids.length} stored credentials</small></div></div>
          <div className="credential-form">
            <TextField label="Credential ID" value={credentialId} onChange={setCredentialId} />
            <TextField label="Secret" value={credentialValue} onChange={setCredentialValue} type="password" />
            <div className="button-row">
              <button type="button" className="primary-button" disabled={!credentialValue.trim() || !credentialStatus.available || busy} onClick={() => { onSaveCredential(credentialId, credentialValue); setCredentialValue(''); }}><KeyRound size={15} /><span>Save credential</span></button>
              <button type="button" className="secondary-button" disabled={busy || !credentialStatus.ids.includes(credentialId)} onClick={() => onClearCredential(credentialId)}><Trash2 size={15} /><span>Remove</span></button>
            </div>
          </div>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><ServerCog size={17} /><span>Managed services</span></div>
          <div className="service-settings-grid">
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>C1 Brain</strong><small>Run the pinned Cognitive1 daemon locally</small></span>
                <input type="checkbox" checked={draft.cognitive1.enabled} onChange={(event) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, enabled: event.target.checked } })} />
              </label>
              <div className="field-grid">
                <TextField label="Endpoint" value={draft.cognitive1.endpoint} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, endpoint: value } })} />
                <TextField label="Brain data path" value={draft.cognitive1.dataPath ?? ''} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, dataPath: value || null } })} />
              </div>
              <div className="settings-subsection">
                <div className="settings-subsection-title"><ShieldCheck size={14} /><span>AI Overwatch</span></div>
                <label className="toggle-row">
                  <span><strong>Enable Overwatch</strong><small>Runs brain quality audits, draft classification, duplicate detection, and kernel distillation</small></span>
                  <input
                    type="checkbox"
                    checked={draft.cognitive1.overwatch.enabled}
                    onChange={(event) => setDraft({
                      ...draft,
                      cognitive1: {
                        ...draft.cognitive1,
                        overwatch: { ...draft.cognitive1.overwatch, enabled: event.target.checked },
                      },
                    })}
                  />
                </label>
                <div className="field-grid">
                  <SelectField
                    label="Provider"
                    value={draft.cognitive1.overwatch.provider}
                    options={[
                      { value: 'deepseek', label: 'DeepSeek' },
                      { value: 'claude', label: 'Claude' },
                      { value: 'openai', label: 'OpenAI API' },
                    ]}
                    onChange={(value) => updateOverwatchProvider(value as AppSettings['cognitive1']['overwatch']['provider'])}
                  />
                  <TextField
                    label="Model"
                    value={draft.cognitive1.overwatch.model}
                    onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, overwatch: { ...draft.cognitive1.overwatch, model: value } } })}
                  />
                  <TextField
                    label="Base URL"
                    value={draft.cognitive1.overwatch.baseUrl}
                    onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, overwatch: { ...draft.cognitive1.overwatch, baseUrl: value } } })}
                  />
                  <TextField
                    label="Credential ID"
                    value={draft.cognitive1.overwatch.credentialId}
                    onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, overwatch: { ...draft.cognitive1.overwatch, credentialId: value } } })}
                  />
                  <NumberField
                    label="Auto-reject threshold"
                    value={draft.cognitive1.overwatch.autoRejectThreshold}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, overwatch: { ...draft.cognitive1.overwatch, autoRejectThreshold: value } } })}
                  />
                </div>
                <div className="credential-form">
                  <TextField label="Overwatch API key" value={overwatchCredentialValue} type="password" onChange={setOverwatchCredentialValue} />
                  <div className="button-row align-start">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!overwatchCredentialValue.trim() || !credentialStatus.available || busy}
                      onClick={() => {
                        onSaveCredential(draft.cognitive1.overwatch.credentialId, overwatchCredentialValue);
                        setOverwatchCredentialValue('');
                      }}
                    >
                      <KeyRound size={15} />
                      <span>Save Overwatch key</span>
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !overwatchCredentialReady}
                      onClick={() => onClearCredential(draft.cognitive1.overwatch.credentialId)}
                    >
                      <Trash2 size={15} />
                      <span>Remove key</span>
                    </button>
                  </div>
                </div>
                <p className={`settings-note ${overwatchCredentialReady ? 'ready' : ''}`}>
                  {overwatchCredentialReady
                    ? 'Credential stored in the OS vault. Save settings to restart C1 with this Overwatch configuration.'
                    : 'No credential stored for this ID. Save a key and enable Overwatch to make it ready.'}
                </p>
              </div>
              <div className="button-row align-start">
                <button type="button" className="secondary-button" disabled={busy} onClick={onImportBrain}>
                  <FolderInput size={15} />
                  <span>Import existing brain</span>
                </button>
                <span className="settings-note">Copies missing brain entries from another Cognitive1 folder and reloads C1.</span>
              </div>
            </div>
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>Universal Proxy</strong><small>Run the pinned proxy on loopback only</small></span>
                <input type="checkbox" checked={draft.proxy.enabled} onChange={(event) => setDraft({ ...draft, proxy: { ...draft.proxy, enabled: event.target.checked } })} />
              </label>
              <div className="field-grid">
                <NumberField label="Port" value={draft.proxy.port} min={1024} max={65535} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, port: value } })} />
                <SelectField label="Credential" value={draft.proxy.credentialId} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, credentialId: value } })} options={[...new Set(DIRECT_PROVIDER_ORDER.map((id) => directProviderPreset(id).credentialId)), 'proxy.main']} />
                <TextField label="Upstream URL" value={draft.proxy.targetBaseUrl} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, targetBaseUrl: value } })} />
                <TextField label="Default model" value={draft.proxy.defaultModel} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, defaultModel: value } })} />
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Database size={17} /><span>Data locations</span></div>
          <div className="location-list">{dataLocations.map((location) => <div key={location.kind} className="location-row"><span>{location.label}</span><code>{location.path}</code></div>)}</div>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Archive size={17} /><span>Configuration backups</span></div>
          <p className="settings-note">Snapshot KAI settings and project permissions before changing models, providers, MCP servers, or service routing.</p>
          {backupError && <div className="workbench-error" role="alert">{backupError}</div>}
          <div className="backup-create-row">
            <label className="field"><span>Backup name</span><input value={backupName} onChange={(event) => setBackupName(event.target.value)} placeholder="Optional label" /></label>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void createBackup()}><Archive size={15} /><span>Create backup</span></button>
            <button type="button" className="secondary-button" disabled={busy || backupsLoading} onClick={() => void refreshBackups()}><RefreshCw size={15} className={backupsLoading ? 'spin' : undefined} /><span>Refresh</span></button>
          </div>
          <div className="backup-list">
            {backups.map((backup) => (
              <article className="backup-row" key={backup.id}>
                <div className="backup-copy">
                  <strong>{backup.name}</strong>
                  <span>{new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}</span>
                  <code>{backup.path}</code>
                </div>
                <div className="backup-actions">
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => void restoreBackup(backup)}><ArchiveRestore size={14} /><span>Restore</span></button>
                  <button type="button" className="icon-button danger-button" disabled={busy} aria-label={`Delete ${backup.name}`} onClick={() => void deleteBackup(backup)}><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
            {!backupsLoading && backups.length === 0 && <div className="empty-list">No configuration backups yet</div>}
          </div>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Gauge size={17} /><span>Recent diagnostics</span></div>
          <div className="log-list">
            {logs.slice(-8).reverse().map((entry, index) => <div key={`${entry.timestamp}-${index}`} className={`log-row ${entry.severity}`}><span>{entry.severity}</span><strong>{entry.category}</strong><p>{entry.message}</p><time>{new Date(entry.timestamp).toLocaleTimeString()}</time></div>)}
            {logs.length === 0 && <div className="empty-list">No diagnostics recorded</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function PageHeader({ title, detail }: { title: string; detail: string }): ReactNode {
  return <header className="page-header"><div><h1>{title}</h1><p>{detail}</p></div></header>;
}

type SelectOption = string | { value: string; label: string };

function NotificationToggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }): ReactNode {
  return <label className="toggle-row"><span><strong>{label}</strong><small>{hint}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => {
    const item = typeof option === 'string' ? { value: option, label: option } : option;
    return <option key={item.value} value={item.value}>{item.label}</option>;
  })}</select></label>;
}

function TextField({ label, value, type = 'text', list, onChange }: { label: string; value: string; type?: string; list?: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><input type={type} list={list} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }): ReactNode {
  return <label className="field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} /></label>;
}

function updateDraftMcpServer(settings: AppSettings, index: number, patch: McpServerPatch): AppSettings {
  return {
    ...settings,
    mcpServers: settings.mcpServers.map((server, serverIndex) => serverIndex === index ? { ...server, ...patch } as McpServer : server),
  };
}

function updateDraftMcpServerTransport(settings: AppSettings, index: number, transport: McpServer['transport']): AppSettings {
  const server = settings.mcpServers[index];
  if (!server) return settings;
  const common = { id: server.id, name: server.name, enabled: server.enabled };
  const next: McpServer = transport === 'http'
    ? { ...common, transport: 'http', url: 'https://', headerCredentialIds: {} }
    : { ...common, transport: 'stdio', command: 'npx', args: [], cwd: null, envCredentialIds: {} };
  return { ...settings, mcpServers: settings.mcpServers.map((item, itemIndex) => itemIndex === index ? next : item) };
}

function newMcpServer(transport: McpServer['transport']): McpServer {
  const common = {
    id: `mcp_${window.crypto.randomUUID()}`,
    name: transport === 'http' ? 'New remote MCP server' : 'New local MCP server',
    enabled: false,
  };
  if (transport === 'http') return { ...common, transport: 'http', url: 'https://', headerCredentialIds: {} };
  return {
    ...common,
    transport: 'stdio',
    command: 'npx',
    args: [],
    cwd: null,
    envCredentialIds: {},
  };
}

function overwatchProviderPreset(provider: AppSettings['cognitive1']['overwatch']['provider']): {
  baseUrl: string;
  model: string;
} {
  if (provider === 'claude') return { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
  if (provider === 'openai') return { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' };
  return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' };
}

function formatCredentialRefs(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
}

function parseCredentialRefs(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const credentialId = line.slice(separator + 1).trim();
    if (key && credentialId) result[key] = credentialId;
  }
  return result;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The settings operation failed.';
}
