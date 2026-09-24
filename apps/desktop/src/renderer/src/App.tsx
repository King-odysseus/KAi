import { AlertTriangle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type {
  AgentCapability,
  AgentId,
  AutonomyMode,
  BootstrapPayload,
  CheckpointReview,
  CompareRun,
  ConfigBackup,
  ConversationRecord,
  ContextPreview,
  CredentialStatus,
  DirectApiCapability,
  ExecutionMode,
  LogEntry,
  ProjectPreferences,
  RecoveryResume,
  RouteMode,
  SettingsUpdate,
  SetupCheck,
  SetupStatus,
} from '@kai/contracts';
import { THEME_MODES } from '@kai/contracts';
import { CommandPalette, ConversationSidebar, NavigationRail, TitleBar, type CommandPaletteItem } from './components/Chrome';
import { HistoryView, ProjectsView, ServiceView, WorkflowsView } from './components/Pages';
import { Cognitive1Panel } from './components/Cognitive1Panel';
import { ProxyPanel } from './components/ProxyView';
import { RulesView } from './components/RulesView';
import { SettingsView } from './components/SettingsView';
import { CodeView } from './components/CodeView';
import { GitView } from './components/GitView';
import { TasksView } from './components/TasksView';
import { TerminalView } from './components/TerminalView';
import { PreviewView } from './components/PreviewView';
import { UrgentBanner } from './components/CoordinationPanel';
import { UpdateBanner } from './components/UpdatesPanel';
import { OperationsView, type OperationsTab } from './components/OperationsView';
import { UsageView } from './components/UsageView';
import {
  ContextPanel,
  WorkspaceView,
  type WorkspaceSendOptions,
  type WorkspaceCommandKind,
  type WorkspaceCommandRequest,
} from './components/Workspace';
import { clamp, unwrap, type ViewId } from './types';
import { confirmDialog, DialogHost } from './components/AppDialog';
import { shouldHandleAgentEvent } from './agent-events';
import { SetupPanel } from './components/SetupPanel';
import { ShortcutSheet } from './components/ShortcutSheet';
import { matchingShortcutAction, shortcutLabel, shortcutsWithDefaults } from './shortcuts';

const emptyCredentials: CredentialStatus = { available: false, ids: [] };

interface PendingApproval {
  conversationId: string;
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  tool?: string;
}

export function App(): ReactNode {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus>(emptyCredentials);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapability[]>([]);
  const [directApiCapability, setDirectApiCapability] = useState<DirectApiCapability | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreview | null>(null);
  const [contextPreviewLoading, setContextPreviewLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('codex');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('cli');
  const [selectedRoute, setSelectedRoute] = useState<RouteMode>('direct');
  const [selectedAutonomy, setSelectedAutonomy] = useState<AutonomyMode>('ask');
  const [view, setView] = useState<ViewId>('workspace');
  const [interruptedRuns, setInterruptedRuns] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(() => {
    try {
      return window.localStorage.getItem('kai.previewOpen') === 'true';
    } catch {
      return false;
    }
  });
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      return clamp(Number(window.localStorage.getItem('kai.terminalHeight')) || 260, 140, 700);
    } catch {
      return 260;
    }
  });
  const [modelChoices, setModelChoices] = useState<Record<string, string>>({});
  const [contextOpen, setContextOpen] = useState(() => {
    try {
      return window.localStorage.getItem('kai.contextOpen') === 'true';
    } catch {
      return false;
    }
  });
  const [threadsOpen, setThreadsOpen] = useState(() => {
    try {
      return window.localStorage.getItem('kai.threadsOpen') === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      return clamp(Number(window.localStorage.getItem('kai.sidebarWidth')) || 248, 190, 480);
    } catch {
      return 248;
    }
  });
  const [contextWidth, setContextWidth] = useState(() => {
    try {
      return clamp(Number(window.localStorage.getItem('kai.contextWidth')) || 286, 230, 560);
    } catch {
      return 286;
    }
  });
  const [previewWidth, setPreviewWidth] = useState(() => {
    try {
      return clamp(Number(window.localStorage.getItem('kai.previewWidth')) || 460, 340, 760);
    } catch {
      return 460;
    }
  });
  const [resizing, setResizing] = useState<'sidebar' | 'context' | 'preview' | null>(null);
  const [busy, setBusy] = useState('Starting KAI');
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null);
  const [runPaused, setRunPaused] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const [workspaceCommand, setWorkspaceCommand] = useState<WorkspaceCommandRequest | null>(null);
  const [operationsTab, setOperationsTab] = useState<OperationsTab>('recovery');
  const started = useRef(false);
  const commandNonce = useRef(0);
  const resizeOrigin = useRef<{ kind: 'sidebar' | 'context' | 'preview'; x: number; width: number } | null>(null);
  const runningConversationIdRef = useRef<string | null>(null);
  const shortcutsRef = useRef(bootstrap?.settings.shortcuts ?? {});
  const shortcutSheetOpenRef = useRef(false);
  const pendingApproval = pendingApprovals[0] ?? null;
  runningConversationIdRef.current = runningConversationId;
  shortcutsRef.current = bootstrap?.settings.shortcuts ?? {};
  shortcutSheetOpenRef.current = shortcutSheetOpen;

  const activeProject = bootstrap?.projects.find((project) => project.id === bootstrap.activeProjectId) ?? null;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const shortcuts = shortcutsWithDefaults(bootstrap?.settings.shortcuts ?? {});
  const commandItems: CommandPaletteItem[] = [
    { id: 'workbench', label: 'Open Agent Workbench', description: 'Return to the active conversation and composer', shortcut: shortcutLabel(shortcuts, 'workbench'), run: () => setView('workspace') },
    { id: 'new-window', label: 'New Window', description: 'Open another independent KAI project window', shortcut: shortcutLabel(shortcuts, 'new-window'), run: () => void openNewWindow() },
    { id: 'goal', label: 'Start or Edit Goal', description: 'Define the outcome, constraints, and verification', run: () => openWorkspaceCommand('goal') },
    { id: 'skills', label: 'Browse Skills', description: 'Add a project or personal skill to the next run', run: () => openWorkspaceCommand('skills') },
    { id: 'selection', label: 'Add Selection to Chat', description: 'Attach a referenced file and line range as context', run: () => openWorkspaceCommand('context') },
    { id: 'checkpoint', label: 'Review Latest Turn Changes', description: 'Open the checkpoint viewer for the newest captured turn', run: () => openWorkspaceCommand('checkpoint') },
    { id: 'raw', label: 'Inspect Raw Fallback Events', description: 'Review and copy raw diagnostic payloads', run: () => openWorkspaceCommand('raw') },
    { id: 'compact-context', label: 'Compact Conversation Context', description: 'Summarize older turns and keep only the active tail in model context', run: () => void compactActiveConversation() },
    { id: 'handoff', label: 'Handoff to Another Agent', description: 'Start a handoff prompt in the active conversation', run: () => openWorkspaceCommand('handoff') },
    { id: 'rules', label: 'View and Edit Execution Rules', description: 'Manage the authoritative rules injected into agent runs', run: () => setView('rules') },
    { id: 'brain', label: 'Open C1 Brain', description: 'Search, inspect, and maintain the shared brain', run: () => setView('brain') },
    { id: 'proxy', label: 'Open Universal Proxy', description: 'Show proxy status, activity, health, history, and costs', run: () => setView('proxy') },
    { id: 'workflows', label: 'Open Workflows', description: 'Build, save, and run sequential agent work', run: () => setView('workflows') },
    { id: 'history', label: 'Open Conversation History', description: 'Search, rename, archive, fork, and reopen threads', run: () => setView('history') },
    { id: 'usage', label: 'Open Usage and Budgets', description: 'See estimated API spend and set warn or block limits', run: () => setView('usage') },
    { id: 'operations-recovery', label: 'Open Recovery (interrupted runs)', description: 'Resume or discard runs interrupted by a crash or close', run: () => openOperations('recovery') },
    { id: 'code', label: 'Open Code Editor', description: 'Browse and edit project files with the built-in editor', run: () => setView('code') },
    { id: 'preview', label: 'Toggle Live Preview Pane', description: 'Run the project, inspect rendered elements, and capture browser errors', run: () => setPreviewOpen((open) => !open) },
    { id: 'tasks', label: 'Open Tasks, Reviews and Handoffs', description: 'Shared task board, review queue, handoff inbox and decision log', run: () => setView('tasks') },
    { id: 'verification', label: 'Open Checks (test results per file)', description: 'See whether changed files are verified, stale or failing, and re-run checks', run: () => openOperations('verification') },
    { id: 'git', label: 'Open Git and GitHub', description: 'Branches, changes, commits, push and pull requests', run: () => setView('git') },
    { id: 'terminal', label: 'Toggle Terminal Panel', description: 'Show or hide the command terminal at the bottom of the window', shortcut: shortcutLabel(shortcuts, 'terminal'), run: () => setTerminalOpen((open) => !open) },
    { id: 'threads', label: 'Toggle Threads Panel', description: 'Show or hide the conversation threads on the left', shortcut: shortcutLabel(shortcuts, 'threads'), run: () => setThreadsOpen((open) => !open) },
    { id: 'context-panel', label: 'Toggle Context Panel', description: 'Show or hide project context on the right', shortcut: shortcutLabel(shortcuts, 'context-panel'), run: () => setContextOpen((open) => !open) },
    { id: 'command-palette', label: 'Show Command Palette', description: 'Search commands, conversations, and the brain', shortcut: shortcutLabel(shortcuts, 'command-palette'), run: () => setCommandPaletteOpen(true) },
    { id: 'shortcut-sheet', label: 'Open Shortcut Sheet', description: 'Review and customize keyboard shortcuts', shortcut: shortcutLabel(shortcuts, 'shortcuts'), run: () => setShortcutSheetOpen(true) },
    { id: 'diagnostics', label: 'Open Diagnostics', description: 'Service health, engine checks and a copyable bug report', run: () => openOperations('diagnostics') },
    { id: 'settings', label: 'Open Settings', description: 'Configure agents, routes, API providers, services, and MCP', run: () => setView('settings') },
    { id: 'backups', label: 'Open Configuration Backups', description: 'Create, restore, or delete app-owned configuration backups', run: () => setView('settings') },
    { id: 'restart-proxy', label: 'Restart Universal Proxy', description: 'Stop and start the managed proxy service', run: () => controlService('universalProxy', 'restart') },
    ...agentCapabilities.map((agent): CommandPaletteItem => ({
      id: `agent-${agent.id}`,
      label: `Set Agent: ${agent.displayName}`,
      description: agent.available ? `Use ${agent.displayName} for CLI runs` : agent.unavailableReason ?? `${agent.displayName} is unavailable`,
      run: () => {
        setSelectedAgent(agent.id);
        setExecutionMode('cli');
        setSelectedRoute('direct');
        setAgentNotice(agent.available ? null : agent.unavailableReason ?? `${agent.displayName} is unavailable.`);
      },
    })),
    { id: 'route-direct', label: 'Set Route: Direct provider', description: 'Use API mode with the configured direct provider', run: () => { setExecutionMode('api'); setSelectedRoute('direct'); } },
    { id: 'route-proxy', label: 'Set Route: Universal Proxy', description: 'Use API mode through the managed Universal Proxy', run: () => { setExecutionMode('api'); setSelectedRoute('proxy'); } },
    { id: 'route-toggle', label: 'Toggle Direct/Proxy Route', description: 'Switch API mode to the other configured route', run: () => { setExecutionMode('api'); setSelectedRoute((route) => route === 'direct' ? 'proxy' : 'direct'); } },
    { id: 'autonomy-plan', label: 'Set Autonomy: Plan', description: 'Read-only planning before any project change', run: () => setSelectedAutonomy('plan') },
    { id: 'autonomy-ask', label: 'Set Autonomy: Ask', description: 'Ask before edits and commands', run: () => setSelectedAutonomy('ask') },
    { id: 'autonomy-auto', label: 'Set Autonomy: Auto-edit', description: 'Edit automatically and ask before risky commands', run: () => setSelectedAutonomy('autoEdit') },
    { id: 'autonomy-full', label: 'Set Autonomy: Full Control', description: 'Run without approval prompts', run: () => setSelectedAutonomy('full') },
    { id: 'autonomy-custom', label: 'Set Autonomy: Custom', description: 'Choose individual file, shell, network, and MCP permissions', run: () => setSelectedAutonomy('custom') },
    { id: 'autonomy-cycle', label: 'Cycle Autonomy Mode', description: 'Advance through Plan, Ask, Auto-edit, and Full Control', shortcut: 'Shift+Tab', run: cycleAutonomyMode },
  ];

  function openWorkspaceCommand(kind: WorkspaceCommandKind): void {
    commandNonce.current += 1;
    setView('workspace');
    setWorkspaceCommand({ kind, nonce: commandNonce.current });
  }

  function cycleAutonomyMode(): void {
    const modes: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full'];
    setSelectedAutonomy((current) => modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length]);
  }

  useEffect(() => {
    if (!activeProject) {
      setContextPreview(null);
      setContextPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setContextPreviewLoading(true);
    void window.kaiDesktop
      .previewContext({
        projectId: activeProject.id,
        ...(activeConversation ? { conversationId: activeConversation.id } : {}),
      })
      .then(unwrap)
      .then((preview) => {
        if (!cancelled) setContextPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setContextPreview(null);
      })
      .finally(() => {
        if (!cancelled) setContextPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, activeConversation?.id, activeConversation?.updatedAt, activeConversation?.events.length]);

  useEffect(() => {
    if (!activeProject) {
      setProjectPreferences(null);
      return;
    }
    let cancelled = false;
    void window.kaiDesktop
      .getPreferences(activeProject.id)
      .then(unwrap)
      .then((preferences) => {
        if (!cancelled) setProjectPreferences(preferences);
      })
      .catch(() => {
        if (!cancelled) setProjectPreferences(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id]);

  async function perform<T>(task: () => Promise<T>, message?: string): Promise<T | null> {
    if (message) setBusy(message);
    try {
      const result = await task();
      setError(null);
      return result;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function searchEverything(query: string): Promise<CommandPaletteItem[]> {
    const result = unwrap(await window.kaiDesktop.globalSearch(query));
    const groups = { conversation: 'Conversations', entry: 'Brain entries', handoff: 'Handoffs', daily: 'Daily logs', knowledge: 'Knowledge files' } as const;
    return result.hits.map((hit, index) => ({
      id: `search-${hit.source}-${index}`,
      label: hit.label,
      description: hit.detail,
      group: groups[hit.source],
      run: () => (hit.conversationId ? openConversation(hit.conversationId) : setView('brain')),
    }));
  }

  async function refreshInterrupted(): Promise<void> {
    try {
      setInterruptedRuns(unwrap(await window.kaiDesktop.listInterruptedRuns()).length);
    } catch {
      setInterruptedRuns(0);
    }
  }

  async function resumeInterruptedRun(resume: RecoveryResume): Promise<void> {
    const conversation = conversations.find((item) => item.id === resume.conversationId)
      ?? unwrap(await window.kaiDesktop.getConversation(resume.conversationId));
    if (!conversation) throw new Error('The conversation for this run no longer exists.');
    setActiveConversationId(conversation.id);
    setView('workspace');
    await runConversation(conversation, resume.prompt, {
      agent: resume.agent,
      execution: resume.execution,
      route: resume.route,
      autonomy: resume.autonomy,
    });
  }

  async function loadApplication(): Promise<void> {
    setBusy('Starting KAI');
    try {
      const [
        nextBootstrap,
        nextConversations,
        nextCredentials,
        nextLogs,
        nextAgentCapabilities,
        nextDirectApiCapability,
        nextSetupStatus,
      ] = await Promise.all([
        window.kaiDesktop.bootstrap().then(unwrap),
        window.kaiDesktop.listConversations().then(unwrap),
        window.kaiDesktop.credentialStatus().then(unwrap),
        window.kaiDesktop.recentLogs(50).then(unwrap),
        window.kaiDesktop.agentCapabilities().then(unwrap),
        window.kaiDesktop.directApiCapability().then(unwrap),
        window.kaiDesktop.setupStatus().then(unwrap),
      ]);
      setBootstrap(nextBootstrap);
      setConversations(nextConversations);
      setActiveConversationId(nextBootstrap.activeConversationId ?? nextConversations.find((conversation) => conversation.projectId === nextBootstrap.activeProjectId)?.id ?? null);
      setCredentials(nextCredentials);
      setLogs(nextLogs);
      setAgentCapabilities(nextAgentCapabilities);
      setDirectApiCapability(nextDirectApiCapability);
      setSetupStatus(nextSetupStatus);
      setSetupOpen(!nextSetupStatus.complete);
      setSelectedAgent(nextBootstrap.settings.defaultAgent);
      setExecutionMode('cli');
      setSelectedRoute('direct');
      setSelectedAutonomy(nextBootstrap.settings.defaultAutonomy);
      setAgentNotice(null);
      setError(null);
      void refreshInterrupted();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadApplication();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = bootstrap?.settings.theme ?? 'dark';
  }, [bootstrap?.settings.theme]);

  const servicesStarting = Boolean(
    bootstrap &&
    ((bootstrap.settings.cognitive1.enabled && serviceNeedsPolling(serviceFor(bootstrap, 'cognitive1').status)) ||
      (bootstrap.settings.proxy.enabled && serviceNeedsPolling(serviceFor(bootstrap, 'universalProxy').status))),
  );

  useEffect(() => {
    if (!servicesStarting) return;
    const timer = window.setInterval(() => {
      void window.kaiDesktop
        .serviceStatus()
        .then(unwrap)
        .then((services) => {
          setBootstrap((current) => (current ? { ...current, services } : current));
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [servicesStarting]);

  useEffect(() => window.kaiDesktop.onSharedDesktopState((shared) => {
    setBootstrap((current) => current ? {
      ...current,
      settings: shared.settings,
      projects: shared.projects,
      services: shared.services,
    } : current);
    setCredentials(shared.credentials);
    void refreshDirectApiStatus();
  }), []);

  useEffect(() => window.kaiDesktop.onAgentEvent((payload) => {
    const { conversationId, event } = payload;
    if (!shouldHandleAgentEvent(payload, runningConversationIdRef.current)) return;
    if (event.type === 'approval.request') {
      const requestId = event.requestId;
      if (!requestId) return;
      setPendingApprovals((current) => current.some((approval) => approval.requestId === requestId)
        ? current
        : [...current, {
            conversationId,
            requestId,
            title: event.title,
            detail: event.detail,
            risk: event.risk,
            tool: event.tool,
          }]);
      return;
    }
    if (conversationId !== runningConversationIdRef.current) return;
      if (event.type === 'text.delta' && event.channel === 'assistant') {
        setStreamingText((current) => current + event.text);
      }
  }), []);

  useEffect(() => {
    void window.kaiDesktop.reportView(view, activeConversationId).catch(() => undefined);
  }, [view, activeConversationId]);

  useEffect(() => {
    try {
      window.localStorage.setItem('kai.threadsOpen', String(threadsOpen));
    } catch {
      // Remembering panel visibility is a convenience only.
    }
  }, [threadsOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem('kai.contextOpen', String(contextOpen));
    } catch {
      // Remembering panel visibility is a convenience only.
    }
  }, [contextOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem('kai.sidebarWidth', String(sidebarWidth));
      window.localStorage.setItem('kai.contextWidth', String(contextWidth));
      window.localStorage.setItem('kai.previewWidth', String(previewWidth));
    } catch {
      // Remembering pane widths is a convenience only.
    }
  }, [contextWidth, previewWidth, sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('kai.previewOpen', String(previewOpen));
    } catch {
      // Remembering pane visibility is a convenience only.
    }
  }, [previewOpen]);

  const openConversationRef = useRef(openConversation);
  openConversationRef.current = openConversation;
  useEffect(() => window.kaiDesktop.onOpenConversation(({ conversationId }) => {
    void openConversationRef.current(conversationId);
  }), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || shortcutSheetOpenRef.current) return;
      const action = matchingShortcutAction(event, shortcutsRef.current);
      if (!action) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      );
      if (typing && action !== 'command-palette') return;
      event.preventDefault();
      if (action === 'workbench') setView('workspace');
      else if (action === 'code') setView('code');
      else if (action === 'new-window') void openNewWindow();
      else if (action === 'terminal') setTerminalOpen((open) => !open);
      else if (action === 'command-palette') setCommandPaletteOpen(true);
      else if (action === 'threads') setThreadsOpen((open) => !open);
      else if (action === 'context-panel') setContextOpen((open) => !open);
      else if (action === 'shortcuts') setShortcutSheetOpen(true);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function chooseProject(): Promise<void> {
    const project = await perform(() => window.kaiDesktop.chooseProject().then(unwrap), 'Opening project');
    if (!project) return;
    const next = await perform(() => window.kaiDesktop.bootstrap().then(unwrap), 'Refreshing workspace');
    if (next) {
      setBootstrap(next);
      setActiveConversationId(next.activeConversationId);
    }
  }

  function openOperations(tab: OperationsTab): void {
    setOperationsTab(tab);
    setView('operations');
  }

  async function openProject(id: string): Promise<void> {
    const next = await perform(() => window.kaiDesktop.openProject(id).then(unwrap), 'Opening project');
    if (next) {
      setBootstrap(next);
      setActiveConversationId(next.activeConversationId);
    }
  }

  async function openNewWindow(): Promise<void> {
    await perform(() => window.kaiDesktop.newWindow().then(unwrap), 'Opening a new window');
  }

  async function refreshSetupStatus(): Promise<void> {
    try {
      const status = await window.kaiDesktop.setupStatus().then(unwrap);
      setSetupStatus(status);
    } catch {
      // The setup panel keeps its last known state if the main process is busy.
    }
  }

  async function runSetupAction(action: NonNullable<SetupCheck['action']>): Promise<void> {
    if (action === 'open_project') {
      await chooseProject();
    } else if (action === 'open_settings') {
      setSetupOpen(false);
      setView('settings');
    } else if (action === 'start_cognitive1') {
      await controlService('cognitive1', 'start');
    } else {
      await controlService('universalProxy', 'start');
    }
    await refreshSetupStatus();
  }

  async function completeSetup(): Promise<void> {
    const status = await perform(
      () => window.kaiDesktop.completeSetup(true).then(unwrap),
      'Finishing setup',
    );
    if (!status) return;
    setSetupStatus(status);
    setSetupOpen(false);
    setAgentNotice('Setup complete. KAI is ready for your first task.');
  }

  async function removeProject(id: string): Promise<void> {
    const next = await perform(() => window.kaiDesktop.removeProject(id).then(unwrap), 'Removing project');
    if (next) setBootstrap(next);
  }

  async function openConversation(id: string): Promise<void> {
    const existing = conversations.find((conversation) => conversation.id === id);
    if (existing) {
      setActiveConversationId(id);
      setSelectedAgent(existing.activeAgent ?? bootstrap?.settings.defaultAgent ?? 'codex');
      const mode = existing.execution ?? 'cli';
      setExecutionMode(mode);
      setSelectedRoute(mode === 'api' ? existing.route ?? bootstrap?.settings.defaultRoute ?? 'direct' : 'direct');
      setSelectedAutonomy(existing.autonomy ?? bootstrap?.settings.defaultAutonomy ?? 'ask');
      setView('workspace');
      return;
    }
    const conversation = await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== id)]);
    setActiveConversationId(id);
    setSelectedAgent(conversation.activeAgent ?? bootstrap?.settings.defaultAgent ?? 'codex');
    const mode = conversation.execution ?? 'cli';
    setExecutionMode(mode);
    setSelectedRoute(mode === 'api' ? conversation.route ?? bootstrap?.settings.defaultRoute ?? 'direct' : 'direct');
    setSelectedAutonomy(conversation.autonomy ?? bootstrap?.settings.defaultAutonomy ?? 'ask');
    setView('workspace');
  }

  async function createConversation(prompt: string, options: WorkspaceSendOptions = {}): Promise<void> {
    if (!bootstrap || !activeProject) return;
    const conversation = await perform(
      () => window.kaiDesktop.createConversation(activeProject.id, prompt).then(unwrap),
      'Creating conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setView('workspace');
    await runConversation(conversation, prompt, options);
  }

  async function sendPrompt(prompt: string, options: WorkspaceSendOptions = {}): Promise<void> {
    if (!bootstrap || !activeConversation) {
      await createConversation(prompt, options);
      return;
    }
    await runConversation(activeConversation, prompt, options);
  }

  async function runConversation(
    conversation: ConversationRecord,
    prompt: string,
    options: WorkspaceSendOptions & { agent?: AgentId; execution?: ExecutionMode; route?: RouteMode; autonomy?: AutonomyMode } = {},
  ): Promise<void> {
    if (!bootstrap) return;
    const runAgentId = options.agent ?? selectedAgent;
    const runExecution = options.execution ?? executionMode;
    const runAutonomy = options.autonomy ?? selectedAutonomy;
    const apiRun = runExecution === 'api';
    const capability = agentCapabilities.find((agent) => agent.id === runAgentId);
    const requestedRoute = options.route ?? selectedRoute;
    const runRoute = !apiRun && !capability?.supportsRoutes.includes('proxy') ? 'direct' : requestedRoute;
    if (!apiRun && !capability?.available) {
      setError(capability?.unavailableReason ?? `${runAgentId} CLI is not available.`);
      return;
    }
    if (runRoute === 'proxy' && serviceFor(bootstrap, 'universalProxy').status !== 'ready') {
      setError('Start Universal Proxy before running an agent through its proxy route.');
      return;
    }
    if (apiRun && !directApiCapability?.available) {
      setError(directApiCapability?.unavailableReason ?? 'Direct API mode is not available.');
      return;
    }

    // Warn (never block) when another agent has claimed a file this run will touch.
    const projectForCheck = conversation.projectId ?? activeProject?.id;
    if (projectForCheck && options.selectedPaths?.length) {
      try {
        const check = unwrap(await window.kaiDesktop.coordinationPreflight(projectForCheck, options.selectedPaths));
        if (check.conflicts.length > 0) {
          const detail = check.conflicts.map((conflict) => `${conflict.agent} (${conflict.project}): ${conflict.overlap.join(', ')}`).join('\n');
          if (!(await confirmDialog({
            title: 'Files are already claimed',
            detail: `Another agent is working on files you selected:\n\n${detail}\n\nRun anyway?`,
            confirmLabel: 'Run anyway',
          }))) return;
        }
      } catch {
        // The check is advisory; a failure must not stop the run.
      }
    }

    setAgentNotice(null);
    setStreamingText('');
    setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== conversation.id));
    setRunningConversationId(conversation.id);
    setRunPaused(false);
    try {
      const result = await perform(
        () => window.kaiDesktop.runAgent({
          conversationId: conversation.id,
          prompt,
          agent: runAgentId,
          execution: runExecution,
          route: runRoute,
          autonomy: runAutonomy,
          ...(modelChoices[`${runExecution}:${runAgentId}`] ? { model: modelChoices[`${runExecution}:${runAgentId}`] } : {}),
          ...(options.goal ? { goal: options.goal } : {}),
          ...(options.skills?.length ? { skills: options.skills } : {}),
          ...(options.selectedPaths?.length ? { selectedPaths: options.selectedPaths } : {}),
        }).then(unwrap),
        apiRun
          ? `${directApiCapability?.displayName} is working`
          : `${capability?.displayName} is working`,
      );
      if (!result) return;
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      if (result.error) setError(result.error);
    } finally {
      setRunningConversationId(null);
      setRunPaused(false);
      setStreamingText('');
      setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== conversation.id));
    }
  }

  async function cancelConversation(): Promise<void> {
    if (!runningConversationId) return;
    const cancelled = await perform(
      () => window.kaiDesktop.cancelAgent(runningConversationId).then(unwrap),
      'Stopping agent',
    );
    if (cancelled) {
      setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== runningConversationId));
      setAgentNotice('Stopping the current agent run.');
    }
  }

  async function handoffConversation(agent: AgentId, prompt: string): Promise<void> {
    setSelectedAgent(agent);
    if (!activeConversation) {
      await createConversation(prompt, { agent });
      return;
    }
    await runConversation(activeConversation, prompt, { agent });
  }

  async function compareConversation(prompt: string, targetAgent: AgentId): Promise<CompareRun> {
    if (!bootstrap || !activeProject) throw new Error('Open a project before comparing agents.');
    return execute('Comparing agents in isolated worktrees', () => window.kaiDesktop.startCompare({
      projectId: activeProject.id,
      prompt,
      agent: selectedAgent,
      targetAgent,
      execution: executionMode,
      route: executionMode === 'api' ? selectedRoute : 'direct',
      autonomy: selectedAutonomy,
    }).then(unwrap));
  }

  async function pickCompareWinner(id: string, side: 'left' | 'right'): Promise<void> {
    await execute('Applying comparison changes', () => window.kaiDesktop.pickCompareWinner(id, side).then(unwrap));
    setAgentNotice(`Applied the ${side} agent's changes to the workspace.`);
  }

  async function discardCompare(id: string): Promise<void> {
    await execute('Discarding comparison', () => window.kaiDesktop.discardCompare(id).then(unwrap));
  }

  async function openCompareWorktree(id: string, side: 'left' | 'right'): Promise<void> {
    await execute('Opening comparison worktree', () => window.kaiDesktop.openCompareWorktree(id, side).then(unwrap));
  }

  async function reviewConversationCheckpoint(conversationId: string, turnId: string): Promise<CheckpointReview> {
    return execute('Reviewing turn changes', () => window.kaiDesktop.reviewCheckpoint(conversationId, turnId).then(unwrap));
  }

  async function refreshConversationRecord(id: string): Promise<void> {
    const conversation = await window.kaiDesktop.getConversation(id).then(unwrap);
    if (!conversation) return;
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== id)]);
  }

  async function rejectConversationFile(conversationId: string, turnId: string, filePath: string): Promise<void> {
    await execute('Restoring file from checkpoint', () => window.kaiDesktop.rejectCheckpointFile(conversationId, turnId, filePath).then(unwrap));
    await refreshConversationRecord(conversationId);
  }

  async function restoreConversationCheckpoint(conversationId: string, turnId: string): Promise<void> {
    await execute('Restoring turn checkpoint', () => window.kaiDesktop.restoreCheckpoint(conversationId, turnId).then(unwrap));
    await refreshConversationRecord(conversationId);
  }

  async function listConfigBackups(): Promise<ConfigBackup[]> {
    return execute('Loading configuration backups', () => window.kaiDesktop.listBackups().then(unwrap));
  }

  async function createConfigBackup(name?: string): Promise<ConfigBackup> {
    return execute('Creating configuration backup', () => window.kaiDesktop.createBackup(name).then(unwrap));
  }

  async function restoreConfigBackup(id: string): Promise<void> {
    await execute('Restoring configuration backup', () => window.kaiDesktop.restoreBackup(id).then(unwrap));
    await loadApplication();
  }

  async function deleteConfigBackup(id: string): Promise<void> {
    await execute('Deleting configuration backup', () => window.kaiDesktop.deleteBackup(id).then(unwrap));
  }

  async function execute<T>(message: string, task: () => Promise<T>): Promise<T> {
    const result = await perform(task, message);
    if (result === null) throw new Error(error ?? 'The operation failed.');
    return result;
  }

  async function respondToApproval(approved: boolean): Promise<void> {
    const approval = pendingApproval;
    if (!approval) return;
    setPendingApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
    await perform(
      () => window.kaiDesktop.respondToApproval({
        conversationId: approval.conversationId,
        requestId: approval.requestId,
        approved,
      }).then(unwrap),
      approved ? 'Approving project change' : 'Denying project change',
    );
  }

  async function refreshAgentCapabilities(): Promise<void> {
    const statuses = await perform(
      () => Promise.all([
        window.kaiDesktop.agentCapabilities().then(unwrap),
        window.kaiDesktop.directApiCapability().then(unwrap),
      ]),
      'Refreshing agent status',
    );
    if (!statuses) return;
    const [capabilities, apiCapability] = statuses;
    setAgentCapabilities(capabilities);
    setDirectApiCapability(apiCapability);
    if (executionMode === 'api') {
      setAgentNotice(apiCapability.available
        ? `${apiCapability.displayName} is ready.`
        : apiCapability.unavailableReason ?? 'Direct API status was refreshed.');
      return;
    }
    const selected = capabilities.find((agent) => agent.id === selectedAgent);
    setAgentNotice(selected?.available
      ? `${selected.displayName} is ready.`
      : selected?.unavailableReason ?? 'Agent status was refreshed.');
  }

  async function signInAgent(agent: AgentId): Promise<void> {
    const result = await perform(
      () => window.kaiDesktop.signInAgent(agent).then(unwrap),
      `Opening ${agent} sign-in`,
    );
    if (result) setAgentNotice(result.message);
  }

  async function deleteConversation(id: string): Promise<void> {
    const removed = await perform(() => window.kaiDesktop.deleteConversation(id).then(unwrap), 'Deleting conversation');
    if (removed === null) return;
    setConversations((current) => {
      const next = current.filter((conversation) => conversation.id !== id);
      if (activeConversationId === id) setActiveConversationId(next[0]?.id ?? null);
      return next;
    });
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    const conversation = conversations.find((item) => item.id === id) ?? await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!conversation) return;
    await saveConversationRecord({ ...conversation, title, updatedAt: new Date().toISOString() });
  }

  async function archiveConversation(id: string, archived: boolean): Promise<void> {
    const conversation = conversations.find((item) => item.id === id) ?? await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!conversation) return;
    await saveConversationRecord({ ...conversation, archived, updatedAt: new Date().toISOString() });
  }

  async function forkConversation(id: string): Promise<void> {
    const original = conversations.find((item) => item.id === id) ?? await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!original) return;
    const now = new Date().toISOString();
    const forked: ConversationRecord = {
      ...original,
      id: `conv_${crypto.randomUUID()}`,
      title: `${original.title} (fork)`,
      createdAt: now,
      updatedAt: now,
      archived: false,
      unread: false,
      turns: original.turns.map((turn) => ({ ...turn, id: `turn_${crypto.randomUUID()}` })),
      events: original.events.map((event) => ({ ...event, id: `evt_${crypto.randomUUID()}`, taskId: `conv_${crypto.randomUUID()}` })),
    };
    await saveConversationRecord(forked);
    setActiveConversationId(forked.id);
  }

  async function saveSettings(update: SettingsUpdate): Promise<boolean> {
    const settings = await perform(() => window.kaiDesktop.updateSettings(update).then(unwrap), 'Saving settings');
    if (settings) {
      const services = await window.kaiDesktop.serviceStatus().then(unwrap);
      setBootstrap((current) => (current ? { ...current, settings, services } : current));
      if (!activeConversation) setSelectedAgent(settings.defaultAgent);
      await refreshDirectApiStatus();
      return true;
    }
    return false;
  }

  async function saveProjectPreferences(preferences: ProjectPreferences): Promise<void> {
    const saved = await perform(
      () => window.kaiDesktop.updatePreferences(preferences).then(unwrap),
      'Saving project permissions',
    );
    if (saved) setProjectPreferences(saved);
  }

  async function saveConversationRecord(conversation: ConversationRecord): Promise<void> {
    const saved = await perform(
      () => window.kaiDesktop.saveConversation(conversation).then(unwrap),
      'Saving conversation',
    );
    if (!saved) return;
    setConversations((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
  }

  async function compactActiveConversation(): Promise<void> {
    if (!activeConversation) {
      setError('Open a conversation before compacting context.');
      return;
    }
    const compacted = await perform(
      () => window.kaiDesktop.compactConversation(activeConversation.id).then(unwrap),
      'Compacting conversation context',
    );
    if (!compacted) return;
    setConversations((current) => current.map((item) => item.id === compacted.id ? compacted : item));
    setAgentNotice(`Compacted ${compacted.compaction?.originalTurns ?? 0} conversation turns into a reusable context briefing.`);
  }

  async function importBrain(): Promise<void> {
    const result = await perform(
      () => window.kaiDesktop.importBrain().then(unwrap),
      'Importing C1 brain data',
    );
    if (!result) return;
    setAgentNotice(`Imported ${result.imported} brain files; skipped ${result.skipped} existing files.`);
    const [services, logs] = await Promise.all([
      window.kaiDesktop.serviceStatus().then(unwrap),
      window.kaiDesktop.recentLogs(50).then(unwrap),
    ]);
    setBootstrap((current) => current ? { ...current, services } : current);
    setLogs(logs);
  }

  function toggleTheme(): void {
    if (!bootstrap) return;
    const previous = bootstrap.settings.theme;
    const theme = THEME_MODES[(THEME_MODES.findIndex((item) => item.id === previous) + 1) % THEME_MODES.length]!.id;
    setBootstrap((current) => current ? { ...current, settings: { ...current.settings, theme } } : current);
    void window.kaiDesktop
      .updateSettings({ theme })
      .then(unwrap)
      .then((settings) => setBootstrap((current) => current ? { ...current, settings } : current))
      .catch((caught) => {
        setBootstrap((current) => current ? { ...current, settings: { ...current.settings, theme: previous } } : current);
        setError(messageOf(caught));
      });
  }

  async function refreshDirectApiStatus(): Promise<void> {
    try {
      setDirectApiCapability(await window.kaiDesktop.directApiCapability().then(unwrap));
    } catch {
      // The next explicit refresh will surface an error if the main process is unavailable.
    }
  }

  async function controlService(
    kind: 'cognitive1' | 'universalProxy',
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const request =
      action === 'start'
        ? window.kaiDesktop.startService(kind)
        : action === 'stop'
          ? window.kaiDesktop.stopService(kind)
          : window.kaiDesktop.restartService(kind);
    const services = await perform(
      () => request.then(unwrap),
      `${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} service`,
    );
    if (services) setBootstrap((current) => (current ? { ...current, services } : current));
  }

  async function copyServiceToken(kind: 'cognitive1' | 'universalProxy'): Promise<void> {
    await perform(() => window.kaiDesktop.copyServiceToken(kind).then(unwrap), 'Copying access token');
  }

  async function rotateServiceToken(kind: 'cognitive1' | 'universalProxy'): Promise<void> {
    const services = await perform(
      () => window.kaiDesktop.rotateServiceToken(kind).then(unwrap),
      'Rotating access token',
    );
    if (services) setBootstrap((current) => (current ? { ...current, services } : current));
  }

  async function saveCredential(id: string, value: string): Promise<boolean> {
    const status = await perform(() => window.kaiDesktop.setCredential(id, value).then(unwrap), 'Saving credential');
    if (status) {
      setCredentials(status);
      await refreshDirectApiStatus();
      return true;
    }
    return false;
  }

  async function pauseConversation(): Promise<void> {
    if (!runningConversationId) return;
    const paused = await perform(() => window.kaiDesktop.pauseAgent(runningConversationId).then(unwrap), 'Pausing agent');
    if (paused) {
      setRunPaused(true);
      setAgentNotice('The run is paused. It will continue from the same point.');
    }
  }

  async function resumeConversation(): Promise<void> {
    if (!runningConversationId) return;
    const resumed = await perform(() => window.kaiDesktop.resumeAgent(runningConversationId).then(unwrap), 'Resuming agent');
    if (resumed) {
      setRunPaused(false);
      setAgentNotice(null);
    }
  }

  async function clearCredential(id: string): Promise<boolean> {
    const status = await perform(() => window.kaiDesktop.clearCredential(id).then(unwrap), 'Removing credential');
    if (status) {
      setCredentials(status);
      await refreshDirectApiStatus();
      return true;
    }
    return false;
  }

  function beginResize(kind: 'sidebar' | 'context' | 'preview', event: ReactPointerEvent<HTMLDivElement>): void {
    const width = kind === 'sidebar' ? sidebarWidth : kind === 'context' ? contextWidth : previewWidth;
    resizeOrigin.current = { kind, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(kind);
  }

  function continueResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin) return;
    const delta = event.clientX - origin.x;
    if (origin.kind === 'sidebar') setSidebarWidth(clamp(origin.width + delta, 190, 480));
    else if (origin.kind === 'context') setContextWidth(clamp(origin.width - delta, 230, 560));
    else setPreviewWidth(clamp(origin.width - delta, 340, 760));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeOrigin.current = null;
    setResizing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizePaneWithKeyboard(kind: 'sidebar' | 'context' | 'preview', event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 12;
    const current = kind === 'sidebar' ? sidebarWidth : kind === 'context' ? contextWidth : previewWidth;
    const minimum = kind === 'sidebar' ? 190 : kind === 'context' ? 230 : 340;
    const maximum = kind === 'sidebar' ? 480 : kind === 'context' ? 560 : 760;
    let next = current;
    if (event.key === 'Home') next = minimum;
    else if (event.key === 'End') next = maximum;
    else if (kind === 'sidebar') next += event.key === 'ArrowRight' ? step : -step;
    else next += event.key === 'ArrowLeft' ? step : -step;
    if (kind === 'sidebar') setSidebarWidth(clamp(next, minimum, maximum));
    else if (kind === 'context') setContextWidth(clamp(next, minimum, maximum));
    else setPreviewWidth(clamp(next, minimum, maximum));
  }

  function requestPreviewChange(prompt: string): void {
    commandNonce.current += 1;
    setWorkspaceCommand({ kind: 'preview-change', nonce: commandNonce.current, prompt });
    setView('workspace');
  }

  function renderCurrentView(): ReactNode {
    if (!bootstrap) return null;
    switch (view) {
      case 'projects':
        return (
          <ProjectsView
            projects={bootstrap.projects}
            activeProjectId={bootstrap.activeProjectId}
            onChoose={() => void chooseProject()}
            onOpen={(id) => void openProject(id)}
            onRemove={(id) => void removeProject(id)}
          />
        );
      case 'brain':
        return (
          <ServiceView
            service={serviceFor(bootstrap, 'cognitive1')}
            kind="brain"
            busy={Boolean(busy)}
            onConfigure={() => setView('settings')}
            onStart={() => void controlService('cognitive1', 'start')}
            onStop={() => void controlService('cognitive1', 'stop')}
            onRestart={() => void controlService('cognitive1', 'restart')}
            onCopyToken={() => void copyServiceToken('cognitive1')}
            onRotateToken={() => void rotateServiceToken('cognitive1')}
          >
            <Cognitive1Panel service={serviceFor(bootstrap, 'cognitive1')} projects={bootstrap.projects} />
          </ServiceView>
        );
      case 'rules':
        return <RulesView />;
      case 'proxy':
        return (
          <ServiceView
            service={serviceFor(bootstrap, 'universalProxy')}
            kind="proxy"
            busy={Boolean(busy)}
            onConfigure={() => setView('settings')}
            onStart={() => void controlService('universalProxy', 'start')}
            onStop={() => void controlService('universalProxy', 'stop')}
            onRestart={() => void controlService('universalProxy', 'restart')}
            onCopyToken={() => void copyServiceToken('universalProxy')}
            onRotateToken={() => void rotateServiceToken('universalProxy')}
          >
            <ProxyPanel
              service={serviceFor(bootstrap, 'universalProxy')}
              settings={bootstrap.settings}
              busy={Boolean(busy)}
              logs={logs}
              credentialStatus={credentials}
              onSave={(update) => void saveSettings(update)}
              onSaveCredential={(id, value) => void saveCredential(id, value)}
              onClearCredential={(id) => void clearCredential(id)}
              onReload={loadApplication}
            />
          </ServiceView>
        );
      case 'workflows':
        return (
          <WorkflowsView
            activeProject={activeProject}
            agentCapabilities={agentCapabilities}
            settings={bootstrap.settings}
            busy={Boolean(busy)}
          />
        );
      case 'history':
        return (
          <HistoryView
            conversations={conversations}
            activeId={activeConversationId}
            projects={bootstrap.projects}
            onOpen={(id) => void openConversation(id)}
            onRename={(id, title) => void renameConversation(id, title)}
            onArchive={(id, archived) => void archiveConversation(id, archived)}
            onFork={(id) => void forkConversation(id)}
            onDelete={(id) => void deleteConversation(id)}
          />
        );
      case 'usage':
        return <UsageView settings={bootstrap.settings} activeConversationId={activeConversationId} busy={Boolean(busy)} onSave={(update) => void saveSettings(update)} />;
      case 'git':
        return <GitView activeProject={activeProject} />;
      case 'tasks':
        return <TasksView activeProject={activeProject} cognitive1Ready={serviceFor(bootstrap, 'cognitive1').status === 'ready'} onStartTask={async (prompt) => { setView('workspace'); await createConversation(prompt); }} />;
      case 'code':
        return null;
      case 'operations':
        return <OperationsView initialTab={operationsTab} activeProject={activeProject} onResume={resumeInterruptedRun} onRecoveryChanged={() => void refreshInterrupted()} />;
      case 'settings':
        return (
          <SettingsView
            settings={bootstrap.settings}
            credentialStatus={credentials}
            dataLocations={bootstrap.dataLocations}
            logs={logs}
            busy={Boolean(busy)}
            onSave={(update) => saveSettings(update)}
            onImportBrain={() => void importBrain()}
            onSaveCredential={(id, value) => saveCredential(id, value)}
            onClearCredential={(id) => clearCredential(id)}
            onListProviderModels={(request) => window.kaiDesktop.listProviderModels(request).then(unwrap)}
            onListBackups={listConfigBackups}
            onCreateBackup={createConfigBackup}
            onRestoreBackup={restoreConfigBackup}
            onDeleteBackup={deleteConfigBackup}
          />
        );
      case 'workspace':
      default:
        return (
          <WorkspaceView
            activeProject={activeProject}
            activeConversation={activeConversation}
            settings={bootstrap.settings}
            projectPreferences={projectPreferences}
            busy={Boolean(busy)}
            commandRequest={workspaceCommand}
            agentCapabilities={agentCapabilities}
            directApiCapability={directApiCapability}
            selectedAgent={selectedAgent}
            executionMode={executionMode}
            selectedRoute={selectedRoute}
            selectedAutonomy={selectedAutonomy}
            proxyReady={serviceFor(bootstrap, 'universalProxy').status === 'ready'}
            streamingText={streamingText}
            running={runningConversationId === activeConversation?.id}
            paused={runPaused}
            awaitingApproval={pendingApproval?.conversationId === activeConversation?.id}
            notice={agentNotice}
            onSelectExecution={(mode) => {
              setExecutionMode(mode);
              setAgentNotice(null);
            }}
            onSelectAgent={(agent) => {
              setSelectedAgent(agent);
              const capability = agentCapabilities.find((item) => item.id === agent);
              if (!capability?.supportsRoutes.includes('proxy')) setSelectedRoute('direct');
              setAgentNotice(null);
            }}
            onSelectRoute={(route) => {
              setSelectedRoute(route);
              setAgentNotice(null);
            }}
            onSelectAutonomy={(autonomy) => {
              setSelectedAutonomy(autonomy);
              setAgentNotice(null);
            }}
            onUpdatePreferences={saveProjectPreferences}
            onUpdateConversation={saveConversationRecord}
            onChooseProject={() => void chooseProject()}
            onCreateConversation={(prompt, options) => void createConversation(prompt, options)}
            onSend={(prompt, options) => void sendPrompt(prompt, options)}
            onHandoff={(agent, prompt) => void handoffConversation(agent, prompt)}
            onCompare={compareConversation}
            onPickCompare={pickCompareWinner}
            onDiscardCompare={discardCompare}
            onOpenCompareWorktree={openCompareWorktree}
            onReviewCheckpoint={reviewConversationCheckpoint}
            onRejectCheckpointFile={rejectConversationFile}
            onRestoreCheckpoint={restoreConversationCheckpoint}
            onCancel={() => void cancelConversation()}
            onPause={() => void pauseConversation()}
            onResume={() => void resumeConversation()}
            onSignIn={(agent) => void signInAgent(agent)}
            onRefreshAgents={() => void refreshAgentCapabilities()}
            onOpenSettings={() => setView('settings')}
            onOpenUsage={() => setView('usage')}
            selectedModel={modelChoices[`${executionMode}:${selectedAgent}`] ?? ''}
            onSelectModel={(model) => setModelChoices((current) => ({ ...current, [`${executionMode}:${selectedAgent}`]: model }))}
            interruptedRuns={interruptedRuns}
            onOpenRecovery={() => openOperations('recovery')}
            onOpenVerification={() => openOperations('verification')}
            onOpenRules={() => setView('rules')}
            onOpenWorkflows={() => setView('workflows')}
            onCompactConversation={() => void compactActiveConversation()}
          />
        );
    }
  }

  if (!bootstrap) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">K</div>
        <h1>KAI</h1>
        <p>{error ?? busy ?? 'Preparing workspace'}</p>
        {error && (
          <button type="button" className="primary-button" onClick={() => void loadApplication()}>
            <RefreshCw size={15} />
            <span>Retry</span>
          </button>
        )}
      </div>
    );
  }

  const showThreads = view === 'workspace' && threadsOpen;
  const showContext = view === 'workspace' && contextOpen;

  return (
    <div className={`app-shell ${resizing ? 'is-resizing' : ''}`}>
      <TitleBar
        projects={bootstrap.projects}
        activeProject={activeProject}
        theme={bootstrap.settings.theme}
        leftOpen={threadsOpen}
        rightOpen={contextOpen}
        previewOpen={previewOpen}
        shortcuts={shortcuts}
        onChoose={() => void chooseProject()}
        onOpenProject={(id) => void openProject(id)}
        onNewWindow={() => void openNewWindow()}
        onToggleTheme={toggleTheme}
        onOpenSearch={() => setCommandPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutSheetOpen(true)}
        onToggleThreads={() => setThreadsOpen((open) => !open)}
        onToggleContext={() => setContextOpen((open) => !open)}
        onTogglePreview={() => setPreviewOpen((open) => !open)}
      />
      <UrgentBanner />
      <UpdateBanner onOpen={() => setView('settings')} />
      {setupStatus && !setupStatus.complete && !setupOpen && (
        <button type="button" className="setup-reminder" onClick={() => setSetupOpen(true)}>
          <ShieldCheck size={15} />
          <span>Finish KAI setup</span>
          <span className="setup-reminder-progress">
            {setupStatus.checks.filter((check) => check.status === 'ready').length}/{setupStatus.checks.length} ready
          </span>
        </button>
      )}
      {commandPaletteOpen && <CommandPalette items={commandItems} onClose={() => setCommandPaletteOpen(false)} onSearch={searchEverything} />}
      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button
            type="button"
            className="icon-button compact"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="app-body">
        <NavigationRail
          view={view}
          version={`v${bootstrap.version} · ${bootstrap.buildIdentifier.split('+').at(-1) ?? 'dev'}`}
          serviceStatus={serviceFor(bootstrap, 'universalProxy').status}
          shortcuts={shortcuts}
          onChange={setView}
        />
        {showThreads && (
          <>
            <div className="conversation-column" style={{ width: sidebarWidth }}>
              <ConversationSidebar
                conversations={conversations}
                activeId={activeConversationId}
                onOpen={(id) => void openConversation(id)}
                onDelete={(id) => void deleteConversation(id)}
                onCollapse={() => setThreadsOpen(false)}
                onNew={() => {
                  setActiveConversationId(null);
                  setSelectedAgent(bootstrap.settings.defaultAgent);
                  setExecutionMode('cli');
                  setStreamingText('');
                  setView('workspace');
                }}
              />
            </div>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize conversations"
              aria-orientation="vertical"
              aria-valuemin={190}
              aria-valuemax={480}
              aria-valuenow={Math.round(sidebarWidth)}
              tabIndex={0}
              onPointerDown={(event) => beginResize('sidebar', event)}
              onPointerMove={continueResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={() => setSidebarWidth(248)}
              onKeyDown={(event) => resizePaneWithKeyboard('sidebar', event)}
            />
          </>
        )}
        <div className="main-column">
          <main className={`app-main view-${view}`}>
            {view !== 'code' && renderCurrentView()}
            <div className={`persistent-code-view ${view === 'code' ? 'active' : ''}`} aria-hidden={view !== 'code'}>
              <CodeView
                activeProject={activeProject}
                editorState={bootstrap.editor}
                autoSave={bootstrap.settings.editor.autoSave}
                autoSaveDelayMs={bootstrap.settings.editor.autoSaveDelayMs}
                onOpenSettings={() => setView('settings')}
              />
            </div>
          </main>
          <TerminalView
            activeProject={activeProject}
            open={terminalOpen}
            height={terminalHeight}
            onClose={() => setTerminalOpen(false)}
            onResizeStart={(event) => {
              event.preventDefault();
              const startY = event.clientY;
              const startHeight = terminalHeight;
              let latest = startHeight;
              const move = (moveEvent: globalThis.PointerEvent): void => {
                latest = clamp(startHeight + (startY - moveEvent.clientY), 140, Math.round(window.innerHeight * 0.75));
                setTerminalHeight(latest);
              };
              const up = (): void => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                try {
                  window.localStorage.setItem('kai.terminalHeight', String(latest));
                } catch {
                  // A remembered height is a convenience only.
                }
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />
        </div>
        {showContext && (
          <>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize context panel"
              aria-orientation="vertical"
              aria-valuemin={230}
              aria-valuemax={560}
              aria-valuenow={Math.round(contextWidth)}
              tabIndex={0}
              onPointerDown={(event) => beginResize('context', event)}
              onPointerMove={continueResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={() => setContextWidth(286)}
              onKeyDown={(event) => resizePaneWithKeyboard('context', event)}
            />
            <div className="context-column" style={{ width: contextWidth }}>
              <ContextPanel
                activeProject={activeProject}
                conversation={activeConversation}
                services={bootstrap.services}
                contextPreview={contextPreview}
                contextPreviewLoading={contextPreviewLoading}
              />
            </div>
          </>
        )}
        {previewOpen && (
          <>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize live preview pane"
              aria-orientation="vertical"
              aria-valuemin={340}
              aria-valuemax={760}
              aria-valuenow={Math.round(previewWidth)}
              tabIndex={0}
              onPointerDown={(event) => beginResize('preview', event)}
              onPointerMove={continueResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={() => setPreviewWidth(460)}
              onKeyDown={(event) => resizePaneWithKeyboard('preview', event)}
            />
            <div className="preview-column" style={{ width: previewWidth }}>
              <PreviewView
                activeProject={activeProject}
                onRequestChange={requestPreviewChange}
                onClose={() => setPreviewOpen(false)}
              />
            </div>
          </>
        )}
      </div>
      {busy && (
        <div className="busy-indicator" role="status">
          <span />
          {busy}
        </div>
      )}
      {pendingApproval && (
        <ApprovalDialog approval={pendingApproval} onRespond={(approved) => void respondToApproval(approved)} />
      )}
      {setupOpen && setupStatus && !setupStatus.complete && (
        <SetupPanel
          status={setupStatus}
          busy={Boolean(busy)}
          onAction={(action) => void runSetupAction(action)}
          onComplete={() => void completeSetup()}
          onDismiss={() => setSetupOpen(false)}
        />
      )}
      {shortcutSheetOpen && (
        <ShortcutSheet
          shortcuts={shortcuts}
          busy={Boolean(busy)}
          onSave={(next) => saveSettings({ shortcuts: next })}
          onClose={() => setShortcutSheetOpen(false)}
        />
      )}
      <DialogHost />
    </div>
  );
}

function ApprovalDialog({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (approved: boolean) => void;
}): ReactNode {
  return (
    <div className="approval-overlay">
      <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-dialog-head">
          <ShieldCheck size={20} />
          <div><span className="eyebrow">Project approval</span><h2 id="approval-title">{approval.title}</h2></div>
          <span className={`risk-badge ${approval.risk}`}>{approval.risk} risk</span>
        </div>
        {approval.tool && <code className="approval-tool">{approval.tool}</code>}
        <pre className="approval-detail">{approval.detail}</pre>
        <div className="approval-dialog-actions">
          <button type="button" className="secondary-button" onClick={() => onRespond(false)}>Deny</button>
          <button type="button" className="primary-button" autoFocus onClick={() => onRespond(true)}>Allow once</button>
        </div>
      </section>
    </div>
  );
}

function serviceFor(bootstrap: BootstrapPayload, kind: 'cognitive1' | 'universalProxy') {
  return (
    bootstrap.services.find((service) => service.kind === kind) ?? {
      kind,
      status: 'not_configured' as const,
      detail: 'Service status is unavailable.',
      endpoint: null,
      version: null,
      updatedAt: new Date().toISOString(),
    }
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'KAI encountered an unexpected error.';
}

function serviceNeedsPolling(status: string): boolean {
  return status === 'starting' || status === 'stopped';
}
