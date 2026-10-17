import { ImageCard, ImageChip } from './ImageAttachment';
import { AutoSettings } from './AutoSettings';
import { ComposerRunDetails, ComposerRunLine, useComposerRun } from './ComposerRunLine';
import { AUTO_WORKING_AUTONOMY, buildAutoStartRequest, readAutoSettings } from './auto-settings';
import { settleWithin } from '../async-deadline';
import { PlanStrip } from './PlanStrip';
import { EqualizerPanel } from './EqualizerPanel';
import { Markdown } from './Markdown';
import {
  Archive,
  AtSign,
  BookmarkPlus,
  ArrowRight,
  Braces,
  Brain,
  ChevronDown,
  Check,
  Circle,
  Cloud,
  Copy,
  Cpu,
  Download,
  Eye,
  Lightbulb,
  File,
  FileSearch,
  ExternalLink,
  FileDiff,
  FolderPlus,
  FolderOpen,
  GitCompare,
  GitFork,
  Goal,
  History,
  Loader2,
  LogIn,
  Minimize2,
  ImagePlus,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentCapability,
  AgentId,
  AppSettings,
  AutopilotRunRecord,
  AutonomyMode,
  ChangeReviewResult,
  CheckpointReview,
  CompareRun,
  ConversationRecord,
  ContextChip,
  ContextPreview,
  ReasoningEffort,
  ResponseStyle,
  ConversationTurn,
  DirectApiCapability,
  FileVerificationState,
  ExecutionMode,
  GoalInput,
  NormalizedGoalInput,
  PersistedEvent,
  PermissionKey,
  ProjectPreferences,
  ProjectRecord,
  PromptGuideReadiness,
  ReviewMode,
  RouteMode,
  ServiceState,
  SkillSummary,
  VerificationOverview,
  WorkbenchGoal,
} from '@kai/contracts';
import { ACCESS_LEVELS, CLI_MODEL_SUGGESTIONS, REASONING_LABEL, RESPONSE_STYLES, RESPONSE_STYLE_DESCRIPTION, RESPONSE_STYLE_LABEL, COMPACTION_WARNING_TOKENS, MAX_REVIEW_FILES, directProviderPreset, estimateConversationTokens, experienceProfile } from '@kai/contracts';
import { relativeTime, statusLabel, unwrap } from '../types';
import { HunkReview, canReviewHunks } from './HunkReview';
import { ToolCallCard, toolCallStatus } from './ToolCallCard';
import { isPreviewableTool } from '../tool-call-preview';
import { SaveToBrainDialog } from './SaveToBrain';
import { VerificationBadge } from './VerificationPanel';
import { UsageBanner } from './UsageView';
import { confirmDialog, promptDialog } from './AppDialog';
import { AgentActivityStrip, deriveAgentActivity } from './AgentActivity';
import type { QueuedPrompt } from './composer-queue';

import { Select } from './ui/Select';
export interface WorkspaceSendOptions {
  goal?: NormalizedGoalInput;
  skills?: string[];
  selectedPaths?: string[];
  contextChips?: ContextChip[];
  agent?: AgentId;
}

export type WorkspaceCommandKind = 'goal' | 'skills' | 'context' | 'checkpoint' | 'raw' | 'handoff' | 'preview-change' | 'prompt';

export interface WorkspaceQuestion {
  requestId: string;
  title: string;
  detail: string;
  options: string[];
  allowFreeText?: boolean;
}

export interface WorkspaceCommandRequest {
  kind: WorkspaceCommandKind;
  nonce: number;
  prompt?: string;
}

interface WorkspaceViewProps {
  activeProject: ProjectRecord | null;
  activeConversation: ConversationRecord | null;
  settings: AppSettings;
  projectPreferences: ProjectPreferences | null;
  busy: boolean;
  composerDraft: string;
  onComposerDraftChange: (draft: string) => void;
  selectedFiles: string[];
  setSelectedFiles: Dispatch<SetStateAction<string[]>>;
  contextChips: ContextChip[];
  setContextChips: Dispatch<SetStateAction<ContextChip[]>>;
  selectedSkills: SkillSummary[];
  setSelectedSkills: Dispatch<SetStateAction<SkillSummary[]>>;
  onInterjectionDelivered: (conversationId: string, text: string) => void;
  commandRequest: WorkspaceCommandRequest | null;
  /** Called once a command has been acted on, so coming back to this screen later does not replay it. */
  onCommandHandled: () => void;
  running: boolean;
  paused: boolean;
  awaitingApproval: boolean;
  pendingQuestion: WorkspaceQuestion | null;
  onAnswerQuestion: (requestId: string, answer: string | null) => void;
  notice: string | null;
  streamingText: string;
  agentCapabilities: AgentCapability[];
  directApiCapability: DirectApiCapability | null;
  selectedAgent: AgentId;
  executionMode: ExecutionMode;
  selectedRoute: RouteMode;
  selectedAutonomy: AutonomyMode;
  proxyReady: boolean;
  proxyContinuationAgent: AgentId | null;
  onSelectExecution: (mode: ExecutionMode) => void;
  onSelectAgent: (agent: AgentId) => void;
  onSelectRoute: (route: RouteMode) => void;
  onContinueViaProxy: (agent: AgentId) => void;
  onSelectAutonomy: (autonomy: AutonomyMode) => void;
  onUpdatePreferences: (preferences: ProjectPreferences) => Promise<void>;
  onUpdateConversation: (conversation: ConversationRecord) => Promise<void>;
  onChooseProject: () => void;
  onCreateConversation: (prompt: string, options?: WorkspaceSendOptions) => void;
  onBranchTurn: (turnId: string) => void;
  onRewindTurn: (turnId: string) => void;
  onSend: (prompt: string, options?: WorkspaceSendOptions) => void;
  queuedPrompts: QueuedPrompt[];
  onQueuePrompt: (prompt: QueuedPrompt, first?: boolean) => void;
  onUpdateQueuedPrompt: (id: string, update: 'remove' | 'retry' | 'promote') => void;
  onHandoff: (agent: AgentId, prompt: string) => void;
  onCompare: (prompt: string, targetAgent: AgentId) => Promise<CompareRun>;
  onPickCompare: (id: string, side: 'left' | 'right') => Promise<void>;
  onDiscardCompare: (id: string) => Promise<void>;
  onOpenCompareWorktree: (id: string, side: 'left' | 'right') => Promise<void>;
  onReviewCheckpoint: (conversationId: string, turnId: string) => Promise<CheckpointReview>;
  onRejectCheckpointFile: (conversationId: string, turnId: string, filePath: string) => Promise<void>;
  onRestoreCheckpoint: (conversationId: string, turnId: string) => Promise<void>;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  /** Stops every run and clears the state a run that never returned left behind. Never disabled by it. */
  onStopEverything: () => void;
  onSignIn: (agent: AgentId) => void;
  onInstall: (agent: AgentId) => void;
  onRefreshAgents: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  selectedModel: string;
  onSelectModel: (model: string) => void;
  /** Thinking effort chosen for this conversation ('' means the CLI's own default). */
  selectedReasoning: ReasoningEffort | '';
  /** How the agent words its replies; plain words unless the person changed it. */
  selectedStyle: ResponseStyle;
  onSelectStyle: (style: ResponseStyle) => void;
  /** The effort levels the selected agent's CLI accepts; empty hides the control. */
  reasoningLevels: readonly ReasoningEffort[];
  onSelectReasoning: (reasoning: ReasoningEffort | '') => void;
  interruptedRuns: number;
  onOpenRecovery: () => void;
  onOpenVerification: () => void;
  onOpenRules: () => void;
  onOpenWorkflows: () => void;
  onCompactConversation: () => void;
  onContinueInNewTab: () => void;
  onOpenFile: (path: string) => void;
}

type TaskIntent = 'ask' | 'plan' | 'build' | 'review' | 'learn' | 'equalizer' | 'auto';

/**
 * Where the chosen intent is remembered. It is a working preference rather than part of a message, so it is kept for
 * the app rather than for one conversation.
 */
const INTENT_KEY = 'kai.composer.intent';

/**
 * The intent a stored value names, or Ask when it names nothing KAI still offers.
 *
 * Storage is outliving the code that wrote it: an intent that has since been renamed or removed would otherwise leave
 * the composer showing a mode that no longer exists, so anything unrecognised falls back rather than being trusted.
 */
export function savedTaskIntent(stored: string | null): TaskIntent {
  return TASK_INTENTS.some((intent) => intent.id === stored) ? stored as TaskIntent : 'ask';
}

/**
 * How long each composer action may hold its own button before the UI stops waiting on it. Generous, because the
 * cost of being wrong is asymmetric: a slow call that finishes just after its deadline releases a button the
 * person is already free to press again, while waiting forever leaves them with no button at all.
 */
const START_WAIT_MS = 30_000;
const REFINE_WAIT_MS = 60_000;
const STOP_WAIT_MS = 30_000;

const TASK_INTENTS: ReadonlyArray<{ id: TaskIntent; label: string; description: string; placeholder: string; starter: string }> = [
  { id: 'ask', label: 'General', description: 'Ask a question or describe a task in your own words', placeholder: 'Ask KAI about this project or describe a task', starter: '' },
  { id: 'plan', label: 'Plan', description: 'Inspect first; do not change files', placeholder: 'Describe the outcome you want to plan', starter: 'Plan this work. Inspect the project first. Do not change files. Explain the approach, affected areas, risks, and how you would verify it:\n\n' },
  { id: 'build', label: 'Build', description: 'Make a safe, verified change', placeholder: 'Describe what you want KAI to build', starter: 'Build this safely. First state the plan, then make the smallest useful change and run relevant checks:\n\n' },
  { id: 'review', label: 'Review', description: 'Check code, risks, and tests', placeholder: 'Paste or describe what you want reviewed', starter: 'Review this for correctness, architecture, security, and missing tests. Do not change files unless I ask:\n\n' },
  { id: 'learn', label: 'Learn', description: 'Understand architecture or security', placeholder: 'What do you want to understand?', starter: 'Teach me this in simple terms. Focus on the architecture, security implications, trade-offs, and one small way I can check my understanding:\n\n' },
  { id: 'equalizer', label: 'Equalizer', description: 'Compare the built screens with their design and report every difference', placeholder: 'Say what does not match, for example: the dashboard on my dev server', starter: '' },
  { id: 'auto', label: 'Auto', description: 'Send the task and KAI works it on its own until the agent says it is done, switching provider when a limit is hit', placeholder: 'Describe the task; send it and Auto works it until it is done', starter: '' },
];

const STATUS_WORDS = [
  'Thinking',
  'Reasoning',
  'Reading context',
  'Tracing the code',
  'Building a plan',
  'Checking the details',
  'Connecting the dots',
  'Untangling the problem',
  'Synthesizing',
  'Testing assumptions',
  'Looking for edges',
  'Wrangling the types',
  'Asking the compiler nicely',
  'Counting semicolons',
  'Reading the stack trace',
  'Making the pixels behave',
  'Refactoring the vibes',
  'Trying not to overthink this',
  'Double-checking the obvious',
  'Talking to the test suite',
  'Bribing the linter with coffee',
  'Asking the rubber duck',
  'Herding the async promises',
  'Blaming the cache, just in case',
  'Turning it off and on again',
  'Reading the docs so you do not have to',
  'Negotiating with node_modules',
  'Sharpening the diffs',
  'Consulting the ancient Stack Overflow scrolls',
  'Aligning the divs, spiritually',
  'Convincing the build to cooperate',
  'Politely arguing with the regex',
  'Sweeping up the null pointers',
  'Compiling my thoughts',
  'Rehearsing the commit message',
  'Measuring twice, editing once',
] as const;

const COMMANDS = [
  '/goal',
  '/skills',
  '/rules',
  '/agent',
  '/route',
  '/handoff',
  '/review',
  '/implement',
  '/debug',
  '/explain',
  '/test',
] as const;

const COMMAND_TEMPLATES: Record<string, string> = {
  review: 'Review this code for bugs, style issues, and improvements:',
  implement: 'Implement the following change:',
  debug: 'Debug this issue:',
  explain: 'Explain how this code works:',
  test: 'Write tests for:',
};

const PERMISSIONS: ReadonlyArray<{ key: PermissionKey; label: string; description: string }> = [
  { key: 'workspaceEdit', label: 'Edit workspace', description: 'Create, edit, or delete project files.' },
  { key: 'shellCommand', label: 'Run commands', description: 'Run project-scoped build, test, and shell commands.' },
  { key: 'dependencyInstall', label: 'Install dependencies', description: 'Add or update project packages and tools.' },
  { key: 'configWrite', label: 'Write config', description: 'Change project or KAI configuration files.' },
  { key: 'network', label: 'Network access', description: 'Allow commands or tools to reach the network.' },
  { key: 'gitCommit', label: 'Git commit', description: 'Create commits in the active project.' },
  { key: 'gitPush', label: 'Git push', description: 'Push commits to a configured remote.' },
  { key: 'destructiveFilesystem', label: 'Destructive filesystem', description: 'Allow recursive or permanent file removal.' },
];

export function WorkspaceView({
  activeProject,
  activeConversation,
  settings,
  projectPreferences,
  busy,
  composerDraft,
  onComposerDraftChange,
  selectedFiles,
  setSelectedFiles,
  contextChips,
  setContextChips,
  selectedSkills,
  setSelectedSkills,
  onInterjectionDelivered,
  commandRequest,
  onCommandHandled,
  running,
  paused,
  awaitingApproval,
  pendingQuestion,
  onAnswerQuestion,
  notice,
  streamingText,
  agentCapabilities,
  directApiCapability,
  selectedAgent,
  executionMode,
  selectedRoute,
  selectedAutonomy,
  proxyReady,
  proxyContinuationAgent,
  onSelectExecution,
  onSelectAgent,
  onSelectRoute,
  onContinueViaProxy,
  onSelectAutonomy,
  onUpdatePreferences,
  onUpdateConversation,
  onChooseProject,
  onCreateConversation,
  onBranchTurn,
  onRewindTurn,
  onSend,
  queuedPrompts,
  onQueuePrompt,
  onUpdateQueuedPrompt,
  onHandoff,
  onCompare,
  onPickCompare,
  onDiscardCompare,
  onOpenCompareWorktree,
  onReviewCheckpoint,
  onRejectCheckpointFile,
  onRestoreCheckpoint,
  onCancel,
  onPause,
  onResume,
  onStopEverything,
  onSignIn,
  onInstall,
  onRefreshAgents,
  onOpenSettings,
  onOpenUsage,
  selectedModel,
  onSelectModel,
  selectedReasoning,
  selectedStyle,
  onSelectStyle,
  reasoningLevels,
  onSelectReasoning,
  interruptedRuns,
  onOpenRecovery,
  onOpenVerification,
  onOpenRules,
  onOpenWorkflows,
  onCompactConversation,
  onContinueInNewTab,
  onOpenFile,
}: WorkspaceViewProps): ReactNode {
  const [prompt, setPrompt] = useState('');
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [contextBusy, setContextBusy] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [goalEditor, setGoalEditor] = useState<GoalInput | null>(null);
  const queueConversationId = activeConversation?.id ?? null;
  const [statusWord, setStatusWord] = useState<(typeof STATUS_WORDS)[number]>('Thinking');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [compareMode, setCompareMode] = useState(false);
  const [compareAgent, setCompareAgent] = useState<AgentId>('claude');
  const [compareResult, setCompareResult] = useState<CompareRun | null>(null);
  const [comparing, setComparing] = useState(false);
  // Remembered, because the composer is unmounted whenever the person looks at another screen. Plain component state
  // meant picking Auto, glancing at the Studio, and coming back to Ask — the choice silently discarded, which reads as
  // the app forgetting what you told it.
  const [taskIntent, setTaskIntent] = useState<TaskIntent>(() => {
    try {
      return savedTaskIntent(window.localStorage.getItem(INTENT_KEY));
    } catch {
      return 'ask';
    }
  });
  const [advancedComposerOpen, setAdvancedComposerOpen] = useState(false);
  const [checkpointReview, setCheckpointReview] = useState<CheckpointReview | null>(null);
  const [brainDraft, setBrainDraft] = useState<string | null>(null);
  const [fileChecks, setFileChecks] = useState<Record<string, FileVerificationState>>({});
  const [rawEventsOpen, setRawEventsOpen] = useState(false);
  /** The run's log and settings, opened from the composer's run line rather than standing above the message box. */
  const [runDetailsOpen, setRunDetailsOpen] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [showRunDetails, setShowRunDetails] = useState(false);
  const [workbenchNotice, setWorkbenchNotice] = useState<string | null>(null);
  /**
   * Set when something the composer is waiting on has run past its deadline, so the person is told rather than left
   * watching a spinner. Carries the way out with it, because a control held open by a call that never returned
   * cannot be released from inside the composer.
   */
  const [stuckNotice, setStuckNotice] = useState<string | null>(null);
  /** Set while Auto is being asked to start, so the composer's send cannot be pressed twice into it. */
  const [startingAuto, setStartingAuto] = useState(false);
  /** Set by the one-click access fix below: send as soon as the new access level has reached this component. */
  const [sendWhenAccessReady, setSendWhenAccessReady] = useState(false);
  const [refiningPrompt, setRefiningPrompt] = useState(false);
  const [interjecting, setInterjecting] = useState(false);
  const [promptGuideReadiness, setPromptGuideReadiness] = useState<PromptGuideReadiness | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is at the bottom; scrolling up releases it until they send again.
  const stickToBottomRef = useRef(true);
  const wasRunningRef = useRef(false);
  const previousConversationIdRef = useRef<string | null>(null);
  const [pendingUser, setPendingUser] = useState<{ text: string; baseCount: number; images: Array<{ name: string; dataUrl: string }> } | null>(null);
  const selectedCapability = agentCapabilities.find((agent) => agent.id === selectedAgent);
  const brainReady = settings.cognitive1.enabled;
  const profile = experienceProfile(settings.experienceLevel);
  const apiRun = executionMode === 'api';
  const cliProxySupported = Boolean(selectedCapability?.supportsRoutes.includes('proxy'));
  const routeAvailable = apiRun || (cliProxySupported && proxyReady);
  const effectiveRoute = apiRun || cliProxySupported ? selectedRoute : 'direct';
  // A signed-out CLI can still run through the proxy, which supplies its own key.
  const ready = apiRun
    ? Boolean(directApiCapability?.available)
    : Boolean(selectedCapability?.available || (effectiveRoute === 'proxy' && selectedCapability?.state === 'signed_out'));
  const unavailableReason = apiRun
    ? directApiCapability?.unavailableReason ?? 'Direct API status is unavailable.'
    : selectedCapability?.unavailableReason ?? 'No agent CLI is available.';
  const refineTarget = promptGuideReadiness?.ready
    ? `${promptGuideReadiness.displayName} · ${promptGuideReadiness.model}`
    : directApiCapability?.available
      ? `${directApiCapability.displayName}${directApiCapability.model ? ` · ${directApiCapability.model}` : ''}`
      : null;
  const refineReason = refineTarget
    ? null
    : promptGuideReadiness?.reason ?? directApiCapability?.unavailableReason ?? 'Checking the available model connection.';
  /** What the provider is called on screen. The model beside it belongs to the model control, and only there. */
  const providerLabel = effectiveRoute === 'proxy'
    ? `Proxy${settings.proxy.defaultModel ? ` · ${settings.proxy.defaultModel}` : ''}`
    : `${directApiCapability?.displayName || 'Direct API'}${directApiCapability?.model ? ` · ${directApiCapability.model}` : ''}`;
  const activeGoal = activeConversation?.goal ?? null;
  const activeTaskIntent = TASK_INTENTS.find((intent) => intent.id === taskIntent) ?? TASK_INTENTS[0];
  const allContextChips: ContextChip[] = [
    ...selectedFiles.map((path) => ({ type: 'file' as const, path })),
    ...contextChips,
  ];
  const hasImageAttachment = contextChips.some((chip) => chip.type === 'image');
  const canSendPrompt = Boolean(prompt.trim()) || hasImageAttachment;
  const sendOptions: WorkspaceSendOptions | undefined = (activeGoal || selectedSkills.length || allContextChips.length)
    ? {
        ...(activeGoal ? { goal: activeGoal } : {}),
        ...(selectedSkills.length ? { skills: selectedSkills.map((skill) => skill.name) } : {}),
        ...(selectedFiles.length ? { selectedPaths: selectedFiles } : {}),
        ...(allContextChips.length ? { contextChips: allContextChips } : {}),
      }
    : undefined;

  // A tab owns its draft even while another tab is active. The composer remains local
  // for responsive typing, while the shell persists the value by conversation id.
  useEffect(() => {
    setPrompt(composerDraft);
  // Deliberately only switch the draft when the tab changes. Including composerDraft
  // here caused the old tab's effect to write back during a switch, producing a rapid
  // visual blink and occasionally replacing the new draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id]);

  useEffect(() => {
    onComposerDraftChange(prompt);
  }, [onComposerDraftChange, prompt]);

  useEffect(() => {
    setCompareResult(null);
    if (!activeProject) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    void window.kaiDesktop
      .listSkills(activeProject.id)
      .then(unwrap)
      .then((catalog) => {
        if (!cancelled) setSkills(catalog);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id]);

  useEffect(() => {
    let cancelled = false;
    setPromptGuideReadiness(null);
    void window.kaiDesktop
      .promptGuideReadiness()
      .then(unwrap)
      .then((readiness) => {
        if (!cancelled) setPromptGuideReadiness(readiness);
      })
      .catch(() => {
        if (!cancelled) setPromptGuideReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    settings.promptGuide.baseUrl,
    settings.promptGuide.credentialId,
    settings.promptGuide.enabled,
    settings.promptGuide.model,
    settings.promptGuide.provider,
  ]);

  // Keep the prompt legible as it grows. Resetting first makes it shrink again after text is removed.
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 260 ? 'auto' : 'hidden';
  }, [prompt]);

  useEffect(() => {
    if (!contextPickerOpen || !activeProject) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setContextBusy(true);
      void window.kaiDesktop
        .searchFiles({ projectId: activeProject.id, query: fileQuery.trim() })
        .then(unwrap)
        .then((files) => {
          if (!cancelled) setFileResults(files.slice(0, 40));
        })
        .catch((caught) => {
          if (!cancelled) setWorkbenchNotice(messageOf(caught));
        })
        .finally(() => {
          if (!cancelled) setContextBusy(false);
        });
    }, fileQuery ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProject?.id, contextPickerOpen, fileQuery]);

  useEffect(() => {
    if (!commandRequest) return;
    // The request lives in the app, not here: without this, leaving for another screen and coming back remounts the
    // composer and the stale request fills the prompt again.
    onCommandHandled();
    if (commandRequest.kind === 'goal') {
      setGoalEditor({ outcome: '', constraints: '', verification: '' });
    } else if (commandRequest.kind === 'skills') {
      setSkillsOpen(true);
    } else if (commandRequest.kind === 'context') {
      setContextPickerOpen(true);
      window.setTimeout(() => promptRef.current?.focus(), 0);
    } else if (commandRequest.kind === 'raw') {
      setRawEventsOpen(true);
    } else if (commandRequest.kind === 'handoff') {
      setPrompt('/handoff ');
      window.setTimeout(() => promptRef.current?.focus(), 0);
    } else if (commandRequest.kind === 'preview-change') {
      setPrompt(commandRequest.prompt ?? '');
      setWorkbenchNotice('Preview context added. Add any extra detail, then send the change request.');
      window.setTimeout(() => promptRef.current?.focus(), 0);
    } else if (commandRequest.kind === 'prompt') {
      setPrompt(commandRequest.prompt ?? '');
      setWorkbenchNotice('The Studio brief is ready in the composer. Review it, then send when you are ready.');
      window.setTimeout(() => promptRef.current?.focus(), 0);
    } else if (commandRequest.kind === 'checkpoint') {
      const conversation = activeConversation;
      const latest = conversation?.events
        .filter((event): event is Extract<PersistedEvent, { type: 'turn.changes' }> =>
          event.type === 'turn.changes' && Boolean(event.turnId) && event.hasCheckpoint)
        .at(-1);
      if (!conversation || !latest?.turnId) {
        setWorkbenchNotice('No checkpointed turn is available in the active conversation.');
        return;
      }
      void onReviewCheckpoint(conversation.id, latest.turnId)
        .then(setCheckpointReview)
        .catch((caught) => setWorkbenchNotice(messageOf(caught)));
    }
  }, [commandRequest?.nonce]);

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }
    const started = Date.now();
    setStatusWord(STATUS_WORDS[Math.floor(Math.random() * STATUS_WORDS.length)]);
    const wordTimer = window.setInterval(() => {
      setStatusWord((current) => {
        const currentIndex = STATUS_WORDS.indexOf(current);
        return STATUS_WORDS[(currentIndex + 1 + Math.floor(Math.random() * 3)) % STATUS_WORDS.length];
      });
    }, 2_200);
    const clockTimer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1_000)), 1_000);
    return () => {
      window.clearInterval(wordTimer);
      window.clearInterval(clockTimer);
    };
  }, [running]);

  useEffect(() => {
    if (wasRunningRef.current && !running) setPendingUser(null);
    wasRunningRef.current = running;
  }, [running]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stickToBottomRef.current) return;
    // Let React lay out the incoming message/change summary before following it.
    const frame = window.requestAnimationFrame(() => { canvas.scrollTop = canvas.scrollHeight; });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversation?.turns.length, activeConversation?.events.length, compareResult, queuedPrompts.length, streamingText, pendingUser, pendingQuestion?.requestId, running]);

  useEffect(() => {
    if (!pendingQuestion) return;
    const frame = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (canvas) canvas.scrollTop = canvas.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingQuestion?.requestId]);

  // Opening a different conversation (including a branch) starts at its latest message with the composer ready.
  useEffect(() => {
    stickToBottomRef.current = true;
    // A brand-new chat gets its id after the first send; keep that message showing.
    if (previousConversationIdRef.current) setPendingUser(null);
    previousConversationIdRef.current = activeConversation?.id ?? null;
    setShowRunDetails(false);
    const canvas = canvasRef.current;
    if (canvas) canvas.scrollTop = canvas.scrollHeight;
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }, [activeConversation?.id]);

  const onCanvasScroll = (): void => {
    const canvas = canvasRef.current;
    if (canvas) stickToBottomRef.current = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 80;
  };

  const queueOrSend = (text: string, options = sendOptions): void => {
    if (!text || !activeProject || !ready) return;
    if (running) {
      if (queueConversationId) onQueuePrompt({
        id: crypto.randomUUID(), conversationId: queueConversationId, text,
        options: { ...(options ?? {}), agent: selectedAgent, execution: executionMode, route: selectedRoute, autonomy: selectedAutonomy, ...(selectedModel ? { model: selectedModel } : {}) },
        status: 'queued',
      });
      return;
    }
    stickToBottomRef.current = true;
    setPendingUser({
      text,
      baseCount: activeConversation?.turns.length ?? 0,
      images: contextChips.flatMap((chip) => (chip.type === 'image' && chip.dataUrl ? [{ name: chip.name, dataUrl: chip.dataUrl }] : [])),
    });
    // Auto is a mode of this composer, not a second one: the same box, the same send. Decided here rather than at the
    // button, so a steered or queued task behaves the same as one typed straight in.
    if (taskIntent === 'auto') {
      void startAuto(text, options);
      return;
    }
    if (activeConversation) onSend(text, options);
    else onCreateConversation(text, options);
  };

  // Declared after the handler it wraps: a `const` arrow is not hoisted, so reading it above its own definition
  // would throw on the first render.
  const queueOrSendStable = useLatestHandler(queueOrSend);

  const optionsForPrompt = (text: string): WorkspaceSendOptions | undefined => {
    const namedSkills = skills
      .filter((skill) => new RegExp(`\\$${escapeRegExp(skill.name)}(?![A-Za-z0-9_-])`, 'i').test(text))
      .map((skill) => skill.name);
    const skillNames = [...new Set([...selectedSkills.map((skill) => skill.name), ...namedSkills])];
    const options: WorkspaceSendOptions = {
      ...(sendOptions ?? {}),
      ...(skillNames.length ? { skills: skillNames } : {}),
    };
    return Object.keys(options).length ? options : undefined;
  };

  const send = (): void => {
    const typedText = prompt.trim();
    if ((!typedText && !hasImageAttachment) || !activeProject || busy || refiningPrompt || !ready) return;
    const text = typedText || 'Please look at the attached image.';
    if (taskIntent === 'auto' && !AUTO_WORKING_AUTONOMY.has(selectedAutonomy)) {
      setWorkbenchNotice('Auto needs Edit files or Full access. Choose an access level below, then send again.');
      return;
    }
    const goalAndImplementation = typedText ? goalAndImplementationFor(text) : null;
    if (goalAndImplementation) {
      setPrompt('');
      queueOrSend(goalAndImplementation.prompt, {
        ...(optionsForPrompt(text) ?? {}),
        goal: goalAndImplementation.goal,
      });
      clearComposerContext();
      setSelectedSkills([]);
      return;
    }
    const command = typedText ? commandFor(text) : null;
    if (command) {
      setPrompt('');
      runCommand(command, text);
      return;
    }
    setPrompt('');
    if (compareMode && typedText) {
      setCompareResult(null);
      setComparing(true);
      void onCompare(text, compareAgent)
        .then(setCompareResult)
        .finally(() => setComparing(false));
      clearComposerContext();
      setSelectedSkills([]);
      return;
    }
    queueOrSend(text, optionsForPrompt(text));
    clearComposerContext();
    setSelectedSkills([]);
  };

  useEffect(() => {
    if (!sendWhenAccessReady || !AUTO_WORKING_AUTONOMY.has(selectedAutonomy)) return;
    setSendWhenAccessReady(false);
    send();
    // send reads the latest props on every render; this runs once the new access level has arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendWhenAccessReady, selectedAutonomy]);

  /**
   * Starts Auto on the task in the composer, under the composer's own choices — agent, mode, route, autonomy and
   * model are the ones on screen, and Auto's own tuning is what the panel below was last set to.
   */
  async function startAuto(text: string, options: WorkspaceSendOptions | undefined): Promise<void> {
    if (!activeProject) return;
    if (!AUTO_WORKING_AUTONOMY.has(selectedAutonomy)) {
      setWorkbenchNotice(`Auto runs at Edit files or Full access, not ${selectedAutonomy}. It cannot answer the questions a lower level asks.`);
      return;
    }
    setStartingAuto(true);
    setWorkbenchNotice(null);
    try {
      const request = buildAutoStartRequest({
        projectId: activeProject.id,
        prompt: text,
        settings: readAutoSettings(activeProject.id),
        execution: executionMode,
        agent: selectedAgent,
        route: selectedRoute,
        autonomy: selectedAutonomy,
        ...(activeConversation ? { conversationId: activeConversation.id } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(options?.skills?.length ? { skills: options.skills } : {}),
        ...(options?.selectedPaths?.length ? { selectedPaths: options.selectedPaths } : {}),
        ...(options?.contextChips?.length ? { contextChips: options.contextChips } : {}),
      });
      const started = await settleWithin(() => window.kaiDesktop.startAuto(request).then(unwrap), START_WAIT_MS);
      // Unlike the flags below, this call is not side-effect free: it starts a real Auto session. So the deadline
      // clears the button but says what happened, rather than quietly re-enabling send onto a second session.
      if (!started.settled) setStuckNotice('Auto did not start in time, so the button was released. If a run did start, Stop everything ends it.');
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    } finally {
      setStartingAuto(false);
    }
  }

  const steerNow = (): void => {
    const text = prompt.trim();
    if (!text || !activeProject || busy || refiningPrompt || !ready || !queueConversationId) return;
    if (!running) {
      send();
      return;
    }
    if (apiRun) {
      interjectNow();
      return;
    }
    onQueuePrompt({
      id: crypto.randomUUID(), conversationId: queueConversationId, text,
      options: { ...(optionsForPrompt(text) ?? {}), agent: selectedAgent, execution: executionMode, route: selectedRoute, autonomy: selectedAutonomy, ...(selectedModel ? { model: selectedModel } : {}) },
      status: 'queued',
    }, true);
    setPrompt('');
    clearComposerContext();
    setSelectedSkills([]);
    setWorkbenchNotice('This CLI run cannot take a live message. Your instruction is queued for its next turn; the current work continues.');
  };

  /**
   * Says something to the run that is already going, instead of waiting for it to end or stopping it.
   *
   * The model handles the immediate instruction at its next step, then resumes the original task.
   */
  const interjectNow = (): void => {
    const text = prompt.trim();
    const conversationId = activeConversation?.id;
    if (!text || !conversationId || !running || interjecting) return;
    setInterjecting(true);
    setWorkbenchNotice('Waiting for the active model to take this message.');
    void window.kaiDesktop.interjectAgent({ conversationId, text }).then(unwrap)
      .then(({ queued }) => {
        if (queued) {
          setPrompt((current) => current.trim() === text ? '' : current);
          onInterjectionDelivered(conversationId, text);
          setWorkbenchNotice('Your message was added to the active run.');
        } else {
          setWorkbenchNotice('This run ended or does not support in-run messages. Your text is still in the composer; queue it for the next turn.');
        }
      })
      .catch((caught) => {
        setWorkbenchNotice(caught instanceof Error ? caught.message : 'The message could not be sent to the run.');
      }).finally(() => setInterjecting(false));
  };

  /**
   * Calling a queued instruction forward while a run is going. The run is not in the way — this is not a
   * replacement for it — so the preferred move is the same in-run message `interjectNow` sends: it reaches the
   * agent at its next turn, is answered or taken as a correction, and the run carries on with what it was doing.
   * Stopping and restarting is the fallback, used only for a run that genuinely cannot take a mid-turn message
   * (a CLI run, or one that has already ended by the time this reaches it) — never the first move.
   */
  const steerQueuedPrompt = (index: number): void => {
    const item = queuedPrompts[index];
    if (!item || busy || !activeProject || !ready) return;
    const conversationId = activeConversation?.id;
    if (running && conversationId && apiRun) {
      setWorkbenchNotice('Sending this to the active run…');
      void window.kaiDesktop.interjectAgent({ conversationId, text: item.text }).then(unwrap)
        .then(({ queued }) => {
          if (queued) {
            onInterjectionDelivered(conversationId, item.text);
            onUpdateQueuedPrompt(item.id, 'remove');
            setWorkbenchNotice('Sent to the active run; it will answer this and carry on with the rest.');
          } else {
            setWorkbenchNotice('The active run could not take this message. It remains queued for the next turn; nothing was stopped.');
          }
        })
        .catch(() => setWorkbenchNotice('Could not reach the active run. The instruction remains queued; nothing was stopped.'));
      return;
    }
    if (running) {
      setWorkbenchNotice('This CLI run cannot take a live message. The instruction remains queued for its next turn.');
      return;
    }
    onUpdateQueuedPrompt(item.id, 'promote');
  };

  async function refinePromptDraft(): Promise<void> {
    const text = prompt.trim();
    if (!text || !refineTarget || busy || running || paused || awaitingApproval || refiningPrompt) return;
    setRefiningPrompt(true);
    setWorkbenchNotice(null);
    try {
      const refined = await settleWithin(
        () => window.kaiDesktop.refinePrompt({ text, intent: taskIntent === 'equalizer' || taskIntent === 'auto' ? 'build' : taskIntent }).then(unwrap),
        REFINE_WAIT_MS,
      );
      // Nothing was changed in the project, so releasing the button is all this needs to do.
      if (!refined.settled) {
        setWorkbenchNotice('Refining the prompt did not answer in time. Your text is unchanged.');
        return;
      }
      const result = refined.value;
      setPrompt(result.prompt);
      window.setTimeout(() => {
        promptRef.current?.focus();
        promptRef.current?.setSelectionRange(result.prompt.length, result.prompt.length);
      }, 0);
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    } finally {
      setRefiningPrompt(false);
    }
  }

  function cycleAutonomy(): void {
    const modes: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full'];
    const index = modes.indexOf(selectedAutonomy);
    onSelectAutonomy(modes[(index === -1 ? 0 : index + 1) % modes.length]);
  }

  /** Puts a question about something KAI just showed into the composer, read-only, ready to send. */
  const askKaiStable = useLatestHandler(askKai);

  function askKai(text: string): void {
    rememberIntent('learn');
    setPrompt(text);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  /** A fix chosen in the Equalizer: the prompt goes into the composer for the user to read and send, as a Build. */
  function applyEqualizerFix(text: string): void {
    rememberIntent('build');
    setPrompt(text);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  /**
   * Sets the intent and keeps it, so every path that changes it lasts as long as the person's choice rather than as
   * long as this screen stays mounted — leaving for the Studio and coming back used to lose an intent set from a
   * panel rather than from the row.
   */
  function rememberIntent(intent: TaskIntent): void {
    setTaskIntent(intent);
    // A window with storage locked down keeps it in memory instead.
    try { window.localStorage.setItem(INTENT_KEY, intent); } catch { /* memory only */ }
  }

  function chooseTaskIntent(intent: TaskIntent): void {
    const definition = TASK_INTENTS.find((item) => item.id === intent)!;
    rememberIntent(intent);
    if (!prompt.trim() && definition.starter) setPrompt(definition.starter);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  async function confirmProxyContinuation(agent: AgentId): Promise<void> {
    const budget = settings.usageBudget.monthlyUsd > 0 ? `$${settings.usageBudget.monthlyUsd.toFixed(2)} monthly KAI budget` : 'no KAI monthly budget set';
    const confirmed = await confirmDialog({
      title: 'Continue with paid API via proxy?',
      detail: `The subscription-backed ${selectedCapability?.displayName ?? agent} run reached its limit. The next run will use ${settings.proxy.defaultModel} through ${settings.proxy.targetBaseUrl}. Your prompt and selected project context will be sent to that configured provider and may create API charges (${budget}).`,
      confirmLabel: 'Continue via proxy',
    });
    if (confirmed) onContinueViaProxy(agent);
  }

  function commandFor(text: string): string | undefined {
    const match = /^\/(goal|skills|rules|agent|route|handoff|workflows|review|implement|debug|explain|test)\b/i.exec(text);
    return match?.[1]?.toLowerCase();
  }

  /** Lets a plain-English request behave like Codex's "make a goal and
   * implement" workflow without making the user learn a slash command. */
  function goalAndImplementationFor(text: string): { goal: NormalizedGoalInput; prompt: string } | null {
    const match = /^(?:please\s+)?(?:make|create|start|set)\s+(?:a\s+)?goal\s+(?:and|then)\s+(?:implement|build|do)\s+(.+)$/i.exec(text.trim());
    const outcome = match?.[1]?.trim();
    if (!outcome) return null;
    // Only the goal input shape crosses the IPC boundary; the main process assigns the id, status
    // and timestamps (and its strict goal schema rejects anything else).
    return {
      goal: { outcome, constraints: '', verification: '' },
      prompt: `Implement this goal: ${outcome}`,
    };
  }

  function runCommand(command: string, text: string): void {
    if (command === 'goal') {
      setGoalEditor({ outcome: text.replace(/^\/goal\s*/i, '').trim(), constraints: '', verification: '' });
      return;
    }
    if (command === 'skills') {
      setSkillsOpen(true);
      return;
    }
    if (command === 'rules') {
      onOpenRules();
      return;
    }
    if (command === 'workflows') {
      onOpenWorkflows();
      return;
    }
    if (command === 'handoff') {
      const [, requestedAgent, ...rest] = text.split(/\s+/);
      const target = agentCapabilities.find((agent) => agent.id === requestedAgent)?.id;
      if (!target) return;
      const handoffPrompt = rest.join(' ').trim() || `Continue the current task with ${target}.`;
      onHandoff(target, handoffPrompt);
      return;
    }
    if (command === 'agent') {
      const requestedAgent = text.split(/\s+/)[1]?.toLowerCase();
      const target = agentCapabilities.find((agent) => agent.id === requestedAgent)?.id;
      if (target) onSelectAgent(target);
      return;
    }
    if (command === 'route') {
      const requestedRoute = text.split(/\s+/)[1]?.toLowerCase();
      if (requestedRoute === 'direct' || requestedRoute === 'proxy') onSelectRoute(requestedRoute);
      return;
    }
    const template = COMMAND_TEMPLATES[command];
    if (template) {
      setPrompt(`${template} `);
      window.setTimeout(() => promptRef.current?.focus(), 0);
      return;
    }
    setPrompt(`${text} `);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  function clearComposerContext(): void {
    setSelectedFiles([]);
    setContextChips([]);
  }

  async function attachFiles(): Promise<void> {
    if (!activeProject) return;
    try {
      const files = await window.kaiDesktop.chooseFiles(activeProject.id).then(unwrap);
      setSelectedFiles((current) => [...new Set([...current, ...files])]);
    } catch {
      // The app-level error banner reports IPC failures.
    }
  }

  function applyCommand(command: string): void {
    if (command === '/goal') {
      setGoalEditor({ outcome: '', constraints: '', verification: '' });
      return;
    }
    if (command === '/skills') {
      setSkillsOpen(true);
      return;
    }
    if (command === '/rules') {
      onOpenRules();
      return;
    }
    const name = command.replace(/^\//, '').toLowerCase();
    const template = COMMAND_TEMPLATES[name];
    if (template) {
      setPrompt(`${template} `);
      promptRef.current?.focus();
      return;
    }
    setPrompt(`${command} `);
    promptRef.current?.focus();
  }

  async function addSelectionContext(): Promise<void> {
    const path = await promptDialog({
      title: 'Add selection context',
      label: 'Project-relative file path',
      initialValue: selectedFiles[0] ?? '',
      placeholder: 'src/component.tsx',
      confirmLabel: 'Next',
      validate: (value) => value.startsWith('/') || /^[A-Za-z]:/.test(value)
        ? 'Use a project-relative path.'
        : null,
    });
    if (!path?.trim()) return;
    const startValue = await promptDialog({
      title: 'Add selection context',
      label: 'Start line',
      initialValue: '1',
      confirmLabel: 'Next',
      validate: positiveLine,
    });
    if (startValue === null) return;
    const start = Number(startValue);
    const endValue = await promptDialog({
      title: 'Add selection context',
      label: 'End line',
      initialValue: String(start),
      confirmLabel: 'Add context',
      validate: (value) => positiveLine(value) ?? (Number(value) < start ? 'The end line must follow the start line.' : null),
    });
    if (endValue === null) return;
    const end = Number(endValue);
    setContextChips((current) => [
      ...current.filter((chip) => !(chip.type === 'selection' && chip.path === path.trim())),
      { type: 'selection', path: path.trim(), startLine: start, endLine: end },
    ]);
    setContextPickerOpen(false);
  }

  async function addGitDiffContext(): Promise<void> {
    if (!activeProject) return;
    setContextBusy(true);
    try {
      const result = await window.kaiDesktop.gitDiffStat(activeProject.id).then(unwrap);
      if (result.error) {
        setWorkbenchNotice(result.error);
        return;
      }
      setContextChips((current) => [
        ...current.filter((chip) => chip.type !== 'gitDiff'),
        { type: 'gitDiff', stat: result.stat },
      ]);
      setContextPickerOpen(false);
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    } finally {
      setContextBusy(false);
    }
  }

  async function addMemoryContext(): Promise<void> {
    const query = (await promptDialog({
      title: 'Search memory',
      label: 'Cognitive1 memory query',
      placeholder: 'Search terms or a question',
      confirmLabel: 'Search',
    }))?.trim();
    if (!query) return;
    setContextBusy(true);
    try {
      const memories = await window.kaiDesktop.searchBrain({ query, maxResults: 8 }).then(unwrap);
      const summary = memories.length > 0
        ? memories.map((entry) => `${entry.title}\n${entry.project} / ${entry.type}\n${Object.values(entry.fields).filter(Boolean).join('\n')}`).join('\n\n')
        : `No recall results found for "${query}".`;
      setContextChips((current) => [
        ...current.filter((chip) => !(chip.type === 'memory' && chip.query === query)),
        { type: 'memory', query, summary },
      ]);
      setContextPickerOpen(false);
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    } finally {
      setContextBusy(false);
    }
  }

  /** Attaches every image given, one after another. A failure on one is reported and the rest still attach. */
  async function attachImageFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      setWorkbenchNotice('Attach a PNG, JPEG, GIF, or WebP image.');
      return;
    }
    setContextBusy(true);
    try {
      for (const file of images) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const chip = await window.kaiDesktop.saveAttachment(file.name, dataUrl).then(unwrap);
          if (chip.type !== 'image') throw new Error('The attachment service returned an invalid image chip.');
          // Each save has its own file, so two pasted screenshots that are both called image.png stay separate.
          setContextChips((current) => [...current.filter((item) => !(item.type === 'image' && item.path === chip.path)), chip]);
        } catch (caught) {
          setWorkbenchNotice(`${file.name}: ${messageOf(caught)}`);
        }
      }
    } finally {
      setContextBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }

  // Every run event card takes this as a prop. A fresh function each render would defeat their memoisation and put
  // the whole transcript back in the keystroke path, so its identity has to survive typing.
  const reviewTurnChanges = useCallback(async (turnId: string): Promise<void> => {
    if (!activeConversation) return;
    try {
      setCheckpointReview(await onReviewCheckpoint(activeConversation.id, turnId));
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    }
  }, [activeConversation, onReviewCheckpoint]);

  async function rejectReviewedFile(filePath: string): Promise<void> {
    if (!checkpointReview) return;
    try {
      await onRejectCheckpointFile(checkpointReview.conversationId, checkpointReview.turnId, filePath);
      setCheckpointReview(await onReviewCheckpoint(checkpointReview.conversationId, checkpointReview.turnId));
      setWorkbenchNotice(`Restored ${filePath} from the turn checkpoint.`);
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    }
  }

  // Show whether each reviewed file is covered by the latest passing check.
  useEffect(() => {
    if (!checkpointReview || !activeProject) return;
    let cancelled = false;
    void window.kaiDesktop.verificationOverview(activeProject.id).then((response) => {
      if (cancelled || !response.ok) return;
      setFileChecks(Object.fromEntries(response.data.files.map((file) => [file.path, file.status])));
    });
    return () => { cancelled = true; };
  }, [checkpointReview, activeProject]);

  async function rejectReviewedHunk(filePath: string, hunkId: number): Promise<void> {
    if (!checkpointReview) return;
    try {
      unwrap(await window.kaiDesktop.rejectCheckpointHunks(checkpointReview.conversationId, checkpointReview.turnId, filePath, [hunkId]));
      setCheckpointReview(await onReviewCheckpoint(checkpointReview.conversationId, checkpointReview.turnId));
      setWorkbenchNotice(`Rejected one change in ${filePath}.`);
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    }
  }

  const restoreTurnChanges = useCallback(async (turnId: string): Promise<void> => {
    if (!activeConversation) return;
    try {
      await onRestoreCheckpoint(activeConversation.id, turnId);
      setCheckpointReview(null);
      setWorkbenchNotice('Restored every file changed during that turn.');
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    }
  }, [activeConversation, onRestoreCheckpoint]);

  async function saveGoal(start: boolean): Promise<void> {
    if (!goalEditor?.outcome.trim() || !activeProject) return;
    const now = new Date().toISOString();
    const goal: WorkbenchGoal = activeGoal && activeGoal.outcome === goalEditor.outcome
      ? {
          ...activeGoal,
          constraints: goalEditor.constraints ?? '',
          verification: goalEditor.verification ?? '',
          updatedAt: now,
        }
      : {
          id: `goal_${crypto.randomUUID()}`,
          outcome: goalEditor.outcome.trim(),
          constraints: goalEditor.constraints?.trim() ?? '',
          verification: goalEditor.verification?.trim() ?? '',
          status: 'running',
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        };
    if (activeConversation) await onUpdateConversation({ ...activeConversation, goal, updatedAt: now });
    setGoalEditor(null);
    if (start) queueOrSend(goal.outcome, { ...sendOptions, goal });
  }

  async function updateGoalState(status: WorkbenchGoal['status']): Promise<void> {
    if (!activeConversation?.goal) return;
    const now = new Date().toISOString();
    const goal: WorkbenchGoal = status === 'completed'
      ? { ...activeConversation.goal, status, completedAt: now, updatedAt: now }
      : status === 'paused'
        ? { ...activeConversation.goal, status, pausedAt: now, updatedAt: now }
        : { ...activeConversation.goal, status, pausedAt: undefined, updatedAt: now };
    await onUpdateConversation({ ...activeConversation, goal, updatedAt: now });
  }

  async function clearGoal(): Promise<void> {
    if (!activeConversation) return;
    await onUpdateConversation({ ...activeConversation, goal: null, updatedAt: new Date().toISOString() });
  }

  async function togglePermission(key: PermissionKey, enabled: boolean): Promise<void> {
    if (!activeProject) return;
    await onUpdatePreferences({
      schemaVersion: 1,
      projectId: activeProject.id,
      ...(projectPreferences ?? {}),
      customPermissions: { ...projectPreferences?.customPermissions, [key]: enabled },
    });
  }

  const visibleSkills = skills.filter((skill) => {
    const query = skillQuery.trim().toLowerCase();
    return !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
  });
  const cost = activeConversation?.events.reduce((sum, event) => sum + (event.type === 'cost.update' ? event.amountUsd ?? 0 : 0), 0) ?? 0;
  // How many times KAI has sent a read-only helper (the `explore` tool) off in this conversation. Counted here,
  // not read off the transcript, because a finished helper's own card is collapsed by default and easy to miss.
  const helperAgentCount = (activeConversation?.events ?? [])
    .filter((event): event is Extract<PersistedEvent, { type: 'tool.call' }> => event.type === 'tool.call' && event.name === 'explore' && event.status === 'completed')
    .length;
  const rawEvents = (activeConversation?.events ?? [])
    .filter((event): event is Extract<PersistedEvent, { type: 'raw.fallback' }> => event.type === 'raw.fallback')
    .slice(-50)
    .reverse();
  const recentEvents = (activeConversation?.events ?? []).slice(-40);
  const runDetails = recentEvents.filter(isRunDetailEvent);
  // Errors and change summaries sit in the conversation where they happened, before the next message,
  // so a new message pushes them up instead of leaving them pinned under the chat.
  const inlineEventsByTurn = new Map<string, PersistedEvent[]>();
  const trailingInlineEvents: PersistedEvent[] = [];
  for (const event of (activeConversation?.events ?? []).filter((item) => !isRunDetailEvent(item)).slice(-100)) {
    const next = activeConversation?.turns.find((turn) => turn.role === 'user' && turn.createdAt > event.timestamp);
    if (!next) trailingInlineEvents.push(event);
    else inlineEventsByTurn.set(next.id, [...(inlineEventsByTurn.get(next.id) ?? []), event]);
  }
  /**
   * Whether anything is still going on this conversation. Paused and awaiting-approval count: a run parked on a
   * person still has a call in flight, so its cards must not read as interrupted. This is the same union the
   * composer's Stop button uses.
   */
  const runActive = running || paused || awaitingApproval;
  const renderInlineEvent = (event: PersistedEvent, defaultExpanded: boolean): ReactNode => <RunEventCard key={event.id} event={event} projectId={activeProject?.id ?? null} reviewMode={profile.reviewMode} defaultExpanded={defaultExpanded} runActive={runActive} onAskKai={askKaiStable} onReview={reviewTurnChanges} onUndo={restoreTurnChanges} onOpenVerification={onOpenVerification} />;
  const renderInlineEvents = (events: readonly PersistedEvent[]): ReactNode => groupExecutableCommands(events).map((group) => group.kind === 'commands'
    ? <ExecutableCommandsGroup key={group.key} events={group.events} runActive={runActive}>{group.events.map((event) => renderInlineEvent(event, false))}</ExecutableCommandsGroup>
    : renderInlineEvent(group.event, false));
  const timelineSummary = runDetails.reduce((summary, event) => {
    if (event.type === 'tool.call') summary.tools += 1;
    else if (event.type === 'file.edit.applied' || event.type === 'file.change' || event.type === 'diff.proposal') summary.edits += 1;
    else if (event.type === 'cost.update') summary.usage += 1;
    return summary;
  }, { tools: 0, edits: 0, usage: 0 });
  const activity = deriveAgentActivity(recentEvents, running, paused, awaitingApproval);
  // Autopilot runs a Studio plan, so it is reached through the plan this conversation was opened for — the studio id,
  // not the desktop project the plan happens to be registered as. Auto, by contrast, is about this conversation.
  const autopilotOrigin = activeConversation?.origin?.kind === 'autopilot' ? activeConversation.origin : null;
  const composerRun = useComposerRun(autopilotOrigin?.studioProjectId ?? null, activeConversation?.id ?? null);

  // A run KAI was closed in the middle of. Its status died with the process, so the board is still holding the card
  // under Autopilot's name and nothing else on this screen knows it. Asked for only for a conversation that came from
  // a plan, since that is the only conversation it could belong to.
  const [interruptedAutopilot, setInterruptedAutopilot] = useState<AutopilotRunRecord | null>(null);
  const interruptedProjectId = autopilotOrigin?.studioProjectId ?? null;
  useEffect(() => {
    setInterruptedAutopilot(null);
    if (!interruptedProjectId) return undefined;
    let cancelled = false;
    void window.kaiDesktop.autopilotInterrupted().then(unwrap)
      .then((runs) => { if (!cancelled) setInterruptedAutopilot(runs.find((record) => record.studioProjectId === interruptedProjectId) ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [interruptedProjectId]);

  /** Starts the recorded run again from the settings it was given; the loop takes back the card it still holds. */
  async function carryOnAutopilot(): Promise<void> {
    if (!interruptedAutopilot) return;
    setStoppingRun(true);
    try {
      setInterruptedAutopilot(null);
      const resumed = await settleWithin(
        () => window.kaiDesktop.resumeInterruptedAutopilot({ studioProjectId: interruptedAutopilot.studioProjectId }).then(unwrap),
        STOP_WAIT_MS,
      );
      if (!resumed.settled) setStuckNotice('Autopilot did not answer in time. Stop everything ends anything it started.');
    } catch (caught) {
      setWorkbenchNotice(`Autopilot could not carry on: ${messageOf(caught)}`);
    } finally {
      setStoppingRun(false);
    }
  }

  /** Hands the card back to the board instead, for someone who would rather start it clean. */
  async function releaseAutopilotCard(): Promise<void> {
    if (!interruptedAutopilot) return;
    setStoppingRun(true);
    try {
      const released = await settleWithin(
        () => window.kaiDesktop.releaseInterruptedAutopilot({ studioProjectId: interruptedAutopilot.studioProjectId }).then(unwrap),
        STOP_WAIT_MS,
      );
      if (!released.settled) setStuckNotice('The board did not answer in time. Stop everything ends anything it started.');
      else setInterruptedAutopilot(null);
    } catch (caught) {
      setWorkbenchNotice(`The card could not be put back: ${messageOf(caught)}`);
    } finally {
      setStoppingRun(false);
    }
  }
  const liveTokenEstimate = (activeConversation ? estimateConversationTokens(activeConversation) : 0) + Math.ceil(streamingText.length / 4);
  const refineBlocked = busy || running || paused || awaitingApproval || refiningPrompt;
  const refineTitle = !prompt.trim()
    ? 'Type a prompt to refine'
    : refineBlocked
      ? refiningPrompt ? 'Refining prompt' : 'Wait for the current action to finish'
      : refineTarget
        ? `Refine prompt with ${refineTarget}`
        : refineReason ?? 'Set up Prompt Guide or Direct API in Settings';

  /**
   * Stops the board's loop for the plan this conversation came from.
   *
   * The card it is holding is left where it is on purpose: Autopilot takes its own card back when it starts again, so
   * stopping here costs the run nothing. Auto is stopped by the composer's own button, which already ends both the
   * session and the turn in flight — see `cancelConversation` in `App`.
   */
  async function stopAutopilot(): Promise<void> {
    if (!autopilotOrigin) return;
    setStoppingRun(true);
    try {
      const stopped = await settleWithin(() => window.kaiDesktop.stopAutopilot({ projectId: autopilotOrigin.studioProjectId }), STOP_WAIT_MS);
      if (!stopped.settled) setStuckNotice('Autopilot did not answer in time, so it may still be running. Stop everything ends it.');
    } catch (caught) {
      setWorkbenchNotice(`Autopilot could not be stopped: ${messageOf(caught)}`);
    } finally {
      setStoppingRun(false);
    }
  }

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <div><span className="eyebrow">{activeConversation ? 'Conversation' : 'Workspace'}</span><h1>{activeConversation?.title ?? activeProject?.name ?? 'Open a project'}</h1></div>
        <div className="workspace-status">
          <button type="button" className={`status-action ${rawEventsOpen ? 'active' : ''}`} aria-pressed={rawEventsOpen} onClick={() => setRawEventsOpen((current) => !current)} title="Inspect raw fallback events"><Braces size={13} /><span>Raw</span><small>{rawEvents.length}</small></button>
          <span className={`status-pill ${ready ? 'ready' : 'unavailable'}`}><Circle size={7} fill="currentColor" /> {apiRun ? 'API' : 'CLI'} {ready ? 'ready' : 'unavailable'}</span>
          <span className="status-pill lavender"><Sparkles size={13} /> {apiRun ? directApiCapability?.model || directApiCapability?.displayName || 'Direct API' : selectedCapability?.version ?? selectedCapability?.displayName ?? selectedAgent}</span>
        </div>
      </div>

      <div className="workspace-notices">
        {interruptedRuns > 0 && !running && (
          <div className="workbench-notice recovery-banner" role="status">
            <span>{interruptedRuns} run{interruptedRuns === 1 ? ' was' : 's were'} interrupted the last time KAI closed.</span>
            <button type="button" className="secondary-button" onClick={onOpenRecovery}>Review</button>
          </div>
        )}

        {/* Something the composer was waiting on has passed its deadline. Rendering it here rather than in the
            composer is the point: the control that is stuck is inside the composer, so the way out has to be
            somewhere the stuck call cannot disable. */}
        {stuckNotice && (
          <div className="workbench-notice workbench-error" role="alert">
            <span>{stuckNotice}</span>
            <button type="button" className="secondary-button" onClick={onStopEverything}>Stop everything</button>
            <button type="button" className="icon-button compact" aria-label="Dismiss notice" onClick={() => setStuckNotice(null)}><X size={13} /></button>
          </div>
        )}

        {/* Said here because this is the conversation that card was being worked in. A run that closed mid-card, or
            one stopped by hand, leaves the board holding the card with nothing running for it — and this is the only
            screen that can offer to carry on from where it stopped rather than starting the card over. */}
        {interruptedAutopilot && (
          <div className="workbench-notice recovery-banner" role="status">
            <span>
              The board still has &ldquo;{interruptedAutopilot.cardTitle}&rdquo; marked In progress from an Autopilot run that is no longer going.
            </span>
            <button type="button" className="secondary-button" disabled={stoppingRun} onClick={() => void carryOnAutopilot()}>Carry on</button>
            <button type="button" className="secondary-button" disabled={stoppingRun} onClick={() => void releaseAutopilotCard()}>Put the card back</button>
          </div>
        )}

        {activeConversation && !running && estimateConversationTokens(activeConversation) >= COMPACTION_WARNING_TOKENS && (
          <div className="workbench-notice compaction-banner" role="status">
            <span>This conversation is about {formatCompact(estimateConversationTokens(activeConversation))} tokens. Compact it before the context window fills.</span>
            <button type="button" className="secondary-button" disabled={busy} onClick={onCompactConversation}>Compact</button>
            <button type="button" className="secondary-button" disabled={busy} onClick={onContinueInNewTab} title="Summarise this conversation and carry on in a new tab">Continue in new tab</button>
          </div>
        )}

        <UsageBanner conversationId={activeConversation?.id} refreshToken={activeConversation?.events.length} onOpenUsage={onOpenUsage} />

        {workbenchNotice && (
          <div className="workbench-notice" role="status">
            <span>{workbenchNotice}</span>
            <button type="button" className="icon-button compact" aria-label="Dismiss notice" onClick={() => setWorkbenchNotice(null)}><X size={13} /></button>
          </div>
        )}

        {/* What the app is saying about the run that is going right now — "the run is paused", "this run cannot be
            paused from here". It was only ever rendered inside the setup banner, which is shown when no agent is
            ready, so every one of these was written and never seen. */}
        {notice && running && (
          <div className="workbench-notice" role="status">
            <span>{notice}</span>
          </div>
        )}
      </div>

      {skillsOpen && (
        <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Skills">
          <div className="skills-panel">
            <div className="skills-panel-head">
              <div><span className="eyebrow">Project capabilities</span><h2>Skills</h2></div>
              <button type="button" className="icon-button compact" aria-label="Close skills" onClick={() => setSkillsOpen(false)}><X size={15} /></button>
            </div>
            <label className="input-with-icon"><Search size={14} /><input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="Search skills" autoFocus /></label>
            <div className="skills-list">
              {visibleSkills.map((skill) => {
                const selected = selectedSkills.some((item) => item.name === skill.name);
                return (
                    <button key={`${skill.scope}:${skill.path}`} type="button" className={`skill-row ${selected ? 'selected' : ''}`} onClick={() => { setSelectedSkills((current) => selected ? current.filter((item) => item.name !== skill.name) : [...current, skill]); setPrompt((current) => /\$[A-Za-z0-9_-]*$/.test(current) ? current.replace(/\$[A-Za-z0-9_-]*$/, `$${skill.name} `) : current); }}>
                    <span><strong>${skill.name}</strong><small>{skill.scope}</small></span>
                    <p>{skill.description}</p>
                  </button>
                );
              })}
              {visibleSkills.length === 0 && <div className="empty-list">No matching skills</div>}
            </div>
          </div>
        </div>
      )}

      {runDetailsOpen && composerRun && (
        <ComposerRunDetails
          title={composerRun.line.who === 'autopilot' ? 'Autopilot' : 'Auto'}
          run={composerRun}
          onClose={() => setRunDetailsOpen(false)}
        >
          {composerRun.line.who === 'auto' && (
            <AutoSettings projectId={activeProject?.id ?? null} execution={executionMode} running={composerRun.line.canStop} />
          )}
        </ComposerRunDetails>
      )}

      {rawEventsOpen && (
        <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Raw event inspector">
          <div className="skills-panel raw-event-panel">
            <div className="skills-panel-head">
              <div><span className="eyebrow">Diagnostics</span><h2>Raw event inspector</h2></div>
              <button type="button" className="icon-button compact" aria-label="Close raw event inspector" onClick={() => setRawEventsOpen(false)}><X size={15} /></button>
            </div>
            <div className="raw-event-list">
              {rawEvents.map((event) => (
                <article className="raw-event" key={event.id}>
                  <div className="raw-event-heading">
                    <strong>{event.sourceType}</strong>
                    <span>{new Date(event.timestamp).toLocaleString()}{event.agent ? ` · ${event.agent}` : ''}</span>
                    <button type="button" className="secondary-button" onClick={() => void copyRawEvent(event.payload, setWorkbenchNotice)}>Copy payload</button>
                  </div>
                  <pre>{formatRawPayload(event.payload)}</pre>
                </article>
              ))}
              {rawEvents.length === 0 && <div className="empty-list">No raw fallback events captured in this conversation</div>}
            </div>
          </div>
        </div>
      )}

      {brainDraft !== null && activeProject && (
        <SaveToBrainDialog text={brainDraft} project={activeProject.name} onClose={() => setBrainDraft(null)} onSaved={setWorkbenchNotice} />
      )}

      {checkpointReview && createPortal(
        <div className="skills-overlay checkpoint-overlay" role="dialog" aria-modal="true" aria-label="Review turn changes">
          <div className="skills-panel checkpoint-panel">
            <div className="skills-panel-head">
              <div><span className="eyebrow">Checkpoint review</span><h2>{checkpointReview.files.length} changed file{checkpointReview.files.length === 1 ? '' : 's'}</h2></div>
              <div className="checkpoint-head-actions">
                <button type="button" className="secondary-button" onClick={() => void restoreTurnChanges(checkpointReview.turnId)}><Undo2 size={14} /><span>Undo all</span></button>
                <button type="button" className="icon-button compact" aria-label="Close checkpoint review" onClick={() => setCheckpointReview(null)}><X size={15} /></button>
              </div>
            </div>
            {!checkpointReview.gitAvailable && <div className="workbench-error">This turn has no Git checkpoint, so files cannot be restored automatically.</div>}
            <div className="checkpoint-files">
              {checkpointReview.files.map((file) => (
                <article className="checkpoint-file" key={file.path}>
                  <div className="checkpoint-file-heading">
                    <div><strong>{file.path}</strong> <VerificationBadge status={fileChecks[file.path] ?? 'unverified'} /><span><b className="diff-add">+{file.added}</b><b className="diff-remove">-{file.removed}</b>{file.binary ? ' · binary' : ''}</span></div>
                    <button type="button" className="secondary-button" disabled={!checkpointReview.gitAvailable} onClick={() => void rejectReviewedFile(file.path)}><Undo2 size={13} /><span>Restore file</span></button>
                  </div>
                  {!file.binary && checkpointReview.gitAvailable && canReviewHunks(file.before, file.after) && (
                    <HunkReview before={file.before} after={file.after} disabled={false} onReject={(hunkId) => void rejectReviewedHunk(file.path, hunkId)} />
                  )}
                  {!file.binary && !(checkpointReview.gitAvailable && canReviewHunks(file.before, file.after)) && (
                    <div className="checkpoint-diff">
                      <div><span>Before</span><pre>{file.before || '(empty)'}</pre></div>
                      <div><span>After</span><pre>{file.after || '(empty)'}</pre></div>
                    </div>
                  )}
                </article>
              ))}
              {checkpointReview.files.length === 0 && <div className="empty-list">No files differ from this checkpoint</div>}
            </div>
          </div>
        </div>
      , document.body)}

      <div ref={canvasRef} className="conversation-canvas" onScroll={onCanvasScroll}>
        {activeConversation?.turns.length || streamingText || pendingUser || pendingQuestion ? (
          <>
            {activeConversation?.turns.map((turn, index) => (
              <Fragment key={turn.id}>
                {renderInlineEvents(inlineEventsByTurn.get(turn.id) ?? [])}
                <MessageTurn
                  turn={turn}
                  brainReady={brainReady}
                  onSaveToBrain={setBrainDraft}
                  onBranch={onBranchTurn}
                  onRewind={onRewindTurn}
                  onOpenFile={onOpenFile}
                  awaitingAnswer={Boolean(turn.awaitingAnswer) && !running && index === activeConversation.turns.length - 1}
                  onAnswer={queueOrSendStable}
                />
              </Fragment>
            ))}
            {pendingUser && (activeConversation?.turns.length ?? 0) <= pendingUser.baseCount && (
              <article className="message user">
                <div className="message-role">You</div>
                <MessageContent text={pendingUser.text} />
                {pendingUser.images.length > 0 && (
                  <div className="message-attachments" aria-label="Attached images">
                    {pendingUser.images.map((image) => <ImageCard key={`${image.name}-${image.dataUrl.slice(-24)}`} name={image.name} dataUrl={image.dataUrl} />)}
                  </div>
                )}
              </article>
            )}
            {streamingText && <article className="message assistant streaming"><div className="message-role">KAI</div><Markdown text={streamingText} onOpenFile={onOpenFile} /></article>}
            {pendingQuestion && <InlineQuestion key={pendingQuestion.requestId} question={pendingQuestion} onAnswer={onAnswerQuestion} />}
            {running && (
              <WorkProgressTimeline events={recentEvents} activity={activity} paused={paused} elapsedSeconds={elapsedSeconds} tokenEstimate={liveTokenEstimate} />
            )}
            {/* The run in progress shows its changes as they happen; a finished one keeps them closed. */}
            {/* Commands and edits stay folded to one line while the run is live too; opening one is the reader's choice. */}
            {renderInlineEvents(trailingInlineEvents)}
            {runDetails.length > 0 && (
              <section className="run-details" aria-label="Activity timeline">
                <button type="button" className="run-details-toggle" aria-expanded={showRunDetails} onClick={() => setShowRunDetails((current) => !current)}>
                  <ChevronDown size={13} />
                  <span>Activity</span>
                  <small>{timelineSummary.tools ? `${timelineSummary.tools} actions` : ''}{timelineSummary.edits ? `${timelineSummary.tools ? ' · ' : ''}${timelineSummary.edits} edits` : ''}{timelineSummary.usage ? `${timelineSummary.tools || timelineSummary.edits ? ' · ' : ''}usage` : ''}</small>
                </button>
                {showRunDetails && (
                  <div className="run-details-list">
                    {renderInlineEvents(runDetails)}
                  </div>
                )}
              </section>
            )}
            {compareResult && (
              <ComparePanel
                result={compareResult}
                onPick={async (id, side) => {
                  await onPickCompare(id, side);
                  setCompareResult(null);
                  setWorkbenchNotice(`Applied the ${side} agent's changes to the workspace.`);
                }}
                onOpen={onOpenCompareWorktree}
                onDiscard={async (id) => {
                  await onDiscardCompare(id);
                  setCompareResult(null);
                }}
              />
            )}
            {comparing && <div className="thinking"><span className="spinner" /><span className="status-word">Comparing agents</span><span className="status-timer">0s</span></div>}
          </>
        ) : (
          <div className="workspace-empty">
            <Sparkles size={40} />
            <h2>Ready when you are</h2>
            <p>Send a message to KAI, use <code>/goal</code> for durable work, or type <code>$</code> to invoke a skill.</p>
            {!activeProject && <button type="button" className="primary-button" onClick={onChooseProject}><FolderOpen size={16} /><span>Open project</span></button>}
          </div>
        )}
      </div>

      <div className="composer">
        {proxyContinuationAgent === selectedAgent && !apiRun && effectiveRoute === 'direct' && (
          <div className="composer-route-handoff" role="status">
            <Route size={15} />
            <div>
              <strong>{selectedCapability?.displayName ?? 'This agent'} reached its account limit</strong>
              <span>Keep this conversation and switch only its next run to {settings.proxy.defaultModel} through your configured Universal Proxy. KAI will show the provider and budget before any API request.</span>
            </div>
            <button type="button" className="primary-button" disabled={!proxyReady || busy} onClick={() => void confirmProxyContinuation(proxyContinuationAgent)}>
              <Route size={13} /><span>{proxyReady ? 'Continue via proxy' : 'Start proxy first'}</span>
            </button>
          </div>
        )}
        {activeConversation && (running || paused || awaitingApproval) && <AgentActivityStrip
          events={activeConversation.events}
          running={running}
          paused={paused}
          awaitingApproval={awaitingApproval}
          elapsedSeconds={elapsedSeconds}
          tokenEstimate={liveTokenEstimate}
        />}
        {/* A missing CLI is explained even before a project is open, so the user knows how to get it. */}
        {(activeProject || (!apiRun && selectedCapability?.state === 'not_installed')) && !ready && (apiRun ? directApiCapability : selectedCapability) && (
          <div className="agent-setup-banner" role="status">
            <div className="agent-setup-copy">
              <strong>{apiRun ? 'API setup required' : setupTitle(selectedCapability!)}</strong>
              <span>{notice ?? unavailableReason}</span>
              {!apiRun && selectedCapability?.state === 'not_installed' && selectedCapability.installCommand && (
                <div className="agent-install-command">
                  <code title="Official install command">{selectedCapability.installCommand}</code>
                  <button type="button" className="icon-button" title="Copy install command" aria-label="Copy install command" onClick={() => void navigator.clipboard.writeText(selectedCapability.installCommand!).catch(() => undefined)}>
                    <Copy size={13} />
                  </button>
                </div>
              )}
            </div>
            <div className="agent-setup-actions">
              {!apiRun && selectedCapability?.state === 'not_installed' && (
                <button type="button" className="primary-button" onClick={() => onInstall(selectedAgent)} disabled={busy}>
                  <Download size={14} />
                  <span>Install</span>
                </button>
              )}
              {!apiRun && selectedCapability?.state === 'signed_out' && (
                <button type="button" className="secondary-button" onClick={() => onSignIn(selectedAgent)} disabled={busy}>
                  <LogIn size={14} />
                  <span>Sign in</span>
                </button>
              )}
              {apiRun ? (
                <button type="button" className="secondary-button" onClick={onOpenSettings} disabled={busy}>
                  <Settings2 size={14} />
                  <span>Configure API</span>
                </button>
              ) : (
                <a className="secondary-button" href={selectedCapability!.installUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  <span>Install guide</span>
                </a>
              )}
              <button type="button" className="secondary-button" onClick={onRefreshAgents} disabled={busy}>
                <RefreshCw size={14} />
                <span>Refresh status</span>
              </button>
            </div>
          </div>
        )}
        {activeGoal && (
          <div className={`goal-progress status-${activeGoal.status}`}>
            <span className="goal-target"><Goal size={15} /></span>
            <div className="goal-copy"><strong>{activeGoal.outcome}</strong><small>{activeGoal.status}{activeGoal.verification ? ` · ${activeGoal.verification}` : ''}</small></div>
            <div className="goal-actions">
              {activeGoal.status === 'running'
                ? <button type="button" title="Pause goal" onClick={() => void updateGoalState('paused')}><Square size={11} /></button>
                : <button type="button" title="Resume goal" onClick={() => void updateGoalState('running')}><Play size={12} /></button>}
              <button type="button" title="Complete goal" onClick={() => void updateGoalState('completed')}><Check size={12} /></button>
              <button type="button" title="Clear goal" onClick={() => void clearGoal()}><X size={12} /></button>
            </div>
          </div>
        )}
        {queuedPrompts.length > 0 && (
          <div className="queue-list">
            {queuedPrompts.map((item, index) => (
              <div className="queue-row" key={item.id}>
                <span className="queue-label" title={item.status === 'sending' ? 'Sending instruction' : item.status === 'blocked' ? 'Delivery failed' : 'Queued instruction'}><GitFork size={12} /></span><span className="truncate">{item.text}</span>
                <span className="queue-status">{item.status === 'sending' ? 'Sending' : item.status === 'blocked' ? 'Needs retry' : 'Waiting'}</span>
                {item.status === 'blocked' && <button type="button" aria-label="Retry queued prompt" title={item.error ?? 'Retry queued prompt'} onClick={() => onUpdateQueuedPrompt(item.id, 'retry')}><RefreshCw size={12} /></button>}
                <button
                  type="button"
                  className="queue-steer-button"
                  aria-label="Send queued prompt now"
                  title={running ? apiRun ? 'Handle this instruction now, then resume the active task' : 'CLI runs cannot accept live messages; this will send after the run ends' : 'Send this instruction next'}
                  disabled={item.status === 'sending' || (running && !apiRun)}
                  onClick={() => steerQueuedPrompt(index)}
                ><ArrowRight size={12} /><span>{running && !apiRun ? 'After run' : 'Steer now'}</span></button>
                <button type="button" aria-label="Edit queued prompt" title="Edit queued prompt" disabled={item.status === 'sending'} onClick={() => { setPrompt(item.text); onUpdateQueuedPrompt(item.id, 'remove'); promptRef.current?.focus(); }}><Pencil size={12} /></button>
                <button type="button" aria-label="Remove queued prompt" title="Remove queued prompt" disabled={item.status === 'sending'} onClick={() => onUpdateQueuedPrompt(item.id, 'remove')}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="context-chip-row">
          {selectedFiles.map((file) => (
            <span className="context-chip" key={file} title={file}><File size={11} /><span className="truncate">{file}</span><button type="button" aria-label={`Remove ${file}`} onClick={() => setSelectedFiles((current) => current.filter((item) => item !== file))}><X size={11} /></button></span>
          ))}
          {contextChips.map((chip) => chip.type === 'image' && chip.dataUrl ? (
            <ImageChip
              key={contextChipKey(chip)}
              name={chip.name}
              dataUrl={chip.dataUrl}
              onRemove={() => setContextChips((current) => current.filter((item) => contextChipKey(item) !== contextChipKey(chip)))}
            />
          ) : (
            <span className={`context-chip ${chip.type}-chip`} key={contextChipKey(chip)} title={contextChipLabel(chip)}>
              {contextChipIcon(chip.type)}
              <span className="truncate">{contextChipLabel(chip)}</span>
              <button type="button" aria-label={`Remove ${contextChipLabel(chip)}`} onClick={() => setContextChips((current) => current.filter((item) => contextChipKey(item) !== contextChipKey(chip)))}><X size={11} /></button>
            </span>
          ))}
          {selectedSkills.map((skill) => (
            <span className="context-chip skill-chip" key={skill.name}>${skill.name}<button type="button" aria-label={`Remove ${skill.name}`} onClick={() => setSelectedSkills((current) => current.filter((item) => item.name !== skill.name))}><X size={11} /></button></span>
          ))}
        </div>
        {contextChips.filter((chip): chip is Extract<ContextChip, { type: 'memory' }> => chip.type === 'memory').map((chip) => (
          <div className="brain-brief" key={`brief:${chip.query}`} role="status">
            <Brain size={14} />
            <div><strong>Brain brief</strong><span>{chip.summary || `Memory search: ${chip.query}`}</span></div>
            <button type="button" className="icon-button compact" aria-label="Remove Brain brief" title="Remove Brain brief" onClick={() => setContextChips((current) => current.filter((item) => item !== chip))}><X size={12} /></button>
          </div>
        ))}
        {contextPickerOpen && activeProject && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Add context">
          <div className="context-picker skills-panel">
            <div className="context-picker-head">
              <div><strong>Add context</strong><span>Files, selections, changes, memory, or an image</span></div>
              <button type="button" className="icon-button compact" aria-label="Close context picker" onClick={() => setContextPickerOpen(false)}><X size={14} /></button>
            </div>
            <div className="context-picker-actions">
              <button type="button" disabled={contextBusy} onClick={() => void addSelectionContext()}><Braces size={14} /><span>Current selection</span></button>
              <button type="button" disabled={contextBusy} onClick={() => void addGitDiffContext()}><FileDiff size={14} /><span>Uncommitted changes</span></button>
              <button type="button" disabled={contextBusy} onClick={() => void addMemoryContext()}><Brain size={14} /><span>Search memory</span></button>
              <button type="button" disabled={contextBusy} onClick={() => imageInputRef.current?.click()}><ImagePlus size={14} /><span>Attach image</span></button>
            </div>
            <label className="input-with-icon context-file-search"><FileSearch size={14} /><input autoFocus value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Search project files" /></label>
            <div className="context-file-results">
              {fileResults.map((file) => (
                <button type="button" key={file} onClick={() => { setSelectedFiles((current) => [...new Set([...current, file])]); setContextPickerOpen(false); setFileQuery(''); setPrompt((current) => current.replace(/@[^\s]*$/, '').trimEnd()); }}>
                  <AtSign size={12} /><span className="truncate">{file}</span>
                </button>
              ))}
              {contextBusy && <div className="empty-list">Searching project files</div>}
              {!contextBusy && fileResults.length === 0 && <div className="empty-list">No matching files</div>}
            </div>
          </div>
          </div>
        )}
        {goalEditor && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Goal">
          <div className="goal-editor skills-panel">
            <div className="goal-editor-head"><strong>Goal</strong><span>Outcome, constraints, and proof of completion</span></div>
            <label><span>Outcome</span><textarea rows={2} value={goalEditor.outcome} onChange={(event) => setGoalEditor({ ...goalEditor, outcome: event.target.value })} placeholder="What should be true when this work is done?" /></label>
            <label><span>Constraints</span><textarea rows={2} value={goalEditor.constraints ?? ''} onChange={(event) => setGoalEditor({ ...goalEditor, constraints: event.target.value })} placeholder="Required tools, boundaries, or approaches to avoid" /></label>
            <label><span>Verification</span><textarea rows={2} value={goalEditor.verification ?? ''} onChange={(event) => setGoalEditor({ ...goalEditor, verification: event.target.value })} placeholder="Tests, measurements, or review criteria that prove completion" /></label>
            <div className="button-row align-end"><button type="button" className="secondary-button" onClick={() => setGoalEditor(null)}>Cancel</button><button type="button" className="secondary-button" onClick={() => void saveGoal(false)}>Save</button><button type="button" className="primary-button" onClick={() => void saveGoal(true)}>Start goal</button></div>
          </div>
          </div>
        )}
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            if (files.length > 0) void attachImageFiles(files);
          }}
        />
        {activeProject && <PlanStrip projectId={activeProject.id} refreshKey={activeConversation?.updatedAt} />}
        {/* `busy` here is the boolean prop. It used to be compared to null, which is always true, so the Stop
            button on this line was disabled on every run: the one control that ends a run was unreachable. */}
        {composerRun && (
          <ComposerRunLine
            state={composerRun.line}
            busy={stoppingRun || busy}
            onStop={() => void (composerRun.line.who === 'autopilot' ? stopAutopilot() : onCancel())}
            onOpenDetails={() => setRunDetailsOpen(true)}
          />
        )}
        {taskIntent === 'equalizer' && activeProject && (
          <EqualizerPanel projectId={activeProject.id} message={prompt} onFix={applyEqualizerFix} />
        )}
        <div className={`composer-box${composerRun ? ` run-${composerRun.line.state}` : ''}`}>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => {
              const value = event.target.value;
              setPrompt(value);
              if (/(?:^|\s)@[^\s]*$/.test(value)) {
                setContextPickerOpen(true);
                setFileQuery(value.split('@').pop() ?? '');
              }
              const skillMatch = /(?:^|\s)\$([A-Za-z0-9_-]*)$/.exec(value);
              if (skillMatch) {
                setSkillsOpen(true);
                setSkillQuery(skillMatch[1]);
              }
            }}
            onPaste={(event) => {
              const files = [...event.clipboardData.items]
                .filter((item) => item.type.startsWith('image/'))
                .flatMap((item) => item.getAsFile() ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void attachImageFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                cycleAutonomy();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if ((event.altKey || event.ctrlKey || event.metaKey) && running) steerNow();
                else send();
              }
              if (event.key === 'Escape') {
                setGoalEditor(null);
                setContextPickerOpen(false);
              }
            }}
            placeholder={activeTaskIntent.placeholder}
            aria-label="Task prompt"
            disabled={!activeProject || (busy && !running) || !ready || refiningPrompt}
          />
          <div className="composer-toolbar">
            <div className="composer-leading">
              <button type="button" className={`composer-icon-button ${contextPickerOpen ? 'active' : ''}`} onClick={() => setContextPickerOpen((current) => !current)} title="Add files, images, memory, or project context" aria-label="Add context"><Plus size={15} /></button>
              <SelectMenu ariaLabel="Task type" className="composer-task-select" disabled={busy} icon={<Sparkles size={14} />} labelPrefix="Task" onChange={chooseTaskIntent} options={TASK_INTENTS.map((intent) => ({ value: intent.id, label: intent.label, description: intent.description }))} title="Choose a task guide; this does not change access" value={taskIntent} />
              <SelectMenu ariaLabel="Access level" className="composer-access-select" disabled={busy} icon={<ShieldCheck size={14} />} labelPrefix="Access" onChange={onSelectAutonomy} options={ACCESS_OPTIONS} title="Choose how much access KAI has" value={selectedAutonomy} />
              <SelectMenu ariaLabel="Reply style" className="composer-style-select" disabled={busy} icon={<Lightbulb size={14} />} onChange={(value) => onSelectStyle(value as ResponseStyle)} options={RESPONSE_STYLES.map((style) => ({ value: style, label: RESPONSE_STYLE_LABEL[style], description: RESPONSE_STYLE_DESCRIPTION[style] }))} title="How the agent words what it tells you" value={selectedStyle} />
              {helperAgentCount > 0 && (
                <span
                  className="composer-helper-pill"
                  title={`KAI sent ${helperAgentCount} read-only helper agent${helperAgentCount === 1 ? '' : 's'} off to look into something in this conversation`}
                >
                  <Search size={12} /><span>{helperAgentCount}</span>
                </span>
              )}
              {/* Route is the one rarely-used choice, so it sits behind this gear. CLI/API, agent, model and effort are
                  on the right, always in view: they are what a person changes between windows. */}
              <button type="button" className={`composer-icon-button composer-advanced-toggle ${advancedComposerOpen ? 'active' : ''}`} aria-expanded={advancedComposerOpen} aria-label="More run options" title="More run options (route)" onClick={() => setAdvancedComposerOpen((open) => !open)} disabled={busy}><Settings2 size={14} /></button>
              {advancedComposerOpen && <SelectMenu ariaLabel="Route" className={`control-select route-select ${effectiveRoute === 'proxy' && !proxyReady ? 'unavailable' : ''}`} disabled={busy || !routeAvailable} icon={<Route size={14} />} onChange={onSelectRoute} options={[{ value: 'direct', label: 'Direct' }, { value: 'proxy', label: proxyReady ? 'Proxy' : 'Proxy (not ready)', disabled: !routeAvailable || !proxyReady }]} title={!routeAvailable ? 'This agent does not support the Universal Proxy route' : proxyReady ? 'Choose direct provider access or the KAI Universal Proxy route' : 'Start Universal Proxy in Settings to use the proxy route'} value={effectiveRoute} />}
            </div>
            <div className="composer-actions">
              <div className="mode-toggle" role="group" aria-label="Execution mode">
                <button type="button" className={!apiRun ? 'active' : ''} aria-pressed={!apiRun} onClick={() => onSelectExecution('cli')} disabled={busy}><span>CLI</span></button>
                <button type="button" className={apiRun ? 'active' : ''} aria-pressed={apiRun} onClick={() => onSelectExecution('api')} disabled={busy}><span>API</span></button>
              </div>
              {apiRun ? (
                <button type="button" className="composer-icon-button" title={`${providerLabel} — open provider settings`} aria-label={`Provider: ${providerLabel}. Open provider settings`} onClick={onOpenSettings} disabled={busy}><Cloud size={14} /></button>
              ) : <SelectMenu ariaLabel="Agent" className={`agent-select ${ready ? '' : 'unavailable'}`} disabled={busy} icon={<Cpu size={14} />} onChange={onSelectAgent} options={agentCapabilities.map((agent) => ({ value: agent.id, label: `${agent.displayName}${setupSuffix(agent)}` }))} title={selectedCapability?.unavailableReason ?? 'Which agent works on this conversation'} value={selectedAgent} />}
              <SelectMenu ariaLabel="Model" className="composer-model-select" disabled={busy} icon={<Sparkles size={14} />} onChange={(value) => { if (value !== CUSTOM_MODEL) { onSelectModel(value); return; } void promptDialog({ title: 'Use a custom model', label: 'Model name', initialValue: selectedModel, placeholder: 'provider/model-name', confirmLabel: 'Use model', validate: validateModelName }).then((typed) => { if (typed) onSelectModel(typed); }); }} options={modelOptions(apiRun, selectedAgent, directApiCapability, selectedModel)} title="Model for this conversation" value={selectedModel} />
              {!apiRun && reasoningLevels.length > 0 && (
                <SelectMenu ariaLabel="Thinking effort" className="composer-effort-select" disabled={busy} icon={<Brain size={14} />} onChange={(value) => onSelectReasoning(value as ReasoningEffort | '')} options={[{ value: '', label: 'Effort: default' }, ...reasoningLevels.map((level) => ({ value: level, label: REASONING_LABEL[level] }))]} title="How hard the agent thinks on this conversation's next runs" value={selectedReasoning} />
              )}
              <button type="button" className={`composer-icon-button ${refiningPrompt ? 'active' : ''}`} disabled={!prompt.trim() || refineBlocked || !refineTarget} onClick={() => void refinePromptDraft()} title={refineTitle} aria-label="Refine prompt">{refiningPrompt ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />}</button>
              {(running || paused || awaitingApproval) ? (
                <>
                  {running && <button type="button" className="send-button" disabled={!canSendPrompt || busy || refiningPrompt} onClick={send} title="Queue for the next turn" aria-label="Queue message"><Send size={13} /></button>}
                  {running && apiRun && <button type="button" className="send-button" disabled={!prompt.trim() || interjecting} onClick={interjectNow} title="Steer this run at its next model step" aria-label="Steer active run"><ArrowRight size={13} /></button>}
                  {!awaitingApproval && <button type="button" className="send-button pause-button" onClick={paused ? onResume : onPause} title={paused ? 'Resume agent' : 'Pause agent'} aria-label={paused ? 'Resume agent' : 'Pause agent'}>{paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}</button>}
                  <button type="button" className="send-button stop-button" onClick={onCancel} title="Stop agent" aria-label="Stop agent"><Square size={13} fill="currentColor" /></button>
                </>
              ) : <button type="button" className="send-button" disabled={!activeProject || !canSendPrompt || busy || startingAuto || refiningPrompt || !ready} onClick={send} title={taskIntent === 'auto' ? 'Send and Auto works it until it is done' : activeConversation ? 'Send message' : 'Start conversation'} aria-label={taskIntent === 'auto' ? 'Start Auto on this task' : activeConversation ? 'Send message' : 'Start conversation'}>{startingAuto ? <Loader2 className="spin" size={15} /> : <Send size={16} />}</button>}
            </div>
          </div>
        </div>
        {taskIntent === 'auto' && !AUTO_WORKING_AUTONOMY.has(selectedAutonomy) && (
          <p className="composer-task-guidance" role="note">
            <span>Auto works on its own, so it needs Edit files or Full access, and Access is lower than that.</span>{' '}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { onSelectAutonomy('autoEdit'); if (prompt.trim()) setSendWhenAccessReady(true); }}>{prompt.trim() ? 'Use Edit files and send' : 'Use Edit files'}</button>
          </p>
        )}
        {taskIntent === 'build' && selectedAutonomy === 'plan' && (
          <p className="composer-task-guidance" role="note">With Plan only access, KAI can plan this build but cannot edit files.</p>
        )}
        {advancedComposerOpen && selectedAutonomy === 'custom' && activeProject && (
          <div className="permission-grid">
            {PERMISSIONS.map((permission) => (
              <label key={permission.key} title={permission.description}>
                <input type="checkbox" checked={Boolean(projectPreferences?.customPermissions?.[permission.key])} onChange={(event) => void togglePermission(permission.key, event.target.checked)} />
                <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
              </label>
            ))}
          </div>
        )}
        <div className="command-chip-row">{COMMANDS.map((command) => <button type="button" key={command} onClick={() => applyCommand(command)}>{command}</button>)}</div>
        {profile.explainAccess && <p className="access-hint" role="note"><ShieldCheck size={12} /><span><strong>{ACCESS_LEVELS.find((level) => level.value === selectedAutonomy)?.label}:</strong> {ACCESS_LEVELS.find((level) => level.value === selectedAutonomy)?.description}</span></p>}
        <div className="composer-footer"><span>{running ? `Enter to queue${apiRun ? ' · Alt/Ctrl+Enter to steer' : ''}` : 'Enter to send · Shift+Enter for a new line'} · Shift+Tab to change access</span><span>{cost > 0 ? `$${cost.toFixed(4)} session` : activeConversation?.compaction ? `Context compacted ${relativeTime(activeConversation.compaction.createdAt)}` : activeConversation ? `${activeConversation.turns.length} messages` : 'New conversation'}</span></div>
      </div>
    </div>
  );
}

/**
 * A stable identity for a handler that closes over state which changes.
 *
 * The two components that repeat per message are memoised so a keystroke does not redraw the whole transcript, and
 * that only works if the handlers they are given do not change. A plain function declared in the component body is a
 * new function on every render, so the memo compared unequal and redrew anyway — every character, the entire
 * transcript, which is what the memo was for.
 *
 * The callback forwards to the latest closure, so nothing goes stale: the identity is fixed, the behaviour is not.
 */
function useLatestHandler<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}

// The composer's prompt lives in Workspace state, so every keystroke re-renders it. Without memoising the two
// components that repeat per message, each character redraws the entire transcript and typing lags behind the
// keyboard. Their props are already stable: the turn and event objects are replaced only when the run changes.
const RunEventCard = memo(RunEventCardBase);

type InlineEventGroup =
  | { kind: 'event'; event: PersistedEvent }
  | { kind: 'commands'; key: string; events: Array<Extract<PersistedEvent, { type: 'tool.call' }>> };

const EXECUTABLE_COMMAND_TOOLS = new Set(['run_command', 'bash', 'shell_command']);

function isExecutableCommandTool(name: string): boolean {
  return EXECUTABLE_COMMAND_TOOLS.has(name.toLowerCase());
}

/** Keep the transcript's order, but turn a noisy streak of shell calls into one readable disclosure. */
export function groupExecutableCommands(events: readonly PersistedEvent[]): InlineEventGroup[] {
  const groups: InlineEventGroup[] = [];
  for (const event of events) {
    const isCommand = event.type === 'tool.call' && isExecutableCommandTool(event.name);
    const previous = groups[groups.length - 1];
    if (isCommand && previous?.kind === 'commands') {
      previous.events.push(event);
    } else if (isCommand) {
      groups.push({ kind: 'commands', key: `commands-${event.id}`, events: [event] });
    } else {
      groups.push({ kind: 'event', event });
    }
  }
  return groups;
}

function ExecutableCommandsGroup({ events, runActive, children }: { events: Array<Extract<PersistedEvent, { type: 'tool.call' }>>; runActive: boolean; children: ReactNode }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const failed = events.filter((event) => event.status === 'failed').length;
  const runningCount = events.filter((event) => toolCallStatus(event.status, runActive).mark === 'spin').length;
  const interrupted = events.filter((event) => toolCallStatus(event.status, runActive).mark === 'dash').length;
  const summary = failed > 0
    ? `${failed} failed`
    : runningCount > 0
      ? `${runningCount} running`
      : interrupted > 0
        ? `${interrupted} interrupted`
        : 'Done';
  return (
    <section className={`command-group${failed > 0 ? ' failed' : ''}`} aria-label={`${events.length} executable command${events.length === 1 ? '' : 's'}`}>
      <button type="button" className="command-group-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)} title={expanded ? 'Hide executable commands' : 'Show executable commands'}>
        <ChevronDown className="command-group-chevron" size={14} />
        <span className="tool-call-icon"><Terminal size={13} /></span>
        <strong>{events.length} command{events.length === 1 ? '' : 's'}</strong>
        <small>{summary}</small>
      </button>
      {expanded && <div className="command-group-list">{children}</div>}
    </section>
  );
}

const MessageTurn = memo(function MessageTurn({ turn, brainReady, onSaveToBrain, onBranch, onRewind, onOpenFile, awaitingAnswer, onAnswer }: {
  turn: ConversationTurn;
  brainReady: boolean;
  onSaveToBrain: (text: string) => void;
  onBranch: (turnId: string) => void;
  onRewind: (turnId: string) => void;
  onOpenFile: (path: string) => void;
  /** Set only for the conversation's latest turn, while nothing is running, so answering it is unambiguous. */
  awaitingAnswer: boolean;
  onAnswer: (text: string) => void;
}): ReactNode {
  return (
    <article className={`message ${turn.role}`}>
      <div className="message-role">
        {turn.role === 'user' ? 'You' : 'KAI'}
        {turn.role === 'assistant' && brainReady && (
          <button type="button" className="message-action" title="Save this answer to the C1 brain" aria-label="Save to Brain" onClick={() => onSaveToBrain(turn.text)}>
            <BookmarkPlus size={12} /><span>Save to Brain</span>
          </button>
        )}
        {turn.role === 'user' && (
          <button type="button" className="message-action" title="Rewind to before this message" aria-label="Rewind to before this message" onClick={() => onRewind(turn.id)}><Undo2 size={12} /><span>Rewind</span></button>
        )}
        <button type="button" className="message-action" title="Branch from this message" aria-label="Branch from this message" onClick={() => onBranch(turn.id)}><GitFork size={12} /><span>Branch</span></button>
      </div>
      <MessageContent text={turn.text} markdown={turn.role === 'assistant'} onOpenFile={onOpenFile} />
      {turn.role === 'user' && turn.attachments?.length ? (
        <div className="message-attachments" aria-label="Attached images">
          {turn.attachments.map((attachment) => (
            <ImageCard key={`${attachment.name}-${attachment.dataUrl.slice(-24)}`} name={attachment.name} dataUrl={attachment.dataUrl} />
          ))}
        </div>
      ) : null}
      <CopyMessageButton text={turn.text} />
      {awaitingAnswer && <AnswerBox onAnswer={onAnswer} />}
    </article>
  );
});

/**
 * The run that produced the turn above it has already ended — a CLI process exits once it has had its say, and
 * an API run stops rather than guess at an answer — so this cannot talk back into that run. What it can do is make
 * the question impossible to miss and turn a reply into a one-click resume instead of the person having to notice
 * the question themselves and retype it into the composer below.
 */
function AnswerBox({ onAnswer }: { onAnswer: (text: string) => void }): ReactNode {
  const [text, setText] = useState('');
  const submit = (): void => {
    const value = text.trim();
    if (!value) return;
    setText('');
    onAnswer(value);
  };
  return (
    <div className="answer-box" role="group" aria-label="Answer KAI's question">
      <input
        type="text"
        value={text}
        placeholder="Type your answer…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
      />
      <button type="button" className="primary-button" disabled={!text.trim()} onClick={submit}>Answer</button>
    </div>
  );
}

function CopyMessageButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="message-tools">
      <button
        type="button"
        className="message-copy"
        title={copied ? 'Copied' : 'Copy message'}
        aria-label="Copy message"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          }).catch(() => undefined);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function WorkProgressTimeline({ events, activity, paused, elapsedSeconds, tokenEstimate }: {
  events: readonly PersistedEvent[];
  activity: ReturnType<typeof deriveAgentActivity>;
  paused: boolean;
  elapsedSeconds: number;
  tokenEstimate: number;
}): ReactNode {
  const milestones = events
    .filter((event) => event.type === 'tool.call' || event.type === 'file.edit.applied' || event.type === 'file.change')
    .slice(-5)
    .map((event) => {
      if (event.type === 'tool.call') {
        const input = event.input && typeof event.input === 'object' && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
        const detail = [input.path, input.filePath, input.command, input.pattern].find((value): value is string => typeof value === 'string');
        return { id: event.id, label: detail ? `${event.name}: ${detail}` : event.name, complete: event.status === 'completed', failed: event.status === 'failed' };
      }
      const path = event.type === 'file.edit.applied' ? event.filePath : event.path;
      return { id: event.id, label: `${event.type === 'file.change' ? event.action : 'Edited'} ${path}`, complete: true, failed: false };
    });
  const current = paused ? 'Paused' : activity.label;
  return (
    <article className="work-progress" role="status" aria-live="polite">
      <div className="work-progress-current"><span className={paused ? 'progress-dot paused' : 'progress-dot'} /> <strong>{current}</strong><small>{activity.detail}</small><time>{elapsedSeconds}s{tokenEstimate > 0 ? ` · ~${formatTokenEstimate(tokenEstimate)} tokens` : ''}</time></div>
      {milestones.length > 0 && <div className="work-progress-steps">{milestones.map((step) => <div key={step.id} className={`work-progress-step ${step.complete ? 'complete' : step.failed ? 'failed' : 'active'}`}><span>{step.complete ? '✓' : step.failed ? '!' : '•'}</span><p>{step.label}</p></div>)}</div>}
    </article>
  );
}

function formatTokenEstimate(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

/** A small, dependency-free response renderer: prose remains easy to scan and fenced commands become copyable cards. */
function MessageContent({ text, markdown = false, onOpenFile }: { text: string; markdown?: boolean; onOpenFile?: (path: string) => void }): ReactNode {
  // KAI's replies are Markdown. What the user typed is shown exactly as written.
  if (markdown) return <Markdown text={text} onOpenFile={onOpenFile} />;
  const parts = text.split(/```([^\n`]*)\n?([\s\S]*?)```/g);
  return (
    <div className="message-body response-content">
      {parts.map((part, index) => {
        if (index % 3 === 1) return null;
        if (index % 3 === 2) {
          const language = parts[index - 1]?.trim() || 'text';
          return <section className="response-code" key={`code-${index}`}>
            <header><span>{language}</span><button type="button" title="Copy code" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(part)}><Copy size={14} /></button></header>
            <pre><code>{part.trim()}</code></pre>
          </section>;
        }
        return part.split(/\n{2,}/).filter(Boolean).map((paragraph, paragraphIndex) => <p key={`text-${index}-${paragraphIndex}`}>{paragraph}</p>);
      })}
    </div>
  );
}

function RunEventCardBase({ event, projectId, reviewMode, defaultExpanded, runActive, onAskKai, onReview, onUndo, onOpenVerification }: { event: PersistedEvent; projectId: string | null; reviewMode: ReviewMode; defaultExpanded: boolean; /** Whether the run this event belongs to is still going, which is the only way to tell a live tool call from one nothing is running. */ runActive: boolean; onAskKai: (text: string) => void; onReview: (turnId: string) => Promise<void>; onUndo: (turnId: string) => Promise<void>; onOpenVerification: () => void }): ReactNode {
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [explanation, setExplanation] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; result?: ChangeReviewResult; error?: string }>({ state: 'idle' });
  if (event.type === 'approval.request' && event.options) {
    return <article className="message assistant inline-question" aria-label="Question KAI asked"><div className="message-role">KAI asked</div><h3>{event.title}</h3>{event.detail && <p className="inline-question-context">{event.detail}</p>}</article>;
  }
  async function explainChanges(paths: string[]): Promise<void> {
    if (!projectId || paths.length === 0) return;
    setExplanation({ state: 'loading' });
    try {
      const result = unwrap(await window.kaiDesktop.reviewChanges({ projectId, paths: paths.slice(0, MAX_REVIEW_FILES), mode: reviewMode }));
      setExplanation({ state: 'done', result });
    } catch (error) {
      setExplanation({ state: 'error', error: error instanceof Error ? error.message : 'The explanation could not be completed.' });
    }
  }
  const [verification, setVerification] = useState<VerificationOverview | null>(null);
  useEffect(() => {
    if (event.type !== 'turn.changes' || !projectId) return;
    let cancelled = false;
    void window.kaiDesktop.verificationOverview(projectId).then(unwrap).then((next) => {
      if (!cancelled) setVerification(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [event.id, event.type, projectId]);
  if (event.type === 'text.delta') return null;
  if (event.type === 'tool.call') {
    // An edit or a command carries the change itself, so it is worth the space in the transcript.
    if (isPreviewableTool(event.name)) return <ToolCallCard event={event} defaultExpanded={defaultExpanded} runActive={runActive} />;
    return (
      <div className={`run-event tool ${event.status}`}>
        <span>Tool</span><strong>{event.name}</strong><small>{toolCallStatus(event.status, runActive).word}</small>
      </div>
    );
  }
  if (event.type === 'diff.proposal') {
    return <div className="run-event diff"><span>Proposed</span><strong>{event.filePath}</strong><small>{event.summary}</small></div>;
  }
  if (event.type === 'file.edit.applied' || event.type === 'file.change') {
    const path = event.type === 'file.edit.applied' ? event.filePath : event.path;
    return <div className="run-event diff"><span>Changed</span><strong>{path}</strong>{event.type === 'file.change' && <small>{event.action}</small>}</div>;
  }
  if (event.type === 'memory.event') {
    return <div className="run-event memory"><span>Memory</span><strong>{event.action.replace('_', ' ')}</strong><small>{event.summary}</small></div>;
  }
  if (event.type === 'notice') {
    return <div className="run-event notice"><ShieldCheck size={12} /><span>{event.message}</span></div>;
  }
  if (event.type === 'cost.update') {
    const details = [event.amountUsd != null ? `$${event.amountUsd.toFixed(4)}` : '', event.inputTokens != null ? `${event.inputTokens} in` : '', event.outputTokens != null ? `${event.outputTokens} out` : ''].filter(Boolean).join(' · ');
    return details ? <div className="run-event cost"><span>Usage</span><strong>{details}</strong></div> : null;
  }
  if (event.type === 'error') {
    return <div className="run-event error"><span>Error</span><strong>{event.message}</strong>{event.recoverable && <small>recoverable</small>}<button type="button" className="secondary-button explain-error-button" title="Ask KAI what this error means and how to fix it, without changing any files" onClick={() => onAskKai(`I got this error. Explain in plain words what it means, why it probably happened, and the smallest safe fix. Do not change any files yet.\n\nError: ${event.message}`)}><Lightbulb size={12} /><span>Explain this error</span></button></div>;
  }
  if (event.type === 'turn.changes') {
    const added = event.files.reduce((sum, file) => sum + file.added, 0);
    const removed = event.files.reduce((sum, file) => sum + file.removed, 0);
    const changedPaths = new Set(event.files.map((file) => file.path));
    const latestFiles = (verification?.files ?? []).filter((file) => changedPaths.has(file.path));
    const stale = latestFiles.some((file) => file.status === 'stale');
    const failed = latestFiles.some((file) => file.status === 'failed');
    const verified = latestFiles.length > 0 && latestFiles.every((file) => file.status === 'verified');
    const verificationLabel = !verification?.latest ? 'Not checked yet' : stale ? 'Checks stale after later edits' : failed ? 'Latest check failed' : verified ? 'Changed files verified' : 'Verification is partial';
    const securityReview = securityReviewHint(event.files.map((file) => file.path));
    return (
      <section className={`changes-card ${changesExpanded ? 'expanded' : ''}`}>
        <div className="changes-summary">
          <div>
            <strong>KAI changed {event.files.length} file{event.files.length === 1 ? '' : 's'}</strong>
            <span>Review the exact diff, restore individual hunks or files, or undo the whole turn.</span>
          </div>
          <VerificationBadge status={stale ? 'stale' : failed ? 'failed' : verified ? 'verified' : 'unverified'} />
          <small>{verificationLabel}{verification?.latest ? ` · ${relativeTime(verification.latest.startedAt)}` : ''}</small>
        </div>
        <div className={`change-safety-summary ${securityReview.level}`}>
          <ShieldCheck size={14} />
          <div><strong>{securityReview.title}</strong><span>{securityReview.detail}</span></div>
        </div>
        <button
          type="button"
          className="changes-head"
          aria-expanded={changesExpanded}
          title={changesExpanded ? 'Hide changed files' : 'Show changed files'}
          onClick={() => setChangesExpanded((current) => !current)}
        >
          <ChevronDown className="changes-chevron" size={14} />
          <strong>Changed files</strong>
          <span className="changes-head-spacer" />
          {added > 0 && <span className="diff-add">+{added}</span>}
          {removed > 0 && <span className="diff-remove">-{removed}</span>}
        </button>
        {changesExpanded && (
          <>
            <div className="changes-list">
              {event.files.slice(0, 8).map((file) => (
                <div className="changes-row" key={file.path}><span className="truncate">{file.path}</span><small><span className="diff-add">+{file.added}</span> <span className="diff-remove">-{file.removed}</span></small></div>
              ))}
              {event.files.length === 0 && <div className="changes-more">No files were changed in this turn.</div>}
              {event.files.length > 8 && <div className="changes-more">+{event.files.length - 8} more files</div>}
            </div>
          </>
        )}
        <div className="changes-actions">
          <button type="button" className="primary-button" disabled={!event.turnId || !event.hasCheckpoint} onClick={() => event.turnId && void onReview(event.turnId)} title={event.hasCheckpoint ? 'Review changed files against the checkpoint' : 'This turn has no Git checkpoint'}><Eye size={13} /><span>Review changes</span></button>
          <button type="button" className="secondary-button" disabled={!event.turnId || !event.hasCheckpoint} onClick={() => event.turnId && void onUndo(event.turnId)} title={event.hasCheckpoint ? 'Restore every file changed during this turn' : 'This turn has no Git checkpoint'}><Undo2 size={13} /><span>Undo turn</span></button>
          <button type="button" className="secondary-button" disabled={!projectId || event.files.length === 0 || explanation.state === 'loading'} onClick={() => void explainChanges(event.files.map((file) => file.path))} title="A second model reads these changes and explains them in plain words"><Lightbulb size={13} /><span>{explanation.state === 'loading' ? 'Reading the changes…' : explanation.state === 'done' ? 'Explain again' : 'Explain these changes'}</span></button>
          {verification?.latest && <button type="button" className="secondary-button" onClick={onOpenVerification} title="Open verification history"><ShieldCheck size={13} /><span>Verification details</span></button>}
        </div>
        {explanation.state === 'error' && <div className="change-explanation error" role="alert"><strong>Could not explain the changes</strong><p>{explanation.error}</p></div>}
        {explanation.state === 'done' && explanation.result && (
          <div className="change-explanation" aria-live="polite">
            <strong>{explanation.result.findings.length === 0 ? 'Nothing needs your attention' : explanation.result.ok ? 'A few minor notes' : 'Worth a look before you keep this'}</strong>
            {explanation.result.summary && <p>{explanation.result.summary}</p>}
            {explanation.result.findings.length > 0 && <ul>{explanation.result.findings.map((finding, index) => <li key={index}><span className={`review-chip ${finding.severity}`}>{finding.severity}</span><em>{finding.file}{finding.line ? `:${finding.line}` : ''}</em><p>{finding.note}</p></li>)}</ul>}
          </div>
        )}
      </section>
    );
  }
  return null;
}

function isRunDetailEvent(event: PersistedEvent): boolean {
  if (event.type === 'turn.changes') return event.files.length === 0;
  // Edits stay inline where they happened; executable commands live in Activity so the transcript
  // stays compact and the full command is available inside its larger disclosure.
  if (event.type === 'tool.call') return isExecutableCommandTool(event.name) || !isPreviewableTool(event.name);
  return event.type === 'diff.proposal'
    || event.type === 'file.edit.applied'
    || event.type === 'file.change'
    || event.type === 'memory.event'
    || event.type === 'cost.update'
    || event.type === 'plan.update'
    || event.type === 'agent.lifecycle';
}

function securityReviewHint(paths: string[]): { level: 'routine' | 'attention'; title: string; detail: string } {
  const joined = paths.join(' ').toLowerCase();
  const sensitive = /(?:auth|login|session|token|permission|role|user|account|secret|credential|password|env|api|route|middleware|database|schema|migration|config)/.test(joined);
  if (sensitive) {
    return {
      level: 'attention',
      title: 'Security review recommended',
      detail: 'These changes may affect access, data, configuration, or trust boundaries. Review input validation, permissions, secrets, and tests before shipping.',
    };
  }
  return {
    level: 'routine',
    title: 'Review before accepting',
    detail: 'Check the diff and verification result. Run a security-focused workflow when this change touches user data, network access, permissions, or configuration.',
  };
}

function ComparePanel({ result, onPick, onOpen, onDiscard }: { result: CompareRun; onPick: (id: string, side: 'left' | 'right') => Promise<void>; onOpen: (id: string, side: 'left' | 'right') => Promise<void>; onDiscard: (id: string) => Promise<void> }): ReactNode {
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = async (key: string, action: () => Promise<void>): Promise<void> => {
    setActionBusy(key);
    try {
      await action();
      setActionError(null);
    } catch (caught) {
      setActionError(messageOf(caught));
    } finally {
      setActionBusy(null);
    }
  };
  return (
    <section className="compare-panel">
      <div className="compare-heading"><GitCompare size={15} /><strong>Agent comparison</strong><span>{result.prompt}</span></div>
      <div className="compare-grid">
        {[{ side: result.left, position: 'left' as const }, { side: result.right, position: 'right' as const }].map(({ side, position }) => (
          <article key={position} className="compare-result">
            <div className="compare-label"><span className={`agent-dot ${side.agent}`} />{side.agent}<span className={`compare-state ${side.ok ? 'ok' : 'failed'}`}>{side.ok ? 'completed' : 'failed'}</span><small>{formatElapsed(side.elapsedMs)}</small></div>
            <MessageText text={side.output || side.error || 'No output returned.'} />
            <div className="compare-file-summary">
              <span>{side.files.length} changed file{side.files.length === 1 ? '' : 's'}</span>
              <span className="diff-add">+{side.files.reduce((sum, file) => sum + file.added, 0)}</span>
              <span className="diff-remove">-{side.files.reduce((sum, file) => sum + file.removed, 0)}</span>
            </div>
            <div className="compare-actions">
              <button type="button" className="primary-button" disabled={Boolean(actionBusy) || !side.ok} onClick={() => void runAction(`pick-${position}`, () => onPick(result.id, position))}><Check size={13} /><span>{actionBusy === `pick-${position}` ? 'Applying' : 'Pick this one'}</span></button>
              <button type="button" className="secondary-button" disabled={Boolean(actionBusy)} onClick={() => void runAction(`open-${position}`, () => onOpen(result.id, position))}><FolderOpen size={13} /><span>Open worktree</span></button>
            </div>
          </article>
        ))}
      </div>
      {actionError && <div className="workbench-error">{actionError}</div>}
      <div className="compare-discard-row"><button type="button" className="secondary-button" disabled={Boolean(actionBusy)} onClick={() => void runAction('discard', () => onDiscard(result.id))}><Trash2 size={13} /><span>Discard both</span></button></div>
    </section>
  );
}

function MessageText({ text }: { text: string }): ReactNode {
  return <div className="message-body">{text}</div>;
}

function contextChipKey(chip: ContextChip): string {
  return JSON.stringify(chip);
}

function contextChipLabel(chip: ContextChip): string {
  switch (chip.type) {
    case 'file':
      return chip.path;
    case 'selection':
      return `${chip.path}:${chip.startLine}-${chip.endLine}`;
    case 'terminal':
      return 'Terminal output';
    case 'gitDiff':
      return 'Uncommitted changes';
    case 'memory':
      return `Memory: ${chip.query}`;
    case 'image':
      return chip.name;
  }
}

function contextChipIcon(type: ContextChip['type']): ReactNode {
  switch (type) {
    case 'file':
      return <File size={11} />;
    case 'selection':
    case 'terminal':
      return <Braces size={11} />;
    case 'gitDiff':
      return <FileDiff size={11} />;
    case 'memory':
      return <Brain size={11} />;
    case 'image':
      return <ImagePlus size={11} />;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function copyRawEvent(payload: unknown, notify: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatRawPayload(payload));
    notify('Raw event payload copied to the clipboard.');
  } catch (error) {
    notify(messageOf(error));
  }
}

function formatRawPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.';
}

const CUSTOM_MODEL = '__custom__';

/** Plain names for models whose identifiers say little: the size of the model, which is what a person is choosing. */
const MODEL_LABELS: Record<string, string> = {
  opus: 'Opus (strongest)',
  sonnet: 'Sonnet (balanced)',
  haiku: 'Haiku (fastest)',
  'gpt-6-astra': 'GPT-6 Astra (strongest)',
  'gpt-5.6-sol': 'GPT-5.6 Sol (balanced)',
  'gpt-5.6-luna': 'GPT-5.6 Luna (fastest)',
};

function positiveLine(value: string): string | null {
  return /^\d+$/.test(value) && Number(value) >= 1 ? null : 'Enter a positive line number.';
}

function validateModelName(value: string): string | null {
  if (value.length > 240) return 'Model names must be 240 characters or fewer.';
  return /^[A-Za-z0-9._/:\-]+$/.test(value)
    ? null
    : 'Use only letters, numbers, ., -, _, /, and :.';
}

function modelOptions(
  apiRun: boolean,
  agent: AgentId,
  capability: DirectApiCapability | null,
  selected: string,
): SelectMenuOption<string>[] {
  const suggestions = apiRun
    ? directProviderPreset(capability?.provider ?? 'openai').models
    : agent in CLI_MODEL_SUGGESTIONS ? CLI_MODEL_SUGGESTIONS[agent as keyof typeof CLI_MODEL_SUGGESTIONS] : [];
  const known = new Set(suggestions);
  const defaultLabel = apiRun && capability?.model ? `Default (${capability.model})` : 'Default';
  return [
    { value: '', label: defaultLabel },
    ...suggestions.map((name) => ({ value: name, label: MODEL_LABELS[name] ?? name })),
    ...(selected && !known.has(selected) ? [{ value: selected, label: selected }] : []),
    { value: CUSTOM_MODEL, label: 'Other model…' },
  ];
}

interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  /** A line under the label that says what the choice does. */
  description?: string;
  disabled?: boolean;
}

function InlineQuestion({ question, onAnswer }: {
  question: WorkspaceQuestion;
  onAnswer: (requestId: string, answer: string | null) => void;
}): ReactNode {
  const [answer, setAnswer] = useState('');
  return (
    <section className="message assistant inline-question" aria-label="KAI question">
      <div className="message-role">KAI is asking</div>
      <h3>{question.title}</h3>
      {question.detail && <p className="inline-question-context">{question.detail}</p>}
      <div className="inline-question-options">
        {question.options.map((option) => (
          <button key={option} type="button" className="secondary-button" onClick={() => onAnswer(question.requestId, option)}>{option}</button>
        ))}
      </div>
      {question.allowFreeText && (
        <form className="inline-question-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) onAnswer(question.requestId, answer.trim()); }}>
          <input aria-label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Or type your own answer" />
          <button type="submit" className="primary-button" disabled={!answer.trim()}>Answer</button>
        </form>
      )}
      <button type="button" className="inline-question-skip" onClick={() => onAnswer(question.requestId, null)}>Skip for now</button>
    </section>
  );
}

/** The access choices with what each one lets KAI do. There is one control for them, in the composer's own row. */
const ACCESS_OPTIONS: readonly SelectMenuOption<AutonomyMode>[] = ACCESS_LEVELS.map((level) => ({ value: level.value, label: level.label, description: level.description }));

function SelectMenu<T extends string>({ ariaLabel, className = '', disabled = false, icon, labelPrefix, onChange, options, title, value }: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  labelPrefix?: string;
  onChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  title?: string;
  value: T;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const focusTimer = window.setTimeout(() => optionRefs.current[selectedIndex]?.focus(), 0);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, selectedIndex]);

  const choose = (option: SelectMenuOption<T>): void => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveFocus = (currentIndex: number, direction: 1 | -1): void => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const nextIndex = (currentIndex + direction * offset + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        optionRefs.current[nextIndex]?.focus();
        return;
      }
    }
  };

  const focusEdge = (fromStart: boolean): void => {
    const indexes = options.map((_, index) => index);
    if (!fromStart) indexes.reverse();
    for (const index of indexes) {
      if (options[index]?.disabled) continue;
      optionRefs.current[index]?.focus();
      return;
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(index, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusEdge(true);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusEdge(false);
    }
  };

  return (
    <div ref={rootRef} className={`chip-button select-menu ${className} ${disabled ? 'disabled' : ''}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={title}
      >
        {icon}
        <span className="select-menu-value truncate">{labelPrefix ? `${labelPrefix}: ` : ''}{selectedOption?.label ?? value}</span>
        <ChevronDown className="select-menu-chevron" size={12} />
      </button>
      {open && (
        <div className="select-menu-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-menu-option ${option.value === value ? 'selected' : ''}`.trim()}
              disabled={option.disabled}
              onClick={() => choose(option)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              {option.description
                ? <span className="select-menu-option-text"><span>{option.label}</span><small>{option.description}</small></span>
                : <span>{option.label}</span>}
              {option.value === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function setupTitle(capability: AgentCapability): string {
  if (capability.state === 'signed_out') return 'Sign in required';
  if (capability.state === 'not_installed') return 'Install required';
  return 'Agent unavailable';
}

function setupSuffix(capability: AgentCapability): string {
  if (capability.available) return '';
  if (capability.state === 'signed_out') return ' (sign-in required)';
  if (capability.state === 'not_installed') return ' (not installed)';
  return ' (unavailable)';
}

export function ContextPanel({ activeProject, conversation, services, contextPreview, contextPreviewLoading }: { activeProject: ProjectRecord | null; conversation: ConversationRecord | null; services: ServiceState[]; contextPreview: ContextPreview | null; contextPreviewLoading: boolean }): ReactNode {
  return (
    <div className="context-body">
      <div className="context-heading"><div><span className="eyebrow">Context</span><h2>{activeProject?.name ?? 'No project'}</h2></div><FileDiff size={17} /></div>
      <div className="context-meter">
        <span>Estimated direct API context</span>
        <strong>{contextPreviewLoading ? 'Calculating...' : contextPreview ? `~${formatCompact(contextPreview.estimatedTokens)} tokens` : 'Unavailable'}</strong>
        <small>{contextPreview ? `${formatCompact(contextPreview.totalCharacters)} characters across ${contextPreview.sections.reduce((sum, section) => sum + section.items.length, 0)} item(s)` : 'Open a project to preview context.'}</small>
      </div>
      {(contextPreview?.sections ?? []).map((section) => (
        <div className="context-section" key={section.kind}>
          <div className="context-label">{contextSectionIcon(section.kind)}<span>{section.label}</span><small>~{formatCompact(section.estimatedTokens)}</small></div>
          {section.note && <div className="context-note">{section.note}</div>}
          {section.items.length > 0 ? (
            <div className="context-item-list">
              {section.items.map((item) => (
                <div className="context-item" key={`${item.kind}:${item.source ?? item.label}`} title={item.source}>
                  <span>{item.label}</span>
                  <small>~{formatCompact(item.estimatedTokens)} tok{item.truncated ? ' / partial' : ''}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="context-empty">None</div>
          )}
        </div>
      ))}
      <div className="context-section">
        <div className="context-label"><Cpu size={14} /><span>Services</span></div>
        {services.map((service) => <div key={service.kind} className="service-row"><span className={`status-dot ${service.status}`} /><span>{service.kind === 'cognitive1' ? 'C1 Brain' : 'Universal Proxy'}</span><small>{statusLabel(service.status)}</small></div>)}
      </div>
      <div className="context-section context-foot"><span>Updated</span><strong>{conversation ? relativeTime(conversation.updatedAt) : 'Not active'}</strong></div>
    </div>
  );
}

function contextSectionIcon(kind: ContextPreview['sections'][number]['kind']): ReactNode {
  if (kind === 'memories') return <BrainIcon />;
  if (kind === 'skills') return <Sparkles size={14} />;
  if (kind === 'history') return <History size={14} />;
  return <FileDiff size={14} />;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function BrainIcon(): ReactNode {
  return <span className="brain-dot" aria-hidden="true" />;
}
