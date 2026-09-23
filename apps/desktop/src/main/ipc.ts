import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import {
  type BootstrapPayload,
  type AgentRunEvent,
  type AgentId,
  type AgentRunRequest,
  type AgentRunResult,
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
  type ProjectRecord,
  type SkillSummary,
  type ServiceTokenCopyResult,
  type ServiceState,
  type WorkflowTemplate,
  type WorkflowTemplateSaveInput,
  parseIpcInput,
} from '@kai/contracts';
import type { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import type { DesktopAgentRuntime } from './agent-runtime';
import { buildProjectContext } from './context-builder';
import type { DesktopDirectProviderRuntime, DirectApiApprovalPort } from './direct-provider-runtime';
import { applyExecutionRulesToRequest, buildExecutionRulesBriefing } from './execution-rules';
import type { DesktopExecutionRules } from './execution-rules';
import type { DesktopMcpRuntime } from './mcp-runtime';
import type { Cognitive1Client } from './cognitive1-client';
import { dataLocations, type DesktopPaths } from './paths';
import type { UniversalProxyClient } from './proxy-client';
import { mergeSettingsUpdate, type DesktopServiceController } from './service-controller';
import type { ProjectPreferenceStore } from './project-preference-store';
import type { ProjectStore } from './project-store';
import { buildSkillPrompt, discoverDesktopSkills, skillSummaries } from './skills';
import type { WorkflowTemplateStore } from './workflow-templates';
import type { DesktopConfigBackupStore } from './backups';
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

export interface IpcContext {
  appName: string;
  version: string;
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
  agents: DesktopAgentRuntime;
  executionRules: DesktopExecutionRules;
  directApi: DesktopDirectProviderRuntime;
  mcp: DesktopMcpRuntime;
  workflowTemplates: WorkflowTemplateStore;
  backups: DesktopConfigBackupStore;
  compareRuns: Map<string, ActiveCompareRun>;
  memorySessions: Map<string, ActiveMemorySession>;
  pendingApprovals: Map<string, { conversationId: string; resolve: (approved: boolean) => void }>;
  getMainWindow: () => BrowserWindow | null;
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
  handle(context, 'app:get-bootstrap', async () => createBootstrap(context));
  handle(context, 'projects:choose', async () => chooseProject(context));
  handle(context, 'projects:open', async ({ id }) => openProject(context, id));
  handle(context, 'projects:remove', async ({ id }) => removeProject(context, id));
  handle(context, 'settings:get', async () => context.settings.load());
  handle(context, 'settings:update', async (update) => {
    const settings = await context.settings.load();
    const merged = mergeSettingsUpdate(settings, update);
    await context.settings.save(merged);
    context.mcp.invalidate();
    await context.services.syncFromSettings(merged);
    return context.settings.load();
  });
  handle(context, 'services:status', async () => context.services.status());
  handle(context, 'services:start', async ({ kind }) => context.services.start(kind));
  handle(context, 'services:stop', async ({ kind }) => context.services.stop(kind));
  handle(context, 'services:restart', async ({ kind }) => context.services.restart(kind));
  handle(context, 'services:rotate-token', async ({ kind }) => context.services.rotateToken(kind));
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
  handle(context, 'rules:get', async () => context.executionRules.document());
  handle(context, 'rules:save', async (rule) => context.executionRules.save(rule));
  handle(context, 'skills:list', async ({ projectId }) => listSkills(context, projectId));
  handle(context, 'files:choose', async ({ projectId }) => chooseProjectFiles(context, projectId));
  handle(context, 'files:search', async ({ projectId, query }) => searchProjectFiles(context, projectId, query));
  handle(context, 'context:git-diff', async ({ projectId }) => gitDiffForProject(context, projectId));
  handle(context, 'attachments:save', async ({ name, dataUrl }) => saveAttachment(context, name, dataUrl));
  handle(context, 'workflows:list-templates', async () => context.workflowTemplates.list());
  handle(context, 'workflows:save-template', async (template) => context.workflowTemplates.save(template));
  handle(context, 'workflows:delete-template', async ({ id }) => context.workflowTemplates.delete(id));
  handle(context, 'proxy:overview', async () => context.proxy.overview());
  handle(context, 'proxy:history', async (query) => context.proxy.history(query));
  handle(context, 'proxy:history-detail', async ({ id }) => context.proxy.historyDetail(id));
  handle(context, 'proxy:clear-history', async () => context.proxy.clearHistory());
  handle(context, 'preferences:get', async ({ projectId }) => context.preferences.get(projectId));
  handle(context, 'preferences:update', async (preferences) => {
    await context.preferences.upsert(preferences);
    return preferences;
  });
  handle(context, 'credentials:status', async () => credentialStatus(context));
  handle(context, 'credentials:set', async ({ id, value }) => {
    await context.credentials.set(id, value);
    context.mcp.invalidate();
    return credentialStatus(context);
  });
  handle(context, 'credentials:clear', async ({ id }) => {
    await context.credentials.delete(id);
    context.mcp.invalidate();
    return credentialStatus(context);
  });
  handle(context, 'conversations:list', async () => context.conversations.list());
  handle(context, 'conversations:get', async ({ id }) => context.conversations.get(id));
  handle(context, 'conversations:create', async ({ projectId, firstPrompt }) => {
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
    return conversation;
  });
  handle(context, 'conversations:save', async (conversation) => {
    await context.conversations.save(conversation);
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
  handle(context, 'agents:run', async (request) => runConversationAgent(context, request));
  handle(context, 'agents:cancel', async ({ conversationId }) => cancelAgent(context, conversationId));
  handle(context, 'agents:sign-in', async ({ agent }) => context.agents.signIn(agent));
  handle(context, 'agents:approval-response', async ({ conversationId, requestId, approved }) => {
    const pending = context.pendingApprovals.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return false;
    context.pendingApprovals.delete(requestId);
    pending.resolve(approved);
    return true;
  });
  handle(context, 'diagnostics:data-locations', async () => dataLocations(context.paths));
  handle(context, 'diagnostics:recent-logs', async ({ count }) => context.logger.recent(count));
  handle(context, 'window:state', async () => ({ maximized: context.getMainWindow()?.isMaximized() ?? false }));
}

async function runConversationAgent(
  context: IpcContext,
  request: AgentRunRequest,
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

  const resumeSessionId = canResume ? conversation.agentSessionId : undefined;
  await context.conversations.save(conversation);

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
    const window = context.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send('agents:event', { conversationId: conversation.id, event } satisfies AgentRunEvent);
  };
  const approvals: DirectApiApprovalPort = {
    request: (approval) => new Promise<boolean>((resolve) => {
      context.pendingApprovals.set(approval.requestId, { conversationId: conversation.id, resolve });
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
      )).text
    : (await buildConversationContext(
        context,
        project.path,
        project.name,
        conversation,
        request.prompt,
        undefined,
        selectedPaths,
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
  const apiHistory = executionMode === 'api' && conversation.turns.length > 0
    ? [
        ...conversation.turns.slice(0, -1),
        { ...conversation.turns[conversation.turns.length - 1], text: effectivePrompt },
      ]
    : undefined;
  const execution = executionMode === 'api'
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
    : await context.agents.run(executionRequest, project.path, resumeSessionId, emit, preferences?.customPermissions);
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
  };
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
) {
  const memories = await recallScopedMemories(context, projectPath, projectName, prompt);
  return buildProjectContext(projectPath, {
    selectedPaths: [...new Set([...changedFilePaths(conversation), ...selectedPaths])].slice(-12),
    memories,
    authoritativeRules,
  });
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

function cancelAgent(context: IpcContext, conversationId: string): boolean {
  resolvePendingApprovals(context, conversationId, false);
  return context.agents.cancel(conversationId) || context.directApi.cancel(conversationId);
}

function resolvePendingApprovals(context: IpcContext, conversationId: string, approved: boolean): void {
  for (const [requestId, pending] of context.pendingApprovals) {
    if (pending.conversationId !== conversationId) continue;
    context.pendingApprovals.delete(requestId);
    pending.resolve(approved);
  }
}

async function createBootstrap(context: IpcContext): Promise<BootstrapPayload> {
  const [settings, projects, services] = await Promise.all([
    context.settings.load(),
    context.projects.list(),
    context.services.status(),
  ]);

  return {
    appName: context.appName,
    version: context.version,
    platform: process.platform,
    projects,
    activeProjectId: settings.activeProjectId,
    settings,
    services,
    dataLocations: dataLocations(context.paths),
  };
}

async function chooseProject(context: IpcContext): Promise<ProjectRecord | null> {
  const options: OpenDialogOptions = {
    title: 'Open a project',
    properties: ['openDirectory', 'createDirectory'],
  };
  const mainWindow = context.getMainWindow();
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
  const settings = await context.settings.load();
  await context.settings.save({
    ...settings,
    activeProjectId: project.id,
    projectOrder: [project.id, ...settings.projectOrder.filter((id) => id !== project.id)],
  });
  context.logger.info('internal', 'Project opened', project.name);
  return project;
}

async function openProject(context: IpcContext, id: string): Promise<BootstrapPayload> {
  const project = (await context.projects.list()).find((item) => item.id === id);
  if (!project) throw new NotFoundError('Project not found.');
  project.lastOpenedAt = new Date().toISOString();
  await context.projects.upsert(project);
  const settings = await context.settings.load();
  await context.settings.save({
    ...settings,
    activeProjectId: id,
    projectOrder: [id, ...settings.projectOrder.filter((projectId) => projectId !== id)],
  });
  return createBootstrap(context);
}

async function removeProject(context: IpcContext, id: string): Promise<BootstrapPayload> {
  await context.projects.remove(id);
  await context.preferences.remove(id);
  const settings = await context.settings.load();
  await context.settings.save({
    ...settings,
    activeProjectId: settings.activeProjectId === id ? null : settings.activeProjectId,
    projectOrder: settings.projectOrder.filter((projectId) => projectId !== id),
  });
  return createBootstrap(context);
}

async function credentialStatus(context: IpcContext): Promise<CredentialStatus> {
  return { available: context.credentials.isAvailable(), ids: await context.credentials.status() };
}

function handle<TChannel extends IpcChannel>(
  context: IpcContext,
  channel: TChannel,
  handler: (input: ReturnType<typeof parseIpcInput<TChannel>>) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, rawInput: unknown): Promise<IpcResponse<unknown>> => {
    try {
      assertTrustedSender(event.senderFrame?.url ?? '');
      const input = parseIpcInput(channel, rawInput);
      const data = await handler(input);
      return { ok: true, data };
    } catch (error) {
      context.logger.error('ipc_error', `IPC ${channel} failed`, undefined, error);
      return failureFor(error);
    }
  });
}

function assertTrustedSender(url: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && url.startsWith(devUrl)) return;
  if (url.startsWith('file://')) return;
  throw new Error('IPC request came from an untrusted renderer.');
}

function failureFor(error: unknown): IpcFailure {
  if (error instanceof NotFoundError) return { ok: false, error: { code: 'NOT_FOUND', message: error.message } };
  if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Request validation failed.' } };
  }
  return {
    ok: false,
    error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Unexpected error.' },
  };
}

class NotFoundError extends Error {}

function titleFromPrompt(prompt: string): string {
  const title = prompt.trim().replace(/\s+/g, ' ').slice(0, 64);
  return title || 'New conversation';
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

  const selectedRoot = path.resolve(selection.filePaths[0]);
  const nestedBrain = path.join(selectedRoot, 'brain');
  const sourcePath = await directoryExists(nestedBrain) ? nestedBrain : selectedRoot;
  const settings = await context.settings.load();
  const dataRoot = settings.cognitive1.dataPath ?? path.join(context.paths.root, 'engines', 'cognitive1');
  const targetPath = path.join(dataRoot, 'brain');
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('The selected folder is already KAI desktop\'s active C1 brain.');
  }

  const result = await copyMissingFiles(sourcePath, targetPath);
  if (settings.cognitive1.enabled) {
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

export type DesktopBridge = KaiDesktopBridge;
