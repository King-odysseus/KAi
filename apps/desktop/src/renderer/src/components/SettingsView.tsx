import { reconcileSettingsDraft } from './settings-draft';
import { Archive, ArchiveRestore, Check, ChevronDown, Cloud, Code2, Cpu, Database, FolderInput, Gauge, GraduationCap, KeyRound, Keyboard, PenTool, Play, Plug, Plus, RefreshCw, RotateCcw, Save, Search, ServerCog, ShieldCheck, Trash2, Users, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UpdatesPanel } from './UpdatesPanel';
import { OpenPencilCard } from './OpenPencilCard';
import { RemoteAccessPanel } from './RemoteAccessPanel';
import { AgentTeamCard } from './TeamSettings';
import { ProjectAutomation } from './AutomationSettings';
import { changedGroups, SETTINGS_GROUP_NAMES, updateForGroups, type SettingsGroup } from './settings-groups';
import { ThemeColors } from './ThemeColors';
import { ACCESS_LEVELS, CLI_MODEL_SUGGESTIONS, cliApiKeyCredentialId, DIRECT_PROVIDER_ORDER, EXPERIENCE_PROFILES, experienceProfile, WORK_LEVELS, WORK_LEVEL_LABEL, THEME_MODES, WEB_SEARCH_SOURCES, WEB_SEARCH_SOURCE_LABEL, directProviderPreset, isLocalProvider, nativeSearchProvider, pickLocalModel, searchCredentialId } from '@kai/contracts';
import type { AgentConfigImportPreview, AppSettings, ConnectorCatalogEntry, ProjectAutomation as ProjectAutomationSettings, ConfigBackup, CredentialStatus, DataLocation, LogEntry, ProviderModelCatalog, ServiceState, SettingsUpdate, WebSearchTestResult } from '@kai/contracts';
import { confirmDialog } from './AppDialog';
import { ModelField } from './ModelField';
import { ShortcutEditor } from './ShortcutSheet';
import { shortcutConflicts } from '../shortcuts';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
import { PageHeader } from './ui/PageHeader';
type McpServer = AppSettings['mcpServers'][number];
type HttpMcpServer = Extract<McpServer, { transport: 'http' }>;
type StdioMcpServer = Extract<McpServer, { transport: 'stdio' }>;
type McpServerPatch = Partial<HttpMcpServer> | Partial<StdioMcpServer>;
type ProviderScope = 'direct' | 'learning' | 'guide';
/** The settings entry each provider card edits. */
const SCOPE_KEY = { direct: 'directApi', learning: 'learningTutor', guide: 'promptGuide' } as const;
type FeedbackScope = ProviderScope | 'generic' | 'overwatch' | 'search' | 'cli';
type FeedbackKind = 'success' | 'error' | 'pending';
interface SettingsFeedback { kind: FeedbackKind; message: string }
type SettingsCategoryId = 'general' | 'connections' | 'design' | 'services' | 'data';

const SETTINGS_CATEGORIES: Array<{ id: SettingsCategoryId; title: string; detail: string }> = [
  { id: 'general', title: 'General', detail: 'Defaults, team, editor, updates, and shortcuts' },
  { id: 'connections', title: 'Connections and models', detail: 'Providers, API keys, MCP servers, and credentials' },
  { id: 'design', title: 'Design tools', detail: 'The open-pencil connection for drawing and pulling screens' },
  { id: 'services', title: 'Services and access', detail: 'C1 Brain, Universal Proxy, and remote access' },
  { id: 'data', title: 'Data and diagnostics', detail: 'Locations, backups, and recent logs' },
];

/** What each card is called in the save bar. */
const GROUP_LABELS: Record<SettingsGroup, string> = {
  agentDefaults: 'Agent defaults',
  agentTeam: 'Agent team',
  editor: 'Code editor',
  shortcuts: 'Keyboard shortcuts',
  learningTutor: 'Learning Tutor API',
  experienceCapture: 'Agent experience capture',
  promptGuide: 'Prompt Guide',
  directApi: 'Direct API',
  webSearch: 'Web search',
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

export function SettingsView({ activeProject, projectTeam, onSaveProjectTeam, projectAutomation, onSaveProjectAutomation, settings, credentialStatus, dataLocations, logs, busy, services, onSave, onImportBrain, onSaveCredential, onClearCredential, onListProviderModels, onListBackups, onCreateBackup, onRestoreBackup, onDeleteBackup, onControlService, destination }: { activeProject: { id: string; name: string } | null; projectTeam: AppSettings['agentTeam'] | null; onSaveProjectTeam: (team: AppSettings['agentTeam'] | null) => Promise<boolean>; projectAutomation: ProjectAutomationSettings | null; onSaveProjectAutomation: (automation: ProjectAutomationSettings | null) => Promise<boolean>; settings: AppSettings; credentialStatus: CredentialStatus; dataLocations: DataLocation[]; logs: LogEntry[]; busy: boolean; services: ServiceState[]; onSave: (update: SettingsUpdate) => Promise<boolean>; onImportBrain: () => void; onSaveCredential: (id: string, value: string) => Promise<boolean>; onClearCredential: (id: string) => Promise<boolean>; onListProviderModels: (request: { provider: AppSettings['directApi']['provider']; baseUrl: string; credentialId: string }) => Promise<ProviderModelCatalog>; onListBackups: () => Promise<ConfigBackup[]>; onCreateBackup: (name?: string) => Promise<ConfigBackup>; onRestoreBackup: (id: string) => Promise<void>; onDeleteBackup: (id: string) => Promise<void>; onControlService: (kind: 'cognitive1' | 'universalProxy', action: 'start' | 'restart') => void; destination?: { category: SettingsCategoryId; nonce: number } | null }): ReactNode {
  const [draft, setDraft] = useState(settings);
  const [credentialId, setCredentialId] = useState('provider.openai');
  const [credentialValue, setCredentialValue] = useState('');
  const [directCredentialValue, setDirectCredentialValue] = useState('');
  const [learningCredentialValue, setLearningCredentialValue] = useState('');
  const [overwatchCredentialValue, setOverwatchCredentialValue] = useState('');
  const [guideCredentialValue, setGuideCredentialValue] = useState('');
  const [searchCredentialValue, setSearchCredentialValue] = useState('');
  const [cliKeyValues, setCliKeyValues] = useState<Record<string, string>>({});
  const [searchTest, setSearchTest] = useState<{ kind: FeedbackKind; message: string; titles: string[] } | null>(null);
  const [providerModels, setProviderModels] = useState<Record<ProviderScope, ProviderModelCatalog | null>>({ direct: null, learning: null, guide: null });
  const [refreshingModels, setRefreshingModels] = useState<ProviderScope | null>(null);
  const [modelFeedback, setModelFeedback] = useState<Record<ProviderScope, SettingsFeedback | null>>({ direct: null, learning: null, guide: null });
  const [credentialFeedback, setCredentialFeedback] = useState<Record<FeedbackScope, SettingsFeedback | null>>({ direct: null, learning: null, guide: null, generic: null, overwatch: null, search: null, cli: null });
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [backupName, setBackupName] = useState('');
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [experienceCount, setExperienceCount] = useState(0);
  const [experienceMessage, setExperienceMessage] = useState('');
  const [cardFeedback, setCardFeedback] = useState<Record<string, SettingsFeedback | null>>({});
  const [connectorCatalog, setConnectorCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [connectorChoice, setConnectorChoice] = useState('');
  const [connectorMessage, setConnectorMessage] = useState<string | null>(null);
  const [openCategories, setOpenCategories] = useState<Record<SettingsCategoryId, boolean>>({
    general: true,
    connections: false,
    design: false,
    services: false,
    data: false,
  });

  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('general');
  const searching = query.trim() !== '';
  const isOpen = (id: SettingsCategoryId): boolean => searching || openCategories[id];

  const previousSettings = useRef(settings);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    setDraft((current) => reconcileSettingsDraft(current, previous, settings));
  }, [settings]);
  useEffect(() => {
    void refreshBackups();
  }, []);
  useEffect(() => {
    void window.kaiDesktop.experienceCount().then((response) => { if (response.ok) setExperienceCount(response.data); });
  }, []);
  useEffect(() => {
    void window.kaiDesktop.listConnectorCatalog().then((response) => {
      if (!response.ok) return;
      setConnectorCatalog(response.data);
      setConnectorChoice((current) => current || response.data[0]?.id || '');
    });
  }, []);
  const exportExperiences = async (): Promise<void> => {
    const response = await window.kaiDesktop.exportExperiences();
    setExperienceMessage(response.ok ? response.data ? `Exported ${response.data.count} records to ${response.data.path}` : 'Export cancelled or no records are available.' : response.error.message);
  };
  const clearExperiences = async (): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete captured agent experiences?', detail: 'This permanently removes the local experience dataset from this device.', confirmLabel: 'Delete dataset', destructive: true }))) return;
    const response = await window.kaiDesktop.clearExperiences();
    if (response.ok) { setExperienceCount(0); setExperienceMessage('Local experience dataset deleted.'); }
    else setExperienceMessage(response.error.message);
  };
  const directPreset = directProviderPreset(draft.directApi.provider);
  const learningPreset = directProviderPreset(draft.learningTutor.provider);
  const directModels = providerModels.direct?.provider === draft.directApi.provider
    ? providerModels.direct.models
    : directPreset.models;
  const learningModels = providerModels.learning?.provider === draft.learningTutor.provider
    ? providerModels.learning.models
    : learningPreset.models;
  const guidePreset = directProviderPreset(draft.promptGuide.provider);
  const guideModels = providerModels.guide?.provider === draft.promptGuide.provider
    ? providerModels.guide.models
    : guidePreset.models;
  const webSearch = draft.webSearch;
  const nativeSearchSource = nativeSearchProvider(webSearch.source);
  // Blank override means: the matching Direct API key when it is the same provider, otherwise the provider's preset key.
  const searchCredential = webSearch.credentialId.trim()
    || (nativeSearchSource
      ? (draft.directApi.provider === nativeSearchSource ? draft.directApi.credentialId : directProviderPreset(nativeSearchSource).credentialId)
      : searchCredentialId(webSearch.source));
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
  const setCliApiKey = (agent: AppSettings['defaultAgent'], use: boolean): void => {
    setDraft((current) => ({ ...current, cliApiKeys: { ...current.cliApiKeys, [agent]: use } }));
  };
  const setTierModel = (agent: AppSettings['defaultAgent'], level: (typeof WORK_LEVELS)[number], value: string): void => {
    setDraft((current) => {
      const tier = { ...current.autoModel.tiers[agent] };
      if (value.trim()) tier[level] = value.trim();
      else delete tier[level];
      return { ...current, autoModel: { ...current.autoModel, tiers: { ...current.autoModel.tiers, [agent]: tier } } };
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
  const updateLearningProvider = (provider: AppSettings['learningTutor']['provider'], scope: 'learning' | 'guide' = 'learning'): void => {
    const preset = directProviderPreset(provider);
    const key = SCOPE_KEY[scope];
    if (isLocalProvider(provider)) void refreshProviderModels(scope, { provider, baseUrl: preset.defaultBaseUrl, credentialId: preset.credentialId });
    setProviderModels((current) => ({ ...current, [scope]: null }));
    setModelFeedback((current) => ({ ...current, [scope]: null }));
    setDraft((current) => ({
      ...current,
      [key]: {
        ...current[key],
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
    const configuration = override ?? draft[SCOPE_KEY[scope]];
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
        const key = SCOPE_KEY[scope];
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
    const configuration = draft[SCOPE_KEY[scope]];
    const value = { direct: directCredentialValue, learning: learningCredentialValue, guide: guideCredentialValue }[scope];
    if (!value.trim()) return;
    setCredentialFeedback((current) => ({ ...current, [scope]: { kind: 'pending', message: 'Saving key in the OS vault...' } }));
    const settingsSaved = await onSave({ [SCOPE_KEY[scope]]: configuration });
    const keySaved = await onSaveCredential(configuration.credentialId, value);
    if (settingsSaved && keySaved) {
      ({ direct: setDirectCredentialValue, learning: setLearningCredentialValue, guide: setGuideCredentialValue })[scope]('');
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

  async function addConnectorFromCatalog(): Promise<void> {
    if (!connectorChoice) return;
    const response = await window.kaiDesktop.installConnector(connectorChoice);
    if (!response.ok) {
      setConnectorMessage(response.error.message);
      return;
    }
    setDraft((current) => ({
      ...current,
      mcpServers: [...current.mcpServers.filter((server) => server.id !== response.data.id), response.data],
    }));
    setConnectorMessage(`${response.data.name} added disabled. Fill any credential and tick Enabled, then save.`);
  }

  async function testWebSearchConnection(): Promise<void> {
    setSearchTest({ kind: 'pending', message: 'Testing the search source...', titles: [] });
    const response = await window.kaiDesktop.testWebSearch({
      source: webSearch.source,
      endpoint: webSearch.endpoint,
      credentialId: webSearch.credentialId,
    });
    if (!response.ok) {
      setSearchTest({ kind: 'error', message: response.error.message, titles: [] });
      return;
    }
    setSearchTest({
      kind: response.data.ok ? 'success' : 'error',
      message: response.data.detail,
      titles: response.data.titles,
    });
  }

  async function clearProviderCredential(scope: ProviderScope): Promise<void> {
    const configuration = draft[SCOPE_KEY[scope]];
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
      if (scope === 'cli') setCliKeyValues({});
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

  // Search looks through everything a card says: headings, notes, field labels, placeholders and tooltips. Closed
  // categories are opened while searching so their cards exist to be matched, and categories with no match hide.
  useEffect(() => {
    const root = document.querySelector('.settings-categories');
    if (!root) return;
    const needle = query.trim().toLowerCase();
    const cards = [...root.querySelectorAll<HTMLElement>('.settings-section')];
    for (const card of cards) {
      if (!needle) {
        card.hidden = false;
        continue;
      }
      const attributes = [...card.querySelectorAll<HTMLElement>('[placeholder],[aria-label],[title]')]
        .map((element) => `${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`)
        .join(' ');
      card.hidden = !`${card.textContent ?? ''} ${attributes}`.toLowerCase().includes(needle);
    }
    for (const category of root.querySelectorAll<HTMLElement>('.settings-category')) {
      category.hidden = needle !== '' && ![...category.querySelectorAll<HTMLElement>('.settings-section')].some((card) => !card.hidden);
    }
  });

  // The bar highlights the category being read, so it works as a map and not only as buttons.
  useEffect(() => {
    const elements = SETTINGS_CATEGORIES.flatMap((category) => document.getElementById(`settings-category-${category.id}`) ?? []);
    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const top = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (top) setActiveCategory(top.target.id.replace('settings-category-', '') as SettingsCategoryId);
    }, { rootMargin: '-120px 0px -60% 0px' });
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [openCategories, query]);

  function discardDraft(): void {
    setDraft(settings);
    setCardFeedback({});
  }

  function toggleCategory(id: SettingsCategoryId): void {
    setOpenCategories((current) => ({ ...current, [id]: !current[id] }));
  }

  function jumpToCategory(id: SettingsCategoryId): void {
    setQuery('');
    setActiveCategory(id);
    setOpenCategories((current) => ({ ...current, [id]: true }));
    window.requestAnimationFrame(() => {
      document.getElementById(`settings-category-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  useEffect(() => {
    if (destination) jumpToCategory(destination.category);
  // A destination is an explicit navigation event, not a settings change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.nonce]);

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
        <UiButton
          type="button"
          className={`primary-button align-end card-save ${isDirty(groups) ? 'dirty' : ''}`}
          disabled={busy || !isDirty(groups) || pending || (groups.includes('shortcuts') && shortcutConflictList.length > 0)}
          onClick={() => void saveGroups(groups, feedbackKey)}
        >
          <Check size={16} />
          <span>{pending ? 'Saving' : label}</span>
        </UiButton>
        <FeedbackMessage feedback={cardFeedback[feedbackKey] ?? null} />
      </>
    );
  }

  return (
    <div className="page-view settings-view">
      <PageHeader
        title="Settings"
        detail={changed.length > 0 ? `${changed.length} card${changed.length === 1 ? '' : 's'} with unsaved changes: ${changed.map((group) => GROUP_LABELS[group]).join(' · ')}` : 'All changes saved'}
        actions={<>
          <label className="settings-search">
            <Search size={14} />
            <UiTextInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
              placeholder="Search settings"
              title="Search every setting: model, API key, token, open-pencil…"
              aria-label="Search settings"
            />
            {searching && <UiButton type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></UiButton>}
          </label>
          <UiButton type="button" className="secondary-button" disabled={busy || changed.length === 0} onClick={discardDraft}>
            <RotateCcw size={15} />
            <span>Discard</span>
          </UiButton>
          <UiButton
            type="button"
            className="primary-button"
            disabled={busy || changed.length === 0 || shortcutConflictList.length > 0 || cardFeedback.all?.kind === 'pending'}
            onClick={() => void saveGroups(SETTINGS_GROUP_NAMES, 'all')}
          >
            <Save size={15} />
            <span>{cardFeedback.all?.kind === 'pending' ? 'Saving everything' : 'Save all'}</span>
          </UiButton>
        </>}
      />
      <FeedbackMessage feedback={cardFeedback.all ?? null} />
      <div className="settings-sticky">
        <nav className="settings-category-nav" aria-label="Settings categories">
          {SETTINGS_CATEGORIES.map((category) => (
            <UiButton
              key={category.id}
              type="button"
              className={[openCategories[category.id] ? 'active' : '', !searching && activeCategory === category.id ? 'current' : ''].filter(Boolean).join(' ') || undefined}
              aria-current={!searching && activeCategory === category.id ? 'location' : undefined}
              onClick={() => jumpToCategory(category.id)}
            >
              <strong>{category.title}</strong>
              {category.detail && <small>{category.detail}</small>}
            </UiButton>
          ))}
        </nav>
      </div>
      <div className="settings-categories">
      <SettingsCategory
        id="general"
        icon={<Cpu size={17} />}
        title="General"
        detail="Defaults, team, editor, updates, and shortcuts"
        open={isOpen('general')}
        onToggle={() => toggleCategory('general')}
      >
      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title"><Cpu size={17} /><span>Agent defaults</span></div>
          <div className="field-grid">
            <SelectField label="Agent" value={draft.defaultAgent} onChange={(value) => setDraft({ ...draft, defaultAgent: value as AppSettings['defaultAgent'] })} options={['codex', 'claude', 'qwen', 'gemini', 'kimi']} />
            <SelectField label="Route" value={draft.defaultRoute} onChange={(value) => setDraft({ ...draft, defaultRoute: value as AppSettings['defaultRoute'] })} options={['direct', 'proxy']} />
            <SelectField label="Experience level" value={draft.experienceLevel} onChange={(value) => { const level = value as AppSettings['experienceLevel']; setDraft({ ...draft, experienceLevel: level, defaultAutonomy: experienceProfile(level).autonomy }); }} options={(Object.keys(EXPERIENCE_PROFILES) as AppSettings['experienceLevel'][]).map((level) => ({ value: level, label: EXPERIENCE_PROFILES[level].label }))} />
            <SelectField label="Autonomy" value={draft.defaultAutonomy} onChange={(value) => setDraft({ ...draft, defaultAutonomy: value as AppSettings['defaultAutonomy'] })} options={ACCESS_LEVELS.map((level) => ({ value: level.value, label: level.label }))} />
            <SelectField label="Theme" value={draft.theme} onChange={(value) => setDraft({ ...draft, theme: value as AppSettings['theme'] })} options={THEME_MODES.map((item) => ({ value: item.id, label: item.label }))} />
            <NumberField label="Log entries" value={draft.logRetentionEntries} min={100} max={100000} onChange={(value) => setDraft({ ...draft, logRetentionEntries: value })} />
          </div>
          <p className="settings-note">{experienceProfile(draft.experienceLevel).summary} Changing the level also resets the default access to match; you can still pick any access level per chat. {ACCESS_LEVELS.find((level) => level.value === draft.defaultAutonomy)?.description}</p>
          <label className="toggle-row"><span><strong>Diagnostics</strong><small>Store redacted local diagnostics</small></span><Checkbox checked={draft.diagnosticsEnabled} onChange={(event) => setDraft({ ...draft, diagnosticsEnabled: event.target.checked })} /></label>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>Colours</span></div>
            <ThemeColors theme={settings.theme} themeLabel={THEME_MODES.find((item) => item.id === settings.theme)?.label ?? settings.theme} />
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>CLI models</span></div>
            <p className="settings-note">The model each CLI agent is asked to use when Auto model has none for the job. Leave a field empty to keep that CLI's own default (for example the model in ~/.codex/config.toml).</p>
            <div className="field-grid">
              {(['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const).map((agent) => (
                <ModelField key={agent} label={`${agent} model`} value={draft.agentModels[agent] ?? ''} models={CLI_MODEL_SUGGESTIONS[agent]} emptyLabel="CLI default" onChange={(value) => setAgentModel(agent, value)} />
              ))}
            </div>
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>CLI API keys</span></div>
            <p className="settings-note">For when the subscription ends. Save an API key and switch it on, and that CLI runs on the key and is billed per token instead of using its own sign-in. The key stays in the OS vault and is handed to that one run only; the CLI's own config and sign-in are never changed. Leave the switch off to keep using the subscription. Runs routed through the Universal Proxy keep the proxy's own credentials.</p>
            {(['claude', 'codex', 'gemini', 'kimi'] as const).map((agent) => {
              const id = cliApiKeyCredentialId(agent);
              const stored = credentialStatus.ids.includes(id);
              const label = { claude: 'Claude Code (Anthropic key)', codex: 'Codex (OpenAI key)', gemini: 'Gemini CLI (Google key)', kimi: 'Kimi Code (Kimi Code or Moonshot key)' }[agent];
              return (
                <div key={agent} className="settings-subsection">
                  <NotificationToggle label={label} hint={stored ? 'A key is stored in the OS vault.' : 'No key stored yet. Save one to use this.'} checked={Boolean(draft.cliApiKeys[agent]) && stored} onChange={(use) => setCliApiKey(agent, use)} />
                  <div className="field-grid">
                    <TextField label={`${agent} API key`} value={cliKeyValues[agent] ?? ''} type="password" onChange={(value) => setCliKeyValues((current) => ({ ...current, [agent]: value }))} />
                  </div>
                  <div className="button-row align-start">
                    <UiButton type="button" className="secondary-button" disabled={!(cliKeyValues[agent] ?? '').trim() || !credentialStatus.available || busy} onClick={() => void saveNamedCredential(id, cliKeyValues[agent] ?? '', 'cli')}><KeyRound size={15} /><span>Save key</span></UiButton>
                    <UiButton type="button" className="secondary-button" disabled={busy || !stored} onClick={() => void clearNamedCredential(id, 'cli')}><Trash2 size={15} /><span>Remove key</span></UiButton>
                  </div>
                </div>
              );
            })}
            <FeedbackMessage feedback={credentialFeedback.cli} />
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>Auto model</span></div>
            <NotificationToggle label="Pick the model by the size of the job" hint="Small edits use a light model and design work a heavy one. A model you pick for a chat or a team role always wins. Direct CLI runs only." checked={draft.autoModel.enabled} onChange={(enabled) => setDraft({ ...draft, autoModel: { ...draft.autoModel, enabled } })} />
            {draft.autoModel.enabled && <div className="auto-model-grid">
              {(['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const).map((agent) => (
                <fieldset key={agent} className="auto-model-row">
                  <legend>{agent}</legend>
                  {WORK_LEVELS.map((level) => (
                    <ModelField key={level} label={WORK_LEVEL_LABEL[level]} value={draft.autoModel.tiers[agent]?.[level] ?? ''} models={CLI_MODEL_SUGGESTIONS[agent]} emptyLabel="Unchanged" onChange={(value) => setTierModel(agent, level, value)} />
                  ))}
                </fieldset>
              ))}
            </div>}
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-title"><span>Tray and notifications</span></div>
            <NotificationToggle label="Keep KAI running when the window closes" hint="Runs and scheduled goals continue in the system tray, and the phone console stays reachable. Quit from the tray menu. Off by default." checked={draft.notifications.trayEnabled} onChange={(trayEnabled) => setDraft({ ...draft, notifications: { ...draft.notifications, trayEnabled } })} />
            <NotificationToggle label="Start KAI when I sign in" hint="Only applies to an installed copy, not a development build." checked={draft.notifications.launchAtLogin} onChange={(launchAtLogin) => setDraft({ ...draft, notifications: { ...draft.notifications, launchAtLogin } })} />
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

        <section className="settings-section span-two" aria-label="Project automation">
          <div className="section-title"><Wand2 size={17} /><span>Project automation</span></div>
          <ProjectAutomation project={activeProject} automation={projectAutomation} onSaveAutomation={onSaveProjectAutomation} busy={busy} />
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
          <NotificationToggle
            label="Format on save"
            hint="Prettier for JS, TS, React, HTML, CSS, JSON, Markdown and YAML (built in); Format can install Ruff for Python; Black, gofmt, rustfmt and clang-format work when installed"
            checked={draft.editor.formatOnSave}
            onChange={(formatOnSave) => setDraft((current) => ({ ...current, editor: { ...current.editor, formatOnSave } }))}
          />
          <NotificationToggle
            label="File type icons"
            hint="A distinct icon for each kind of file and folder in the file trees, tabs and change lists"
            checked={draft.editor.fileIcons}
            onChange={(fileIcons) => setDraft((current) => ({ ...current, editor: { ...current.editor, fileIcons } }))}
          />
          <NotificationToggle
            label="Bracket pair colours"
            hint="Matching brackets share a colour, nested ones differ"
            checked={draft.editor.bracketColors}
            onChange={(bracketColors) => setDraft((current) => ({ ...current, editor: { ...current.editor, bracketColors } }))}
          />
          <NotificationToggle
            label="Indent and bracket guides"
            hint="Vertical lines that show nesting and link a bracket to its partner"
            checked={draft.editor.guides}
            onChange={(guides) => setDraft((current) => ({ ...current, editor: { ...current.editor, guides } }))}
          />
          <NotificationToggle
            label="Sticky scroll"
            hint="Keeps the enclosing function or class pinned at the top while you scroll"
            checked={draft.editor.stickyScroll}
            onChange={(stickyScroll) => setDraft((current) => ({ ...current, editor: { ...current.editor, stickyScroll } }))}
          />
          <NotificationToggle
            label="Error Lens"
            hint="Shows each error or warning message at the end of its line"
            checked={draft.editor.errorLens}
            onChange={(errorLens) => setDraft((current) => ({ ...current, editor: { ...current.editor, errorLens } }))}
          />
          <NotificationToggle
            label="Inline Git blame"
            hint="Faint “who changed this, and when” text on the line your cursor is on"
            checked={draft.editor.gitBlame}
            onChange={(gitBlame) => setDraft((current) => ({ ...current, editor: { ...current.editor, gitBlame } }))}
          />
          <NotificationToggle
            label="Highlight TODO and FIXME"
            hint="Colours TODO, FIXME, HACK, BUG and NOTE markers inside comments"
            checked={draft.editor.todoHighlight}
            onChange={(todoHighlight) => setDraft((current) => ({ ...current, editor: { ...current.editor, todoHighlight } }))}
          />
          <NotificationToggle
            label="Colour swatches"
            hint="A small swatch beside colour values such as #ff8800, with a picker"
            checked={draft.editor.colorSwatches}
            onChange={(colorSwatches) => setDraft((current) => ({ ...current, editor: { ...current.editor, colorSwatches } }))}
          />
          <NotificationToggle
            label="Rename paired tags together"
            hint="Editing an HTML or JSX opening tag edits its closing tag"
            checked={draft.editor.linkedTagEditing}
            onChange={(linkedTagEditing) => setDraft((current) => ({ ...current, editor: { ...current.editor, linkedTagEditing } }))}
          />
          <NotificationToggle
            label="Inline hints"
            hint="Parameter names and inferred types shown inside the code, where the language supports it"
            checked={draft.editor.inlayHints}
            onChange={(inlayHints) => setDraft((current) => ({ ...current, editor: { ...current.editor, inlayHints } }))}
          />
          <NotificationToggle
            label="Font ligatures"
            hint="Draws sequences like =>, !== and >= as single symbols (needs Cascadia Code, Fira Code or JetBrains Mono)"
            checked={draft.editor.ligatures}
            onChange={(ligatures) => setDraft((current) => ({ ...current, editor: { ...current.editor, ligatures } }))}
          />
          <NotificationToggle
            label="Smooth scrolling and cursor"
            hint="Animates scrolling and the caret"
            checked={draft.editor.smoothScrolling}
            onChange={(smoothScrolling) => setDraft((current) => ({ ...current, editor: { ...current.editor, smoothScrolling } }))}
          />
          <NotificationToggle
            label="Minimap"
            hint="A zoomed-out map of the file along the right edge"
            checked={draft.editor.minimap}
            onChange={(minimap) => setDraft((current) => ({ ...current, editor: { ...current.editor, minimap } }))}
          />
          <NotificationToggle
            label="Wrap long lines"
            hint="Wraps lines at the edge of the editor instead of scrolling sideways"
            checked={draft.editor.wordWrap}
            onChange={(wordWrap) => setDraft((current) => ({ ...current, editor: { ...current.editor, wordWrap } }))}
          />
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

      </div>
      </SettingsCategory>

      <SettingsCategory
        id="connections"
        icon={<Cloud size={17} />}
        title="Connections and models"
        detail="Providers, API keys, MCP servers, and credentials"
        open={isOpen('connections')}
        onToggle={() => toggleCategory('connections')}
      >
      <div className="settings-grid">
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

        <AgentConfigImportCard />

        <ProviderConnectionSection
          title="Prompt Guide"
          icon={<Wand2 size={17} />}
          detail="Turns a rough idea into a clear goal, the questions still open, and one prompt per teammate, from the Auto team card on Workflows. A small, cheap model is enough. It reads the project but never changes it."
          toggleLabel="Enable the Prompt Guide"
          toggleHint={isLocalProvider(draft.promptGuide.provider) ? 'Uses the LM Studio server on this computer; no key needed' : 'Uses its own provider and OS-vault credential'}
          enabled={draft.promptGuide.enabled}
          provider={draft.promptGuide.provider}
          model={draft.promptGuide.model}
          baseUrl={draft.promptGuide.baseUrl}
          credentialId={draft.promptGuide.credentialId}
          models={guideModels}
          catalog={providerModels.guide}
          modelFeedback={modelFeedback.guide}
          refreshingModels={refreshingModels === 'guide'}
          credentialValue={guideCredentialValue}
          credentialStored={credentialStatus.ids.includes(draft.promptGuide.credentialId)}
          credentialFeedback={credentialFeedback.guide}
          busy={busy}
          saveSlot={cardSave('promptGuide', 'Save Prompt Guide settings', ['promptGuide'])}
          onEnabledChange={(enabled) => setDraft({ ...draft, promptGuide: { ...draft.promptGuide, enabled } })}
          onProviderChange={(provider) => updateLearningProvider(provider, 'guide')}
          onModelChange={(model) => setDraft({ ...draft, promptGuide: { ...draft.promptGuide, model } })}
          onBaseUrlChange={(baseUrl) => setDraft({ ...draft, promptGuide: { ...draft.promptGuide, baseUrl } })}
          onCredentialIdChange={(id) => setDraft({ ...draft, promptGuide: { ...draft.promptGuide, credentialId: id } })}
          onCredentialValueChange={setGuideCredentialValue}
          onRefreshModels={() => void refreshProviderModels('guide')}
          onSaveKey={() => void saveProviderKey('guide')}
          onClearKey={() => void clearProviderCredential('guide')}
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
          <div className="section-title"><Search size={17} /><span>Web search</span></div>
          <p className="settings-note">Search and page reading for Direct API runs. This is separate from the model provider: an external source works with any model, and a native source uses that provider's key. Claude Code and Codex use their own web tools.</p>
          <NotificationToggle
            label="Allow API runs to search the web"
            hint="The agent can look up current information and cite the pages it used."
            checked={webSearch.enabled}
            onChange={(enabled) => setDraft({ ...draft, webSearch: { ...webSearch, enabled } })}
          />
          <NotificationToggle
            label="Allow API runs to read a page"
            hint="Fetches one public http or https address and returns its text. Free, and needs no search service."
            checked={webSearch.fetchEnabled}
            onChange={(fetchEnabled) => setDraft({ ...draft, webSearch: { ...webSearch, fetchEnabled } })}
          />
          <div className="field-grid">
            <SelectField
              label="Source"
              value={webSearch.source}
              options={WEB_SEARCH_SOURCES.map((source) => ({ value: source, label: WEB_SEARCH_SOURCE_LABEL[source] }))}
              onChange={(value) => setDraft({ ...draft, webSearch: { ...webSearch, source: value as AppSettings['webSearch']['source'] } })}
            />
            {webSearch.source === 'searxng' && (
              <TextField
                label="SearXNG address"
                value={webSearch.endpoint}
                onChange={(endpoint) => setDraft({ ...draft, webSearch: { ...webSearch, endpoint } })}
              />
            )}
            <TextField
              label="Credential override (blank reuses the provider key)"
              value={webSearch.credentialId}
              onChange={(credentialId) => setDraft({ ...draft, webSearch: { ...webSearch, credentialId } })}
            />
            <NumberField label="Results per search" value={webSearch.results} min={1} max={10} onChange={(results) => setDraft({ ...draft, webSearch: { ...webSearch, results } })} />
            <NumberField label="Max searches per run" value={webSearch.maxSearchesPerRun} min={1} max={50} onChange={(maxSearchesPerRun) => setDraft({ ...draft, webSearch: { ...webSearch, maxSearchesPerRun } })} />
            <NumberField label="Max page reads per run" value={webSearch.maxFetchesPerRun} min={1} max={50} onChange={(maxFetchesPerRun) => setDraft({ ...draft, webSearch: { ...webSearch, maxFetchesPerRun } })} />
            <NumberField label="Timeout (ms)" value={webSearch.timeoutMs} min={1_000} max={60_000} step={1_000} onChange={(timeoutMs) => setDraft({ ...draft, webSearch: { ...webSearch, timeoutMs } })} />
          </div>
          <p className={`settings-note ${searchCredential ? 'ready' : ''}`}>
            {webSearch.source === 'searxng'
              ? 'SearXNG needs no key. It must be running and allow JSON results (search.formats: [html, json]).'
              : `Key: ${searchCredential}${credentialStatus.ids.includes(searchCredential) ? ' (stored in the OS vault)' : ' (not stored yet)'}. Native search is billed per call by that provider (DeepSeek $0.75 per 1,000 searches from November 1; Moonshot about $0.002 per search). Choose SearXNG for free local search, or Brave/Tavily on their free tiers.`}
          </p>
          {webSearch.source !== 'searxng' && (
            <div className="credential-form">
              <TextField label="Search API key" value={searchCredentialValue} type="password" onChange={setSearchCredentialValue} />
              <div className="button-row align-start">
                <UiButton
                  type="button"
                  className="secondary-button"
                  disabled={!searchCredentialValue.trim() || !credentialStatus.available || busy}
                  onClick={() => void saveNamedCredential(searchCredential, searchCredentialValue, 'search')}
                >
                  <KeyRound size={15} />
                  <span>Save search key</span>
                </UiButton>
                <UiButton
                  type="button"
                  className="secondary-button"
                  disabled={busy || !credentialStatus.ids.includes(searchCredential)}
                  onClick={() => void clearNamedCredential(searchCredential, 'search')}
                >
                  <Trash2 size={15} />
                  <span>Remove key</span>
                </UiButton>
              </div>
            </div>
          )}
          <FeedbackMessage feedback={credentialFeedback.search} />
          <div className="button-row align-start">
            <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => void testWebSearchConnection()}>
              <Search size={15} />
              <span>Test search source</span>
            </UiButton>
          </div>
          {searchTest && <FeedbackMessage feedback={searchTest} />}
          {searchTest && searchTest.titles.length > 0 && (
            <ul className="settings-note">
              {searchTest.titles.map((title) => <li key={title}>{title}</li>)}
            </ul>
          )}
          {cardSave('webSearch', 'Save web search settings', ['webSearch'])}
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Plug size={17} /><span>MCP servers</span></div>
          <p className="settings-note">Connect local stdio or remote Streamable HTTP MCP servers to API mode. Secrets stay in the OS vault; the settings file stores credential IDs only.</p>
          <div className="mcp-server-list">
            {draft.mcpServers.map((server, index) => (
              <div className="mcp-server-row" key={server.id}>
                <div className="mcp-server-head">
                  <label className="mcp-enable"><Checkbox checked={server.enabled} onChange={(event) => updateMcpServer(index, { enabled: event.target.checked })} /><span>{server.enabled ? 'Enabled' : 'Disabled'}</span></label>
                  <UiButton type="button" className="icon-button compact" aria-label={`Remove ${server.name}`} onClick={() => setDraft({ ...draft, mcpServers: draft.mcpServers.filter((item) => item.id !== server.id) })}><Trash2 size={14} /></UiButton>
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
          {connectorCatalog.length > 0 && (
            <div className="field-grid">
              <SelectField
                label="Ready-made connector"
                value={connectorChoice}
                options={connectorCatalog.map((entry) => ({ value: entry.id, label: `${entry.name} — ${entry.description}` }))}
                onChange={setConnectorChoice}
              />
              <div className="button-row align-start">
                <UiButton type="button" className="secondary-button" disabled={!connectorChoice || busy} onClick={() => void addConnectorFromCatalog()}><Plus size={15} /><span>Add from catalog</span></UiButton>
              </div>
            </div>
          )}
          {connectorMessage && <p className="settings-note">{connectorMessage}</p>}
          <div className="button-row align-start">
            <UiButton type="button" className="secondary-button" onClick={() => setDraft({ ...draft, mcpServers: [...draft.mcpServers, newMcpServer('stdio')] })}><Plus size={15} /><span>Add local server</span></UiButton>
            <UiButton type="button" className="secondary-button" onClick={() => setDraft({ ...draft, mcpServers: [...draft.mcpServers, newMcpServer('http')] })}><Plus size={15} /><span>Add remote server</span></UiButton>
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
              <UiButton type="button" className="primary-button" disabled={!credentialValue.trim() || !credentialStatus.available || busy} onClick={() => void saveNamedCredential(credentialId, credentialValue, 'generic')}><KeyRound size={15} /><span>Save credential</span></UiButton>
              <UiButton type="button" className="secondary-button" disabled={busy || !credentialStatus.ids.includes(credentialId)} onClick={() => void clearNamedCredential(credentialId, 'generic')}><Trash2 size={15} /><span>Remove</span></UiButton>
            </div>
          </div>
          <FeedbackMessage feedback={credentialFeedback.generic} />
        </section>

      </div>
      </SettingsCategory>

      <SettingsCategory
        id="design"
        icon={<PenTool size={17} />}
        title="Design tools"
        detail="The open-pencil connection for drawing and pulling screens"
        open={isOpen('design')}
        onToggle={() => toggleCategory('design')}
      >
        <div className="settings-grid">
          <OpenPencilCard />
        </div>
      </SettingsCategory>

      <SettingsCategory
        id="services"
        icon={<ServerCog size={17} />}
        title="Services and access"
        detail="C1 Brain, Universal Proxy, and remote access"
        open={isOpen('services')}
        onToggle={() => toggleCategory('services')}
      >
      <div className="settings-grid">
        <section className="settings-section span-two">
          <div className="section-title"><ServerCog size={17} /><span>Managed services</span></div>
          <div className="service-settings-grid">
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>C1 Brain</strong><small>Run the pinned Cognitive1 daemon locally</small></span>
                <Checkbox checked={draft.cognitive1.enabled} onChange={(event) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, enabled: event.target.checked } })} />
              </label>
              <ServiceStatusLine kind="cognitive1" service={serviceState('cognitive1')} busy={busy} onStart={() => onControlService('cognitive1', 'start')} onRestart={() => onControlService('cognitive1', 'restart')} />
              <div className="field-grid">
                <TextField label="Endpoint" value={draft.cognitive1.endpoint} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, endpoint: value } })} />
                <TextField label="Brain data path" value={draft.cognitive1.dataPath ?? ''} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, dataPath: value || null } })} />
              </div>
              <div className="settings-subsection">
                <div className="settings-subsection-title"><Database size={14} /><span>Second brain</span></div>
                <label className="toggle-row">
                  <span><strong>Mirror every lesson</strong><small>Files each lesson into another Cognitive1 daemon as well, such as the standalone one on port 9876 that commits and pushes its brain on a timer. Reads and sessions stay with KAI's own daemon.</small></span>
                  <Checkbox checked={draft.cognitive1.mirror.enabled} onChange={(event) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, mirror: { ...draft.cognitive1.mirror, enabled: event.target.checked } } })} />
                </label>
                <div className="field-grid">
                  <TextField label="Mirror endpoint" value={draft.cognitive1.mirror.endpoint} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, mirror: { ...draft.cognitive1.mirror, endpoint: value } } })} />
                  <TextField label="Mirror token" value={draft.cognitive1.mirror.token} onChange={(value) => setDraft({ ...draft, cognitive1: { ...draft.cognitive1, mirror: { ...draft.cognitive1.mirror, token: value } } })} />
                </div>
                <small className="settings-subsection-note">The standalone daemon needs no token. KAI keeps the two level every fifteen minutes; “Sync the mirror now” on the C1 Brain page forces a pass early.</small>
              </div>
              <div className="settings-subsection">
                <div className="settings-subsection-title"><ShieldCheck size={14} /><span>AI Overwatch</span></div>
                <label className="toggle-row">
                  <span><strong>Enable Overwatch</strong><small>Runs brain quality audits, draft classification, duplicate detection, and kernel distillation</small></span>
                  <Checkbox
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
                    <UiButton
                      type="button"
                      className="secondary-button"
                      disabled={!overwatchCredentialValue.trim() || !credentialStatus.available || busy}
                      onClick={() => void saveNamedCredential(draft.cognitive1.overwatch.credentialId, overwatchCredentialValue, 'overwatch')}
                    >
                      <KeyRound size={15} />
                      <span>Save Overwatch key</span>
                    </UiButton>
                    <UiButton
                      type="button"
                      className="secondary-button"
                      disabled={busy || !overwatchCredentialReady}
                      onClick={() => void clearNamedCredential(draft.cognitive1.overwatch.credentialId, 'overwatch')}
                    >
                      <Trash2 size={15} />
                      <span>Remove key</span>
                    </UiButton>
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
                <UiButton type="button" className="secondary-button" disabled={busy} onClick={onImportBrain}>
                  <FolderInput size={15} />
                  <span>Import existing brain</span>
                </UiButton>
                <span className="settings-note">Copies missing brain entries from another Cognitive1 folder and reloads C1.</span>
              </div>
              {cardSave('cognitive1', 'Save C1 settings', ['cognitive1'])}
            </div>
            <div className="service-setting">
              <label className="toggle-row">
                <span><strong>Universal Proxy</strong><small>Run the pinned proxy on loopback only</small></span>
                <Checkbox checked={draft.proxy.enabled} onChange={(event) => setDraft({ ...draft, proxy: { ...draft.proxy, enabled: event.target.checked } })} />
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

        <RemoteAccessPanel settings={settings} onSave={onSave} busy={busy} />

      </div>
      </SettingsCategory>

      <SettingsCategory
        id="data"
        icon={<Database size={17} />}
        title="Data and diagnostics"
        detail="Locations, backups, and recent logs"
        open={isOpen('data')}
        onToggle={() => toggleCategory('data')}
      >
      <div className="settings-grid">
        <section className="settings-section span-two">
          <div className="section-title"><Database size={17} /><span>Data locations</span></div>
          <div className="location-list">{dataLocations.map((location) => <div key={location.kind} className="location-row"><span>{location.label}</span><code>{location.path}</code></div>)}</div>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Database size={17} /><span>Local agent experience capture</span></div>
          <p className="settings-note">Optional Cognitive1 training-data foundation. Records stay on this device, redact common secret formats, and never include hidden model reasoning. Content is excluded unless you explicitly enable it.</p>
          <label className="toggle-row"><Checkbox checked={draft.experienceCapture.enabled} onChange={(event) => setDraft({ ...draft, experienceCapture: { ...draft.experienceCapture, enabled: event.target.checked } })} /><span>Collect run outcomes and verification metadata locally</span></label>
          <label className="toggle-row"><Checkbox checked={draft.experienceCapture.includeContent} disabled={!draft.experienceCapture.enabled} onChange={(event) => setDraft({ ...draft, experienceCapture: { ...draft.experienceCapture, includeContent: event.target.checked } })} /><span>Include redacted request, response, and code diffs for later curation</span></label>
          <label className="field"><span>Retention (days)</span><UiTextInput type="number" min={1} max={3650} value={draft.experienceCapture.retentionDays} onChange={(event) => setDraft({ ...draft, experienceCapture: { ...draft.experienceCapture, retentionDays: Math.max(1, Math.min(3650, Number(event.target.value) || 1)) } })} /></label>
          {cardSave('experienceCapture', 'Save experience capture settings', ['experienceCapture'])}
          <div className="backup-create-row"><span>{experienceCount} local run records</span><UiButton type="button" className="secondary-button" disabled={!experienceCount} onClick={() => void exportExperiences()}><Archive size={14} />Export JSONL</UiButton><UiButton type="button" className="secondary-button danger-button" disabled={!experienceCount} onClick={() => void clearExperiences()}><Trash2 size={14} />Delete all</UiButton></div>
          {experienceMessage && <p className="settings-note" role="status">{experienceMessage}</p>}
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><Archive size={17} /><span>Configuration backups</span></div>
          <p className="settings-note">Snapshot KAI settings and project permissions before changing models, providers, MCP servers, or service routing.</p>
          {backupError && <div className="workbench-error" role="alert">{backupError}</div>}
          <div className="backup-create-row">
            <label className="field"><span>Backup name</span><UiTextInput value={backupName} onChange={(event) => setBackupName(event.target.value)} placeholder="Optional label" /></label>
            <UiButton type="button" className="primary-button" disabled={busy} onClick={() => void createBackup()}><Archive size={15} /><span>Create backup</span></UiButton>
            <UiButton type="button" className="secondary-button" disabled={busy || backupsLoading} onClick={() => void refreshBackups()}><RefreshCw size={15} className={backupsLoading ? 'spin' : undefined} /><span>Refresh</span></UiButton>
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
                  <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => void restoreBackup(backup)}><ArchiveRestore size={14} /><span>Restore</span></UiButton>
                  <UiButton type="button" className="icon-button danger-button" disabled={busy} aria-label={`Delete ${backup.name}`} onClick={() => void deleteBackup(backup)}><Trash2 size={14} /></UiButton>
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
      </SettingsCategory>
      </div>
    </div>
  );
}

function AgentConfigImportCard(): ReactNode {
  const [previews, setPreviews] = useState<AgentConfigImportPreview[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState<'codex' | 'claude' | null>(null);

  const refresh = (): void => {
    void window.kaiDesktop.agentConfigImportPreview().then((response) => {
      if (response.ok) setPreviews(response.data);
      else setMessage(response.error.message);
    });
  };

  useEffect(() => { refresh(); }, []);

  async function importModel(agent: 'codex' | 'claude'): Promise<void> {
    setWorking(agent);
    setMessage(null);
    try {
      const response = await window.kaiDesktop.importAgentConfig(agent);
      if (!response.ok) throw new Error(response.error.message);
      setMessage(`Imported ${response.data.model} as KAI's ${agent} CLI model preference. A KAI backup was created first.`);
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The preference could not be imported.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="settings-section span-two" aria-label="Import agent preferences">
      <div className="section-title"><FolderInput size={17} /><span>Import local agent preferences</span></div>
      <p className="settings-note">KAI can copy the selected CLI model from local Codex or Claude Code settings. It previews first, creates a KAI backup, and never imports account sessions, API keys, permissions, or MCP connections.</p>
      <div className="import-agent-list">
        {previews.map((preview) => (
          <div className="vault-state" key={preview.agent}>
            <Cpu size={17} />
            <div><strong>{preview.agent === 'codex' ? 'Codex' : 'Claude Code'}</strong><small>{preview.detail}</small></div>
            {preview.model && <code>{preview.model}</code>}
            <UiButton type="button" className="secondary-button" disabled={!preview.model || working !== null} onClick={() => void importModel(preview.agent)}>
              <FolderInput size={14} /><span>{working === preview.agent ? 'Importing…' : 'Import model'}</span>
            </UiButton>
          </div>
        ))}
      </div>
      {message && <p className="settings-note">{message}</p>}
    </section>
  );
}

function SettingsCategory({ id, icon, title, detail, open, onToggle, children }: {
  id: SettingsCategoryId;
  icon: ReactNode;
  title: string;
  detail: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  const bodyId = `settings-category-body-${id}`;
  return (
    <section id={`settings-category-${id}`} className={`settings-category${open ? ' open' : ''}`}>
      <UiButton type="button" className="settings-category-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="settings-category-icon">{icon}</span>
        <span className="settings-category-copy"><strong>{title}</strong><small>{detail}</small></span>
        <ChevronDown size={17} className="settings-category-chevron" />
      </UiButton>
      {open && <div id={bodyId} className="settings-category-body">{children}</div>}
    </section>
  );
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
        <UiButton type="button" className="secondary-button compact" disabled={busy} onClick={running ? onRestart : onStart}>
          {running ? <RefreshCw size={14} /> : <Play size={14} />}
          <span>{running ? 'Restart' : 'Start'}</span>
        </UiButton>
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
      <label className="toggle-row"><span><strong>{toggleLabel}</strong><small>{toggleHint}</small></span><Checkbox checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} /></label>
      <div className="field-grid">
        <SelectField label="Provider" value={provider} onChange={(value) => onProviderChange(value as AppSettings['directApi']['provider'])} options={DIRECT_PROVIDER_ORDER.map((id) => ({ value: id, label: directProviderPreset(id).displayName }))} />
        <ModelField label="Model" value={model} models={models} onChange={onModelChange} />
        <TextField label="Base URL" value={baseUrl} onChange={onBaseUrlChange} />
        <TextField label="Credential ID" value={credentialId} onChange={onCredentialIdChange} />
      </div>
      <div className="button-row align-start">
        <UiButton type="button" className="secondary-button" disabled={busy || refreshingModels} onClick={onRefreshModels}>
          <RefreshCw size={15} className={refreshingModels ? 'spin' : undefined} />
          <span>{refreshingModels ? 'Refreshing models' : 'Refresh models'}</span>
        </UiButton>
        <span className="settings-note">
          {catalog?.source === 'live'
            ? `${catalog.models.length} ${local ? 'models on this computer' : 'live provider models'}. Refreshed ${formatRefreshTime(catalog.fetchedAt)}.`
            : local
              ? 'Refresh lists the models you have downloaded in LM Studio.'
              : 'Bundled model list, which can be out of date. Save a key, then Refresh to load every model your key can use. Refresh uses the stored credential without exposing it.'}
        </span>
      </div>
      <FeedbackMessage feedback={modelFeedback} />
      {local && <p className="settings-note local-provider-note">Runs on your computer, so there is no key and nothing is billed. In LM Studio open the Developer tab, start the local server and load a model (for example Qwen2.5 Coder), then refresh here. Only add a key below if you switched on API-token protection in LM Studio.</p>}
      <div className="credential-form">
        <TextField label={local ? 'API key (optional)' : 'API key'} value={credentialValue} type="password" onChange={onCredentialValueChange} />
        <div className="button-row align-start">
          <UiButton type="button" className="secondary-button" disabled={!credentialValue.trim() || !vaultAvailable || busy} onClick={onSaveKey}>
            <KeyRound size={15} />
            <span>Save key and use provider</span>
          </UiButton>
          <UiButton type="button" className="secondary-button" disabled={busy || !credentialStored} onClick={onClearKey}>
            <Trash2 size={15} />
            <span>Remove key</span>
          </UiButton>
        </div>
        <span className="settings-note credential-note">{credentialStored ? 'Credential stored in the OS vault.' : local ? 'No key stored, which is fine for a local server.' : 'No credential stored for this ID.'}</span>
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
  return <label className="toggle-row"><span><strong>{label}</strong><small>{hint}</small></span><Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><Select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => {
    const item = typeof option === 'string' ? { value: option, label: option } : option;
    return <option key={item.value} value={item.value}>{item.label}</option>;
  })}</Select></label>;
}

function TextField({ label, value, type = 'text', list, onChange }: { label: string; value: string; type?: string; list?: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><UiTextInput type={type} list={list} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

/**
 * A number the settings schema bounds. The input's own min and max are only hints, so a typed 20 in a field that stops at
 * 10 went straight into the draft and the whole save was refused with nothing pointing at the field. A value inside the
 * range is taken as it is typed; one outside it waits until the field is left and is then brought back to the nearest
 * limit, so typing "1500" in a field that starts at 1000 is not cut off at "1".
 */
function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const clamp = (raw: number): number => Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min));
  return <label className="field"><span>{label}</span><UiTextInput
    type="number"
    value={text ?? value}
    min={min}
    max={max}
    step={step}
    onChange={(event) => {
      const raw = event.target.value;
      setText(raw);
      const parsed = Number(raw);
      if (raw !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
    }}
    onBlur={() => {
      if (text === null) return;
      onChange(clamp(Number(text)));
      setText(null);
    }}
  /></label>;
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><Textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} /></label>;
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
