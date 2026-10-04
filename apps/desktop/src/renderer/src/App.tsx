import { AlertTriangle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react';
import type {
  AgentCapability,
  AgentTeam,
  AgentId,
  AutonomyMode,
  BootstrapPayload,
  CheckpointReview,
  CompareRun,
  ConfigBackup,
  ConversationRecord,
  ContextChip,
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
  SkillSummary,
  TeamPlanDraft,
} from '@kai/contracts';
import { CLI_MODEL_SUGGESTIONS, COMPACTION_WARNING_TOKENS, contextChipSchema, estimateConversationTokens, skillSummarySchema, THEME_MODES } from '@kai/contracts';
import { CommandPalette, ConversationSidebar, NavigationRail, TitleBar, type CommandPaletteItem } from './components/Chrome';
import { HistoryView, ProjectsView, ServiceView, WorkflowsView } from './components/Pages';
import { Cognitive1Panel } from './components/Cognitive1Panel';
import { ProxyPanel } from './components/ProxyView';
import { RulesView } from './components/RulesView';
import { SettingsView } from './components/SettingsView';
import { CodeView } from './components/CodeView';
import { GitView } from './components/GitView';
import { CommandsView } from './components/CommandsView';
import { TasksView } from './components/TasksView';
import { StudioView } from './components/StudioView';
import { TerminalView } from './components/TerminalView';
import { PreviewView } from './components/PreviewView';
import { RightPane } from './components/RightPane';
import { UrgentBanner } from './components/CoordinationPanel';
import { UpdateBanner } from './components/UpdatesPanel';
import { OperationsView, type OperationsTab } from './components/OperationsView';
import { UsageView } from './components/UsageView';
import {
  WorkspaceView,
  type WorkspaceSendOptions,
  type WorkspaceCommandKind,
  type WorkspaceCommandRequest,
} from './components/Workspace';
import { GraphView } from './components/GraphView';
import { composerSettingsFor } from './components/composer-settings';
import { TourGuide } from './components/TourGuide';
import { TOUR_STORAGE_KEY, parseTourProgress, type TourProgress } from './tour-lessons';
import { clamp, unwrap, type ViewId } from './types';
import { confirmDialog, DialogHost } from './components/AppDialog';
import { TooltipLayer } from './components/TooltipLayer';
import { isApprovalForConversation, shouldHandleAgentEvent } from './agent-events';
import { approvalActions } from './approval-actions';
import { rememberAgentChoice, rememberedAgentChoice, startupAgentChoice } from './agent-memory';
import { SetupPanel } from './components/SetupPanel';
import { ShortcutSheet } from './components/ShortcutSheet';
import { matchingShortcutAction, shortcutLabel, shortcutsWithDefaults } from './shortcuts';
import { loadComposerQueue, queuedPromptWasAccepted, saveComposerQueue, QUEUE_KEY, type QueuedPrompt } from './components/composer-queue';

const emptyCredentials: CredentialStatus = { available: false, ids: [] };

interface PendingApproval {
  conversationId: string;
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  tool?: string;
  /** Set when the run is asking about itself, so the dialog offers these answers instead of allow and deny. */
  runQuestion?: { continueLabel: string; finishLabel: string };
  /** Set when the model asked a question via `ask_user`: the choices to show instead of allow/deny buttons. */
  options?: string[];
  /** Whether a typed answer is also acceptable for an `options` question, not only one of the choices. */
  allowFreeText?: boolean;
}

interface ComposerSelection {
  agent: AgentId;
  execution: ExecutionMode;
  route: RouteMode;
  autonomy: AutonomyMode;
  model: string;
}

const COMPOSER_SELECTIONS_KEY = 'kai.composerSelections.v1';
const COMPOSER_DRAFTS_KEY = 'kai.composerDrafts.v1';
const COMPOSER_CONTEXTS_KEY = 'kai.composerContexts.v1';

interface ComposerContextDraft {
  selectedFiles: string[];
  contextChips: ContextChip[];
  selectedSkills: SkillSummary[];
}

const emptyComposerContext: ComposerContextDraft = { selectedFiles: [], contextChips: [], selectedSkills: [] };

function loadComposerContexts(): Record<string, ComposerContextDraft> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPOSER_CONTEXTS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object') return [];
      const draft = value as Partial<ComposerContextDraft>;
      return [[key, {
        selectedFiles: Array.isArray(draft.selectedFiles) ? draft.selectedFiles.filter((file): file is string => typeof file === 'string') : [],
        contextChips: Array.isArray(draft.contextChips) ? draft.contextChips.flatMap((chip) => {
          const parsed = contextChipSchema.safeParse(chip);
          return parsed.success ? [parsed.data] : [];
        }) : [],
        selectedSkills: Array.isArray(draft.selectedSkills) ? draft.selectedSkills.flatMap((skill) => {
          const parsed = skillSummarySchema.safeParse(skill);
          return parsed.success ? [parsed.data] : [];
        }) : [],
      }]];
    }));
  } catch {
    return {};
  }
}

function loadComposerDrafts(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPOSER_DRAFTS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function isSupportedCodexCliModel(model: string): boolean {
  return model === '' || CLI_MODEL_SUGGESTIONS.codex.includes(model);
}

function loadComposerSelections(): Record<string, ComposerSelection> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPOSER_SELECTIONS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, ComposerSelection>).map(([key, selection]) => [
      key,
      selection.agent === 'codex' && selection.execution === 'cli' && !isSupportedCodexCliModel(selection.model)
        ? { ...selection, model: '' }
        : selection,
    ]));
  } catch {
    return {};
  }
}

export function App(): ReactNode {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [openConversationIds, setOpenConversationIds] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus>(emptyCredentials);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapability[]>([]);
  const [directApiCapability, setDirectApiCapability] = useState<DirectApiCapability | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreview | null>(null);
  const [codeOpenRequest, setCodeOpenRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [contextPreviewLoading, setContextPreviewLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('codex');
  const signInAttempt = useRef(0);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('cli');
  const [selectedRoute, setSelectedRoute] = useState<RouteMode>('direct');
  const [selectedAutonomy, setSelectedAutonomy] = useState<AutonomyMode>('ask');
  const [view, setView] = useState<ViewId>('workspace');
  // The guided tour's progress is a per-viewer convenience, so it lives in this window's storage, not in settings.
  const [tourProgress, setTourProgress] = useState<TourProgress>(() => {
    try {
      return parseTourProgress(window.localStorage.getItem(TOUR_STORAGE_KEY));
    } catch {
      return parseTourProgress(null);
    }
  });
  const [tourListOpen, setTourListOpen] = useState(false);
  function changeTourProgress(next: TourProgress): void {
    setTourProgress(next);
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The tour still works for this session if storage is unavailable.
    }
  }
  // A plan the Project Studio built from the board, carried to the Workflows page so it opens for review there.
  const [incomingTeamPlan, setIncomingTeamPlan] = useState<TeamPlanDraft | null>(null);
  const [interruptedRuns, setInterruptedRuns] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState<{ command: string; nonce: number } | null>(null);
  const [settingsDestination, setSettingsDestination] = useState<{ category: 'connections' | 'services'; nonce: number } | null>(null);
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
  const [runningConversationIds, setRunningConversationIds] = useState<string[]>([]);
  const [pausedConversationIds, setPausedConversationIds] = useState<string[]>([]);
  /**
   * Conversations where an Auto run has stopped and is waiting for a person: a cap reached, a repeated wall, an
   * approval, no provider left. Auto keeps its session alive across turns, so from the composer's side this is a run
   * paused on you — and it is the reason Resume has to stay reachable once Auto's own buttons are gone.
   */
  const [autoWaitingConversationIds, setAutoWaitingConversationIds] = useState<string[]>([]);
  const [failedConversationIds, setFailedConversationIds] = useState<string[]>([]);
  const [streamingTextByConversation, setStreamingTextByConversation] = useState<Record<string, string>>({});
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>(loadComposerDrafts);
  const [composerContexts, setComposerContexts] = useState<Record<string, ComposerContextDraft>>(loadComposerContexts);
  const [composerSelections, setComposerSelections] = useState<Record<string, ComposerSelection>>(loadComposerSelections);
  const [queuedPromptsByConversation, setQueuedPromptsByConversation] = useState<Record<string, QueuedPrompt[]>>(loadComposerQueue);
  const dispatchingQueuedConversations = useRef(new Set<string>());
  const localRunsInFlight = useRef(new Set<string>());
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const [proxyContinuationAgent, setProxyContinuationAgent] = useState<AgentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const [workspaceCommand, setWorkspaceCommand] = useState<WorkspaceCommandRequest | null>(null);
  const [operationsTab, setOperationsTab] = useState<OperationsTab>('recovery');
  const started = useRef(false);
  const commandNonce = useRef(0);
  const resizeOrigin = useRef<{ kind: 'sidebar' | 'context' | 'preview'; x: number; width: number } | null>(null);
  const runningConversationIdsRef = useRef<string[]>([]);
  const shortcutsRef = useRef(bootstrap?.settings.shortcuts ?? {});
  const shortcutSheetOpenRef = useRef(false);
  const pendingApproval = pendingApprovals.find((approval) => approval.conversationId === activeConversationId && !approval.options)
    ?? pendingApprovals.find((approval) => !approval.options)
    ?? null;
  const activeQuestion = pendingApprovals.find((approval) => approval.conversationId === activeConversationId && approval.options !== undefined);
  runningConversationIdsRef.current = runningConversationIds;
  shortcutsRef.current = bootstrap?.settings.shortcuts ?? {};
  shortcutSheetOpenRef.current = shortcutSheetOpen;

  const activeProject = bootstrap?.projects.find((project) => project.id === bootstrap.activeProjectId) ?? null;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const activeRunning = Boolean(activeConversationId && runningConversationIds.includes(activeConversationId));
  const activePaused = Boolean(
    activeConversationId
    && (pausedConversationIds.includes(activeConversationId) || autoWaitingConversationIds.includes(activeConversationId)),
  );
  const streamingText = activeConversationId ? streamingTextByConversation[activeConversationId] ?? '' : '';
  const openConversations = openConversationIds.map((id) => conversations.find((conversation) => conversation.id === id)).filter((conversation): conversation is ConversationRecord => Boolean(conversation));
  const activeDraftKey = activeConversationId ?? '__new__';
  const activeContextKey = activeConversationId ?? `__new__:${activeProject?.id ?? 'none'}`;
  const activeComposerContext = composerContexts[activeContextKey] ?? emptyComposerContext;
  const activeComposerSelection = composerSelections[activeDraftKey];
  const savedActiveModel = activeComposerSelection?.model ?? modelChoices[`${executionMode}:${selectedAgent}`] ?? '';
  const selectedWorkspaceModel = executionMode === 'cli' && selectedAgent === 'codex' && !isSupportedCodexCliModel(savedActiveModel)
    ? ''
    : savedActiveModel;
  const updateComposerDraft = useCallback((value: string) => {
    setComposerDrafts((current) => current[activeDraftKey] === value ? current : { ...current, [activeDraftKey]: value });
  }, [activeDraftKey]);
  const setComposerContextField = <K extends keyof ComposerContextDraft>(key: K, update: SetStateAction<ComposerContextDraft[K]>): void => {
    setComposerContexts((current) => {
      const draft = current[activeContextKey] ?? emptyComposerContext;
      const value = typeof update === 'function'
        ? (update as (previous: ComposerContextDraft[K]) => ComposerContextDraft[K])(draft[key]) : update;
      return { ...current, [activeContextKey]: { ...draft, [key]: value } };
    });
  };
  const queuePrompt = (item: QueuedPrompt, first = false): void => {
    setQueuedPromptsByConversation((current) => {
      const existing = current[item.conversationId] ?? [];
      return { ...current, [item.conversationId]: first ? [item, ...existing] : [...existing, item] };
    });
  };
  const updateQueuedPrompt = (conversationId: string, id: string, update: 'remove' | 'retry' | 'promote'): void => {
    setQueuedPromptsByConversation((current) => {
      const existing = current[conversationId] ?? [];
      const item = existing.find((entry) => entry.id === id);
      if (!item) return current;
      const remaining = existing.filter((entry) => entry.id !== id);
      return {
        ...current,
        [conversationId]: update === 'remove' ? remaining
          : update === 'promote' ? [{ ...item, status: 'queued' }, ...remaining]
            : existing.map((entry) => entry.id === id ? { ...entry, status: 'queued', error: undefined } : entry),
      };
    });
  };
  const updateComposerSelection = useCallback((patch: Partial<ComposerSelection>) => {
    setComposerSelections((current) => {
      const fallback: ComposerSelection = {
        agent: selectedAgent,
        execution: executionMode,
        route: selectedRoute,
        autonomy: selectedAutonomy,
        model: modelChoices[`${executionMode}:${selectedAgent}`] ?? '',
      };
      const next = { ...current, [activeDraftKey]: { ...fallback, ...(current[activeDraftKey] ?? {}), ...patch } };
      // Save in the selection event itself. This must survive an immediate app close,
      // before React has a chance to flush the state-effect below.
      try {
        window.localStorage.setItem(COMPOSER_SELECTIONS_KEY, JSON.stringify(next));
      } catch {
        // The rendered state remains usable when storage is unavailable.
      }
      return next;
    });
  }, [activeDraftKey, executionMode, modelChoices, selectedAgent, selectedAutonomy, selectedRoute]);

  useEffect(() => {
    if (activeConversationId) setOpenConversationIds((current) => current.includes(activeConversationId) ? current : [...current, activeConversationId]);
  }, [activeConversationId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COMPOSER_SELECTIONS_KEY, JSON.stringify(composerSelections));
    } catch {
      // Per-tab composer preferences are a convenience only.
    }
  }, [composerSelections]);

  useEffect(() => {
    if (!saveComposerQueue(queuedPromptsByConversation)) {
      setError('KAI could not save the message queue on this device. Keep the app open and retry delivery before closing it.');
    }
  }, [queuedPromptsByConversation]);
  useEffect(() => {
    try { window.localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(composerDrafts)); } catch { /* Drafts remain available until the app closes. */ }
  }, [composerDrafts]);
  useEffect(() => {
    try {
      window.localStorage.setItem(COMPOSER_CONTEXTS_KEY, JSON.stringify(composerContexts, (key, value) => key === 'dataUrl' ? undefined : value));
    } catch { /* The selected context remains available until the app closes. */ }
  }, [composerContexts]);
  useEffect(() => {
    const refresh = (event: StorageEvent): void => {
      if (event.key === QUEUE_KEY) setQueuedPromptsByConversation(loadComposerQueue());
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  useEffect(() => {
    const selection = composerSelections[activeDraftKey];
    if (!selection) return;
    setSelectedAgent(selection.agent);
    setExecutionMode(selection.execution);
    setSelectedRoute(selection.route);
    setSelectedAutonomy(selection.autonomy);
    if (selection.model) setModelChoices((current) => ({ ...current, [`${selection.execution}:${selection.agent}`]: selection.model }));
  }, [activeDraftKey]);
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
    { id: 'graph', label: 'Open Project Graph', description: 'See what blocks what on the board and which agent holds which card', run: () => setView('graph') },
    { id: 'studio', label: 'Open Project Studio', description: 'Interview a project idea and write the brief the board and agents work from', run: () => setView('studio') },
    { id: 'verification', label: 'Open Checks (test results per file)', description: 'See whether changed files are verified, stale or failing, and re-run checks', run: () => openOperations('verification') },
    { id: 'git', label: 'Open Git and GitHub', description: 'Branches, changes, commits, push and pull requests', run: () => setView('git') },
    { id: 'terminal', label: 'Toggle Terminal Panel', description: 'Show or hide the command terminal at the bottom of the window', shortcut: shortcutLabel(shortcuts, 'terminal'), run: () => setTerminalOpen((open) => !open) },
    { id: 'threads', label: 'Toggle Threads Panel', description: 'Show or hide the conversation threads on the left', shortcut: shortcutLabel(shortcuts, 'threads'), run: () => setThreadsOpen((open) => !open) },
    { id: 'context-panel', label: 'Toggle Context Panel', description: 'Show or hide project context on the right', shortcut: shortcutLabel(shortcuts, 'context-panel'), run: () => setContextOpen((open) => !open) },
    { id: 'command-palette', label: 'Show Command Palette', description: 'Search commands, conversations, and the brain', shortcut: shortcutLabel(shortcuts, 'command-palette'), run: () => setCommandPaletteOpen(true) },
    { id: 'shortcut-sheet', label: 'Open Shortcut Sheet', description: 'Review and customize keyboard shortcuts', shortcut: shortcutLabel(shortcuts, 'shortcuts'), run: () => setShortcutSheetOpen(true) },
    { id: 'diagnostics', label: 'Open Diagnostics', description: 'Service health, engine checks and a copyable bug report', run: () => openOperations('diagnostics') },
    { id: 'settings', label: 'Open Settings', description: 'Configure agents, routes, API providers, services, and MCP', run: () => setView('settings') },
    { id: 'reconfigure', label: 'Reconfigure KAI', description: 'Run the setup wizard again and use KAI Guide', run: () => { setSetupOpen(true); void refreshSetupStatus(); } },
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
      const startConversationId = preferredConversationId(nextBootstrap, nextConversations);
      const startChoice = startupAgentChoice(
        nextConversations.find((conversation) => conversation.id === startConversationId),
        rememberedAgentChoice(),
        { agent: nextBootstrap.settings.defaultAgent, route: nextBootstrap.settings.defaultRoute, execution: 'cli' },
      );
      setBootstrap(nextBootstrap);
      setConversations(nextConversations);
      setActiveConversationId(startConversationId);
      setCredentials(nextCredentials);
      setLogs(nextLogs);
      setAgentCapabilities(nextAgentCapabilities);
      setDirectApiCapability(nextDirectApiCapability);
      setSetupStatus(nextSetupStatus);
      setSetupOpen(!nextSetupStatus.complete);
      setSelectedAgent(startChoice.agent);
      setExecutionMode(startChoice.execution);
      setSelectedRoute(startChoice.route);
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
    if (!runningConversationIdsRef.current.includes(conversationId)) return;
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
            runQuestion: event.runQuestion,
            options: event.options,
            allowFreeText: event.allowFreeText,
          }]);
      return;
    }
      if (event.type === 'text.delta' && event.channel === 'assistant') {
        setStreamingTextByConversation((current) => ({ ...current, [conversationId]: `${current[conversationId] ?? ''}${event.text}` }));
        return;
      }
      // Keep tool and lifecycle events in the active transcript as they arrive.
      // The completed run later saves the authoritative event list; this only
      // fills the otherwise silent period while an agent is working.
      setConversations((current) => current.map((conversation) => (
        conversation.id !== conversationId || conversation.events.some((item) => item.id === event.id)
          ? conversation
          : { ...conversation, events: [...conversation.events, event] }
      )));
  }), []);

  // A run begun in the main process — Auto carrying a task, the board working a card, a schedule firing — announces
  // itself here, because the composer's own send is not the only way a conversation gets worked on. Taking it up is
  // what lets its events through the gate below, and pulling the record shows the turn the run was given: the window
  // was holding the conversation as it stood before that turn was saved, so Auto worked an empty-looking transcript.
  useEffect(() => window.kaiDesktop.onAgentRunState(({ conversationId, status }) => {
    if (status === 'started') {
      setRunningConversationIds((current) => current.includes(conversationId) ? current : [...current, conversationId]);
      setFailedConversationIds((current) => current.filter((id) => id !== conversationId));
    } else {
      setRunningConversationIds((current) => current.filter((id) => id !== conversationId));
      setStreamingTextByConversation((current) => { const next = { ...current }; delete next[conversationId]; return next; });
    }
    // On both ends: the request is saved before the run starts, the reply and its events after it ends.
    void refreshConversationRecord(conversationId).catch(() => undefined);
  }), []);

  // Auto parking on a person is not visible in the run's own state — the session stays alive across turns — so the
  // parked conversations are tracked here. Without it a run stopped at a cap would show a Pause button and no way to
  // carry on from the screen it was started on.
  useEffect(() => window.kaiDesktop.onAutoChanged((status) => {
    setAutoWaitingConversationIds((current) => status.phase === 'waiting-for-you'
      ? (current.includes(status.conversationId) ? current : [...current, status.conversationId])
      : current.filter((id) => id !== status.conversationId));
  }), []);

  useEffect(() => {
    void window.kaiDesktop.reportView(view, activeConversationId).catch(() => undefined);
  }, [view, activeConversationId]);

  const applicationLoaded = bootstrap !== null;
  useEffect(() => {
    // Wait for startup to restore the choice, so the placeholder state never overwrites it.
    if (!applicationLoaded) return;
    rememberAgentChoice({ agent: selectedAgent, route: selectedRoute, execution: executionMode });
  }, [applicationLoaded, executionMode, selectedAgent, selectedRoute]);

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
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = bootstrap?.activeProjectId ?? null;
  useEffect(() => window.kaiDesktop.onOpenConversation(({ conversationId, projectId, openTab }) => {
    void (async () => {
      // A conversation belongs to a project; switch to it first or the composer would show the wrong one.
      if (projectId && projectId !== activeProjectIdRef.current) await openProjectRef.current(projectId, 'stay');
      // Auto hands a split's remainder to a conversation of its own, so it needs a tab, not just to be shown.
      if (openTab) setOpenConversationIds((current) => current.includes(conversationId) ? current : [...current, conversationId]);
      await openConversationRef.current(conversationId);
    })();
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
      setView('workspace');
    }
  }

  function openOperations(tab: OperationsTab): void {
    setOperationsTab(tab);
    setView('operations');
  }

  async function openProject(id: string, destination: 'workspace' | 'code' | 'stay' = 'workspace'): Promise<BootstrapPayload | null> {
    const next = await perform(() => window.kaiDesktop.openProject(id).then(unwrap), 'Opening project');
    if (next) {
      setBootstrap(next);
      setActiveConversationId(preferredConversationId(next, conversations));
      if (destination !== 'stay') setView(destination);
    }
    return next ?? null;
  }

  async function openStudioProject(
    studioProjectId: string,
    destination: 'composer' | 'editor' | 'generate',
  ): Promise<void> {
    const launch = await perform(
      () => window.kaiDesktop.launchStudioProject({ projectId: studioProjectId, destination }).then(unwrap),
      destination === 'composer' ? 'Preparing the composer' : destination === 'generate' ? 'Starting project generation' : 'Opening the code editor',
    );
    if (!launch) return;
    const next = await openProject(launch.projectId, 'stay');
    if (!next) return;
    if (destination === 'editor') {
      setView('code');
      return;
    }

    const conversation = await perform(
      () => window.kaiDesktop.createConversation(launch.projectId, launch.prompt).then(unwrap),
      'Creating conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    if (destination === 'generate') {
      setView('workspace');
      await runConversation(conversation, launch.prompt);
      return;
    }
    setWorkspaceCommand({ kind: 'prompt', nonce: Date.now(), prompt: launch.prompt });
    setView('workspace');
  }

  async function openProjectInNewWindow(id: string): Promise<void> {
    await perform(() => window.kaiDesktop.newWindow(id).then(unwrap), 'Opening project in a new window');
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
      setSettingsDestination({ category: 'connections', nonce: Date.now() });
      setView('settings');
    } else if (action === 'open_tutor') {
      setSetupOpen(false);
      setSettingsDestination({ category: 'connections', nonce: Date.now() });
      setView('settings');
      setAgentNotice('Open Learning Tutor in Settings to choose a provider and securely save its API key. It is optional and separate from your coding-agent connection.');
    } else if (action === 'open_github') {
      setSetupOpen(false);
      const githubCheck = setupStatus?.checks.find((check) => check.id === 'github');
      if (githubCheck?.detail.includes('not installed')) {
        window.open('https://cli.github.com/', '_blank', 'noopener,noreferrer');
        setAgentNotice('Install GitHub CLI, then choose Reconfigure KAI → Connect GitHub to sign in.');
      } else {
        setView('git');
        setTerminalCommand({ command: 'gh auth login', nonce: Date.now() });
        setTerminalOpen(true);
        setAgentNotice('GitHub sign-in is running in KAI’s Terminal. Follow the prompts and approve access in your browser; GitHub CLI stores the sign-in securely.');
      }
    } else if (action === 'open_remote') {
      setSetupOpen(false);
      setSettingsDestination({ category: 'services', nonce: Date.now() });
      setView('settings');
      setAgentNotice('Turn on KAI Remote in Services and access, then pair each device with its own link.');
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

  /**
   * Empties the project list. Asked first, because the folders stay but KAI forgets which ones it had and every
   * per-project setting that went with them — the list is a convenience, and losing it by a stray click would not be.
   */
  async function clearProjects(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Clear the project list?',
      detail: 'KAI forgets every project in the list, along with its per-project settings. The folders themselves are not touched — open one again and it comes back with a fresh start.',
      confirmLabel: 'Clear list',
    });
    if (!confirmed) return;
    const next = await perform(() => window.kaiDesktop.clearProjects().then(unwrap), 'Clearing projects');
    if (next) setBootstrap(next);
  }

  /**
   * Takes the composer's agent, mode, route and autonomy for the conversation about to be worked in.
   *
   * The order of who has the last word is in `composerSettingsFor`, and the first of the three is the point: the
   * choice the person made *in this conversation* outlives anything the record says, so opening it again — from a
   * thread, from the Studio, from Auto making its own tab — cannot quietly put the composer back to CLI and Ask.
   * Before this, a reopen overwrote what they had chosen, and the record's own last run (or its absence) decided.
   */
  function adoptConversationSettings(conversation: ConversationRecord): void {
    const chosen = composerSettingsFor({
      stored: composerSelections[conversation.id],
      recorded: {
        ...(conversation.activeAgent ? { agent: conversation.activeAgent } : {}),
        ...(conversation.execution ? { execution: conversation.execution } : {}),
        ...(conversation.route ? { route: conversation.route } : {}),
        ...(conversation.autonomy ? { autonomy: conversation.autonomy } : {}),
      },
      current: { agent: selectedAgent, execution: executionMode, route: selectedRoute, autonomy: selectedAutonomy },
    });
    setSelectedAgent(chosen.agent);
    setExecutionMode(chosen.execution);
    setSelectedRoute(chosen.route);
    setSelectedAutonomy(chosen.autonomy);
  }

  async function openConversation(id: string): Promise<void> {
    const existing = conversations.find((conversation) => conversation.id === id);
    if (existing) {
      setActiveConversationId(id);
      adoptConversationSettings(existing);
      // A failure from whatever chat was open before must not bleed into the one being switched to.
      setError(null);
      setAgentNotice(null);
      setProxyContinuationAgent(null);
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
    adoptConversationSettings(conversation);
    setAgentNotice(null);
    setProxyContinuationAgent(null);
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
    setError(null);
    setAgentNotice(null);
    setProxyContinuationAgent(null);
    setView('workspace');
    await runConversation(conversation, prompt, options);
  }

  async function createEmptyConversation(): Promise<void> {
    if (!bootstrap) return;
    const conversation = await perform(
      () => window.kaiDesktop.createConversation(activeProject?.id ?? null, '').then(unwrap),
      'Opening new conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current]);
    setOpenConversationIds((current) => current.includes(conversation.id) ? current : [...current, conversation.id]);
    setActiveConversationId(conversation.id);
    // The composer keeps the choices it is showing. A new thread is the same person in the same moment, and this used
    // to hand them the app's defaults instead — including a hardcoded CLI, which undid an API choice on the way past.
    // The defaults still have their say where they belong: at startup, and in Settings.
    setError(null);
    setAgentNotice(null);
    setProxyContinuationAgent(null);
    setView('workspace');
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
    options: WorkspaceSendOptions & { agent?: AgentId; execution?: ExecutionMode; route?: RouteMode; autonomy?: AutonomyMode; model?: string; clientMessageId?: string } = {},
  ): Promise<void> {
    if (!bootstrap) return;
    const runAgentId = options.agent ?? selectedAgent;
    const runExecution = options.execution ?? executionMode;
    const runAutonomy = options.autonomy ?? selectedAutonomy;
    const apiRun = runExecution === 'api';
    const capability = agentCapabilities.find((agent) => agent.id === runAgentId);
    const requestedRoute = options.route ?? selectedRoute;
    const runRoute = !apiRun && !capability?.supportsRoutes.includes('proxy') ? 'direct' : requestedRoute;
    // The proxy supplies its own key, so a signed-out CLI can still run through it.
    const proxyWithoutAccount = runRoute === 'proxy' && capability?.state === 'signed_out';
    if (!apiRun && !capability?.available && !proxyWithoutAccount) {
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

    // A conversation that has grown long is summarised first, so every later request stays small. A failure here
    // never blocks the message: the run simply goes ahead with the full history.
    if (estimateConversationTokens(conversation) >= COMPACTION_WARNING_TOKENS) {
      setAgentNotice('This conversation has grown long, so KAI is summarising the older turns first.');
      const compacted = await window.kaiDesktop.compactConversation(conversation.id).then(unwrap).catch(() => null);
      if (compacted) {
        setConversations((current) => current.map((item) => item.id === compacted.id ? compacted : item));
        setAgentNotice(`Summarised ${compacted.compaction?.originalTurns ?? 0} earlier turns to keep this conversation fast.`);
      }
    } else {
      setAgentNotice(null);
    }
    setProxyContinuationAgent(null);
    setStreamingTextByConversation((current) => ({ ...current, [conversation.id]: '' }));
    setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== conversation.id));
    setRunningConversationIds((current) => current.includes(conversation.id) ? current : [...current, conversation.id]);
    setPausedConversationIds((current) => current.filter((id) => id !== conversation.id));
    setFailedConversationIds((current) => current.filter((id) => id !== conversation.id));
    localRunsInFlight.current.add(conversation.id);
    try {
      const result = unwrap(await window.kaiDesktop.runAgent({
          conversationId: conversation.id,
          prompt,
          ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
          agent: runAgentId,
          execution: runExecution,
          route: runRoute,
          autonomy: runAutonomy,
          ...(() => {
            const model = options.model ?? composerSelections[conversation.id]?.model ?? modelChoices[`${runExecution}:${runAgentId}`] ?? '';
            return runExecution === 'cli' && runAgentId === 'codex' && !isSupportedCodexCliModel(model)
              ? {}
              : model ? { model } : {};
          })(),
          ...(options.goal ? { goal: options.goal } : {}),
          ...(options.skills?.length ? { skills: options.skills } : {}),
          ...(options.selectedPaths?.length ? { selectedPaths: options.selectedPaths } : {}),
          // Files picked in the composer already travel as selectedPaths; the images and memory notes travel as chips.
          ...(() => {
            const chips = (options.contextChips ?? []).filter((chip) => chip.type !== 'file');
            return chips.length ? { contextChips: chips } : {};
          })(),
        }));
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      if (result.signInRequired && capability) {
        markSignedOut(capability);
      } else if (result.error) {
        if (!apiRun && runRoute === 'direct' && capability?.supportsRoutes.includes('proxy') && looksLikeAccountLimit(result.error)) {
          setProxyContinuationAgent(runAgentId);
          setAgentNotice(`${capability.displayName}'s usage limit on your subscription was reached. Continue this run through your paid Universal Proxy route instead?`);
        } else {
          setFailedConversationIds((current) => current.includes(conversation.id) ? current : [...current, conversation.id]);
          if (conversation.id === activeConversationId) setError(result.error);
        }
      }
    } catch (caught) {
      setFailedConversationIds((current) => current.includes(conversation.id) ? current : [...current, conversation.id]);
      if (conversation.id === activeConversationId) setError(messageOf(caught));
    } finally {
      localRunsInFlight.current.delete(conversation.id);
      setRunningConversationIds((current) => current.filter((id) => id !== conversation.id));
      setPausedConversationIds((current) => current.filter((id) => id !== conversation.id));
      setStreamingTextByConversation((current) => { const next = { ...current }; delete next[conversation.id]; return next; });
      setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== conversation.id));
    }
  }

  // The app owns delivery, so queued turns keep moving when the Workspace view is closed or another chat is open.
  useEffect(() => {
    if (!bootstrap || busy) return;
    for (const [conversationId, items] of Object.entries(queuedPromptsByConversation)) {
      const next = items[0];
      if (!next || next.status !== 'queued' || runningConversationIds.includes(conversationId)
        || localRunsInFlight.current.has(conversationId)
        || dispatchingQueuedConversations.current.has(conversationId)) continue;
      dispatchingQueuedConversations.current.add(conversationId);
      setQueuedPromptsByConversation((current) => ({
        ...current,
        [conversationId]: (current[conversationId] ?? []).map((item) => item.id === next.id
          ? { ...item, status: 'sending' } : item),
      }));
      void (async () => {
        try {
          const latest = await window.kaiDesktop.getConversation(conversationId).then(unwrap);
          if (!latest) throw new Error('The conversation no longer exists.');
          if (!queuedPromptWasAccepted(latest, next.id)) {
            await runConversation(latest, next.text, { ...next.options, clientMessageId: next.id });
          }
          const updated = await window.kaiDesktop.getConversation(conversationId).then(unwrap);
          if (!updated || !queuedPromptWasAccepted(updated, next.id)) {
            throw new Error('KAI did not accept this message. Check the agent connection and retry.');
          }
          setQueuedPromptsByConversation((current) => ({
            ...current,
            [conversationId]: (current[conversationId] ?? []).filter((item) => item.id !== next.id),
          }));
        } catch (caught) {
          setQueuedPromptsByConversation((current) => ({
            ...current,
            [conversationId]: (current[conversationId] ?? []).map((item) => item.id === next.id
              ? { ...item, status: 'blocked', error: messageOf(caught) } : item),
          }));
        } finally {
          dispatchingQueuedConversations.current.delete(conversationId);
        }
      })();
    }
  }, [bootstrap, busy, conversations, queuedPromptsByConversation, runningConversationIds]);

  async function cancelConversation(): Promise<void> {
    if (!activeConversationId || !runningConversationIds.includes(activeConversationId)) return;
    // Auto keeps a session alive across turns, keyed by conversation. Cancelling the run in flight on its own leaves
    // that session free to start the next turn, so Stop looked as though it had done nothing. End the session first.
    // A conversation with no Auto session simply has nothing to stop, so a refusal here is not worth reporting.
    await window.kaiDesktop.stopAuto({ conversationId: activeConversationId }).catch(() => undefined);
    const cancelled = await perform(
      () => window.kaiDesktop.cancelAgent(activeConversationId).then(unwrap),
      'Stopping agent',
    );
    if (cancelled) {
      setPendingApprovals((current) => current.filter((approval) => approval.conversationId !== activeConversationId));
      setAgentNotice('Stopping the current agent run.');
      // Keep the run marked active until its result settles. A queued follow-up must not begin beside a process
      // that has only been asked to stop and is still cleaning up.
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

  async function respondToApproval(approved: boolean, useFullAccess = false, answer?: string, requestId?: string): Promise<void> {
    const approval = requestId
      ? pendingApprovals.find((item) => item.requestId === requestId)
      : pendingApproval;
    if (!approval) return;
    if (useFullAccess) {
      setSelectedAutonomy('full');
      updateComposerSelection({ autonomy: 'full' });
      setAgentNotice('Full access is selected for this conversation’s next run.');
    }
    setPendingApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
    await perform(
      () => window.kaiDesktop.respondToApproval({
        conversationId: approval.conversationId,
        requestId: approval.requestId,
        approved,
        ...(answer ? { answer } : {}),
      }).then(unwrap),
      // Answering a question about the run is not approving a change to the project, and saying so would name the
      // wrong thing in the one place the person looks to check what their click did.
      approval.options
        ? (answer ? `Answered: ${answer}` : 'Declined to answer')
        : approval.runQuestion
          ? (approved ? 'Continuing the run' : 'Finishing the run')
          : (approved ? 'Approving project change' : 'Denying project change'),
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

  function markSignedOut(capability: AgentCapability): void {
    const reason = `${capability.displayName} is not signed in. Use Sign in to connect your account, then send your message again.`;
    setAgentCapabilities((current) => current.map((item) => (item.id === capability.id
      ? { ...item, available: false, state: 'signed_out', unavailableReason: reason }
      : item)));
    setAgentNotice(reason);
  }

  async function signInAgent(agent: AgentId): Promise<void> {
    const result = await perform(
      () => window.kaiDesktop.signInAgent(agent).then(unwrap),
      `Opening ${agent} sign-in`,
    );
    if (!result) return;
    setAgentNotice(result.message);
    if (result.started) await watchAgentSetup(agent, (state) => state === 'ready', 'is signed in and ready.', 180_000);
  }

  async function installAgent(agent: AgentId): Promise<void> {
    const result = await perform(
      () => window.kaiDesktop.installAgent(agent).then(unwrap),
      `Opening ${agent} installer`,
    );
    if (!result) return;
    setAgentNotice(result.message);
    if (!result.started) return;
    await watchAgentSetup(
      agent,
      (state) => state !== 'not_installed',
      'is installed.',
      600_000,
      (capability) => (capability.state === 'signed_out' ? ' Use Sign in to connect your account.' : ''),
    );
  }

  /** Re-checks one agent until an install or sign-in window finishes, so the user does not have to press Refresh. */
  async function watchAgentSetup(
    agent: AgentId,
    done: (state: AgentCapability['state']) => boolean,
    doneMessage: string,
    limitMs: number,
    followUp: (capability: AgentCapability) => string = () => '',
  ): Promise<void> {
    const attempt = ++signInAttempt.current;
    for (let elapsed = 0; elapsed < limitMs && attempt === signInAttempt.current; elapsed += 4_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const capabilities = await window.kaiDesktop.agentCapabilities().then(unwrap).catch(() => null);
      const current = capabilities?.find((item) => item.id === agent);
      if (!capabilities || !current || attempt !== signInAttempt.current) continue;
      if (done(current.state)) {
        setAgentCapabilities(capabilities);
        setAgentNotice(`${current.displayName} ${doneMessage}${followUp(current)}`);
        return;
      }
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    const removed = await perform(() => window.kaiDesktop.deleteConversation(id).then(unwrap), 'Deleting conversation');
    if (removed === null) return;
    setQueuedPromptsByConversation((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
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

  async function forkConversation(id: string, throughTurnId?: string): Promise<void> {
    const original = conversations.find((item) => item.id === id) ?? await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!original) return;
    const throughIndex = throughTurnId ? original.turns.findIndex((turn) => turn.id === throughTurnId) : -1;
    const turnsToCopy = throughIndex >= 0 ? original.turns.slice(0, throughIndex + 1) : original.turns;
    const now = new Date().toISOString();
    const forked: ConversationRecord = {
      ...original,
      id: `conv_${crypto.randomUUID()}`,
      title: `${original.title} (branch)`,
      createdAt: now,
      updatedAt: now,
      archived: false,
      unread: false,
      // Provider-native sessions belong to the original thread. Reusing one in a copy can trigger
      // resume failures (for example, "no rollout found"), so the branch starts a fresh CLI session.
      agentSessionId: undefined,
      turns: turnsToCopy.map((turn) => ({ ...turn, id: `turn_${crypto.randomUUID()}` })),
      // Events describe a provider run and may refer to turns after the branch point. The copied transcript is
      // the branch context; new activity begins cleanly in the new conversation.
      events: [],
    };
    await saveConversationRecord(forked);
    setActiveConversationId(forked.id);
    setError(null);
    setProxyContinuationAgent(null);
    setView('workspace');
    setAgentNotice(`Branched into "${forked.title}". Continue from here without changing the original chat.`);
  }

  async function saveSettings(update: SettingsUpdate): Promise<boolean> {
    const previousDefault = bootstrap?.settings.defaultAgent;
    const settings = await perform(() => window.kaiDesktop.updateSettings(update).then(unwrap), 'Saving settings');
    if (settings) {
      const services = await window.kaiDesktop.serviceStatus().then(unwrap);
      setBootstrap((current) => (current ? { ...current, settings, services } : current));
      // Saving an unrelated settings card must not swap the agent you picked.
      if (!activeConversation && settings.defaultAgent !== previousDefault) setSelectedAgent(settings.defaultAgent);
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

  /** Saves (or, with null, removes) the checks, hooks and review for the open project; true when it was stored. */
  async function saveProjectAutomation(automation: ProjectPreferences['automation'] | null): Promise<boolean> {
    if (!activeProject) return false;
    const base: ProjectPreferences = projectPreferences ?? { schemaVersion: 1, projectId: activeProject.id };
    const { automation: _previous, ...rest } = base;
    const next: ProjectPreferences = automation ? { ...rest, automation } : rest;
    const saved = await perform(() => window.kaiDesktop.updatePreferences(next).then(unwrap), 'Saving project automation');
    if (saved) setProjectPreferences(saved);
    return Boolean(saved);
  }

  /** Saves (or, with null, removes) the team just for the open project; true when it was stored. */
  async function saveProjectTeam(team: AgentTeam | null): Promise<boolean> {
    if (!activeProject) return false;
    const base: ProjectPreferences = projectPreferences ?? { schemaVersion: 1, projectId: activeProject.id };
    const { agentTeam: _previous, ...rest } = base;
    const next: ProjectPreferences = team ? { ...rest, agentTeam: team } : rest;
    const saved = await perform(() => window.kaiDesktop.updatePreferences(next).then(unwrap), 'Saving the project team');
    if (saved) setProjectPreferences(saved);
    return Boolean(saved);
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

  /** Summarises the open conversation and carries on from that summary in a new tab; the old tab is left as it was. */
  async function continueInNewTab(): Promise<void> {
    if (!bootstrap || !activeConversation) return;
    const source = activeConversation;
    const compacted = await perform(
      () => window.kaiDesktop.compactConversation(source.id).then(unwrap),
      'Summarising this conversation',
    );
    if (!compacted?.compaction) return;
    setConversations((current) => current.map((item) => item.id === compacted.id ? compacted : item));
    const fresh = await perform(
      () => window.kaiDesktop.createConversation(source.projectId, '').then(unwrap),
      'Opening a new tab',
    );
    if (!fresh) return;
    const now = new Date().toISOString();
    const seeded: ConversationRecord = {
      ...fresh,
      title: `${source.title} (continued)`.slice(0, 120),
      ...(source.activeAgent ? { activeAgent: source.activeAgent } : {}),
      ...(source.execution ? { execution: source.execution } : {}),
      ...(source.route ? { route: source.route } : {}),
      ...(source.autonomy ? { autonomy: source.autonomy } : {}),
      turns: [
        { id: `turn_${crypto.randomUUID()}`, role: 'user', text: `I am continuing "${source.title}" in a new conversation. Here is a briefing of the earlier work:\n\n${compacted.compaction.summary}`, createdAt: now },
        { id: `turn_${crypto.randomUUID()}`, role: 'assistant', text: 'I have the briefing and will carry on from here.', createdAt: now },
      ],
    };
    const saved = await perform(() => window.kaiDesktop.saveConversation(seeded).then(unwrap), 'Saving the new tab');
    if (!saved) return;
    setConversations((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setOpenConversationIds((current) => current.includes(saved.id) ? current : [...current, saved.id]);
    setActiveConversationId(saved.id);
    setView('workspace');
    setAgentNotice('Opened a new tab that continues from a summary of the earlier conversation.');
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
    if (!activeConversationId || !runningConversationIds.includes(activeConversationId)) return;
    // Both levels, the same treatment Stop already gives: Auto's own loop, or it would go on starting turns while the
    // one in flight sits paused. A call with nothing to do refuses without an error, so neither has to know which
    // kind of run this is.
    await window.kaiDesktop.pauseAuto({ conversationId: activeConversationId }).catch(() => undefined);
    // What the runtime answered, not what was hoped for: a run with no process to hold yet cannot be suspended, and
    // an API run only pauses between provider rounds. Claiming "paused" regardless is how the button came to promise
    // something the app did not do.
    const paused = await window.kaiDesktop.pauseAgent(activeConversationId).then(unwrap).catch(() => false);
    if (!paused) {
      setAgentNotice('This run cannot be paused from here — use Stop to end it.');
      return;
    }
    setPausedConversationIds((current) => current.includes(activeConversationId) ? current : [...current, activeConversationId]);
    setAgentNotice('The run is paused. It will continue from the same point.');
  }

  async function resumeConversation(): Promise<void> {
    if (!activeConversationId || !runningConversationIds.includes(activeConversationId)) return;
    await window.kaiDesktop.resumeAuto({ conversationId: activeConversationId }).catch(() => undefined);
    await window.kaiDesktop.resumeAgent(activeConversationId).catch(() => undefined);
    setPausedConversationIds((current) => current.filter((id) => id !== activeConversationId));
    setAutoWaitingConversationIds((current) => current.filter((id) => id !== activeConversationId));
    setAgentNotice(null);
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
            onOpen={(id, destination) => void openProject(id, destination)}
            onOpenInNewWindow={(id) => void openProjectInNewWindow(id)}
            onRemove={(id) => void removeProject(id)}
          />
        );
      case 'brain':
        return (
          <ServiceView
            service={serviceFor(bootstrap, 'cognitive1')}
            kind="brain"
            busy={Boolean(busy) && !activeRunning}
            onConfigure={() => setView('settings')}
            onStart={() => void controlService('cognitive1', 'start')}
            onStop={() => void controlService('cognitive1', 'stop')}
            onRestart={() => void controlService('cognitive1', 'restart')}
            onCopyToken={() => void copyServiceToken('cognitive1')}
            onRotateToken={() => void rotateServiceToken('cognitive1')}
          >
            <Cognitive1Panel service={serviceFor(bootstrap, 'cognitive1')} projects={bootstrap.projects} settings={bootstrap.settings} onSaveSettings={saveSettings} />
          </ServiceView>
        );
      case 'rules':
        return <RulesView />;
      case 'proxy':
        return (
          <div className="page-view">
            <ProxyPanel
              service={serviceFor(bootstrap, 'universalProxy')}
              settings={bootstrap.settings}
              busy={Boolean(busy)}
              logs={logs}
              credentialStatus={credentials}
              onSave={(update) => saveSettings(update)}
              onSaveCredential={(id, value) => saveCredential(id, value)}
              onClearCredential={(id) => clearCredential(id)}
              onReload={loadApplication}
              onStart={() => void controlService('universalProxy', 'start')}
              onStop={() => void controlService('universalProxy', 'stop')}
              onRestart={() => void controlService('universalProxy', 'restart')}
              onCopyToken={() => void copyServiceToken('universalProxy')}
              onRotateToken={() => void rotateServiceToken('universalProxy')}
            />
          </div>
        );
      case 'workflows':
        return (
          <WorkflowsView
            activeProject={activeProject}
            agentCapabilities={agentCapabilities}
            settings={bootstrap.settings}
            busy={Boolean(busy)}
            incomingPlan={incomingTeamPlan}
            onIncomingPlanUsed={() => setIncomingTeamPlan(null)}
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
      case 'commands':
        return <CommandsView onOpenTerminal={() => setTerminalOpen(true)} />;
      case 'git':
        return <GitView activeProject={activeProject} onOpenTerminal={() => setTerminalOpen(true)} onSignInGitHub={() => { setTerminalCommand({ command: 'gh auth login', nonce: Date.now() }); setTerminalOpen(true); }} />;
      case 'tasks':
        return <TasksView activeProject={activeProject} cognitive1Ready={serviceFor(bootstrap, 'cognitive1').status === 'ready'} onStartTask={async (prompt) => { setView('workspace'); await createConversation(prompt); }} />;
      case 'graph':
        return <GraphView />;
      case 'studio':
        return (
          <StudioView
            activeProject={activeProject}
            projects={bootstrap.projects}
            onOpenSettings={() => setView('settings')}
            onLaunchProject={openStudioProject}
            onPlanForTeam={(plan) => { setIncomingTeamPlan(plan); setView('workflows'); }}
          />
        );
      case 'code':
        return null;
      case 'operations':
        return <OperationsView initialTab={operationsTab} activeProject={activeProject} onResume={resumeInterruptedRun} onRecoveryChanged={() => void refreshInterrupted()} />;
      case 'settings':
        return (
          <SettingsView
            activeProject={activeProject ? { id: activeProject.id, name: activeProject.name } : null}
            projectTeam={projectPreferences?.agentTeam ?? null}
            onSaveProjectTeam={(team) => saveProjectTeam(team)}
            projectAutomation={projectPreferences?.automation ?? null}
            onSaveProjectAutomation={(automation) => saveProjectAutomation(automation)}
            settings={bootstrap.settings}
            credentialStatus={credentials}
            dataLocations={bootstrap.dataLocations}
            logs={logs}
            busy={Boolean(busy)}
            services={bootstrap.services}
            onSave={(update) => saveSettings(update)}
            onControlService={(kind, action) => void controlService(kind, action)}
            onImportBrain={() => void importBrain()}
            onSaveCredential={(id, value) => saveCredential(id, value)}
            onClearCredential={(id) => clearCredential(id)}
            onListProviderModels={(request) => window.kaiDesktop.listProviderModels(request).then(unwrap)}
            onListBackups={listConfigBackups}
            onCreateBackup={createConfigBackup}
            onRestoreBackup={restoreConfigBackup}
            onDeleteBackup={deleteConfigBackup}
            destination={settingsDestination}
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
            composerDraft={composerDrafts[activeDraftKey] ?? ''}
            onComposerDraftChange={updateComposerDraft}
            selectedFiles={activeComposerContext.selectedFiles}
            setSelectedFiles={(update) => setComposerContextField('selectedFiles', update)}
            contextChips={activeComposerContext.contextChips}
            setContextChips={(update) => setComposerContextField('contextChips', update)}
            selectedSkills={activeComposerContext.selectedSkills}
            setSelectedSkills={(update) => setComposerContextField('selectedSkills', update)}
            onInterjectionDelivered={(conversationId, text) => setComposerDrafts((current) => current[conversationId]?.trim() === text
              ? { ...current, [conversationId]: '' } : current)}
            commandRequest={workspaceCommand}
            onCommandHandled={() => setWorkspaceCommand(null)}
            agentCapabilities={agentCapabilities}
            directApiCapability={directApiCapability}
            selectedAgent={selectedAgent}
            executionMode={executionMode}
            selectedRoute={selectedRoute}
            selectedAutonomy={selectedAutonomy}
            proxyReady={serviceFor(bootstrap, 'universalProxy').status === 'ready'}
            proxyContinuationAgent={proxyContinuationAgent}
            streamingText={streamingText}
            running={activeRunning}
            paused={activePaused}
            awaitingApproval={Boolean(activeQuestion) || isApprovalForConversation(pendingApproval?.conversationId, activeConversation?.id)}
            pendingQuestion={activeQuestion?.options ? { ...activeQuestion, options: activeQuestion.options } : null}
            onAnswerQuestion={(requestId, answer) => void respondToApproval(Boolean(answer), false, answer ?? undefined, requestId)}
            notice={agentNotice}
            onSelectExecution={(mode) => {
              setExecutionMode(mode);
              updateComposerSelection({ execution: mode });
              rememberAgentChoice({ agent: selectedAgent, route: selectedRoute, execution: mode });
              setAgentNotice(null);
            }}
            onSelectAgent={(agent) => {
              setSelectedAgent(agent);
              const capability = agentCapabilities.find((item) => item.id === agent);
              const route = capability?.supportsRoutes.includes('proxy') ? selectedRoute : 'direct';
              if (route !== selectedRoute) setSelectedRoute(route);
              updateComposerSelection({ agent, route });
              rememberAgentChoice({ agent, route, execution: executionMode });
              setAgentNotice(null);
            }}
            onSelectRoute={(route) => {
              setSelectedRoute(route);
              updateComposerSelection({ route });
              rememberAgentChoice({ agent: selectedAgent, route, execution: executionMode });
              if (route === 'proxy') setProxyContinuationAgent(null);
              setAgentNotice(null);
            }}
            onContinueViaProxy={(agent) => {
              if (serviceFor(bootstrap, 'universalProxy').status !== 'ready') {
                setError('Start Universal Proxy before continuing this agent through its proxy route.');
                return;
              }
              setExecutionMode('cli');
              setSelectedAgent(agent);
              setSelectedRoute('proxy');
              updateComposerSelection({ execution: 'cli', agent, route: 'proxy' });
              rememberAgentChoice({ agent, route: 'proxy', execution: 'cli' });
              setProxyContinuationAgent(null);
              setAgentNotice(`${agentCapabilities.find((item) => item.id === agent)?.displayName ?? agent} now uses the proxy for the next message in this conversation.`);
            }}
            onSelectAutonomy={(autonomy) => {
              setSelectedAutonomy(autonomy);
              updateComposerSelection({ autonomy });
              setAgentNotice(null);
            }}
            onUpdatePreferences={saveProjectPreferences}
            onUpdateConversation={saveConversationRecord}
            onChooseProject={() => void chooseProject()}
            onCreateConversation={(prompt, options) => void createConversation(prompt, options)}
            onBranchTurn={(turnId) => { if (activeConversation) void forkConversation(activeConversation.id, turnId); }}
            onSend={(prompt, options) => void sendPrompt(prompt, options)}
            queuedPrompts={activeConversationId ? queuedPromptsByConversation[activeConversationId] ?? [] : []}
            onQueuePrompt={queuePrompt}
            onUpdateQueuedPrompt={(id, update) => { if (activeConversationId) updateQueuedPrompt(activeConversationId, id, update); }}
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
            onInstall={(agent) => void installAgent(agent)}
            onRefreshAgents={() => void refreshAgentCapabilities()}
            onOpenSettings={() => setView('settings')}
            onOpenUsage={() => setView('usage')}
            selectedModel={selectedWorkspaceModel}
            onSelectModel={(model) => {
              if (executionMode === 'cli' && selectedAgent === 'codex' && !isSupportedCodexCliModel(model)) {
                setError('This Codex ChatGPT connection supports GPT-6 Astra or Default. GPT-6 Sol requires an API connection.');
                return;
              }
              setModelChoices((current) => ({ ...current, [`${executionMode}:${selectedAgent}`]: model }));
              updateComposerSelection({ model });
            }}
            interruptedRuns={interruptedRuns}
            onOpenRecovery={() => openOperations('recovery')}
            onOpenVerification={() => openOperations('verification')}
            onOpenRules={() => setView('rules')}
            onOpenWorkflows={() => setView('workflows')}
            onCompactConversation={() => void compactActiveConversation()}
            onContinueInNewTab={() => void continueInNewTab()}
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
        terminalOpen={terminalOpen}
        shortcuts={shortcuts}
        onChoose={() => void chooseProject()}
        onOpenProject={(id) => void openProject(id)}
        onRemoveProject={(id) => void removeProject(id)}
        onClearProjects={() => void clearProjects()}
        onNewWindow={() => void openNewWindow()}
        onToggleTheme={toggleTheme}
        onOpenSearch={() => setCommandPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutSheetOpen(true)}
        onToggleThreads={() => setThreadsOpen((open) => !open)}
        onToggleContext={() => setContextOpen((open) => !open)}
        onTogglePreview={() => setPreviewOpen((open) => !open)}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
        onOpenTour={() => setTourListOpen((open) => !open)}
        tourListOpen={tourListOpen}
      />
      {view === 'workspace' && (
        <nav className="conversation-tab-strip" role="tablist" aria-label="Open conversations">
          {openConversations.map((conversation) => {
            const running = runningConversationIds.includes(conversation.id);
            const approval = pendingApprovals.some((item) => item.conversationId === conversation.id);
            const failed = failedConversationIds.includes(conversation.id);
            return <button key={conversation.id} type="button" role="tab" aria-selected={conversation.id === activeConversationId} className={`conversation-tab ${conversation.id === activeConversationId ? 'active' : ''}`} onClick={() => void openConversation(conversation.id)}><span className={`conversation-tab-state ${approval ? 'approval' : failed ? 'failed' : running ? 'running' : 'idle'}`} /><span className="truncate">{conversation.title}</span><span className="conversation-tab-close" onClick={(event) => { event.stopPropagation(); setOpenConversationIds((current) => current.filter((id) => id !== conversation.id)); if (conversation.id === activeConversationId) setActiveConversationId(openConversations.find((item) => item.id !== conversation.id)?.id ?? null); }}>×</span></button>;
          })}
          <button type="button" className="conversation-tab-new" title="New conversation" aria-label="New conversation" onClick={() => void createEmptyConversation()}>+</button>
        </nav>
      )}
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
                projectId={activeProject?.id ?? null}
                filesRefreshKey={`${activeConversation?.id ?? ''}:${activeConversation?.updatedAt ?? ''}`}
                onOpenFile={(path) => {
                  setCodeOpenRequest({ path, nonce: Date.now() });
                  setView('code');
                }}
                onOpen={(id) => void openConversation(id)}
                onDelete={(id) => void deleteConversation(id)}
                onCollapse={() => setThreadsOpen(false)}
                onNew={() => void createEmptyConversation()}
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
                formatOnSave={bootstrap.settings.editor.formatOnSave}
                onOpenSettings={() => setView('settings')}
                onCreateReviewFollowup={(prompt) => { updateComposerDraft(prompt); setView('workspace'); }}
                openRequest={codeOpenRequest}
              />
            </div>
          </main>
          <TerminalView
            activeProject={activeProject}
            open={terminalOpen}
            height={terminalHeight}
            commandRequest={terminalCommand}
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
              <RightPane
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
        <ApprovalDialog approval={pendingApproval} onRespond={(approved, useFullAccess, answer) => void respondToApproval(approved, useFullAccess, answer)} />
      )}
      <TourGuide
        view={view}
        progress={tourProgress}
        suspended={setupOpen}
        listOpen={tourListOpen}
        onProgress={changeTourProgress}
        onCloseList={() => setTourListOpen(false)}
        onNavigate={setView}
      />
      {setupOpen && setupStatus && (
        <SetupPanel
          status={setupStatus}
          busy={Boolean(busy)}
          onAction={(action) => void runSetupAction(action)}
          onComplete={() => void completeSetup()}
          onDismiss={() => setSetupOpen(false)}
          onAskGuide={(question, conversationContext) => window.kaiDesktop.answerSetupGuide({ question, conversationContext }).then(unwrap)}
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
      {/* Last, so the styled tooltip sits above everything it might be describing. */}
      <TooltipLayer />
    </div>
  );
}

function ApprovalDialog({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (approved: boolean, useFullAccess?: boolean, answer?: string) => void;
}): ReactNode {
  // A guard asking whether to carry on is not a tool asking for permission. Its answers are named actions, and the
  // full-access button that belongs on a permission prompt has no meaning here — next to a spend limit it would read
  // as consent to keep spending, permanently. So it is a different dialog with the two answers it actually has.
  const question = approval.runQuestion;
  const actions = approvalActions(approval);
  return (
    <div className="approval-overlay">
      <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-dialog-head">
          {question ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
          <div>
            <span className="eyebrow">{question ? 'About this run' : 'Project approval'}</span>
            <h2 id="approval-title">{approval.title}</h2>
          </div>
          <span className={`risk-badge ${approval.risk}`}>{approval.risk} risk</span>
        </div>
        {approval.tool && <code className="approval-tool">{approval.tool}</code>}
        <pre className="approval-detail">{approval.detail}</pre>
        <div className="approval-dialog-actions">
          <button type="button" className="secondary-button" onClick={() => onRespond(false)}>{actions.cancelLabel}</button>
          {/* A tool being allowed is what the person expects to have focused. A question about the run is not, so
              neither answer is: Enter would take the permissive one, and these questions exist because the run is
              already past a limit. */}
          <button type="button" className="primary-button" autoFocus={!question} onClick={() => onRespond(true)}>{actions.confirmLabel}</button>
          {actions.offersFullAccess && (
            <button type="button" className="primary-button" onClick={() => onRespond(true, true)}>Allow &amp; use full access</button>
          )}
        </div>
      </section>
    </div>
  );
}

function looksLikeAccountLimit(message: string): boolean {
  // Covers both metered-API wording ("quota exhausted", "billing") and subscription CLI wording, which speaks of
  // a rolling window ("5-hour limit", "weekly limit") and a reset time rather than money.
  return /(?:credit|quota|usage(?:\s|-)?limit|monthly(?:\s|-)?limit|spending(?:\s|-)?limit|billing|balance|exhausted|out of tokens|reached (?:your )?limit|limit (?:has been )?reached|\d+[\s-]?(?:hour|day|week)(?:ly)?[\s-]?limit|limit will reset|resets? at|try again (?:later|after)|rate.?limit)/i.test(message);
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

function preferredConversationId(
  bootstrap: BootstrapPayload,
  conversations: readonly ConversationRecord[],
): string | null {
  if (bootstrap.activeConversationId && conversations.some((conversation) => conversation.id === bootstrap.activeConversationId)) {
    return bootstrap.activeConversationId;
  }
  return conversations
    .filter((conversation) => conversation.projectId === bootstrap.activeProjectId && !conversation.archived)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null;
}

function serviceNeedsPolling(status: string): boolean {
  return status === 'starting' || status === 'stopped';
}
