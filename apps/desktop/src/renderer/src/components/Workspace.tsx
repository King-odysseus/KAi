import { ImageCard, ImageChip } from './ImageAttachment';

import { Switch } from './ui/Switch';
import { AutoSettings } from './AutoSettings';
import { ComposerRunDetails, ComposerRunLine, useComposerRun } from './ComposerRunLine';
import { AUTO_WORKING_AUTONOMY, buildAutoStartRequest, readAutoSettings } from './auto-settings';
import { settleWithin } from '../async-deadline';
import { composerLimitPolicy } from '../cost-visibility';
import { steerWaitingNotice } from '../run-controls';
import { PlanStrip, usePlanProgress } from './PlanStrip';
import { EqualizerPanel } from './EqualizerPanel';
import { Markdown } from './Markdown';
import { Pill } from './Pill';
import {
  Archive,
  AtSign,
  BookmarkPlus,
  ArrowRight,
  Braces,
  Ellipsis,
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
  ListChecks,
  Users,
  File,
  FileSearch,
  ExternalLink,
  FileDiff,
  FolderPlus,
  FolderOpen,
  GitCompare,
  GitFork,
  Goal,
  Hash,
  History,
  Loader2,
  LogIn,
  MessageCircleQuestion,
  Minimize2,
  ImagePlus,
  NotebookPen,
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
import { PlanApprovalBar, PLAN_APPROVED_PROMPT } from './PlanApprovalBar';
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
  HelperChoice,
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
  SavedRecipe,
  ProjectRecord,
  PromptGuideReadiness,
  PromptPreset,
  ReviewMode,
  RouteMode,
  ServiceState,
  SkillSummary,
  VerificationOverview,
  WorkbenchGoal,
} from '@kai/contracts';
import { ACCESS_LEVELS, CLI_MODEL_SUGGESTIONS, HELPER_CHOICES, HELPER_CHOICE_DESCRIPTION, HELPER_CHOICE_LABEL, REASONING_LABEL, RESPONSE_STYLES, RESPONSE_STYLE_DESCRIPTION, RESPONSE_STYLE_LABEL, COMPACTION_WARNING_TOKENS, MAX_REVIEW_FILES, directProviderPreset, estimateConversationTokens, estimateResponseCostUsd, experienceProfile, MAX_SAVED_RECIPES, SAVED_RECIPE_INTENTS, architectSplitActive } from '@kai/contracts';
import { relativeTime, statusLabel, unwrap } from '../types';
import { HunkReview, canReviewHunks } from './HunkReview';
import { ToolCallCard, toolCallStatus } from './ToolCallCard';
import { isPreviewableTool } from '../tool-call-preview';
import { collapseToolCalls } from '../tool-call-events';
import { interleaveRun, type RunSegment } from '../transcript-order';
import { addPendingSteer, visiblePendingSteers, type PendingSteer } from '../pending-steers';
import { SaveToBrainDialog } from './SaveToBrain';
import { VerificationBadge } from './VerificationPanel';
import { UsageBanner } from './UsageView';
import { confirmDialog, promptDialog } from './AppDialog';
import { deriveAgentActivity } from './AgentActivity';
import { ActivityCard } from './ActivityCard';
import { currentStep, deriveActivitySteps } from '../activity-steps';
import { BlockedActionsStrip } from './BlockedActionsStrip';
import type { QueuedPrompt } from './composer-queue';
import {
  PERSONAS,
  defaultRecipe,
  recipesFor,
  isAutoLikeIntent,
  isKnownStarter,
  personaFor,
  type PersonaRecipe,
  type TaskIntent,
} from './personas';

import { Select } from './ui/Select';
import { Composer, ComposerInput, ComposerPause, ComposerSend, ComposerStop, ComposerToolbar } from './ui/Composer';
import { IconButton } from './ui/IconButton';
import { ArchitectChip, ArchitectRow, ArchitectStatusLine, ArchitectToggle, useArchitectSplit, useArchitectStatus } from './ArchitectControls';
import { ActionsMenu } from './ui/ActionsMenu';
import { PageHeader } from './ui/PageHeader';
import { NoticeBanner } from './ui/NoticeBanner';
import { OptionMenu, type OptionMenuOption } from './ui/OptionMenu';
import { OptionSection } from './ui/OptionSection';
import { UiButton } from './UiButton';
import { Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
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
  previewImage?: { name: string; dataUrl: string };
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
  /** Auto has parked this run until the person answers. It is also counted in `paused`, but it is not a pause. */
  autoWaiting?: boolean;
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
  /** The composer's Task selector, owned by the conversation rather than the window. */
  taskIntent: TaskIntent;
  /** This window, so the Architect / Implementer choice is remembered per window as well as per tab. */
  windowId?: number;
  /** The chosen recipe inside each Task selector, for this conversation. */
  taskRecipes: Record<string, string>;
  onSelectTaskIntent: (intent: TaskIntent) => void;
  onSelectTaskRecipe: (intent: TaskIntent, recipeId: string) => void;
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
  /** Takes the open project into the Project Studio and starts a plan attached to its folder. */
  onPlanInStudio: () => void;
  onCreateConversation: (prompt: string, options?: WorkspaceSendOptions) => void;
  onBranchTurn: (turnId: string) => void;
  /** Branches the chat from its latest message and puts a queued message in the new chat's composer. */
  onBranchQueued: (id: string, text: string) => void;
  /** Opens a queued message in a new empty chat tab, ready to send there. */
  onNewTabQueued: (id: string, text: string) => void;
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
  /** How many helper agents a run may use; auto lets the agent decide. */
  selectedHelpers: HelperChoice;
  onSelectHelpers: (helpers: HelperChoice) => void;
  /** The effort levels the selected agent's CLI accepts; empty hides the control. */
  reasoningLevels: readonly ReasoningEffort[];
  onSelectReasoning: (reasoning: ReasoningEffort | '') => void;
  interruptedRuns: number;
  onOpenRecovery: () => void;
  onOpenVerification: () => void;
  onOpenRules: () => void;
  onOpenWorkflows: () => void;
  onOpenStudioCard: (studioProjectId: string, cardId: string) => void;
  /** Opens the Crew screen, where a crew's work log is talked about and the Lead is messaged. */
  onOpenCrew: () => void;
  onCompactConversation: () => void;
  onContinueInNewTab: () => void;
  /** The side question asked off this conversation, if one has been started. Null until the first question. */
  sideConversation: ConversationRecord | null;
  sideConversationRunning: boolean;
  onAskSideQuestion: (question: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}

/**
 * How long each composer action may hold its own button before the UI stops waiting on it. Generous, because the
 * cost of being wrong is asymmetric: a slow call that finishes just after its deadline releases a button the
 * person is already free to press again, while waiting forever leaves them with no button at all.
 */
const START_WAIT_MS = 30_000;
const REFINE_WAIT_MS = 60_000;
const STOP_WAIT_MS = 30_000;
/** What goes with an image sent alone, so a message is never empty. The main process uses the same words. */
const IMAGE_ONLY_PROMPT = 'Please look at the attached image.';
const FILE_ONLY_PROMPT = 'Please read the attached file.';


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
  autoWaiting = false,
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
  taskIntent,
  windowId,
  taskRecipes,
  onSelectTaskIntent,
  onSelectTaskRecipe,
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
  onPlanInStudio,
  onCreateConversation,
  onBranchTurn,
  onBranchQueued,
  onNewTabQueued,
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
  selectedHelpers,
  onSelectHelpers,
  reasoningLevels,
  onSelectReasoning,
  interruptedRuns,
  onOpenRecovery,
  onOpenVerification,
  onOpenRules,
  onOpenWorkflows,
  onOpenStudioCard,
  onOpenCrew,
  onCompactConversation,
  onContinueInNewTab,
  sideConversation,
  sideConversationRunning,
  onAskSideQuestion,
  onOpenFile,
}: WorkspaceViewProps): ReactNode {
  const [prompt, setPrompt] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [savingPresetSlot, setSavingPresetSlot] = useState<number | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [sideDraft, setSideDraft] = useState('');
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [contextBusy, setContextBusy] = useState(false);
  const [previewAttachmentSaving, setPreviewAttachmentSaving] = useState(false);
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
  const [advancedComposerOpen, setAdvancedComposerOpen] = useState(false);
  const [composerStatusOpen, setComposerStatusOpen] = useState(false);
  const [noticesExpanded, setNoticesExpanded] = useState(false);
  const [noticeCount, setNoticeCount] = useState(0);
  const noticesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = noticesRef.current;
    if (!host) return;
    const count = (): void => setNoticeCount(host.querySelectorAll(':scope > .workbench-notice').length);
    const observer = new MutationObserver(count);
    observer.observe(host, { childList: true });
    count();
    return () => observer.disconnect();
  }, []);
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
  /** Queued prompts whose steer is still on its way to the run, so the same one cannot be sent twice. */
  const [steeringQueued, setSteeringQueued] = useState<readonly string[]>([]);
  const [promptGuideReadiness, setPromptGuideReadiness] = useState<PromptGuideReadiness | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is at the bottom; scrolling up releases it until they send again.
  const stickToBottomRef = useRef(true);
  const wasRunningRef = useRef(false);
  const previousConversationIdRef = useRef<string | null>(null);
  const [pendingUser, setPendingUser] = useState<{ text: string; baseCount: number; images: Array<{ name: string; dataUrl: string }> } | null>(null);
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const selectedCapability = agentCapabilities.find((agent) => agent.id === selectedAgent);
  // The Architect / Implementer split: its own choices, remembered per tab and per window.
  const architect = useArchitectSplit({ conversationId: activeConversation?.id, recorded: activeConversation?.architect, windowId, capabilities: agentCapabilities });
  const architectStatus = useArchitectStatus(activeConversation?.id);
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
  // What this run actually is. In API mode the agent id is irrelevant: the provider and model are the run.
  const runLabel = apiRun
    ? effectiveRoute === 'proxy'
      ? providerLabel
      : `${directApiCapability?.displayName || 'Direct API'}${(selectedModel || directApiCapability?.model) ? ` · ${selectedModel || directApiCapability?.model}` : ''}`
    : selectedModel || selectedAgent;
  const activeGoal = activeConversation?.goal ?? null;
  const activePersona = personaFor(taskIntent);
  const savedRecipes = projectPreferences?.recipes ?? [];
  const activeRecipes = recipesFor(activePersona, savedRecipes);
  const activeRecipe = activeRecipes.find((recipe) => recipe.id === taskRecipes[activePersona.id])
    ?? activeRecipes[0];
  const allContextChips: ContextChip[] = [
    ...selectedFiles.map((path) => ({ type: 'file' as const, path })),
    ...contextChips,
  ];
  const hasImageAttachment = contextChips.some((chip) => chip.type === 'image');
  const hasFileAttachment = contextChips.some((chip) => chip.type === 'attachment');
  const hasAttachment = hasImageAttachment || hasFileAttachment;
  const attachmentOnlyPrompt = hasFileAttachment ? FILE_ONLY_PROMPT : IMAGE_ONLY_PROMPT;
  const canSendPrompt = Boolean(prompt.trim()) || hasAttachment;
  const estimateModel = selectedModel || directApiCapability?.model || '';
  const promptContextCharacters = allContextChips.reduce((total, chip) => total + (
    chip.type === 'selection' || chip.type === 'terminal' ? chip.content?.length ?? 0
      : chip.type === 'gitDiff' ? chip.stat.length
        : chip.type === 'memory' ? chip.query.length + chip.summary.length
          : chip.type === 'image' ? chip.name.length : chip.path.length
  ), 0) + (activeGoal ? JSON.stringify(activeGoal).length : 0) + selectedSkills.reduce((total, skill) => total + skill.name.length, 0);
  const estimatedInputTokens = estimateConversationTokens(activeConversation ?? { turns: [] })
    + Math.ceil((prompt.length + promptContextCharacters) / 4) + 1_200;
  const responseCostEstimate = apiRun && effectiveRoute === 'direct' && canSendPrompt
    ? estimateResponseCostUsd(estimateModel, estimatedInputTokens) : null;
  const limitPolicy = composerLimitPolicy(apiRun, effectiveRoute);
  // Independent of whatever is or isn't typed yet: what resuming this conversation costs before the next word is
  // written, so the warning to compact a large idle conversation can also say what letting it ride will cost.
  const resumeCostEstimate = activeConversation && apiRun && effectiveRoute === 'direct'
    ? estimateResponseCostUsd(estimateModel, estimateConversationTokens(activeConversation) + 1_200) : null;
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
    // offsetHeight - clientHeight is the border, which scrollHeight leaves out; one spare pixel stops rounding from clipping the first line.
    const chrome = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${Math.min(textarea.scrollHeight + chrome + 1, 260)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 260 ? 'auto' : 'hidden';
    if (textarea.scrollHeight <= 260) textarea.scrollTop = 0;
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
    if (!presetsOpen) return;
    let cancelled = false;
    void window.kaiDesktop.listPromptPresets().then(unwrap).then((list) => {
      if (!cancelled) setPresets(list);
    }).catch((caught) => {
      if (!cancelled) setWorkbenchNotice(messageOf(caught));
    });
    return () => { cancelled = true; };
  }, [presetsOpen]);

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
      const previewImage = commandRequest.previewImage;
      if (previewImage?.dataUrl) {
        setPreviewAttachmentSaving(true);
        setWorkbenchNotice('Saving the annotated preview image…');
        void window.kaiDesktop.saveAttachment(previewImage.name, previewImage.dataUrl).then(unwrap).then((chip) => {
          if (chip.type !== 'image') throw new Error('KAI could not save the preview annotation as an image.');
          setContextChips((current) => [...current.filter((item) => item.type !== 'image' || item.name !== chip.name), chip]);
          setWorkbenchNotice('Annotated preview image attached. Add any extra detail, then send the change request.');
        }).catch((caught) => setWorkbenchNotice(messageOf(caught))).finally(() => setPreviewAttachmentSaving(false));
      }
      else setWorkbenchNotice('Preview context added. Add any extra detail, then send the change request.');
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

  // A send that is refused before a run starts (agent unavailable, proxy down, a cancelled prompt) never flips
  // `running`, so nothing would ever clear the optimistic bubble and the answer box would look dead. Give the run a
  // moment to start, then drop the bubble so the box comes back and the error banner is the only thing left.
  useEffect(() => {
    if (!pendingUser || running) return;
    const timer = window.setTimeout(() => setPendingUser(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [pendingUser, running]);

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

  const visibleSteers = visiblePendingSteers(pendingSteers, activeConversation?.id, activeConversation?.turns ?? []);

  const showDeliveredSteer = (conversationId: string, text: string, chips: readonly ContextChip[]): void => {
    const images = chips.flatMap((chip) => chip.type === 'image' && chip.dataUrl
      ? [{ name: chip.name, dataUrl: chip.dataUrl }] : []).slice(0, 6);
    const turns = activeConversation?.id === conversationId ? activeConversation.turns : [];
    setPendingSteers((current) => addPendingSteer([
      ...current.filter((item) => item.conversationId !== conversationId),
      ...visiblePendingSteers(current, conversationId, turns),
    ], {
      id: crypto.randomUUID(), conversationId, text, images,
    }, turns));
  };

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
    // button, so a steered or queued task behaves the same as one typed straight in. Security Auditor is the same
    // loop with a different starter prompt, not a separate engine.
    if (isAutoLikeIntent(taskIntent)) {
      void startAuto(text, options);
      return;
    }
    // With the split on, the Architect plans and reviews and the Implementer builds; the box and the send are the same.
    if (architectSplitActive(architect.split)) {
      void startArchitect(text, options);
      return;
    }
    if (activeConversation) onSend(text, options);
    else onCreateConversation(text, options);
  };

  // Declared after the handler it wraps: a `const` arrow is not hoisted, so reading it above its own definition
  // would throw on the first render.
  const queueOrSendStable = useLatestHandler(queueOrSend);

  // Approving a plan changes the access level and then sends. The level lives in the parent, so the send waits for
  // the render that carries it; sending in the same tick would still run under Plan and be refused.
  const [approvedPlanPrompt, setApprovedPlanPrompt] = useState<string | null>(null);
  const [dismissedPlanAt, setDismissedPlanAt] = useState<string | null>(null);
  useEffect(() => {
    if (approvedPlanPrompt === null || selectedAutonomy === 'plan') return;
    const text = approvedPlanPrompt;
    setApprovedPlanPrompt(null);
    queueOrSendStable(text);
  }, [approvedPlanPrompt, selectedAutonomy, queueOrSendStable]);
  const lastTurn = activeConversation?.turns[activeConversation.turns.length - 1];
  const planAwaitsApproval = selectedAutonomy === 'plan' && !running && !isAutoLikeIntent(taskIntent)
    && lastTurn?.role === 'assistant' && lastTurn.text.trim().length > 0 && dismissedPlanAt !== activeConversation?.updatedAt;

  const optionsForPrompt = (text: string): WorkspaceSendOptions | undefined => {
    const namedSkills = skills
      .filter((skill) => new RegExp(`\\$${escapeRegExp(skill.name)}(?![A-Za-z0-9_-])`, 'i').test(text))
      .map((skill) => skill.name);
    // A selector or recipe is a skill, not just a starter sentence. Selecting it loads the full instructions even
    // when the person never types the `$name`.
    const intentSkills = activeRecipe?.skills ?? [];
    const skillNames = [...new Set([...selectedSkills.map((skill) => skill.name), ...namedSkills, ...intentSkills])];
    const options: WorkspaceSendOptions = {
      ...(sendOptions ?? {}),
      ...(skillNames.length ? { skills: skillNames } : {}),
    };
    return Object.keys(options).length ? options : undefined;
  };

  const send = (): void => {
    const typedText = prompt.trim();
    if ((!typedText && !hasAttachment) || !activeProject || busy || refiningPrompt || !ready) return;
    let text = typedText || attachmentOnlyPrompt;
    // An audit starter ends in "Attack " / "Audit " / "Profile " and waits for a target. Sent as-is it should
    // still run, not arrive as a dangling sentence, so an empty target becomes the whole project.
    const activeStarter = activeRecipe?.starter ?? activePersona.starter;
    if (taskIntent === 'audit' && activeStarter.trim() && typedText.trim() === activeStarter.trim()) {
      text = `${text.trim()} this whole project.`;
    }
    if (isAutoLikeIntent(taskIntent) && !AUTO_WORKING_AUTONOMY.has(selectedAutonomy)) {
      setWorkbenchNotice('Auto needs Edit files or Full access. Choose an access level below, then send again.');
      return;
    }
    if (architect.split.enabled && architect.problem) {
      setWorkbenchNotice(architect.problem);
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
        // Auto honours the chosen Architect and Implementer instead of choosing its own.
        ...(architectSplitActive(architect.split) ? { architect: architect.split } : {}),
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

  /**
   * Sends the task through the Architect / Implementer split: the Architect plans, the Implementer builds, the
   * Architect reviews and sends work back. The same box and the same send; only who does what is different.
   */
  async function startArchitect(text: string, options: WorkspaceSendOptions | undefined): Promise<void> {
    if (!activeProject) return;
    if (selectedAutonomy === 'plan') {
      setWorkbenchNotice('The Implementer cannot change files at Plan only access. Choose Edit files or Full access, then send again.');
      return;
    }
    setStartingAuto(true);
    setWorkbenchNotice(null);
    try {
      const started = await settleWithin(() => window.kaiDesktop.runArchitect({
        projectId: activeProject.id,
        prompt: text,
        split: architect.split,
        route: selectedRoute,
        autonomy: selectedAutonomy,
        agent: selectedAgent,
        execution: executionMode,
        ...(activeConversation ? { conversationId: activeConversation.id } : {}),
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(options?.skills?.length ? { skills: options.skills } : {}),
        ...(options?.selectedPaths?.length ? { selectedPaths: options.selectedPaths } : {}),
        ...(options?.contextChips?.length ? { contextChips: options.contextChips } : {}),
      }).then(unwrap), START_WAIT_MS);
      if (!started.settled) setStuckNotice('The Architect did not start in time, so the button was released. If a run did start, Stop everything ends it.');
    } catch (caught) {
      setWorkbenchNotice(messageOf(caught));
    } finally {
      setStartingAuto(false);
    }
  }

  const steerNow = (): void => {
    // An image alone is a complete message, the same as when it is sent rather than steered.
    const text = prompt.trim() || (hasAttachment ? attachmentOnlyPrompt : '');
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
    const typed = prompt.trim();
    const text = typed || (hasAttachment ? attachmentOnlyPrompt : '');
    const conversationId = activeConversation?.id;
    if (!text || !conversationId || !running || interjecting) return;
    // What a send would carry: an image, a selection or terminal output attached beside the words is part of what is
    // being said. A steer that sent only the words answered a different question than the one asked.
    const chips = allContextChips;
    setInterjecting(true);
    setWorkbenchNotice(steerWaitingNotice(paused));
    void window.kaiDesktop.interjectAgent({ conversationId, text, ...(chips.length > 0 ? { contextChips: chips } : {}) }).then(unwrap)
      .then(({ queued }) => {
        if (queued) {
          showDeliveredSteer(conversationId, text, chips);
          setPrompt((current) => current.trim() === typed ? '' : current);
          // Cleared only now that the run has taken it: on any other outcome the composer is left as it was.
          clearComposerContext();
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
    if (!item || !activeProject) return;
    const conversationId = activeConversation?.id;
    // A run that is already going is proof enough that the provider is usable. Requiring `ready` (or the composer's
    // transient `busy` flag) here made Steer now a no-op while an API run was active; it only matters when this falls
    // through to promoting the instruction for a later turn.
    if (running && conversationId && apiRun) {
      if (steeringQueued.includes(item.id)) return;
      setSteeringQueued((current) => [...current, item.id]);
      setWorkbenchNotice(steerWaitingNotice(paused));
      // The queued prompt's own chips go with it. This used to send the words alone and then delete the queued row,
      // which is how an image sat in the queue, was "sent", and was gone.
      const chips = item.options.contextChips ?? [];
      void window.kaiDesktop.interjectAgent({ conversationId, text: item.text, ...(chips.length > 0 ? { contextChips: chips } : {}) }).then(unwrap)
        .then(({ queued }) => {
          if (queued) {
            showDeliveredSteer(conversationId, item.text, chips);
            onInterjectionDelivered(conversationId, item.text);
            onUpdateQueuedPrompt(item.id, 'remove');
            setWorkbenchNotice('Sent to the active run; it will answer this and carry on with the rest.');
          } else {
            setWorkbenchNotice('The active run could not take this message. It remains queued for the next turn; nothing was stopped.');
          }
        })
        .catch(() => setWorkbenchNotice('Could not reach the active run. The instruction remains queued; nothing was stopped.'))
        .finally(() => setSteeringQueued((current) => current.filter((id) => id !== item.id)));
      return;
    }
    if (running) {
      setWorkbenchNotice('This CLI run cannot take a live message. The instruction remains queued for its next turn.');
      return;
    }
    if (busy || !ready) return;
    onUpdateQueuedPrompt(item.id, 'promote');
  };

  async function refinePromptDraft(): Promise<void> {
    const text = prompt.trim();
    if (!text || !refineTarget || busy || running || paused || awaitingApproval || refiningPrompt) return;
    setRefiningPrompt(true);
    setWorkbenchNotice(null);
    try {
      const refined = await settleWithin(
        () => window.kaiDesktop.refinePrompt({ text, intent: taskIntent === 'equalizer' || isAutoLikeIntent(taskIntent) ? 'build' : taskIntent }).then(unwrap),
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

  /** Prepares a reviewed finding as a scoped build request for the person to inspect and send. */
  function fixFinding(text: string): void {
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
    onSelectTaskIntent(intent);
  }

  function chooseTaskIntent(intent: TaskIntent): void {
    const persona = personaFor(intent);
    const available = recipesFor(persona, savedRecipes);
    const remembered = available.find((recipe) => recipe.id === taskRecipes[intent]);
    const starter = (remembered ?? available[0])?.starter ?? persona.starter;
    rememberIntent(intent);
    // A recipe chosen earlier comes back with the selector. Typed text is never overwritten, but a starter that
    // belonged to the previous selector is replaced (or cleared, for a selector with no starter).
    if (isKnownStarter(prompt)) setPrompt(starter);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  /** Keeps the prompt of one of the person's own messages as a recipe behind the current selector. */
  async function saveTurnAsRecipe(turnId: string): Promise<void> {
    if (!activeProject) return;
    const turn = activeConversation?.turns.find((item) => item.id === turnId);
    if (!turn || !turn.text.trim()) return;
    if (savedRecipes.length >= MAX_SAVED_RECIPES) {
      setWorkbenchNotice(`This project already has ${MAX_SAVED_RECIPES} saved recipes. Remove one first.`);
      return;
    }
    // A selector with no recipes of its own (General, Learn, Equalizer, Auto) cannot hold one, so it goes under Build.
    const intent = (SAVED_RECIPE_INTENTS as readonly string[]).includes(taskIntent) ? taskIntent : 'build';
    const name = await promptDialog({
      title: 'Save as a recipe',
      label: `Name (it will appear under ${personaFor(intent as TaskIntent).label})`,
      initialValue: turn.text.trim().split('\n')[0]!.slice(0, 40),
      placeholder: 'Fix a flaky test',
      confirmLabel: 'Save recipe',
      validate: (value) => (value.trim() ? null : 'Give the recipe a name.'),
    });
    if (!name?.trim()) return;
    const recipe: SavedRecipe = {
      id: `saved_${crypto.randomUUID().slice(0, 8)}`,
      intent: intent as SavedRecipe['intent'],
      label: name.trim().slice(0, 40),
      description: turn.text.trim().replace(/\s+/g, ' ').slice(0, 140),
      starter: turn.text.trim().slice(0, 4_000),
      skills: [...(intent === taskIntent ? activeRecipe?.skills ?? [] : [])],
      createdAt: new Date().toISOString(),
    };
    await onUpdatePreferences({ schemaVersion: 1, projectId: activeProject.id, ...(projectPreferences ?? {}), recipes: [...savedRecipes, recipe] });
    onSelectTaskRecipe(intent as TaskIntent, recipe.id);
    setWorkbenchNotice(`Saved "${recipe.label}" under ${personaFor(intent as TaskIntent).label}.`);
  }

  async function removeSavedRecipe(recipeId: string): Promise<void> {
    if (!activeProject) return;
    const recipe = savedRecipes.find((item) => item.id === recipeId);
    if (!recipe) return;
    if (!(await confirmDialog({ title: `Remove "${recipe.label}"?`, detail: 'This only removes the saved recipe. The conversation it came from is not touched.', confirmLabel: 'Remove recipe' }))) return;
    const { recipes: _removed, ...rest } = projectPreferences ?? { schemaVersion: 1 as const, projectId: activeProject.id };
    const remaining = savedRecipes.filter((item) => item.id !== recipeId);
    await onUpdatePreferences({ ...rest, schemaVersion: 1, projectId: activeProject.id, ...(remaining.length > 0 ? { recipes: remaining } : {}) });
    const first = personaFor(taskIntent).recipes?.[0];
    if (first) onSelectTaskRecipe(taskIntent, first.id);
  }
  const saveTurnAsRecipeStable = useLatestHandler(saveTurnAsRecipe);

  /** Picks a specialist inside the current selector and loads its skill. */
  function chooseRecipe(recipe: PersonaRecipe): void {
    onSelectTaskRecipe(taskIntent, recipe.id);
    if (isKnownStarter(prompt)) setPrompt(recipe.starter);
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

  /** Attaches every file given, one after another. A failure on one is reported and the rest still attach. */
  async function attachComposerFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    setContextBusy(true);
    try {
      for (const file of files) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const chip = await window.kaiDesktop.saveAttachment(file.name, dataUrl).then(unwrap);
          // Each save has its own file, so two pasted screenshots that are both called image.png stay separate.
          const savedPath = chip.type === 'image' || chip.type === 'attachment' ? chip.path : null;
          setContextChips((current) => [...current.filter((item) => !(savedPath && (item.type === 'image' || item.type === 'attachment') && item.path === savedPath)), chip]);
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
  // A call is stored as a "started" event and a result event; each is shown once, as the state it has reached.
  const runDetails = collapseToolCalls(recentEvents.filter(isRunDetailEvent));
  // Errors and change summaries sit in the conversation where they happened, before the next message,
  // so a new message pushes them up instead of leaving them pinned under the chat.
  const inlineEventsByTurn = new Map<string, PersistedEvent[]>();
  const trailingInlineEvents: PersistedEvent[] = [];
  for (const event of collapseToolCalls((activeConversation?.events ?? []).filter((item) => !isRunDetailEvent(item))).slice(-100)) {
    const next = activeConversation?.turns.find((turn) => turn.role === 'user' && turn.createdAt > event.timestamp);
    if (!next) trailingInlineEvents.push(event);
    else inlineEventsByTurn.set(next.id, [...(inlineEventsByTurn.get(next.id) ?? []), event]);
  }
  // Each reply is drawn with its activity between the sentences it belongs to, in the order they happened, so the
  // reader follows the run down the page instead of reading all the prose and then all the calls. A record from before
  // positions were kept has nothing to place by and keeps the old layout.
  const conversationTurns = activeConversation?.turns ?? [];
  const runParts = new Map<string, RunSegment[]>();
  const foldedBefore = new Set<string>();
  let trailingFolded = false;
  conversationTurns.forEach((turn, index) => {
    if (turn.role !== 'assistant') return;
    const following = conversationTurns[index + 1];
    if (following && following.role !== 'user') return;
    if (!following && running) return;
    const runEvents = following ? inlineEventsByTurn.get(following.id) : trailingInlineEvents;
    if (!runEvents?.length) return;
    const parts = interleaveRun(turn.text, runEvents);
    if (!parts) return;
    runParts.set(turn.id, parts);
    if (following) foldedBefore.add(following.id);
    else trailingFolded = true;
  });
  const liveParts = running && !trailingFolded && trailingInlineEvents.length > 0 ? interleaveRun(streamingText, trailingInlineEvents) : null;
  /**
   * Whether anything is still going on this conversation. Paused and awaiting-approval count: a run parked on a
   * person still has a call in flight, so its cards must not read as interrupted. This is the same union the
   * composer's Stop button uses.
   */
  const runActive = running || paused || awaitingApproval;
  const fixFindingStable = useLatestHandler(fixFinding);
  const renderInlineEvent = (event: PersistedEvent, defaultExpanded: boolean): ReactNode => <RunEventCard key={event.id} event={event} originalRequest={event.type === 'turn.changes' ? activeConversation?.turns.find((turn) => turn.id === event.turnId)?.text ?? '' : ''} projectId={activeProject?.id ?? null} reviewMode={profile.reviewMode} defaultExpanded={defaultExpanded} runActive={runActive} onAskKai={askKaiStable} onFixFinding={fixFindingStable} onOpenFile={onOpenFile} onReview={reviewTurnChanges} onUndo={restoreTurnChanges} onOpenVerification={onOpenVerification} />;
  const renderInlineEvents = (events: readonly PersistedEvent[]): ReactNode => groupExecutableCommands(events).map((group) => group.kind === 'commands'
    ? <ExecutableCommandsGroup key={group.key} events={group.events} runActive={runActive}>{group.events.map((event) => renderInlineEvent(event, false))}</ExecutableCommandsGroup>
    : renderInlineEvent(group.event, false));
  const timelineSummary = runDetails.reduce((summary, event) => {
    if (event.type === 'tool.call') summary.tools += 1;
    else if (event.type === 'file.edit.applied' || event.type === 'file.change' || event.type === 'diff.proposal') summary.edits += 1;
    else if (event.type === 'cost.update') summary.usage += 1;
    return summary;
  }, { tools: 0, edits: 0, usage: 0 });
  const activity = deriveAgentActivity(recentEvents, running, paused, awaitingApproval, autoWaiting);
  const latestRequestText = [...(activeConversation?.turns ?? [])].reverse().find((turn) => turn.role === 'user')?.text ?? '';
  const latestRequest = latestRequestText.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
  // The composer's status line names only the step in hand ("Editing payment.service.ts"); the card holds the rest.
  const liveStep = running ? currentStep(deriveActivitySteps(recentEvents)) : null;
  const planProgress = usePlanProgress(activeProject?.id ?? null, activeConversation?.id ?? null, activeConversation?.updatedAt);
  // Autopilot runs a Studio plan, so it is reached through the plan this conversation was opened for — the studio id,
  // not the desktop project the plan happens to be registered as. Auto, by contrast, is about this conversation.
  const autopilotOrigin = activeConversation?.origin?.kind === 'autopilot' ? activeConversation.origin : null;
  /** A crew's work log is read here and never written to: a message typed in it would start an ordinary run, not reach the Lead. */
  const crewLog = activeConversation?.origin?.kind === 'crew';
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
  // The size the person chose for compacting; with auto-compact off the old warning size still marks "getting long".
  const compactLimit = settings.usageBudget.compactAtTokens > 0 ? settings.usageBudget.compactAtTokens : COMPACTION_WARNING_TOKENS;
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
      <PageHeader
        title={activeConversation?.title ?? activeProject?.name ?? 'Workspace'}
        detail={activeConversation ? activeProject?.name ?? 'Conversation' : activeProject ? 'Workspace' : 'Open a project to begin'}
        actions={<>
          {activeProject && !activeProject.id.startsWith('studio_') && (
            <UiButton
              type="button"
              className="status-action"
              onClick={onPlanInStudio}
              disabled={running || busy}
              title={`Take ${activeProject.name} into the Project Studio and start a plan attached to its folder`}
            >
              <NotebookPen size={13} /><span>Plan in Studio</span>
            </UiButton>
          )}
          <Pill tone={ready ? 'success' : 'error'}><Circle size={7} fill="currentColor" /> {apiRun ? 'API' : 'CLI'} {ready ? 'ready' : 'unavailable'}</Pill>
          <Pill tone="info"><Sparkles size={13} /> {apiRun ? directApiCapability?.model || directApiCapability?.displayName || 'Direct API' : selectedCapability?.version ?? selectedCapability?.displayName ?? selectedAgent}</Pill>
          <ActionsMenu
            ariaLabel="More workspace actions"
            items={[
              { key: 'raw', label: `Raw events (${rawEvents.length})`, icon: <Braces size={14} />, onSelect: () => setRawEventsOpen((current) => !current) },
              { key: 'continue', label: 'Continue in new tab', disabled: busy || !activeConversation, onSelect: onContinueInNewTab },
            ]}
            trigger={({ onClick, expanded }) => <IconButton aria-label="More workspace actions" aria-expanded={expanded} onClick={onClick} icon={<Ellipsis size={15} />} />}
          />
        </>}
      />

      <div ref={noticesRef} className={`workspace-notices ${noticesExpanded ? 'expanded' : ''}`}>
        {interruptedRuns > 0 && !running && (
          <NoticeBanner primary={<UiButton type="button" variant="secondary" onClick={onOpenRecovery}>Review</UiButton>}>
            {interruptedRuns} run{interruptedRuns === 1 ? ' was' : 's were'} interrupted the last time KAI closed.
          </NoticeBanner>
        )}

        {/* Something the composer was waiting on has passed its deadline. Rendering it here rather than in the
            composer is the point: the control that is stuck is inside the composer, so the way out has to be
            somewhere the stuck call cannot disable. */}
        {stuckNotice && (
          <NoticeBanner tone="danger" primary={<UiButton type="button" variant="danger" onClick={onStopEverything}>Stop everything</UiButton>} onDismiss={() => setStuckNotice(null)}>
            {stuckNotice}
          </NoticeBanner>
        )}

        {/* Said here because this is the conversation that card was being worked in. A run that closed mid-card, or
            one stopped by hand, leaves the board holding the card with nothing running for it — and this is the only
            screen that can offer to carry on from where it stopped rather than starting the card over. */}
        {interruptedAutopilot && (
          <NoticeBanner
            tone="waiting"
            primary={<UiButton type="button" variant="secondary" disabled={stoppingRun} onClick={() => void carryOnAutopilot()}>Carry on</UiButton>}
            more={[{ key: 'release', label: 'Put the card back', disabled: stoppingRun, onSelect: () => void releaseAutopilotCard() }]}
          >
            The board still has &ldquo;{interruptedAutopilot.cardTitle}&rdquo; marked In progress from an Autopilot run that is no longer going.
          </NoticeBanner>
        )}

        {crewLog && (
          <NoticeBanner primary={<UiButton type="button" variant="secondary" onClick={onOpenCrew}>Open the Crew</UiButton>}>
            This is a crew&rsquo;s work log, read-only. To ask the Lead something or give the crew more to do, use the Crew tab.
          </NoticeBanner>
        )}

        {autopilotOrigin && (
          <NoticeBanner primary={<UiButton type="button" variant="secondary" onClick={() => onOpenStudioCard(autopilotOrigin.studioProjectId, autopilotOrigin.cardId)}>Open card in Studio</UiButton>}>
            Studio card: &ldquo;{autopilotOrigin.cardTitle}&rdquo;
          </NoticeBanner>
        )}

        {activeConversation && !running && estimateConversationTokens(activeConversation) >= compactLimit && (
          <NoticeBanner
            primary={<UiButton type="button" variant="secondary" disabled={busy} onClick={onCompactConversation}>Compact</UiButton>}
            more={[{ key: 'continue', label: 'Continue in new tab', disabled: busy, onSelect: onContinueInNewTab }]}
          >
              This conversation is about {formatCompact(estimateConversationTokens(activeConversation))} tokens. Compact it before the context window fills.
              {/* The size on its own says nothing about money; a large idle conversation resumed on a paid API model is exactly
                  the moment a cost warning is worth having, before the first reply of the new session is sent. */}
              {resumeCostEstimate && <> Resuming it costs roughly ${resumeCostEstimate.low < 0.01 ? resumeCostEstimate.low.toFixed(4) : resumeCostEstimate.low.toFixed(2)}–${resumeCostEstimate.high < 0.01 ? resumeCostEstimate.high.toFixed(4) : resumeCostEstimate.high.toFixed(2)} for the next response alone.</>}
            
          </NoticeBanner>
        )}

        <UsageBanner conversationId={activeConversation?.id} refreshToken={activeConversation?.events.length} onOpenUsage={onOpenUsage} />

        {workbenchNotice && (
          <div className="workbench-notice" role="status">
            <span>{workbenchNotice}</span>
            <UiButton type="button" className="icon-button compact" aria-label="Dismiss notice" onClick={() => setWorkbenchNotice(null)}><X size={13} /></UiButton>
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
        {noticeCount > 1 && <UiButton type="button" className="workspace-more-notices" aria-expanded={noticesExpanded} onClick={() => setNoticesExpanded((open) => !open)}>{noticesExpanded ? 'Show less' : `+${noticeCount - 1} more`}</UiButton>}
      </div>

      {skillsOpen && (
        <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Skills">
          <div className="skills-panel">
            <div className="skills-panel-head">
              <div><span className="eyebrow">Project capabilities</span><h2>Skills</h2></div>
              <UiButton type="button" className="icon-button compact" aria-label="Close skills" onClick={() => setSkillsOpen(false)}><X size={15} /></UiButton>
            </div>
            <label className="input-with-icon"><Search size={14} /><UiTextInput value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="Search skills" autoFocus /></label>
            <div className="skills-list">
              {visibleSkills.map((skill) => {
                const selected = selectedSkills.some((item) => item.name === skill.name);
                return (
                    <UiButton key={`${skill.scope}:${skill.path}`} type="button" className={`skill-row ${selected ? 'selected' : ''}`} onClick={() => { setSelectedSkills((current) => selected ? current.filter((item) => item.name !== skill.name) : [...current, skill]); setPrompt((current) => /\$[A-Za-z0-9_-]*$/.test(current) ? current.replace(/\$[A-Za-z0-9_-]*$/, `$${skill.name} `) : current); }}>
                    <span><strong>${skill.name}</strong><small>{skill.scope}</small></span>
                    <p>{skill.description}</p>
                  </UiButton>
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
              <UiButton type="button" className="icon-button compact" aria-label="Close raw event inspector" onClick={() => setRawEventsOpen(false)}><X size={15} /></UiButton>
            </div>
            <div className="raw-event-list">
              {rawEvents.map((event) => (
                <article className="raw-event" key={event.id}>
                  <div className="raw-event-heading">
                    <strong>{event.sourceType}</strong>
                    <span>{new Date(event.timestamp).toLocaleString()}{event.agent ? ` · ${event.agent}` : ''}</span>
                    <UiButton type="button" className="secondary-button" onClick={() => void copyRawEvent(event.payload, setWorkbenchNotice)}>Copy payload</UiButton>
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
                <UiButton type="button" className="secondary-button" onClick={() => void restoreTurnChanges(checkpointReview.turnId)}><Undo2 size={14} /><span>Undo all</span></UiButton>
                <UiButton type="button" className="icon-button compact" aria-label="Close checkpoint review" onClick={() => setCheckpointReview(null)}><X size={15} /></UiButton>
              </div>
            </div>
            {!checkpointReview.gitAvailable && <div className="workbench-error">This turn has no Git checkpoint, so files cannot be restored automatically.</div>}
            <div className="checkpoint-files">
              {checkpointReview.files.map((file) => (
                <article className="checkpoint-file" key={file.path}>
                  <div className="checkpoint-file-heading">
                    <div><strong>{file.path}</strong> <VerificationBadge status={fileChecks[file.path] ?? 'unverified'} /><span><b className="diff-add">+{file.added}</b><b className="diff-remove">-{file.removed}</b>{file.binary ? ' · binary' : ''}</span></div>
                    <UiButton type="button" className="secondary-button" disabled={!checkpointReview.gitAvailable} onClick={() => void rejectReviewedFile(file.path)}><Undo2 size={13} /><span>Restore file</span></UiButton>
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
        {activeConversation?.turns.length || streamingText || pendingUser || visibleSteers.length || pendingQuestion ? (
          <>
            {activeConversation?.turns.map((turn, index) => (
              <Fragment key={turn.id}>
                {!foldedBefore.has(turn.id) && renderInlineEvents(inlineEventsByTurn.get(turn.id) ?? [])}
                {(() => {
                  const parts = runParts.get(turn.id);
                  const awaiting = Boolean(turn.awaitingAnswer) && !running && !pendingUser && index === activeConversation.turns.length - 1;
                  if (!parts) {
                    return <MessageTurn turn={turn} brainReady={brainReady} onSaveToBrain={setBrainDraft} onBranch={onBranchTurn} onRewind={onRewindTurn} onSaveRecipe={saveTurnAsRecipeStable} onOpenFile={onOpenFile} awaitingAnswer={awaiting} onAnswer={queueOrSendStable} />;
                  }
                  const lastText = parts.map((part) => part.kind).lastIndexOf('text');
                  const firstText = parts.findIndex((part) => part.kind === 'text');
                  return parts.map((part, partIndex) => part.kind === 'events'
                    ? <Fragment key={`events-${partIndex}`}>{renderInlineEvents(part.events)}</Fragment>
                    : <MessageTurn key={`text-${partIndex}`} turn={turn} partText={part.text} partFirst={partIndex === firstText} partLast={partIndex === lastText} brainReady={brainReady} onSaveToBrain={setBrainDraft} onBranch={onBranchTurn} onRewind={onRewindTurn} onSaveRecipe={saveTurnAsRecipeStable} onOpenFile={onOpenFile} awaitingAnswer={awaiting} onAnswer={queueOrSendStable} />);
                })()}
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
            {visibleSteers.map((steer) => (
              <article key={steer.id} className="message user">
                <div className="message-role">You</div>
                <MessageContent text={steer.text} />
                {steer.images.length > 0 && (
                  <div className="message-attachments" aria-label="Attached images">
                    {steer.images.map((image, index) => <ImageCard key={`${index}-${image.name}`} name={image.name} dataUrl={image.dataUrl} />)}
                  </div>
                )}
              </article>
            ))}
            {liveParts
              ? liveParts.map((part, partIndex) => part.kind === 'events'
                ? <Fragment key={`live-events-${partIndex}`}>{renderInlineEvents(part.events)}</Fragment>
                : <article key={`live-text-${partIndex}`} className={`message assistant${partIndex === liveParts.length - 1 ? ' streaming' : ''}${partIndex === liveParts.findIndex((item) => item.kind === 'text') ? '' : ' continued'}`}>
                    {partIndex === liveParts.findIndex((item) => item.kind === 'text') && <div className="message-role">KAI</div>}
                    <Markdown text={part.text} onOpenFile={onOpenFile} />
                  </article>)
              : streamingText && <article className="message assistant streaming"><div className="message-role">KAI</div><Markdown text={streamingText} onOpenFile={onOpenFile} /></article>}
            {pendingQuestion && <InlineQuestion key={pendingQuestion.requestId} question={pendingQuestion} onAnswer={onAnswerQuestion} />}
            {(running || paused || awaitingApproval) && (
              <ActivityCard events={recentEvents} activity={activity} running={running} paused={paused} task={latestRequest} elapsedSeconds={elapsedSeconds} tokenEstimate={liveTokenEstimate} onOpenFile={onOpenFile} />
            )}
            {/* The run in progress shows its changes as they happen; a finished one keeps them closed. */}
            {/* Commands and edits stay folded to one line while the run is live too; opening one is the reader's choice. */}
            {!trailingFolded && !liveParts && renderInlineEvents(trailingInlineEvents)}
            {runDetails.length > 0 && (
              <section className="run-details" aria-label="Activity timeline">
                <UiButton type="button" className="run-details-toggle" aria-expanded={showRunDetails} onClick={() => setShowRunDetails((current) => !current)}>
                  <ChevronDown size={13} />
                  <span>Activity</span>
                  <small>{timelineSummary.tools ? `${timelineSummary.tools} actions` : ''}{timelineSummary.edits ? `${timelineSummary.tools ? ' · ' : ''}${timelineSummary.edits} edits` : ''}{timelineSummary.usage ? `${timelineSummary.tools || timelineSummary.edits ? ' · ' : ''}usage` : ''}</small>
                </UiButton>
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
            {!activeProject && <UiButton type="button" className="primary-button" onClick={onChooseProject}><FolderOpen size={16} /><span>Open project</span></UiButton>}
          </div>
        )}
      </div>

      <div className="composer">
        {/* CLI only: the next agent is a real choice there. In API mode the provider/model runs the turn, and the
            conversation's old CLI agent (often "claude") is not what is running. */}
        {!apiRun && running && activeConversation?.activeAgent && activeConversation.activeAgent !== selectedAgent && (
          <div className="composer-agent-notice" role="status">
            <strong>Current run: {agentCapabilities.find((agent) => agent.id === activeConversation.activeAgent)?.displayName ?? activeConversation.activeAgent}</strong>
            <span>{agentCapabilities.find((agent) => agent.id === selectedAgent)?.displayName ?? selectedAgent} is selected for the next run.</span>
          </div>
        )}
        {proxyContinuationAgent === selectedAgent && !apiRun && effectiveRoute === 'direct' && (
          <div className="composer-route-handoff" role="status">
            <Route size={15} />
            <div>
              <strong>{selectedCapability?.displayName ?? 'This agent'} reached its account limit</strong>
              <span>Keep this conversation and switch only its next run to {settings.proxy.defaultModel} through your configured Universal Proxy. KAI will show the provider and budget before any API request.</span>
            </div>
            <UiButton type="button" className="primary-button" disabled={!proxyReady || busy} onClick={() => void confirmProxyContinuation(proxyContinuationAgent)}>
              <Route size={13} /><span>{proxyReady ? 'Continue via proxy' : 'Start proxy first'}</span>
            </UiButton>
          </div>
        )}
        {activeConversation && <BlockedActionsStrip conversationId={activeConversation.id} events={activeConversation.events} />}
        {/* A missing CLI is explained even before a project is open, so the user knows how to get it. */}
        {(activeProject || (!apiRun && selectedCapability?.state === 'not_installed')) && !ready && (apiRun ? directApiCapability : selectedCapability) && (
          <div className="agent-setup-banner" role="status">
            <div className="agent-setup-copy">
              <strong>{apiRun ? 'API setup required' : setupTitle(selectedCapability!)}</strong>
              <span>{notice ?? unavailableReason}</span>
              {!apiRun && selectedCapability?.state === 'not_installed' && selectedCapability.installCommand && (
                <div className="agent-install-command">
                  <code title="Official install command">{selectedCapability.installCommand}</code>
                  <UiButton type="button" className="icon-button" title="Copy install command" aria-label="Copy install command" onClick={() => void navigator.clipboard.writeText(selectedCapability.installCommand!).catch(() => undefined)}>
                    <Copy size={13} />
                  </UiButton>
                </div>
              )}
            </div>
            <div className="agent-setup-actions">
              {!apiRun && selectedCapability?.state === 'not_installed' && (
                <UiButton type="button" className="primary-button" onClick={() => onInstall(selectedAgent)} disabled={busy}>
                  <Download size={14} />
                  <span>Install</span>
                </UiButton>
              )}
              {!apiRun && selectedCapability?.state === 'signed_out' && (
                <UiButton type="button" className="secondary-button" onClick={() => onSignIn(selectedAgent)} disabled={busy}>
                  <LogIn size={14} />
                  <span>Sign in</span>
                </UiButton>
              )}
              {apiRun ? (
                <UiButton type="button" className="secondary-button" onClick={onOpenSettings} disabled={busy}>
                  <Settings2 size={14} />
                  <span>Configure API</span>
                </UiButton>
              ) : (
                <a className="secondary-button" href={selectedCapability!.installUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  <span>Install guide</span>
                </a>
              )}
              <UiButton type="button" className="secondary-button" onClick={onRefreshAgents} disabled={busy}>
                <RefreshCw size={14} />
                <span>Refresh status</span>
              </UiButton>
            </div>
          </div>
        )}
        {activeGoal && (
          <div className={`goal-progress status-${activeGoal.status}`}>
            <span className="goal-target"><Goal size={15} /></span>
            <div className="goal-copy"><strong>{activeGoal.outcome}</strong><small>{activeGoal.status}{activeGoal.verification ? ` · ${activeGoal.verification}` : ''}</small></div>
            <div className="goal-actions">
              {activeGoal.status === 'running'
                ? <UiButton type="button" title="Pause goal" onClick={() => void updateGoalState('paused')}><Square size={11} /></UiButton>
                : <UiButton type="button" title="Resume goal" onClick={() => void updateGoalState('running')}><Play size={12} /></UiButton>}
              <UiButton type="button" title="Complete goal" onClick={() => void updateGoalState('completed')}><Check size={12} /></UiButton>
              <UiButton type="button" title="Clear goal" onClick={() => void clearGoal()}><X size={12} /></UiButton>
            </div>
          </div>
        )}
        {queuedPrompts.length > 0 && (
          <div className="queue-list">
            {queuedPrompts.map((item, index) => (
              <div className="queue-row" key={item.id}>
                <span className="queue-label" title={item.status === 'sending' ? 'Sending instruction' : item.status === 'blocked' ? 'Delivery failed' : 'Queued instruction'}><GitFork size={12} /></span><span className="truncate">{item.text}</span>
                <span className="queue-status">{item.status === 'sending' || steeringQueued.includes(item.id) ? 'Sending' : item.status === 'blocked' ? 'Needs retry' : 'Waiting'}</span>
                {item.status === 'blocked' && <UiButton type="button" aria-label="Retry queued prompt" title={item.error ?? 'Retry queued prompt'} onClick={() => onUpdateQueuedPrompt(item.id, 'retry')}><RefreshCw size={12} /></UiButton>}
                <UiButton
                  type="button"
                  className="queue-steer-button"
                  aria-label="Send queued prompt now"
                  title={running ? apiRun ? 'Handle this instruction now, then resume the active task' : 'CLI runs cannot accept live messages; this will send after the run ends' : 'Send this instruction next'}
                  disabled={item.status === 'sending' || steeringQueued.includes(item.id) || (running && !apiRun)}
                  onClick={() => steerQueuedPrompt(index)}
                ><ArrowRight size={12} /><span>{running && !apiRun ? 'After run' : 'Steer now'}</span></UiButton>
                <UiButton
                  type="button"
                  className="queue-steer-button"
                  aria-label="Branch from this queued prompt"
                  title="Start a new chat branched from your latest message, with this message ready to send there"
                  disabled={item.status === 'sending' || steeringQueued.includes(item.id)}
                  onClick={() => onBranchQueued(item.id, item.text)}
                ><GitFork size={12} /><span>Branch</span></UiButton>
                <UiButton
                  type="button"
                  className="queue-steer-button"
                  aria-label="Continue this queued prompt in a new tab"
                  title="Open a new empty chat tab with this message ready to send there"
                  disabled={item.status === 'sending' || steeringQueued.includes(item.id)}
                  onClick={() => onNewTabQueued(item.id, item.text)}
                ><Plus size={12} /><span>New tab</span></UiButton>
                <UiButton type="button" aria-label="Edit queued prompt" title="Edit queued prompt" disabled={item.status === 'sending'} onClick={() => { setPrompt(item.text); onUpdateQueuedPrompt(item.id, 'remove'); promptRef.current?.focus(); }}><Pencil size={12} /></UiButton>
                <UiButton type="button" aria-label="Remove queued prompt" title="Remove queued prompt" disabled={item.status === 'sending'} onClick={() => onUpdateQueuedPrompt(item.id, 'remove')}><Trash2 size={12} /></UiButton>
              </div>
            ))}
          </div>
        )}
        <div className="context-chip-row">
          {selectedFiles.map((file) => (
            <Pill className="context-chip" key={file} title={file}><File size={11} /><span className="truncate">{file}</span><UiButton type="button" aria-label={`Remove ${file}`} onClick={() => setSelectedFiles((current) => current.filter((item) => item !== file))}><X size={11} /></UiButton></Pill>
          ))}
          {contextChips.map((chip) => chip.type === 'image' && chip.dataUrl ? (
            <ImageChip
              key={contextChipKey(chip)}
              name={chip.name}
              dataUrl={chip.dataUrl}
              onRemove={() => setContextChips((current) => current.filter((item) => contextChipKey(item) !== contextChipKey(chip)))}
            />
          ) : (
            <Pill className={`context-chip ${chip.type}-chip`} key={contextChipKey(chip)} title={contextChipLabel(chip)}>
              {contextChipIcon(chip.type)}
              <span className="truncate">{contextChipLabel(chip)}</span>
              <UiButton type="button" aria-label={`Remove ${contextChipLabel(chip)}`} onClick={() => setContextChips((current) => current.filter((item) => contextChipKey(item) !== contextChipKey(chip)))}><X size={11} /></UiButton>
            </Pill>
          ))}
          {selectedSkills.map((skill) => (
            <Pill className="context-chip skill-chip" key={skill.name}>${skill.name}<UiButton type="button" aria-label={`Remove ${skill.name}`} onClick={() => setSelectedSkills((current) => current.filter((item) => item.name !== skill.name))}><X size={11} /></UiButton></Pill>
          ))}
        </div>
        {contextChips.filter((chip): chip is Extract<ContextChip, { type: 'memory' }> => chip.type === 'memory').map((chip) => (
          <div className="brain-brief" key={`brief:${chip.query}`} role="status">
            <Brain size={14} />
            <div><strong>Brain brief</strong><span>{chip.summary || `Memory search: ${chip.query}`}</span></div>
            <UiButton type="button" className="icon-button compact" aria-label="Remove Brain brief" title="Remove Brain brief" onClick={() => setContextChips((current) => current.filter((item) => item !== chip))}><X size={12} /></UiButton>
          </div>
        ))}
        {contextPickerOpen && activeProject && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Add context">
          <div className="context-picker skills-panel">
            <div className="context-picker-head">
              <div><strong>Add context</strong><span>Files, selections, changes, memory, or an attachment</span></div>
              <UiButton type="button" className="icon-button compact" aria-label="Close context picker" onClick={() => setContextPickerOpen(false)}><X size={14} /></UiButton>
            </div>
            <div className="context-picker-actions">
              <UiButton type="button" disabled={contextBusy} onClick={() => void addSelectionContext()}><Braces size={14} /><span>Current selection</span></UiButton>
              <UiButton type="button" disabled={contextBusy} onClick={() => void addGitDiffContext()}><FileDiff size={14} /><span>Uncommitted changes</span></UiButton>
              <UiButton type="button" disabled={contextBusy} onClick={() => void addMemoryContext()}><Brain size={14} /><span>Search memory</span></UiButton>
              <UiButton type="button" disabled={contextBusy} onClick={() => imageInputRef.current?.click()}><Paperclip size={14} /><span>Attach file</span></UiButton>
            </div>
            <label className="input-with-icon context-file-search"><FileSearch size={14} /><UiTextInput autoFocus value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Search project files" /></label>
            <div className="context-file-results">
              {fileResults.map((file) => (
                <UiButton type="button" key={file} onClick={() => { setSelectedFiles((current) => [...new Set([...current, file])]); setContextPickerOpen(false); setFileQuery(''); setPrompt((current) => current.replace(/@[^\s]*$/, '').trimEnd()); }}>
                  <AtSign size={12} /><span className="truncate">{file}</span>
                </UiButton>
              ))}
              {contextBusy && <div className="empty-list">Searching project files</div>}
              {!contextBusy && fileResults.length === 0 && <div className="empty-list">No matching files</div>}
            </div>
          </div>
          </div>
        )}
        {presetsOpen && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Saved prompts">
          <div className="context-picker skills-panel">
            <div className="context-picker-head">
              <div><strong>Saved prompts</strong><span>Reuse a prompt, or save the one you're writing into a slot</span></div>
              <UiButton type="button" className="icon-button compact" aria-label="Close saved prompts" onClick={() => setPresetsOpen(false)}><X size={14} /></UiButton>
            </div>
            <div className="prompt-preset-list">
              {Array.from({ length: 9 }, (_, index) => index + 1).map((slot) => {
                const preset = presets.find((entry) => entry.slot === slot);
                return (
                  <div className="prompt-preset-row" key={slot}>
                    <span className="prompt-preset-slot"><Hash size={11} />{slot}</span>
                    {preset ? (
                      <>
                        <UiButton type="button" className="prompt-preset-use" title={preset.text} onClick={() => { setPrompt(preset.text); setPresetsOpen(false); window.setTimeout(() => promptRef.current?.focus(), 0); }}>
                          {preset.label}
                        </UiButton>
                        <UiButton type="button" className="icon-button compact" aria-label={`Delete preset ${slot}`} title="Delete this saved prompt" onClick={() => void window.kaiDesktop.deletePromptPreset(slot).then(unwrap).then(setPresets)}><Trash2 size={12} /></UiButton>
                      </>
                    ) : (
                      <UiButton
                        type="button"
                        className="prompt-preset-use empty"
                        disabled={!prompt.trim() || savingPresetSlot === slot}
                        title={prompt.trim() ? 'Save the current prompt into this slot' : 'Write a prompt first'}
                        onClick={() => void (async () => {
                          const label = await promptDialog({ title: 'Save prompt', label: 'Name', placeholder: 'What this prompt is for', validate: (value) => value.trim() ? null : 'Give it a short name.' });
                          if (!label) return;
                          setSavingPresetSlot(slot);
                          try {
                            const saved = unwrap(await window.kaiDesktop.savePromptPreset(slot, label.trim(), prompt));
                            setPresets(saved);
                          } catch (caught) {
                            setWorkbenchNotice(messageOf(caught));
                          } finally {
                            setSavingPresetSlot(null);
                          }
                        })()}
                      >
                        Empty — save current prompt here
                      </UiButton>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="command-chip-row in-picker" role="group" aria-label="Slash commands">{COMMANDS.map((command) => <UiButton type="button" key={command} onClick={() => { applyCommand(command); setPresetsOpen(false); }}>{command}</UiButton>)}</div>
          </div>
          </div>
        )}
        {sideOpen && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Side question">
          <div className="context-picker skills-panel side-question-panel">
            <div className="context-picker-head">
              <div><strong>Side question</strong><span>Answered on its own, without changing this conversation</span></div>
              <UiButton type="button" className="icon-button compact" aria-label="Close side question" onClick={() => setSideOpen(false)}><X size={14} /></UiButton>
            </div>
            {sideConversation && sideConversation.turns.length > 0 && (
              <div className="side-question-transcript">
                {sideConversation.turns.map((turn) => (
                  <div key={turn.id} className={`side-question-turn ${turn.role}`}>
                    {turn.role === 'assistant' ? <Markdown text={turn.text} /> : <p>{turn.text}</p>}
                  </div>
                ))}
                {sideConversationRunning && <div className="side-question-turn assistant thinking"><Loader2 className="spin" size={12} /><span>Thinking…</span></div>}
              </div>
            )}
            <div className="side-question-compose">
              <Textarea
                rows={1}
                value={sideDraft}
                onChange={(event) => setSideDraft(event.target.value)}
                placeholder="Ask something off to the side, then come back to this conversation"
                disabled={sideConversationRunning}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (sideDraft.trim() && !sideConversationRunning) { onAskSideQuestion(sideDraft.trim()); setSideDraft(''); }
                  }
                }}
              />
              <UiButton type="button" className="secondary-button" disabled={!sideDraft.trim() || sideConversationRunning} onClick={() => { onAskSideQuestion(sideDraft.trim()); setSideDraft(''); }}>
                {sideConversationRunning ? <Loader2 className="spin" size={13} /> : <Send size={13} />}
                <span>Ask</span>
              </UiButton>
            </div>
          </div>
          </div>
        )}
        {goalEditor && (
          <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Goal">
          <div className="goal-editor skills-panel">
            <div className="goal-editor-head"><strong>Goal</strong><span>Outcome, constraints, and proof of completion</span></div>
            <label><span>Outcome</span><Textarea rows={2} value={goalEditor.outcome} onChange={(event) => setGoalEditor({ ...goalEditor, outcome: event.target.value })} placeholder="What should be true when this work is done?" /></label>
            <label><span>Constraints</span><Textarea rows={2} value={goalEditor.constraints ?? ''} onChange={(event) => setGoalEditor({ ...goalEditor, constraints: event.target.value })} placeholder="Required tools, boundaries, or approaches to avoid" /></label>
            <label><span>Verification</span><Textarea rows={2} value={goalEditor.verification ?? ''} onChange={(event) => setGoalEditor({ ...goalEditor, verification: event.target.value })} placeholder="Tests, measurements, or review criteria that prove completion" /></label>
            <div className="button-row align-end"><UiButton type="button" className="secondary-button" onClick={() => setGoalEditor(null)}>Cancel</UiButton><UiButton type="button" className="secondary-button" onClick={() => void saveGoal(false)}>Save</UiButton><UiButton type="button" className="primary-button" onClick={() => void saveGoal(true)}>Start goal</UiButton></div>
          </div>
          </div>
        )}
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            if (files.length > 0) void attachComposerFiles(files);
          }}
        />
        {activeProject && <PlanStrip projectId={activeProject.id} conversationId={activeConversation?.id ?? null} refreshKey={activeConversation?.updatedAt} />}
        {activeProject && planAwaitsApproval && (
          <PlanApprovalBar
            projectId={activeProject.id}
            conversationId={activeConversation?.id ?? null}
            refreshKey={activeConversation?.updatedAt}
            onApprove={(level) => { onSelectAutonomy(level); setApprovedPlanPrompt(PLAN_APPROVED_PROMPT); }}
            onDismiss={() => setDismissedPlanAt(activeConversation?.updatedAt ?? null)}
          />
        )}
        {/* `busy` here is the boolean prop. It used to be compared to null, which is always true, so the Stop
            button on this line was disabled on every run: the one control that ends a run was unreachable. */}
        {taskIntent === 'equalizer' && activeProject && (
          <EqualizerPanel projectId={activeProject.id} message={prompt} onFix={applyEqualizerFix} />
        )}
        <Composer
          className={crewLog ? '!hidden' : ''}
          tone={composerRun?.line.state ?? 'idle'}
          status={composerRun ? (
            <ComposerRunLine
              state={composerRun.line}
              step={liveStep}
              progress={planProgress}
              busy={stoppingRun || busy}
              onStop={() => void (composerRun.line.who === 'autopilot' ? stopAutopilot() : onCancel())}
              onOpenDetails={() => setRunDetailsOpen(true)}
            />
          ) : undefined}
        >
          <ComposerInput
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
                .filter((item) => item.kind === 'file')
                .flatMap((item) => item.getAsFile() ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void attachComposerFiles(files);
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
            placeholder={running
              ? apiRun ? 'Steer the run, or press Stop to take over…' : 'Queue a message for the next turn…'
              : activePersona.placeholder}
            aria-label="Task prompt"
            disabled={!activeProject || (busy && !running) || !ready || refiningPrompt}
          />
          <ComposerToolbar
            leading={<>
              <IconButton aria-label="Add context" title="Add files, images, memory, or project context" active={contextPickerOpen} onClick={() => setContextPickerOpen((current) => !current)} icon={<Plus size={15} />} />
              <IconButton aria-label="Saved prompts" title="Saved prompts" active={presetsOpen} onClick={() => setPresetsOpen((current) => !current)} icon={<Hash size={14} />} />
              <IconButton aria-label="Slash commands" title="Commands: type / in the message box" onClick={() => { setPrompt((current) => (current.startsWith('/') ? current : `/${current}`)); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task prompt"]')?.focus(), 0); }} icon={<span className="font-mono text-[13px] font-semibold leading-none">/</span>} />
              {activeConversation && <ContextRing tokens={liveTokenEstimate} limit={compactLimit} busy={busy} running={running} onCompact={onCompactConversation} />}
              {activeConversation && <IconButton aria-label="Side question" title="Ask a quick question without derailing this conversation" active={sideOpen} onClick={() => setSideOpen((current) => !current)} icon={<MessageCircleQuestion size={14} />} />}
              <OptionMenu ariaLabel="Access level" disabled={busy} icon={<ShieldCheck size={13} />} labelPrefix="Access" onChange={onSelectAutonomy} options={ACCESS_OPTIONS} title="Choose how much access KAI has" value={selectedAutonomy} />
              <OptionMenu ariaLabel="Task type" disabled={busy} icon={<Sparkles size={14} />} labelPrefix="Task" onChange={chooseTaskIntent} options={PERSONAS.map((persona) => ({ value: persona.id, label: persona.label, description: persona.description }))} title="Choose a task guide; this does not change access" value={taskIntent} />
              <ArchitectChip state={architect} onOpen={() => setAdvancedComposerOpen(true)} />
              {activeRecipes.length > 1 && (
                <OptionMenu
                  ariaLabel="Recipe"
                  disabled={busy}
                  icon={<ListChecks size={14} />}
                  labelPrefix="Recipe"
                  onChange={(value) => {
                    const recipe = activeRecipes.find((entry) => entry.id === value);
                    if (recipe) chooseRecipe(recipe);
                  }}
                  options={activeRecipes.map((recipe) => ({ value: recipe.id, label: recipe.label, description: recipe.description }))}
                  title={`Choose the kind of ${activePersona.label.toLowerCase()} task`}
                  value={activeRecipe?.id ?? activeRecipes[0]?.id ?? ''}
                />
              )}
              {activeRecipe && activeRecipe.id.startsWith('saved_') && <IconButton aria-label="Remove saved recipe" title="Remove this saved recipe" disabled={busy} onClick={() => void removeSavedRecipe(activeRecipe.id)} icon={<Trash2 size={14} />} />}
              <OptionMenu ariaLabel="Model" disabled={busy} icon={<Sparkles size={14} />} onChange={(value) => { if (value !== CUSTOM_MODEL) { onSelectModel(value); return; } void promptDialog({ title: 'Use a custom model', label: 'Model name', initialValue: selectedModel, placeholder: 'provider/model-name', confirmLabel: 'Use model', validate: validateModelName }).then((typed) => { if (typed) onSelectModel(typed); }); }} options={modelOptions(apiRun, selectedAgent, directApiCapability, selectedModel)} title="Model for this conversation" value={selectedModel} />
              <IconButton data-tour="composer-advanced" aria-label="More run options" title="More run options" aria-expanded={advancedComposerOpen} active={advancedComposerOpen} disabled={busy} onClick={() => setAdvancedComposerOpen((open) => !open)} icon={<Settings2 size={14} />} />
            </>}
            actions={<>
              <IconButton aria-label="Refine prompt" title={refineTitle} disabled={!prompt.trim() || refineBlocked || !refineTarget} onClick={() => void refinePromptDraft()} icon={refiningPrompt ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />} />
              {(running || paused || awaitingApproval) ? (
                <>
                  {running && <ComposerSend label="Queue message" title="Queue for the next turn" disabled={!canSendPrompt || busy || refiningPrompt || previewAttachmentSaving} onClick={send} />}
                  {running && apiRun && <ComposerSend label="Steer active run" title="Steer this run at its next model step" disabled={!canSendPrompt || interjecting || previewAttachmentSaving} onClick={interjectNow} icon={<ArrowRight size={14} />} />}
                  {!awaitingApproval && <ComposerPause paused={paused} onPause={onPause} onResume={onResume} />}
                  <ComposerStop onClick={onCancel} />
                </>
              ) : (
                <ComposerSend
                  label={isAutoLikeIntent(taskIntent) ? 'Start Auto on this task' : activeConversation ? 'Send message' : 'Start conversation'}
                  title={isAutoLikeIntent(taskIntent) ? 'Send and Auto works it until it is done' : activeConversation ? 'Send message' : 'Start conversation'}
                  disabled={!activeProject || !canSendPrompt || busy || startingAuto || refiningPrompt || previewAttachmentSaving || !ready}
                  sending={startingAuto}
                  onClick={send}
                />
              )}
            </>}
          />
          <ArchitectStatusLine status={architectStatus} />
          {advancedComposerOpen && <div className="mt-2.5 flex flex-col gap-4 border-t border-[color:var(--border)] pt-3" aria-label="More run options">
            <OptionSection title="How it runs">
              <OptionMenu ariaLabel="Route" tone={effectiveRoute === 'proxy' && !proxyReady ? 'unavailable' : undefined} disabled={busy || !routeAvailable} icon={<Route size={14} />} onChange={onSelectRoute} options={[{ value: 'direct', label: 'Direct' }, { value: 'proxy', label: proxyReady ? 'Proxy' : 'Proxy (not ready)', disabled: !routeAvailable || !proxyReady }]} title={!routeAvailable ? 'This agent does not support the Universal Proxy route' : proxyReady ? 'Choose direct provider access or the KAI Universal Proxy route' : 'Start Universal Proxy in Settings to use the proxy route'} value={effectiveRoute} />
              <div className="mode-toggle" role="group" aria-label="Execution mode"><UiButton type="button" className={!apiRun ? 'active' : ''} aria-pressed={!apiRun} onClick={() => onSelectExecution('cli')} disabled={busy}>CLI</UiButton><UiButton type="button" className={apiRun ? 'active' : ''} aria-pressed={apiRun} onClick={() => onSelectExecution('api')} disabled={busy}>API</UiButton></div>
              {apiRun ? <IconButton title={`${providerLabel} — open provider settings`} aria-label={`Provider: ${providerLabel}. Open provider settings`} onClick={onOpenSettings} disabled={busy} icon={<Cloud size={14} />} /> : <OptionMenu ariaLabel="Agent" tone={ready ? undefined : 'unavailable'} disabled={busy || running} icon={<Cpu size={14} />} onChange={onSelectAgent} options={agentCapabilities.map((agent) => ({ value: agent.id, label: `${agent.displayName}${setupSuffix(agent)}` }))} title={running ? 'The current run is using its original agent; stop it before switching' : (selectedCapability?.unavailableReason ?? 'Which agent works on this conversation')} value={selectedAgent} />}
              {!apiRun && reasoningLevels.length > 0 && <OptionMenu ariaLabel="Thinking effort" disabled={busy} icon={<Brain size={14} />} onChange={(value) => onSelectReasoning(value as ReasoningEffort | '')} options={[{ value: '', label: 'Effort: default' }, ...reasoningLevels.map((level) => ({ value: level, label: REASONING_LABEL[level] }))]} title="How hard the agent thinks on this conversation's next runs" value={selectedReasoning} />}
            </OptionSection>
            <OptionSection title="Replies and helpers">
              <OptionMenu ariaLabel="Reply style" disabled={busy} icon={<Lightbulb size={14} />} onChange={(value) => onSelectStyle(value as ResponseStyle)} options={RESPONSE_STYLES.map((style) => ({ value: style, label: RESPONSE_STYLE_LABEL[style], description: RESPONSE_STYLE_DESCRIPTION[style] }))} title="How the agent words what it tells you" value={selectedStyle} />
              <OptionMenu ariaLabel="Agents" disabled={busy} icon={<Users size={14} />} onChange={(value) => onSelectHelpers(value as HelperChoice)} options={HELPER_CHOICES.map((choice) => ({ value: choice, label: HELPER_CHOICE_LABEL[choice], description: HELPER_CHOICE_DESCRIPTION[choice] }))} title="How many helper agents may work on a job at once" value={selectedHelpers} />
              {helperAgentCount > 0 && <Pill tone="info" title={`${helperAgentCount} helper agents in this conversation`}><Search size={12} />{helperAgentCount}</Pill>}
            </OptionSection>
            <OptionSection title="Architect and Implementer" className="!items-start !gap-3">
              <ArchitectToggle state={architect} disabled={busy || running} />
              <ArchitectRow state={architect} disabled={busy || running} />
            </OptionSection>
          </div>}
        </Composer>
        {isAutoLikeIntent(taskIntent) && !AUTO_WORKING_AUTONOMY.has(selectedAutonomy) && (
          <p className="composer-task-guidance" role="note">
            <span>Auto works on its own, so it needs Edit files or Full access, and Access is lower than that.</span>{' '}
            <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => { onSelectAutonomy('autoEdit'); if (prompt.trim()) setSendWhenAccessReady(true); }}>{prompt.trim() ? 'Use Edit files and send' : 'Use Edit files'}</UiButton>
          </p>
        )}
        {taskIntent === 'build' && selectedAutonomy === 'plan' && (
          <p className="composer-task-guidance" role="note">With Plan only access, KAI can plan this build but cannot edit files.</p>
        )}
        {advancedComposerOpen && selectedAutonomy === 'custom' && activeProject && (
          <div className="permission-grid">
            {PERMISSIONS.map((permission) => (
              <label key={permission.key} title={permission.description}>
                <Switch checked={Boolean(projectPreferences?.customPermissions?.[permission.key])} onChange={(event) => void togglePermission(permission.key, event.target.checked)} />
                <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
              </label>
            ))}
          </div>
        )}
        <div className="composer-status-line">
          <UiButton type="button" aria-expanded={composerStatusOpen} onClick={() => setComposerStatusOpen((open) => !open)}><ChevronDown size={12} className={composerStatusOpen ? 'rotate-180' : ''} /> {running ? 'Running' : 'Ready'} · {apiRun ? 'API' : 'CLI'} · {runLabel}</UiButton>
          <span>{cost > 0 ? `$${cost.toFixed(4)} session` : activeConversation?.compaction ? `Context compacted ${relativeTime(activeConversation.compaction.createdAt)}` : activeConversation ? `${activeConversation.turns.length} messages` : 'New conversation'}</span>
          {limitPolicy && <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2" title={limitPolicy}>{limitPolicy}<UiButton type="button" className="composer-text-button" onClick={onOpenUsage}>Usage</UiButton></span>}
        </div>
        {composerStatusOpen && <div className="composer-status-details">
          {responseCostEstimate && <p className="composer-cost-estimate" title={`Rough estimate for one model response on ${estimateModel}. Full agent runs can make multiple responses; context, caching, provider pricing, tools, and actual output change the bill.`}>Roughly ${responseCostEstimate.low < 0.01 ? responseCostEstimate.low.toFixed(4) : responseCostEstimate.low.toFixed(2)}–${responseCostEstimate.high < 0.01 ? responseCostEstimate.high.toFixed(4) : responseCostEstimate.high.toFixed(2)} per response <span>· full task may cost more</span></p>}
          {profile.explainAccess && <p className="access-hint" role="note"><ShieldCheck size={12} /><span><strong>{ACCESS_LEVELS.find((level) => level.value === selectedAutonomy)?.label}:</strong> {ACCESS_LEVELS.find((level) => level.value === selectedAutonomy)?.description}</span></p>}
          <div className="composer-footer"><span>{running ? `Enter to queue${apiRun ? ' · Alt/Ctrl+Enter to steer' : ''}` : 'Enter to send · Shift+Enter for a new line'} · Shift+Tab to change access</span></div>
        </div>}
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
      <UiButton type="button" className="command-group-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)} title={expanded ? 'Hide executable commands' : 'Show executable commands'}>
        <ChevronDown className="command-group-chevron" size={14} />
        <span className="tool-call-icon"><Terminal size={13} /></span>
        <strong>{events.length} command{events.length === 1 ? '' : 's'}</strong>
        <small>{summary}</small>
      </UiButton>
      {expanded && <div className="command-group-list">{children}</div>}
    </section>
  );
}

const MessageTurn = memo(function MessageTurn({ turn, brainReady, onSaveToBrain, onBranch, onRewind, onSaveRecipe, onOpenFile, awaitingAnswer, onAnswer, partText, partFirst = true, partLast = true }: {
  turn: ConversationTurn;
  /** Set when the reply is drawn in pieces with its activity between them: this piece's text, and whether it opens or closes the reply. */
  partText?: string;
  partFirst?: boolean;
  partLast?: boolean;
  brainReady: boolean;
  onSaveToBrain: (text: string) => void;
  onBranch: (turnId: string) => void;
  onRewind: (turnId: string) => void;
  /** Keeps this message's prompt as a recipe. */
  onSaveRecipe: (turnId: string) => void;
  onOpenFile: (path: string) => void;
  /** Set only for the conversation's latest turn, while nothing is running, so answering it is unambiguous. */
  awaitingAnswer: boolean;
  onAnswer: (text: string) => void;
}): ReactNode {
  return (
    <article className={`message ${turn.role}${partFirst ? '' : ' continued'}`}>
      {partFirst && <div className="message-role">
        {turn.role === 'user' ? 'You' : 'KAI'}
        {turn.role === 'assistant' && brainReady && (
          <UiButton type="button" className="message-action" title="Save this answer to the C1 brain" aria-label="Save to Brain" onClick={() => onSaveToBrain(turn.text)}>
            <BookmarkPlus size={12} /><span>Save to Brain</span>
          </UiButton>
        )}
        {turn.role === 'assistant' && (
          <UiButton type="button" className="message-action" title="Branch from this message" aria-label="Branch from this message" onClick={() => onBranch(turn.id)}><GitFork size={12} /><span>Branch</span></UiButton>
        )}
      </div>}
      <MessageContent text={partText ?? turn.text} markdown={turn.role === 'assistant'} onOpenFile={onOpenFile} />
      {turn.role === 'user' && turn.attachments?.length ? (
        <div className="message-attachments" aria-label="Attached images">
          {turn.attachments.map((attachment) => (
            <ImageCard key={`${attachment.name}-${attachment.dataUrl.slice(-24)}`} name={attachment.name} dataUrl={attachment.dataUrl} />
          ))}
        </div>
      ) : null}
      {turn.role === 'user' && turn.files?.length ? (
        <div className="message-attachments" aria-label="Attached files">
          {turn.files.map((file) => (
            <span className="attachment-file" key={`${file.name}:${file.mimeType ?? ''}`} title={file.name}>
              <Paperclip size={12} /><span className="truncate">{file.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {turn.role === 'assistant' && partLast && turn.generatedImages?.length ? (
        <div className="message-attachments" aria-label="Generated images">
          {turn.generatedImages.map((image, index) => <ImageCard key={`${turn.id}-${index}`} name={image.name} dataUrl={image.dataUrl} />)}
        </div>
      ) : null}
      {partLast && <CopyMessageButton text={turn.text} extra={turn.role === 'user' ? (
        <>
          <UiButton type="button" className="message-action" title="Rewind to before this message" aria-label="Rewind to before this message" onClick={() => onRewind(turn.id)}><Undo2 size={12} /><span>Rewind</span></UiButton>
          <UiButton type="button" className="message-action" title="Branch from this message" aria-label="Branch from this message" onClick={() => onBranch(turn.id)}><GitFork size={12} /><span>Branch</span></UiButton>
          <UiButton type="button" className="message-action" title="Keep this prompt as a recipe in the task picker" aria-label="Save this prompt as a recipe" onClick={() => onSaveRecipe(turn.id)}><BookmarkPlus size={12} /><span>Save as recipe</span></UiButton>
        </>
      ) : undefined} />}
      {awaitingAnswer && partLast && <AnswerBox onAnswer={onAnswer} />}
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
      <UiTextInput
        type="text"
        value={text}
        placeholder="Type your answer…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
      />
      <UiButton type="button" className="primary-button" disabled={!text.trim()} onClick={submit}>Answer</UiButton>
    </div>
  );
}

function CopyMessageButton({ text, extra }: { text: string; extra?: ReactNode }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="message-tools">
      {extra}
      <UiButton
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
      </UiButton>
    </div>
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
            <header><span>{language}</span><UiButton type="button" title="Copy code" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(part)}><Copy size={14} /></UiButton></header>
            <pre><code>{part.trim()}</code></pre>
          </section>;
        }
        return part.split(/\n{2,}/).filter(Boolean).map((paragraph, paragraphIndex) => <p key={`text-${index}-${paragraphIndex}`}>{paragraph}</p>);
      })}
    </div>
  );
}

function RunEventCardBase({ event, originalRequest, projectId, reviewMode, defaultExpanded, runActive, onAskKai, onFixFinding, onOpenFile, onReview, onUndo, onOpenVerification }: { event: PersistedEvent; originalRequest: string; projectId: string | null; reviewMode: ReviewMode; defaultExpanded: boolean; /** Whether the run this event belongs to is still going, which is the only way to tell a live tool call from one nothing is running. */ runActive: boolean; onAskKai: (text: string) => void; onFixFinding: (text: string) => void; onOpenFile: (path: string, line?: number) => void; onReview: (turnId: string) => Promise<void>; onUndo: (turnId: string) => Promise<void>; onOpenVerification: () => void }): ReactNode {
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [contextSnapshotExpanded, setContextSnapshotExpanded] = useState(false);
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
  if (event.type === 'context.snapshot') {
    return (
      <details className="run-event context-snapshot" onToggle={(toggle) => setContextSnapshotExpanded(toggle.currentTarget.open)}>
        <summary><span>Context sent</span><strong>{event.delivery.toUpperCase()} · ~{formatCompact(event.estimatedTokens)} tokens</strong></summary>
        <small>{formatCompact(event.totalCharacters)} characters of project context. Token count is approximate; provider-managed system prompts and resumed session history are outside this record.</small>
        {event.sections.map((section) => (
          <div className="context-snapshot-section" key={section.kind}>
            <strong>{section.label}</strong>
            {section.note && <small>{section.note}</small>}
            {section.items.map((item) => <small key={`${item.kind}:${item.source ?? item.label}`}>{item.source ?? item.label}{item.truncated ? ' · truncated' : ''}</small>)}
            {section.items.length === 0 && !section.note && <small>None</small>}
          </div>
        ))}
        {event.supplementalSources.length > 0 && <div className="context-snapshot-section"><strong>Additional inputs</strong>{event.supplementalSources.map((source) => <small key={source}>{source}</small>)}</div>}
        {event.projectContextText !== undefined && event.projectContextText.length > 0 && <div className="context-snapshot-section"><strong>Project context text{event.projectContextTextTruncated ? ' · display capped' : ''}</strong>{contextSnapshotExpanded && <pre>{event.projectContextText}</pre>}</div>}
        {event.projectContextText === undefined && <small>Project context text is unavailable for this saved snapshot.</small>}
      </details>
    );
  }
  if (event.type === 'memory.event') {
    return <div className="run-event memory"><span>Memory</span><strong>{event.action.replace('_', ' ')}</strong><small>{event.summary}</small></div>;
  }
  if (event.type === 'notice') {
    return <div className="run-event notice"><ShieldCheck size={12} /><span>{event.message}</span></div>;
  }
  if (event.type === 'cost.update') {
    const details = [event.amountUsd != null ? `$${event.amountUsd.toFixed(4)}` : '', event.inputTokens != null ? `${event.inputTokens} in` : '', event.outputTokens != null ? `${event.outputTokens} out` : '', event.cachedInputTokens && event.inputTokens ? `${Math.min(100, Math.round((event.cachedInputTokens / event.inputTokens) * 100))}% cached${event.cacheSavedUsd ? `, saved $${event.cacheSavedUsd.toFixed(4)}` : ''}` : ''].filter(Boolean).join(' · ');
    return details ? <div className="run-event cost"><span>Usage</span><strong>{details}</strong></div> : null;
  }
  if (event.type === 'error') {
    return <div className="run-event error"><span>Error</span><strong>{event.message}</strong>{event.recoverable && <small>recoverable</small>}<UiButton type="button" className="secondary-button explain-error-button" title="Ask KAI what this error means and how to fix it, without changing any files" onClick={() => onAskKai(`I got this error. Explain in plain words what it means, why it probably happened, and the smallest safe fix. Do not change any files yet.\n\nError: ${event.message}`)}><Lightbulb size={12} /><span>Explain this error</span></UiButton></div>;
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
        <UiButton
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
        </UiButton>
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
          <UiButton type="button" className="primary-button" disabled={!event.turnId || !event.hasCheckpoint} onClick={() => event.turnId && void onReview(event.turnId)} title={event.hasCheckpoint ? 'Review changed files against the checkpoint' : 'This turn has no Git checkpoint'}><Eye size={13} /><span>Review changes</span></UiButton>
          <UiButton type="button" className="secondary-button" disabled={!event.turnId || !event.hasCheckpoint} onClick={() => event.turnId && void onUndo(event.turnId)} title={event.hasCheckpoint ? 'Restore every file changed during this turn' : 'This turn has no Git checkpoint'}><Undo2 size={13} /><span>Undo turn</span></UiButton>
          <UiButton type="button" className="secondary-button" disabled={!projectId || event.files.length === 0 || explanation.state === 'loading'} onClick={() => void explainChanges(event.files.map((file) => file.path))} title="A second model reads these changes and explains them in plain words"><Lightbulb size={13} /><span>{explanation.state === 'loading' ? 'Reading the changes…' : explanation.state === 'done' ? 'Explain again' : 'Explain these changes'}</span></UiButton>
          {verification?.latest && <UiButton type="button" className="secondary-button" onClick={onOpenVerification} title="Open verification history"><ShieldCheck size={13} /><span>Verification details</span></UiButton>}
        </div>
        {explanation.state === 'error' && <div className="change-explanation error" role="alert"><strong>Could not explain the changes</strong><p>{explanation.error}</p></div>}
        {explanation.state === 'done' && explanation.result && (
          <div className="change-explanation" aria-live="polite">
            <strong>{explanation.result.findings.length === 0 ? 'Nothing needs your attention' : explanation.result.ok ? 'A few minor notes' : 'Worth a look before you keep this'}</strong>
            {explanation.result.summary && <p>{explanation.result.summary}</p>}
            {explanation.result.findings.length > 0 && <ul>{explanation.result.findings.map((finding, index) => {
              const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
              const fixPrompt = [
                `Fix this reviewed finding in ${finding.file}${finding.line ? ` at line ${finding.line}` : ''}.`,
                ...(originalRequest ? [`Original request: ${originalRequest}`] : []),
                `Finding (${finding.severity}): ${finding.note}`,
                'Make the smallest appropriate change, then run the relevant checks and report what you verified.',
              ].join('\n\n');
              return (
                <li key={index}>
                  <Pill tone={finding.severity === 'high' ? 'error' : finding.severity === 'medium' ? 'warning' : 'info'}>{finding.severity}</Pill>
                  <UiButton type="button" className="review-finding-file-button" title={`Open ${location}`} onClick={() => onOpenFile(finding.file, finding.line)}><File size={12} /><span>{location}</span></UiButton>
                  <p>{finding.note}</p>
                  <UiButton type="button" className="secondary-button compact" onClick={() => onFixFinding(fixPrompt)}><Wand2 size={12} /><span>Ask KAI to fix</span></UiButton>
                </li>
              );
            })}</ul>}
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
    || event.type === 'context.snapshot'
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
              <UiButton type="button" className="primary-button" disabled={Boolean(actionBusy) || !side.ok} onClick={() => void runAction(`pick-${position}`, () => onPick(result.id, position))}><Check size={13} /><span>{actionBusy === `pick-${position}` ? 'Applying' : 'Pick this one'}</span></UiButton>
              <UiButton type="button" className="secondary-button" disabled={Boolean(actionBusy)} onClick={() => void runAction(`open-${position}`, () => onOpen(result.id, position))}><FolderOpen size={13} /><span>Open worktree</span></UiButton>
            </div>
          </article>
        ))}
      </div>
      {actionError && <div className="workbench-error">{actionError}</div>}
      <div className="compare-discard-row"><UiButton type="button" className="secondary-button" disabled={Boolean(actionBusy)} onClick={() => void runAction('discard', () => onDiscard(result.id))}><Trash2 size={13} /><span>Discard both</span></UiButton></div>
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
    case 'attachment':
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
    case 'attachment':
      return <Paperclip size={11} />;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The file could not be read.'));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
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

/** The trade-off each model makes, said in the picker the way the mockup does. */
const MODEL_DESCRIPTIONS: Record<string, string> = {
  opus: 'Deep reasoning',
  sonnet: 'Fast, everyday builds',
  haiku: 'Cheapest, quick checks',
  'claude-opus-5-5': 'Deep reasoning',
  'claude-sonnet-5-5': 'Fast, everyday builds',
  'claude-haiku-5-5': 'Cheapest, quick checks',
  'claude-fable-5-1': 'Long-form and creative work',
};

/** The picker groups by who serves the model, so a list that mixes providers reads as a menu, not a jumble. */
function modelGroup(name: string): string {
  if (name.startsWith('claude')) return 'Anthropic';
  if (name.startsWith('gpt')) return 'OpenAI';
  if (name.startsWith('deepseek')) return 'DeepSeek';
  if (name.startsWith('qwen')) return 'Qwen';
  return 'Other';
}

/**
 * How full the conversation's context is, as a small ring beside the composer's other tools. Opening it says how much
 * is used and holds the one action that frees room, Compact, so that action sits where the fullness is shown.
 */
function ContextRing({ tokens, limit, busy, running, onCompact }: { tokens: number; limit: number; busy: boolean; running: boolean; onCompact: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const ratio = limit > 0 ? Math.min(1, tokens / limit) : 0;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = ratio >= 0.9 ? 'var(--needs-you, var(--danger))' : ratio >= 0.7 ? 'var(--waiting, var(--accent))' : 'var(--accent)';
  return (
    <div ref={rootRef} className="context-ring relative inline-flex">
      <IconButton
        aria-label={`Context used: about ${Math.round(ratio * 100)} percent`}
        aria-expanded={open}
        title={open ? undefined : "Context used"}
        active={open}
        onClick={() => setOpen((current) => !current)}
        icon={(
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r={radius} fill="none" stroke="var(--border)" strokeWidth="2.5" />
            <circle cx="9" cy="9" r={radius} fill="none" stroke={tone} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${circumference * ratio} ${circumference}`} transform="rotate(-90 9 9)" />
          </svg>
        )}
      />
      {open && (
        <div role="dialog" aria-label="Context used" className="absolute bottom-[calc(100%+6px)] left-0 z-[60] w-64 rounded-xl border border-[color:var(--border)] bg-[var(--bg-raised)] p-3 shadow-[0_14px_34px_rgba(0,0,0,0.4)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--text-dim)]">Context</div>
          <div className="mt-1 text-sm text-[var(--text)]">About {Math.round(ratio * 100)}% used</div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">~{formatCompact(tokens)} of ~{formatCompact(limit)} tokens before KAI suggests compacting.</div>
          <UiButton type="button" className="secondary-button mt-2.5" disabled={busy} onClick={() => { setOpen(false); onCompact(); }}>{running ? 'Compact before the next step' : 'Compact conversation'}</UiButton>
        </div>
      )}
    </div>
  );
}

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
): OptionMenuOption<string>[] {
  const suggestions = apiRun
    ? directProviderPreset(capability?.provider ?? 'openai').models
    : agent in CLI_MODEL_SUGGESTIONS ? CLI_MODEL_SUGGESTIONS[agent as keyof typeof CLI_MODEL_SUGGESTIONS] : [];
  const known = new Set(suggestions);
  const defaultLabel = apiRun && capability?.model ? `Default (${capability.model})` : 'Default';
  return [
    { value: '', label: defaultLabel },
    ...suggestions.map((name) => ({
      value: name,
      label: MODEL_LABELS[name] ?? name,
      ...(MODEL_DESCRIPTIONS[name] ? { description: MODEL_DESCRIPTIONS[name] } : {}),
      group: modelGroup(name),
    })),
    ...(selected && !known.has(selected) ? [{ value: selected, label: selected, group: modelGroup(selected) }] : []),
    { value: CUSTOM_MODEL, label: 'Other model…' },
  ];
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
          <UiButton key={option} type="button" className="secondary-button" onClick={() => onAnswer(question.requestId, option)}>{option}</UiButton>
        ))}
      </div>
      {question.allowFreeText && (
        <form className="inline-question-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) onAnswer(question.requestId, answer.trim()); }}>
          <UiTextInput aria-label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Or type your own answer" />
          <UiButton type="submit" className="primary-button" disabled={!answer.trim()}>Answer</UiButton>
        </form>
      )}
      <UiButton type="button" className="inline-question-skip" onClick={() => onAnswer(question.requestId, null)}>Skip for now</UiButton>
    </section>
  );
}

/** The access choices with what each one lets KAI do. There is one control for them, in the composer's own row. */
const ACCESS_OPTIONS: readonly OptionMenuOption<AutonomyMode>[] = ACCESS_LEVELS.map((level) => ({ value: level.value, label: level.label, description: level.description }));

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
  const label = 'text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-dim)]';
  return (
    <div className="context-body kai-scroll-hidden flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
      <div>
        <div className={label}>Context</div>
        <h2 className="m-0 mt-1 text-sm font-semibold text-[var(--text)]">{activeProject?.name ?? 'No project'}</h2>
      </div>
      <div>
        <div className={label}>Estimated direct API context</div>
        <div className="mt-1 text-[13px] text-[var(--text)]">{contextPreviewLoading ? 'Calculating...' : contextPreview ? `~${formatCompact(contextPreview.estimatedTokens)} tokens` : 'Unavailable'}</div>
        <div className="mt-0.5 text-xs text-[var(--text-dim)]">{contextPreview ? `${formatCompact(contextPreview.totalCharacters)} characters across ${contextPreview.sections.reduce((sum, section) => sum + section.items.length, 0)} item(s)` : 'Open a project to preview context.'}</div>
      </div>
      {(contextPreview?.sections ?? []).map((section) => (
        <div key={section.kind}>
          <div className={`${label} flex items-center gap-1.5`}>{contextSectionIcon(section.kind)}<span>{section.label}</span><small className="ml-auto normal-case tracking-normal">~{formatCompact(section.estimatedTokens)}</small></div>
          {section.note && <div className="mt-1 text-xs text-[var(--text-dim)]">{section.note}</div>}
          {section.items.length > 0 ? (
            <div className="mt-1 flex flex-col">
              {section.items.map((item) => (
                <div key={`${item.kind}:${item.source ?? item.label}`} title={item.source} className="flex items-center justify-between gap-2 py-1 text-xs text-[var(--text-muted)]">
                  <span className="min-w-0 truncate">{item.label}</span>
                  <small className="shrink-0 whitespace-nowrap text-[11px] text-[var(--text-dim)]">~{formatCompact(item.estimatedTokens)} tok{item.truncated ? ' / partial' : ''}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-xs text-[var(--text-dim)]">None</div>
          )}
        </div>
      ))}
      <div>
        <div className={`${label} flex items-center gap-1.5`}><Cpu size={12} /><span>Services</span></div>
        {services.map((service) => (
          <div key={service.kind} className="mt-1.5 flex items-center gap-2 text-[13px] text-[var(--text)]">
            <span className={`status-dot ${service.status}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{service.kind === 'cognitive1' ? 'C1 Brain' : 'Universal Proxy'}</span>
            <Pill tone={service.status === 'ready' ? 'success' : service.status === 'failed' || service.status === 'degraded' ? 'error' : 'neutral'}>{statusLabel(service.status)}</Pill>
          </div>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-[color:var(--border-soft)] pt-2.5 text-xs text-[var(--text-dim)]"><span>Updated</span><strong className="font-medium text-[var(--text-muted)]">{conversation ? relativeTime(conversation.updatedAt) : 'Not active'}</strong></div>
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
  return <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-2)]" aria-hidden="true" />;
}
