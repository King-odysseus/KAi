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
  type ConversationRecord,
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
  parseIpcInput,
  parseTasks,
  parseTestCounts,
  revertHunks,
  proxyServiceSettingsSchema,
} from '@kai/contracts';
import type { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import type { AgentExecutionResult, DesktopAgentRuntime } from './agent-runtime';
import { brainProjectNote, resolveBrainProject, type BrainProjectResolution, type KnownBrainProject } from './brain-project';
import { describeRunOutcome, outstandingLine } from './run-summary';
import { planBriefingFor, readPlan } from './plan-store';
import { buildTurnDigest } from './turn-digest';
import { workingMethodBriefing } from './working-method';
import { diagnoseRun, diagnosisLine } from './run-doctor';
import { buildHistoryNote } from './run-history';
import { canInterject, clearInterjections, interject, setInterjectionActive, takeDeliveredInterjections } from './interjections';
import { buildProjectContext } from './context-builder';
import type { DesktopDirectProviderRuntime, DirectApiApprovalPort, DirectApiApprovalRequest } from './direct-provider-runtime';
import { awaitsTheUser } from './direct-provider-runtime';
import { applyExecutionRulesToRequest, buildExecutionRulesBriefing, injectRulesIntoProjects, RULES_MARKER, shouldCarryRules } from './execution-rules';
import type { DesktopExecutionRules } from './execution-rules';
import type { DesktopMcpRuntime } from './mcp-runtime';
import type { Cognitive1Client } from './cognitive1-client';
import { dataLocations, type DesktopPaths } from './paths';
import type { UniversalProxyClient } from './proxy-client';
import type { DesktopProxyRouting } from './proxy-routing';
import { proxyAgentBaseUrl } from './proxy-routing';
import { ensureClaudeSettingsFile, resetClaudeCodeConfig } from './claude-maintenance';
import { mergeSettingsUpdate, type DesktopServiceController } from './service-controller';
import type { ProjectPreferenceStore } from './project-preference-store';
import type { ProjectStore } from './project-store';
import { buildSkillPrompt, discoverDesktopSkills, skillSummaries } from './skills';
import type { DesktopShell } from './desktop-shell';
import { mcpText, parseActiveClaims, parseConflictText, parseRecallText, parseUrgentNotes } from './coordination';
import type { TerminalManager } from './terminal';
import { findGitBash } from './terminal';
import type { ExecutionMode } from '@kai/contracts';
import type { UpdateController } from './updater';
import { buildDiagnosticsReport } from './diagnostics-report';
import { gitCheckout, gitCommit, gitCreateBranch, gitCreatePullRequest, gitCreateRepository, gitDiffAgainstHead, gitDiffFile, githubCliStatus, gitInit, gitOverview, gitStage, gitSync } from './git-tools';
import { agentChecksFromEvents, recordVerification, runCheckCommand, suggestTestCommand, verificationOverview, type RecordedCheck, type VerificationStore } from './verification';
import { FileConflictError, fileChangedOnDisk, listProjectFiles, readProjectFile, writeProjectFile } from './project-files';
import { buildRecap, buildResume, describeEvent, type RecoveryStore } from './recovery-store';
import type { NotificationCenter } from './notification-rules';
import { summarizeUsage } from './usage-budget';
import type { WorkflowTemplateStore } from './workflow-templates';
import type { DesktopConfigBackupStore } from './backups';
import type { LearningProgressStore } from './learning-progress';
import type { DesktopLearningTutor } from './learning-tutor';
import type { TeachingLibraryStore } from './teaching-library';
import { recordLearningLesson } from './learning-records';
import type { LearningBudgetGuard, LearningUsageStore } from './learning-usage';
import { listProviderModels } from './provider-models';
import { autoCliModel } from './auto-model';
import { invalidateRepoMap } from './repo-map';
import { runWithAutomation, type AutomationPorts } from './automation';
import type { DesktopChangeReviewer } from './change-review';
import type { DesktopEvals } from './evals';
import { escalatedLevel, summarizeScores, type RunScoreStore } from './run-scores';
import { makeAgentExperience, type AgentExperienceStore } from './experience-store';
import type { DesktopScheduler, ScheduledRunOutcome } from './scheduler';
import type { DesktopWorkflowRunner } from './workflow-runner';
import type { DesktopTeamPlanner } from './team-planner';
import type { DesktopAutopilot } from './autopilot';
import type { DesktopAutoSession } from './auto-session';
import { syncBrainToMirror } from './brain-mirror';
import type { BrainMirrorOutcome } from '@kai/contracts';
import { composeRunLesson, type RunLessonInput } from './run-learning';
import type { DesktopPromptGuide } from './prompt-guide';
import type { DesktopInterview } from './interview';
import type { DesktopStudio } from './studio';
import type { StudioStyleReferenceStore } from './style-references';
import type { EqualizerService } from './equalizer';
import { resolveInside } from './project-files';
import type { TeamRecordStore } from './team-record-store';
import type { DesktopRunControl } from './run-control';
import { brainGitStatus, syncBrainGit } from './brain-git';
import { buildSetupStatus } from './setup-status';
import { syncCognitive1Mcp, withOpenPencilMcpSetting } from './agent-mcp-config';
import { projectSelectionForWindow, type DesktopWindowRegistry, type DesktopWindowSession } from './desktop-windows';
import type { EditorSessionManager } from './editor-sessions';
import { formatProjectCode, projectGitFileInfo } from './code-tools';
import {
  createProjectCheckpoint,
  diffFromCheckpoint,
  gitDiffStat,
  isGitRepo,
  readFileAtCheckpoint,
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
  teamPlanner: DesktopTeamPlanner;
  autopilot: DesktopAutopilot;
  auto: DesktopAutoSession;
  promptGuide: DesktopPromptGuide;
  interview: DesktopInterview;
  studio: DesktopStudio;
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

export function registerIpc(context: IpcContext): IpcRegistry {
  const handlers = new Map<IpcChannel, IpcChannelHandler>();

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
    handlers.set(channel, (rawInput, request) =>
      handler(parseIpcInput(channel, rawInput), request),
    );
  };

  handle(context, 'app:get-bootstrap', async (_input, request) => createBootstrap(context, request.session));
  handle(context, 'projects:choose', async (_input, request) => chooseProject(context, request.session));
  handle(context, 'projects:open', async ({ id }, request) => openProject(context, id, request.session));
  handle(context, 'projects:remove', async ({ id }, request) => removeProject(context, id, request.session));
  handle(context, 'projects:clear', async (_input, request) => clearProjects(context, request.session));
  handle(context, 'settings:get', async () => context.settings.load());
  handle(context, 'setup:agent-config-preview', async () => agentConfigImportPreview());
  handle(context, 'setup:agent-config-import', async ({ agent }) => importAgentConfig(context, agent));
  handle(context, 'setup:guide-answer', async ({ question, conversationContext }) => {
    const settings = await context.settings.load();
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Tutor is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const projectId = settings.activeProjectId ?? 'kai-guide';
    const reservation = context.learningBudget.reserve({
      projectId,
      provider: readiness.provider,
      model: readiness.model,
      conversations: await context.conversations.list(),
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
  handle(context, 'providers:list-models', async (request) => listProviderModels(request, context.credentials));
  handle(context, 'settings:update', async (update) => {
    const snapshot: { previous: AppSettings | null } = { previous: null };
    const merged = await context.settings.update((settings) => {
      snapshot.previous = settings;
      return mergeSettingsUpdate(settings, update);
    });
    if (!snapshot.previous) throw new Error('Settings could not be read.');
    const proxyChanged = update.proxy !== undefined && JSON.stringify(merged.proxy) !== JSON.stringify(snapshot.previous.proxy);
    const cognitive1Changed = update.cognitive1 !== undefined && JSON.stringify(merged.cognitive1) !== JSON.stringify(snapshot.previous.cognitive1);
    const remoteChanged = JSON.stringify(merged.remote) !== JSON.stringify(snapshot.previous.remote);
    const services = await context.services.status();
    const proxyWasReady = services.some((service) => service.kind === 'universalProxy' && service.status === 'ready');
    const cognitive1WasReady = services.some((service) => service.kind === 'cognitive1' && service.status === 'ready');
    context.desktopShell.apply(merged.notifications);
    context.mcp.invalidate();
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
  handle(context, 'files:choose', async ({ projectId }) => chooseProjectFiles(context, projectId));
  handle(context, 'files:search', async ({ projectId, query }) => searchProjectFiles(context, projectId, query));
  handle(context, 'context:git-diff', async ({ projectId }) => gitDiffForProject(context, projectId));
  handle(context, 'attachments:save', async ({ name, dataUrl }) => saveAttachment(context, name, dataUrl));
  handle(context, 'workflows:list-templates', async ({ projectId }) => context.workflowTemplates.list(projectId));
  handle(context, 'workflows:list-runs', async ({ projectId }) => context.workflows.list(projectId));
  handle(context, 'workflows:start', async (input, request) => context.workflows.start(input, request.ownerWindowId));
  handle(context, 'workflows:stop', async ({ workflowId }, request) => context.workflows.stop(workflowId, request.ownerWindowId));
  handle(context, 'workflows:resume', async ({ workflowId }, request) => context.workflows.resume(workflowId, request.ownerWindowId));
  handle(context, 'workflows:save-template', async (template) => context.workflowTemplates.save(template));
  handle(context, 'workflows:delete-template', async ({ id }) => context.workflowTemplates.delete(id));
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
    if (/^studio_[0-9a-f-]{36}$/i.test(projectId)) {
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
  handle(context, 'studio:interview-finish', async ({ projectId }) => context.interview.finish({ projectId }));
  handle(context, 'studio:interview-reset', async ({ projectId }) => context.interview.reset({ projectId }));
  handle(context, 'studio:interview-extend', async ({ projectId }) => context.interview.extend({ projectId }));
  handle(context, 'studio:artifacts-read', async ({ projectId }) => context.studio.artifacts(projectId));
  handle(context, 'studio:artifacts-files', async ({ projectId }) => context.studio.files(projectId));
  handle(context, 'studio:artifacts-text', async ({ projectId, kind }) => context.studio.artifactText(projectId, kind));
  handle(context, 'studio:artifacts-save', async ({ projectId, kind, content }) => context.studio.saveArtifact(projectId, kind, content));
  handle(context, 'studio:style-refs-read', async ({ projectId }) => context.styleReferences.list(projectId));
  handle(context, 'studio:style-refs-add', async ({ projectId, name, data }) => context.styleReferences.add(projectId, name, data));
  handle(context, 'studio:style-refs-remove', async ({ projectId, name }) => context.styleReferences.remove(projectId, name));
  handle(context, 'studio:style-refs-describe', async ({ projectId }) => context.styleReferences.describe(projectId));
  handle(context, 'studio:artifacts-generate', async ({ projectId, kind }) => context.studio.generate(projectId, kind));
  handle(context, 'studio:artifacts-generate-all', async ({ projectId }) => context.studio.generateAll(projectId));
  handle(context, 'studio:artifacts-mark-edited', async ({ projectId, kind }) => context.studio.markEdited(projectId, kind));
  handle(context, 'studio:board-read', async ({ projectId }) => context.studio.board(projectId));
  handle(context, 'studio:board-plan', async ({ projectId }) => announceBoard(context, projectId, await context.studio.plan(projectId)));
  // Arranging rewrites the order of an existing board, so every window is told, not only the one that asked.
  handle(context, 'studio:board-arrange', async ({ projectId }) => announceBoard(context, projectId, await context.studio.arrange(projectId)));
  handle(context, 'studio:board-next', async ({ projectId }) => context.studio.next(projectId));
  handle(context, 'studio:board-move', async (input) => {
    const card = await context.studio.move(input.projectId, input.cardId, input.status, input.note);
    announceBoard(context, input.projectId, await context.studio.board(input.projectId));
    return card;
  });
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
  handle(context, 'autopilot:start', async (input, request) => context.autopilot.start(input, request.ownerWindowId));
  handle(context, 'autopilot:stop', async ({ projectId }) => context.autopilot.stop(projectId));
  handle(context, 'autopilot:status', async ({ projectId }) => context.autopilot.status(projectId));
  handle(context, 'autopilot:requeue', async ({ projectId }) => ({ requeued: await context.autopilot.requeueBlocked(projectId) }));
  handle(context, 'auto:start', async (input, request) => context.auto.start(input, request.ownerWindowId));
  handle(context, 'auto:stop', async ({ conversationId }) => context.auto.stop(conversationId));
  handle(context, 'auto:status', async ({ conversationId }) => context.auto.status(conversationId));
  handle(context, 'auto:pause', async ({ conversationId }) => context.auto.pause(conversationId));
  handle(context, 'auto:resume', async ({ conversationId }) => context.auto.resume(conversationId));
  handle(context, 'studio:design-read', async ({ projectId }) => context.studio.design(projectId));
  handle(context, 'studio:design-pull', async ({ projectId }) => {
    const pulled = await context.studio.pullDesign(projectId);
    announceBoard(context, projectId, pulled.board);
    return pulled;
  });
  handle(context, 'studio:design-build-step', async ({ projectId, prompt, stepId }, request) =>
    context.studio.buildDesignStep(projectId, prompt, stepId, (event) => {
      const payload = { conversationId: stepId, event } satisfies AgentRunEvent;
      if (context.windows.send(request.ownerWindowId, 'agents:event', payload)) return;
      context.windows.broadcast('agents:event', payload);
    }));
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
    context.mcp.invalidate();
    await restartCognitive1ForOverwatchCredential(context, id);
    const status = await credentialStatus(context);
    await broadcastSharedState(context);
    return status;
  });
  handle(context, 'credentials:clear', async ({ id }) => {
    await context.credentials.delete(id);
    context.mcp.invalidate();
    await restartCognitive1ForOverwatchCredential(context, id);
    const status = await credentialStatus(context);
    await broadcastSharedState(context);
    return status;
  });
  handle(context, 'conversations:list', async () => context.conversations.list());
  handle(context, 'conversations:get', async ({ id }) => context.conversations.get(id));
  handle(context, 'conversations:create', async ({ projectId, firstPrompt }, request) => {
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
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
    if (request.session) request.session.conversationId = conversation.id;
    return conversation;
  });
  handle(context, 'conversations:compact', async ({ conversationId }) => compactConversation(context, conversationId));
  handle(context, 'conversations:save', async (conversation, request) => {
    await context.conversations.save(conversation);
    if (request.session) request.session.conversationId = conversation.id;
    return conversation;
  });
  handle(context, 'conversations:delete', async ({ id }) => {
    const conversation = await context.conversations.get(id);
    if (conversation) {
      await finishMemorySession(context, id, `Session closed when conversation "${conversation.title}" was deleted.`);
    }
    await context.conversations.remove(id);
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
    return (await buildConversationContext(context, project.path, project.name, project.id, conversation, prompt)).preview;
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
  handle(context, 'agents:interject', async ({ conversationId, text }) => {
    if (!canInterject(conversationId)) return { queued: false };
    return { queued: await interject(conversationId, text) };
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
    summarizeUsage(
      await context.conversations.list(),
      (await context.settings.load()).usageBudget,
      new Date(),
      conversationId,
      await context.learningUsage.runs(),
    ));
  handle(context, 'ui:report-view', async ({ view, conversationId }, request) => {
    const owner = request.ownerWindowId;
    const session = context.windows.get(owner);
    if (session) {
      session.view = view;
      session.conversationId = conversationId;
    }
    context.notifications.setViewing(owner, view, conversationId);
    return true;
  });
  handle(context, 'files:tree', async ({ projectId }) => listProjectFiles((await resolveProject(context, projectId, true)).path));
  handle(context, 'files:read', async ({ projectId, path: filePath }) => readProjectFile((await resolveProject(context, projectId, true)).path, filePath));
  handle(context, 'files:write', async ({ projectId, path: filePath, content, expectedHash, eol, bom }) => {
    try {
      return await writeProjectFile((await resolveProject(context, projectId, true)).path, filePath, content, { expectedHash, eol, bom });
    } catch (error) {
      if (error instanceof FileConflictError) throw new ConflictError(error.message);
      throw error;
    }
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
      conversations: await context.conversations.list(),
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
      conversations: await context.conversations.list(),
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
  handle(context, 'learning:evaluate', async (request): Promise<LearningEvaluationResult> => {
    await resolveProject(context, request.projectId, true);
    const settings = await context.settings.load();
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const estimatedInputTokens = Math.ceil((request.code.length + (request.completionContext?.prefix.length ?? 0) + (request.completionContext?.suffix.length ?? 0) + (request.selectedText?.length ?? 0) + (request.question?.length ?? 0) + (request.conversationContext?.length ?? 0)) / 4) + 1_500;
    const reservation = context.learningBudget.reserve({
      projectId: request.projectId,
      provider: readiness.provider,
      model: readiness.model,
      conversations: await context.conversations.list(),
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
      const detailed = await context.learningTutor.evaluateDetailed(request, JSON.stringify({ memory: remembered.memory, concepts: remembered.concepts.slice(0, 20) }));
      await context.learningUsage.record({
        projectId: request.projectId,
        provider: readiness.provider,
        model: readiness.model,
        usage: detailed.usage,
      });
      const progress = request.completionContext ? await context.learningProgress.get(request.projectId) : await context.learningProgress.recordEvaluation(request, detailed.response);
      return { response: detailed.response, progress, usage: detailed.usage };
    } finally {
      context.learningBudget.release(reservation.id);
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
  handle(context, 'learning:generate-teaching-draft', async (input, request) => {
    const settings = await context.settings.load();
    const learningProjectId = request.session?.projectId ?? settings.activeProjectId ?? 'learning-library';
    const readiness = await context.learningTutor.readiness();
    if (!readiness.ready) throw new Error(`${readiness.reason ?? 'Learning Mode is not ready.'} ${readiness.recovery ?? ''}`.trim());
    const reservation = context.learningBudget.reserve({
      projectId: learningProjectId,
      provider: readiness.provider,
      model: readiness.model,
      conversations: await context.conversations.list(),
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
    return formatProjectCode(project.path, filePath, content);
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
  handle(context, 'plan:read', async ({ projectId }) => readPlan(await projectPath(projectId)));
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
  handle(context, 'git:diff', async ({ projectId, path: filePath, staged }) => gitDiffFile(await projectPath(projectId), filePath, staged));
  handle(context, 'review:change', async ({ request: reviewRequest, diff, mode }) => context.changeReviewer.review(reviewRequest, diff, mode));
  handle(context, 'review:changes', async ({ projectId, paths, request: reviewRequest, mode }) => {
    const root = await projectPath(projectId);
    const files: Array<{ path: string; diff: string }> = [];
    for (const filePath of [...new Set(paths)]) files.push({ path: filePath, diff: await gitDiffAgainstHead(root, filePath).catch(() => '') });
    return context.changeReviewer.reviewFiles(reviewRequest ?? '', files, mode);
  });
  handle(context, 'experiences:count', async () => (await context.experiences.list()).length);
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
  handle(context, 'verification:run', async ({ projectId, command }) => {
    // The renderer asks the user to confirm before this channel is called; the command runs with their permissions.
    const project = await resolveProject(context, projectId, true);
    const check = await runCheckCommand(project.path, command);
    const run = await recordVerification(context.verification, project.id, project.path, check);
    await logRegression(context, project.path, project.name, check);
    return run;
  });
  handle(context, 'recovery:list', async () => context.recovery.list());
  handle(context, 'recovery:recap', async ({ conversationId }) => interruptedRunRecap(context, conversationId));
  handle(context, 'recovery:resume', async ({ conversationId }) => {
    const record = await context.recovery.read(conversationId);
    if (!record) throw new NotFoundError('That interrupted run is no longer available.');
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
    });
    if (copy) clipboard.writeText(text);
    return { text };
  });
  handle(context, 'diagnostics:data-locations', async () => dataLocations(context.paths));
  handle(context, 'diagnostics:recent-logs', async ({ count }) => context.logger.recent(count));
  handle(context, 'window:state', async (_input, request) => ({
    maximized: request.session?.window.isMaximized() ?? false,
  }));
  handle(context, 'window:new', async ({ projectId }) => {
    await context.createWindow(projectId ?? null);
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
  const settings = await context.settings.load();
  const projectId = conversation.projectId ?? settings.activeProjectId;
  const project = projectId ? (await context.projects.list()).find((item) => item.id === projectId) : undefined;
  if (!project) return runConversationAgent(context, request, ownerWindowId);

  const startedAt = Date.now();
  const firstTurnIndex = conversation.turns.length;
  const automation = (await context.preferences.get(project.id))?.automation;
  const stop = new AbortController();
  automationRuns.set(request.conversationId, stop);
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
      const check: RecordedCheck = { command, source: 'agent', exitCode: outcome.exitCode, startedAt: new Date(), durationMs: 0, output: outcome.output };
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
  }
  const cancelled = stop.signal.aborted || (outcome.result.status === 'failed' && /cancel/i.test(outcome.result.error ?? ''));
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
      prompt: schedule.prompt,
      agent: schedule.agent,
      execution: schedule.execution,
      route: schedule.route,
      autonomy: schedule.autonomy,
      freshSession: true,
    },
    null,
  );
  const summary = result.status === 'completed' ? result.output.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Completed.' : result.error ?? 'The run failed.';
  return { status: result.status === 'completed' ? 'completed' : 'failed', summary, conversationId: conversation.id };
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

export async function runConversationAgent(
  context: IpcContext,
  request: AgentRunRequest,
  ownerWindowId: number | null = null,
  // Main-process only, never from the renderer: run in a separate copy of the project (a part running side by side).
  options: { cwd?: string } = {},
): Promise<AgentRunResult> {
  const conversation = await context.conversations.get(request.conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');

  const settings = await context.settings.load();
  const projectId = conversation.projectId ?? settings.activeProjectId;
  const project = projectId ? (await context.projects.list()).find((item) => item.id === projectId) : undefined;
  if (!project) throw new NotFoundError('Open a project before sending a message.');
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
  const rulesBriefing = buildExecutionRulesBriefing(authoritativeRules);

  const executionMode = request.execution ?? 'cli';
  if (executionMode === 'api') {
    // Block mode refuses before anything is saved or sent, so the run never reaches the provider.
    const usage = summarizeUsage(
      await context.conversations.list(),
      settings.usageBudget,
      new Date(),
      conversation.id,
      await context.learningUsage.runs(),
    );
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
    text: request.prompt,
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
  };
  conversation.turns.push(userTurn);

  const resumeSessionId = canResume && !conversation.compaction ? conversation.agentSessionId : undefined;
  if (!resumeSessionId && conversation.compaction) delete conversation.agentSessionId;
  await context.conversations.save(conversation);
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

  const memoryEvents: PersistedEvent[] = [];
  if (executionMode === 'api') {
    const projectName = await memoryProjectName(context, project.path, project.name);
    await prepareMemorySession(
      context,
      conversation,
      request,
      project.path,
      projectName,
      previousAgent,
      previousExecution,
      memoryEvents,
    );
  }

  const emit = (event: AgentRunEvent['event']): void => {
    const activity = describeEvent(event);
    if (activity) void context.recovery.touch(conversation.id, activity).catch(() => undefined);
    if (event.type === 'approval.request') {
      void context.notifications.notifyApproval(conversation.id, conversation.title, event.title, ownerWindowId ?? undefined);
      // An Auto run cannot answer a prompt, so it stops and asks the person instead of looking stuck. Optional
      // because a context assembled for a single run (tests, headless callers) may have no Auto loop at all.
      context.auto?.onApprovalRequest(conversation.id, event.title);
    }
    const payload = { conversationId: conversation.id, event } satisfies AgentRunEvent;
    if (ownerWindowId !== null && context.windows.send(ownerWindowId, 'agents:event', payload)) return;
    context.windows.broadcast('agents:event', payload);
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
  const contextText = executionMode === 'api'
    ? (await buildConversationContext(
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
      )).text
    : (await buildConversationContext(
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
      )).text;
  let effectivePrompt = `${workingMethodBriefing()}\n\n${longRunningCommandBriefing()}\n\n${buildSkillPrompt(selectedSkills, request.prompt)}`;
  if (activeGoal) effectivePrompt = buildGoalPrompt(activeGoal, effectivePrompt);
  if (chipContext.text) effectivePrompt = `${chipContext.text}\n\n${effectivePrompt}`;
  if (request.autonomy === 'full') effectivePrompt = `${fullAccessExecutionBriefing(executionMode)}\n\n${effectivePrompt}`;
  // A route/agent switch starts a fresh CLI session. Carry enough transcript
  // forward that the new provider treats this as a continuation, not a new task.
  if (executionMode === 'cli' && !canResume) {
    const handoff = renderConversationHandoff(conversation.turns.slice(0, -1));
    if (handoff) effectivePrompt = `${handoff}\n\n${effectivePrompt}`;
  }
  if (executionMode === 'cli' && contextText) {
    effectivePrompt = `${contextText}\n\n[USER REQUEST]\n${effectivePrompt}`;
  }
  // A run started while a plan is unfinished is very often a diversion: the person steered, or asked a question, and
  // the run that was doing the work is gone. Told what it interrupted, it can answer and then carry on; without this
  // the plan would sit in the project unread while the model dealt with the new request and stopped.
  const planNote = planBriefingFor(await readPlan(workRoot).catch(() => null));
  if (planNote) effectivePrompt = `${planNote}\n\n${effectivePrompt}`;
  const historyTurns = conversation.compaction
    ? conversation.turns.slice(conversation.compaction.throughTurnIndex + 1)
    : conversation.turns;
  const preparedRequest: AgentRunRequest = { ...request, prompt: effectivePrompt };
  /*
   * Whether this run has to carry the standing rules itself, or whether they are already going with it.
   *
   * A CLI run does not, past its first turn: the session is alive and remembers them. A Direct API run has no such
   * session — a request is whatever is sent with it — so the rules go in the prompt, unless the context block being
   * sent already carries them, which is where the API path puts them every time.
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
  const executionRequest = carryRules
    ? applyExecutionRulesToRequest(preparedRequest, rulesBriefing)
    : preparedRequest;
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
      ? 'Standing execution rules (57 rules from Cognitive1) were included in this turn.'
      : executionMode === 'cli'
        ? 'Standing execution rules were sent on this session’s first turn and do not need to be resent while it stays open.'
        : 'Standing execution rules are already carried in this turn’s context, so they were not sent twice.',
  };
  const apiHistory = executionMode === 'api' && historyTurns.length > 0
    ? [
        // Earlier turns carry what they actually did, not just what they said — see `buildTurnDigest`. Without
        // this a follow-up message only ever saw the previous turn's closing prose and had no idea which files
        // were already read or changed, or what a command it ran had printed.
        ...historyTurns.slice(0, -1).map((turn) => ({
          role: turn.role,
          text: turn.toolDigest ? `${turn.text}\n\n[What this turn actually did]\n${turn.toolDigest}` : turn.text,
        })),
        { ...historyTurns[historyTurns.length - 1], text: effectivePrompt },
      ]
    : undefined;
  // A model picked for this run wins; otherwise KAI sizes the request, and the Settings model is the last resort.
  // An agent that keeps getting a level of work wrong is handed that level's work one tier up.
  const recentScores = executionMode === 'cli' && !request.model ? await context.runScores.list() : [];
  const autoPick = executionMode === 'cli' && !request.model
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
  // Announced once the turn is on disk and everything that could still refuse the run is behind us, so a window
  // that takes it up fetches a record that already holds the request.
  announceRunState(context, conversation.id, 'started');
  context.notifications.runStarted(conversation.id);
  const recordDeliveredInterjections = (): number => {
    const messages = takeDeliveredInterjections(conversation.id);
    for (const text of messages) conversation.turns.push({
      id: `turn_${crypto.randomUUID()}`, role: 'user', text, createdAt: new Date().toISOString(),
    });
    return messages.length;
  };
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
      : await context.agents.run(executionRequest, workRoot, resumeSessionId, emit, preferences?.customPermissions, request.model ?? autoPick?.model ?? settings.agentModels[request.agent], autoPick?.note, chipContext.imagePaths);

    // A CLI run is a single process, so an agent that stops with its plan unfinished simply stops — unlike the Direct
    // API path, which loops inside the run and can push it to carry on. The only way to continue here is to invoke the
    // agent again with the outstanding items, which is what this does.
    //
    // Bounded, and only after a run that finished cleanly: a run that failed or was cancelled stopped for a reason,
    // and asking it to carry on would be arguing with the person. Each round is a full invocation, so the cap is low.
    if (executionMode === 'cli') {
      execution = await continueWhilePlanOpen(workRoot, execution, (prompt, sessionId) => context.agents.run(
        { ...executionRequest, prompt },
        workRoot,
        sessionId ?? resumeSessionId,
        emit,
        preferences?.customPermissions,
        request.model ?? autoPick?.model ?? settings.agentModels[request.agent],
        autoPick?.note,
        chipContext.imagePaths,
      ));
    }
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
    context.notifications.runEnded(conversation.id);
    context.runControl.forget(conversation.id);
    // Anything still waiting came too late to reach the run it was meant for, and handing it to the next one would be
    // answering a question nobody is asking any more.
    clearInterjections(conversation.id);
    await context.recovery.end(conversation.id).catch(() => undefined);
    // Released on every exit path: completion, failure, cancellation and thrown errors.
    if (claimedProject) await releaseAgentClaim(context, request.agent);
  }
  recordDeliveredInterjections();
  if (executionMode === 'api' && execution.status === 'failed') {
    const ended = await finishMemorySession(
      context,
      conversation.id,
      `Session ended after agent failure: ${execution.error || 'unknown error'}`,
    );
    if (ended) execution.events.push(ended);
  }
  execution.events.unshift(rulesNotice, ...memoryEvents);
  resolvePendingApprovals(context, conversation.id, false);
  // Files may have changed, so the next run's project outline must be rebuilt.
  invalidateRepoMap(workRoot);
  for (const check of agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)) {
    // The recorded run knows the commit the check ran against; the brain gets it below so a regression can be
    // traced to the change behind it rather than filed against "unknown".
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
  const lessonEvent = await fileRunLesson(context, {
    conversationId: conversation.id,
    agent: request.agent,
    projectPath: project.path,
    projectName: project.name,
    prompt: userTurn.text,
    output: execution.output ?? '',
    status: execution.status,
    error: execution.error,
    files: (userTurn.fileChanges ?? []).map((change) => change.path),
    checks: agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)
      .map((check) => ({ command: check.command, passed: check.exitCode === null ? null : check.exitCode === 0 })),
  });
  if (lessonEvent) execution.events.push(lessonEvent);
  // The model's own account when it gave one. When it did not, the run used to end in silence — commands in the
  // activity list and nothing saying what they added up to — so KAI states the outcome from the facts it holds.
  // What the plan still lists. Said either way, because a model's own account describes what it did and reliably
  // leaves out what it did not get to — which is the half the reader needs to decide what happens next.
  const remaining = openPlanItems(await readPlan(workRoot).catch(() => null)).map((item) => item.text);
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
  const toolDigest = buildTurnDigest(execution.events);
  // Only the model's own words count as a question — the synthesized `describeRunOutcome` fallback never is one —
  // and only a run that actually finished: a failed or cancelled run did not stop because it was asking anything.
  const awaitingAnswer = execution.status === 'completed' && Boolean(spoken) && awaitsTheUser(spoken!);
  conversation.turns.push({
    id: `turn_${crypto.randomUUID()}`,
    role: 'assistant' as const,
    text: closing,
    createdAt: conversation.updatedAt,
    ...(awaitingAnswer ? { awaitingAnswer: true } : {}),
    ...(toolDigest ? { toolDigest } : {}),
  });
  conversation.events.push(...execution.events);
  conversation.agentSessionId = execution.sessionId;
  await context.conversations.save(conversation);
  // Only now, once the turn it produced is on disk: a window that did not run this pulls the record when it hears
  // the run is over, and pulling it before the save would show a reply that stops at the user's own message.
  announceRunState(context, conversation.id, 'finished');

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
    const outcome = execution.status === 'completed'
      ? verification.length > 0 && verification.every((check) => check.passed === true) ? 'verified' : 'unverified'
      : /cancel/i.test(execution.error ?? '') ? 'cancelled' : 'failed';
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

  const cancelled = execution.status === 'failed' && /cancel/i.test(execution.error ?? '');
  void context.notifications.notifyRunFinished(
    conversation.id,
    conversation.title,
    cancelled ? 'cancelled' : execution.status,
    execution.error,
    ownerWindowId ?? undefined,
  );
  if (executionMode === 'api') {
    const usage = summarizeUsage(
      await context.conversations.list(),
      settings.usageBudget,
      new Date(),
      conversation.id,
      await context.learningUsage.runs(),
    );
    void context.notifications.notifyBudget(conversation.id, usage.limits);
  }

  if (execution.error) {
    context.logger.error('agent_crash', `Agent ${request.agent} (${executionMode}) failed`, execution.error);
  } else {
    context.logger.info('internal', `Agent ${request.agent} (${executionMode}) completed`, conversation.title);
  }

  return {
    conversation,
    status: execution.status,
    output: execution.output,
    error: execution.error,
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
  const lesson = composeRunLesson(run);
  if (!lesson || !(await cognitive1Ready(context))) return null;
  try {
    // The daemon answers 200 with `ok: false` when its own quality gate turns the draft away.
    const result = (await context.cognitive1.operation({
      operation: 'brain-auto-learn',
      payload: {
        source: 'session',
        summary: lesson.summary,
        files: lesson.files,
        project: await memoryProjectName(context, run.projectPath, run.projectName),
        agent: run.agent,
      },
    })) as { ok?: boolean } | null;
    if (result?.ok === false) return null;
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

async function interruptedRunRecap(context: IpcContext, conversationId: string) {
  const record = await context.recovery.read(conversationId);
  if (!record) throw new NotFoundError('That interrupted run is no longer available.');
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
): Promise<void> {
  if (!(await cognitive1Ready(context))) return;

  const active = context.memorySessions.get(conversation.id);
  if (
    previousAgent &&
    previousAgent !== request.agent &&
    previousExecution === 'api' &&
    active?.agent !== request.agent
  ) {
    try {
      await context.cognitive1.recordHandoff({
        fromAgent: previousAgent,
        toAgent: request.agent,
        project: projectName,
        status: `Agent switch in "${conversation.title}"`,
        next: recallQuery(request.prompt),
        files: changedFilePaths(conversation).join(', '),
        notes: `Continue the conversation with ${request.agent}.`,
      });
      events.push(memoryEvent(
        conversation.id,
        request.agent,
        'handoff',
        `Recorded a C1 handoff from ${previousAgent} to ${request.agent}.`,
      ));
    } catch (error) {
      context.logger.error('service_error', 'C1 handoff recording failed', undefined, error);
    }
  }

  if (active?.agent === request.agent && active.projectPath === projectPath) return;
  try {
    const session = await context.cognitive1.startSession({
      agent: request.agent,
      projectPath,
      task: recallQuery(request.prompt),
    });
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
  } catch (error) {
    context.logger.error('service_error', 'C1 session start failed', undefined, error);
  }
}

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
) {
  const recall = await recallScopedMemories(context, projectPath, projectName, prompt);
  const filesInPlay = [...new Set([...changedFilePaths(conversation), ...selectedPaths])];
  // What KAI's own runs already did here, chosen by the files this one is about. Read from the scores every scored
  // run writes, so it works with the brain stopped and never leaves the machine.
  const history = await context.runScores.list()
    .then((runs) => buildHistoryNote({ runs, files: filesInPlay, projectId, now: Date.now() }))
    .catch(() => null);
  const projectContext = await buildProjectContext(projectPath, {
    selectedPaths: filesInPlay.slice(-12),
    memories: recall.memories,
    memoryNote: recall.note,
    authoritativeRules,
    omitStatic,
    includeRepoMap,
    ...(history ? { history } : {}),
  });
  if (!compaction) return projectContext;
  return {
    ...projectContext,
    text: `${renderCompactionContext(compaction)}\n\n${projectContext.text}`,
  };
}

function renderConversationHandoff(turns: readonly ConversationRecord['turns'][number][]): string {
  const lines = turns.slice(-12).map((turn) => `${turn.role === 'user' ? 'User' : 'KAi'}: ${turn.text}`).join('\n\n');
  if (!lines) return '';
  return `# Conversation handoff\nYou are continuing an existing conversation after the user changed agent, route, or provider. Preserve the prior intent, decisions, and context; do not ask them to repeat it.\n\n${lines.slice(-60_000)}`;
}

function fullAccessExecutionBriefing(executionMode: ExecutionMode): string {
  const windows = process.platform === 'win32';
  // The Direct API's run_command tool spawns through Git Bash when it is installed (project-tools.ts,
  // agentShell()), not cmd.exe or PowerShell — so the advice below has to match what the command actually runs
  // in. A CLI agent's own shell tool is outside KAI's control and unverified, so it keeps the Windows-specific
  // wording unchanged rather than being told something that may not hold for it.
  const usesGitBash = windows && executionMode === 'api' && Boolean(findGitBash());
  return [
    '# Full access execution policy',
    'The user explicitly selected Full access for this run. You may edit project files, run shell commands, and, when the user explicitly asks, commit and push changes without requesting an additional confirmation.',
    'Complete the requested workflow yourself. Do not stop after a command error merely to give the user instructions when a safe retry or equivalent command can be run.',
    usesGitBash
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

async function renderContextChips(
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
    if (chip.type === 'image') {
      const root = await fs.realpath(attachmentsRoot).catch(() => path.resolve(attachmentsRoot));
      const target = await fs.realpath(chip.path).catch(() => '');
      if (!target || !insideRoot(root, target) || !(await fs.stat(target)).isFile()) {
        throw new Error(`Attached image is unavailable: ${chip.name}`);
      }
      imagePaths.push(target);
      sections.push(`### Attached image\nName: ${chip.name}\nPath: ${target}\nThis is visual input. Open the image with an image-capable reader before answering; do not infer its contents from the file name.`);
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
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('Unsupported image attachment. Use PNG, JPEG, GIF, or WebP.');
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const data = Buffer.from(match[2], 'base64');
  if (data.length === 0 || data.length > 15 * 1024 * 1024) {
    throw new Error('Image attachments must be between 1 byte and 15 MB.');
  }
  await fs.mkdir(context.paths.attachments, { recursive: true });
  const id = `img_${crypto.randomUUID()}`;
  const filePath = path.join(context.paths.attachments, `${id}.${extension}`);
  await fs.writeFile(filePath, data);
  return { type: 'image', name: sanitizeAttachmentName(name, `${id}.${extension}`), path: filePath, dataUrl };
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
  first: AgentExecutionResult,
  runAgain: (prompt: string, sessionId?: string) => Promise<AgentExecutionResult>,
  limit = MAX_PLAN_CONTINUATIONS,
): Promise<AgentExecutionResult> {
  let execution = first;
  for (let round = 0; round < limit && execution.status === 'completed'; round += 1) {
    const plan = await readPlan(workRoot).catch(() => null);
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
  return ['econnrefused', 'econnreset', 'etimedout', 'ehostunreach', 'fetch failed', 'socket hang up', 'unable to connect']
    .some((needle) => text.includes(needle));
}

async function recallScopedMemories(
  context: IpcContext,
  projectPath: string,
  fallbackProjectName: string,
  prompt: string,
): Promise<{ memories: BrainEntry[]; note: string | null }> {
  if (!(await cognitive1Ready(context))) return { memories: [], note: null };
  try {
    const resolution = await resolveProjectMemoryName(context, projectPath, fallbackProjectName);
    const query = recallQuery(prompt);
    const memories = await context.cognitive1.search({ query, project: resolution.name, maxResults: RECALL_LIMIT });

    // Every project's lessons, not only this one's. Most of what a codebase will bite you with has already bitten
    // someone: a stale closure, a date derived from toISOString, a credential keyed by the wrong thing. So the recall
    // is topped up across the whole brain rather than left at whatever this project happens to hold — a project with
    // nothing filed still gets grounding, and a project with a little still benefits from the rest.
    const seen = new Set(memories.map((entry) => `${entry.type}|${entry.title}`));
    const elsewhere = await context.cognitive1
      .search({ query, global: true, maxResults: RECALL_LIMIT * 2 })
      .catch(() => [] as BrainEntry[]);
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
    if (borrowed === 0 || memories.length === 0) return { memories, note };
    // Said plainly, because grounding a project in another project's answers is only honest when the reader can see
    // that is what happened — and can weigh it accordingly.
    const from = memories[memories.length - 1]?.project;
    return {
      memories,
      note: `${note ? `${note} ` : ''}${borrowed} of them come from other projects${from ? `, such as "${from}"` : ''}.`,
    };
  } catch (error) {
    context.logger.error('service_error', 'C1 scoped recall failed', undefined, error);
    return { memories: [], note: 'Memory recall failed, so this run has no recalled memories.' };
  }
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

function recallQuery(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, 500);
}

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
export async function mirrorBrainNow(context: IpcContext, dryRun: boolean): Promise<BrainMirrorOutcome> {
  const settings = await context.settings.load();
  const mirror = settings.cognitive1.mirror;
  if (!mirror.enabled) throw new Error('Turn on the brain mirror in Settings, then try again.');
  if (!(await cognitive1Ready(context))) throw new Error('Cognitive1 is not running yet.');
  return syncBrainToMirror({
    sourceBrain: await sharedBrainPath(context),
    endpoint: mirror.endpoint,
    ...(mirror.token ? { token: mirror.token } : {}),
    dryRun,
  });
}

/** Stops on Stop: the checks and hooks a run's automation is executing, not only the agent. */
const automationRuns = new Map<string, AbortController>();

function cancelAgent(context: IpcContext, conversationId: string): boolean {
  resolvePendingApprovals(context, conversationId, false);
  context.runControl.forget(conversationId);
  const automation = automationRuns.get(conversationId);
  automation?.abort();
  return context.agents.cancel(conversationId) || context.directApi.cancel(conversationId) || Boolean(automation);
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

  return {
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
  const project: ProjectRecord = {
    schemaVersion: 1,
    id: `project_${crypto.randomUUID()}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    createdAt: now,
    lastOpenedAt: now,
  };
  await context.projects.upsert(project);
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
  return { projectId: project.id, projectName: project.name, path: project.path };
}

async function launchStudioProject(
  context: IpcContext,
  studioProjectId: string,
  _destination: 'composer' | 'editor' | 'generate',
): Promise<{ projectId: string; projectName: string; prompt: string }> {
  const state = await context.interview.read({ projectId: studioProjectId });
  if (!state) throw new NotFoundError('Studio project not found.');
  if (state.status !== 'done') throw new Error('Finish the interview before launching the project.');

  const project = await ensureStudioDesktopProject(context, studioProjectId, state);

  const brief = (await context.studio.artifactText(studioProjectId, 'brief'))?.trim();
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
  const request: AgentRunRequest = {
    conversationId: `compact_${crypto.randomUUID()}`,
    prompt: compactionPrompt(transcript),
    agent,
    execution,
    route,
    autonomy: 'plan',
  };

  try {
    if (execution === 'api' && (await context.directApi.capability()).available) {
      const result = await context.directApi.run(request, projectPath);
      if (result.status === 'completed' && result.output.trim()) {
        return limitText(result.output.trim(), MAX_COMPACTION_SUMMARY_CHARS, 'summary');
      }
    } else if (execution === 'cli') {
      const result = await context.agents.run(request, projectPath);
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

async function copyProxyEnv(context: IpcContext, agent: ProxyAgentId): Promise<ProxyEnvCopyResult> {
  const settings = await context.settings.load();
  const value = proxyEnvironmentVariable(settings, agent);
  clipboard.writeText(value);
  return { copied: true, value };
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

function proxyEnvironmentVariable(settings: AppSettings, agent: ProxyAgentId): string {
  const name = agent === 'claude'
    ? 'ANTHROPIC_BASE_URL'
    : agent === 'codex'
      ? 'OPENAI_BASE_URL'
      : agent === 'qwen'
        ? 'QWEN_BASE_URL'
        : 'KIMI_BASE_URL';
  return `${name}=${proxyAgentBaseUrl(settings, agent)}`;
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
  context.mcp.invalidate();
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
