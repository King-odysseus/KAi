import { reconcileSettingsDraft } from './settings-draft';
import { Archive, ArchiveRestore, Check, Cloud, Code2, Cpu, Database, FolderInput, Gauge, GraduationCap, KeyRound, Keyboard, Play, Plug, Plus, RefreshCw, RotateCcw, Save, ServerCog, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UpdatesPanel } from './UpdatesPanel';
import { AgentTeamCard } from './TeamSettings';
import { changedGroups, SETTINGS_GROUP_NAMES, updateForGroups, type SettingsGroup } from './settings-groups';
import { CLI_MODEL_SUGGESTIONS, DIRECT_PROVIDER_ORDER, THEME_MODES, directProviderPreset, isLocalProvider, pickLocalModel } from '@kai/contracts';
import type { AppSettings, ConfigBackup, CredentialStatus, DataLocation, LogEntry, ProviderModelCatalog, ServiceState, SettingsUpdate } from '@kai/contracts';
import { confirmDialog } from './AppDialog';
import { ShortcutEditor } from './ShortcutSheet';
import { shortcutConflicts } from '../shortcuts';

type McpServer = AppSettings['mcpServers'][number];
type HttpMcpServer = Extract<McpServer, { transport: 'http' }>;
type StdioMcpServer = Extract<McpServer, { transport: 'stdio' }>;
type McpServerPatch = Partial<HttpMcpServer> | Partial<StdioMcpServer>;
type ProviderScope = 'direct' | 'learning';
type FeedbackScope = ProviderScope | 'generic' | 'overwatch';
type FeedbackKind = 'success' | 'error' | 'pending';
interface SettingsFeedback { kind: FeedbackKind; message: string }

/** What each card is called in the save bar. */
const GROUP_LABELS: Record<SettingsGroup, string> = {
  agentDefaults: 'Agent defaults',
  agentTeam: 'Agent team',
  editor: 'Code editor',
  shortcuts: 'Keyboard shortcuts',
  learningTutor: 'Learning Tutor API',
  directApi: 'Direct API',
  mcpServers: 'MCP servers',
  cognitive1: 'C1 Brain',
  proxy: 'Universal Proxy',
};

const SERVICE_STATES: Record<ServiceState['status'], string> = {
  ready: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  degraded: 'Degraded',
  stopped: 'Stopped',
  failed: 'Failed',
  not_configured: 'Off',
};

export function SettingsView({ activeProject, projectTeam, onSaveProjectTeam, settings, credentialStatus, dataLocations, logs, busy, services, onSave, onImportBrain, onSaveCredential, onClearCredential, onListProviderModels, onListBackups, onCreateBackup, onRestoreBackup, onDeleteBackup, onControlService }: { activeProject: { id: string; name: string } | null; projectTeam: AppSettings['agentTeam'] | null; onSaveProjectTeam: (team: AppSettings['agentTeam'] | null) => Promise<boolean>; settings: AppSettings; credentialStatus: CredentialStatus; dataLocations: DataLocation[]; logs: LogEntry[]; busy: boolean; services: ServiceState[]; onSave: (update: SettingsUpdate) => Promise<boolean>; onImportBrain: () => void; onSaveCredential: (id: string, value: string) => Promise<boolean>; onClearCredential: (id: string) => Promise<boolean>; onListProviderModels: (request: { provider: AppSettings['directApi']['provider']; baseUrl: string; credentialId: string }) => Promise<ProviderModelCatalog>; onListBackups: () => Promise<ConfigBackup[]>; onCreateBackup: (name?: string) => Promise<ConfigBackup>; onRestoreBackup: (id: string) => Promise<void>; onDeleteBackup: (id: string) => Promise<void>; onControlService: (kind: 'cognitive1' | 'universalProxy', action: 'start' | 'restart') => void }): ReactNode {
  const [draft, setDraft] = useState(settings);
  const [credentialId, setCredentialId] = useState('provider.openai');
  const [credentialValue, setCredentialValue] = useState('');
  const [directCredentialValue, setDirectCredentialValue] = useState('');
  const [learningCredentialValue, setLearningCredentialValue] = useState('');
  const [overwatchCredentialValue, setOverwatchCredentialValue] = useState('');
  const [providerModels, setProviderModels] = useState<Record<ProviderScope, ProviderModelCatalog | null>>({ direct: null, learning: null });
  const [refreshingModels, setRefreshingModels] = useState<ProviderScope | null>(null);
  const [modelFeedback, setModelFeedback] = useState<Record<ProviderScope, SettingsFeedback | null>>({ direct: null, learning: null });
  const [credentialFeedback, setCredentialFeedback] = useState<Record<FeedbackScope, SettingsFeedback | null>>({ direct: null, learning: null, generic: null, overwatch: null });
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [backupName, setBackupName] = useState('');
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [cardFeedback, setCardFeedback] = useState<Record<string, SettingsFeedback | null>>({});

  const previousSettings = useRef(settings);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    setDraft((current) => reconcileSettingsDraft(current, previous, settings));
  }, [settings]);
  useEffect(() => {
    void refreshBackups();
  }, []);
  const directPreset = directProviderPreset(draft.directApi.provider);
  const learningPreset = directProviderPreset(draft.learningTutor.provider);
  const directModels = providerModels.direct?.provider === draft.directApi.provider
    ? providerModels.direct.models
    : directPreset.models;
  const learningModels = providerModels.learning?.provider === draft.learningTutor.provider
    ? providerModels.learning.models
    : learningPreset.models;
  const overwatchCredentialReady = credentialStatus.ids.includes(draft.cognitive1.overwatch.credentialId);
  const shortcutConflictList = shortcutConflicts(draft.shortcuts);
  const setAgentModel = (agent: AppSettings['defaultAgent'], value: string): void => {
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
    // A local server has nothing to configure but a model, so list what it has right away.
    if (isLocalProvider(provider)) void refreshProviderModels('direct', { provider, baseUrl: preset.defaultBaseUrl, credentialId: preset.credentialId });
    setCredentialId(preset.credentialId);
    setProviderModels((current) => ({ ...current, direct: null }));
    setModelFeedback((current) => ({ ...current, direct: null }));
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
  const updateLearningProvider = (provider: AppSettings['learningTutor']['provider']): void => {
    const preset = directProviderPreset(provider);
    if (isLocalProvider(provider)) void refreshProviderModels('learning', { provider, baseUrl: preset.defaultBaseUrl, credentialId: preset.credentialId });
    setProviderModels((current) => ({ ...current, learning: null }));
    setModelFeedback((current) => ({ ...current, learning: null }));
    setDraft((current) => ({
      ...current,
      learningTutor: {
        ...current.learningTutor,
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

  async function refreshProviderModels(
    scope: ProviderScope,
    override?: { provider: AppSettings['directApi']['provider']; baseUrl: string; credentialId: string },
  ): Promise<void> {
    const configuration = override ?? (scope === 'direct' ? draft.directApi : draft.learningTutor);
    setRefreshingModels(scope);
    setModelFeedback((current) => ({ ...current, [scope]: { kind: 'pending', message: 'Refreshing provider models...' } }));
    try {
      const catalog = await onListProviderModels({
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        credentialId: configuration.credentialId,
      });
      setProviderModels((current) => ({ ...current, [scope]: catalog }));
      setModelFeedback((current) => ({
        ...current,
        [scope]: catalog.source === 'live'
          ? { kind: 'success', message: `Loaded ${catalog.models.length} live models from ${directProviderPreset(configuration.provider).displayName}.` }
          : { kind: 'error', message: catalog.error ?? 'Live model refresh was unavailable; using the bundled catalog.' },
      }));
      // With nothing chosen yet, start from a coding model the server already has (never an embedding model).
      if (catalog.source === 'live' && isLocalProvider(configuration.provider)) {
        const key = scope === 'direct' ? 'directApi' : 'learningTutor';
        setDraft((current) => (current[key].provider === configuration.provider && !current[key].model.trim()
          ? { ...current, [key]: { ...current[key], model: pickLocalModel(catalog.models) } }
          : current));
      }
    } catch (caught) {
      setModelFeedback((current) => ({ ...current, [scope]: { kind: 'error', message: messageOf(caught) } }));
    } finally {
      setRefreshingModels((current) => current === scope ? null : current);
    }
  }

  async function saveProviderKey(scope: ProviderScope): Promise<void> {
    const configuration = scope === 'direct' ? draft.directApi : draft.learningTutor;
    const value = scope === 'direct' ? directCredentialValue : learningCredentialValue;
    if (!value.trim()) return;
    setCredentialFeedback((current) => ({ ...current, [scope]: { kind: 'pending', message: 'Saving key in the OS vault...' } }));
    const settingsSaved = await onSave(scope === 'direct' ? { directApi: configuration } : { learningTutor: configuration });
    const keySaved = await onSaveCredential(configuration.credentialId, value);
    if (settingsSaved && keySaved) {
      if (scope === 'direct') setDirectCredentialValue('');
      else setLearningCredentialValue('');
      setCredentialFeedback((current) => ({
        ...current,
        [scope]: { kind: 'success', message: `${directProviderPreset(configuration.provider).displayName} key saved in the OS vault and this connection is ready to use.` },
      }));
      return;
    }
    setCredentialFeedback((current) => ({
      ...current,
      [scope]: {
        kind: 'error',
        message: keySaved
          ? 'The key was saved, but the provider settings could not be updated. Use this card\'s Save button and try again.'
          : 'The key could not be saved. Check the OS credential vault and try again.',
      },
    }));
  }

  async function clearProviderCredential(scope: ProviderScope): Promise<void> {
    const configuration = scope === 'direct' ? draft.directApi : draft.learningTutor;
    const cleared = await onClearCredential(configuration.credentialId);
    setCredentialFeedback((current) => ({
      ...current,
      [scope]: {
        kind: cleared ? 'success' : 'error',
        message: cleared ? 'Credential removed from the OS vault.' : 'The credential could not be removed.',
      },
    }));
  }

  async function saveNamedCredential(id: string, value: string, scope: FeedbackScope): Promise<void> {
    setCredentialFeedback((current) => ({ ...current, [scope]: { kind: 'pending', message: 'Saving credential...' } }));
    const saved = await onSaveCredential(id, value);
    if (saved) {
      if (scope === 'generic') setCredentialValue('');
      if (scope === 'overwatch') setOverwatchCredentialValue('');
    }
    setCredentialFeedback((current) => ({
      ...current,
      [scope]: {
        kind: saved ? 'success' : 'error',
        message: saved ? `Credential "${id}" saved in the OS vault.` : 'The credential could not be saved.',
      },
    }));
  }

  async function clearNamedCredential(id: string, scope: FeedbackScope): Promise<void> {
    const cleared = await onClearCredential(id);
    setCredentialFeedback((current) => ({
      ...current,
      [scope]: {
        kind: cleared ? 'success' : 'error',
        message: cleared ? `Credential "${id}" removed from the OS vault.` : 'The credential could not be removed.',
      },
    }));
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

  async function saveGroups(groups: readonly SettingsGroup[], feedbackKey: string): Promise<void> {
    if (groups.includes('shortcuts') && shortcutConflictList.length > 0) {
      setCardFeedback((current) => ({ ...current, [feedbackKey]: { kind: 'error', message: shortcutConflictList[0]! } }));
      return;
    }
    setCardFeedback((current) => ({ ...current, [feedbackKey]: { kind: 'pending', message: 'Saving settings...' } }));
    const names = groups.map((group) => GROUP_LABELS[group]).join(', ');
    const saved = await onSave(updateForGroups(draft, groups));
    setCardFeedback((current) => ({
      ...current,
      [feedbackKey]: {
        kind: saved ? 'success' : 'error',
        message: saved
          ? `${names} saved and shared with all open KAI windows.`
          : 'Settings were not saved. Review the error shown at the top of the window.',
      },
    }));
  }

  function discardDraft(): void {
    setDraft(settings);
    setCardFeedback({});
  }

  const changed = useMemo(() => changedGroups(draft, settings), [draft, settings]);
  const isDirty = (groups: readonly SettingsGroup[]): boolean => groups.some((group) => changed.includes(group));

  function serviceState(kind: 'cognitive1' | 'universalProxy'): ServiceState {
    return services.find((service) => service.kind === kind) ?? {
      kind,
      status: 'not_configured',
      detail: 'Service status is unavailable.',
      endpoint: null,
      version: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** The Save button for one card. It stays disabled until that card actually changes something. */
  function cardSave(feedbackKey: string, label: string, groups: readonly SettingsGroup[]): ReactNode {
    const pending = cardFeedback[feedbackKey]?.kind === 'pending';
    return (
      <>
        <button
          type="button"
          className={`primary-button align-end card-save ${isDirty(groups) ? 'dirty' : ''}`}
          disabled={busy || !isDirty(groups) || pending || (groups.includes('shortcuts') && shortcutConflictList.length > 0)}
          onClick={() => void saveGroups(groups, feedbackKey)}
        >
          <Check size={16} />
          <span>{pending ? 'Saving' : label}</span>
        </button>
        <FeedbackMessage feedback={cardFeedback[feedbackKey] ?? null} />
      </>
    );
  }

  return (
    <div className="page-view settings-view">
      <PageHeader title="Settings" detail="App-owned configuration and local diagnostics" />
      <div className={`settings-save-bar ${changed.length > 0 ? 'dirty' : 'saved'}`}>
        <div className="settings-save-summary">
          <strong>{changed.length > 0 ? `${changed.length} card${changed.length === 1 ? '' : 's'} with unsaved changes` : 'All changes saved'}</strong>
          <small>{changed.length > 0 ? changed.map((group) => GROUP_LABELS[group]).join(' · ') : 'Every card below matches what KAI has stored.'}</small>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-button" disabled={busy || changed.length === 0} onClick={discardDraft}>
            <RotateCcw size={15} />
            <span>Discard</span>
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || changed.length === 0 || shortcutConflictList.length > 0 || cardFeedback.all?.kind === 'pending'}
            onClick={() => void saveGroups(SETTINGS_GROUP_NAMES, 'all')}
          >
            <Save size={15} />
            <span>{cardFeedback.all?.kind === 'pending' ? 'Saving everything' : 'Save all changes'}</span>
          </button>
        </div>
        <FeedbackMessage feedback={cardFeedback.all ?? null} />
      </div>
      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title"><Cpu size={17} /><span>Agent defaults</span></div>
          <div className="field-grid">
            <SelectField label="Agent" value={draft.defaultAgent} onChange={(value) => setDraft({ ...draft, defaultAgent: value as AppSettings['defaultAgent'] })} options={['codex', 'claude', 'qwen', 'gemini', 'kimi']} />
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
              {(['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const).map((agent) => (
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
          {cardSave('agentDefaults', 'Save agent defaults', ['agentDefaults'])}
        </section>

        <section className="settings-section" aria-label="Agent team">
          <div className="section-title"><Users size={17} /><span>Agent team</span></div>
          <AgentTeamCard
            globalTeam={draft.agentTeam}
            onGlobalChange={(agentTeam) => setDraft({ ...draft, agentTeam })}
            globalSaveSlot={cardSave('agentTeam', 'Save agent team', ['agentTeam'])}
            project={activeProject}
            projectTeam={projectTeam}
            onSaveProjectTeam={onSaveProjectTeam}
            busy={busy}
          />
        </section>

        <section className="settings-section">
          <div className="section-title"><Code2 size={17} /><span>Code editor</span></div>
          <p className="settings-note">Autosave writes after a short pause when the file has not changed elsewhere. Conflicting external edits are never overwritten.</p>
          <NotificationToggle
            label="Autosave edited files"
            hint="Keeps files current while you work; Ctrl+S still saves immediately"
            checked={draft.editor.autoSave}
            onChange={(autoSave) => setDraft((current) => ({ ...current, editor: { ...current.editor, autoSave } }))}
          />
          {draft.editor.autoSave && (
            <div className="field-grid">
              <NumberField
                label="Autosave delay (ms)"
                value={draft.editor.autoSaveDelayMs}
                min={300}
                max={10_000}
                step={100}
                onChange={(autoSaveDelayMs) => setDraft((current) => ({ ...current, editor: { ...current.editor, autoSaveDelayMs } }))}
              />
            </div>
          )}
          {cardSave('editor', 'Save editor settings', ['editor'])}
        </section>

        <UpdatesPanel settings={settings} />

        <section className="settings-section">
          <div className="section-title"><Keyboard size={17} /><span>Keyboard shortcuts</span></div>
          <p className="settings-note">Focus a shortcut and press a new key combination. Changes are shared by every KAI window after saving.</p>
          <ShortcutEditor
            shortcuts={draft.shortcuts}
            disabled={busy}
            onChange={(shortcuts) => setDraft((current) => ({ ...current, shortcuts }))}
          />
          {shortcutConflictList.length > 0 && <FeedbackMessage feedback={{ kind: 'error', message: shortcutConflictList[0]! }} />}
          {cardSave('shortcuts', 'Save shortcuts', ['shortcuts'])}
        </section>

        <ProviderConnectionSection
          title="Learning Tutor API"
          icon={<GraduationCap size={17} />}
          detail="Dedicated provider connection for Learn, Guided, Pair, and Copilot. It stays independent from Compose and Direct API mode."
          toggleLabel="Enable Learning Tutor API"
          toggleHint={isLocalProvider(draft.learningTutor.provider) ? 'Uses the LM Studio server on this computer; no key needed' : 'Uses its own provider and OS-vault credential'}
          enabled={draft.learningTutor.enabled}
          provider={draft.learningTutor.provider}
          model={draft.learningTutor.model}
          baseUrl={draft.learningTutor.baseUrl}
          credentialId={draft.learningTutor.credentialId}
          models={learningModels}
          catalog={providerModels.learning}
          modelFeedback={modelFeedback.learning}
          refreshingModels={refreshingModels === 'learning'}
          credentialValue={learningCredentialValue}
          credentialStored={credentialStatus.ids.includes(draft.learningTutor.credentialId)}
          credentialFeedback={credentialFeedback.learning}
          busy={busy}
          modelListId="learning-tutor-models"
          saveSlot={cardSave('learningTutor', 'Save Learning Tutor settings', ['learningTutor'])}
          onEnabledChange={(enabled) => setDraft({ ...draft, learningTutor: { ...draft.learningTutor, enabled } })}
          onProviderChange={(provider) => updateLearningProvider(provider)}
          onModelChange={(model) => setDraft({ ...draft, learningTutor: { ...draft.learningTutor, model } })}
          onBaseUrlChange={(baseUrl) => setDraft({ ...draft, learningTutor: { ...draft.learningTutor, baseUrl } })}
          onCredentialIdChange={(id) => setDraft({ ...draft, learningTutor: { ...draft.learningTutor, credentialId: id } })}
          onCredentialValueChange={setLearningCredentialValue}
          onRefreshModels={() => void refreshProviderModels('learning')}
          onSaveKey={() => void saveProviderKey('learning')}
          onClearKey={() => void clearProviderCredential('learning')}
          vaultAvailable={credentialStatus.available}
        />

        <ProviderConnectionSection
          title="Direct API"
          icon={<Cloud size={17} />}
          detail="Provider connection used by Compose when execution is set to API. Changing it does not change Learning Tutor."
          toggleLabel="Enable direct API mode"
          toggleHint={isLocalProvider(draft.directApi.provider) ? 'Uses the LM Studio server on this computer; no key needed' : 'Uses a provider key from the OS vault'}
          enabled={draft.directApi.enabled}
          provider={draft.directApi.provider}
          model={draft.directApi.model}
          baseUrl={draft.directApi.baseUrl}
          credentialId={draft.directApi.credentialId}
          models={directModels}
          catalog={providerModels.direct}
          modelFeedback={modelFeedback.direct}
          refreshingModels={refreshingModels === 'direct'}
          credentialValue={directCredentialValue}
          credentialStored={credentialStatus.ids.includes(draft.directApi.credentialId)}
          credentialFeedback={credentialFeedback.direct}
          busy={busy}
          modelListId="direct-api-models"
          saveSlot={cardSave('directApi', 'Save Direct API settings', ['directApi'])}
          onEnabledChange={(enabled) => setDraft({ ...draft, directApi: { ...draft.directApi, enabled } })}
          onProviderChange={(provider) => updateDirectProvider(provider)}
          onModelChange={(model) => setDraft({ ...draft, directApi: { ...draft.directApi, model } })}
          onBaseUrlChange={(baseUrl) => setDraft({ ...draft, directApi: { ...draft.directApi, baseUrl } })}
          onCredentialIdChange={(id) => setDraft({ ...draft, directApi: { ...draft.directApi, credentialId: id } })}
          onCredentialValueChange={setDirectCredentialValue}
          onRefreshModels={() => void refreshProviderModels('direct')}
          onSaveKey={() => void saveProviderKey('direct')}
          onClearKey={() => void clearProviderCredential('direct')}
          vaultAvailable={credentialStatus.available}
        />

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
          {cardSave('mcpServers', 'Save MCP servers', ['mcpServers'])}
        </section>

        <section className="settings-section">
          <div className="section-title"><KeyRound size={17} /><span>Credentials</span></div>
          <div className={`vault-state ${credentialStatus.available ? 'ready' : 'unavailable'}`}><ShieldCheck size={18} /><div><strong>{credentialStatus.available ? 'OS vault available' : 'OS vault unavailable'}</strong><small>{credentialStatus.ids.length} stored credentials</small></div></div>
          <div className="credential-form">
            <TextField label="Credential ID" value={credentialId} onChange={setCredentialId} />
            <TextField label="Secret" value={credentialValue} onChange={setCredentialValue} type="password" />
            <div className="button-row">
              <button type="button" className="primary-button" disabled={!credentialValue.trim() || !credentialStatus.available || busy} onClick={() => void saveNamedCredential(credentialId, credentialValue, 'generic')}><KeyRound size={15} /><span>Save credential</span></button>
              <button type="button" className="secondary-button" disabled={busy || !credentialStatus.ids.includes(credentialId)} onClick={() => void clearNamedCredential(credentialId, 'generic')}><Trash2 size={15} /><span>Remove</span></button>
            </div>
          </div>
          <FeedbackMessage feedback={credentialFeedback.generic} />
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><ServerCog size={17} /><span>Managed services</span></div>
          <div className="service-settings-grid">
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>C1 Brain</strong><small>Run the pinned Cognitive1 daemon locally</small></span>
                <input type="checkbox" checked={draft.cognitive1.enabled} onChange={(event) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, enabled: event.target.checked } })} />
              </label>
              <ServiceStatusLine kind="cognitive1" service={serviceState('cognitive1')} busy={busy} onStart={() => onControlService('cognitive1', 'start')} onRestart={() => onControlService('cognitive1', 'restart')} />
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
                      onClick={() => void saveNamedCredential(draft.cognitive1.overwatch.credentialId, overwatchCredentialValue, 'overwatch')}
                    >
                      <KeyRound size={15} />
                      <span>Save Overwatch key</span>
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !overwatchCredentialReady}
                      onClick={() => void clearNamedCredential(draft.cognitive1.overwatch.credentialId, 'overwatch')}
                    >
                      <Trash2 size={15} />
                      <span>Remove key</span>
                    </button>
                  </div>
                </div>
                <FeedbackMessage feedback={credentialFeedback.overwatch} />
                <p className={`settings-note ${overwatchCredentialReady ? 'ready' : ''}`}>
                  {overwatchCredentialReady
                    ? 'Credential stored in the OS vault. Save this card to restart C1 with this Overwatch configuration.'
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
              {cardSave('cognitive1', 'Save C1 settings', ['cognitive1'])}
            </div>
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>Universal Proxy</strong><small>Run the pinned proxy on loopback only</small></span>
                <input type="checkbox" checked={draft.proxy.enabled} onChange={(event) => setDraft({ ...draft, proxy: { ...draft.proxy, enabled: event.target.checked } })} />
              </label>
              <ServiceStatusLine kind="universalProxy" service={serviceState('universalProxy')} busy={busy} onStart={() => onControlService('universalProxy', 'start')} onRestart={() => onControlService('universalProxy', 'restart')} />
              <div className="field-grid">
                <NumberField label="Port" value={draft.proxy.port} min={1024} max={65535} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, port: value } })} />
                <SelectField label="Credential" value={draft.proxy.credentialId} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, credentialId: value } })} options={[...new Set(DIRECT_PROVIDER_ORDER.map((id) => directProviderPreset(id).credentialId)), 'proxy.main']} />
                <TextField label="Upstream URL" value={draft.proxy.targetBaseUrl} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, targetBaseUrl: value } })} />
                <TextField label="Default model" value={draft.proxy.defaultModel} onChange={(value) => setDraft({ ...draft, proxy: { ...draft.proxy, defaultModel: value } })} />
              </div>
              <p className="settings-note">Route your CLIs through KAI by selecting Proxy in Compose. If another program already holds this port, KAI moves its own proxy to the next free one and saves it here.</p>
              {cardSave('proxy', 'Save proxy settings', ['proxy'])}
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

/** The live state of a managed service, so "enabled but not running" shows its reason here and not only on its own page. */
function ServiceStatusLine({ kind, service, busy, onStart, onRestart }: { kind: ServiceState['kind']; service: ServiceState; busy: boolean; onStart: () => void; onRestart: () => void }): ReactNode {
  const running = service.status === 'ready';
  return (
    <div className={`service-status ${service.status}`}>
      <div className="service-status-head">
        <span className="service-status-dot" aria-hidden="true" />
        <strong>{SERVICE_STATES[service.status]}</strong>
        {service.endpoint && <code>{service.endpoint}</code>}
        <button type="button" className="secondary-button compact" disabled={busy} onClick={running ? onRestart : onStart}>
          {running ? <RefreshCw size={14} /> : <Play size={14} />}
          <span>{running ? 'Restart' : 'Start'}</span>
        </button>
      </div>
      <p>{service.detail}</p>
      {service.restartsExhausted === true && <p className="service-status-warning">Automatic restarts stopped after {service.restarts ?? 0} crashes. Start {kind === 'cognitive1' ? 'C1' : 'the proxy'} again once the cause is fixed.</p>}
    </div>
  );
}

function ProviderConnectionSection({
  title,
  icon,
  detail,
  toggleLabel,
  toggleHint,
  enabled,
  provider,
  model,
  baseUrl,
  credentialId,
  models,
  catalog,
  modelFeedback,
  refreshingModels,
  credentialValue,
  credentialStored,
  credentialFeedback,
  busy,
  modelListId,
  vaultAvailable,
  saveSlot,
  onEnabledChange,
  onProviderChange,
  onModelChange,
  onBaseUrlChange,
  onCredentialIdChange,
  onCredentialValueChange,
  onRefreshModels,
  onSaveKey,
  onClearKey,
}: {
  title: string;
  icon: ReactNode;
  detail: string;
  toggleLabel: string;
  toggleHint: string;
  enabled: boolean;
  provider: AppSettings['directApi']['provider'];
  model: string;
  baseUrl: string;
  credentialId: string;
  models: readonly string[];
  catalog: ProviderModelCatalog | null;
  modelFeedback: SettingsFeedback | null;
  refreshingModels: boolean;
  credentialValue: string;
  credentialStored: boolean;
  credentialFeedback: SettingsFeedback | null;
  busy: boolean;
  modelListId: string;
  vaultAvailable: boolean;
  saveSlot: ReactNode;
  onEnabledChange: (enabled: boolean) => void;
  onProviderChange: (provider: AppSettings['directApi']['provider']) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (baseUrl: string) => void;
  onCredentialIdChange: (id: string) => void;
  onCredentialValueChange: (value: string) => void;
  onRefreshModels: () => void;
  onSaveKey: () => void;
  onClearKey: () => void;
}): ReactNode {
  const preset = directProviderPreset(provider);
  const local = isLocalProvider(provider);
  return (
    <section className="settings-section">
      <div className="section-title">{icon}<span>{title}</span></div>
      <p className="settings-note">{detail}</p>
      <label className="toggle-row"><span><strong>{toggleLabel}</strong><small>{toggleHint}</small></span><input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} /></label>
      <div className="field-grid">
        <SelectField label="Provider" value={provider} onChange={(value) => onProviderChange(value as AppSettings['directApi']['provider'])} options={DIRECT_PROVIDER_ORDER.map((id) => ({ value: id, label: directProviderPreset(id).displayName }))} />
        <TextField label="Model" value={model} list={modelListId} onChange={onModelChange} />
        <TextField label="Base URL" value={baseUrl} onChange={onBaseUrlChange} />
        <TextField label="Credential ID" value={credentialId} onChange={onCredentialIdChange} />
      </div>
      <datalist id={modelListId}>{models.map((candidate) => <option key={candidate} value={candidate} />)}</datalist>
      <div className="button-row align-start">
        <button type="button" className="secondary-button" disabled={busy || refreshingModels} onClick={onRefreshModels}>
          <RefreshCw size={15} className={refreshingModels ? 'spin' : undefined} />
          <span>{refreshingModels ? 'Refreshing models' : 'Refresh models'}</span>
        </button>
        <span className="settings-note">
          {catalog?.source === 'live'
            ? `${catalog.models.length} ${local ? 'models on this computer' : 'live provider models'}. Refreshed ${formatRefreshTime(catalog.fetchedAt)}.`
            : local
              ? 'Refresh lists the models you have downloaded in LM Studio.'
              : 'Bundled model catalog. Refresh uses the stored credential without exposing it.'}
        </span>
      </div>
      <FeedbackMessage feedback={modelFeedback} />
      {local && <p className="settings-note local-provider-note">Runs on your computer, so there is no key and nothing is billed. In LM Studio open the Developer tab, start the local server and load a model (for example Qwen2.5 Coder), then refresh here. Only add a key below if you switched on API-token protection in LM Studio.</p>}
      <div className="credential-form">
        <TextField label={local ? 'API key (optional)' : 'API key'} value={credentialValue} type="password" onChange={onCredentialValueChange} />
        <div className="button-row align-start">
          <button type="button" className="secondary-button" disabled={!credentialValue.trim() || !vaultAvailable || busy} onClick={onSaveKey}>
            <KeyRound size={15} />
            <span>Save key and use provider</span>
          </button>
          <button type="button" className="secondary-button" disabled={busy || !credentialStored} onClick={onClearKey}>
            <Trash2 size={15} />
            <span>Remove key</span>
          </button>
          <span className="settings-note">{credentialStored ? 'Credential stored in the OS vault.' : local ? 'No key stored, which is fine for a local server.' : 'No credential stored for this ID.'}</span>
        </div>
      </div>
      <FeedbackMessage feedback={credentialFeedback} />
      <p className="settings-note">{preset.protocol === 'responses'
        ? 'Uses the OpenAI Responses API. '
        : preset.protocol === 'chat-completions'
          ? 'Uses the OpenAI-compatible Chat Completions API. '
          : preset.protocol === 'anthropic-messages'
            ? 'Uses the native Anthropic Messages API. '
            : 'Uses the native Google Gemini API. '}{title === 'Direct API' ? 'Assistant text streams into Compose, and enabled MCP servers use the same approval rules.' : 'Tutor requests use this connection even when Compose is set to CLI or Direct API is disabled.'}</p>
      {saveSlot}
    </section>
  );
}

function FeedbackMessage({ feedback }: { feedback: SettingsFeedback | null }): ReactNode {
  if (!feedback) return null;
  return <p className={`settings-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>;
}

function formatRefreshTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : value;
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
  return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' };
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
