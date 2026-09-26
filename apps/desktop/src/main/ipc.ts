import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import {
  type BootstrapPayload,
  type AgentRunEvent,
  type AgentId,
  type AgentRunRequest,
  type AgentRunResult,
  type AppSettings,
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
  type WorkflowTemplate,
  type WorkflowTemplateSaveInput,
  type CodeFormatResult,
  type GitFileInfo,
  type LearningEvaluationResult,
  type LearningLessonRecordResult,
  type LearningProgress,
  type WorkflowRun,
  type WorkflowStartInput,
  parseIpcInput,
  parseTestCounts,
  revertHunks,
  proxyServiceSettingsSchema,
} from '@kai/contracts';
import type { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import type { AgentExecutionResult, DesktopAgentRuntime } from './agent-runtime';
import { buildProjectContext } from './context-builder';
import type { DesktopDirectProviderRuntime, DirectApiApprovalPort } from './direct-provider-runtime';
import { applyExecutionRulesToRequest, buildExecutionRulesBriefing } from './execution-rules';
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
import type { UpdateController } from './updater';
import { buildDiagnosticsReport } from './diagnostics-report';
import { gitCheckout, gitCommit, gitCreateBranch, gitCreatePullRequest, gitDiffFile, gitOverview, gitStage, gitSync } from './git-tools';
import { agentChecksFromEvents, recordVerification, runCheckCommand, verificationOverview, type RecordedCheck, type VerificationStore } from './verification';
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
import type { DesktopWorkflowRunner } from './workflow-runner';
import type { DesktopTeamPlanner } from './team-planner';
import type { DesktopRunControl } from './run-control';
import { brainGitStatus, syncBrainGit } from './brain-git';
import { buildSetupStatus } from './setup-status';
import { syncCognitive1Mcp } from './agent-mcp-config';
import { projectSelectionForWindow, type DesktopWindowRegistry, type DesktopWindowSession } from './desktop-windows';
import type { EditorSessionManager } from './editor-sessions';
import { formatProjectCode, projectGitFileInfo } from './code-tools';
import {
  createCheckpoint,
  diffFromCheckpoint,
  gitDiffStat,
  isGitRepo,
  readFileAtCheckpoint,
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
    resolve: (approved: boolean) => void;
  }>;
  windows: DesktopWindowRegistry;
  editorSessions: EditorSessionManager;
  learningUsage: LearningUsageStore;
  learningBudget: LearningBudgetGuard;
  workflows: DesktopWorkflowRunner;
  teamPlanner: DesktopTeamPlanner;
  runControl: DesktopRunControl;
  notifications: NotificationCenter;
  recovery: RecoveryStore;
  verification: VerificationStore;
  terminal: TerminalManager;
  updater: UpdateController;
  desktopShell: DesktopShell;
  getMainWindow: () => BrowserWindow | null;
  createWindow: () => Promise<void>;
}

interface IpcRequestContext {
  event: Electron.IpcMainInvokeEvent;
  session: DesktopWindowSession | null;
  ownerWindowId: number | null;
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

export function registerIpc(context: IpcContext): void {
  handle(context, 'app:get-bootstrap', async (_input, request) => createBootstrap(context, request.session));
  handle(context, 'projects:choose', async (_input, request) => chooseProject(context, request.session));
  handle(context, 'projects:open', async ({ id }, request) => openProject(context, id, request.session));
  handle(context, 'projects:remove', async ({ id }, request) => removeProject(context, id, request.session));
  handle(context, 'settings:get', async () => context.settings.load());
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
  handle(context, 'cognitive1:tool', async (request) => context.cognitive1.tool(request));
  handle(context, 'cognitive1:operation', async (request) => context.cognitive1.operation(request));
  handle(context, 'rules:get', async () => context.executionRules.document());
  handle(context, 'rules:save', async (rule) => context.executionRules.save(rule));
  handle(context, 'skills:list', async ({ projectId }) => listSkills(context, projectId));
  handle(context, 'files:choose', async ({ projectId }) => chooseProjectFiles(context, projectId));
  handle(context, 'files:search', async ({ projectId, query }) => searchProjectFiles(context, projectId, query));
  handle(context, 'context:git-diff', async ({ projectId }) => gitDiffForProject(context, projectId));
  handle(context, 'attachments:save', async ({ name, dataUrl }) => saveAttachment(context, name, dataUrl));
  handle(context, 'workflows:list-templates', async ({ projectId }) => context.workflowTemplates.list(projectId));
  handle(context, 'workflows:list-runs', async ({ projectId }) => context.workflows.list(projectId));
  handle(context, 'workflows:start', async (input, request) => context.workflows.start(input, ownerWindowId(context, request)));
  handle(context, 'workflows:stop', async ({ workflowId }) => context.workflows.stop(workflowId));
  handle(context, 'workflows:resume', async ({ workflowId }, request) => context.workflows.resume(workflowId, ownerWindowId(context, request)));
  handle(context, 'workflows:save-template', async (template) => context.workflowTemplates.save(template));
  handle(context, 'workflows:delete-template', async ({ id }) => context.workflowTemplates.delete(id));
  handle(context, 'team:plan', async (input, request) => context.teamPlanner.plan(input, ownerWindowId(context, request)));
  handle(context, 'team:start', async (input, request) => context.teamPlanner.start(input, ownerWindowId(context, request)));
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
      title: titleFromPrompt(firstPrompt),
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
    return (await buildConversationContext(context, project.path, project.name, conversation, prompt)).preview;
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
  handle(context, 'agents:run', async (request, ipcRequest) => runConversationAgent(context, request, ownerWindowId(context, ipcRequest)));
  handle(context, 'agents:cancel', async ({ conversationId }) => cancelAgent(context, conversationId));
  handle(context, 'agents:pause', async ({ conversationId }) => context.runControl.pause(conversationId));
  handle(context, 'agents:resume', async ({ conversationId }) => context.runControl.resume(conversationId));
  handle(context, 'agents:sign-in', async ({ agent }) => context.agents.signIn(agent));
  handle(context, 'agents:install', async ({ agent }) => context.agents.install(agent));
  handle(context, 'agents:approval-response', async ({ conversationId, requestId, approved }, request) => {
    const pending = context.pendingApprovals.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return false;
    if (pending.ownerWindowId !== null && pending.ownerWindowId !== request.ownerWindowId) return false;
    context.pendingApprovals.delete(requestId);
    pending.resolve(approved);
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
    const owner = ownerWindowId(context, request);
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
    context.terminal.start(projectId, await projectPath(projectId), shell, cols, rows, ownerWindowId(context, request)));
  handle(context, 'terminal:write', async ({ id, data }) => context.terminal.write(id, data));
  handle(context, 'terminal:resize', async ({ id, cols, rows }) => context.terminal.resize(id, cols, rows));
  handle(context, 'terminal:stop', async ({ id }) => context.terminal.stop(id));
  handle(context, 'git:overview', async ({ projectId }) => gitOverview(await projectPath(projectId)));
  handle(context, 'git:stage', async ({ projectId, paths, stage }) => gitStage(await projectPath(projectId), paths, stage));
  handle(context, 'git:commit', async ({ projectId, message }) => gitCommit(await projectPath(projectId), message));
  handle(context, 'git:checkout', async ({ projectId, branch }) => gitCheckout(await projectPath(projectId), branch));
  handle(context, 'git:create-branch', async ({ projectId, name, checkout }) => gitCreateBranch(await projectPath(projectId), name, checkout));
  // Pushing sends work off this machine, so the renderer confirms it with the user before calling this.
  handle(context, 'git:sync', async ({ projectId, action }) => gitSync(await projectPath(projectId), action));
  handle(context, 'git:diff', async ({ projectId, path: filePath, staged }) => gitDiffFile(await projectPath(projectId), filePath, staged));
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
  handle(context, 'window:new', async () => {
    await context.createWindow();
    return true;
  });
}

async function restartCognitive1ForOverwatchCredential(context: IpcContext, credentialId: string): Promise<void> {
  const settings = await context.settings.load();
  if (!settings.cognitive1.overwatch.enabled || credentialId !== settings.cognitive1.overwatch.credentialId) return;
  const cognitive1Ready = (await context.services.status()).some(
    (service) => service.kind === 'cognitive1' && service.status === 'ready',
  );
  if (cognitive1Ready) await context.services.restart('cognitive1', settings);
}

export async function runConversationAgent(
  context: IpcContext,
  request: AgentRunRequest,
  ownerWindowId: number | null = null,
): Promise<AgentRunResult> {
  const conversation = await context.conversations.get(request.conversationId);
  if (!conversation) throw new NotFoundError('Conversation not found.');

  const settings = await context.settings.load();
  const projectId = conversation.projectId ?? settings.activeProjectId;
  const project = projectId ? (await context.projects.list()).find((item) => item.id === projectId) : undefined;
  if (!project) throw new NotFoundError('Open a project before sending a message.');

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
  const selectedPaths = await resolveSelectedProjectPaths(project.path, [
    ...(request.selectedPaths ?? []),
    ...chipPaths,
  ]);
  const chipContext = await renderContextChips(
    project.path,
    context.paths.attachments,
    request.contextChips ?? [],
  );
  const availableSkills = await discoverDesktopSkills(project.path);
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
  const checkpoint = (await isGitRepo(project.path))
    ? await createCheckpoint(project.path).catch(() => null)
    : null;
  const userTurn: ConversationRecord['turns'][number] = {
    id: `turn_${crypto.randomUUID()}`,
    role: 'user',
    text: request.prompt,
    createdAt: now,
    ...(checkpoint ? { checkpoint } : {}),
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
    const projectName = await memoryProjectName(project.path, project.name);
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
    }
    const payload = { conversationId: conversation.id, event } satisfies AgentRunEvent;
    if (ownerWindowId !== null && context.windows.send(ownerWindowId, 'agents:event', payload)) return;
    context.windows.broadcast('agents:event', payload);
  };
  const approvals: DirectApiApprovalPort = {
    request: (approval) => new Promise<boolean>((resolve) => {
      const event: Extract<AgentRunEvent['event'], { type: 'approval.request' }> = {
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
      };
      context.pendingApprovals.set(approval.requestId, { conversationId: conversation.id, ownerWindowId, event, resolve });
    }),
  };
  const contextText = executionMode === 'api'
    ? (await buildConversationContext(
        context,
        project.path,
        project.name,
        conversation,
        request.prompt,
        authoritativeRules,
        selectedPaths,
        conversation.compaction,
      )).text
    : (await buildConversationContext(
        context,
        project.path,
        project.name,
        conversation,
        request.prompt,
        undefined,
        selectedPaths,
        conversation.compaction,
      )).text;
  let effectivePrompt = buildSkillPrompt(selectedSkills, request.prompt);
  if (activeGoal) effectivePrompt = buildGoalPrompt(activeGoal, effectivePrompt);
  if (chipContext) effectivePrompt = `${chipContext}\n\n${effectivePrompt}`;
  if (executionMode === 'cli' && contextText) {
    effectivePrompt = `${contextText}\n\n[USER REQUEST]\n${effectivePrompt}`;
  }
  const preparedRequest: AgentRunRequest = { ...request, prompt: effectivePrompt };
  const executionRequest = executionMode === 'cli'
    ? applyExecutionRulesToRequest(preparedRequest, rulesBriefing)
    : preparedRequest;
  const historyTurns = conversation.compaction
    ? conversation.turns.slice(conversation.compaction.throughTurnIndex + 1)
    : conversation.turns;
  const apiHistory = executionMode === 'api' && historyTurns.length > 0
    ? [
        ...historyTurns.slice(0, -1),
        { ...historyTurns[historyTurns.length - 1], text: effectivePrompt },
      ]
    : undefined;
  let execution: AgentExecutionResult;
  // CLI runs claim the project so other agents see the work; API runs are claimed by their memory session.
  const claimedProject = executionMode === 'cli' && (await cognitive1Ready(context))
    ? await memoryProjectName(project.path, project.name)
    : null;
  if (claimedProject) {
    await context.cognitive1.operation({
      operation: 'active-claim',
      payload: { agent: request.agent, project: claimedProject, what: conversation.title, files: selectedPaths.join(',') },
    }).catch(() => undefined);
  }
  context.notifications.runStarted(conversation.id);
  try {
    execution = executionMode === 'api'
      ? await context.directApi.run(
          executionRequest,
          project.path,
          resumeSessionId,
          emit,
          approvals,
          contextText,
          apiHistory,
          preferences?.customPermissions,
        )
      : await context.agents.run(executionRequest, project.path, resumeSessionId, emit, preferences?.customPermissions, request.model ?? settings.agentModels[request.agent]);
  } finally {
    context.notifications.runEnded(conversation.id);
    context.runControl.forget(conversation.id);
    await context.recovery.end(conversation.id).catch(() => undefined);
    // Released on every exit path: completion, failure, cancellation and thrown errors.
    if (claimedProject) await releaseAgentClaim(context, request.agent);
  }
  if (executionMode === 'api' && execution.status === 'failed') {
    const ended = await finishMemorySession(
      context,
      conversation.id,
      `Session ended after agent failure: ${execution.error || 'unknown error'}`,
    );
    if (ended) execution.events.push(ended);
  }
  execution.events.unshift(...memoryEvents);
  resolvePendingApprovals(context, conversation.id, false);
  for (const check of agentChecksFromEvents(execution.events as Array<{ type: string } & Record<string, unknown>>)) {
    await recordVerification(context.verification, project.id, project.path, check).catch(() => undefined);
    await logRegression(context, project.path, project.name, check);
  }
  conversation.updatedAt = new Date().toISOString();
  if (checkpoint) {
    const files = await diffFromCheckpoint(project.path, checkpoint).catch(() => []);
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
  conversation.turns.push(...(execution.output
    ? [{
        id: `turn_${crypto.randomUUID()}`,
        role: 'assistant' as const,
        text: execution.output,
        createdAt: conversation.updatedAt,
      }]
    : []));
  conversation.events.push(...execution.events);
  conversation.agentSessionId = execution.sessionId;
  await context.conversations.save(conversation);

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
async function logRegression(context: IpcContext, projectPath: string, projectName: string, check: RecordedCheck): Promise<void> {
  const counts = parseTestCounts(check.output);
  if (counts.passed === null || !(await cognitive1Ready(context))) return;
  await context.cognitive1.tool({
    tool: 'regression_log',
    arguments: { project: await memoryProjectName(projectPath, projectName), passed: counts.passed, failed: counts.failed ?? 0, notes: `${check.source}: ${check.command}`.slice(0, 300), agent: 'kai-desktop' },
  }).catch(() => undefined);
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
      arguments: { files: files.join(','), project: await memoryProjectName(project.path, project.name) },
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
  conversation: ConversationRecord | null,
  prompt: string,
  authoritativeRules?: string,
  selectedPaths: readonly string[] = [],
  compaction?: ConversationRecord['compaction'],
) {
  const memories = await recallScopedMemories(context, projectPath, projectName, prompt);
  const projectContext = await buildProjectContext(projectPath, {
    selectedPaths: [...new Set([...changedFilePaths(conversation), ...selectedPaths])].slice(-12),
    memories,
    authoritativeRules,
  });
  if (!compaction) return projectContext;
  return {
    ...projectContext,
    text: `${renderCompactionContext(compaction)}\n\n${projectContext.text}`,
  };
}

async function renderContextChips(
  projectPath: string,
  attachmentsRoot: string,
  chips: readonly ContextChip[],
): Promise<string> {
  if (chips.length === 0) return '';
  const sections: string[] = [];
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
      sections.push(`### Attached image\nName: ${chip.name}\nPath: ${target}`);
    }
  }
  return sections.length > 0 ? `# Attached context\n${sections.join('\n\n')}` : '';
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
  return { type: 'image', name: sanitizeAttachmentName(name, `${id}.${extension}`), path: filePath };
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

async function recallScopedMemories(
  context: IpcContext,
  projectPath: string,
  fallbackProjectName: string,
  prompt: string,
): Promise<BrainEntry[]> {
  if (!(await cognitive1Ready(context))) return [];
  try {
    return await context.cognitive1.search({
      query: recallQuery(prompt),
      project: await memoryProjectName(projectPath, fallbackProjectName),
      maxResults: 8,
    });
  } catch (error) {
    context.logger.error('service_error', 'C1 scoped recall failed', undefined, error);
    return [];
  }
}

async function cognitive1Ready(context: IpcContext): Promise<boolean> {
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

async function memoryProjectName(projectPath: string, fallback: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const value = JSON.parse(raw) as { displayName?: unknown; name?: unknown };
    if (typeof value.displayName === 'string' && value.displayName.trim()) return value.displayName.trim();
    if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  } catch {
    // A project does not need a package manifest to use its folder name.
  }
  return fallback;
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

function cancelAgent(context: IpcContext, conversationId: string): boolean {
  resolvePendingApprovals(context, conversationId, false);
  context.runControl.forget(conversationId);
  return context.agents.cancel(conversationId) || context.directApi.cancel(conversationId);
}

async function sharedBrainPath(context: IpcContext): Promise<string> {
  const settings = await context.settings.load();
  const dataRoot = settings.cognitive1.dataPath ?? path.join(context.paths.root, 'engines', 'cognitive1');
  return path.join(dataRoot, 'brain');
}

async function currentSetupStatus(context: IpcContext): Promise<Awaited<ReturnType<typeof buildSetupStatus>>> {
  return buildSetupStatus({
    settings: () => context.settings.load(),
    projects: async () => (await context.projects.list()).map((project) => ({ id: project.id })),
    services: () => context.services.status(),
    agentCapabilities: async () => (await context.agents.capabilities()).map((capability) => ({
      available: capability.available,
      displayName: capability.displayName,
      ...(capability.unavailableReason ? { unavailableReason: capability.unavailableReason } : {}),
    })),
    directApiAvailable: async () => (await context.directApi.capability()).available,
    directApiDetail: async () => (await context.directApi.capability()).unavailableReason ?? 'Configure a direct API provider.',
  });
}

function resolvePendingApprovals(context: IpcContext, conversationId: string, approved: boolean): void {
  for (const [requestId, pending] of context.pendingApprovals) {
    if (pending.conversationId !== conversationId) continue;
    context.pendingApprovals.delete(requestId);
    pending.resolve(approved);
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
      pending.resolve(false);
    }
  }
}

async function credentialStatus(context: IpcContext): Promise<CredentialStatus> {
  return { available: context.credentials.isAvailable(), ids: await context.credentials.status() };
}

function handle<TChannel extends IpcChannel>(
  context: IpcContext,
  channel: TChannel,
  handler: (
    input: ReturnType<typeof parseIpcInput<TChannel>>,
    request: IpcRequestContext,
  ) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, rawInput: unknown): Promise<IpcResponse<unknown>> => {
    try {
      assertTrustedSender(event.senderFrame?.url ?? '');
      const input = parseIpcInput(channel, rawInput);
      const session = context.windows.fromWebContentsId(event.sender.id);
      const data = await handler(input, {
        event,
        session,
        ownerWindowId: session?.id ?? null,
      });
      return { ok: true, data };
    } catch (error) {
      context.logger.error('ipc_error', `IPC ${channel} failed`, undefined, error);
      return failureFor(error);
    }
  });
}

function ownerWindowId(context: IpcContext, request: IpcRequestContext): number {
  return request.ownerWindowId ?? request.event.sender.id ?? context.windows.focused()?.id ?? 0;
}

function assertTrustedSender(url: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && url.startsWith(devUrl)) return;
  if (url.startsWith('file://')) return;
  throw new Error('IPC request came from an untrusted renderer.');
}

function failureFor(error: unknown): IpcFailure {
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
