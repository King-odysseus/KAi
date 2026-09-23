import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import {
  type BootstrapPayload,
  type AgentRunEvent,
  type AgentId,
  type AgentRunRequest,
  type AgentRunResult,
  type BrainEntry,
  type ConversationRecord,
  type CredentialStatus,
  type IpcChannel,
  type IpcFailure,
  type IpcResponse,
  type KaiDesktopBridge,
  type LogEntry,
  type PersistedEvent,
  type ProjectRecord,
  type ServiceTokenCopyResult,
  type ServiceState,
  parseIpcInput,
} from '@kai/contracts';
import type { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import type { DesktopAgentRuntime } from './agent-runtime';
import { buildProjectContext } from './context-builder';
import type { DesktopDirectProviderRuntime, DirectApiApprovalPort } from './direct-provider-runtime';
import type { DesktopMcpRuntime } from './mcp-runtime';
import type { Cognitive1Client } from './cognitive1-client';
import { dataLocations, type DesktopPaths } from './paths';
import type { UniversalProxyClient } from './proxy-client';
import { mergeSettingsUpdate, type DesktopServiceController } from './service-controller';
import type { ProjectPreferenceStore } from './project-preference-store';
import type { ProjectStore } from './project-store';

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
  directApi: DesktopDirectProviderRuntime;
  mcp: DesktopMcpRuntime;
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

  const executionMode = request.execution ?? 'cli';
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
  conversation.updatedAt = now;
  conversation.turns.push({
    id: `turn_${crypto.randomUUID()}`,
    role: 'user',
    text: request.prompt,
    createdAt: now,
  });

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
    ? (await buildConversationContext(context, project.path, project.name, conversation, request.prompt)).text
    : '';
  const execution = executionMode === 'api'
    ? await context.directApi.run(request, project.path, resumeSessionId, emit, approvals, contextText, conversation.turns)
    : await context.agents.run(request, project.path, resumeSessionId, emit);
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
) {
  const memories = await recallScopedMemories(context, projectPath, projectName, prompt);
  return buildProjectContext(projectPath, {
    selectedPaths: changedFilePaths(conversation),
    memories,
  });
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

export type DesktopBridge = KaiDesktopBridge;
