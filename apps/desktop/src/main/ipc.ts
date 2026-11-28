import { isWorkspaceConversation, scopeConversationRequest } from './conversation-scope';
import { prepareLeadEdit, decideLeadEdit, type LeadEditStore } from './lead-edits';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import {
  OPENPENCIL_CREDENTIAL_ID,
  OPENPENCIL_ENDPOINT,
  OPENPENCIL_MCP_SERVER_ID,
  type EqualizerImageInput,
  type OpenPencilSaveInput,
  type OpenPencilStatus,
  type OpenPencilTestResult,
  classifyWork,
  type Schedule,
  type BootstrapPayload,
  type AgentRunEvent,
  type AgentId,
  type AgentConfigImportPreview,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunState,
  type AppSettings,
  openPlanItems,
  openPlanReminder,
  planIsUnfinished,
  type BrainEntry,
  type ConversationBranchResult,
  type ConversationForkInput,
  type ConversationRecord,
  type ConversationRewindInput,
  type ContextChip,
  type CompareRun,
  type CompareStartInput,
  type CheckpointReview,
  type CheckpointRestoreResult,
  type ConfigBackup,
  type CredentialStatus,
  type IpcChannel,
  type IpcFailure,
  type IpcResponse,
  type KaiDesktopBridge,
  type LogEntry,
  type PersistedEvent,
  type ProxyAgentId,
  type ProxyConfigTransferResult,
  type ProxyEnvCopyResult,
  type ProxyLaunchResult,
  type ProxyLiveEvent,
  type ProxyRoutingAction,
  type ProjectRecord,
  type SkillSummary,
  type ServiceTokenCopyResult,
  type ServiceState,
  type SharedDesktopState,
  type StudioBoard,
  type WorkflowTemplate,
  type WorkflowTemplateSaveInput,
  type CodeFormatResult,
  type GitFileInfo,
  type LearningEvaluationResult,
  type LearningExplainBackHelp,
  type LearningExplainBackResult,
  type LearningLessonRecordResult,
  type LearningProgress,
  type WorkflowRun,
  type WorkflowStartInput,
  createDefaultCrewConfig,
  studioCrewGoal,
  parseIpcInput,
  parseSecurityFindingsReport,
  parseTasks,
  parseTestCounts,
  revertHunks,
  proxyServiceSettingsSchema,
  securityAuditPrompt,
  type SecurityScanInput,
  type SecurityScanResult,
} from '@kai/contracts';
import type { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import { cliProxyEnvironment, type AgentExecutionResult, type DesktopAgentRuntime } from './agent-runtime';
import { brainProjectNote, resolveBrainProject, type BrainProjectResolution, type KnownBrainProject } from './brain-project';
import { describeRunOutcome, outstandingLine } from './run-summary';
import { planBriefingFor, readPlan } from './plan-store';
import { MemoryBudget } from './memory-budget';
import { buildTurnDigest } from './turn-digest';
import { helpersBriefing, responseStyleBriefing, workingMethodBriefing } from './working-method';
import { diagnoseRun, diagnosisLine } from './run-doctor';
import { buildHistoryNote } from './run-history';
import { canInterject, clearInterjections, interject, setInterjectionActive, takeDeliveredInterjections, type InterjectionAttachment, type InterjectionExtras } from './interjections';
import { parseImageDataUrl } from './image-attachments';
import { attachmentText } from './attachment-text';
import { buildProjectContext, namedPaths } from './context-builder';
import { resolveApiConnection, withGatewayProfile } from './api-connection';
import type { DesktopDirectProviderRuntime, DirectApiApprovalPort, DirectApiApprovalRequest } from './direct-provider-runtime';
import { awaitsTheUser } from './direct-provider-runtime';
import { applyExecutionRulesToRequest, buildExecutionRulesBriefing, compactRules, injectRulesIntoProjects, plainDashes, RULES_MARKER, shouldCarryRules, withAutopilotException, withCrewException, withCrewReadOnlyException } from './execution-rules';
import type { DesktopExecutionRules } from './execution-rules';
import type { DesktopMcpRuntime } from './mcp-runtime';
import type { Cognitive1Client } from './cognitive1-client';
import { dataLocations, type DesktopPaths } from './paths';
import { isParallelCopy } from './parallel-session';
import { closeWhatARunOpened } from './process-cleanup';
import type { UniversalProxyClient } from './proxy-client';
import type { DesktopProxyRouting } from './proxy-routing';
import { proxyAgentBaseUrl } from './proxy-routing';
import { ensureClaudeSettingsFile, resetClaudeCodeConfig } from './claude-maintenance';
import { brainPathInsideRepository, mergeSettingsUpdate, type DesktopServiceController } from './service-controller';
import type { ProjectPreferenceStore } from './project-preference-store';
import type { ProjectStore } from './project-store';
import { buildSkillPrompt, discoverDesktopSkills, readCapabilityBundleSkills, skillSummaries } from './skills';
import type { DesktopShell } from './desktop-shell';
import { mcpText, parseActiveClaims, parseConflictText, parseRecallText, parseUrgentNotes } from './coordination';
import type { TerminalManager } from './terminal';
import { findGitBash } from './terminal';
import { availableShells, terminalBriefing } from './agent-terminal';
import { windowBriefing } from './window-control';
import { runSecurityPrepass } from './security-prepass';
import { boardCardSchema, type ImportReport } from '@kai/contracts';
import type { ExecutionMode } from '@kai/contracts';
import { BRAIN_TOOLS_GUIDANCE, type BrainAccess } from './brain-tools';
import { windowedHistory } from './history-tools';
import { renderConversationHandoff } from './conversation-handoff';
import { brainMemoryReviewPrompt, type BrainMemoryReviewInput, type BrainMemoryReviewResult } from '@kai/contracts';
import { compactThresholdFor, modelContextFor, modelHostOf, estimateConversationTokens, isLocalProvider } from '@kai/contracts';
import type { UpdateController } from './updater';
import { buildDiagnosticsReport } from './diagnostics-report';
import { gitCheckout, gitCloneTeamRepository, gitCommit, gitCreateBranch, gitCreatePullRequest, gitCreateRepository, gitBlameFile, gitChangedHunks, gitDiffAgainstHead, scanTodos, gitDiffFile, githubCliStatus, gitInit, gitOverview, gitPullTeamBranch, gitStage, gitSync } from './git-tools';
import { importCardId, scanForImport } from './import-scan';
import { agentChecksFromEvents, recordVerification, runCheckCommand, suggestTestCommand, verificationOverview, type RecordedCheck, type VerificationStore } from './verification';
import { captureTurnFileEvidence } from './turn-file-evidence';
import { publishInlineMockup, publishProjectMockup } from './mockup-server';
import { FileConflictError, createProjectFolder, deleteProjectPath, fileChangedOnDisk, listProjectFiles, readProjectFile, readProjectImage, renameProjectPath, writeProjectFile } from './project-files';
import { buildRecap, buildResume, describeEvent, type RecoveryStore } from './recovery-store';
import type { NotificationCenter } from './notification-rules';
import { collectPaidRuns, summarizeUsageFromRuns, type ExternalPaidRun } from './usage-budget';
import type { UsageLedger } from './usage-ledger';
import { sharedLoad } from './shared-load';

/** How long runs that start together share one load of the saved conversations when checking the usage budget. */
const USAGE_SNAPSHOT_MS = 10_000;
import type { WorkflowTemplateStore } from './workflow-templates';
import type { DesktopConfigBackupStore } from './backups';
import type { LearningProgressStore } from './learning-progress';
import type { DesktopLearningTutor } from './learning-tutor';
import type { TeachingLibraryStore } from './teaching-library';
import type { SecurityFindingsStore } from './security-findings-store';
import { recordLearningLesson } from './learning-records';
import type { LearningBudgetGuard, LearningUsageStore } from './learning-usage';
import { listProviderModels, mergeLocalModels } from './provider-models';
import { testSearchSource } from './web-search';
import { branchedConversation, rewoundConversation } from './conversation-branching';
import { connectorServer, listConnectorCatalog } from './connector-catalog';
import { autoCliModel } from './auto-model';
import { invalidateRepoMap } from './repo-map';
import { knowledgeBriefing, recordRunKnowledge, startWatchingProject } from './project-knowledge';
import { followRunFiles } from './run-file-follow';
import { runWithAutomation, type AutomationPorts } from './automation';
import type { DesktopChangeReviewer } from './change-review';
import type { DesktopEvals } from './evals';
import { escalatedLevel, summarizeScores, type RunScoreStore } from './run-scores';
import { makeAgentExperience, type AgentExperienceStore } from './experience-store';
import { suggestMemoryImprovements } from './experience-suggestions';
import type { DesktopScheduler, ScheduledRunOutcome } from './scheduler';
import type { DesktopWorkflowRunner } from './workflow-runner';
import type { DesktopCrewRunner } from './crew-runner';
import type { DesktopCrewInterview } from './crew-interview';
import type { CrewSupport } from './crew-support';
import type { ConventionService } from './conventions-service';
import type { DesignProfileService } from './design-profile';
import type { DesktopTeamPlanner } from './team-planner';
import type { DesktopAutopilot } from './autopilot';
import type { DesktopAutoSession } from './auto-session';
import type { ArchitectLoop } from './architect-loop';
import type { ArchitectReadiness, RoleTarget } from '@kai/contracts';
import { FileRefusalMemory, syncBrainToMirror } from './brain-mirror';
import type { BrainMirrorOutcome } from '@kai/contracts';
import { modelBelongsToOtherAgent } from '@kai/contracts';
import { composeRunLesson, type RunLessonInput } from './run-learning';
import type { DesktopPromptGuide } from './prompt-guide';
import type { DesktopInterview } from './interview';
import type { DesktopStudio } from './studio';
import type { DesktopGuideService } from './studio-guide-service';
import type { DesktopCodeGuideService } from './code-guide-service';
import type { StudioStyleReferenceStore } from './style-references';
import type { EqualizerService } from './equalizer';
import { resolveInside } from './project-files';
import { suggestPermissionRules } from './permission-setup';
import { deferredToolSummary } from './deferred-tools';
import { recheckReportItems } from './security-recheck';
import { parseNextCheck, selfPacedInstruction } from './self-paced';
import { suggestPermissionRules as suggestHistoryRules, type ApprovalLike } from './permission-suggestions';
import { ComposerQueueStore } from './composer-queue-store';
import type { PromptPresetStore } from './prompt-preset-store';
import type { PlaywrightViewportStatus } from '@kai/contracts';
import type { TeamRecordStore } from './team-record-store';
import type { DesktopRunControl } from './run-control';
import { brainGitStatus, syncBrainGit } from './brain-git';
import { buildSetupStatus } from './setup-status';
import { syncCognitive1Mcp, withOpenPencilMcpSetting } from './agent-mcp-config';
import { projectSelectionForWindow, type DesktopWindowRegistry, type DesktopWindowSession } from './desktop-windows';
import type { EditorSessionManager } from './editor-sessions';
import { formatProjectCode, installRuffFormatter, projectGitFileInfo } from './code-tools';
import {
  createProjectCheckpoint,
  diffFromCheckpoint,
  gitDiffStat,
  isGitRepo,
  readFileAtCheckpoint,
  textDiffFileFromCheckpoint,
  textDiffFromCheckpoint,
  restoreCheckpoint,
  restoreCheckpointFile,
} from './checkpoints';
import {
  applyWorktreePatch,
  createCompareWorktree,
  removeCompareWorktree,
  worktreeChanges,
  worktreeDiffPatch,
} from './worktrees';
import type { PreviewRuntime } from './preview-runtime';
import type { RemoteGateway } from './remote/server';

export interface IpcContext {
  appName: string;
  version: string;
  buildIdentifier: string;
  paths: DesktopPaths;
  fileSystem: NodeFileSystem;
  logger: RedactedLogger;
  settings: SettingsService;
  projects: ProjectStore;
  preferences: ProjectPreferenceStore;
  conversations: ConversationStore;
  composerQueue: ComposerQueueStore;
  promptPresets: PromptPresetStore;
  playwrightViewportStatus(): Promise<PlaywrightViewportStatus>;
  repairPlaywrightViewport(): Promise<PlaywrightViewportStatus>;
  /** What the paid runs have cost, kept up to date as conversations are saved, so no run has to load them all to check the budget. */
  usageLedger?: UsageLedger;
  credentials: CredentialVault;
  services: DesktopServiceController;
  cognitive1: Cognitive1Client;
  proxy: UniversalProxyClient;
  proxyRouting: DesktopProxyRouting;
  proxyLiveTails: Map<number, AbortController>;
  agents: DesktopAgentRuntime;
  executionRules: DesktopExecutionRules;
  directApi: DesktopDirectProviderRuntime;
  mcp: DesktopMcpRuntime;
  /** KAI's terminal is being offered to agents this launch, so their briefing says so. */
  terminalMcp?: boolean;
  /** KAI's own windows are being offered to agents this launch. */
  windowMcp?: boolean;
  /** Launches open-pencil if it is not running, and re-syncs KAI's own connection to whatever it reports (its
   * token when auth is on, no header at all when it is off). Called before any user-initiated open-pencil action
   * — Pull the design, Check connection, a design-build step — so each one works from the editor's live state
   * rather than whatever was last saved, and starts the editor rather than just reporting it is not there. */
  ensureOpenPencil: () => Promise<void>;
  workflowTemplates: WorkflowTemplateStore;
  backups: DesktopConfigBackupStore;
  learningProgress: LearningProgressStore;
  learningTutor: DesktopLearningTutor;
  teachingLibrary: TeachingLibraryStore;
  securityFindings: SecurityFindingsStore;
  preview: PreviewRuntime;
  compareRuns: Map<string, ActiveCompareRun>;
  memorySessions: Map<string, ActiveMemorySession>;
  pendingApprovals: Map<string, {
    conversationId: string;
    ownerWindowId: number | null;
    event: Extract<AgentRunEvent['event'], { type: 'approval.request' }>;
    // `answer` carries the option (or free text) chosen for a question raised with `options`; absent for an
    // ordinary allow/deny response, and ignored by a caller that only reads `approved`.
    resolve: (result: { approved: boolean; answer?: string }) => void;
  }>;
  windows: DesktopWindowRegistry;
  editorSessions: EditorSessionManager;
  learningUsage: LearningUsageStore;
  learningBudget: LearningBudgetGuard;
  workflows: DesktopWorkflowRunner;
  crew: DesktopCrewRunner;
  /** The short interview before a crew plans. */
  crewInterview: DesktopCrewInterview;
  crewSupport: CrewSupport;
  conventions: ConventionService;
  designProfiles: DesignProfileService;
  teamPlanner: DesktopTeamPlanner;
  autopilot: DesktopAutopilot;
  auto: DesktopAutoSession;
  /** The Architect / Implementer split for a normal send. Auto runs the same Architect through its own session. */
  architect: ArchitectLoop;
  /** Whether one role's choice can run right now; the composer asks before a run and the engine asks during one. */
  architectReadiness: (target: RoleTarget) => Promise<ArchitectReadiness>;
  promptGuide: DesktopPromptGuide;
  interview: DesktopInterview;
  studio: DesktopStudio;
  /** The Senior Dev: reads the project to say which step it is on, and explains it in plain words when asked. */
  guide: DesktopGuideService;
  /** The same guide for a code project: the repository, the files, what has been studied and the board. */
  codeGuide: DesktopCodeGuideService;
  styleReferences: StudioStyleReferenceStore;
  equalizer: EqualizerService;
  teamRecord: TeamRecordStore;
  runScores: RunScoreStore;
  experiences: AgentExperienceStore;
  scheduler: DesktopScheduler;
  evals: DesktopEvals;
  changeReviewer: DesktopChangeReviewer;
  runControl: DesktopRunControl;
  notifications: NotificationCenter;
  recovery: RecoveryStore;
  verification: VerificationStore;
  terminal: TerminalManager;
  updater: UpdateController;
  desktopShell: DesktopShell;
  getMainWindow: () => BrowserWindow | null;
  createWindow: (projectId?: string | null) => Promise<void>;
  /** The LAN gateway the mobile console talks to. Its own auth, its own default-deny allowlist. */
  remote: RemoteGateway;
}

/**
 * What every handler receives alongside its validated input. Deliberately free of Electron types so
 * the remote gateway can build one without an IpcMainInvokeEvent.
 */
export interface IpcRequestContext {
  session: DesktopWindowSession | null;
  /** Resolved once, at dispatch time. Handlers must not recompute it. */
  ownerWindowId: number;
}

/** A registered handler with its input type erased. Takes the raw payload and validates it itself. */
export type IpcChannelHandler = (rawInput: unknown, request: IpcRequestContext) => Promise<unknown>;

/** The channel table behind the renderer bridge, re-exposed so other surfaces can dispatch through it. */
export interface IpcRegistry {
  /** Channels that have a handler registered. */
  channels(): IpcChannel[];
  /** Validates `rawInput` for `channel`, then runs its handler. Throws on validation or handler error. */
  dispatch(channel: IpcChannel, rawInput: unknown, request: IpcRequestContext): Promise<unknown>;
}

interface ActiveMemorySession {
  agent: AgentId;
  conversationId: string;
  projectName: string;
  projectPath: string;
}

export interface ActiveCompareRun {
  id: string;
  projectId: string;
  projectPath: string;
  worktreeLeft: string;
  worktreeRight: string;
  patchLeft: string;
  patchRight: string;
}

/**
 * The IPC calls running right now, by channel, with when each was first entered.
 *
 * A handler that never returns is the worst failure this app has: the window waits on it forever, the control
 * that started it stays disabled, and nothing anywhere says which call it was. It is also invisible in the log,
 * because nothing is logged while a call is merely outstanding — an hour was once spent reading a perfectly
 * healthy log looking for a call that had simply never answered. Every handler is timed here so the answer is
 * always on hand, and the diagnostics report prints it.
 *
 * A count rather than a single start time, because a channel can legitimately be in flight more than once.
 */
const inFlightIpc = new Map<string, { count: number; startedAt: number }>();

/** The calls that have not returned yet, longest-waiting first. */
export function inFlightIpcCalls(now: number = Date.now()): Array<{ channel: string; count: number; seconds: number }> {
  return [...inFlightIpc.entries()]
    .map(([channel, entry]) => ({ channel, count: entry.count, seconds: Math.round((now - entry.startedAt) / 1_000) }))
    .sort((left, right) => right.seconds - left.seconds);
}

function trackIpcCall<T>(channel: string, work: () => Promise<T>): Promise<T> {
  const entry = inFlightIpc.get(channel);
  // A second call on the same channel does not restart the clock: what is worth knowing is how long the oldest
  // unanswered one has been waiting.
  if (entry) entry.count += 1;
  else inFlightIpc.set(channel, { count: 1, startedAt: Date.now() });
  return work().finally(() => {
    const current = inFlightIpc.get(channel);
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) inFlightIpc.delete(channel);
  });
}

/**
 * How a direct API run reads and writes the project's memory in C1. The project is found from the folder the run works
 * in, the same way the recall at the start of a run finds it, so both look in one place. Every failure comes back as
 * a reason the model can read rather than an exception that would end its turn.
 */
export function projectBrainAccess(context: IpcContext): BrainAccess {
  const resolve = async (projectRoot: string) => {
    const projects = await context.projects.list();
    const project = projects.find((candidate) => projectRoot.startsWith(candidate.path)) ?? null;
    return resolveProjectMemoryName(context, project?.path ?? projectRoot, project?.name ?? path.basename(projectRoot));
  };
  return {
    async recall(projectRoot, query) {
      if (!(await cognitive1Ready(context))) return { ok: false, reason: 'The brain is not running right now. Carry on without it.' };
      try {
        const resolution = await resolve(projectRoot);
        return { ok: true, entries: await context.cognitive1.search({ query, project: resolution.name, maxResults: 6 }) };
      } catch (error) {
        return { ok: false, reason: `The brain could not be read: ${messageOf(error)}` };
      }
    },
    async remember(projectRoot, entry) {
      if (!(await cognitive1Ready(context))) return { ok: false, reason: 'The brain is not running right now, so this was not kept. Put it in your reply instead.' };
      try {
        const resolution = await resolve(projectRoot);
        const answer = (await context.cognitive1.operation({
          operation: 'brain-learn',
          payload: { title: entry.title, type: entry.type, project: resolution.name, agent: 'kai', note: entry.note, ...(entry.why ? { why: entry.why } : {}), ...(entry.how ? { how: entry.how } : {}), ...(entry.tags ? { tags: entry.tags } : {}) },
        })) as { ok?: boolean; rejected?: boolean; reason?: string } | null;
        if (answer?.rejected || answer?.ok === false) return { ok: false, reason: `The brain turned this entry away: ${answer.reason || 'it did not pass the quality gate'}. Make it more specific and try again.` };
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `The brain could not be written: ${messageOf(error)}` };
      }
    },
  };
}

export function registerIpc(context: IpcContext): IpcRegistry {
  const handlers = new Map<IpcChannel, IpcChannelHandler>();
  const tutorRequests = new Map<string, { controller: AbortController; ownerWindowId: number }>();

  // Shadows the module-level helper of the same name so the ~178 registrations below stay exactly as
  // they were. Validation lives here, in the one place both the ipcMain path and dispatch() go
  // through, so neither can reach a handler body with an unvalidated payload.
  const handle = <TChannel extends IpcChannel>(
    _context: IpcContext,
    channel: TChannel,
    handler: (
      input: ReturnType<typeof parseIpcInput<TChannel>>,
      request: IpcRequestContext,
    ) => Promise<unknown>,
  ): void => {
    handlers.set(channel, (rawInput, request) => {
      // Validated before it is tracked: input that cannot be parsed never reached a handler body, so timing it
      // as an outstanding call would be reporting a call that does not exist.
      const input = parseIpcInput(channel, rawInput);
      return trackIpcCall(channel, () => handler(input, request));
    });
  };

  handle(context, 'app:get-bootstrap', async (_input, request) => createBootstrap(context, request.session));
  handle(context, 'playwright:viewport-status', async () => context.playwrightViewportStatus());
  handle(context, 'playwright:viewport-repair', async () => context.repairPlaywrightViewport());
  handle(context, 'projects:choose', async (_input, request) => chooseProject(context, request.session));
  handle(context, 'projects:open', async ({ id }, request) => openProject(context, id, request.session));
  handle(context, 'projects:remove', async ({ id }, request) => removeProject(context, id, request.session));
  handle(context, 'projects:clear', async (_input, request) => clearProjects(context, request.session));
  handle(context, 'settings:get', async () => context.settings.load());
  handle(context, 'setup:agent-config-preview', async () => agentConfigImportPreview());
  handle(context, 'setup:agent-config-import', async ({ agent }) => importAgentConfig(context, agent));
  handle(context, 'setup:guide-answer', async ({ question, conversationContext }, request) => {
    const settings = await context.settings.load();
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Tutor is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const projectId = request.session
      ? request.session.projectId ?? 'kai-guide'
      : settings.activeProjectId ?? 'kai-guide';
    const reservation = context.learningBudget.reserve({
      projectId,
      provider: readiness.provider,
      model: readiness.model,
      paidRuns: await conversationPaidRuns(context),
      budget: settings.usageBudget,
      estimatedInputTokens: Math.ceil((question.length + (conversationContext?.length ?? 0)) / 4) + 1_000,
      estimatedOutputTokens: 1_500,
      externalRuns: await context.learningUsage.runs(),
    });
    if (reservation.blockedReason) throw new Error(`${reservation.blockedReason} Raise the limit or switch to warn mode in Settings to continue.`);
    try {
      const result = await context.learningTutor.answerKaiGuideDetailed(question, conversationContext);
      await context.learningUsage.record({ projectId, provider: readiness.provider, model: readiness.model, usage: result.usage });
      return result.response;
    } finally {
      context.learningBudget.release(reservation.id);
    }
  });
  handle(context, 'providers:list-models', async (request) => {
    const catalog = await listProviderModels(request, context.credentials);
    if (!isLocalProvider(request.provider) && request.provider !== 'openai-compatible') return catalog;
    const settings = await context.settings.load();
    const merged = mergeLocalModels(catalog, settings.savedLocalModels[request.provider] ?? []);
    if (catalog.source === 'live' && merged.remembered.length !== (settings.savedLocalModels[request.provider] ?? []).length) {
      await context.settings.update((current) => ({ ...current, savedLocalModels: { ...current.savedLocalModels, [request.provider]: merged.remembered } }));
    }
    // What each model can hold, so its runs compact at a share of its own window (see compactThresholdFor).
    const windows = catalog.contextLengths ?? {};
    if (Object.entries(windows).some(([model, size]) => settings.localModelContext[model] !== size)) {
      await context.settings.update((current) => ({ ...current, localModelContext: { ...current.localModelContext, ...windows } }));
    }
    return modelHostOf({ provider: request.provider, baseUrl: request.baseUrl }, settings) === 'own-hardware'
      ? { ...merged.catalog, models: merged.catalog.models.filter((model) => model.toLowerCase() !== 'gateway/auto') }
      : merged.catalog;
  });
  handle(context, 'catalog:list', async () => listConnectorCatalog());
  handle(context, 'catalog:install', async ({ id }) => {
    const server = connectorServer(id);
    if (!server) throw new Error('That connector is not in the catalog.');
    return server;
  });
  handle(context, 'web-search:test', async (request) => {
    const settings = await context.settings.load();
    return testSearchSource(
      request.source,
      request.endpoint,
      request.credentialId,
      context.credentials,
      {
        provider: settings.directApi.provider,
        credentialId: settings.directApi.credentialId,
        baseUrl: settings.directApi.baseUrl,
      },
    );
  });
  handle(context, 'settings:update', async (update) => {
    const snapshot: { previous: AppSettings | null } = { previous: null };
    const currentSettings = await context.settings.load();
    const nextDirectApi = { ...currentSettings.directApi, ...update.directApi };
    const gatewayOwnHardware = update.gatewayOwnHardware ?? currentSettings.gatewayOwnHardware;
    let gatewayAwayUrl = update.gatewayAwayUrl !== undefined ? update.gatewayAwayUrl : currentSettings.gatewayAwayUrl;
    let gatewayCredentialId = update.gatewayCredentialId !== undefined ? update.gatewayCredentialId : currentSettings.gatewayCredentialId;
    // Migrate an older opted-in profile before Direct API changes from its gateway to a cloud provider.
    if (gatewayOwnHardware && !gatewayAwayUrl && currentSettings.directApi.provider === 'openai-compatible') {
      gatewayAwayUrl = currentSettings.directApi.baseUrl;
      gatewayCredentialId = currentSettings.directApi.credentialId;
    }
    // Only an empty profile is filled from the default connection. Once saved, choosing another service as the default
    // must not mark that service as the person's own hardware, or forget where the gateway is.
    if (gatewayOwnHardware && !gatewayAwayUrl && nextDirectApi.provider === 'openai-compatible') {
      gatewayAwayUrl = nextDirectApi.baseUrl;
      gatewayCredentialId = nextDirectApi.credentialId;
    }
    const candidateSettings = {
      ...currentSettings,
      gatewayOwnHardware,
      gatewayAwayUrl,
      gatewayCredentialId,
      gatewayHomeUrl: update.gatewayHomeUrl !== undefined ? update.gatewayHomeUrl : currentSettings.gatewayHomeUrl,
      directApi: nextDirectApi,
    };
    const invalidOwnRoute = [
      { connection: candidateSettings.directApi, model: update.directApi?.model },
      { connection: { ...currentSettings.learningTutor, ...update.learningTutor }, model: update.learningTutor?.model },
      { connection: { ...currentSettings.promptGuide, ...update.promptGuide }, model: update.promptGuide?.model },
    ].some(({ connection, model }) => model?.toLowerCase() === 'gateway/auto' && modelHostOf(connection, candidateSettings) === 'own-hardware');
    if (invalidOwnRoute) {
      throw new Error('gateway/auto cannot be selected for your own hardware. Choose gateway/coding, gateway/general, gateway/research, or gateway/vision.');
    }
    // Before anything is written: a brain path inside a repository is the one setting here that can reach outside
    // KAI and change somebody else's history. See `brainPathInsideRepository`.
    if (update.cognitive1?.dataPath) {
      const repository = await brainPathInsideRepository(update.cognitive1.dataPath);
      if (repository) {
        throw new Error(
          `That brain path is inside the git repository at ${repository}. The engine pulls, commits and pushes its `
          + 'brain folder on a timer, so it would do all three to that repository — your branch, your remote. Choose '
          + 'a folder outside any repository, such as one under your user data folder.',
        );
      }
    }
    const persistedUpdate = { ...update, gatewayAwayUrl, gatewayCredentialId };
    const merged = await context.settings.update((settings) => {
      snapshot.previous = settings;
      return mergeSettingsUpdate(settings, persistedUpdate);
    });
    if (!snapshot.previous) throw new Error('Settings could not be read.');
    const proxyChanged = update.proxy !== undefined && JSON.stringify(merged.proxy) !== JSON.stringify(snapshot.previous.proxy);
    const cognitive1Changed = update.cognitive1 !== undefined && JSON.stringify(merged.cognitive1) !== JSON.stringify(snapshot.previous.cognitive1);
    const remoteChanged = JSON.stringify(merged.remote) !== JSON.stringify(snapshot.previous.remote);
    const services = await context.services.status();
    const proxyWasReady = services.some((service) => service.kind === 'universalProxy' && service.status === 'ready');
    const cognitive1WasReady = services.some((service) => service.kind === 'cognitive1' && service.status === 'ready');
    context.desktopShell.apply(merged.notifications);
    // No blanket invalidate: the runtime reconnects exactly the servers whose settings changed, and a save that
    // touches none of them must not close a tool call an agent is in the middle of.
    if (proxyChanged && proxyWasReady) {
      if (merged.proxy.enabled) await context.services.restart('universalProxy', merged);
      else await context.services.stop('universalProxy');
    }
    if (cognitive1Changed && cognitive1WasReady) {
      if (merged.cognitive1.enabled) await context.services.restart('cognitive1', merged);
      else await context.services.stop('cognitive1');
    }
    await context.services.syncFromSettings(merged);
    // A port that is already taken leaves the setting saved but the gateway down, so the failure is
    // reported through `remote:status` rather than thrown: the rest of the save still succeeded.
    if (remoteChanged) {
      await context.remote.apply(merged.remote).catch((error: unknown) => {
        context.logger.warn('internal', 'KAI Remote could not start', messageOf(error));
      });
    }
    await syncManagedCognitive1Mcp(context);
    await broadcastSharedState(context);
    return context.settings.load();
  });
  handle(context, 'services:status', async () => context.services.status());
  handle(context, 'services:start', async ({ kind }) => {
    const services = await context.services.start(kind);
    if (kind === 'cognitive1') await syncManagedCognitive1Mcp(context);
    await broadcastSharedState(context);
    return services;
  });
  handle(context, 'services:stop', async ({ kind }) => {
    const services = await context.services.stop(kind);
    await broadcastSharedState(context);
    return services;
  });
  handle(context, 'services:restart', async ({ kind }) => {
    const services = await context.services.restart(kind);
    if (kind === 'cognitive1') await syncManagedCognitive1Mcp(context);
    await broadcastSharedState(context);
    return services;
  });
  handle(context, 'services:rotate-token', async ({ kind }) => {
    const services = await context.services.rotateToken(kind);
    if (kind === 'cognitive1') await syncManagedCognitive1Mcp(context);
    await broadcastSharedState(context);
    return services;
  });
  handle(context, 'services:copy-token', async ({ kind }) => {
    const access = await context.services.loopbackAccess(kind);
    clipboard.writeText(access.token);
    return {
      copied: true,
      kind: access.kind,
      endpoint: access.endpoint,
      header: 'Authorization',
      scheme: 'Bearer',
    } satisfies ServiceTokenCopyResult;
  });
  handle(context, 'brain:overview', async () => context.cognitive1.overview());
  handle(context, 'brain:search', async (query) => context.cognitive1.search(query));
  handle(context, 'brain:update-field', async (update) => context.cognitive1.updateField(update));
  handle(context, 'brain:import', async () => importBrain(context));
  handle(context, 'brain:git-status', async () => brainGitStatus(await sharedBrainPath(context)));
  handle(context, 'brain:git-sync', async ({ action }) => syncBrainGit(await sharedBrainPath(context), action));
  handle(context, 'brain:mirror-now', async ({ dryRun }) => mirrorBrainNow(context, dryRun));
  handle(context, 'cognitive1:tool', async (request) => context.cognitive1.tool(request));
  handle(context, 'cognitive1:operation', async (request) => {
    try {
      return await context.cognitive1.operation(request);
    } catch (error) {
      if (!looksUnreachable(error)) throw error;
      // A daemon that stops answering without exiting is invisible to the restart policy, which only hears about a
      // process that died. Every read and write then fails — quietly, because the caller sees an empty result rather
      // than an error — and the brain looks empty instead of unreachable. The first failed call is the health check:
      // bring it back and ask once more. One retry only, so a genuinely broken endpoint cannot become a restart loop.
      context.logger.warn('service_error', 'Cognitive1 did not answer; restarting it and trying once more.', messageOf(error));
      await context.services.restart('cognitive1').catch((restartError: unknown) => {
        context.logger.error('service_error', 'Cognitive1 could not be restarted', messageOf(restartError));
      });
      return context.cognitive1.operation(request);
    }
  });
  handle(context, 'rules:get', async () => context.executionRules.document());
  handle(context, 'rules:save', async (rule) => context.executionRules.save(rule));
  handle(context, 'rules:inject-projects', async () => {
    const document = await context.executionRules.document();
    const projects = await context.projects.list();
    return {
      results: await injectRulesIntoProjects(
        document.markdown,
        document.path,
        projects.map((project) => ({ name: project.name || project.path, path: project.path })),
      ),
    };
  });
  handle(context, 'skills:list', async ({ projectId }) => listSkills(context, projectId));
  handle(context, 'skills:bundle-content', async ({ projectId, names }) => {
    const project = await resolveProject(context, projectId, true);
    return readCapabilityBundleSkills(project.path, names);
  });
  handle(context, 'files:choose', async ({ projectId }) => chooseProjectFiles(context, projectId));
  handle(context, 'files:search', async ({ projectId, query }) => searchProjectFiles(context, projectId, query));
  handle(context, 'permission-rules:suggest', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    const fromScripts = await suggestPermissionRules(await fs.realpath(project.path));
    // Also learn from what the user has already been asked: a command approved over and over becomes a rule to accept.
    const existing = (await context.preferences.get(project.id))?.automation?.permissionRules ?? [];
    const recent = (await context.conversations.listSummaries())
      .filter((summary) => summary.projectId === project.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30);
    const events = (await Promise.all(recent.map((summary) => context.conversations.get(summary.id).catch(() => null))))
      .flatMap((conversation) => conversation?.events ?? []);
    const seen = new Set(fromScripts.map((rule) => rule.id));
    const fromHistory = suggestHistoryRules(events as ApprovalLike[], [...existing, ...fromScripts])
      .map((suggestion) => suggestion.rule)
      .filter((rule) => !seen.has(rule.id));
    return [...fromScripts, ...fromHistory];
  });
  handle(context, 'context:git-diff', async ({ projectId }) => gitDiffForProject(context, projectId));
  handle(context, 'attachments:save', async ({ name, dataUrl }) => saveAttachment(context, name, dataUrl));
  handle(context, 'workflows:list-templates', async ({ projectId }) => context.workflowTemplates.list(projectId));
  handle(context, 'workflows:list-runs', async ({ projectId }) => context.workflows.list(projectId));
  handle(context, 'workflows:start', async (input, request) => context.workflows.start(input, request.ownerWindowId));
  handle(context, 'workflows:stop', async ({ workflowId }, request) => context.workflows.stop(workflowId, request.ownerWindowId));
  handle(context, 'workflows:resume', async ({ workflowId }, request) => context.workflows.resume(workflowId, request.ownerWindowId));
  handle(context, 'workflows:save-template', async (template) => context.workflowTemplates.save(template));
  handle(context, 'workflows:delete-template', async ({ id }) => context.workflowTemplates.delete(id));
  handle(context, 'crew:list', async ({ projectId }) => context.crew.list(projectId));
  handle(context, 'crew:start', async ({ projectId, goal, config, keepGoing, explainSimply }, request) => context.crew.start({ projectId, goal, config: config ?? createDefaultCrewConfig((await context.settings.load()).defaultAgent), ...(keepGoing !== undefined ? { keepGoing } : {}), ...(explainSimply !== undefined ? { explainSimply } : {}) }, request.ownerWindowId));
  handle(context, 'crew:interview', async ({ projectId, goal }) => context.crewInterview.run({ projectId, goal }));
  handle(context, 'crew:approve', async ({ runId }, request) => context.crew.approve(runId, request.ownerWindowId));
  handle(context, 'crew:answer', async ({ runId, answer, guidance }, request) => context.crew.answer(runId, answer, guidance, request.ownerWindowId));
  handle(context, 'crew:pause', async ({ runId }) => context.crew.pause(runId));
  handle(context, 'crew:resume', async ({ runId }, request) => context.crew.resume(runId, request.ownerWindowId));
  handle(context, 'crew:follow-up', async ({ runId, prompt }, request) => context.crew.followUp(runId, prompt, request.ownerWindowId));
  handle(context, 'crew:message', async ({ runId, kind, text }, request) => context.crew.message(runId, kind, text, request.ownerWindowId));
  handle(context, 'crew:away', async ({ runId, enabled, minutes, policy }, request) => context.crew.setAway(runId, enabled, minutes, request.ownerWindowId, policy));
  handle(context, 'crew:keep-going', async ({ runId, keepGoing }, request) => context.crew.setKeepGoing(runId, keepGoing, request.ownerWindowId));
  handle(context, 'crew:update-config', async ({ runId, config }) => context.crew.updateConfig(runId, config));
  handle(context, 'crew:stop-ask', async ({ runId }) => context.crew.stopAsk(runId));
  handle(context, 'crew:task-diff', async ({ runId, taskId }) => context.crew.taskDiff(runId, taskId));
  handle(context, 'crew:pause-after', async ({ runId, phase, on }) => context.crew.setPauseAfter(runId, phase, on));
  handle(context, 'crew:clear-notes', async ({ runId }) => context.crew.clearNotes(runId));
  handle(context, 'crew:accept-phase', async ({ runId, phase }) => context.crew.acceptPhase(runId, phase));
  handle(context, 'crew:revert-preview', async ({ runId, taskId }) => context.crew.previewRevert(runId, taskId));
  handle(context, 'crew:revert', async ({ runId, taskId }) => context.crew.revertTask(runId, taskId));
  handle(context, 'crew:decide', async ({ runId, approvalId, approve }, request) => context.crew.decide(runId, approvalId, approve, request.ownerWindowId));
  handle(context, 'crew:explain-simply', async ({ runId, explainSimply }) => context.crew.setExplainSimply(runId, explainSimply));
  handle(context, 'crew:find-phases', async ({ runId }, request) => context.crew.findPhases(runId, request.ownerWindowId));
  handle(context, 'crew:stop', async ({ runId }) => context.crew.stop(runId));
  handle(context, 'crew:defaults', async ({ projectId }) => context.crewSupport.defaults(projectId));
  handle(context, 'crew:save-defaults', async ({ projectId, config }) => context.crewSupport.saveDefaults(projectId, config));
  handle(context, 'conventions:get', async ({ refresh }) => context.conventions.state(refresh));
  handle(context, 'conventions:reference', async ({ path: projectPath, reference }) => context.conventions.setReference(projectPath, reference));
  handle(context, 'conventions:rule-add', async ({ text }) => context.conventions.addRule(text));
  handle(context, 'conventions:rule-remove', async ({ id }) => context.conventions.removeRule(id));
  handle(context, 'conventions:mute', async ({ key, muted }) => context.conventions.setMuted(key, muted));
  handle(context, 'conventions:seen', async () => context.conventions.markSeen());
  handle(context, 'design-profiles:get', async ({ refresh }) => context.designProfiles.state(refresh));
  handle(context, 'design-profiles:approve', async ({ projectPath }) => context.designProfiles.approve(projectPath));
  handle(context, 'design-profiles:generate', async ({ projectPath }) => context.designProfiles.generateDraft(projectPath));
  handle(context, 'crew:design', async ({ launch }) => context.crewSupport.design(launch));
  handle(context, 'team:plan', async (input, request) => context.teamPlanner.plan(input, request.ownerWindowId));
  handle(context, 'team:plan-from-parts', async (input) => context.teamPlanner.planFromParts(input));
  handle(context, 'prompt-guide:readiness', async () => context.promptGuide.readiness());
  handle(context, 'prompt-guide:refine', async (input) => context.promptGuide.refine(input));
  handle(context, 'prompt-guide:refine-prompt', async (input) => context.promptGuide.refinePrompt(input));
  handle(context, 'equalizer:screens', async ({ projectId }) => context.equalizer.screens(projectId));
  handle(context, 'equalizer:run', async (input) => context.equalizer.run(input));
  handle(context, 'equalizer:image', async (input) => equalizerImage(context, input));
  handle(context, 'design:openpencil-status', async () => openPencilStatus(context));
  handle(context, 'design:openpencil-save', async (input) => saveOpenPencil(context, input));
  handle(context, 'design:openpencil-test', async () => testOpenPencil(context));
  handle(context, 'studio:readiness', async () => context.interview.readiness());
  handle(context, 'studio:projects-list', async () => context.interview.list());
  // Pointing a plan at a folder, or at none. The plan is otherwise stranded on whatever path it was linked to,
  // which is no help once that folder is renamed or moved.
  handle(context, 'studio:project-link', async ({ projectId, linkedProjectId }) => {
    const summary = await context.interview.setLinkedProject(projectId, linkedProjectId);
    await broadcastSharedState(context);
    return summary;
  });
  handle(context, 'studio:project-archive', async (input) => context.interview.setArchived(input));
  handle(context, 'studio:project-remove', async ({ projectId }) => {
    await context.interview.remove({ projectId });
    if (/^studio_(?:[0-9a-f]{32}|[0-9a-f-]{36})$/i.test(projectId)) {
      await removeProject(context, projectId, null);
      await fs.rm(path.join(context.paths.studio, 'projects', projectId), { recursive: true, force: true });
    }
    return null;
  });
  handle(context, 'studio:project-folder', async ({ projectId }, request) =>
    chooseStudioProjectFolder(context, projectId, request.session));
  handle(context, 'studio:project-launch', async ({ projectId, destination }) =>
    launchStudioProject(context, projectId, destination));
  handle(context, 'studio:interview-read', async ({ projectId }) => context.interview.read({ projectId }));
  handle(context, 'studio:interview-start', async (input) => context.interview.start(input));
  handle(context, 'studio:interview-answer', async (input) => context.interview.answer(input));
  handle(context, 'studio:interview-correct', async (input) => context.interview.correct(input));
  handle(context, 'studio:interview-assumption', async (input) => context.interview.assumption(input));
  handle(context, 'studio:interview-assumed-topics', async ({ projectId }) => context.interview.askAssumedTopics({ projectId }));
  handle(context, 'studio:interview-topic-ask', async (input) => context.interview.askTopic(input));
  handle(context, 'studio:interview-importance', async (input) => context.interview.setImportance(input));
  handle(context, 'studio:interview-finish', async ({ projectId }) => context.interview.finish({ projectId }));
  handle(context, 'studio:interview-confirm', async ({ projectId }) => context.interview.confirm({ projectId }));
  handle(context, 'studio:interview-reopen', async ({ projectId }) => context.interview.reopen({ projectId }));
  handle(context, 'studio:interview-reset', async ({ projectId }) => context.interview.reset({ projectId }));
  handle(context, 'studio:interview-extend', async ({ projectId }) => context.interview.extend({ projectId }));
  handle(context, 'studio:interview-resume', async ({ projectId }) => context.interview.resume({ projectId }));
  handle(context, 'studio:interview-draft', async (input) => context.interview.saveDraft(input));
  handle(context, 'studio:artifacts-read', async ({ projectId }) => context.studio.artifacts(projectId));
  handle(context, 'studio:artifacts-files', async ({ projectId }) => context.studio.files(projectId));
  handle(context, 'studio:artifacts-text', async ({ projectId, kind }) => context.studio.artifactText(projectId, kind));
  handle(context, 'studio:brief-export', async ({ projectId }, request) => {
    const brief = await context.studio.artifactText(projectId, 'brief');
    if (!brief?.trim()) throw new Error('This project does not have a brief to export yet.');
    const options = {
      title: 'Export project brief',
      buttonLabel: 'Export brief',
      defaultPath: 'project-brief.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const owner = BrowserWindow.fromId(request.ownerWindowId) ?? context.getMainWindow() ?? undefined;
    const selection = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return { canceled: true };
    await fs.writeFile(selection.filePath, brief.trimEnd() + '\n', 'utf8');
    return { canceled: false, path: selection.filePath };
  });
  handle(context, 'studio:artifacts-save', async ({ projectId, kind, content }) => context.studio.saveArtifact(projectId, kind, content));
  handle(context, 'studio:style-refs-read', async ({ projectId }) => context.styleReferences.list(projectId));
  handle(context, 'studio:style-refs-add', async ({ projectId, name, data }) => context.styleReferences.add(projectId, name, data));
  handle(context, 'studio:style-refs-remove', async ({ projectId, name }) => context.styleReferences.remove(projectId, name));
  handle(context, 'studio:style-refs-describe', async ({ projectId }) => context.styleReferences.describe(projectId));
  handle(context, 'studio:artifacts-generate', async ({ projectId, kind }) => context.studio.generate(projectId, kind));
  handle(context, 'studio:artifacts-generate-all', async ({ projectId }) => context.studio.generateAll(projectId));
  handle(context, 'studio:artifacts-generate-selected', async ({ projectId, kinds }) => context.studio.generateSelected(projectId, kinds));
  handle(context, 'studio:artifacts-mark-edited', async ({ projectId, kind }) => context.studio.markEdited(projectId, kind));
  handle(context, 'studio:board-read', async ({ projectId }) => context.studio.board(projectId));
  handle(context, 'studio:board-append', async (input) => {
    const result = await context.studio.addCards(input.projectId, input.cards, input.expectedRevision);
    announceBoard(context, input.projectId, result.board);
    return result;
  });
  handle(context, 'import:scan', async ({ projectId }) => scanProjectForImport(context, projectId));
  handle(context, 'import:add-cards', async ({ projectId, findingIds }) => {
    const report = await scanProjectForImport(context, projectId);
    const picked = report.findings.filter((finding) => findingIds.includes(finding.id));
    if (picked.length === 0) throw new Error('None of those findings are in the project any more. Scan again.');
    const at = new Date().toISOString();
    const cards = picked.map((finding) => boardCardSchema.parse({
      id: importCardId(finding.id), title: finding.card.title, kind: finding.card.kind, story: finding.card.story,
      acceptance: finding.card.acceptance,
      prompt: [finding.card.title, '', finding.detail, '', 'Done when:', ...finding.card.acceptance.map((line) => `- ${line}`)].join('\n'),
      status: 'backlog', createdAt: at, updatedAt: at,
    }));
    const { board, added } = await context.studio.addCards(projectId, cards);
    announceBoard(context, projectId, board);
    return { added, report: { ...report, onBoard: board.cards.map((card) => card.id).filter((id) => id.startsWith('import-')).map((id) => id.slice('import-'.length)) } };
  });
  handle(context, 'studio:board-plan', async ({ projectId }) => announceBoard(context, projectId, await context.studio.plan(projectId)));
  // Arranging rewrites the order of an existing board, so every window is told, not only the one that asked.
  handle(context, 'studio:board-arrange', async ({ projectId }) => announceBoard(context, projectId, await context.studio.arrange(projectId)));
  handle(context, 'studio:board-next', async ({ projectId }) => context.studio.next(projectId));
  handle(context, 'studio:board-move', async (input) => {
    const card = await context.studio.move(input.projectId, input.cardId, input.status, input.note);
    announceBoard(context, input.projectId, await context.studio.board(input.projectId));
    return card;
  });
  handle(context, 'studio:board-review', async ({ projectId, cardId, verdict }) => {
    const card = await context.studio.reviewBoardCard(projectId, cardId, verdict);
    announceBoard(context, projectId, await context.studio.board(projectId));
    return card;
  });
  handle(context, 'studio:board-acceptance-rule', async ({ projectId, required }) => {
    const board = await context.studio.setBoardAcceptanceRequired(projectId, required);
    announceBoard(context, projectId, board);
    return board;
  });
  handle(context, 'studio:board-route', async (input) => {
    const card = input.notAScreen ? await context.studio.markCardNotAScreen(input.projectId, input.cardId) : await context.studio.setCardRoute(input.projectId, input.cardId, input.route);
    announceBoard(context, input.projectId, await context.studio.board(input.projectId));
    return card;
  });
  handle(context, 'studio:board-repair-routes', async ({ projectId }) => context.studio.suggestRouteRepairs(projectId));
  handle(context, 'studio:board-claim', async (input) => {
    const card = await context.studio.claim(input.projectId, input.cardId, input.agent);
    announceBoard(context, input.projectId, await context.studio.board(input.projectId));
    return card;
  });
  handle(context, 'studio:board-check-ui', async ({ projectId, cardId }) => {
    const checked = await context.studio.checkUi(projectId, cardId);
    announceBoard(context, projectId, await context.studio.board(projectId));
    return checked;
  });
  // Both of these run agents, so the window that asked owns the run and sees its events.
  handle(context, 'studio:board-team-plan', async ({ projectId }) => context.teamPlanner.planFromBoard(projectId));
  handle(context, 'studio:board-work', async ({ projectId, maxCards, agent, model }, request) => {
    const worked = await context.teamPlanner.workBoard(projectId, request.ownerWindowId, {
      maxCards,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    });
    announceBoard(context, projectId, await context.studio.board(projectId));
    return worked;
  });
  // Reading the guide never calls a provider, so the board's strip can ask on every redraw. Explaining spends, and
  // only when the stored explanation no longer fits — see `DesktopGuideService`.
  handle(context, 'studio:guide-read', async ({ projectId }) => context.guide.read(projectId));
  handle(context, 'studio:guide-explain', async ({ projectId }) => context.guide.explain(projectId));
  // The code flavour of the same thing: its steps come from the repository and the files rather than from a plan, so
  // a project that has never been near the Studio still has somewhere to be told it is.
  handle(context, 'code:guide-read', async ({ projectId }) => context.codeGuide.read(projectId));
  handle(context, 'code:guide-explain', async ({ projectId }) => context.codeGuide.explain(projectId));
  handle(context, 'autopilot:start', async (input, request) => context.autopilot.start(input, request.ownerWindowId));
  handle(context, 'autopilot:stop', async ({ projectId }) => context.autopilot.stop(projectId));
  handle(context, 'autopilot:status', async ({ projectId }) => context.autopilot.status(projectId));
  handle(context, 'autopilot:requeue', async ({ projectId }) => ({ requeued: await context.autopilot.requeueBlocked(projectId) }));
  handle(context, 'autopilot:interrupted', async () => context.autopilot.interrupted());
  handle(context, 'autopilot:audit', async ({ projectId }) => context.autopilot.audit(projectId));
  handle(context, 'autopilot:interrupted-resume', async ({ studioProjectId }, request) => context.autopilot.resumeInterrupted(studioProjectId, request.ownerWindowId));
  handle(context, 'autopilot:interrupted-release', async ({ studioProjectId }) => ({ released: await context.autopilot.releaseInterrupted(studioProjectId) }));
  handle(context, 'auto:start', async (input, request) => context.auto.start(input, request.ownerWindowId));
  handle(context, 'auto:stop', async ({ conversationId }) => context.auto.stop(conversationId));
  handle(context, 'auto:status', async ({ conversationId }) => context.auto.status(conversationId));
  handle(context, 'auto:pause', async ({ conversationId }) => context.auto.pause(conversationId));
  handle(context, 'auto:resume', async ({ conversationId }) => context.auto.resume(conversationId));
  handle(context, 'architect:run', async (input, request) => context.architect.start(input, request.ownerWindowId));
  handle(context, 'architect:stop', async ({ conversationId }) => context.architect.stop(conversationId));
  handle(context, 'architect:handoff', async ({ conversationId }) => context.architect.handoff(conversationId));
  handle(context, 'architect:answer', async ({ conversationId, carryOn }) => context.architect.answer(conversationId, carryOn));
  handle(context, 'architect:status', async ({ conversationId }) => context.architect.status(conversationId));
  handle(context, 'architect:ready', async ({ target }) => context.architectReadiness(target));
  handle(context, 'studio:design-read', async ({ projectId }) => context.studio.design(projectId));
  handle(context, 'studio:design-status', async ({ projectId }) => context.studio.designStatus(projectId));
  handle(context, 'studio:design-pull', async ({ projectId, adopt }) => {
    const pulled = await context.studio.pullDesign(projectId, { adopt });
    announceBoard(context, projectId, pulled.board);
    return pulled;
  });
  handle(context, 'studio:design-build-cancel', async ({ stepId }) => context.studio.cancelDesignStep(stepId));
  // Both write to open-pencil and to `.kai/spec`, so every window is told the board moved, not only the one that asked.
  handle(context, 'studio:design-page-rename', async ({ projectId, currentName, name }) => {
    const pulled = await context.studio.renameDesignPage(projectId, currentName, name);
    announceBoard(context, projectId, pulled.board);
    return pulled;
  });
  handle(context, 'studio:design-page-delete', async ({ projectId, pageId }) => {
    const pulled = await context.studio.deleteDesignPage(projectId, pageId);
    announceBoard(context, projectId, pulled.board);
    return pulled;
  });
  handle(context, 'studio:design-build-step', async ({ projectId, prompt, stepId }, request) =>
    context.studio.buildDesignStep(projectId, prompt, stepId, (event) => {
      const payload = { conversationId: stepId, event } satisfies AgentRunEvent;
      if (context.windows.send(request.ownerWindowId, 'agents:event', payload)) return;
      context.windows.broadcast('agents:event', payload);
    }));
  handle(context, 'studio:plan-chat', async ({ projectId, message, intent }) =>
    context.studio.planChat(projectId, message, intent, (stage) => {
      context.windows.broadcast('studio:plan-progress', { projectId, stage });
    }));
  handle(context, 'studio:plan-apply', async ({ projectId, actions }) => {
    const applied = await context.studio.applyPlanActions(projectId, actions);
    announceBoard(context, projectId, applied.board);
    return applied;
  });
  handle(context, 'studio:design-chat', async ({ projectId, message, imageDataUrl, stepId, pageName }, request) =>
    context.studio.chatDesign(projectId, message, imageDataUrl, stepId, (event) => {
      const payload = { conversationId: stepId, event } satisfies AgentRunEvent;
      if (context.windows.send(request.ownerWindowId, 'agents:event', payload)) return;
      context.windows.broadcast('agents:event', payload);
    }, pageName));
  handle(context, 'studio:design-screenshot', async ({ projectId, pageId }) => context.studio.capturePageScreenshot(projectId, pageId));
  handle(context, 'team:start', async (input, request) => context.teamPlanner.start(input, request.ownerWindowId));
  handle(context, 'team:record', async (input) => context.teamPlanner.advice(input));
  handle(context, 'team:clear-record', async () => { await context.teamRecord.clear(); return null; });
  handle(context, 'schedules:list', async ({ projectId }) => context.scheduler.list(projectId));
  handle(context, 'schedules:save', async (input) => {
    await resolveProject(context, input.projectId, true);
    return context.scheduler.save(input);
  });
  handle(context, 'schedules:delete', async ({ id }) => ({ deleted: await context.scheduler.remove(id) }));
  handle(context, 'schedules:run-now', async ({ id }) => context.scheduler.runNow(id));
  handle(context, 'evals:list', async ({ projectId }) => context.evals.overview(projectId));
  handle(context, 'evals:save-case', async (input) => context.evals.saveCase(input));
  handle(context, 'evals:delete-case', async ({ projectId, caseId }) => ({ deleted: await context.evals.deleteCase(projectId, caseId) }));
  handle(context, 'evals:run', async (input) => context.evals.run(input));
  handle(context, 'scorecards:summary', async () => summarizeScores(await context.runScores.list()));
  handle(context, 'proxy:overview', async () => context.proxy.overview());
  handle(context, 'proxy:history', async (query) => context.proxy.history(query));
  handle(context, 'proxy:history-detail', async ({ id }) => context.proxy.historyDetail(id));
  handle(context, 'proxy:clear-history', async () => context.proxy.clearHistory());
  handle(context, 'proxy:test-connection', async ({ agent }) => context.proxy.testConnection(agent));
  handle(context, 'proxy:ping-all', async () => context.proxy.pingAll());
  handle(context, 'proxy:dry-run', async ({ body }) => context.proxy.dryRun(body));
  handle(context, 'proxy:clear-costs', async () => context.proxy.clearCosts());
  handle(context, 'proxy:cost-summary', async ({ period }) => context.cognitive1.costSummary(period));
  handle(context, 'proxy:replay-preview', async ({ id }) => context.proxy.replayPreview(id));
  handle(context, 'proxy:replay', async ({ id }) => context.proxy.replay(id));
  handle(context, 'proxy:models', async () => context.proxy.models());
  handle(context, 'proxy:routes', async () => context.proxyRouting.routes());
  handle(context, 'proxy:route-action', async ({ agent, action, routeUntil }) => {
    const result = await context.proxyRouting.action(agent, action, routeUntil);
    await broadcastSharedState(context);
    return result;
  });
  handle(context, 'proxy:export-config', async () => exportProxyConfig(context));
  handle(context, 'proxy:import-config', async () => importProxyConfig(context));
  handle(context, 'proxy:copy-env', async ({ agent }) => copyProxyEnv(context, agent ?? 'claude'));
  handle(context, 'proxy:launch-agent', async ({ agent }) => launchProxyAgent(context, agent));
  handle(context, 'proxy:reset-claude', async () => resetClaudeCodeConfig());
  handle(context, 'proxy:open-claude-settings', async () => {
    const settingsPath = await ensureClaudeSettingsFile();
    const error = await shell.openPath(settingsPath);
    return {
      opened: !error,
      path: settingsPath,
      detail: error || `Opened ${settingsPath}.`,
    };
  });
  handle(context, 'proxy:start-live-tail', async () => startProxyLiveTail(context));
  handle(context, 'proxy:stop-live-tail', async () => stopProxyLiveTail(context));
  handle(context, 'preferences:get', async ({ projectId }) => context.preferences.get(projectId));
  handle(context, 'preferences:update', async (preferences) => {
    await context.preferences.upsert(preferences);
    return preferences;
  });
  handle(context, 'credentials:status', async () => credentialStatus(context));
  handle(context, 'credentials:set', async ({ id, value }) => {
    await context.credentials.set(id, value);
    await context.mcp.invalidateCredential(id);
    await restartCognitive1ForOverwatchCredential(context, id);
    const status = await credentialStatus(context);
    await broadcastSharedState(context);
    return status;
  });
  handle(context, 'credentials:clear', async ({ id }) => {
    await context.credentials.delete(id);
    await context.mcp.invalidateCredential(id);
    await restartCognitive1ForOverwatchCredential(context, id);
    const status = await credentialStatus(context);
    await broadcastSharedState(context);
    return status;
  });
  handle(context, 'conversations:list', async () => context.conversations.listSummaries());
  handle(context, 'composer-queue:load', async ({ legacy }) => {
    const queue = await context.composerQueue.loadOrMigrate(legacy);
    context.windows.broadcast('app:composer-queue-changed', queue);
    return queue;
  });
  handle(context, 'composer-queue:add', async ({ item, first }) => {
    const queue = await context.composerQueue.add(item, first);
    context.windows.broadcast('app:composer-queue-changed', queue);
    return queue;
  });
  handle(context, 'composer-queue:claim', async ({ conversationId, id }) => {
    const result = await context.composerQueue.claim(conversationId, id);
    if (result.claimed) context.windows.broadcast('app:composer-queue-changed', result.queue);
    return result;
  });
  handle(context, 'composer-queue:update', async ({ conversationId, id, action, error }) => {
    const queue = await context.composerQueue.update(conversationId, id, action, error);
    context.windows.broadcast('app:composer-queue-changed', queue);
    return queue;
  });
  handle(context, 'composer-queue:hold-all', async ({ error }) => {
    const queue = await context.composerQueue.holdAll(error);
    context.windows.broadcast('app:composer-queue-changed', queue);
    return queue;
  });
  handle(context, 'composer-queue:remove-conversation', async ({ conversationId }) => {
    const queue = await context.composerQueue.removeConversation(conversationId);
    context.windows.broadcast('app:composer-queue-changed', queue);
    return queue;
  });
  handle(context, 'prompt-presets:list', async () => context.promptPresets.list());
  handle(context, 'prompt-presets:save', async ({ slot, label, text }) => context.promptPresets.save({ slot, label, text }));
  handle(context, 'prompt-presets:delete', async ({ slot }) => context.promptPresets.delete(slot));
  handle(context, 'conversations:get', async ({ id }) => context.conversations.get(id));
  handle(context, 'conversations:create', async ({ projectId, firstPrompt, origin }, request) => {
    if (request.session && request.session.projectId !== projectId) {
      throw new Error('This window can create conversations only for its open project. Open the project in this window first.');
    }
    if (origin && origin.projectId !== projectId) throw new Error('Lead chat must belong to its project.');
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      ...(origin ? { origin } : {}),
      schemaVersion: 1,
      id: `conv_${crypto.randomUUID()}`,
      projectId,
      title: firstPrompt.trim() ? titleFromPrompt(firstPrompt) : 'New conversation',
      createdAt: now,
      updatedAt: now,
      archived: false,
      unread: false,
      activeAgent: null,
      route: null,
      autonomy: null,
      turns: [],
      events: [],
    };
    await context.conversations.save(conversation);
    if (request.session && isWorkspaceConversation(conversation)) request.session.conversationId = conversation.id;
    return conversation;
  });
  handle(context, 'conversations:compact', async ({ conversationId, beforeNextRun }) => {
    if (!beforeNextRun) return compactConversation(context, conversationId);
    // Asked while a run is going: it is done just before this conversation's next request starts.
    const conversation = await context.conversations.get(conversationId);
    if (!conversation) throw new NotFoundError('Conversation not found.');
    compactBeforeNextRun.add(conversationId);
    return conversation;
  });
  handle(context, 'conversations:save', async (conversation, request) => {
    if (request.session && request.session.projectId !== conversation.projectId) {
      throw new Error('This window can save conversations only for its open project. Open the project in this window first.');
    }
    await context.conversations.save(conversation);
    if (request.session && isWorkspaceConversation(conversation)) request.session.conversationId = conversation.id;
    return conversation;
  });
  handle(context, 'conversations:fork', async (input) => {
    const result = await forkConversation(context, input);
    context.windows.broadcast('app:conversation-changed', { conversationId: result.conversation.id });
    return result;
  });
  handle(context, 'conversations:rewind', async (input) => {
    const result = await rewindConversation(context, input);
    context.windows.broadcast('app:conversation-changed', { conversationId: result.conversation.id });
    return result;
  });
  handle(context, 'conversations:delete', async ({ id }) => {
    const conversation = await context.conversations.get(id);
    if (conversation) {
      await finishMemorySession(context, id, `Session closed when conversation "${conversation.title}" was deleted.`);
    }
    await context.conversations.remove(id);
    const queue = await context.composerQueue.removeConversation(id);
    context.windows.broadcast('app:composer-queue-changed', queue);
  });
  handle(context, 'checkpoints:review', async ({ conversationId, turnId }) => reviewCheckpoint(context, conversationId, turnId));
  handle(context, 'checkpoints:reject', async ({ conversationId, turnId, filePath }) => rejectCheckpointFile(context, conversationId, turnId, filePath));
  handle(context, 'checkpoints:restore', async ({ conversationId, turnId }) => restoreConversationCheckpoint(context, conversationId, turnId));
  handle(context, 'compare:start', async (request) => startCompare(context, request));
  handle(context, 'compare:pick', async ({ id, side }) => pickCompareWinner(context, id, side));
  handle(context, 'compare:discard', async ({ id }) => discardCompare(context, id));
  handle(context, 'compare:open', async ({ id, side }) => openCompareWorktree(context, id, side));
  handle(context, 'backups:list', async () => context.backups.list());
  handle(context, 'backups:create', async ({ name }) => context.backups.create(name));
  handle(context, 'backups:restore', async ({ id }) => {
    await context.backups.restore(id);
    const settings = await context.settings.load();
    await context.services.syncFromSettings(settings);
    await broadcastSharedState(context);
    return { restored: true };
  });
  handle(context, 'backups:delete', async ({ id }) => {
    await context.backups.delete(id);
    return { deleted: true };
  });
  handle(context, 'agents:capabilities', async () => context.agents.capabilities());
  handle(context, 'agents:api-capability', async () => context.directApi.capability());
  handle(context, 'context:preview', async ({ projectId, conversationId }) => {
    const project = (await context.projects.list()).find((item) => item.id === projectId);
    if (!project) throw new NotFoundError('Project not found.');
    const conversation = conversationId ? await context.conversations.get(conversationId) : null;
    const prompt = [...(conversation?.turns ?? [])]
      .reverse()
      .find((turn) => turn.role === 'user')
      ?.text ?? '';
    // The panel describes what a run would be sent. It was built without the standing rules, so it read "Instructions:
    // None" for every project while the runs themselves did carry them, which looked exactly like rules being ignored.
    let rules = await context.executionRules.read().catch(() => '');
    if (rules && conversation?.origin?.kind === 'autopilot') rules = withAutopilotException(rules);
    return (await buildConversationContext(context, project.path, project.name, project.id, conversation, prompt, rules)).preview;
  });
  handle(context, 'preview:info', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    return context.preview.info(project.path);
  });
  handle(context, 'preview:status', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    return context.preview.status(project.id, project.path);
  });
  handle(context, 'preview:start', async ({ projectId, command }) => {
    const project = await resolveProject(context, projectId, true);
    return context.preview.start(project.id, project.path, command);
  });
  handle(context, 'preview:stop', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    return context.preview.stop(project.id, project.path);
  });
  handle(context, 'agents:run', async (request, ipcRequest) => runInteractiveAgent(context, request, ipcRequest.ownerWindowId));
  // Saying something to a run already going, rather than waiting for it to end or cancelling it. It reaches the
  // agent at its next turn, so it answers or takes the correction and carries on.
  handle(context, 'agents:interject', async ({ conversationId, text, contextChips }) => {
    if (!canInterject(conversationId)) return { queued: false };
    return { queued: await interject(conversationId, text, await interjectionExtras(context, conversationId, contextChips ?? [])) };
  });
  handle(context, 'agents:cancel', async ({ conversationId }) => cancelAgent(context, conversationId));
  handle(context, 'agents:pause', async ({ conversationId }) => context.runControl.pause(conversationId));
  handle(context, 'agents:resume', async ({ conversationId }) => context.runControl.resume(conversationId));
  handle(context, 'agents:sign-in', async ({ agent }) => context.agents.signIn(agent));
  handle(context, 'agents:install', async ({ agent }) => context.agents.install(agent));
  handle(context, 'agents:approval-response', async ({ conversationId, requestId, approved, answer }, request) => {
    const pending = context.pendingApprovals.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return false;
    if (pending.ownerWindowId !== null && pending.ownerWindowId !== request.ownerWindowId) return false;
    context.pendingApprovals.delete(requestId);
    pending.resolve({ approved, answer });
    return true;
  });
  handle(context, 'usage:summary', async ({ conversationId }) =>
    summarizeUsageFromRuns(await paidRunsFor(context), (await context.settings.load()).usageBudget, new Date(), conversationId));
  handle(context, 'ui:report-view', async ({ view, conversationId }, request) => {
    const owner = request.ownerWindowId;
    const session = context.windows.get(owner);
    const viewedConversation = conversationId ? await context.conversations.get(conversationId) : null;
    if (session) {
      session.view = view;
      if (!viewedConversation || isWorkspaceConversation(viewedConversation)) session.conversationId = conversationId;
    }
    context.notifications.setViewing(owner, view, conversationId);
    return true;
  });
  handle(context, 'files:tree', async ({ projectId }) => listProjectFiles((await resolveProject(context, projectId, true)).path));
  const leadEditsStore = (request: IpcRequestContext): LeadEditStore => ({
    get: async (id) => {
      const record = await context.conversations.get(id);
      if (record && request.session && request.session.projectId !== record.projectId) throw new Error('Open the owning project in this window before editing.');
      return record;
    },
    save: async (record) => { await context.conversations.save(record); context.windows.broadcast('app:conversation-changed', { conversationId: record.id }); },
    list: () => context.conversations.list(),
    runs: (id) => context.verification.list(id),
    root: async (id) => { if (request.session && request.session.projectId !== id) throw new Error('The open project changed. Review this edit in its owning project.'); return (await resolveProject(context, id, true)).path; },
  });
  handle(context, 'lead:prepare-edit', async ({ conversationId, turnId }, request) => prepareLeadEdit(leadEditsStore(request), conversationId, turnId));
  handle(context, 'lead:decide-edit', async ({ conversationId, proposalId, action }, request) => decideLeadEdit(leadEditsStore(request), conversationId, proposalId, action));
  handle(context, 'files:read', async ({ projectId, path: filePath }) => readProjectFile((await resolveProject(context, projectId, true)).path, filePath));
  handle(context, 'files:image', async ({ projectId, path: filePath }) => readProjectImage((await resolveProject(context, projectId, true)).path, filePath));
  handle(context, 'mockup:inline', async ({ html }) => publishInlineMockup(html));
  handle(context, 'mockup:file', async ({ projectId, path: filePath }) => publishProjectMockup((await resolveProject(context, projectId, true)).path, filePath));
  handle(context, 'files:write', async ({ projectId, path: filePath, content, expectedHash, eol, bom }) => {
    try {
      return await writeProjectFile((await resolveProject(context, projectId, true)).path, filePath, content, { expectedHash, eol, bom });
    } catch (error) {
      if (error instanceof FileConflictError) throw new ConflictError(error.message);
      throw error;
    }
  });
  handle(context, 'files:delete', async ({ projectId, path: filePath }) => {
    await deleteProjectPath((await resolveProject(context, projectId, true)).path, filePath);
    return { path: filePath };
  });
  handle(context, 'files:rename', async ({ projectId, from, to }) => {
    await renameProjectPath((await resolveProject(context, projectId, true)).path, from, to);
    return { path: to };
  });
  handle(context, 'files:folder', async ({ projectId, path: filePath }) => {
    await createProjectFolder((await resolveProject(context, projectId, true)).path, filePath);
    return { path: filePath };
  });
  handle(context, 'files:reveal', async ({ projectId, path: filePath }) => {
    const project = await resolveProject(context, projectId, true);
    shell.showItemInFolder(await resolveInside(project.path, filePath));
    return { revealed: true };
  });
  handle(context, 'files:changed', async ({ projectId, path: filePath, expectedHash }) =>
    fileChangedOnDisk((await resolveProject(context, projectId, true)).path, filePath, expectedHash));
  handle(context, 'editor:update-document', async (document, request) => {
    if (request.ownerWindowId !== null) context.editorSessions.update(request.ownerWindowId, document);
    return true;
  });
  handle(context, 'editor:remove-document', async ({ projectId, path: filePath }, request) => {
    if (request.ownerWindowId !== null) context.editorSessions.remove(request.ownerWindowId, projectId, filePath);
    return true;
  });
  handle(context, 'editor:update-window', async (snapshot, request) => {
    if (request.ownerWindowId !== null) context.editorSessions.updateWindow(request.ownerWindowId, snapshot);
    return true;
  });
  handle(context, 'learning:progress', async ({ projectId }): Promise<LearningProgress> => {
    await resolveProject(context, projectId, true);
    return context.learningProgress.get(projectId);
  });
  handle(context, 'learning:understood', async ({ projectId, lessonId }) => {
    await resolveProject(context, projectId, true);
    return context.learningProgress.markUnderstood(projectId, lessonId);
  });
  handle(context, 'learning:record-check-evidence', async (input) => {
    await resolveProject(context, input.projectId, true);
    return context.learningProgress.recordCheckEvidence(input);
  });
  handle(context, 'learning:explain-back', async ({ projectId, lessonId, question, answer }): Promise<LearningExplainBackResult> => {
    await resolveProject(context, projectId, true);
    const lesson = (await context.learningProgress.get(projectId)).lessons?.find((candidate) => candidate.id === lessonId);
    if (!lesson) throw new Error('This lesson is no longer available.');
    const settings = await context.settings.load();
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const reservation = context.learningBudget.reserve({
      projectId,
      provider: readiness.provider,
      model: readiness.model,
      paidRuns: await conversationPaidRuns(context),
      budget: settings.usageBudget,
      estimatedInputTokens: Math.ceil((JSON.stringify(lesson.response).length + question.length + answer.length) / 4) + 600,
      estimatedOutputTokens: 1_000,
      externalRuns: await context.learningUsage.runs(),
    });
    if (reservation.blockedReason) {
      throw new Error(`${reservation.blockedReason} Raise the limit or switch to warn mode in Settings to continue.`);
    }
    try {
      const detailed = await context.learningTutor.gradeExplanationDetailed(lesson.response, question, answer);
      await context.learningUsage.record({
        projectId,
        provider: readiness.provider,
        model: readiness.model,
        usage: detailed.usage,
      });
      const progress = await context.learningProgress.recordExplanation(projectId, lessonId, question, detailed.grade);
      return { grade: detailed.grade, progress };
    } finally {
      context.learningBudget.release(reservation.id);
    }
  });
  // Help with the question is not graded and records no progress: seeing an answer is not evidence of learning it.
  handle(context, 'learning:explain-back-help', async ({ projectId, lessonId, question, kind }): Promise<LearningExplainBackHelp> => {
    await resolveProject(context, projectId, true);
    const lesson = (await context.learningProgress.get(projectId)).lessons?.find((candidate) => candidate.id === lessonId);
    if (!lesson) throw new Error('This lesson is no longer available.');
    const settings = await context.settings.load();
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const reservation = context.learningBudget.reserve({
      projectId,
      provider: readiness.provider,
      model: readiness.model,
      paidRuns: await conversationPaidRuns(context),
      budget: settings.usageBudget,
      estimatedInputTokens: Math.ceil((JSON.stringify(lesson.response).length + question.length) / 4) + 500,
      estimatedOutputTokens: 800,
      externalRuns: await context.learningUsage.runs(),
    });
    if (reservation.blockedReason) {
      throw new Error(`${reservation.blockedReason} Raise the limit or switch to warn mode in Settings to continue.`);
    }
    try {
      const detailed = await context.learningTutor.explainBackHelpDetailed(lesson.response, question, kind);
      await context.learningUsage.record({ projectId, provider: readiness.provider, model: readiness.model, usage: detailed.usage });
      return detailed.help;
    } finally {
      context.learningBudget.release(reservation.id);
    }
  });
  handle(context, 'learning:readiness', async () => context.learningTutor.readiness());
  handle(context, 'learning:update-preferences', async (input): Promise<LearningProgress> => {
    await resolveProject(context, input.projectId, true);
    return context.learningProgress.updatePreferences(input);
  });
  handle(context, 'learning:cancel', async ({ requestId }, ipcRequest) => {
    const active = tutorRequests.get(requestId);
    if (!active || active.ownerWindowId !== ipcRequest.ownerWindowId) return false;
    active.controller.abort();
    return true;
  });
  handle(context, 'learning:evaluate', async (request, ipcRequest): Promise<LearningEvaluationResult> => {
    const controller = new AbortController();
    if (request.requestId) tutorRequests.set(request.requestId, { controller, ownerWindowId: ipcRequest.ownerWindowId });
    try {
      await resolveProject(context, request.projectId, true);
      const settings = await context.settings.load();
      const readiness = await context.learningTutor.readiness();
      if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
      const estimatedInputTokens = Math.ceil((request.code.length + (request.completionContext?.prefix.length ?? 0) + (request.completionContext?.suffix.length ?? 0) + (request.selectedText?.length ?? 0) + (request.question?.length ?? 0) + (request.conversationContext?.length ?? 0)) / 4) + 1_500;
      const reservation = context.learningBudget.reserve({
        projectId: request.projectId,
        provider: readiness.provider,
        model: readiness.model,
        paidRuns: await conversationPaidRuns(context),
        budget: settings.usageBudget,
        estimatedInputTokens,
        estimatedOutputTokens: 6_000,
        externalRuns: await context.learningUsage.runs(),
      });
      if (reservation.blockedReason) {
        throw new Error(`${reservation.blockedReason} Raise the limit or switch to warn mode in Settings to continue.`);
      }
      try {
        const remembered = await context.learningProgress.get(request.projectId);
        controller.signal.throwIfAborted();
        const detailed = await context.learningTutor.evaluateDetailed(request, JSON.stringify({ memory: remembered.memory, concepts: remembered.concepts.slice(0, 20) }), controller.signal);
        controller.signal.throwIfAborted();
        await context.learningUsage.record({
          projectId: request.projectId,
          provider: readiness.provider,
          model: readiness.model,
          usage: detailed.usage,
        });
        controller.signal.throwIfAborted();
        const progress = request.completionContext ? await context.learningProgress.get(request.projectId) : await context.learningProgress.recordEvaluation(request, detailed.response);
        return { response: detailed.response, progress, usage: detailed.usage };
      } finally {
        context.learningBudget.release(reservation.id);
      }
    } finally {
      if (request.requestId) tutorRequests.delete(request.requestId);
    }
  });
  handle(context, 'learning:record-lesson', async (input): Promise<LearningLessonRecordResult> => {
    const project = await resolveProject(context, input.projectId, true);
    return recordLearningLesson(project.path, input);
  });
  handle(context, 'learning:teaching-library', async () => context.teachingLibrary.get());
  handle(context, 'learning:save-teaching-entry', async (input) => context.teachingLibrary.save(input));
  handle(context, 'learning:delete-teaching-entry', async ({ kind, id }) => context.teachingLibrary.remove(kind, id));
  handle(context, 'learning:reset-teaching-entry', async ({ kind, id }) => context.teachingLibrary.reset(kind, id));
  handle(context, 'learning:security-findings', async () => context.securityFindings.list());
  handle(context, 'learning:save-security-finding', async (input) => context.securityFindings.add(input));
  handle(context, 'learning:update-security-finding-status', async (input) => context.securityFindings.updateStatus(input));
  handle(context, 'learning:security-scan', async (input, request) => runSecurityScan(context, input, request.ownerWindowId));
  handle(context, 'brain:review-memory', async (input, request) => reviewProjectMemory(context, input, request.ownerWindowId));
  handle(context, 'learning:generate-teaching-draft', async (input, request) => {
    const settings = await context.settings.load();
    const learningProjectId = request.session
      ? request.session.projectId ?? 'learning-library'
      : settings.activeProjectId ?? 'learning-library';
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const reservation = context.learningBudget.reserve({
      projectId: learningProjectId,
      provider: readiness.provider,
      model: readiness.model,
      paidRuns: await conversationPaidRuns(context),
      budget: settings.usageBudget,
      estimatedInputTokens: Math.ceil((input.topic.length + (input.instructions?.length ?? 0) + (input.baseContent?.length ?? 0)) / 4) + 2_000,
      estimatedOutputTokens: 6_000,
      externalRuns: await context.learningUsage.runs(),
    });
    if (reservation.blockedReason) {
      throw new Error(`${reservation.blockedReason} Raise the limit or switch to warn mode in Settings to continue.`);
    }
    try {
      const detailed = await context.learningTutor.generateTeachingDraftDetailed(input);
      await context.learningUsage.record({
        projectId: learningProjectId,
        provider: readiness.provider,
        model: readiness.model,
        usage: detailed.usage,
      });
      return detailed.draft;
    } finally {
      context.learningBudget.release(reservation.id);
    }
  });
  handle(context, 'code:format', async ({ projectId, filePath, content }): Promise<CodeFormatResult> => {
    const project = await resolveProject(context, projectId, true);
    return formatProjectCode(project.path, filePath, content, context.paths.root);
  });
  handle(context, 'code:install-formatter', async ({ projectId }) => {
    await resolveProject(context, projectId, true);
    return installRuffFormatter(context.paths.root);
  });
  handle(context, 'git:file-info', async ({ projectId, path: filePath }): Promise<GitFileInfo> => {
    const project = await resolveProject(context, projectId, true);
    return projectGitFileInfo(project.path, filePath);
  });
  handle(context, 'checkpoints:reject-hunks', async ({ conversationId, turnId, filePath, hunkIds }) =>
    rejectCheckpointHunks(context, conversationId, turnId, filePath, hunkIds));
  handle(context, 'coordination:overview', async () => coordinationOverview(context));
  handle(context, 'coordination:preflight', async ({ projectId, files }) => coordinationPreflight(context, projectId, files));
  handle(context, 'search:global', async ({ query }) => globalSearch(context, query));
  const projectPath = async (projectId: string): Promise<string> => (await resolveProject(context, projectId, true)).path;
  handle(context, 'updates:state', async () => context.updater.getState());
  handle(context, 'updates:check', async () => context.updater.check());
  handle(context, 'updates:download', async () => context.updater.download());
  // Installing restarts the app; the controller backs up the configuration first and refuses if that fails.
  handle(context, 'updates:install', async () => context.updater.installAndRestart());
  handle(context, 'setup:status', async () => currentSetupStatus(context));
  handle(context, 'setup:complete', async ({ complete }) => {
    const completedAt = complete ? new Date().toISOString() : null;
    const settings = await context.settings.load();
    await context.settings.save({ ...settings, setupCompletedAt: completedAt });
    await broadcastSharedState(context);
    return currentSetupStatus(context);
  });
  handle(context, 'terminal:start', async ({ projectId, shell, cols, rows }, request) =>
    context.terminal.start(projectId, await projectPath(projectId), shell, cols, rows, request.ownerWindowId));
  handle(context, 'terminal:write', async ({ id, data }) => context.terminal.write(id, data));
  handle(context, 'terminal:resize', async ({ id, cols, rows }) => context.terminal.resize(id, cols, rows));
  handle(context, 'terminal:stop', async ({ id }) => context.terminal.stop(id));
  handle(context, 'terminal:buffer', async ({ id }) => context.terminal.buffer(id) ?? '');
  handle(context, 'plan:read', async ({ projectId, conversationId }) => readPlan(await projectPath(projectId), conversationId));
  handle(context, 'git:overview', async ({ projectId }) => gitOverview(await projectPath(projectId)));
  // Idempotent, so the Git page can offer it as an ordinary button rather than a one-shot action.
  handle(context, 'git:init', async ({ projectId }) => gitInit(await projectPath(projectId)));
  handle(context, 'git:stage', async ({ projectId, paths, stage }) => gitStage(await projectPath(projectId), paths, stage));
  handle(context, 'git:commit', async ({ projectId, message }) => gitCommit(await projectPath(projectId), message));
  handle(context, 'git:checkout', async ({ projectId, branch }) => gitCheckout(await projectPath(projectId), branch));
  handle(context, 'git:create-branch', async ({ projectId, name, checkout }) => gitCreateBranch(await projectPath(projectId), name, checkout));
  // Creating a repository on GitHub is outward-facing, so the renderer confirms the name and visibility first.
  handle(context, 'git:create-repository', async ({ projectId, name, visibility }) => gitCreateRepository(await projectPath(projectId), name, visibility));
  handle(context, 'git:github-status', async ({ projectId }) => githubCliStatus(await projectPath(projectId)));
  // Pushing sends work off this machine, so the renderer confirms it with the user before calling this.
  handle(context, 'git:sync', async ({ projectId, action }) => gitSync(await projectPath(projectId), action));
  handle(context, 'git:pull-team-branch', async ({ projectId, repository, branch }) => gitPullTeamBranch(await projectPath(projectId), repository, branch));
  handle(context, 'git:clone-team-repository', async ({ repository }, request) => {
    const options: OpenDialogOptions = { title: `Choose where to clone ${repository}`, buttonLabel: 'Clone here', properties: ['openDirectory', 'createDirectory'] };
    const owner = request.session?.window ?? context.getMainWindow();
    const choice = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (choice.canceled || !choice.filePaths[0]) return null;
    const destination = await gitCloneTeamRepository(path.resolve(choice.filePaths[0]), repository);
    const now = new Date().toISOString();
    const stored = await context.projects.upsert({ schemaVersion: 1, id: `project_${crypto.randomUUID()}`, name: path.basename(destination), path: destination, createdAt: now, lastOpenedAt: now });
    await broadcastSharedState(context);
    return { projectId: stored.id, path: destination };
  });
  handle(context, 'git:diff', async ({ projectId, path: filePath, staged }) => gitDiffFile(await projectPath(projectId), filePath, staged));
  handle(context, 'git:blame', async ({ projectId, path: filePath }) => gitBlameFile(await projectPath(projectId), filePath));
  handle(context, 'git:changes', async ({ projectId, path: filePath }) => gitChangedHunks(await projectPath(projectId), filePath));
  handle(context, 'files:todos', async ({ projectId }) => scanTodos(await projectPath(projectId)));
  handle(context, 'review:change', async ({ request: reviewRequest, diff, mode }) => context.changeReviewer.review(reviewRequest, diff, mode));
  handle(context, 'review:changes', async ({ projectId, paths, request: reviewRequest, mode }) => {
    const root = await projectPath(projectId);
    const files: Array<{ path: string; diff: string }> = [];
    for (const filePath of [...new Set(paths)]) files.push({ path: filePath, diff: await gitDiffAgainstHead(root, filePath).catch(() => '') });
    return context.changeReviewer.reviewFiles(reviewRequest ?? '', files, mode);
  });
  handle(context, 'experiences:count', async () => (await context.experiences.list()).length);
  handle(context, 'experiences:suggestions', async () => suggestMemoryImprovements(await context.experiences.list()));
  handle(context, 'experiences:suggestions:review', async ({ recordIds }) => { await context.experiences.markMemorySuggestionsReviewed(recordIds); return true; });
  handle(context, 'experiences:export', async (_input, request) => {
    const records = await context.experiences.exportReviewed();
    if (!records) return null;
    const options = {
      title: 'Export KAI agent experiences', defaultPath: 'kai-agent-experiences.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
    };
    const owner = request.session?.window ?? context.getMainWindow();
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, `${records}\n`, 'utf8');
    return { count: records.split('\n').filter(Boolean).length, path: result.filePath };
  });
  handle(context, 'experiences:clear', async () => { await context.experiences.clear(); return true; });
  handle(context, 'git:pull-request', async ({ projectId, title, body }) => gitCreatePullRequest(await projectPath(projectId), title, body));
  handle(context, 'verification:overview', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    return verificationOverview(context.verification, project.id, project.path);
  });
  handle(context, 'verification:run', async ({ projectId, command }, request) => {
    // The renderer asks the user to confirm before this channel is called; the command runs with their permissions.
    if (request.session && request.session.projectId !== projectId) {
      throw new Error('Checks can only run in the project open in this window.');
    }
    const project = await resolveProject(context, projectId, true);
    const check = await runCheckCommand(project.path, command);
    const run = await recordVerification(context.verification, project.id, project.path, check);
    await logRegression(context, project.path, project.name, check);
    return run;
  });
  handle(context, 'recovery:list', async () => context.recovery.list());
  handle(context, 'recovery:recap', async ({ conversationId }) => interruptedRunRecap(context, conversationId));
  handle(context, 'recovery:resume', async ({ conversationId }) => {
    const record = await requireRecoveryRecord(context, conversationId);
    // Resuming is always a user action; the record is cleared here and a fresh one is written when the run starts.
    await context.recovery.end(conversationId);
    await releaseAgentClaim(context, record.agent);
    return buildResume(record);
  });
  handle(context, 'recovery:discard', async ({ conversationId }) => {
    const record = await context.recovery.read(conversationId);
    await context.recovery.end(conversationId);
    if (record) await releaseAgentClaim(context, record.agent);
    return true;
  });
  handle(context, 'runs:stop-all', async () => {
    // Two sources, because neither is complete alone: the notification centre only learns of a run once it is past
    // setup, while a run still hung in setup exists only here. A run missing from this set would carry on working
    // while its recovery record was cleared underneath it, which is worse than not clearing anything.
    const live = new Set([...context.notifications.activeRunIds(), ...automationRuns.keys()]);
    let stoppedRuns = 0;
    for (const conversationId of live) {
      if (cancelConversationRun(context, conversationId)) stoppedRuns += 1;
    }
    // Both are already stop-everything, stopping one session at a time, and neither is terminal: calling them
    // mid-session leaves KAI able to start a fresh run straight afterwards.
    await context.auto.dispose().catch(() => undefined);
    await context.autopilot.dispose().catch(() => undefined);
    // Records left by runs that died with the process. Each also holds a claim on the agent, so clearing the file
    // without releasing the claim would leave the project claimed by an agent that is not running.
    const { records, unreadable } = await context.recovery.list();
    let clearedRuns = 0;
    for (const record of records) {
      await context.recovery.end(record.conversationId).catch(() => undefined);
      await releaseAgentClaim(context, record.agent);
      clearedRuns += 1;
    }
    // Records nobody can read. The run they describe is over either way, and there is nothing in them to resume
    // — and no agent name to release a claim with, which is the one thing this cannot do for them. Removed so
    // they stop being counted as runs still waiting on a person, which is what the banner was reporting.
    for (const conversationId of unreadable) {
      await context.recovery.end(conversationId).catch(() => undefined);
      clearedRuns += 1;
    }
    return { stoppedRuns, clearedRuns };
  });
  handle(context, 'diagnostics:report', async ({ copy }) => {
    const [settings, services, agents] = await Promise.all([context.settings.load(), context.services.status(), context.agents.capabilities().catch(() => [])]);
    const text = buildDiagnosticsReport({
      generatedAt: new Date(),
      appName: context.appName,
      version: context.version,
      platform: process.platform,
      arch: process.arch,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      settings,
      services,
      agents: agents.map((agent) => ({ id: agent.id, available: agent.available, version: agent.version, detail: agent.unavailableReason })),
      logs: context.logger.recent(200),
      // This call is itself outstanding while the report is built, and naming it would only be confusing.
      pendingCalls: inFlightIpcCalls().filter((call) => call.channel !== 'diagnostics:report'),
    });
    if (copy) clipboard.writeText(text);
    return { text };
  });
  handle(context, 'diagnostics:data-locations', async () => dataLocations(context.paths));
  handle(context, 'projects:knowledge', async ({ projectId }) => {
    const project = await resolveProject(context, projectId, true);
    return (await knowledgeBriefing(project.path, 6_000))
      || 'KAI has not learned anything about this project yet. It learns from the files that change while the project is open and from the runs it finishes here.';
  });
  handle(context, 'diagnostics:recent-logs', async ({ count }) => context.logger.recent(count));
  handle(context, 'window:state', async (_input, request) => ({
    maximized: request.session?.window.isMaximized() ?? false,
  }));
  handle(context, 'window:new', async ({ projectId }) => {
    await context.createWindow(projectId ?? null);
    return true;
  });
  handle(context, 'window:title-bar-overlay', async ({ color, symbolColor }, request) => {
    // The controls are drawn by the window manager, so the theme has to be pushed to it. Every window KAI has open
    // gets the same colours: they are separate BrowserWindows, each with its own overlay, so recolouring only the one
    // that asked would leave the others in whatever palette they were created with.
    const windows = context.windows.live();
    const targets = windows.length > 0 ? windows : (request.session ? [request.session] : []);
    for (const session of targets) {
      try {
        session.window.setTitleBarOverlay({ color, symbolColor, height: 38 });
      } catch (error) {
        // An older Electron, or a platform without the overlay. The window still works; it just keeps its colours.
        context.logger.warn('internal', 'Could not recolour the window controls', messageOf(error));
      }
    }
    return true;
  });
  handle(context, 'remote:status', async () => context.remote.status());
  handle(context, 'remote:windows', async () => context.remote.windows());
  handle(context, 'remote:devices', async () => context.remote.devices());
  handle(context, 'remote:pair-device', async ({ label }) => {
    const result = await context.remote.pairDevice(label);
    await broadcastSharedState(context);
    return result;
  });
  handle(context, 'remote:revoke-device', async ({ id }) => {
    const devices = await context.remote.revokeDevice(id);
    await broadcastSharedState(context);
    return devices;
  });
  /**
   * The phone's task board, read-only by construction: the operation is fixed here and only the project
   * filter travels, so no request can name a card to change. The desktop's Tasks page reaches the same
   * brain through `cognitive1:operation`, which is generic — it also carries task-complete, brain-prune
   * and the rest — and is deliberately not on the remote allowlist.
   */
  handle(context, 'remote:tasks', async ({ project }) =>
    parseTasks(
      await context.cognitive1.operation({
        operation: 'tasks',
        payload: { all: 'true', ...(project ? { project } : {}) },
      }),
    ),
  );

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, rawInput: unknown): Promise<IpcResponse<unknown>> => {
      try {
        assertTrustedSender(event.senderFrame?.url ?? '');
        const session = context.windows.fromWebContentsId(event.sender.id);
        const data = await handler(rawInput, {
          session,
          ownerWindowId: session?.id ?? event.sender.id,
        });
        return { ok: true, data };
      } catch (error) {
        context.logger.error('ipc_error', `IPC ${channel} failed`, undefined, error);
        return failureFor(error);
      }
    });
  }

  return {
    channels: () => [...handlers.keys()],
    dispatch: async (channel, rawInput, request) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler is registered for ${channel}.`);
      return handler(rawInput, request);
    },
  };
}

async function restartCognitive1ForOverwatchCredential(context: IpcContext, credentialId: string): Promise<void> {
  const settings = await context.settings.load();
  if (!settings.cognitive1.overwatch.enabled || credentialId !== settings.cognitive1.overwatch.credentialId) return;
  const cognitive1Ready = (await context.services.status()).some(
    (service) => service.kind === 'cognitive1' && service.status === 'ready',
  );
  if (cognitive1Ready) await context.services.restart('cognitive1', settings);
}

/**
 * One prompt from the user (or a schedule), with the project's automation around it: hooks, automatic checks and
 * fixes, and review. The outcome is also scored, so the agent's record can steer later model choices.
 */
export async function runInteractiveAgent(
  context: IpcContext,
  request: AgentRunRequest,
  ownerWindowId: number | null,
): Promise<AgentRunResult> {
  const conversation = await context.conversations.get(request.conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');
  request = scopeConversationRequest(conversation, request);
  const ownerSession = ownerWindowId === null ? null : context.windows.get(ownerWindowId);
  if (ownerSession && ownerSession.projectId !== conversation.projectId) {
    throw new Error('This conversation belongs to a different project. Open that project in this window before running it.');
  }
  if (conversation.origin?.kind === 'lead') return runConversationAgent(context, { ...request, autonomy: 'plan' }, ownerWindowId);
  if (ownerSession) ownerSession.conversationId = conversation.id;
  const settings = await context.settings.load();
  const projectId = conversation.projectId ?? (ownerSession ? null : settings.activeProjectId);
  const project = projectId ? (await context.projects.list()).find((item) => item.id === projectId) : undefined;
  if (!project) return runConversationAgent(context, request, ownerWindowId);

  const startedAt = Date.now();
  const firstTurnIndex = conversation.turns.length;
  const automation = (await context.preferences.get(project.id))?.automation;
  const activeProjectRun = interactiveProjectRuns.get(project.id);
  if (activeProjectRun) {
    throw new Error(`Another agent run is already active in ${project.name}. Wait for it to finish, or start isolated work through Team or Compare.`);
  }
  interactiveProjectRuns.set(project.id, request.conversationId);
  // The same signal every level of this run shares, so one Stop reaches the automation, the setup and the agent.
  const stop = runStopFor(request.conversationId);
  const ports: AutomationPorts = {
    cancelled: () => stop.signal.aborted,
    runOnce: (turn) => runConversationAgent(context, turn, ownerWindowId),
    automation: async () => automation,
    conversation: () => context.conversations.get(request.conversationId),
    suggestCheck: () => suggestTestCommand(project.path),
    runShell: async (command, timeoutMs, env) => {
      const check = await runCheckCommand(project.path, command, AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]), env);
      return { exitCode: check.exitCode, output: check.output };
    },
    recordCheck: async (command, outcome) => {
      const check: RecordedCheck = {
        command,
        source: 'agent',
        exitCode: outcome.exitCode,
        startedAt: new Date(),
        durationMs: 0,
        output: outcome.output,
        ...(conversation.goal ? { task: { id: conversation.goal.id, outcome: conversation.goal.outcome } } : {}),
      };
      await recordVerification(context.verification, project.id, project.path, check);
      await logRegression(context, project.path, project.name, check);
    },
    note: async (text) => {
      const latest = await context.conversations.get(request.conversationId);
      if (!latest) return;
      const at = new Date().toISOString();
      latest.turns.push({ id: `turn_${crypto.randomUUID()}`, role: 'assistant', text, createdAt: at });
      latest.updatedAt = at;
      await context.conversations.save(latest);
    },
    review: async (original) => {
      const latest = await context.conversations.get(request.conversationId);
      const checkpoint = latest?.turns[firstTurnIndex]?.checkpoint;
      if (!checkpoint) return null;
      return context.changeReviewer.review(original.prompt, await textDiffFromCheckpoint(project.path, checkpoint));
    },
  };

  let outcome: Awaited<ReturnType<typeof runWithAutomation>>;
  try {
    outcome = await runWithAutomation(ports, request);
  } finally {
    automationRuns.delete(request.conversationId);
    if (interactiveProjectRuns.get(project.id) === request.conversationId) interactiveProjectRuns.delete(project.id);
  }
  const cancelled = stop.signal.aborted || outcome.result.cancelled === true;
  if (!cancelled) {
    await context.runScores.add({
      at: new Date().toISOString(),
      projectId: project.id,
      agent: request.agent,
      execution: request.execution ?? 'cli',
      ...(request.model ? { model: request.model } : {}),
      level: request.effort ?? classifyWork(request.prompt).level,
      completed: outcome.result.status === 'completed',
      checkPassed: outcome.checkPassed,
      fixRounds: outcome.fixRounds,
      filesChanged: outcome.filesChanged,
      // The paths, not just the count: the next run on these files reads them to see what was already tried here.
      ...(changedPathsOf(outcome.result.conversation).length
        ? { files: changedPathsOf(outcome.result.conversation).slice(0, 100) }
        : {}),
      durationMs: Date.now() - startedAt,
      ...(outcome.result.costUsd !== undefined ? { costUsd: outcome.result.costUsd } : {}),
    }).catch(() => undefined);
  }
  return outcome.result;
}

/** Runs a schedule's prompt in a fresh conversation, as the user would have. */
export async function runScheduledGoal(context: IpcContext, schedule: Schedule): Promise<ScheduledRunOutcome> {
  const project = (await context.projects.list()).find((item) => item.id === schedule.projectId);
  if (!project) return { status: 'failed', summary: 'The project for this schedule is no longer in KAI.' };
  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    schemaVersion: 1,
    id: `conv_${crypto.randomUUID()}`,
    projectId: project.id,
    title: `Scheduled: ${schedule.name}`.slice(0, 64),
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: true,
    activeAgent: null,
    route: null,
    autonomy: null,
    turns: [],
    events: [],
  };
  await context.conversations.save(conversation);
  const result = await runInteractiveAgent(
    context,
    {
      conversationId: conversation.id,
      prompt: schedule.frequency.kind === 'selfPaced' ? `${schedule.prompt}${selfPacedInstruction(schedule.frequency.maxMinutes)}` : schedule.prompt,
      agent: schedule.agent,
      execution: schedule.execution,
      route: schedule.route,
      autonomy: schedule.autonomy,
      freshSession: true,
    },
    null,
  );
  const summary = result.status === 'completed' ? result.output.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Completed.' : result.error ?? 'The run failed.';
  const nextCheck = schedule.frequency.kind === 'selfPaced' ? parseNextCheck(result.output) : undefined;
  return { status: result.status === 'completed' ? 'completed' : 'failed', summary, conversationId: conversation.id, ...(nextCheck ? { nextCheck } : {}) };
}

/**
 * One Security Auditor pass, run as a real agent task rather than as a tutor turn.
 *
 * The old path sent the instruction to the Learning Tutor, which is a single structured call with no shell, file or
 * browser tools: it could neither start a dev server nor reproduce anything, and nothing in that path wrote a
 * finding. This one opens a conversation, runs the project's own agent with the `security-auditor` skill selected —
 * so it has the same tools as any other task — and then files the report the prompt asks for. Findings the agent
 * saved through the `save_security_finding` tool are already in the log; the report block is what makes the same
 * promise true for a provider that has no MCP tools.
 */
/**
 * A real agent run that audits what the brain holds for a project against the project itself. The agent is the person's
 * choice, so a bigger model (Claude, Codex, DeepSeek through a route) can teach what the smaller local ones will read.
 */
async function reviewProjectMemory(
  context: IpcContext,
  input: BrainMemoryReviewInput,
  ownerWindowId: number,
): Promise<BrainMemoryReviewResult> {
  const project = (await context.projects.list()).find((candidate) => candidate.id === input.projectId);
  if (!project) throw new NotFoundError('Project not found.');
  if (!(await cognitive1Ready(context))) throw new Error('The brain is not running. Start Cognitive1 and try again.');
  const settings = await context.settings.load();
  const resolution = await resolveProjectMemoryName(context, project.path, project.name);
  const current = (await context.cognitive1.search({ query: resolution.name, project: resolution.name, maxResults: 40 }).catch(() => []))
    .map((entry) => `[${entry.type}] ${entry.title}${entry.fields.note ? `: ${entry.fields.note.slice(0, 200)}` : ''}`);
  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    schemaVersion: 1,
    id: `conv_${crypto.randomUUID()}`,
    projectId: project.id,
    title: `Review project memory — ${project.name}`.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: false,
    activeAgent: input.agent,
    route: settings.defaultRoute,
    autonomy: 'autoEdit',
    execution: input.execution,
    turns: [],
    events: [],
  };
  await context.conversations.save(conversation);
  const result = await runConversationAgent(context, {
    conversationId: conversation.id,
    prompt: brainMemoryReviewPrompt({ projectName: project.name, current }),
    agent: input.agent,
    execution: input.execution,
    route: settings.defaultRoute,
    autonomy: 'autoEdit',
  }, ownerWindowId);
  return {
    conversationId: conversation.id,
    status: result.status,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function runSecurityScan(
  context: IpcContext,
  input: SecurityScanInput,
  ownerWindowId: number,
): Promise<SecurityScanResult> {
  const project = (await context.projects.list()).find((candidate) => candidate.id === input.projectId);
  if (!project) throw new NotFoundError('Project not found.');
  const existing = input.findingId
    ? (await context.securityFindings.list()).find((finding) => finding.id === input.findingId)
    : undefined;
  if (input.profile === 'verify' && !existing) throw new NotFoundError('That finding is no longer in the log.');

  const settings = await context.settings.load();
  const now = new Date().toISOString();
  const label = input.target.trim() || (existing ? existing.title : project.name);
  const conversation: ConversationRecord = {
    schemaVersion: 1,
    id: `conv_${crypto.randomUUID()}`,
    projectId: project.id,
    title: `Security audit — ${label}`.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: false,
    activeAgent: settings.defaultAgent,
    route: settings.defaultRoute,
    autonomy: 'autoEdit',
    execution: 'cli',
    turns: [],
    events: [],
  };
  await context.conversations.save(conversation);

  // Secrets are the one class where a regex is more reliable than a model's guess at which files to open. Run that
  // pass first and give the agent the leads; it still decides whether each match is a real credential.
  const prepass = input.profile === 'full' || input.profile === 'secrets'
    ? await runSecurityPrepass(project.path).catch(() => null)
    : null;
  const prompt = securityAuditPrompt({
    profile: input.profile,
    target: input.target,
    projectName: project.name,
    ...(existing ? { finding: existing } : {}),
    ...(prepass ? { prepass: prepass.text } : {}),
  });
  const result = await runConversationAgent(context, {
    conversationId: conversation.id,
    prompt,
    agent: settings.defaultAgent,
    execution: 'cli',
    route: settings.defaultRoute,
    autonomy: 'autoEdit',
    skills: ['security-auditor'],
  }, ownerWindowId);

  // A verify pass addresses the record it was asked about; a normal pass lets the fingerprint decide, so the same
  // issue found twice updates one row.
  await fileSecurityReport(context, result.output, {
    projectPath: project.path,
    ...(input.profile === 'verify' && existing ? { findingId: existing.id, verifiedAt: now } : {}),
  });

  return {
    conversationId: conversation.id,
    status: result.status,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    findings: await context.securityFindings.list(),
  };
}

/**
 * Files the report block an audit run ends with. This is the path that works for every provider: a CLI session with
 * the `kai-project` server saves through the tool and the block repeats it (the fingerprint makes that one row), while
 * an API run has no MCP tools and this is the only way its findings reach the log.
 */
async function fileSecurityReport(
  context: IpcContext,
  output: string | undefined,
  options: { findingId?: string; verifiedAt?: string; projectPath?: string } = {},
): Promise<void> {
  if (!output?.trim()) return;
  const reported = parseSecurityFindingsReport(output);
  // A fresh scan gets a sceptical second look before it is filed; a verify pass already re-tests one record by hand.
  // Doubts are written into the evidence, never used to drop a finding.
  const items = options.findingId || !options.projectPath ? reported : await recheckReportItems(reported, options.projectPath, context.changeReviewer);
  for (const item of items) {
    await context.securityFindings.add({
      severity: item.severity,
      vulnClass: item.vulnClass,
      title: item.title,
      location: item.location,
      evidence: item.evidence,
      conceptCard: item.conceptCard,
      ...(item.status ? { status: item.status } : {}),
      ...(options.findingId
        ? {
            id: item.findingId ?? options.findingId,
            ...(options.verifiedAt ? { lastVerifiedAt: options.verifiedAt } : {}),
          }
        : {}),
    });
  }
}

/**
 * Says that a conversation is being worked on, and again when the work is over.
 *
 * Every run announces itself here, whoever asked for it. A window only renders an agent's events for the
 * conversations it has taken up, and the composer's own send used to be the only thing that took one up — so a run
 * started in the main process (Auto carrying a task, the board working a card, a schedule firing) worked with
 * nothing appearing in the conversation it was working in.
 *
 * Broadcast rather than sent to the window that asked, because any window showing the conversation should be able
 * to follow it, and a run the main process began has no window of its own.
 */
function announceRunState(context: IpcContext, conversationId: string, status: AgentRunState['status']): void {
  context.windows.broadcast('agents:run-state', { conversationId, status } satisfies AgentRunState);
}

/** How many agent runs are working in each folder, so the last one out is the one that closes what was opened. */
const runsWorkingIn = new Map<string, number>();

export async function runConversationAgent(
  context: IpcContext,
  request: AgentRunRequest,
  ownerWindowId: number | null = null,
  // Main-process only, never from the renderer: run in a separate copy of the project (a part running side by side).
  options: { cwd?: string } = {},
): Promise<AgentRunResult> {
  const conversation = await context.conversations.get(request.conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');
  request = scopeConversationRequest(conversation, request);

  // Stop has to reach a run before the agent starts, so the signal is taken here, at the top, and every slow step
  // below checks it. `ownsStop` is what keeps this run from clearing a controller that an enclosing automation
  // created and still needs.
  const ownedStop = !automationRuns.has(request.conversationId);
  const stop = runStopFor(request.conversationId);
  const stopped = (): boolean => stop.signal.aborted;
  /**
   * Ends this run as stopped. Before the agent starts, the request has already been written to the conversation —
   * so a stop there takes it back out again rather than leaving a message with no reply under it.
   */
  const stoppedResult = async (): Promise<AgentRunResult> => {
    if (writtenTurnId) {
      const index = conversation.turns.findIndex((turn) => turn.id === writtenTurnId);
      if (index >= 0) {
        conversation.turns.splice(index, 1);
        await context.conversations.save(conversation);
      }
    }
    announceRunState(context, conversation.id, 'finished');
    if (ownedStop) automationRuns.delete(request.conversationId);
    return { conversation, status: 'failed', output: '', cancelled: true };
  };
  let writtenTurnId = '';

  const settings = await context.settings.load();
  const projectId = conversation.projectId ?? (ownerWindowId === null ? settings.activeProjectId : null);
  const project = projectId ? (await context.projects.list()).find((item) => item.id === projectId) : undefined;
  if (!project) throw new NotFoundError('Open a project before sending a message.');
  // One place for every agent run (composer, Crew, Studio, workflows): a history past the chosen size is summarised
  // first. A failure never blocks the run; it simply goes ahead with the full history.
  // The connection this run actually uses: a role's own, or the one in Settings.
  const runProvider = request.execution === 'api' ? request.apiConnection?.provider ?? settings.directApi.provider : null;
  const runModel = request.apiConnection?.model || request.model || settings.directApi.model;
  // Whether that model is on the person's own hardware: such a run costs nothing and is sent less to read.
  const runConnection = request.apiConnection
    ? resolveApiConnection(settings.directApi, withGatewayProfile(settings, request.apiConnection))
    : settings.directApi;
  const ownModelRun = request.execution === 'api' && request.route !== 'proxy'
    && (isLocalProvider(runConnection.provider) || modelHostOf(runConnection, settings) === 'own-hardware');
  const compactAt = compactThresholdFor(settings.usageBudget, runProvider, modelContextFor(settings, runModel));
  const askedToCompact = compactBeforeNextRun.delete(conversation.id);
  const leadConversationRun = conversation.origin?.kind === 'lead';
  // Said in the conversation when it happens: a fold nobody could see looked exactly like one that never ran.
  let compactionNotice: string | null = null;
  if (!leadConversationRun && conversation.turns.length > 0 && (askedToCompact || (compactAt > 0 && estimateConversationTokens(conversation) >= compactAt))) {
    try {
      const before = estimateConversationTokens(conversation);
      Object.assign(conversation, await compactConversation(context, conversation.id));
      const after = estimateConversationTokens(conversation);
      compactionNotice = `Compacted this conversation before the run: ${conversation.compaction?.originalTurns ?? 0} earlier turns became a summary, about ${before.toLocaleString()} down to ${after.toLocaleString()} tokens${askedToCompact ? '' : ` (it reached the ${compactAt.toLocaleString()} you set)`}.`;
      context.logger.info('internal', compactionNotice);
    } catch (error) {
      context.logger.error('agent_crash', 'Automatic context compaction failed; running with the full history', undefined, error);
    }
  }
  // Where the agent works and reads files. The project itself stays the identity for memory, claims and checks.
  const workRoot = options.cwd ?? project.path;

  let authoritativeRules: string;
  try {
    authoritativeRules = await context.executionRules.read();
  } catch (error) {
    throw new Error(
      `KAI could not load the bundled Cognitive1 standing instructions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stopped()) return stoppedResult();
  // Autopilot promises to work on this machine only, so its runs are told, inside the rules, that the commit and push
  // step does not apply to them. Everything built from the rules below (the briefing and the project context) sees it.
  if (conversation.origin?.kind === 'autopilot') authoritativeRules = withAutopilotException(authoritativeRules);
  // A crew whose builders do not commit is told so inside the rules, which otherwise call commit and push mandatory.
  if (conversation.origin?.kind === 'crew') {
    const crewRun = await context.crew.get(conversation.origin.runId).catch(() => null);
    if (crewRun && !crewRun.config.commitWork) authoritativeRules = withCrewException(authoritativeRules);
    // The Lead, planners and reviewers only read; the session tools the rules ask for need an approval they cannot get.
    if (crewRun && request.autonomy === 'plan') authoritativeRules = withCrewReadOnlyException(authoritativeRules);
  }
  // A model on the person's own hardware gets the short form, after any exception has been added to the rules.
  if (ownModelRun) authoritativeRules = compactRules(authoritativeRules);
  const rulesBriefing = buildExecutionRulesBriefing(authoritativeRules);

  const executionMode = request.execution ?? 'cli';
  if (executionMode === 'api' && !ownModelRun) {
    // Block mode refuses before anything is saved or sent, so the run never reaches the provider.
    // From the usage ledger, not from the conversations: loading every saved conversation for each run, with eight runs
    // starting together, is what ran KAI's main process out of memory.
    const usage = summarizeUsageFromRuns(await paidRunsFor(context), settings.usageBudget, new Date(), conversation.id);
    if (usage.blockedReason) {
      context.logger.info('internal', 'Direct API run blocked by usage budget', usage.blockedReason);
      return { conversation, status: 'failed', output: '', error: `${usage.blockedReason} Raise the limit or switch to warn mode in Settings to continue.` };
    }
  }
  const preferences = await context.preferences.get(project.id);
  const chipPaths = (request.contextChips ?? [])
    .filter((chip): chip is Extract<ContextChip, { type: 'file' }> => chip.type === 'file')
    .map((chip) => chip.path);
  const selectedPaths = await resolveSelectedProjectPaths(workRoot, [
    ...(request.selectedPaths ?? []),
    ...chipPaths,
  ]);
  const chipContext = await renderContextChips(
    workRoot,
    context.paths.attachments,
    request.contextChips ?? [],
  );
  const availableSkills = await discoverDesktopSkills(workRoot);
  const selectedSkills = availableSkills.filter((skill) => request.skills?.includes(skill.name));
  const activeGoal = goalForRequest(request.goal, conversation.goal ?? null);
  const previousAgent = conversation.activeAgent;
  const previousExecution = conversation.execution ?? 'cli';
  const now = new Date().toISOString();
  const canResume =
    !request.freshSession &&
    conversation.activeAgent === request.agent &&
    conversation.route === request.route &&
    (conversation.execution ?? 'cli') === executionMode;
  conversation.activeAgent = request.agent;
  conversation.route = request.route;
  conversation.execution = executionMode;
  conversation.autonomy = request.autonomy;
  if (request.goal) conversation.goal = activeGoal;
  conversation.updatedAt = now;
  const checkpoint = await createProjectCheckpoint(workRoot).catch(() => null);
  const userTurn: ConversationRecord['turns'][number] = {
    id: `turn_${crypto.randomUUID()}`,
    role: 'user',
    text: request.displayText ?? request.prompt,
    createdAt: now,
    ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(request.contextChips?.some((chip) => chip.type === 'image' && chip.dataUrl)
      ? {
          attachments: request.contextChips
            .filter((chip): chip is Extract<ContextChip, { type: 'image' }> => chip.type === 'image' && Boolean(chip.dataUrl))
            .map((chip) => ({ name: chip.name, dataUrl: chip.dataUrl! })),
        }
      : {}),
    ...(request.contextChips?.some((chip) => chip.type === 'attachment')
      ? {
          files: request.contextChips
            .filter((chip): chip is Extract<ContextChip, { type: 'attachment' }> => chip.type === 'attachment')
            .slice(0, 20)
            .map((chip) => ({ name: chip.name, ...(chip.mimeType ? { mimeType: chip.mimeType } : {}) })),
        }
      : {}),
  };
  // A thread opened with the + button starts unnamed; its first message is what names it, so tabs read as topics.
  if (isPlaceholderTitle(conversation.title) && !conversation.turns.some((turn) => turn.role === 'user')) {
    // The words the person typed, not the long instructions KAI wrapped around them (a Guided Build plan request).
    conversation.title = titleFromPrompt(request.displayText?.replace(/^(?:Coach|Builder):\s*/i, '').trim() || request.prompt);
  }
  conversation.turns.push(userTurn);
  writtenTurnId = userTurn.id;

  let resumeSessionId = canResume && !conversation.compaction ? conversation.agentSessionId : undefined;
  if (!resumeSessionId && conversation.compaction) delete conversation.agentSessionId;
  await context.conversations.save(conversation);
  if (stopped()) return stoppedResult();
  await context.recovery.begin({
    conversationId: conversation.id,
    projectId: project.id,
    title: conversation.title,
    agent: request.agent,
    execution: executionMode,
    route: request.route,
    autonomy: request.autonomy,
    prompt: request.prompt,
    goal: activeGoal?.outcome ?? null,
    startedAt: now,
    updatedAt: now,
    eventCount: 0,
    checkpoint: checkpoint ?? null,
  }).catch((error) => context.logger.warn('internal', 'Could not write recovery checkpoint', messageOf(error)));

  // One deadline for all of the pre-run memory work, so a hung brain costs a few seconds rather than a couple of
  // minutes before the agent is even asked to start. See `MemoryBudget`.
  const memoryBudget = new MemoryBudget();
  const memoryEvents: PersistedEvent[] = [];
  if (executionMode === 'api') {
    // The brain's own spelling of the project, when it answers in time; the local name either way. Nothing after this
    // depends on which it was.
    const projectName = (await memoryBudget.run(memoryProjectName(context, project.path, project.name))) ?? project.name;
    await prepareMemorySession(
      context,
      conversation,
      request,
      project.path,
      projectName,
      previousAgent,
      previousExecution,
      memoryEvents,
      memoryBudget,
    );
  }
  // The memory session is the slowest part of setup when the brain is unwell, so Stop is answered here too.
  if (stopped()) return stoppedResult();

  // Where in the reply each event happened, so the transcript can keep prose and activity in the order they occurred.
  let streamedChars = 0;
  const eventOffsets = new Map<string, number>();
  const liveDiffEvents: PersistedEvent[] = [];
  const liveDiffTasks = new Map<string, Promise<void>>();
  const liveDiffRefreshes = new Set<Promise<void>>();
  const providerDiffAt = new Map<string, number>();
  const lastLiveDiffText = new Map<string, string>();
  const generatedDiffIds = new Set<string>();
  const emit = (original: AgentRunEvent['event']): void => {
    let event = original;
    if (event.type === 'text.delta') {
      // Rule 47: no long dashes in output. Held here as well as asked for, because a model forgets it mid-run.
      if (event.channel === 'assistant') {
        event = { ...event, text: plainDashes(event.text) };
        streamedChars += event.text.length;
      }
    } else {
      eventOffsets.set(event.id, streamedChars);
      event = { ...event, textOffset: streamedChars };
    }
    const activity = describeEvent(event);
    if (activity) void context.recovery.touch(conversation.id, activity).catch(() => undefined);
    if (event.type === 'approval.request') {
      void context.notifications.notifyApproval(conversation.id, conversation.title, event.title, ownerWindowId ?? undefined);
      // An Auto run cannot answer a prompt, so it stops and asks the person instead of looking stuck. Optional
      // because a context assembled for a single run (tests, headless callers) may have no Auto loop at all.
      context.auto?.onApprovalRequest(conversation.id, event.title);
    }
    const payload = { conversationId: conversation.id, event } satisfies AgentRunEvent;
    if (ownerWindowId === null || !context.windows.send(ownerWindowId, 'agents:event', payload)) {
      context.windows.broadcast('agents:event', payload);
    }
    if (event.type === 'diff.proposal' && !generatedDiffIds.has(event.id)) providerDiffAt.set(event.filePath, Date.now());
    if (event.type === 'diff.proposal' && event.applied && event.diff) lastLiveDiffText.set(event.filePath, event.diff);
    // Providers vary in how they report edits: some send a file-change event, while others only complete an edit or
    // shell tool call. Refresh the checkpoint's changed paths after each such event so every composer execution mode
    // gets the same live diff. Native proposals take precedence when the provider supplies one.
    const toolMayChangeFiles = event.type === 'tool.call'
      && event.status === 'completed'
      && /(edit|write|patch|create|delete|rename|replace|shell|command|exec|terminal|bash|powershell)/i.test(event.name);
    const shouldRefreshDiffs = Boolean(checkpoint) && (
      event.type === 'file.change'
      || event.type === 'file.edit.applied'
      || toolMayChangeFiles
    );
    if (shouldRefreshDiffs && checkpoint) {
      const refresh = (async () => {
        // Give providers that emit a first-party diff immediately after the tool result a chance to do so.
        await new Promise((resolve) => setTimeout(resolve, 120));
        const changedFiles = await diffFromCheckpoint(workRoot, checkpoint).catch(() => []);
        await Promise.all(changedFiles.map(async ({ path: filePath }) => {
          const previous = liveDiffTasks.get(filePath) ?? Promise.resolve();
          const task = previous.then(async () => {
            if (Date.now() - (providerDiffAt.get(filePath) ?? 0) < 1_500) return;
            const diff = await textDiffFileFromCheckpoint(workRoot, checkpoint, filePath);
            if (!diff || diff === lastLiveDiffText.get(filePath) || Date.now() - (providerDiffAt.get(filePath) ?? 0) < 1_500) return;
            lastLiveDiffText.set(filePath, diff);
            const proposal: PersistedEvent = {
              schemaVersion: 1,
              id: `evt_${crypto.randomUUID()}`,
              taskId: conversation.id,
              timestamp: new Date().toISOString(),
              agent: request.agent,
              type: 'diff.proposal',
              filePath,
              summary: 'Live changes from this run',
              diff,
              applied: true,
            };
            generatedDiffIds.add(proposal.id);
            liveDiffEvents.push(proposal);
            emit(proposal);
          }).catch(() => undefined);
          liveDiffTasks.set(filePath, task);
          await task;
        }));
      })().catch(() => undefined);
      liveDiffRefreshes.add(refresh);
      void refresh.finally(() => liveDiffRefreshes.delete(refresh));
    }
  };
  const approvalEvent = (approval: DirectApiApprovalRequest): Extract<AgentRunEvent['event'], { type: 'approval.request' }> => ({
    schemaVersion: 1,
    id: `evt_${crypto.randomUUID()}`,
    taskId: conversation.id,
    timestamp: new Date().toISOString(),
    agent: request.agent,
    type: 'approval.request',
    requestId: approval.requestId,
    title: approval.title,
    detail: approval.detail,
    risk: approval.risk,
    ...(approval.tool ? { tool: approval.tool } : {}),
    // Carried through so the prompt can name its own answers; without it the run's question is put to the person
    // in the words of a permission request, which is the one thing it is not.
    ...(approval.runQuestion ? { runQuestion: approval.runQuestion } : {}),
    // Carried through for `ask_user`: the approval card renders these as answer choices, never as allow/deny.
    ...(approval.options ? { options: [...approval.options], ...(approval.allowFreeText ? { allowFreeText: true } : {}) } : {}),
  });
  const approvals: DirectApiApprovalPort = {
    request: (approval) => new Promise<boolean>((resolve) => {
      context.pendingApprovals.set(approval.requestId, {
        conversationId: conversation.id,
        ownerWindowId,
        event: approvalEvent(approval),
        resolve: (result) => resolve(result.approved),
      });
    }),
    requestChoice: (approval) => new Promise<string | null>((resolve) => {
      context.pendingApprovals.set(approval.requestId, {
        conversationId: conversation.id,
        ownerWindowId,
        event: approvalEvent(approval),
        resolve: (result) => resolve(result.approved ? result.answer ?? null : null),
      });
    }),
  };
  // Coach and Architect runs use the selected high-context reviewer/planner; local Builders keep the standard map.
  const coachRepoMapMaxCharacters = request.splitRole === 'architect' || request.displayText?.startsWith('Coach:')
    ? 128_000
    : undefined;
  const builtProjectContext = executionMode === 'api'
    ? await buildConversationContext(
        context,
        workRoot,
        project.name,
        project.id,
        conversation,
        request.prompt,
        authoritativeRules,
        selectedPaths,
        conversation.compaction,
        false,
        // The direct API agent has no way to look around by itself, so it is given an outline of the project.
        true,
        memoryBudget,
        // What was recalled, said on the run. The event type has existed all along and was never emitted, so a run
        // gave no sign of whether it had memory behind it — including when it had none because the brain was slow.
        (summary) => memoryEvents.push(memoryEvent(conversation.id, request.agent, 'recall', summary)),
        coachRepoMapMaxCharacters,
        ownModelRun,
      )
    : await buildConversationContext(
        context,
        workRoot,
        project.name,
        project.id,
        conversation,
        request.prompt,
        undefined,
        selectedPaths,
        conversation.compaction,
        // A resumed session already holds the rules, instruction files and skills from its first turn.
        Boolean(resumeSessionId),
        // The same outline the direct API agent gets, on a CLI session's first turn: files and their main symbols, so
        // the agent starts from a map of the project instead of walking the whole tree to find its way. A resumed
        // session already has it.
        !resumeSessionId,
        undefined,
        undefined,
        coachRepoMapMaxCharacters,
      );
  // A direct API run holds the brain tools, so it is told what they are for: the Architect keeps decisions there and a
  // local model, which compacts early, reads them back instead of depending on a summary.
  const contextText = executionMode === 'api' && context.directApi.hasBrainAccess?.()
    ? `${builtProjectContext.text}

${BRAIN_TOOLS_GUIDANCE}`
    : builtProjectContext.text;
  let snapshotProjectContext = builtProjectContext;
  const snapshotSupplementalSources = [
    ...selectedSkills.map((skill) => `Skill: ${skill.name}`),
    ...(request.contextChips ?? []).map((chip) => {
      if (chip.type === 'file') return `File attachment: ${chip.path}`;
      if (chip.type === 'selection') return `Selection: ${chip.path}:${chip.startLine}-${chip.endLine}`;
      if (chip.type === 'image') return `Image: ${chip.name}`;
      if (chip.type === 'memory') return `Memory attachment: ${chip.query}`;
      if (chip.type === 'gitDiff') return 'Git diff attachment';
      return 'Terminal selection attachment';
    }),
  ].slice(0, 120);
  // Autopilot tells its own cards how to use helpers, so the composer's choice is not added to those runs.
  const helpersNote = conversation.origin?.kind === 'autopilot' ? '' : `${helpersBriefing(request.helpers, executionMode)}\n\n`;
  let effectivePrompt = `${workingMethodBriefing()}\n\n${responseStyleBriefing(request.responseStyle)}\n\n${helpersNote}${longRunningCommandBriefing()}\n\n${buildSkillPrompt(selectedSkills, request.prompt)}`;
  if (activeGoal) effectivePrompt = buildGoalPrompt(activeGoal, effectivePrompt);
  if (chipContext.text) effectivePrompt = `${chipContext.text}\n\n${effectivePrompt}`;
  const terminalTools = context.terminalMcp === true;
  if (request.autonomy === 'full') effectivePrompt = `${fullAccessExecutionBriefing(executionMode, terminalTools)}\n\n${effectivePrompt}`;
  if (context.windowMcp === true) effectivePrompt = `${windowBriefing(executionMode)}\n\n${effectivePrompt}`;
  if (terminalTools) effectivePrompt = `${terminalBriefing(executionMode, availableShells())}\n\n${effectivePrompt}`;
  const promptWithoutProjectContext = effectivePrompt;
  // A route/agent switch starts a fresh CLI session. Carry enough transcript
  // forward that the new provider treats this as a continuation, not a new task.
  if (executionMode === 'cli' && !canResume) {
    const handoff = renderConversationHandoff(conversation.turns.slice(0, -1), leadConversationRun);
    if (handoff) effectivePrompt = `${handoff}\n\n${effectivePrompt}`;
  }
  if (executionMode === 'cli' && contextText) {
    effectivePrompt = `${contextText}\n\n[USER REQUEST]\n${effectivePrompt}`;
  }
  // A run started while a plan is unfinished is very often a diversion: the person steered, or asked a question, and
  // the run that was doing the work is gone. Told what it interrupted, it can answer and then carry on; without this
  // the plan would sit in the project unread while the model dealt with the new request and stopped.
  const planNote = planBriefingFor(await readPlan(workRoot, conversation.id).catch(() => null), executionMode === 'cli' ? conversation.id : undefined);
  if (planNote) effectivePrompt = `${planNote}\n\n${effectivePrompt}`;
  const historyTurns = conversation.compaction
    ? conversation.turns.slice(conversation.compaction.throughTurnIndex + 1)
    : conversation.turns;
  const preparedRequest: AgentRunRequest = { ...request, prompt: effectivePrompt };
  /*
   * Whether this run has to carry the standing rules itself, or whether they are already going with it.
   *
   * A CLI run carries the current rules on every turn, including resumed sessions where the model may have compacted
   * earlier context. The API context block already carries them every turn, so it does not need a second copy.
   *
   * The test is what is actually being sent rather than "is this the first turn". It used to ask whether any turn in
   * the history contained the rules — and those turns hold the request as the person wrote it, never the briefed
   * prompt, so the answer was always no and every API request carried the whole rule set twice: once in the context
   * block and once in front of the request: eighteen kilobytes — about 2,800 words — twice, on every turn of every
   * API run, and most runs are API runs.
   */
  const rulesInContext = contextText.includes(RULES_MARKER) || contextText.includes('Cognitive1 standing instructions');
  const carried = historyTurns.some((turn) => (turn.text ?? '').includes(RULES_MARKER));
  const carryRules = shouldCarryRules({
    execution: executionMode,
    resumeSessionId,
    rulesInContext,
    historyCarriesRules: carried,
  });
  const requestWithRules = carryRules
    ? applyExecutionRulesToRequest(preparedRequest, rulesBriefing)
    : preparedRequest;
  // API runs load these themselves; a CLI run needs them on the request so the harness flags it can express are set.
  const executionRequest: AgentRunRequest = scopeConversationRequest(conversation, preferences?.automation?.permissionRules?.length
    ? { ...requestWithRules, permissionRules: preferences.automation.permissionRules }
    : requestWithRules);
  // Visible in the conversation itself, not just true in the code: asked plainly, this answers it without
  // anyone having to trust that `shouldCarryRules` did the right thing.
  const rulesNotice: PersistedEvent = {
    schemaVersion: 1,
    id: `evt_${crypto.randomUUID()}`,
    taskId: conversation.id,
    timestamp: new Date().toISOString(),
    agent: request.agent,
    type: 'notice',
    message: carryRules
      ? `Standing execution rules (${(authoritativeRules.match(/^\d+\.\s+\*\*/gm) ?? []).length} rules from Cognitive1) were included in this turn.`
      : 'Standing execution rules are already carried in this turn’s context, so they were not sent twice.',
  };
  // Each Architect and Implementer step is built from the brief, the task and the corrections, all in its prompt, so it
  // starts clean: the earlier steps' transcript was only ever noise to it, and cost tokens on every round.
  const stepOnly = executionMode === 'api' && Boolean(request.splitRole) && historyTurns.length > 0;
  // A local model is slowed by every token it is sent, so it is given the recent turns that fit a budget and reads the
  // rest with read_history. The budget is a share of the size it compacts at, since that is what it can comfortably hold.
  const windowBudget = !leadConversationRun && executionMode === 'api' && !request.splitRole && runProvider && isLocalProvider(runProvider)
    ? Math.max(2_000, Math.floor(compactThresholdFor(settings.usageBudget, runProvider, modelContextFor(settings, runModel)) * 0.4))
    : 0;
  const apiHistory = stepOnly
    ? [{ ...historyTurns[historyTurns.length - 1], text: effectivePrompt }]
    : executionMode === 'api' && historyTurns.length > 0
    ? windowedHistory([
        // Earlier turns carry what they actually did, not just what they said — see `buildTurnDigest`. Without
        // this a follow-up message only ever saw the previous turn's closing prose and had no idea which files
        // were already read or changed, or what a command it ran had printed.
        ...historyTurns.slice(0, -1).map((turn) => ({
          role: turn.role,
          text: turn.toolDigest ? `${turn.text}\n\n[What this turn actually did]\n${turn.toolDigest}` : turn.text,
        })),
        { ...historyTurns[historyTurns.length - 1], text: effectivePrompt },
      ], windowBudget)
    : undefined;
  // A model picked for this run wins; otherwise KAI sizes the request, and the Settings model is the last resort.
  // An agent that keeps getting a level of work wrong is handed that level's work one tier up.
  // A model name that plainly belongs to another agent (a Codex model on a Claude run) would make the CLI refuse the
  // run before it starts, so it is dropped here and the run falls back to the sized or default model instead.
  const chosenModel = request.model && executionMode === 'cli' && modelBelongsToOtherAgent(request.agent, request.model)
    ? undefined
    : request.model;
  const recentScores = executionMode === 'cli' && !chosenModel ? await context.runScores.list() : [];
  const autoPick = executionMode === 'cli' && !chosenModel
    ? autoCliModel(request, settings, selectedPaths.length, (level, agent) => escalatedLevel(level, agent, recentScores))
    : undefined;
  let execution: AgentExecutionResult;
  // CLI runs claim the project so other agents see the work; API runs are claimed by their memory session.
  const claimedProject = executionMode === 'cli' && (await cognitive1Ready(context))
    ? await memoryProjectName(context, project.path, project.name)
    : null;
  if (claimedProject) {
    await context.cognitive1.operation({
      operation: 'active-claim',
      payload: { agent: request.agent, project: claimedProject, what: conversation.title, files: selectedPaths.join(',') },
    }).catch(() => undefined);
  }
  // Last gate before anything is claimed, announced or launched: a Stop that arrived while the project outline was
  // being built has to be honoured here, or the run starts anyway and the stop is lost.
  if (stopped()) return stoppedResult();
  // Announced once the turn is on disk and everything that could still refuse the run is behind us, so a window
  // that takes it up fetches a record that already holds the request.
  announceRunState(context, conversation.id, 'started');
  context.notifications.runStarted(conversation.id);
  const runOpenedFrom = Date.now();
  const inACopy = options.cwd !== undefined || isParallelCopy(workRoot);
  runsWorkingIn.set(workRoot, (runsWorkingIn.get(workRoot) ?? 0) + 1);
  const recordDeliveredInterjections = (): number => {
    const messages = takeDeliveredInterjections(conversation.id);
    // The transcript shows what the person typed and the images they attached, not the context built for the model.
    for (const message of messages) conversation.turns.push({
      id: `turn_${crypto.randomUUID()}`,
      role: 'user',
      text: message.text,
      createdAt: new Date().toISOString(),
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    });
    return messages.length;
  };
  const fileFollow = leadConversationRun ? null : await followRunFiles(workRoot, request, emit);
  try {
    if (executionMode === 'api') setInterjectionActive(conversation.id, true);
    execution = executionMode === 'api'
      ? await context.directApi.run(
          executionRequest,
          workRoot,
          resumeSessionId,
          emit,
          approvals,
          contextText,
          apiHistory,
          preferences?.customPermissions,
        )
      : await context.agents.run(executionRequest, workRoot, resumeSessionId, emit, preferences?.customPermissions, chosenModel ?? autoPick?.model ?? settings.agentModels[request.agent], autoPick?.note, chipContext.imagePaths);

    if (executionMode === 'cli' && resumeSessionId && isUnavailableCliSession(execution)) {
      // Some CLIs remove or expire sessions outside KAI. If resume failed before the agent produced any work, start
      // fresh with a handoff and the full static context instead of making the person retry manually.
      const freshContext = await buildConversationContext(
        context,
        workRoot,
        project.name,
        project.id,
        conversation,
        request.prompt,
        undefined,
        selectedPaths,
        conversation.compaction,
        false,
        true,
        memoryBudget,
        undefined,
        coachRepoMapMaxCharacters,
      );
      const handoff = renderConversationHandoff(conversation.turns.slice(0, -1), leadConversationRun);
      const promptBody = planNote ? `${planNote}\n\n${promptWithoutProjectContext}` : promptWithoutProjectContext;
      const freshPrompt = `${handoff ? `${handoff}\n\n` : ''}${freshContext.text}\n\n[USER REQUEST]\n${promptBody}`;
      const freshRequest = { ...executionRequest, prompt: freshPrompt };
      const retryRequest = carryRules ? applyExecutionRulesToRequest(freshRequest, rulesBriefing) : freshRequest;
      snapshotProjectContext = freshContext;
      resumeSessionId = undefined;
      execution = await context.agents.run(
        retryRequest,
        workRoot,
        undefined,
        emit,
        preferences?.customPermissions,
        chosenModel ?? autoPick?.model ?? settings.agentModels[request.agent],
        autoPick?.note,
        chipContext.imagePaths,
      );
      execution.events.unshift({
        schemaVersion: 1,
        id: `evt_${crypto.randomUUID()}`,
        taskId: conversation.id,
        timestamp: new Date().toISOString(),
        agent: request.agent,
        type: 'notice',
        message: 'The saved CLI session was unavailable, so KAI restarted with a conversation handoff and rebuilt project context.',
      });
    }

    // A CLI run is a single process, so an agent that stops with its plan unfinished simply stops — unlike the Direct
    // API path, which loops inside the run and can push it to carry on. The only way to continue here is to invoke the
    // agent again with the outstanding items, which is what this does.
    //
    // Bounded, and only after a run that finished cleanly: a run that failed or was cancelled stopped for a reason,
    // and asking it to carry on would be arguing with the person. Each round is a full invocation, so the cap is low.
    if (executionMode === 'cli') {
      execution = await continueWhilePlanOpen(workRoot, conversation.id, execution, (prompt, sessionId) => context.agents.run(
        { ...executionRequest, prompt },
        workRoot,
        sessionId ?? resumeSessionId,
        emit,
        preferences?.customPermissions,
        chosenModel ?? autoPick?.model ?? settings.agentModels[request.agent],
        autoPick?.note,
        chipContext.imagePaths,
      ));
    }
    if (fileFollow) execution.events.push(...await fileFollow.stop());
    await Promise.all([...liveDiffRefreshes, ...liveDiffTasks.values()]);
    execution.events.push(...liveDiffEvents);
  } catch (error) {
    // A run that threw never reaches the save at the end, so it is announced here instead: a window left believing
    // the conversation is still running would show a spinner and a Stop button for work that is already over.
    announceRunState(context, conversation.id, 'finished');
    if (recordDeliveredInterjections() > 0) {
      conversation.updatedAt = new Date().toISOString();
      await context.conversations.save(conversation);
    }
    throw error;
  } finally {
    await fileFollow?.stop();
    context.notifications.runEnded(conversation.id);
    context.runControl.forget(conversation.id);
    // What the run opened is closed before anything else touches the folder: a card's check starts its own app in the
    // copy next, and would be closed too if this ran later. In the project itself it waits for the last run there.
    const stillWorking = (runsWorkingIn.get(workRoot) ?? 1) - 1;
    if (stillWorking > 0) runsWorkingIn.set(workRoot, stillWorking); else runsWorkingIn.delete(workRoot);
    if (inACopy || stillWorking === 0) await closeWhatARunOpened(workRoot, runOpenedFrom, inACopy).catch(() => 0);
    // Anything still waiting came too late to reach the run it was meant for, and handing it to the next one would be
    // answering a question nobody is asking any more.
    clearInterjections(conversation.id);
    await context.recovery.end(conversation.id).catch(() => undefined);
    // Released on every exit path: completion, failure, cancellation and thrown errors.
    if (claimedProject) await releaseAgentClaim(context, request.agent);
    // Only when this level created it. An enclosing automation's controller outlives any one of its turns.
    if (ownedStop) automationRuns.delete(request.conversationId);
  }
  memoryEvents.push({
    schemaVersion: 1,
    id: `evt_${crypto.randomUUID()}`,
    taskId: conversation.id,
    timestamp: new Date().toISOString(),
    agent: request.agent,
    type: 'context.snapshot',
    delivery: executionMode,
    totalCharacters: snapshotProjectContext.preview.totalCharacters,
    estimatedTokens: snapshotProjectContext.preview.estimatedTokens,
    projectContextText: snapshotProjectContext.text.slice(0, 2_000_000),
    projectContextTextTruncated: snapshotProjectContext.text.length > 2_000_000,
    sections: snapshotProjectContext.preview.sections,
    supplementalSources: [...snapshotSupplementalSources, ...[deferredToolSummary(execution.events as Array<{ type: string } & Record<string, unknown>>)].filter((line): line is string => Boolean(line))].slice(0, 50),
  });
  recordDeliveredInterjections();
  if (executionMode === 'api' && execution.status === 'failed') {
    // The session still has to be closed either way; only what the brain is told differs, because a run the person
    // stopped is not a run that broke.
    // Told to the brain as a courtesy, like the lesson filed below: a brain that is slow or down must not cost the
    // run its saved turn, which is what an unguarded throw here would do.
    const ended = await finishMemorySession(
      context,
      conversation.id,
      execution.cancelled
        ? 'Session ended because the run was stopped.'
        : `Session ended after agent failure: ${execution.error || 'unknown error'}`,
    ).catch((error: unknown) => {
      context.logger.warn('internal', 'Could not close the C1 memory session', messageOf(error));
      return null;
    });
    if (ended) execution.events.push(ended);
  }
  execution.events.unshift(
    rulesNotice,
    ...(compactionNotice ? [{ schemaVersion: 1 as const, id: `evt_${crypto.randomUUID()}`, taskId: conversation.id, timestamp: new Date().toISOString(), agent: request.agent, type: 'notice' as const, message: compactionNotice }] : []),
    ...memoryEvents,
  );
  resolvePendingApprovals(context, conversation.id, false);
  // Files may have changed, so the next run's project outline must be rebuilt.
  invalidateRepoMap(workRoot);
  for (const check of agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)) {
    // The recorded run knows the commit the check ran against; the brain gets it below so a regression can be
    // traced to the change behind it rather than filed against "unknown".
    if (conversation.goal) check.task = { id: conversation.goal.id, outcome: conversation.goal.outcome };
    const recorded = await recordVerification(context.verification, project.id, project.path, check).catch(() => null);
    // Reporting the totals to C1 is a courtesy, like the lesson filed below it: the brain being slow or down must
    // not cost the run its saved turn, which is what a throw here would do.
    await logRegression(context, project.path, project.name, check, recorded?.head).catch(() => undefined);
  }
  conversation.updatedAt = new Date().toISOString();
  if (checkpoint) {
    const files = await diffFromCheckpoint(workRoot, checkpoint).catch(() => []);
    userTurn.fileChanges = files;
    execution.events.push({
      schemaVersion: 1,
      id: `evt_${crypto.randomUUID()}`,
      taskId: conversation.id,
      turnId: userTurn.id,
      timestamp: conversation.updatedAt,
      agent: request.agent,
      type: 'turn.changes',
      files,
      hasCheckpoint: true,
    });
  }
  // The brain hears what the run did, not just that a session came and went; Overwatch then judges the draft.
  if (conversation.leadHandoffs?.length && conversation.origin?.kind !== 'lead') {
    userTurn.fileSnapshot = await captureTurnFileEvidence(workRoot, userTurn.fileChanges ?? [], execution.events);
  }
  //
  // Guarded, and it matters that it is: this runs before the turn is saved, so a brain that refused the write used to
  // take the whole turn with it — no reply kept, and no announcement that the run had ended.
  // The Architect only plans and reviews, so it has nothing to teach the brain; the step's own prompt is KAI's wording,
  // so the lesson names the person's request instead (see `taskText`).
  const lessonEvent = request.splitRole === 'architect' ? null : await fileRunLesson(context, {
    conversationId: conversation.id,
    agent: request.agent,
    projectPath: project.path,
    projectName: project.name,
    ...(conversation.goal ? { taskId: conversation.goal.id, taskOutcome: conversation.goal.outcome } : {}),
    prompt: request.taskText ?? userTurn.text,
    output: execution.output ?? '',
    status: execution.status,
    error: execution.error,
    files: (userTurn.fileChanges ?? []).map((change) => change.path),
    checks: agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)
      .map((check) => ({ command: check.command, passed: check.exitCode === null ? null : check.exitCode === 0 })),
  }).catch((error: unknown) => {
    context.logger.warn('internal', 'Could not file the run lesson with C1', messageOf(error));
    return null;
  });
  if (lessonEvent) execution.events.push(lessonEvent);
  // The model's own account when it gave one. When it did not, the run used to end in silence — commands in the
  // activity list and nothing saying what they added up to — so KAI states the outcome from the facts it holds.
  // What the plan still lists. Said either way, because a model's own account describes what it did and reliably
  // leaves out what it did not get to — which is the half the reader needs to decide what happens next.
  const remaining = openPlanItems(await readPlan(workRoot, conversation.id).catch(() => null)).map((item) => item.text);
  const spoken = execution.output?.trim();
  // A failed run's own words are usually the symptom — an exit code, a stderr tail, "the provider returned no
  // output" — so KAI names the cause under them when it can tell what it was.
  const diagnosis = diagnoseRun({
    status: execution.status,
    error: execution.error,
    events: execution.events as Array<{ type?: string; name?: string; status?: string; message?: string }>,
  });
  const closing = [
    spoken
      ? [spoken, outstandingLine(remaining)].filter(Boolean).join('\n\n')
      : describeRunOutcome({
          status: execution.status,
          files: (userTurn.fileChanges ?? []).map((change) => change.path),
          checks: agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)
            .map((check) => ({ command: check.command, passed: check.exitCode === null ? null : check.exitCode === 0 })),
          error: execution.error,
          remaining,
        }),
    diagnosis ? diagnosisLine(diagnosis) : null,
  ].filter(Boolean).join('\n\n');
  const closingText = plainDashes(closing);
  const toolDigest = buildTurnDigest(execution.events);
  // Only the model's own words count as a question — the synthesized `describeRunOutcome` fallback never is one —
  // and only a run that actually finished: a failed or cancelled run did not stop because it was asking anything.
  const awaitingAnswer = execution.status === 'completed' && Boolean(spoken) && awaitsTheUser(spoken!);
  conversation.turns.push({
    id: `turn_${crypto.randomUUID()}`,
    role: 'assistant' as const,
    text: closingText,
    createdAt: conversation.updatedAt,
    ...(execution.generatedImages?.length ? { generatedImages: execution.generatedImages } : {}),
    ...(awaitingAnswer ? { awaitingAnswer: true } : {}),
    ...(toolDigest ? { toolDigest } : {}),
  });
  conversation.events.push(...execution.events.map((event) => (
    event.type !== 'text.delta' && eventOffsets.has(event.id) ? { ...event, textOffset: eventOffsets.get(event.id)! } : event
  )));
  conversation.agentSessionId = execution.sessionId;
  try {
    await context.conversations.save(conversation);
  } finally {
    // Announced once the turn it produced is on disk — a window that did not run this pulls the record when it hears
    // the run is over, and pulling it before the save would show a reply that stops at the user's own message.
    //
    // In a `finally` because the save can fail: a full disk, a locked file, a record written by something else. Left
    // unguarded, that skipped the announcement entirely and the window kept its spinner and Stop button for work that
    // was already over — nothing on screen saying the run had ended, and no way to ask it to. A record that did not
    // save is bad; a run nobody can tell has finished is worse, and it is the one the person cannot work around.
    announceRunState(context, conversation.id, 'finished');
  }

  // Keep a local, redacted record of observable work only (never hidden reasoning). Content capture is separately
  // controlled by the user's privacy setting; metadata-only records still support reliability/evaluation metrics.
  const capture = settings.experienceCapture;
  if (capture.enabled) {
    const verification = agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)
      .map((check) => ({ command: check.command, passed: check.exitCode === null ? null : check.exitCode === 0, detail: check.output }));
    const contentDiff = capture.includeContent && checkpoint
      ? await textDiffFromCheckpoint(workRoot, checkpoint).catch(() => '')
      : '';
    const changes: Array<{ path: string; additions: number; removals: number; patch?: string }> = (userTurn.fileChanges ?? []).map((change) => ({
      path: change.path,
      additions: change.added,
      removals: change.removed,
    }));
    if (contentDiff && changes.length) changes[0] = { ...changes[0]!, patch: contentDiff };
    const outcome = execution.cancelled
      ? 'cancelled'
      : execution.status === 'completed'
        ? verification.length > 0 && verification.every((check) => check.passed === true) ? 'verified' : 'unverified'
        : 'failed';
    const experience = makeAgentExperience({
      schemaVersion: 1,
      id: `exp_${crypto.randomUUID()}`,
      createdAt: conversation.updatedAt,
      projectId: project.id,
      conversationId: conversation.id,
      request: userTurn.text,
      response: execution.output ?? '',
      agent: request.agent,
      execution: executionMode,
      ...(request.model ? { model: request.model } : {}),
      outcome,
      verification,
      changes,
      reviewedForTraining: false,
    }, capture.includeContent);
    await context.experiences.add(experience, capture.retentionDays).catch((error) => {
      context.logger.warn('internal', 'Could not save local agent experience', error instanceof Error ? error.message : String(error));
    });
  }

  const cancelled = execution.cancelled === true;
  void context.notifications.notifyRunFinished(
    conversation.id,
    conversation.title,
    cancelled ? 'cancelled' : execution.status,
    execution.error,
    ownerWindowId ?? undefined,
  );
  if (executionMode === 'api') {
    const usage = summarizeUsageFromRuns(await paidRunsFor(context), settings.usageBudget, new Date(), conversation.id);
    void context.notifications.notifyBudget(conversation.id, usage.limits);
  }

  if (cancelled) {
    context.logger.info('internal', `Agent ${request.agent} (${executionMode}) stopped`, conversation.title);
  } else if (execution.error) {
    context.logger.error('agent_crash', `Agent ${request.agent} (${executionMode}) failed`, execution.error);
  } else {
    context.logger.info('internal', `Agent ${request.agent} (${executionMode}) completed`, conversation.title);
  }

  // An audit run files its own report here, whoever started it — the composer's Security Auditor intent, the
  // Learn panel, or any other caller that selected the skill. Auto only carries `skills` on its first turn, so the
  // conversation's own text is checked too; that is what lets an API run's final turn file its report, since it
  // has no MCP tools. The MCP tool may have saved the same records already; the fingerprint makes that an update
  // rather than a duplicate.
  const securityAudit = request.skills?.includes('security-auditor')
    || conversation.turns.some((turn) => turn.role === 'user' && /\$security-auditor\b|security-auditor skill/i.test(turn.text));
  if (securityAudit && !cancelled && execution.status === 'completed') {
    await fileSecurityReport(context, execution.output, { projectPath: workRoot }).catch((error) => {
      context.logger.warn('internal', 'Could not file the security audit report', error instanceof Error ? error.message : String(error));
    });
  }

  return {
    conversation,
    status: execution.status,
    output: execution.output,
    error: execution.error,
    ...(cancelled ? { cancelled: true } : {}),
    ...('signInRequired' in execution && execution.signInRequired ? { signInRequired: true } : {}),
    ...costResult(execution.events),
  };
}

function costResult(events: ReadonlyArray<Record<string, unknown>>): { costUsd?: number } {
  const values = events.flatMap((event) => (typeof event.amountUsd === 'number' ? [event.amountUsd] : []));
  return values.length > 0 ? { costUsd: values.reduce((total, value) => total + value, 0) } : {};
}

/** Send test totals to Cognitive1's regression history when the runner's summary could be read. */
async function logRegression(
  context: IpcContext,
  projectPath: string,
  projectName: string,
  check: RecordedCheck,
  /** The commit the check ran against, so a regression can be traced to the change that caused it. */
  commit?: string | null,
): Promise<void> {
  const counts = parseTestCounts(check.output);
  if (counts.passed === null || !(await cognitive1Ready(context))) return;
  await context.cognitive1.tool({
    tool: 'regression_log',
    arguments: {
      project: await memoryProjectName(context, projectPath, projectName),
      passed: counts.passed,
      failed: counts.failed ?? 0,
      notes: `${check.source}: ${check.command}`.slice(0, 300),
      agent: 'kai-desktop',
      // Without this the brain files every regression against "unknown", which is what it did until now.
      ...(commit ? { commit } : {}),
    },
  }).catch(() => undefined);
}

/**
 * Files a short account of a finished run into C1's draft queue. It is deliberately forgiving: the brain being down,
 * slow or unconfigured must never fail or delay the run it is describing.
 */
async function fileRunLesson(
  context: IpcContext,
  run: RunLessonInput & { conversationId: string; agent: AgentId; projectPath: string; projectName: string },
): Promise<PersistedEvent | null> {
  // What KAI knows about the project is kept locally and does not depend on the brain being up, so it is written first.
  // A run the person stopped says nothing about the project, so it is left out, as it is for the brain.
  const stopped = run.status === 'failed' && /cancell?ed|abort|interrupted|stopped/i.test(run.error ?? '');
  if (!stopped && (run.files.length > 0 || run.status === 'failed')) {
    const checked = run.checks.filter((check) => check.passed !== null);
    void recordRunKnowledge(run.projectPath, {
      at: new Date().toISOString(),
      ...(run.taskId ? { taskId: run.taskId, taskOutcome: run.taskOutcome } : {}),
      task: run.prompt,
      outcome: run.status === 'completed' ? 'completed' : 'failed',
      files: run.files.slice(0, 12),
      checks: checked.length === 0 ? 'none' : checked.every((check) => check.passed) ? 'passed' : 'failed',
      // Keep the local account short and redact common credential forms before it reaches persistent project memory.
      summary: run.output
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
        .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
    }).catch(() => undefined);
  }
  const lesson = composeRunLesson(run);
  if (!lesson || !(await cognitive1Ready(context))) return null;
  try {
    // The daemon answers 200 with `ok: false` when its own quality gate turns the draft away.
    const result = (await context.cognitive1.operation({
      operation: 'brain-auto-learn',
      payload: {
        source: 'session',
        // The first line remains the draft title; the marker follows it so C1 carries the run ID into its draft,
        // learned entry and rejection record without needing a moving queue index.
        summary: [
          lesson.summary.slice(0, lesson.summary.indexOf('\n')),
          `KAI Run ID: ${run.conversationId}`,
          ...(run.taskId ? [`KAI Goal ID: ${run.taskId}`, `Goal: ${run.taskOutcome ?? ''}`] : []),
          lesson.summary.slice(lesson.summary.indexOf('\n') + 1),
        ].join('\n'),
        files: lesson.files,
        project: await memoryProjectName(context, run.projectPath, run.projectName),
        agent: run.agent,
      },
    })) as { ok?: boolean; reason?: string } | null;
    if (result?.ok === false) {
      // The brain judged the draft unworthy and said why. Dropping that left the run looking as though it had been
      // filed, or as though the brain had been asked and had nothing to say — and "why did that run not go into the
      // brain?" had no answer anywhere.
      context.logger.info('internal', `C1 did not take this run's lesson: ${result.reason || 'its quality gate turned it away'}`);
      return null;
    }
    return memoryEvent(run.conversationId, run.agent, 'learn', 'Filed what this run did as a draft in C1 for review.');
  } catch (error) {
    context.logger.warn('internal', 'Could not file the run in C1', messageOf(error));
    return null;
  }
}

async function releaseAgentClaim(context: IpcContext, agent: string): Promise<void> {
  if (!(await cognitive1Ready(context))) return;
  await context.cognitive1.operation({ operation: 'active-release', payload: { agent } }).catch(() => undefined);
}

async function coordinationOverview(context: IpcContext) {
  if (!(await cognitive1Ready(context))) return { available: false, claims: [], urgent: [] };
  const [status, urgent] = await Promise.all([
    context.cognitive1.operation({ operation: 'status' }).catch(() => null),
    context.cognitive1.operation({ operation: 'urgent-list' }).catch(() => null),
  ]);
  return { available: true, claims: parseActiveClaims(status), urgent: parseUrgentNotes(urgent) };
}

/** Warn-only: asks Cognitive1 whether another agent has claimed any of these files. */
async function coordinationPreflight(context: IpcContext, projectId: string, files: readonly string[]) {
  if (files.length === 0 || !(await cognitive1Ready(context))) return { checked: false, conflicts: [] };
  const project = await resolveProject(context, projectId, true);
  try {
    const result = await context.cognitive1.tool({
      tool: 'conflict_check',
      arguments: { files: files.join(','), project: await memoryProjectName(context, project.path, project.name) },
    });
    return { checked: true, conflicts: parseConflictText(mcpText(result)) };
  } catch {
    return { checked: false, conflicts: [] };
  }
}

/**
 * What the saved conversations have cost so far: the usage ledger's paid runs when there is one, so nothing is loaded.
 * Without a ledger (a test, or a build that has not wired one) the conversations are read, once for everyone asking
 * within a few seconds.
 */
async function conversationPaidRuns(context: IpcContext): Promise<ExternalPaidRun[]> {
  if (context.usageLedger) return context.usageLedger.runs();
  return collectPaidRuns(await sharedLoad(context.conversations, () => context.conversations.list(), USAGE_SNAPSHOT_MS));
}

/** Everything spent so far: the saved conversations plus Learning Mode's own usage. */
async function paidRunsFor(context: IpcContext): Promise<ExternalPaidRun[]> {
  return [...(await conversationPaidRuns(context)), ...(await context.learningUsage.runs())];
}

async function globalSearch(context: IpcContext, query: string) {
  const needle = query.toLowerCase();
  const hits: import('@kai/contracts').GlobalSearchHit[] = [];
  for (const conversation of await context.conversations.list()) {
    if (hits.length >= 8) break;
    const inTitle = conversation.title.toLowerCase().includes(needle);
    const turn = inTitle ? undefined : conversation.turns.find((item) => item.text.toLowerCase().includes(needle));
    if (!inTitle && !turn) continue;
    hits.push({
      source: 'conversation',
      label: conversation.title || 'Untitled conversation',
      detail: turn ? turn.text.replace(/\s+/g, ' ').slice(0, 120) : conversation.updatedAt,
      conversationId: conversation.id,
    });
  }
  const brainSearched = await cognitive1Ready(context);
  if (brainSearched) {
    try {
      const result = await context.cognitive1.tool({ tool: 'recall', arguments: { query, scope: 'all', max_results: 8 } });
      for (const hit of parseRecallText(mcpText(result))) hits.push(hit);
    } catch {
      // Brain search is best effort; conversation matches are still returned.
    }
  }
  return { query, brainSearched, hits };
}

/**
 * The record for an interrupted run, or the reason there is none. A record that exists but cannot be parsed is
 * told apart from one that is gone, because "no longer available" is the wrong thing to say about a file that is
 * sitting right there — and it is the answer a person would try again and again.
 */
async function requireRecoveryRecord(context: IpcContext, conversationId: string) {
  const outcome = await context.recovery.readOutcome(conversationId);
  if (outcome.kind === 'unreadable') {
    throw new Error('This run\'s record is damaged and cannot be read, so there is nothing to resume. Discard it, or use Stop everything on the Operations screen.');
  }
  if (outcome.kind === 'missing') throw new NotFoundError('That interrupted run is no longer available.');
  return outcome.record;
}

async function interruptedRunRecap(context: IpcContext, conversationId: string) {
  const record = await requireRecoveryRecord(context, conversationId);
  const project = record.projectId ? (await context.projects.list()).find((item) => item.id === record.projectId) : undefined;
  const changedFiles = record.checkpoint && project
    ? (await diffFromCheckpoint(project.path, record.checkpoint).catch(() => [])).map((file) => file.path)
    : [];
  let brainRecap: string | null = null;
  if (await cognitive1Ready(context)) {
    try {
      brainRecap = JSON.stringify(await context.cognitive1.operation({ operation: 'recover', payload: { project: project?.name ?? '' } }), null, 2).slice(0, 4_000);
    } catch {
      brainRecap = null;
    }
  }
  return { conversationId, recap: buildRecap(record, changedFiles), brainRecap };
}

async function prepareMemorySession(
  context: IpcContext,
  conversation: ConversationRecord,
  request: AgentRunRequest,
  projectPath: string,
  projectName: string,
  previousAgent: AgentId | null,
  previousExecution: NonNullable<ConversationRecord['execution']>,
  events: PersistedEvent[],
  budget?: MemoryBudget,
): Promise<void> {
  if (!(await cognitive1Ready(context))) return;
  const limited = async <T>(work: Promise<T>): Promise<T | null> => (budget ? budget.run(work) : work);

  const active = context.memorySessions.get(conversation.id);
  if (
    previousAgent &&
    previousAgent !== request.agent &&
    previousExecution === 'api' &&
    active?.agent !== request.agent
  ) {
    try {
      const recorded = await limited(context.cognitive1.recordHandoff({
        fromAgent: previousAgent,
        toAgent: request.agent,
        project: projectName,
        status: `Agent switch in "${conversation.title}"`,
        next: taskSummary(request.prompt),
        files: changedFilePaths(conversation).join(', '),
        notes: `Continue the conversation with ${request.agent}.`,
      }));
      if (recorded) {
        events.push(memoryEvent(
          conversation.id,
          request.agent,
          'handoff',
          `Recorded a C1 handoff from ${previousAgent} to ${request.agent}.`,
        ));
      }
    } catch (error) {
      context.logger.error('service_error', 'C1 handoff recording failed', undefined, error);
    }
  }

  if (active?.agent === request.agent && active.projectPath === projectPath) return;
  try {
    const session = await limited(context.cognitive1.startSession({
      agent: request.agent,
      projectPath,
      task: taskSummary(request.prompt),
    }));
    // No session was opened, so none is recorded: a memory session KAI believes is open but the brain never started
    // would be ended later against nothing.
    if (!session) {
      context.logger.warn('internal', 'C1 session start did not finish in time; the run continues without one');
      return;
    }
    context.memorySessions.set(conversation.id, {
      agent: request.agent,
      conversationId: conversation.id,
      projectName: session.project || projectName,
      projectPath,
    });
    events.push(memoryEvent(
      conversation.id,
      request.agent,
      'session_start',
      session.briefed
        ? `Started C1 session in ${session.project || projectName}.`
        : `Continued C1 session in ${session.project || projectName}.`,
    ));
    /*
     * The two things the brain says back that KAI was throwing away.
     *
     * `briefing` is what the brain knows about this project that the run ought to see, and `conflicts` is another
     * agent holding the same work right now. Both were parsed into the client's own type and then read by nothing,
     * so a run could start on a file another agent had claimed with no sign of it anywhere.
     */
    if (session.briefing?.trim()) {
      events.push(memoryEvent(conversation.id, request.agent, 'session_start', session.briefing.trim().slice(0, 1_500)));
    }
    for (const conflict of session.conflicts.slice(0, 5)) {
      context.logger.warn('internal', `${conflict.agent} is already working on ${conflict.what}`);
      events.push(memoryEvent(
        conversation.id,
        request.agent,
        'session_start',
        `${conflict.agent} is already working on ${conflict.what}.`,
      ));
    }
  } catch (error) {
    context.logger.error('service_error', 'C1 session start failed', undefined, error);
  }
}

/** A preloaded file longer than this is outlined for a model on the person's own hardware. */
const LEAN_FILE_CHARACTERS = 6_000;

async function buildConversationContext(
  context: IpcContext,
  projectPath: string,
  projectName: string,
  projectId: string,
  conversation: ConversationRecord | null,
  prompt: string,
  authoritativeRules?: string,
  selectedPaths: readonly string[] = [],
  compaction?: ConversationRecord['compaction'],
  omitStatic = false,
  includeRepoMap = false,
  budget?: MemoryBudget,
  /** Told what recall did, so the run can say it. Optional: the context preview has nobody to tell. */
  onRecall?: (summary: string) => void,
  repoMapMaxCharacters?: number,
  /** For a model on the person's own hardware: only the files this request names, with large ones as outlines. */
  lean = false,
) {
  const recall = await recallScopedMemories(context, projectPath, projectName, prompt, budget);
  onRecall?.(recall.skipped
    ? SKIPPED_MEMORY_NOTE
    : recall.memories.length === 0
      ? 'The brain had no memories to hand for this run.'
      : `Used ${recall.memories.length} recalled ${recall.memories.length === 1 ? 'memory' : 'memories'} for this run.`);
  const filesInPlay = [...new Set([...changedFilePaths(conversation), ...selectedPaths])];
  // What KAI's own runs already did here, chosen by the files this one is about. Read from the scores every scored
  // run writes, so it works with the brain stopped and never leaves the machine.
  const history = await context.runScores.list()
    .then((runs) => buildHistoryNote({ runs, files: filesInPlay, projectId, now: Date.now() }))
    .catch(() => null);
  const designProfile = await context.designProfiles.briefing(projectPath, prompt, filesInPlay);
  // Every file the conversation ever changed, whole, can take most of a small window before the work starts.
  const preload = lean
    ? [...new Set([...namedPaths(prompt, changedFilePaths(conversation)), ...selectedPaths])]
    : filesInPlay.slice(-12);
  const projectContext = await buildProjectContext(projectPath, {
    selectedPaths: preload,
    ...(lean ? { outlineFilesOver: LEAN_FILE_CHARACTERS, skipInjectedRules: Boolean(authoritativeRules) } : {}),
    touchedPaths: filesInPlay,
    memories: recall.memories,
    memoryNote: recall.note,
    authoritativeRules,
    conventions: [context.conventions.briefing(projectPath), designProfile].filter(Boolean).join('\n\n'),
    omitStatic,
    includeRepoMap,
    ...(repoMapMaxCharacters ? { repoMapMaxCharacters } : {}),
    ...(history ? { history } : {}),
  });
  // What KAI has learned about this project leads, on the turns that carry the outline: it is the part an agent would
  // otherwise spend its first minutes working out for itself.
  const learned = includeRepoMap ? await knowledgeBriefing(projectPath, undefined, prompt).catch(() => '') : '';
  // Both come after the project context, which is what stays the same from one message to the next; see renderContext.
  const withKnowledge = learned ? { ...projectContext, text: `${projectContext.text}\n\n${learned}` } : projectContext;
  if (!compaction) return withKnowledge;
  return {
    ...withKnowledge,
    text: `${withKnowledge.text}\n\n${renderCompactionContext(compaction)}`,
  };
}

function fullAccessExecutionBriefing(executionMode: ExecutionMode, terminalTools = false): string {
  const windows = process.platform === 'win32';
  // The Direct API's run_command tool spawns through Git Bash when it is installed (project-tools.ts,
  // agentShell()), not cmd.exe or PowerShell — so the advice below has to match what the command actually runs
  // in. A CLI agent's own shell tool is outside KAI's control and unverified, so it keeps the Windows-specific
  // wording unchanged rather than being told something that may not hold for it. With KAI's terminal offered the
  // agent chooses its shell itself (see terminalBriefing), so no one shell's syntax is dictated here.
  const usesGitBash = windows && executionMode === 'api' && Boolean(findGitBash());
  return [
    '# Full access execution policy',
    'The user explicitly selected Full access for this run. You may edit project files, run shell commands, and, when the user explicitly asks, commit and push changes without requesting an additional confirmation.',
    'Complete the requested workflow yourself. Do not stop after a command error merely to give the user instructions when a safe retry or equivalent command can be run.',
    terminalTools
      ? 'Write each command in the syntax of the shell you run it in.'
      : usesGitBash
        ? 'This is Windows, but your commands run through Git Bash, not cmd.exe or PowerShell. Write ordinary POSIX/Unix-style commands — pipes, `grep`, `tail`, `&&`, `$(...)` all work normally; do not switch to PowerShell syntax.'
        : windows
          ? 'This is Windows. Use Windows-compatible commands. Run build checks directly (for example `npm run build`), never pipe through Unix-only commands such as `tail` or `grep`. If output needs limiting in PowerShell, use `Select-Object -Last N`.'
          : 'Use commands compatible with the current project shell.',
    'For build → commit → push work: make the requested change, run the verification command, fix actionable failures, then commit and push only if the user requested commit/push. Report the command results and commit hash at the end.',
  ].join('\n');
}

function longRunningCommandBriefing(): string {
  return [
    '# Long-running command policy',
    'Development servers are long-lived processes, not verification commands. When the user asks to run `npm run dev`, `npm start`, Vite, Next dev, or an equivalent server, start it in the background, confirm the local URL when possible, and then finish the agent turn.',
    'Never leave a conversation waiting for a dev server to exit and do not describe a timed-out foreground server as successfully running.',
  ].join('\n');
}

/**
 * What a steer carries beside its words: the readable images, and the rest of the composer's context as text.
 *
 * A normal send builds this through `renderContextChips`; a steer used to skip it entirely, so an image attached to a
 * steered message was thrown away and the model was told only to "look at the attached image".
 */
async function interjectionExtras(
  context: IpcContext,
  conversationId: string,
  chips: readonly ContextChip[],
): Promise<InterjectionExtras> {
  if (chips.length === 0) return {};
  const attachments: InterjectionAttachment[] = [];
  for (const chip of chips) {
    if (chip.type !== 'image' || !chip.dataUrl || !parseImageDataUrl(chip.dataUrl)) continue;
    attachments.push({ name: chip.name, dataUrl: chip.dataUrl });
    if (attachments.length >= 6) break;
  }
  const sections: string[] = [];
  const files = chips.filter((chip): chip is Extract<ContextChip, { type: 'file' }> => chip.type === 'file').map((chip) => chip.path);
  if (files.length > 0) sections.push(`Files the user pointed at: ${files.join(', ')}`);
  const textual = chips.filter((chip) => chip.type !== 'image' && chip.type !== 'file');
  if (textual.length > 0) {
    const conversation = await context.conversations.get(conversationId);
    const project = conversation?.projectId ? await resolveProject(context, conversation.projectId, true).catch(() => null) : null;
    // Selections without their own text are read from the project; with no project they are simply left out.
    const rendered = project ? await renderContextChips(project.path, context.paths.attachments, textual).catch(() => null) : null;
    if (rendered?.text) sections.push(rendered.text);
  }
  return { context: sections.join('\n\n'), attachments };
}

export async function renderContextChips(
  projectPath: string,
  attachmentsRoot: string,
  chips: readonly ContextChip[],
): Promise<{ text: string; imagePaths: string[] }> {
  if (chips.length === 0) return { text: '', imagePaths: [] };
  const sections: string[] = [];
  const imagePaths: string[] = [];
  for (const chip of chips) {
    if (chip.type === 'file') continue;
    if (chip.type === 'selection') {
      const selection = chip.content?.trim() || await readProjectSelection(projectPath, chip.path, chip.startLine, chip.endLine);
      if (selection) {
        sections.push(`### Selection: ${chip.path}:${chip.startLine}-${chip.endLine}\n${selection.slice(0, 100_000)}`);
      }
      continue;
    }
    if (chip.type === 'terminal') {
      sections.push(`### Terminal output\n${chip.content.slice(0, 100_000)}`);
      continue;
    }
    if (chip.type === 'gitDiff') {
      sections.push(`### Uncommitted changes\n${chip.stat.slice(0, 100_000)}`);
      continue;
    }
    if (chip.type === 'memory') {
      sections.push(`### Memory search: ${chip.query}\n${chip.summary.slice(0, 100_000)}`);
      continue;
    }
    if (chip.type === 'attachment') {
      const root = await fs.realpath(attachmentsRoot).catch(() => path.resolve(attachmentsRoot));
      const target = await fs.realpath(chip.path).catch(() => '');
      if (!target || !insideRoot(root, target) || !(await fs.stat(target)).isFile()) {
        throw new Error(`Attached file is unavailable: ${chip.name}`);
      }
      // Staged beside images so a CLI agent's file tools can reach it, and quoted here when it has readable text.
      const staged = await stageAttachmentForCli(projectPath, target);
      const text = await attachmentText(target, chip.name, chip.mimeType);
      sections.push(`### Attached file: ${chip.name}${chip.mimeType ? ` (${chip.mimeType})` : ''}\nPath: ${staged}\n${text
        ? `Contents:\n${text.slice(0, 100_000)}`
        : 'This file is binary or could not be read as text. Use the project tools to inspect the staged path.'}`);
      continue;
    }
    if (chip.type === 'image') {
      const root = await fs.realpath(attachmentsRoot).catch(() => path.resolve(attachmentsRoot));
      const target = await fs.realpath(chip.path).catch(() => '');
      if (!target || !insideRoot(root, target) || !(await fs.stat(target)).isFile()) {
        throw new Error(`Attached image is unavailable: ${chip.name}`);
      }
      // Staged inside the project, not left in KAI's own userData folder: a CLI agent's file tools only trust paths
      // under the project root, so a path outside it is one `--image` (Codex) can still take but a plain file-path
      // mention cannot — every other agent was being told to open a file it had no way to reach.
      const staged = await stageAttachmentForCli(projectPath, target);
      imagePaths.push(staged);
      sections.push(`### Attached image\nName: ${chip.name}\nPath: ${staged}\nThis is visual input. Open the image with an image-capable reader before answering; do not infer its contents from the file name.`);
    }
  }
  return {
    text: sections.length > 0 ? `# Attached context\n${sections.join('\n\n')}` : '',
    imagePaths: [...new Set(imagePaths)],
  };
}

async function readProjectSelection(
  projectPath: string,
  relativePath: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  const root = await fs.realpath(projectPath);
  const target = path.resolve(root, relativePath);
  if (!insideRoot(root, target)) return '';
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isFile() || stats.size > 512 * 1024) return '';
  const content = await fs.readFile(target, 'utf8').catch(() => '');
  if (!content || looksBinary(content)) return '';
  return content.split(/\r?\n/).slice(startLine - 1, Math.max(startLine, endLine)).join('\n');
}

async function listSkills(context: IpcContext, projectId?: string): Promise<SkillSummary[]> {
  const project = await resolveProject(context, projectId);
  return skillSummaries(await discoverDesktopSkills(project?.path));
}

async function chooseProjectFiles(context: IpcContext, projectId: string): Promise<string[]> {
  const project = await resolveProject(context, projectId, true);
  const options: OpenDialogOptions = {
    title: 'Add project files to KAI context',
    defaultPath: project.path,
    buttonLabel: 'Add files',
    properties: ['openFile', 'multiSelections'],
  };
  const owner = context.getMainWindow();
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled) return [];
  const paths: string[] = [];
  for (const selected of selection.filePaths) {
    const resolved = await fs.realpath(path.resolve(selected)).catch(() => null);
    if (!resolved || !insideRoot(project.path, resolved)) continue;
    paths.push(path.relative(project.path, resolved).split(path.sep).join('/'));
  }
  return [...new Set(paths)];
}

async function searchProjectFiles(context: IpcContext, projectId: string, query: string): Promise<string[]> {
  const project = await resolveProject(context, projectId, true);
  const root = await fs.realpath(project.path);
  const needle = query.trim().toLocaleLowerCase();
  const files: string[] = [];
  await collectProjectFilePaths(root, root, files, 0);
  return files
    .map((filePath) => path.relative(root, filePath).split(path.sep).join('/'))
    .filter((relativePath) => !needle || relativePath.toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 40);
}

async function collectProjectFilePaths(
  root: string,
  directory: string,
  files: string[],
  depth: number,
): Promise<void> {
  if (depth > 12 || files.length >= 8_000) return;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= 8_000 || entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) continue;
      await collectProjectFilePaths(root, path.join(directory, entry.name), files, depth + 1);
      continue;
    }
    if (!entry.isFile() || shouldSkipFile(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (insideRoot(root, fullPath)) files.push(fullPath);
  }
}

function shouldSkipDirectory(name: string): boolean {
  return new Set([
    '.git',
    '.hg',
    '.svn',
    '.next',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
    'release',
  ]).has(name.toLocaleLowerCase());
}

function shouldSkipFile(name: string): boolean {
  return /\.(?:exe|dll|so|dylib|zip|7z|rar|tar|gz|png|jpe?g|gif|webp|ico|pdf|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i.test(name);
}

async function gitDiffForProject(context: IpcContext, projectId: string): Promise<{ stat: string; error?: string }> {
  const project = await resolveProject(context, projectId, true);
  if (!(await isGitRepo(project.path))) return { stat: '', error: 'The active project is not a Git repository.' };
  const stat = await gitDiffStat(project.path);
  return { stat: stat || 'No uncommitted changes.' };
}

async function saveAttachment(context: IpcContext, name: string, dataUrl: string): Promise<ContextChip> {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error('Unsupported attachment.');
  const mimeType = (match[1] || 'application/octet-stream').toLowerCase();
  const data = match[2]
    ? Buffer.from(match[3] ?? '', 'base64')
    : Buffer.from(decodeURIComponent(match[3] ?? ''), 'utf8');
  if (data.length === 0 || data.length > 25 * 1024 * 1024) {
    throw new Error('Attachments must be between 1 byte and 25 MB.');
  }
  const safeName = sanitizeAttachmentName(name, 'attachment');
  const imageExtension = /^image\/(png|jpe?g|gif|webp)$/i.exec(mimeType)?.[1].toLowerCase();
  const extension = imageExtension
    ? (imageExtension === 'jpeg' ? 'jpg' : imageExtension)
    : (path.extname(safeName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12)
      || ({ 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json' }[mimeType] ?? '.bin'));
  await fs.mkdir(context.paths.attachments, { recursive: true });
  const id = `${imageExtension ? 'img' : 'file'}_${crypto.randomUUID()}`;
  const filePath = path.join(context.paths.attachments, `${id}${extension.startsWith('.') ? extension : `.${extension}`}`);
  await fs.writeFile(filePath, data);
  if (imageExtension) {
    return { type: 'image', name: safeName, path: filePath, dataUrl };
  }
  return { type: 'attachment', name: safeName, path: filePath, mimeType };
}

function sanitizeAttachmentName(name: string, fallback: string): string {
  const clean = path.basename(name.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 200);
  return clean || fallback;
}

async function reviewCheckpoint(
  context: IpcContext,
  conversationId: string,
  turnId: string,
): Promise<CheckpointReview> {
  const { conversation, turn, project } = await checkpointContext(context, conversationId, turnId);
  if (!turn.checkpoint || !(await isGitRepo(project.path))) {
    return { conversationId: conversation.id, turnId, gitAvailable: false, files: [] };
  }
  const changes = await diffFromCheckpoint(project.path, turn.checkpoint);
  const files = [] as CheckpointReview['files'];
  for (const change of changes.slice(0, 50)) {
    const before = await readFileAtCheckpoint(project.path, turn.checkpoint, change.path).catch(() => '');
    const after = await readProjectText(project.path, change.path).catch(() => '');
    files.push({
      ...change,
      before: before.slice(0, 200_000),
      after: after.slice(0, 200_000),
      binary: looksBinary(before) || looksBinary(after),
    });
  }
  return { conversationId: conversation.id, turnId, gitAvailable: true, files };
}

async function rejectCheckpointFile(
  context: IpcContext,
  conversationId: string,
  turnId: string,
  filePath: string,
): Promise<CheckpointRestoreResult> {
  const { conversation, turn, project } = await checkpointContext(context, conversationId, turnId);
  if (!turn.checkpoint) throw new Error('This turn has no Git checkpoint.');
  const result = await restoreCheckpointFile(project.path, turn.checkpoint, filePath);
  turn.fileChanges = await diffFromCheckpoint(project.path, turn.checkpoint).catch(() => turn.fileChanges ?? []);
  conversation.updatedAt = new Date().toISOString();
  await context.conversations.save(conversation);
  return result;
}

async function rejectCheckpointHunks(
  context: IpcContext,
  conversationId: string,
  turnId: string,
  filePath: string,
  hunkIds: readonly number[],
): Promise<CheckpointRestoreResult> {
  const { conversation, turn, project } = await checkpointContext(context, conversationId, turnId);
  if (!turn.checkpoint) throw new Error('This turn has no Git checkpoint.');
  const before = await readFileAtCheckpoint(project.path, turn.checkpoint, filePath).catch(() => '');
  let current = { content: '', hash: null as string | null, eol: 'lf' as 'lf' | 'crlf', bom: false };
  try {
    const opened = await readProjectFile(project.path, filePath);
    current = { content: opened.content, hash: opened.hash, eol: opened.eol, bom: opened.bom };
  } catch {
    // The agent deleted the file; rejecting a hunk recreates it from the checkpoint.
  }
  const reverted = revertHunks(before, current.content, hunkIds);
  await writeProjectFile(project.path, filePath, reverted, { expectedHash: current.hash, eol: current.eol, bom: current.bom });
  turn.fileChanges = await diffFromCheckpoint(project.path, turn.checkpoint).catch(() => turn.fileChanges ?? []);
  conversation.updatedAt = new Date().toISOString();
  await context.conversations.save(conversation);
  return { restored: [filePath], deleted: [] };
}

/**
 * Copies a conversation up to a chosen turn into a new conversation. The copy has new turn IDs so it can diverge
 * without touching the original, and it starts with no provider session, run events or compaction: none of those
 * refer to the new branch.
 */
async function forkConversation(context: IpcContext, input: ConversationForkInput): Promise<ConversationBranchResult> {
  const original = await context.conversations.get(input.conversationId);
  if (!original) throw new NotFoundError('Conversation not found.');
  const copy = branchedConversation(original, input.throughTurnId);
  await context.conversations.save(copy);
  return { conversation: copy, checkpoint: null };
}

/**
 * Removes a user turn and everything after it, optionally putting the project files back to the checkpoint taken
 * just before that turn. A running conversation is refused: its own turn would be written back afterwards.
 */
async function rewindConversation(context: IpcContext, input: ConversationRewindInput): Promise<ConversationBranchResult> {
  const original = await context.conversations.get(input.conversationId);
  if (!original) throw new NotFoundError('Conversation not found.');
  if (context.directApi.isRunning(input.conversationId) || automationRuns.has(input.conversationId)) {
    throw new ConflictError('Stop the run before rewinding this conversation.');
  }
  const turn = original.turns.find((candidate) => candidate.id === input.turnId);
  if (!turn) throw new NotFoundError('Turn not found.');
  const conversation = rewoundConversation(original, input.turnId);

  let checkpoint: CheckpointRestoreResult | null = null;
  if (input.restoreFiles && turn.checkpoint) {
    const project = await resolveProject(context, conversation.projectId ?? undefined, true);
    checkpoint = await restoreCheckpoint(project.path, turn.checkpoint);
  }

  await context.conversations.save(conversation);
  return { conversation, checkpoint };
}

async function restoreConversationCheckpoint(
  context: IpcContext,
  conversationId: string,
  turnId: string,
): Promise<CheckpointRestoreResult> {
  const { conversation, turn, project } = await checkpointContext(context, conversationId, turnId);
  if (!turn.checkpoint) throw new Error('This turn has no Git checkpoint.');
  const result = await restoreCheckpoint(project.path, turn.checkpoint);
  turn.fileChanges = [];
  conversation.updatedAt = new Date().toISOString();
  await context.conversations.save(conversation);
  return result;
}

async function checkpointContext(context: IpcContext, conversationId: string, turnId: string) {
  const conversation = await context.conversations.get(conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');
  const turn = conversation.turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new NotFoundError('Turn not found.');
  const project = await resolveProject(context, conversation.projectId ?? undefined, true);
  return { conversation, turn, project };
}

async function readProjectText(projectPath: string, relativePath: string): Promise<string> {
  const root = await fs.realpath(projectPath);
  const target = path.resolve(root, relativePath);
  if (!insideRoot(root, target)) throw new Error('Project path escapes the active project.');
  const stats = await fs.stat(target);
  if (!stats.isFile() || stats.size > 512 * 1024) return '';
  const data = await fs.readFile(target);
  return looksBinary(data.toString('utf8')) ? '' : data.toString('utf8');
}

function looksBinary(value: string): boolean {
  return value.includes('\u0000');
}

async function startCompare(context: IpcContext, request: CompareStartInput): Promise<CompareRun> {
  if (request.agent === request.targetAgent) {
    throw new Error('Choose two different agents for Compare mode.');
  }
  const project = await resolveProject(context, request.projectId, true);
  if (!(await isGitRepo(project.path))) {
    throw new Error('Compare mode needs a Git repository so each agent can run in an isolated worktree.');
  }
  const id = `compare_${crypto.randomUUID()}`;
  let worktreeLeft = '';
  let worktreeRight = '';
  try {
    [worktreeLeft, worktreeRight] = await Promise.all([
      createCompareWorktree(project.path, `${id}-left`),
      createCompareWorktree(project.path, `${id}-right`),
    ]);
    const [left, right] = await Promise.all([
      runCompareSide(context, request, id, 'left', request.agent, worktreeLeft),
      runCompareSide(context, request, id, 'right', request.targetAgent, worktreeRight),
    ]);
    const patchLeft = await worktreeDiffPatch(worktreeLeft);
    const patchRight = await worktreeDiffPatch(worktreeRight);
    context.compareRuns.set(id, {
      id,
      projectId: project.id,
      projectPath: project.path,
      worktreeLeft,
      worktreeRight,
      patchLeft,
      patchRight,
    });
    return { id, prompt: request.prompt, left, right };
  } catch (error) {
    await Promise.all([
      worktreeLeft ? removeCompareWorktree(project.path, worktreeLeft) : Promise.resolve(),
      worktreeRight ? removeCompareWorktree(project.path, worktreeRight) : Promise.resolve(),
    ]);
    throw error;
  }
}

async function runCompareSide(
  context: IpcContext,
  request: CompareStartInput,
  id: string,
  side: 'left' | 'right',
  agent: AgentId,
  worktreePath: string,
): Promise<CompareRun['left']> {
  const startedAt = Date.now();
  const conversationId = `${id}_${side}`;
  const preferences = await context.preferences.get(request.projectId);
  const authoritativeRules = await context.executionRules.read();
  const rulesBriefing = buildExecutionRulesBriefing(authoritativeRules);
  const built = await buildProjectContext(worktreePath, { authoritativeRules });
  const executionRequest: AgentRunRequest = {
    conversationId,
    prompt: request.prompt,
    agent,
    execution: request.execution,
    route: request.route,
    autonomy: request.autonomy,
  };
  const approvals: DirectApiApprovalPort = {
    request: async () => false,
  };
  const result = request.execution === 'api'
    ? await context.directApi.run(
        executionRequest,
        worktreePath,
        undefined,
        undefined,
        approvals,
        built.text,
        undefined,
        preferences?.customPermissions,
      )
    : await context.agents.run(
        applyExecutionRulesToRequest(
          { ...executionRequest, prompt: built.text ? `${built.text}\n\n[COMPARISON REQUEST]\n${request.prompt}` : request.prompt },
          rulesBriefing,
        ),
        worktreePath,
        undefined,
        undefined,
        preferences?.customPermissions,
      );
  return {
    agent,
    output: result.output,
    ok: result.status === 'completed' && !result.error,
    error: result.error,
    elapsedMs: Date.now() - startedAt,
    files: await worktreeChanges(worktreePath).catch(() => []),
    worktreePath,
  };
}

async function pickCompareWinner(
  context: IpcContext,
  id: string,
  side: 'left' | 'right',
): Promise<{ applied: boolean }> {
  const run = context.compareRuns.get(id);
  if (!run) throw new NotFoundError('Compare run not found or already closed.');
  await applyWorktreePatch(run.projectPath, side === 'left' ? run.patchLeft : run.patchRight);
  await discardCompare(context, id);
  return { applied: true };
}

async function discardCompare(context: IpcContext, id: string): Promise<{ discarded: boolean }> {
  const run = context.compareRuns.get(id);
  if (!run) return { discarded: false };
  context.compareRuns.delete(id);
  await Promise.all([
    removeCompareWorktree(run.projectPath, run.worktreeLeft),
    removeCompareWorktree(run.projectPath, run.worktreeRight),
  ]);
  return { discarded: true };
}

async function openCompareWorktree(
  context: IpcContext,
  id: string,
  side: 'left' | 'right',
): Promise<{ opened: boolean }> {
  const run = context.compareRuns.get(id);
  if (!run) throw new NotFoundError('Compare run not found or already closed.');
  const target = side === 'left' ? run.worktreeLeft : run.worktreeRight;
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: true };
}

export async function closeCompareRuns(context: IpcContext): Promise<void> {
  const runs = [...context.compareRuns.values()];
  context.compareRuns.clear();
  await Promise.all(runs.map((run) => Promise.all([
    removeCompareWorktree(run.projectPath, run.worktreeLeft),
    removeCompareWorktree(run.projectPath, run.worktreeRight),
  ]).then(() => undefined)));
}

async function resolveSelectedProjectPaths(projectRoot: string, requested: readonly string[]): Promise<string[]> {
  const root = await fs.realpath(projectRoot);
  const paths: string[] = [];
  for (const relativePath of requested) {
    const candidate = path.resolve(root, relativePath);
    if (!insideRoot(root, candidate)) continue;
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved || !insideRoot(root, resolved) || !(await fs.stat(resolved)).isFile()) continue;
    paths.push(path.relative(root, resolved).split(path.sep).join('/'));
  }
  return [...new Set(paths)];
}

async function resolveProject(context: IpcContext, projectId?: string, required = false): Promise<ProjectRecord> {
  const settings = await context.settings.load();
  const id = projectId ?? settings.activeProjectId;
  const project = id ? (await context.projects.list()).find((item) => item.id === id) : undefined;
  if (!project && required) throw new NotFoundError('Project not found.');
  return project ?? { schemaVersion: 1, id: '', name: '', path: process.cwd(), createdAt: '', lastOpenedAt: '' };
}

function goalForRequest(
  input: AgentRunRequest['goal'],
  existing: ConversationRecord['goal'] | null,
): ConversationRecord['goal'] | null {
  if (!input) return existing ?? null;
  if (
    existing
    && existing.outcome === input.outcome
    && existing.constraints === (input.constraints ?? '')
    && existing.verification === (input.verification ?? '')
  ) {
    return existing;
  }
  const timestamp = new Date().toISOString();
  return {
    id: `goal_${crypto.randomUUID()}`,
    outcome: input.outcome,
    constraints: input.constraints ?? '',
    verification: input.verification ?? '',
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
  };
}

function buildGoalPrompt(goal: NonNullable<ConversationRecord['goal']>, prompt: string): string {
  const lines = [
    '[ACTIVE GOAL]',
    `Outcome: ${goal.outcome}`,
    goal.constraints ? `Constraints: ${goal.constraints}` : '',
    goal.verification ? `Definition of done: ${goal.verification}` : '',
    'Continue working toward this outcome. Verify the definition of done before reporting completion.',
  ].filter(Boolean);
  return `${lines.join('\n')}\n\n[USER REQUEST]\n${prompt}`;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Copies an attached image into the project's own tree so a CLI agent — whose Read/file tools stay inside the
 * project root — can actually open the path a prompt names. Reused per run rather than cached: these are small
 * (image-attachments.ts caps a single image at 8 MB) and the source in KAI's attachments folder can change between
 * messages even when a chip keeps the same name.
 */
export async function stageAttachmentForCli(projectPath: string, sourcePath: string): Promise<string> {
  const relative = path.posix.join('.kai/tmp/attachments', path.basename(sourcePath));
  const target = await resolveInside(projectPath, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(path.join(path.dirname(target), '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await fs.copyFile(sourcePath, target);
  return target;
}

/** How many memories a run is grounded in. Enough to be useful, few enough to leave room for the actual prompt. */
const RECALL_LIMIT = 8;

/**
 * How many times a CLI run may be invoked again to finish a plan it left open. Each one is a whole agent run, so this
 * is deliberately small: it is for the agent that stopped a step short, not for driving a long task, which is what
 * Auto mode is for.
 */
const MAX_PLAN_CONTINUATIONS = 3;

/**
 * Carries a finished CLI run on, while the plan it wrote still has items open.
 *
 * Split out from the run itself so the behaviour can be tested without an agent: the decision is only ever "is the
 * plan unfinished, and may we ask again", and both of those are worth pinning down.
 *
 * A run that did not finish cleanly is never asked to carry on — it stopped for a reason, and if that reason was the
 * person, arguing with them would be the worst possible response. Each round is a whole invocation, so the cap is low.
 */
export async function continueWhilePlanOpen(
  workRoot: string,
  conversationId: string,
  first: AgentExecutionResult,
  runAgain: (prompt: string, sessionId?: string) => Promise<AgentExecutionResult>,
  limit = MAX_PLAN_CONTINUATIONS,
): Promise<AgentExecutionResult> {
  let execution = first;
  for (let round = 0; round < limit && execution.status === 'completed'; round += 1) {
    const plan = await readPlan(workRoot, conversationId).catch(() => null);
    if (!planIsUnfinished(plan)) break;
    const again = await runAgain(openPlanReminder(plan!), execution.sessionId ?? undefined);
    execution = {
      ...again,
      output: [execution.output, again.output].filter((part) => part.trim()).join('\n\n'),
      events: [...execution.events, ...again.events],
    };
  }
  return execution;
}

/**
 * Whether a failure means the daemon could not be reached at all, as opposed to reaching it and being refused.
 *
 * Only an unreachable daemon is worth restarting: a refusal is the daemon's own answer, and restarting it would lose
 * whatever it was saying. The wording comes from Node's fetch, which is what the client uses.
 */
export function looksUnreachable(error: unknown): boolean {
  const text = messageOf(error).toLowerCase();
  // Including the client's own wording for a hang. It was missing, so the one failure this check exists for — the
  // daemon alive enough to accept a connection and too stuck to answer — was the one it did not recognise, and the
  // restart-and-retry never fired for it.
  return ['econnrefused', 'econnreset', 'etimedout', 'ehostunreach', 'fetch failed', 'socket hang up', 'unable to connect', 'did not respond', 'timed out']
    .some((needle) => text.includes(needle));
}

async function recallScopedMemories(
  context: IpcContext,
  projectPath: string,
  fallbackProjectName: string,
  prompt: string,
  budget?: MemoryBudget,
): Promise<{ memories: BrainEntry[]; note: string | null; skipped: boolean }> {
  if (!(await cognitive1Ready(context))) return { memories: [], note: null, skipped: false };
  const limited = async <T>(work: Promise<T>): Promise<T | null> => (budget ? budget.run(work) : work);
  try {
    const resolution = await limited(resolveProjectMemoryName(context, projectPath, fallbackProjectName));
    // Out of time before the first read even started. The run goes ahead without memory rather than waiting longer,
    // and the daemon is asked to come back rather than being left in whatever state made it stop answering.
    if (!resolution) {
      requestBrainRestart(context, 'a memory read ran past its budget');
      return { memories: [], note: SKIPPED_MEMORY_NOTE, skipped: true };
    }
    const query = recallQuery(prompt);
    const found = await limited(context.cognitive1.search({ query, project: resolution.name, maxResults: RECALL_LIMIT }));
    if (!found) {
      requestBrainRestart(context, 'a recall ran past its budget');
      return { memories: [], note: SKIPPED_MEMORY_NOTE, skipped: true };
    }
    const memories = [...found];

    // Every project's lessons, not only this one's. Most of what a codebase will bite you with has already bitten
    // someone: a stale closure, a date derived from toISOString, a credential keyed by the wrong thing. So the recall
    // is topped up across the whole brain rather than left at whatever this project happens to hold — a project with
    // nothing filed still gets grounding, and a project with a little still benefits from the rest.
    const seen = new Set(memories.map((entry) => `${entry.type}|${entry.title}`));
    const elsewhere = await limited(
      context.cognitive1.search({ query, global: true, maxResults: RECALL_LIMIT * 2 }).catch(() => [] as BrainEntry[]),
    ) ?? [];
    let borrowed = 0;
    for (const entry of elsewhere) {
      if (memories.length >= RECALL_LIMIT) break;
      const key = `${entry.type}|${entry.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      memories.push(entry);
      borrowed += 1;
    }

    if (memories.length === 0 && !resolution.matched) {
      context.logger.info(
        'internal',
        `C1 has no project named "${resolution.name}"; recall returned nothing for ${projectPath}`,
      );
    } else if (borrowed > 0) {
      context.logger.info(
        'internal',
        `Recalled ${memories.length} memories for "${resolution.name}", ${borrowed} of them from other projects.`,
      );
    }

    const note = brainProjectNote(resolution, memories.length - borrowed);
    if (borrowed === 0 || memories.length === 0) return { memories, note, skipped: false };
    // Said plainly, because grounding a project in another project's answers is only honest when the reader can see
    // that is what happened — and can weigh it accordingly.
    const from = memories[memories.length - 1]?.project;
    return {
      memories,
      note: `${note ? `${note} ` : ''}${borrowed} of them come from other projects${from ? `, such as "${from}"` : ''}.`,
      skipped: false,
    };
  } catch (error) {
    context.logger.error('service_error', 'C1 scoped recall failed', undefined, error);
    // A failure that reads as unreachable is the same hang arriving as an error instead of a deadline, and deserves
    // the same answer.
    if (looksUnreachable(error)) requestBrainRestart(context, 'a memory read failed');
    return { memories: [], note: 'Memory recall failed, so this run has no recalled memories.', skipped: false };
  }
}

/** Said on the run itself, so a run with no memory is not mistaken for a brain that had nothing to say. */
const SKIPPED_MEMORY_NOTE = 'The brain did not answer in time, so this run started without any recalled memories.';

/** When KAI last asked for the brain to be restarted because it stopped answering. */
let lastBrainRestartRequest = 0;
const BRAIN_RESTART_COOLDOWN_MS = 5 * 60_000;

/**
 * Brings the daemon back in the background after it stops answering.
 *
 * The restart policy only hears about a process that exited. A daemon that is alive and not answering is invisible
 * to it, and every read fails quietly — which is why a hung brain used to stall run after run rather than being
 * noticed and fixed. The run does not wait for this: it is already carrying on without memory.
 *
 * Rate-limited, because one hung brain would otherwise be restarted by every run that starts while it is stuck.
 */
function requestBrainRestart(context: IpcContext, reason: string): void {
  const now = Date.now();
  if (now - lastBrainRestartRequest < BRAIN_RESTART_COOLDOWN_MS) return;
  lastBrainRestartRequest = now;
  context.logger.warn('service_error', `Cognitive1 did not answer in time (${reason}); restarting it in the background.`);
  void context.services.restart('cognitive1').catch((error: unknown) => {
    context.logger.error('service_error', 'Cognitive1 could not be restarted', messageOf(error));
  });
}

/**
 * The brain's own spelling of this project, preferring a name it already holds over the local manifest title.
 * A brain that cannot be listed still resolves, it just cannot confirm the match.
 */
async function resolveProjectMemoryName(
  context: IpcContext,
  projectPath: string,
  fallbackProjectName: string,
): Promise<BrainProjectResolution> {
  let known: KnownBrainProject[] = [];
  try {
    known = await context.cognitive1.knownProjects();
  } catch (error) {
    context.logger.warn('service_error', 'C1 project list unavailable for memory scoping', messageOf(error));
  }
  const manifest = await readProjectManifestNames(projectPath);
  return resolveBrainProject(
    {
      projectPath,
      projectName: fallbackProjectName,
      packageName: manifest.name,
      packageDisplayName: manifest.displayName,
    },
    known,
  );
}

async function readProjectManifestNames(projectPath: string): Promise<{ name?: string; displayName?: string }> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const value = JSON.parse(raw) as { displayName?: unknown; name?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : undefined,
      displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
    };
  } catch {
    // A project does not need a package manifest to use the brain.
    return {};
  }
}

export async function cognitive1Ready(context: IpcContext): Promise<boolean> {
  const settings = await context.settings.load();
  if (!settings.cognitive1.enabled) return false;
  try {
    const states = await context.services.status();
    return states.some((state) => state.kind === 'cognitive1' && state.status === 'ready');
  } catch {
    return false;
  }
}

async function syncManagedCognitive1Mcp(context: IpcContext): Promise<void> {
  try {
    const state = (await context.services.status()).find((service) => service.kind === 'cognitive1');
    if (state?.status !== 'ready') return;
    const results = await syncCognitive1Mcp(() => context.services.loopbackAccess('cognitive1'));
    for (const result of results) {
      if (result.error) {
        context.logger.warn(
          'internal',
          `Cognitive1 MCP could not be added to ${result.agent}`,
          `${result.configPath}: ${result.error}`,
        );
      }
    }
  } catch (error) {
    context.logger.warn('internal', 'Cognitive1 MCP registration was skipped', messageOf(error));
  }
}

async function finishMemorySession(
  context: IpcContext,
  conversationId: string,
  summary: string,
): Promise<PersistedEvent | null> {
  const active = context.memorySessions.get(conversationId);
  if (!active) return null;
  context.memorySessions.delete(conversationId);
  try {
    const result = await context.cognitive1.endSession(active.agent, summary);
    return memoryEvent(
      conversationId,
      active.agent,
      'session_end',
      result.autoHandoff
        ? `Ended C1 session in ${active.projectName}; an interrupted-work handoff was recorded.`
        : `Ended C1 session in ${active.projectName}.`,
    );
  } catch (error) {
    context.logger.error('service_error', 'C1 session end failed', undefined, error);
    return null;
  }
}

export async function closeMemorySessions(context: IpcContext): Promise<void> {
  const conversationIds = [...context.memorySessions.keys()];
  await Promise.all(conversationIds.map(async (conversationId) => {
    const event = await finishMemorySession(context, conversationId, 'Session closed when KAI exited.');
    if (!event) return;
    const conversation = await context.conversations.get(conversationId);
    if (!conversation) return;
    conversation.events.push(event);
    conversation.updatedAt = new Date().toISOString();
    await context.conversations.save(conversation);
  }));
}

/** The name every read and write for this project uses, so what one agent files another can recall. */
async function memoryProjectName(context: IpcContext, projectPath: string, fallback: string): Promise<string> {
  return (await resolveProjectMemoryName(context, projectPath, fallback)).name;
}

/**
 * What to ask the brain for, given the request.
 *
 * The brain's own search scores a substring hit per word, so the raw prompt was close to noise: "the", "a" and "and"
 * match nearly every entry ever filed, and the entries that scored highest were simply the recent ones. What recall
 * pulled in was therefore mostly unrelated, which is what "8 of 8 from other projects" looked like from the outside.
 *
 * The words that carry meaning are the ones left after the common ones go, and the prompt's own instruction words
 * ("please", "fix", "add") are dropped with them — they name what to do, not what it is about. KAI can only fix its
 * side of this: the ranking is the engine's, and it lives in the sibling repository.
 */
/** The request's own words, for a session label or a handoff note — places that read as prose, not as a search. */
function taskSummary(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, 500);
}

export function recallQuery(prompt: string): string {
  const words = prompt
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    // Two letters and up, not three: `id`, `db`, `ui` and `os` are words this codebase is about. The noise at that
    // length is handled by the stop list instead, which is where it belongs.
    .filter((word) => word.length >= 2 && !RECALL_STOP_WORDS.has(word.toLowerCase()));
  // Order kept, duplicates dropped: the first mention of a term is the one doing the work. A short prompt that is
  // all stop words keeps its own text rather than asking the brain for nothing.
  const distinctive = [...new Set(words)].slice(0, 40).join(' ');
  return (distinctive || prompt.trim().replace(/\s+/g, ' ')).slice(0, 500);
}

/**
 * Words that tell the brain nothing about what a task is about.
 *
 * Deliberately a short list of unambiguous ones rather than a full stop-word list: dropping a word that mattered is
 * worse than keeping one that did not, and the shared vocabulary here is code, not prose.
 */
const RECALL_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'but', 'you', 'your', 'are', 'was', 'were',
  'has', 'have', 'had', 'can', 'could', 'should', 'would', 'will', 'its', 'it', 'they', 'them', 'then', 'than',
  'when', 'where', 'which', 'while', 'what', 'how', 'why', 'all', 'any', 'each', 'some', 'more', 'most', 'only',
  'also', 'just', 'like', 'make', 'made', 'need', 'want', 'please', 'let', 'get', 'got', 'use', 'using', 'one',
  // Short words that are almost always grammar rather than subject matter. Kept here rather than excluded by length,
  // so that `id`, `db`, `ui` and `os` survive.
  'is', 'to', 'in', 'of', 'on', 'or', 'as', 'at', 'be', 'do', 'if', 'we', 'by', 'an', 'so', 'no', 'up', 'my', 'me',
  'am', 'he', 'she', 'his', 'her', 'our', 'out', 'off', 'too', 'very', 'now', 'new', 'old',
]);

function memoryEvent(
  conversationId: string,
  agent: AgentId,
  action: 'session_start' | 'recall' | 'handoff' | 'learn' | 'session_end',
  summary: string,
): PersistedEvent {
  return {
    schemaVersion: 1,
    id: `evt_${crypto.randomUUID()}`,
    taskId: conversationId,
    timestamp: new Date().toISOString(),
    agent,
    type: 'memory.event',
    action,
    summary,
  };
}

function isUnavailableCliSession(execution: AgentExecutionResult): boolean {
  if (execution.status !== 'failed' || execution.cancelled || execution.output.trim()) return false;
  if (execution.events.some((event) => ['tool.call', 'file.change', 'file.edit.applied', 'diff.proposal', 'turn.changes'].includes(event.type))) return false;
  const message = [
    execution.error ?? '',
    ...execution.events.flatMap((event) => event.type === 'error' ? [event.message] : []),
  ].join('\n');
  return /(?:session|thread|conversation).{0,100}(?:not found|does not exist|expired|invalid|unknown)|(?:not found|does not exist|expired|invalid|unknown).{0,100}(?:session|thread|conversation)/i.test(message);
}

/**
 * The paths a finished run changed, from the turn it recorded them on.
 *
 * The score keeps these so a later run can ask "has anything happened to these files before?" — a count alone
 * cannot answer that, which is why every score used to be useless for it.
 */
function changedPathsOf(conversation: ConversationRecord | null): string[] {
  if (!conversation) return [];
  for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
    const turn = conversation.turns[index];
    if (turn?.role !== 'user') continue;
    const paths = (turn.fileChanges ?? []).map((change) => change.path);
    if (paths.length > 0) return [...new Set(paths)];
  }
  return [];
}

function changedFilePaths(conversation: ConversationRecord | null): string[] {
  if (!conversation) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of conversation.events) {
    const candidates = event.type === 'file.edit.applied'
      ? [event.filePath]
      : event.type === 'file.change'
        ? [event.path]
        : event.type === 'diff.proposal'
          ? [event.filePath]
          : event.type === 'turn.changes'
            ? event.files.map((file) => file.path)
            : [];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
  }
  return paths.slice(-12);
}

export function cancelConversationRun(context: IpcContext, conversationId: string): boolean {
  return cancelAgent(context, conversationId);
}

/**
 * Brings the mirror brain level with this one. It reads the entries this brain holds rather than intercepting writes,
 * which is what makes it cover agents that call brain_learn over their own MCP connection as well as KAI's own runs.
 */
let mirrorRefusals: FileRefusalMemory | null = null;

export async function mirrorBrainNow(context: IpcContext, dryRun: boolean): Promise<BrainMirrorOutcome> {
  const settings = await context.settings.load();
  const mirror = settings.cognitive1.mirror;
  if (!mirror.enabled) throw new Error('Turn on the brain mirror in Settings, then try again.');
  if (!(await cognitive1Ready(context))) throw new Error('Cognitive1 is not running yet.');
  // The outcome schema is strict, so the count of entries skipped as already-refused stays inside the main process.
  const { knownRefused: _knownRefused, ...outcome } = await syncBrainToMirror({
    sourceBrain: await sharedBrainPath(context),
    endpoint: mirror.endpoint,
    ...(mirror.token ? { token: mirror.token } : {}),
    dryRun,
    // Entries the mirror has already refused are remembered across passes and restarts, and asked about again only
    // if their text changes. Before this, the same few were re-sent and re-refused every fifteen minutes for ever.
    refusals: (mirrorRefusals ??= new FileRefusalMemory(path.join(context.paths.root, 'brain-mirror-refused.json'))),
    // A refused entry is not a failure, so it stays out of the outcome — but silence about it means the same entry
    // comes back on every reconcile forever and nobody can see which one or why. The log is where it goes.
    onRejected: (entry, reason) => {
      context.logger.warn('internal', `The brain mirror refused "${entry.title}" (${entry.type}): ${reason}`);
    },
  });
  return outcome;
}

/** Stops on Stop: the checks and hooks a run's automation is executing, not only the agent. */
const automationRuns = new Map<string, AbortController>();
/** Conversations whose person pressed Compact while a run was going: each is compacted before its next request starts. */
const compactBeforeNextRun = new Set<string>();
/** Keep ordinary interactive runs from two windows from editing the same project at the same time. */
const interactiveProjectRuns = new Map<string, string>();

/**
 * The stop signal for one conversation's run, whichever level asks for it first.
 *
 * A run spends real time before the agent starts — a checkpoint, a memory session, the project outline — and Stop
 * used to be unable to reach any of it: the only controller in the map belonged to a run's automation, and the
 * runtime's own controller did not exist until the agent was already launching. So Stop during setup returned true
 * and the run carried on to completion. The setup now holds this signal and checks it, and Stop aborts the same one.
 */
function runStopFor(conversationId: string): AbortController {
  const existing = automationRuns.get(conversationId);
  if (existing && !existing.signal.aborted) return existing;
  const created = new AbortController();
  automationRuns.set(conversationId, created);
  return created;
}

function cancelAgent(context: IpcContext, conversationId: string): boolean {
  resolvePendingApprovals(context, conversationId, false);
  context.runControl.forget(conversationId);
  const stop = automationRuns.get(conversationId);
  stop?.abort();
  return context.agents.cancel(conversationId) || context.directApi.cancel(conversationId) || Boolean(stop);
}

async function sharedBrainPath(context: IpcContext): Promise<string> {
  const settings = await context.settings.load();
  const dataRoot = settings.cognitive1.dataPath ?? path.join(context.paths.root, 'engines', 'cognitive1');
  return path.join(dataRoot, 'brain');
}

async function currentSetupStatus(context: IpcContext): Promise<Awaited<ReturnType<typeof buildSetupStatus>>> {
  return buildSetupStatus({
    settings: () => context.settings.load(),
    projects: async () => (await context.projects.list()).map((project) => ({ id: project.id, path: project.path })),
    services: () => context.services.status(),
    agentCapabilities: async () => (await context.agents.capabilities()).map((capability) => ({
      available: capability.available,
      displayName: capability.displayName,
      ...(capability.unavailableReason ? { unavailableReason: capability.unavailableReason } : {}),
    })),
    directApiAvailable: async () => (await context.directApi.capability()).available,
    directApiDetail: async () => (await context.directApi.capability()).unavailableReason ?? 'Configure a direct API provider.',
    learningTutor: async () => {
      const readiness = await context.learningTutor.readiness();
      return { ready: readiness.ready, reason: readiness.reason, recovery: readiness.recovery };
    },
    github: async () => {
      const settings = await context.settings.load();
      const project = (await context.projects.list()).find((item) => item.id === settings.activeProjectId);
      if (!project) return { available: false, signedInAs: null, detail: 'Open a project before connecting GitHub.' };
      const github = await githubCliStatus(project.path);
      if (!github.cliAvailable) return { available: false, signedInAs: null, detail: 'GitHub CLI is not installed. Open its install instructions, then return here to sign in.' };
      return { available: true, signedInAs: github.signedInAs, detail: 'GitHub CLI is installed. Open GitHub setup to sign in.' };
    },
  });
}

function resolvePendingApprovals(context: IpcContext, conversationId: string, approved: boolean): void {
  for (const [requestId, pending] of context.pendingApprovals) {
    if (pending.conversationId !== conversationId) continue;
    context.pendingApprovals.delete(requestId);
    pending.resolve({ approved });
  }
}

async function broadcastSharedState(context: IpcContext): Promise<void> {
  const [settings, projects, services, credentials] = await Promise.all([
    context.settings.load(),
    context.projects.list(),
    context.services.status(),
    credentialStatus(context),
  ]);
  context.windows.broadcast('app:shared-state', {
    settings,
    projects,
    services,
    credentials,
  } satisfies SharedDesktopState);
}

async function createBootstrap(
  context: IpcContext,
  session?: DesktopWindowSession | null,
): Promise<BootstrapPayload> {
  const [settings, projects, services] = await Promise.all([
    context.settings.load(),
    context.projects.list(),
    context.services.status(),
  ]);
  const requestedProjectId = projectSelectionForWindow(session, settings.activeProjectId);
  const activeProjectId = projects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : null;
  if (session && session.projectId !== activeProjectId) session.projectId = activeProjectId;
  // The open project is watched from the moment it is open, so what changes in it is learned whether or not an agent
  // is running. Watching a project already watched does nothing.
  const openProject = projects.find((project) => project.id === activeProjectId);
  if (openProject) void startWatchingProject(openProject.path).catch(() => undefined);

  return {
    windowId: session?.id ?? 0,
    appName: context.appName,
    version: context.version,
    platform: process.platform,
    projects,
    activeProjectId,
    activeConversationId: session?.conversationId ?? null,
    buildIdentifier: context.buildIdentifier,
    editor: activeProjectId ? context.editorSessions.snapshot(session?.id ?? 0, activeProjectId) : null,
    settings,
    services,
    dataLocations: dataLocations(context.paths),
  };
}

async function chooseProject(
  context: IpcContext,
  session: DesktopWindowSession | null,
): Promise<ProjectRecord | null> {
  if (session && !(await confirmEditorNavigation(context, session, 'open another project'))) return null;
  const options: OpenDialogOptions = {
    title: 'Open a project',
    properties: ['openDirectory', 'createDirectory'],
  };
  const mainWindow = session?.window ?? context.getMainWindow();
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;

  const projectPath = path.resolve(result.filePaths[0]);
  const now = new Date().toISOString();
  // The store keeps the id it already has for a folder it knows, so everything below must use the record it returns.
  // Using the id minted here made the active project an id that is not in the list, and the folder never opened.
  const project = await context.projects.upsert({
    schemaVersion: 1,
    id: `project_${crypto.randomUUID()}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    createdAt: now,
    lastOpenedAt: now,
  });
  await context.settings.update((settings) => ({
    ...settings,
    activeProjectId: project.id,
    projectOrder: [project.id, ...settings.projectOrder.filter((id) => id !== project.id)],
  }));
  if (session) {
    session.projectId = project.id;
    session.conversationId = null;
  }
  await broadcastSharedState(context);
  context.logger.info('internal', 'Project opened', project.name);
  return project;
}

async function openProject(
  context: IpcContext,
  id: string,
  session: DesktopWindowSession | null,
): Promise<BootstrapPayload> {
  const project = (await context.projects.list()).find((item) => item.id === id);
  if (!project) throw new NotFoundError('Project not found.');
  if (session?.projectId !== id && session && !(await confirmEditorNavigation(context, session, 'switch projects'))) {
    return createBootstrap(context, session);
  }
  project.lastOpenedAt = new Date().toISOString();
  await context.projects.upsert(project);
  await context.settings.update((settings) => ({
    ...settings,
    activeProjectId: id,
    projectOrder: [id, ...settings.projectOrder.filter((projectId) => projectId !== id)],
  }));
  if (session) {
    session.projectId = id;
    session.conversationId = null;
  }
  await broadcastSharedState(context);
  return createBootstrap(context, session);
}

async function removeProject(
  context: IpcContext,
  id: string,
  session: DesktopWindowSession | null,
): Promise<BootstrapPayload> {
  if (session?.projectId === id && !(await confirmEditorNavigation(context, session, 'remove this project'))) {
    return createBootstrap(context, session);
  }
  await context.projects.remove(id);
  await context.preferences.remove(id);
  await context.settings.update((settings) => ({
    ...settings,
    activeProjectId: settings.activeProjectId === id ? null : settings.activeProjectId,
    projectOrder: settings.projectOrder.filter((projectId) => projectId !== id),
  }));
  if (session?.projectId === id) {
    session.projectId = null;
    session.conversationId = null;
  }
  await broadcastSharedState(context);
  return createBootstrap(context, session);
}

/**
 * Forgets every project in the list, the way removing one already does — the record, its preferences and its place in
 * the order — because a list that can only be emptied one entry at a time is a list nobody tidies. The folders are
 * not touched; opening one again brings it back with a fresh id.
 */
async function clearProjects(context: IpcContext, session: DesktopWindowSession | null): Promise<BootstrapPayload> {
  if (session?.projectId && !(await confirmEditorNavigation(context, session, 'clear the project list'))) {
    return createBootstrap(context, session);
  }
  const projects = await context.projects.list();
  for (const project of projects) {
    await context.projects.remove(project.id);
    await context.preferences.remove(project.id);
  }
  await context.settings.update((settings) => ({ ...settings, activeProjectId: null, projectOrder: [] }));
  if (session) {
    session.projectId = null;
    session.conversationId = null;
  }
  await broadcastSharedState(context);
  return createBootstrap(context, session);
}

async function chooseStudioProjectFolder(
  context: IpcContext,
  studioProjectId: string,
  session: DesktopWindowSession | null,
): Promise<{ projectId: string; projectName: string; path: string } | null> {
  const state = await context.interview.read({ projectId: studioProjectId });
  if (!state) throw new NotFoundError('Studio project not found.');
  if (state.status !== 'done') throw new Error('Finish the interview before creating the project folder.');

  const options: OpenDialogOptions = {
    title: 'Create or choose a folder for this Studio project',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  const mainWindow = session?.window ?? context.getMainWindow();
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;

  const projectPath = path.resolve(result.filePaths[0]);
  const sourceRoot = path.join(context.paths.studio, 'projects', studioProjectId);
  const sourceSpec = path.join(sourceRoot, '.kai');
  const targetSpec = path.join(projectPath, '.kai');
  if (await pathExists(sourceSpec)) {
    if (await pathExists(targetSpec)) {
      throw new Error('That folder already contains a .kai folder. Choose an empty folder so the Studio brief is not overwritten.');
    }
    await fs.cp(sourceSpec, targetSpec, { recursive: true, force: false, errorOnExist: true });
  }

  const now = new Date().toISOString();
  const projectName = path.basename(projectPath) || studioProjectName(state);
  const existing = (await context.projects.list()).find((project) => path.resolve(project.path) === projectPath);
  const project: ProjectRecord = existing ?? {
    schemaVersion: 1,
    id: `project_${crypto.randomUUID()}`,
    name: projectName,
    path: projectPath,
    createdAt: now,
    lastOpenedAt: now,
  };
  project.name = projectName;
  // The store may already hold this folder under another id, and it keeps the one it has. The link has to name the
  // record that actually survives, or the plan points at an id that is not in the list.
  const stored = await context.projects.upsert(project);
  await context.interview.setLinkedProject(studioProjectId, stored.id);
  await broadcastSharedState(context);
  return { projectId: stored.id, projectName: project.name, path: project.path };
}

async function launchStudioProject(
  context: IpcContext,
  studioProjectId: string,
  destination: 'composer' | 'editor' | 'generate' | 'crew',
): Promise<{ projectId: string; projectName: string; prompt: string }> {
  const state = await context.interview.read({ projectId: studioProjectId });
  if (!state) throw new NotFoundError('Studio project not found.');
  if (state.status !== 'done') throw new Error('Finish the interview before launching the project.');

  const project = await ensureStudioDesktopProject(context, studioProjectId, state);

  const brief = (await context.studio.artifactText(studioProjectId, 'brief'))?.trim();
  if (destination === 'crew') {
    // A crew goal is capped well below a full brief, and the crew's agents can read files: point at the brief
    // and the artifacts instead of pasting them, so nothing is cut off mid-sentence.
    const goal = studioCrewGoal(state);
    return {
      projectId: project.id,
      projectName: project.name,
      prompt: goal,
    };
  }
  const prompt = brief
    ? `Use this Project Studio brief as the source of truth. Start by confirming the smallest implementation plan, then build it.\n\n${brief}`
    : `Build this project from the Project Studio plan.\n\n${state.goal.trim() || state.idea.trim()}`;
  return { projectId: project.id, projectName: project.name, prompt };
}

/**
 * The desktop project a Studio plan runs in. A plan linked to a folder runs in that folder's project; one that is
 * not gets a project of its own, registered here, because an agent can only work inside a project the app knows.
 * Anything that starts an agent for a plan, whether the composer or Autopilot, goes through this.
 */
export async function ensureStudioDesktopProject(
  context: IpcContext,
  studioProjectId: string,
  known?: { linkedProjectId: string | null; goal: string; idea: string; updatedAt: string },
): Promise<ProjectRecord> {
  const state = known ?? await context.interview.read({ projectId: studioProjectId });
  if (!state) throw new NotFoundError('Studio project not found.');
  const existing = state.linkedProjectId
    ? (await context.projects.list()).find((candidate) => candidate.id === state.linkedProjectId)
    : (await context.projects.list()).find((candidate) => candidate.id === studioProjectId);
  if (state.linkedProjectId && !existing) throw new Error('The folder linked to this Studio plan is no longer available.');
  if (existing) return existing;
  const root = path.join(context.paths.studio, 'projects', studioProjectId);
  await fs.mkdir(root, { recursive: true });
  const now = new Date().toISOString();
  const project: ProjectRecord = {
    schemaVersion: 1,
    id: studioProjectId,
    name: studioProjectName(state),
    path: root,
    createdAt: state.updatedAt,
    lastOpenedAt: now,
  };
  await context.projects.upsert(project);
  await broadcastSharedState(context);
  return project;
}

function studioProjectName(state: { goal: string; idea: string }): string {
  return (state.goal.trim() || state.idea.trim() || 'Studio project').slice(0, 80);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(() => true).catch(() => false);
}

export async function confirmEditorNavigation(
  context: IpcContext,
  session: DesktopWindowSession,
  purpose: string,
): Promise<boolean> {
  const dirty = context.editorSessions.dirty(session.id);
  if (dirty.length === 0) return true;
  const detail = dirty.slice(0, 8).map((document) => document.path).join('\n');
  const result = await dialog.showMessageBox(session.window, {
    type: 'warning',
    title: 'Unsaved changes',
    message: `${dirty.length} file${dirty.length === 1 ? '' : 's'} have unsaved changes.`,
    detail: `${detail}${dirty.length > 8 ? `\n...and ${dirty.length - 8} more` : ''}\n\nSave them before KAI continues to ${purpose}?`,
    buttons: ['Save and continue', 'Discard changes', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 2) return false;
  if (result.response === 1) return true;
  const projects = await context.projects.list();
  const roots = new Map(projects.map((project) => [project.id, project.path]));
  const saved = await context.editorSessions.saveDirty(session.id, roots);
  if (saved.conflict) {
    await dialog.showMessageBox(session.window, {
      type: 'error',
      title: 'Save failed',
      message: 'KAI could not save every file, so the current context was kept.',
      detail: saved.conflict,
    });
    return false;
  }
  if (saved.saved.length > 0) context.windows.send(session.id, 'editor:documents-saved', saved.saved);
  return true;
}

/** Transfer approvals to another window when possible; otherwise release the waiting agent. */
export function handleRendererWindowClosed(context: IpcContext, windowId: number): void {
  const replacement = context.windows.live().find((session) => session.id !== windowId) ?? null;
  for (const pending of context.pendingApprovals.values()) {
    if (pending.ownerWindowId !== windowId) continue;
    if (replacement) {
      pending.ownerWindowId = replacement.id;
      context.windows.send(replacement.id, 'agents:event', {
        conversationId: pending.conversationId,
        event: pending.event,
      } satisfies AgentRunEvent);
    } else {
      pending.resolve({ approved: false });
    }
  }
}

async function credentialStatus(context: IpcContext): Promise<CredentialStatus> {
  return { available: context.credentials.isAvailable(), ids: await context.credentials.status() };
}

/** Every window redraws its board when a card moves, whichever window or agent moved it. */
/** Scans a project for the import wizard and marks the findings whose cards the board already holds. */
async function scanProjectForImport(context: IpcContext, projectId: string): Promise<ImportReport> {
  const project = await resolveProject(context, projectId, true);
  const report = await scanForImport(project.id, project.path, project.name);
  const board = await context.studio.board(project.id).catch(() => null);
  const onBoard = new Set((board?.cards ?? []).map((card) => card.id));
  return { ...report, onBoard: report.findings.map((finding) => finding.id).filter((id) => onBoard.has(importCardId(id))) };
}

function announceBoard(context: IpcContext, projectId: string, board: StudioBoard): StudioBoard {
  context.windows.broadcast('studio:board-changed', { projectId, board });
  return board;
}

function assertTrustedSender(url: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && url.startsWith(devUrl)) return;
  if (url.startsWith('file://')) return;
  throw new Error('IPC request came from an untrusted renderer.');
}

export function failureFor(error: unknown): IpcFailure {
  if (error instanceof NotFoundError) return { ok: false, error: { code: 'NOT_FOUND', message: error.message } };
  if (error instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: error.message } };
  if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Request validation failed.' } };
  }
  return {
    ok: false,
    error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Unexpected error.' },
  };
}

class NotFoundError extends Error {}
class ConflictError extends Error {}

function isPlaceholderTitle(title: string | undefined): boolean {
  return !title || !title.trim() || title === 'New conversation';
}

function titleFromPrompt(prompt: string): string {
  const title = prompt.trim().replace(/\s+/g, ' ').slice(0, 64);
  return title || 'New conversation';
}

const MAX_COMPACTION_TRANSCRIPT_CHARS = 140_000;
const MAX_COMPACTION_SUMMARY_CHARS = 30_000;

async function compactConversation(
  context: IpcContext,
  conversationId: string,
): Promise<ConversationRecord> {
  // Compacting now answers any request to compact later.
  compactBeforeNextRun.delete(conversationId);
  const conversation = await context.conversations.get(conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');
  if (conversation.turns.length === 0) throw new Error('There are no turns to compact yet.');
  const project = conversation.projectId
    ? (await context.projects.list()).find((candidate) => candidate.id === conversation.projectId)
    : null;
  if (!project) throw new Error('Open a project before compacting conversation context.');

  const transcript = compactionTranscript(conversation);
  const summary = await generateCompactionSummary(context, conversation, project.path, transcript);
  const now = new Date().toISOString();
  conversation.compaction = {
    summary,
    createdAt: now,
    throughTurnIndex: conversation.turns.length - 1,
    originalTurns: conversation.turns.length,
    originalCharacters: transcript.length,
  };
  delete conversation.agentSessionId;
  conversation.updatedAt = now;
  await context.conversations.save(conversation);
  return conversation;
}

async function generateCompactionSummary(
  context: IpcContext,
  conversation: ConversationRecord,
  projectPath: string,
  transcript: string,
): Promise<string> {
  const settings = await context.settings.load();
  const agent = conversation.activeAgent ?? settings.defaultAgent;
  const execution = conversation.execution ?? 'cli';
  const route = conversation.route ?? 'direct';
  // Compaction is an agent invocation too. It used to bypass the standing rules because it
  // called the provider directly, leaving this maintenance path outside the 57-rule contract.
  const authoritativeRules = await context.executionRules.read();
  const rulesBriefing = buildExecutionRulesBriefing(authoritativeRules);
  const request: AgentRunRequest = {
    conversationId: `compact_${crypto.randomUUID()}`,
    prompt: compactionPrompt(transcript),
    agent,
    execution,
    route,
    autonomy: 'plan',
  };
  const ruledRequest = applyExecutionRulesToRequest(request, rulesBriefing);

  try {
    if (execution === 'api' && (await context.directApi.capability()).available) {
      const result = await context.directApi.run(ruledRequest, projectPath);
      if (result.status === 'completed' && result.output.trim()) {
        return limitText(result.output.trim(), MAX_COMPACTION_SUMMARY_CHARS, 'summary');
      }
    } else if (execution === 'cli') {
      const result = await context.agents.run(ruledRequest, projectPath);
      if (result.status === 'completed' && result.output.trim()) {
        return limitText(result.output.trim(), MAX_COMPACTION_SUMMARY_CHARS, 'summary');
      }
    }
  } catch (error) {
    context.logger.error('agent_crash', 'Context compaction model call failed', undefined, error);
  }

  return deterministicCompactionSummary(conversation, transcript);
}

function compactionPrompt(transcript: string): string {
  return [
    'Compact the conversation below for continued software work.',
    'Return a concise Markdown briefing with these sections: Objective, Decisions, Current state, Files and changes, Constraints, Open questions, Next action.',
    'Preserve exact file paths, commands, errors, decisions, and user constraints. Do not call tools. Do not include a preamble or repeat the transcript.',
    '',
    'Conversation:',
    transcript,
  ].join('\n');
}

function compactionTranscript(conversation: ConversationRecord): string {
  const parts: string[] = [];
  if (conversation.compaction) {
    parts.push(`Previous compaction summary:\n${conversation.compaction.summary}`);
  }
  const startIndex = conversation.compaction ? conversation.compaction.throughTurnIndex + 1 : 0;
  for (const turn of conversation.turns.slice(startIndex)) {
    const label = turn.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${label}:\n${turn.text.trim()}`);
  }
  return limitText(parts.join('\n\n'), MAX_COMPACTION_TRANSCRIPT_CHARS, 'older conversation context');
}

function deterministicCompactionSummary(conversation: ConversationRecord, transcript: string): string {
  const userTurns = conversation.turns.filter((turn) => turn.role === 'user').slice(-12);
  const assistantTurns = conversation.turns.filter((turn) => turn.role === 'assistant').slice(-8);
  const files = changedFilePaths(conversation).slice(-30);
  const objective = userTurns.at(-1)?.text ?? conversation.title;
  const currentState = assistantTurns.at(-1)?.text ?? 'No assistant result has been recorded yet.';
  return [
    '## Objective',
    limitText(objective, 2_000, 'objective'),
    '',
    '## Decisions and requests',
    ...userTurns.map((turn) => `- ${limitText(turn.text.replace(/\s+/g, ' '), 500, 'request')}`),
    '',
    '## Current state',
    limitText(currentState, 4_000, 'current state'),
    '',
    '## Files and changes',
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- No tracked file changes recorded.']),
    '',
    '## Open questions',
    '- Are there unresolved errors or decisions that still require confirmation?',
    '',
    '## Next action',
    'Continue from the current state and verify the next change against the objective above.',
    '',
    `_Compacted ${transcript.length.toLocaleString()} transcript characters._`,
  ].join('\n');
}

function renderCompactionContext(compaction: NonNullable<ConversationRecord['compaction']>): string {
  return [
    '## Compacted conversation context',
    'This summary replaces older turns from the active conversation. The full transcript remains stored locally for audit and review.',
    `Compacted at: ${compaction.createdAt}`,
    '',
    compaction.summary,
  ].join('\n');
}

function limitText(value: string, maxCharacters: number, label: string): string {
  if (value.length <= maxCharacters) return value;
  const suffix = `\n\n[${label} truncated by KAI compaction]`;
  return `${value.slice(0, Math.max(0, maxCharacters - suffix.length)).trimEnd()}${suffix}`;
}

async function importBrain(context: IpcContext) {
  const owner = context.getMainWindow();
  const options: OpenDialogOptions = {
    title: 'Import an existing Cognitive1 brain',
    buttonLabel: 'Import brain',
    properties: ['openDirectory'],
  };
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) return null;

  return importBrainFromDirectory(context, selection.filePaths[0]);
}

export async function importBrainFromDirectory(
  context: IpcContext,
  selectedDirectory: string,
  restartService = true,
) {
  const selectedRoot = path.resolve(selectedDirectory);
  const nestedBrain = path.join(selectedRoot, 'brain');
  const sourcePath = await directoryExists(nestedBrain) ? nestedBrain : selectedRoot;
  const settings = await context.settings.load();
  const dataRoot = settings.cognitive1.dataPath ?? path.join(context.paths.root, 'engines', 'cognitive1');
  const targetPath = path.join(dataRoot, 'brain');
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('The selected folder is already KAI desktop\'s active C1 brain.');
  }

  const result = await copyMissingFiles(sourcePath, targetPath);
  if (restartService && settings.cognitive1.enabled) {
    await context.services.restart('cognitive1');
  }
  return { sourcePath, targetPath, ...result };
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function copyMissingFiles(sourcePath: string, targetPath: string): Promise<{ imported: number; skipped: number }> {
  if (!(await directoryExists(sourcePath))) throw new Error('The selected C1 brain folder was not found.');
  await fs.mkdir(targetPath, { recursive: true });
  const result = { imported: 0, skipped: 0 };
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      result.skipped += 1;
      continue;
    }
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyMissingFiles(sourceEntry, targetEntry);
      result.imported += nested.imported;
      result.skipped += nested.skipped;
      continue;
    }
    if (!entry.isFile()) {
      result.skipped += 1;
      continue;
    }
    try {
      await fs.access(targetEntry);
      result.skipped += 1;
    } catch {
      await fs.copyFile(sourceEntry, targetEntry);
      result.imported += 1;
    }
  }
  return result;
}

async function exportProxyConfig(context: IpcContext): Promise<ProxyConfigTransferResult> {
  const owner = context.getMainWindow();
  const options = {
    title: 'Export Universal Proxy configuration',
    buttonLabel: 'Export',
    defaultPath: 'kai-universal-proxy-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const selection = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return { canceled: true };

  const settings = await context.settings.load();
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    proxy: settings.proxy,
  };
  await fs.writeFile(selection.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  context.logger.info('internal', 'Universal Proxy configuration exported', selection.filePath);
  return { canceled: false, path: selection.filePath, imported: false };
}

async function importProxyConfig(context: IpcContext): Promise<ProxyConfigTransferResult> {
  const owner = context.getMainWindow();
  const options: OpenDialogOptions = {
    title: 'Import Universal Proxy configuration',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

  const filePath = selection.filePaths[0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error('The selected Universal Proxy configuration is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The selected file does not contain Universal Proxy configuration.');
  }
  const record = parsed as Record<string, unknown>;
  const rawProxy = record.proxy ?? record;
  const imported = proxyServiceSettingsSchema.parse(rawProxy);
  const settings = await context.settings.load();
  const proxyWasReady = (await context.services.status()).some(
    (service) => service.kind === 'universalProxy' && service.status === 'ready',
  );
  const merged = { ...settings, proxy: { ...settings.proxy, ...imported } };
  await context.settings.save(merged);
  if (proxyWasReady && merged.proxy.enabled) await context.services.restart('universalProxy', merged);
  else await context.services.syncFromSettings(merged);
  context.logger.info('internal', 'Universal Proxy configuration imported', filePath);
  return { canceled: false, path: filePath, imported: true };
}

/**
 * Puts the environment an outside terminal needs on the clipboard.
 *
 * This is how a CLI the user starts themselves is pointed at KAI's proxy. It used to copy a base URL and nothing else,
 * which cannot work: the proxy's port is behind a gateway that checks the loopback token, and the token is issued fresh
 * every time KAI starts. A CLI configured with the URL alone got 401 on every request while the route card, which
 * probed with KAI's own token, said it was fine.
 *
 * What goes on the clipboard is the same environment KAI gives its own CLI runs (`cliProxyEnvironment`), so the two
 * cannot drift again, and the token is read live rather than from anything stored.
 *
 * Only the description comes back, never the block: the token would otherwise land in the renderer for no reason, and
 * the clipboard is already where the user is going to get it from.
 */
async function copyProxyEnv(context: IpcContext, agent: ProxyAgentId): Promise<ProxyEnvCopyResult> {
  const settings = await context.settings.load();
  if (!settings.proxy.enabled) throw new Error('Turn the Universal Proxy on first.');
  const access = await context.services.loopbackAccess('universalProxy');
  const environment = cliProxyEnvironment(agent, access, undefined);
  const block = Object.entries(environment).map(([name, value]) => `${name}=${value}`).join('\n');
  clipboard.writeText(block);
  return { copied: true, value: `the ${agent} environment for your terminal (${Object.keys(environment).join(', ')})` };
}

async function launchProxyAgent(
  context: IpcContext,
  agent: 'claude' | 'codex',
): Promise<ProxyLaunchResult> {
  const settings = await context.settings.load();
  if (!settings.proxy.enabled) throw new Error('Enable the Universal Proxy before launching a routed agent.');
  const routes = await context.proxyRouting.routes();
  const current = routes.find((route) => route.agentId === agent);
  if (!current || current.route !== 'proxy') {
    const result = await context.proxyRouting.action(agent, 'route');
    if (!result.success) throw new Error(result.error || `Could not route ${agent} through the proxy.`);
  }

  const command = agent;
  const environment = {
    ...process.env,
    ...(agent === 'claude'
      ? { ANTHROPIC_BASE_URL: proxyAgentBaseUrl(settings, 'claude') }
      : { OPENAI_BASE_URL: proxyAgentBaseUrl(settings, 'codex') }),
  };
  const project = settings.activeProjectId
    ? (await context.projects.list()).find((candidate) => candidate.id === settings.activeProjectId)
    : null;
  launchTerminal(command, environment, project?.path);
  return {
    launched: true,
    agent,
    command,
    detail: `Opened ${agent} in a terminal with the Universal Proxy route applied.`,
  };
}

function launchTerminal(command: string, environment: NodeJS.ProcessEnv, cwd?: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', command], {
      cwd,
      env: environment,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  const terminal = process.platform === 'darwin'
    ? spawn('open', ['-a', 'Terminal', command], { cwd, env: environment, detached: true, stdio: 'ignore' })
    : spawn('x-terminal-emulator', ['-e', command], { cwd, env: environment, detached: true, stdio: 'ignore' });
  terminal.unref();
}


async function startProxyLiveTail(context: IpcContext): Promise<boolean> {
  stopProxyLiveTail(context);
  const owner = context.getMainWindow();
  if (!owner) throw new Error('The KAI window is not available.');
  const controller = new AbortController();
  context.proxyLiveTails.set(owner.webContents.id, controller);
  void context.proxy.watchLive((event) => {
    if (!owner.isDestroyed()) owner.webContents.send('proxy:live-event', event satisfies ProxyLiveEvent);
  }, controller.signal).catch((error) => {
    context.proxyLiveTails.delete(owner.webContents.id);
    if (!controller.signal.aborted) {
      context.logger.warn('proxy_error', 'Universal Proxy live tail stopped', messageOf(error));
    }
  });
  return true;
}

function stopProxyLiveTail(context: IpcContext): boolean {
  let stopped = false;
  for (const controller of context.proxyLiveTails.values()) {
    controller.abort();
    stopped = true;
  }
  context.proxyLiveTails.clear();
  return stopped;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type DesktopBridge = KaiDesktopBridge;

/** Read only model preferences are offered for import; tokens, permissions, MCP servers and account state stay owned by their source tool. */
async function agentConfigImportPreview(): Promise<AgentConfigImportPreview[]> {
  const home = os.homedir();
  const codexPath = path.join(home, '.codex', 'config.toml');
  const claudePath = path.join(home, '.claude', 'settings.json');
  const [codex, claude] = await Promise.all([
    fs.readFile(codexPath, 'utf8').then((text) => previewCodexConfig(codexPath, text)).catch(() => ({ agent: 'codex' as const, path: codexPath, found: false, model: null, detail: 'No Codex configuration was found.' })),
    fs.readFile(claudePath, 'utf8').then((text) => previewClaudeConfig(claudePath, text)).catch(() => ({ agent: 'claude' as const, path: claudePath, found: false, model: null, detail: 'No Claude Code settings file was found.' })),
  ]);
  return [codex, claude];
}

function previewCodexConfig(configPath: string, text: string): AgentConfigImportPreview {
  const match = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text);
  const model = match?.[1]?.trim() || null;
  return { agent: 'codex', path: configPath, found: true, model, detail: model ? `Codex uses ${model}.` : 'Codex config was found, but it has no top-level model preference.' };
}

function previewClaudeConfig(configPath: string, text: string): AgentConfigImportPreview {
  try {
    const value = JSON.parse(text) as { model?: unknown };
    const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : null;
    return { agent: 'claude', path: configPath, found: true, model, detail: model ? `Claude Code uses ${model}.` : 'Claude Code settings were found, but no model preference is set.' };
  } catch {
    return { agent: 'claude', path: configPath, found: true, model: null, detail: 'Claude Code settings could not be read as JSON, so nothing can be imported.' };
  }
}

async function importAgentConfig(context: IpcContext, agent: 'codex' | 'claude'): Promise<AgentConfigImportPreview> {
  const preview = (await agentConfigImportPreview()).find((candidate) => candidate.agent === agent)!;
  if (!preview.found || !preview.model) throw new Error(`There is no ${agent} model preference to import.`);
  await context.backups.create(`Before importing ${agent} preference`);
  await context.settings.update((settings) => ({ ...settings, agentModels: { ...settings.agentModels, [agent]: preview.model! } }));
  await broadcastSharedState(context);
  return preview;
}

/** What the Settings card shows. The vault holds the token, so only whether one is stored leaves this function. */
async function openPencilStatus(context: IpcContext): Promise<OpenPencilStatus> {
  const settings = await context.settings.load();
  const server = settings.mcpServers.find((candidate) => candidate.id === OPENPENCIL_MCP_SERVER_ID);
  return {
    endpoint: server?.transport === 'http' ? server.url : OPENPENCIL_ENDPOINT,
    enabled: Boolean(server?.enabled),
    tokenStored: Boolean(await context.credentials.has(OPENPENCIL_CREDENTIAL_ID)),
  };
}

/** Stores the token as the whole Authorization header value, registers the server, and tells the runtime to reconnect. */
async function saveOpenPencil(context: IpcContext, input: OpenPencilSaveInput): Promise<OpenPencilStatus> {
  const token = input.token?.replace(/^bearer\s+/i, '').trim();
  if (token) await context.credentials.set(OPENPENCIL_CREDENTIAL_ID, `Bearer ${token}`);
  await context.settings.update((settings) => withOpenPencilMcpSetting(settings, { endpoint: input.endpoint, enabled: input.enabled }).settings);
  context.mcp.invalidate(OPENPENCIL_MCP_SERVER_ID);
  await broadcastSharedState(context);
  return openPencilStatus(context);
}

/** One cheap read, so a wrong address, a missing token or a stopped editor is reported in words before a pull.
 * Launches the editor and re-syncs the connection first, so this reports the live state rather than whatever was
 * last saved — a person who has never configured open-pencil at all still gets a real answer, not "turn it on". */
async function testOpenPencil(context: IpcContext): Promise<OpenPencilTestResult> {
  try {
    await context.ensureOpenPencil();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const status = await openPencilStatus(context);
  if (!status.enabled) return { ok: false, message: 'Turn the connection on and save it first.' };
  try {
    const blocks = await context.mcp.callServerTool(OPENPENCIL_MCP_SERVER_ID, 'list_pages', {});
    if (blocks === null) return { ok: false, message: `KAI could not connect to ${status.endpoint}. Check that the editor is running and the token matches.` };
    return { ok: true, message: `Connected to open-pencil at ${status.endpoint}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'open-pencil did not answer.' };
  }
}

/** One of a report's pictures as a data URL. Only files the Equalizer wrote are ever read. */
async function equalizerImage(context: IpcContext, input: EqualizerImageInput): Promise<string | null> {
  const relative = input.path.replace(/\\/g, '/');
  if (!/^\.kai\/spec\/equalizer\/[A-Za-z0-9._\/-]+\.png$/.test(relative) || relative.includes('..')) return null;
  const project = (await context.projects.list()).find((candidate) => candidate.id === input.projectId);
  if (!project) return null;
  try {
    const bytes = await fs.readFile(await resolveInside(project.path, relative));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
