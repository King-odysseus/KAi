import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import { DIRECT_PROVIDER_ORDER, OPENPENCIL_CREDENTIAL_ID, OPENPENCIL_ENDPOINT, OPENPENCIL_MCP_SERVER_ID, directProviderPreset, isLocalProvider, migrateDeepSeekModel, type RemoteWindowSummary } from '@kai/contracts';
import { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import { Cognitive1Client } from './cognitive1-client';
import { cliProxyEnvironment, DesktopAgentRuntime } from './agent-runtime';
import { installKaiProjectMcpForAgents, preparePlaywrightMcpSettings, syncCognitive1Mcp, withOpenPencilMcpSetting } from './agent-mcp-config';
import { DesktopConfigBackupStore } from './backups';
import { CredentialVault } from './credential-vault';
import { DesktopDirectProviderRuntime } from './direct-provider-runtime';
import { DesktopExecutionRules } from './execution-rules';
import { DesktopMcpRuntime } from './mcp-runtime';
import { DesktopChangeReviewer } from './change-review';
import { configureCopyCheckpoints } from './copy-checkpoints';
import { jobFileFromArgv, processHeadlessJobFile } from './headless';
import { DesktopEvals, EvalStore } from './evals';
import { RunScoreStore } from './run-scores';
import { AgentExperienceStore } from './experience-store';
import { DesktopScheduler, ScheduleStore } from './scheduler';
import { cancelConversationRun, closeCompareRuns, closeMemorySessions, confirmEditorNavigation, handleRendererWindowClosed, importBrainFromDirectory, registerIpc, runConversationAgent, runInteractiveAgent, runScheduledGoal, type IpcContext } from './ipc';
import { createDesktopPaths } from './paths';
import { UniversalProxyClient } from './proxy-client';
import { DesktopProxyRouting } from './proxy-routing';
import { ProjectPreferenceStore } from './project-preference-store';
import { ProjectStore } from './project-store';
import { RotatingLogSink } from './rotating-log-sink';
import { DesktopShell } from './desktop-shell';
import { RecoveryStore } from './recovery-store';
import { TerminalManager } from './terminal';
import { UpdateController } from './updater';
import { autoUpdater } from 'electron-updater';
import { hashFile, recordVerification, runCheckCommand, VerificationStore } from './verification';
import { gitOverview } from './git-tools';
import { NotificationCenter } from './notification-rules';
import { DesktopServiceController } from './service-controller';
import { WorkflowTemplateStore } from './workflow-templates';
import { LearningProgressStore } from './learning-progress';
import { DesktopLearningTutor } from './learning-tutor';
import { TeachingLibraryStore } from './teaching-library';
import { EditorSessionManager } from './editor-sessions';
import { LearningBudgetGuard, LearningUsageStore } from './learning-usage';
import { DesktopWorkflowRunner } from './workflow-runner';
import { DesktopTeamPlanner } from './team-planner';
import { DesktopPromptGuide } from './prompt-guide';
import { DesktopInterview } from './interview';
import { InterviewStore } from './interview-store';
import { StudioArtifacts } from './artifacts';
import { StudioBoardStore } from './board';
import { DesktopStudio } from './studio';
import { SPEC_ROOT, SpecStore } from './spec-store';
import { DesktopUiCheck, playwrightUiCheckPorts } from './ui-check';
import { resolveInside } from './project-files';
import { completeTeam } from './team-assign';
import { TeamRecordStore } from './team-record-store';
import { activeParallelDirectories, createParallelSession } from './parallel-session';
import { cleanupParallelWorktrees } from './git-worktrees';
import { DesktopRunControl } from './run-control';
import { DesktopWindowRegistry } from './desktop-windows';
import { reloadShortcut } from './reload-shortcut';
import { PreviewRuntime } from './preview-runtime';
import { RemoteDispatcher } from './remote/dispatch';
import { RemoteGateway } from './remote/server';

app.setName('KAI');
if (process.env.KAI_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.KAI_DESKTOP_USER_DATA));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let ipcContext: IpcContext | null = null;
let serviceController: DesktopServiceController | null = null;
let mcpRuntime: DesktopMcpRuntime | null = null;
let remoteGateway: RemoteGateway | null = null;
let shutdownPromise: Promise<void> | null = null;
let desktopShell: DesktopShell | null = null;
let quitting = false;
const desktopWindows = new DesktopWindowRegistry();
const forceClosing = new Set<number>();
let parallelCleanupStarted = false;

// `kai run ...` launches KAI with a job file. A launch that is only a job gets no window and quits when it is done.
const startupJobFile = jobFileFromArgv(process.argv);
let headlessReady = false;
let headlessJobsInFlight = 0;
const queuedJobFiles: string[] = [];

async function handleHeadlessJob(jobFile: string): Promise<void> {
  const context = ipcContext;
  if (!context) return;
  headlessJobsInFlight += 1;
  try {
    await processHeadlessJobFile(
      {
        projects: () => context.projects.list(),
        createConversation: async (projectId, title) => {
          const now = new Date().toISOString();
          const conversation = {
            schemaVersion: 1 as const, id: `conv_${crypto.randomUUID()}`, projectId, title, createdAt: now, updatedAt: now,
            archived: false, unread: true, activeAgent: null, route: null, autonomy: null, turns: [], events: [],
          };
          await context.conversations.save(conversation);
          return conversation.id;
        },
        run: (request) => runInteractiveAgent(context, request, null),
      },
      jobFile,
    );
  } finally {
    headlessJobsInFlight -= 1;
    if (startupJobFile && headlessJobsInFlight === 0 && BrowserWindow.getAllWindows().length === 0) app.quit();
  }
}

function submitHeadlessJob(jobFile: string): void {
  if (headlessReady) void handleHeadlessJob(jobFile);
  else queuedJobFiles.push(jobFile);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const jobFile = jobFileFromArgv(commandLine);
    if (jobFile) {
      submitHeadlessJob(jobFile);
      return;
    }
    const window = desktopWindows.focused()?.window;
    // A retained tray process can outlive a renderer/window failure. Never leave a
    // second launch stranded behind that process: create a usable window again.
    if (!window || window.isDestroyed()) {
      void createMainWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

app.whenReady().then(startApplication).catch(reportStartupFailure);

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // Closing the last window ends KAI and every process it started (Cognitive1, the proxy, MCP servers, terminals),
  // even with KAI Remote on: the phone console is only reachable while KAI is open. Someone who wants KAI to keep
  // running in the background can turn on the tray option, which keeps the app alive while an agent is working.
  app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  const activeContext = ipcContext;
  if (!activeContext || shutdownPromise) return;
  event.preventDefault();
  shutdownPromise = (async () => {
    for (const session of desktopWindows.live()) {
      if (await confirmEditorNavigation(activeContext, session, 'quit KAI')) continue;
      quitting = false;
      throw new Error('QUIT_CANCELLED');
    }
    // The user has agreed to quit. If a service refuses to stop, leave anyway rather than linger as background
    // processes after the window is gone.
    const forceExit = setTimeout(() => {
      ipcContext?.logger.warn('internal', 'Shutdown took too long; exiting anyway');
      app.exit(0);
    }, 15_000);
    forceExit.unref();
  })()
    .then(() => closeMemorySessions(activeContext))
    .then(() => (activeContext ? closeCompareRuns(activeContext) : Promise.resolve()))
    .then(() => activeContext?.workflows.dispose())
    .then(() => activeContext?.scheduler.stop())
    .then(() => activeContext?.terminal.stopAll())
    .then(() => activeContext?.preview.stopAll())
    .then(() => Promise.all([
      serviceController?.dispose() ?? Promise.resolve(),
      // On Windows the MCP servers are ended with everything else at the very end, while they are still attached to
      // KAI; closing them one by one first would leave the processes behind them running.
      process.platform === 'win32' ? Promise.resolve() : (mcpRuntime?.dispose() ?? Promise.resolve()),
      remoteGateway?.dispose() ?? Promise.resolve(),
    ]))
    .then(() => undefined)
    .catch((error) => {
      if (messageOf(error) !== 'QUIT_CANCELLED') {
        ipcContext?.logger.error('service_error', 'Service shutdown failed', undefined, error);
      }
    })
    .finally(() => {
      if (!quitting) {
        shutdownPromise = null;
        return;
      }
      serviceController = null;
      mcpRuntime = null;
      remoteGateway = null;
      desktopShell?.dispose();
      endOwnProcessTree();
      app.exit(0);
    });
});

/**
 * Ends every process KAI started (services, agents, commands, terminals, dev servers) so closing the window leaves
 * nothing running. Windows does not do this by itself: a child keeps running after its parent exits. The tree is
 * ended by a separate process because this one is part of it.
 */
function endOwnProcessTree(): void {
  if (process.platform !== 'win32') return;
  try {
    spawn('taskkill', ['/pid', String(process.pid), '/T', '/F'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch {
    // Exiting anyway; the services were already asked to stop.
  }
}

app.on('activate', () => {
  const window = desktopWindows.focused()?.window;
  if (!window || window.isDestroyed()) {
    void createMainWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

async function startApplication(): Promise<void> {
  const userDataRoot = process.env.KAI_DESKTOP_USER_DATA ?? app.getPath('userData');
  const paths = createDesktopPaths(userDataRoot);
  const fileSystem = new NodeFileSystem();
  const logger = new RedactedLogger(new RotatingLogSink(paths.logs));
  const buildIdentifier = await identifyBuild(app.getVersion());
  const settings = new SettingsService(paths.settings, fileSystem);
  const projects = new ProjectStore(paths.projects, fileSystem);
  const preferences = new ProjectPreferenceStore(paths.preferences, fileSystem);
  const teamRecord = new TeamRecordStore(path.join(paths.root, 'team-record.json'), fileSystem);
  const conversations = new ConversationStore(paths.conversations, fileSystem);
  const credentials = new CredentialVault(paths.credentials, fileSystem);
  await repairProviderSettings(settings, credentials);
  const playwrightMcp = await preparePlaywrightMcpSettings(await settings.load());
  for (const result of playwrightMcp.cliResults) {
    if (result.error) {
      logger.warn(
        'internal',
        `Playwright MCP could not be added to ${result.agent}`,
        `${result.configPath}: ${result.error}`,
      );
    } else if (result.changed) {
      logger.info('internal', `Playwright MCP added to ${result.agent}`, result.configPath);
    }
  }
  if (playwrightMcp.changed) await settings.save(playwrightMcp.settings);
  // open-pencil is only registered once its token is in the vault, so KAI never offers a server that cannot connect.
  if (await credentials.has?.(OPENPENCIL_CREDENTIAL_ID)) {
    const design = withOpenPencilMcpSetting(await settings.load());
    if (design.changed) await settings.save(design.settings);
  }
  // The board server is useful only with a project to point at, so it is registered for the active project. An
  // agent launched for another project keeps the entry it was given; opening that project rewrites it.
  {
    const current = await settings.load();
    const active = (await projects.list()).find((project) => project.id === current.activeProjectId);
    if (active) {
      const results = await installKaiProjectMcpForAgents({
        serverPath: path.join(__dirname, 'kai-project.cjs'),
        projectRoot: active.path,
        command: app.isPackaged ? process.execPath : 'node',
        env: app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      });
      for (const result of results) {
        if (result.error) logger.warn('internal', `KAI board MCP could not be added to ${result.agent}`, `${result.configPath}: ${result.error}`);
        else if (result.changed) logger.info('internal', `KAI board MCP added to ${result.agent}`, result.configPath);
      }
    }
  }
  const kaiRoot = app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), '..', '..');
  const proxyLauncherPath = app.isPackaged
    ? path.join(process.resourcesPath, 'integrations', 'start-proxy.cjs')
    : path.join(kaiRoot, 'packages', 'integrations', 'launchers', 'start-proxy.cjs');
  const engineResourcesPath = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  serviceController = new DesktopServiceController({
    paths,
    settings,
    credentials,
    logger,
    kaiRoot,
    resourcesPath: engineResourcesPath,
    proxyLauncherPath,
    onProxyStarted: async (port) => {
      const moved = await proxyRouting.followPort(port);
      for (const file of moved) logger.info('internal', `Agent proxy route moved to port ${port}`, file);
    },
  });
  const cognitive1 = new Cognitive1Client({ access: serviceController });
  const proxy = new UniversalProxyClient({ access: serviceController });
  const proxyRouting: DesktopProxyRouting = new DesktopProxyRouting({
    locateEngine: () => serviceController!.engineInstallation('universalProxy'),
    loopbackAccess: () => serviceController!.loopbackAccess('universalProxy'),
    loadSettings: () => settings.load(),
    saveSettings: (next) => settings.save(next),
  });
  const agents = new DesktopAgentRuntime(undefined, undefined, {
    resolveProxyEnvironment: async (agent, _request, model) => {
      const controller = serviceController;
      if (!controller) throw new Error('The managed service controller is unavailable.');
      const service = (await controller.status()).find((candidate) => candidate.kind === 'universalProxy');
      if (service?.status !== 'ready') throw new Error('Start Universal Proxy before using its CLI route.');
      const access = await controller.loopbackAccess('universalProxy');
      return cliProxyEnvironment(agent, access, model);
    },
  });
  const runControl = new DesktopRunControl({
    suspendRun: async (conversationId) => {
      await agents.pause(conversationId);
    },
    resumeRun: async (conversationId) => {
      await agents.resume(conversationId);
    },
  });
  const bundledRulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-rules', 'Cognitive1-Rules.md')
    : path.join(kaiRoot, 'apps', 'desktop', 'resources', 'agent-rules', 'Cognitive1-Rules.md');
  const executionRules = new DesktopExecutionRules(
    bundledRulesPath,
    path.join(paths.root, 'agent-rules', 'Cognitive1-Rules.md'),
  );
  configureCopyCheckpoints(path.join(paths.root, 'checkpoints'));
  const workflowTemplates = new WorkflowTemplateStore(path.join(paths.root, 'workflows'));
  const backups = new DesktopConfigBackupStore(paths);
  const learningProgress = new LearningProgressStore(paths.learning, fileSystem);
  const learningUsage = new LearningUsageStore(paths.learning, fileSystem);
  const learningBudget = new LearningBudgetGuard();
  const teachingLibrary = new TeachingLibraryStore(path.join(paths.learning, 'teaching'), fileSystem);
  const learningTutor = new DesktopLearningTutor(
    settings,
    credentials,
    async (projectId) => {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('Project not found.');
      return project.path;
    },
    teachingLibrary,
  );
  const preview = new PreviewRuntime(pathToFileURL(path.join(__dirname, '../preload/preview.cjs')).toString());
  // The studio writes `.kai/spec` inside the project; the interview's own working state stays app-owned.
  const specStore = new SpecStore();
  const interviewStore = new InterviewStore(path.join(paths.studio, 'interviews.json'), fileSystem);
  // Studio discussions get their own app-owned workspace until the user chooses to connect them to a code folder.
  const studioDiscussionRoot = async (projectId: string): Promise<string> => {
    if (!/^studio_[0-9a-f-]{36}$/i.test(projectId)) throw new Error('Project not found.');
    const root = path.join(paths.studio, 'projects', projectId);
    await mkdir(root, { recursive: true });
    return root;
  };
  const studioProjectRoot = async (projectId: string, linkedProjectId?: string | null): Promise<string> => {
    // A code project's own id (which is what the phone console sends) reads the same .kai/spec folder that a Studio
    // plan linked to that project uses, so its board and artifacts can be reached without knowing the plan.
    if (!/^studio_/i.test(projectId)) {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('Project not found.');
      return project.path;
    }
    const linked = linkedProjectId === undefined
      ? (await interviewStore.read(projectId))?.linkedProjectId ?? null
      : linkedProjectId;
    if (!linked) return studioDiscussionRoot(projectId);
    const linkedProject = (await projects.list()).find((candidate) => candidate.id === linked);
    if (!linkedProject) throw new Error('The folder linked to this Studio plan is no longer available.');
    return linkedProject.path;
  };
  mcpRuntime = new DesktopMcpRuntime(settings, credentials, logger);
  const directApi = new DesktopDirectProviderRuntime(settings, credentials, mcpRuntime, {
    waitIfPaused: (conversationId, signal) => runControl.waitIfPaused(conversationId, signal),
    resolveProxyRoute: async (request) => {
      const controller = serviceController;
      if (!controller) throw new Error('The managed service controller is unavailable.');
      const access = await controller.loopbackAccess('universalProxy');
      return {
        baseUrl: `${access.endpoint}/a/${request.agent}/v1`,
        apiKey: access.token,
      };
    },
  });

  const notifications = new NotificationCenter({
    getSettings: async () => (await settings.load()).notifications,
    isWindowFocused: (windowId) => {
      const session = windowId === undefined ? desktopWindows.focused() : desktopWindows.get(windowId);
      return session?.window.isFocused() ?? false;
    },
    show: (notification) => desktopShell?.show(notification),
  });
  const shell = new DesktopShell({
    center: notifications,
    getWindow: () => desktopWindows.focused()?.window ?? null,
    stopRun: (conversationId) => {
      if (ipcContext) cancelConversationRun(ipcContext, conversationId);
    },
  });
  shell.apply((await settings.load()).notifications);
  const editorSessions = new EditorSessionManager();
  // Filled in after registerIpc returns the handler registry the gateway dispatches through.
  let remote!: RemoteGateway;
  let workflowRunner!: DesktopWorkflowRunner;
  let teamPlanner!: DesktopTeamPlanner;
  let promptGuide!: DesktopPromptGuide;
  let interview!: DesktopInterview;
  let studio!: DesktopStudio;
  let scheduler!: DesktopScheduler;
  let evals!: DesktopEvals;
  let changeReviewer!: DesktopChangeReviewer;

  ipcContext = {
    appName: 'KAI',
    version: app.getVersion(),
    buildIdentifier,
    paths,
    fileSystem,
    logger,
    settings,
    projects,
    preferences,
    teamRecord,
    runScores: new RunScoreStore(path.join(paths.root, 'run-scores.json')),
    experiences: new AgentExperienceStore(path.join(paths.root, 'agent-experiences.json')),
    scheduler,
    evals,
    changeReviewer,
    conversations,
    credentials,
    services: serviceController,
    cognitive1,
    proxy,
    proxyRouting,
    proxyLiveTails: new Map(),
    agents,
    executionRules,
    directApi,
    mcp: mcpRuntime,
    workflowTemplates,
    backups,
    learningProgress,
    learningTutor,
    preview,
    teachingLibrary,
    compareRuns: new Map(),
    memorySessions: new Map(),
    pendingApprovals: new Map(),
    windows: desktopWindows,
    editorSessions,
    learningUsage,
    learningBudget,
    workflows: workflowRunner,
    teamPlanner,
    promptGuide,
    interview,
    studio,
    runControl,
    notifications,
    recovery: new RecoveryStore(path.join(paths.root, 'recovery')),
    verification: new VerificationStore(path.join(paths.root, 'verification')),
    updater: new UpdateController(autoUpdater, {
      currentVersion: app.getVersion(),
      // Only an installed build has a release feed; development runs and the smoke tests stay offline.
      enabled: app.isPackaged && process.env.KAI_DESKTOP_UPDATES !== 'off',
      backup: async (name) => (await backups.create(name)).name,
      onChange: (state) => {
        desktopWindows.broadcast('app:update-state', state);
      },
    }),
    terminal: new TerminalManager((event, ownerWindowId) => {
      if (ownerWindowId !== null && desktopWindows.send(ownerWindowId, 'terminal:event', event)) return;
      const fallback = desktopWindows.focused();
      if (fallback) fallback.window.webContents.send('terminal:event', event);
    }),
    desktopShell: shell,
    getMainWindow: () => desktopWindows.focused()?.window ?? null,
    createWindow: (projectId) => createMainWindow(projectId),
    remote,
  };
  async function createBlankConversation(projectId: string, firstPrompt: string) {
    const now = new Date().toISOString();
    const conversation = {
      schemaVersion: 1 as const,
      id: `conv_${crypto.randomUUID()}`,
      projectId,
      title: firstPrompt.trim().slice(0, 64) || 'Workflow',
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
    await conversations.save(conversation);
    return conversation;
  }
  workflowRunner = new DesktopWorkflowRunner({
    recordTeamRun: (run) => teamRecord.record(run).catch((error: unknown) => { logger.error('internal', 'Could not save team track record', undefined, error); }),
    listConversations: () => conversations.list(),
    getConversation: (id) => conversations.get(id),
    saveConversation: (conversation) => conversations.save(conversation),
    createConversation: createBlankConversation,
    runAgent: (request, ownerWindowId, options) => runConversationAgent(ipcContext!, request, ownerWindowId, options),
    worktrees: {
      prepare: async (projectId, key) => {
        const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
        return project ? createParallelSession(project.path, key) : null;
      },
    },
    runCheck: async (projectId, command, signal) => {
      const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('The workflow project is no longer available.');
      const check = await runCheckCommand(project.path, command, signal);
      await recordVerification(ipcContext!.verification, project.id, project.path, check).catch(() => undefined);
      return { passed: check.exitCode === 0, exitCode: check.exitCode, output: check.output };
    },
    cancelAgent: (conversationId) => cancelConversationRun(ipcContext!, conversationId),
    notifyChanged: (ownerWindowId, run) => {
      desktopWindows.send(ownerWindowId, 'workflows:changed', run);
    },
  });
  ipcContext.workflows = workflowRunner;
  teamPlanner = new DesktopTeamPlanner({
    teamRecords: () => teamRecord.list(),
    settings: () => settings.load(),
    projectTeam: async (projectId) => (await preferences.get(projectId))?.agentTeam ?? null,
    agentCapabilities: () => agents.capabilities(),
    directApi: async () => {
      const capability = await directApi.capability();
      return {
        available: capability.available,
        displayName: capability.displayName,
        local: isLocalProvider(capability.provider),
        ...(capability.unavailableReason ? { unavailableReason: capability.unavailableReason } : {}),
      };
    },
    proxyReady: async () => (await serviceController!.status()).some((service) => service.kind === 'universalProxy' && service.status === 'ready'),
    createConversation: createBlankConversation,
    runAgent: (request, ownerWindowId) => runConversationAgent(ipcContext!, request, ownerWindowId),
    startWorkflow: (input, ownerWindowId) => workflowRunner.start(input, ownerWindowId),
    // The studio is built later in this function, so the board is reached lazily through the context.
    board: (projectId) => ipcContext!.studio.board(projectId),
    artifactsFor: (projectId) => ipcContext!.studio.artifactTexts(projectId),
    claimCard: (projectId, cardId, agent) => ipcContext!.studio.claim(projectId, cardId, agent),
    recordCardRun: (projectId, cardId, run) => ipcContext!.studio.recordRun(projectId, cardId, run),
    moveCard: (projectId, cardId, status, note) => ipcContext!.studio.move(projectId, cardId, status, note ?? ''),
    changedFilesFor: async (projectId) => {
      const root = await studioProjectRoot(projectId);
      const overview = await gitOverview(root);
      return overview.changes.map((change) => change.path);
    },
  });
  ipcContext.teamPlanner = teamPlanner;
  promptGuide = new DesktopPromptGuide({
    settings: () => settings.load(),
    team: async (projectId) => completeTeam((await preferences.get(projectId))?.agentTeam ?? (await settings.load()).agentTeam),
    projectRoot: async (projectId) => {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('Project not found.');
      return project.path;
    },
    credentialStored: async (id) => Boolean(await credentials.has?.(id)),
    vaultAvailable: () => credentials.isAvailable(),
    requester: learningTutor,
  });
  ipcContext.promptGuide = promptGuide;
  changeReviewer = new DesktopChangeReviewer({ pickConnection: () => promptGuide.pickConnection(), requester: learningTutor });
  ipcContext.changeReviewer = changeReviewer;
  const projectById = async (projectId: string) => {
    const found = (await projects.list()).find((candidate) => candidate.id === projectId);
    if (!found) throw new Error('That project is no longer in KAI.');
    return found;
  };
  evals = new DesktopEvals(new EvalStore(path.join(paths.root, 'evals')), {
    project: projectById,
    createConversation: async (projectId, title) => {
      const conversation = await createBlankConversation(projectId, title);
      // Eval runs stay out of the conversation list; their results live in the Evals card.
      await conversations.save({ ...conversation, archived: true });
      return conversation.id;
    },
    runAgent: (request, cwd) => runConversationAgent(ipcContext!, request, null, { cwd }),
    runCheck: async (cwd, command) => {
      const check = await runCheckCommand(cwd, command);
      return { exitCode: check.exitCode, output: check.output };
    },
  });
  ipcContext.evals = evals;
  scheduler = new DesktopScheduler(new ScheduleStore(path.join(paths.root, 'schedules.json')), {
    run: (schedule) => runScheduledGoal(ipcContext!, schedule),
  });
  ipcContext.scheduler = scheduler;
  scheduler.start();
  interview = new DesktopInterview({
    settings: () => settings.load(),
    projectRoot: studioProjectRoot,
    credentialStored: async (id) => Boolean(await credentials.has?.(id)),
    vaultAvailable: () => credentials.isAvailable(),
    requester: learningTutor,
    store: interviewStore,
    spec: specStore,
    now: () => new Date().toISOString(),
  });
  ipcContext.interview = interview;
  const studioArtifacts = new StudioArtifacts({ spec: specStore, projectRoot: studioProjectRoot, now: () => new Date().toISOString() });
  const studioBoard = new StudioBoardStore({
    spec: specStore,
    projectRoot: studioProjectRoot,
    // The board asks Git what changed since the check ran; a project that is not a repo simply has no drift.
    dirtyFiles: async (projectPath) => {
      try {
        const overview = await gitOverview(projectPath);
        return await Promise.all(overview.changes.map(async (change) => ({ path: change.path, hash: (await hashFile(projectPath, change.path)) ?? '' })));
      } catch {
        return null;
      }
    },
    hashFile: (projectPath, relativePath) => hashFile(projectPath, relativePath),
    run: async (projectId, runId) => (await ipcContext!.verification.list(projectId)).find((run) => run.id === runId) ?? null,
    now: () => new Date().toISOString(),
  });
  // The visual check drives the Playwright MCP KAI already installs for its agents; screenshots land with the card.
  const uiCheck = new DesktopUiCheck(playwrightUiCheckPorts({
    mcp: {
      callServerTool: (serverId, toolName, input) => {
        if (!mcpRuntime) return Promise.reject(new Error('The MCP runtime is not running.'));
        return mcpRuntime.callServerTool(serverId, toolName, input);
      },
    },
    preview: {
      start: (projectId, projectPath, command) => preview.start(projectId, projectPath, command),
      status: (projectId, projectPath) => preview.status(projectId, projectPath),
    },
    readFile: async (projectPath, relativePath) => {
      const target = await resolveInside(projectPath, path.join(SPEC_ROOT, relativePath));
      try {
        return await readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeFile: async (projectPath, relativePath, base64) => {
      const target = await resolveInside(projectPath, path.join(SPEC_ROOT, relativePath));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(base64, 'base64'));
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  }, () => new Date().toISOString()));
  studio = new DesktopStudio({
    settings: () => settings.load(),
    projectRoot: studioProjectRoot,
    requester: learningTutor,
    interview: { readiness: () => interview.readiness() },
    artifacts: studioArtifacts,
    board: studioBoard,
    uiCheck,
    // open-pencil is reached through the same MCP runtime as every other server, so its token stays in the vault.
    openPencil: async () => {
      const current = await settings.load();
      const server = current.mcpServers.find((candidate) => candidate.id === OPENPENCIL_MCP_SERVER_ID && candidate.enabled);
      if (!server) return null;
      return {
        endpoint: () => (server.transport === 'http' ? server.url : OPENPENCIL_ENDPOINT),
        call: async (tool, input) => {
          if (!mcpRuntime) throw new Error('The MCP runtime is not running.');
          const blocks = await mcpRuntime.callServerTool(OPENPENCIL_MCP_SERVER_ID, tool, input);
          if (blocks === null) throw new Error('open-pencil is not connected. Check its token in Settings, then pull the design again.');
          return blocks;
        },
      };
    },
    now: () => new Date().toISOString(),
  });
  ipcContext.studio = studio;
  desktopShell = shell;

  await importLocalCognitive1Brain(ipcContext, kaiRoot);
  const registry = registerIpc(ipcContext);
  remote = new RemoteGateway({
    credentials,
    dispatcher: new RemoteDispatcher(registry, desktopWindows),
    describeWindows: () => describeRemoteWindows(projects, desktopWindows),
    subscribeWindowEvents: (subscriber) => desktopWindows.subscribe(subscriber),
    // The renderer build directory, not the mobile folder inside it: the phone's page sits in
    // `mobile/` but its scripts and styles are the build's shared `/assets`, one level up.
    mobileRoot: path.join(__dirname, '../renderer'),
    appName: 'KAI',
    version: app.getVersion(),
    logger,
    settings: async () => (await settings.load()).remote,
  });
  remoteGateway = remote;
  ipcContext.remote = remote;
  installContentSecurityPolicy();
  if (!startupJobFile) await createMainWindow();
  await remote.apply((await settings.load()).remote).catch((error: unknown) => {
    logger.warn('internal', 'KAI Remote could not start', messageOf(error));
  });
  headlessReady = true;
  if (startupJobFile) queuedJobFiles.unshift(startupJobFile);
  for (const queued of queuedJobFiles.splice(0)) void handleHeadlessJob(queued);
  // Look for a new version shortly after startup and every few hours, if the user allows it. Checking is
  // read-only; downloading and installing always wait for the user.
  const checkForUpdates = (): void => {
    void settings.load().then((current) => (current.updates.autoCheck ? ipcContext?.updater.check() : undefined)).catch(() => undefined);
  };
  setTimeout(checkForUpdates, 30_000).unref();
  setInterval(checkForUpdates, 6 * 60 * 60_000).unref();
  void serviceController
    .startConfigured()
    .then(() => syncCognitive1McpFromService(serviceController!, logger))
    .catch((error) => logger.error('service_error', 'Managed service startup failed', undefined, error));
}

export async function syncCognitive1McpFromService(
  services: DesktopServiceController,
  logger?: Pick<RedactedLogger, 'info' | 'warn'>,
): Promise<void> {
  const state = (await services.status()).find((service) => service.kind === 'cognitive1');
  if (state?.status !== 'ready') return;
  const results = await syncCognitive1Mcp(() => services.loopbackAccess('cognitive1'));
  for (const result of results) {
    if (result.error) {
      logger?.warn('internal', `Cognitive1 MCP could not be added to ${result.agent}`, `${result.configPath}: ${result.error}`);
    } else if (result.changed) {
      logger?.info('internal', `Cognitive1 MCP added to ${result.agent}`, result.configPath);
    }
  }
}

async function repairProviderSettings(
  settings: SettingsService,
  credentials: CredentialVault,
): Promise<void> {
  const current = await settings.load();
  const model = current.directApi.model.trim();
  const currentPreset = directProviderPreset(current.directApi.provider);
  const storedCredentials = new Set(await credentials.status());
  const repairedDeepSeekModel = migrateDeepSeekModel(model);
  const deprecatedDeepSeekModel = current.directApi.provider === 'deepseek'
    && repairedDeepSeekModel !== model;
  let directApi = current.directApi;
  let changed = false;

  // A local provider has no key by design, so an empty model there is not a broken setup to repair.
  if ((!model || deprecatedDeepSeekModel) && !isLocalProvider(current.directApi.provider)) {
    if (storedCredentials.has(current.directApi.credentialId)) {
      directApi = {
        ...current.directApi,
        model: deprecatedDeepSeekModel ? repairedDeepSeekModel : currentPreset.defaultModel,
        baseUrl: currentPreset.defaultBaseUrl,
      };
      changed = true;
    } else {
      const storedProvider = DIRECT_PROVIDER_ORDER.find((provider) => (
        storedCredentials.has(directProviderPreset(provider).credentialId)
      ));
      if (storedProvider) {
        const preset = directProviderPreset(storedProvider);
        directApi = {
          ...current.directApi,
          provider: preset.id,
          model: preset.defaultModel,
          baseUrl: preset.defaultBaseUrl,
          credentialId: preset.credentialId,
        };
        changed = true;
      }
    }
  }

  let proxy = current.proxy;
  const repairedProxyModel = migrateDeepSeekModel(current.proxy.defaultModel);
  if (current.proxy.credentialId === 'provider.deepseek' && repairedProxyModel !== current.proxy.defaultModel.trim()) {
    proxy = {
      ...current.proxy,
      defaultModel: repairedProxyModel,
    };
    changed = true;
  }

  let learningTutor = current.learningTutor;
  const repairedLearningModel = migrateDeepSeekModel(learningTutor.model);
  if (learningTutor.provider === 'deepseek' && repairedLearningModel !== learningTutor.model.trim()) {
    learningTutor = {
      ...learningTutor,
      model: repairedLearningModel,
      baseUrl: directProviderPreset('deepseek').defaultBaseUrl,
    };
    changed = true;
  }

  if (changed) await settings.save({ ...current, directApi, learningTutor, proxy });
}

async function importLocalCognitive1Brain(context: IpcContext, kaiRoot: string): Promise<void> {
  const projects = await context.projects.list();
  const candidates = [...new Set([
    path.resolve(kaiRoot, '..', 'cognitive1'),
    path.join(app.getPath('documents'), 'WebDev Projects', 'cognitive1'),
    ...projects.map((project) => project.path),
  ])];

  for (const candidate of candidates) {
    try {
      const info = await stat(path.join(candidate, 'brain'));
      if (!info.isDirectory()) continue;
      const result = await importBrainFromDirectory(context, candidate, false);
      if (result.imported > 0) {
        context.logger.info(
          'internal',
          `Imported ${result.imported} missing C1 brain files from ${result.sourcePath}`,
        );
      }
      return;
    } catch {
      // Try the next known source; a missing source is expected on most machines.
    }
  }
}

/** What the phone is offered as a target: one entry per open window, with its project named. */
async function describeRemoteWindows(
  projects: ProjectStore,
  windows: DesktopWindowRegistry,
): Promise<RemoteWindowSummary[]> {
  const names = new Map((await projects.list()).map((project) => [project.id, project.name]));
  const focused = windows.focused();
  return windows.live().map((session) => ({
    id: session.id,
    projectId: session.projectId,
    projectName: session.projectId ? names.get(session.projectId) ?? null : null,
    conversationId: session.conversationId,
    view: session.view,
    focused: session.id === focused?.id,
  }));
}

async function createMainWindow(initialProjectId?: string | null): Promise<void> {
  if (!ipcContext) return;
  const settings = await ipcContext.settings.load();
  const isFirstWindow = desktopWindows.live().length === 0;
  const restored = isFirstWindow
    ? restoreBounds(settings.windowBounds)
    : { width: 1280, height: 820, x: 80 + desktopWindows.live().length * 24, y: 80 + desktopWindows.live().length * 24 };
  const projectId = initialProjectId === undefined ? settings.activeProjectId : initialProjectId;

  const window = new BrowserWindow({
    ...restored,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#08111f',
    title: 'KAI',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#08111f',
      symbolColor: '#d8e2f0',
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      devTools: !app.isPackaged || process.env.KAI_DESKTOP_DEVTOOLS === 'true',
    },
  });
  const session = desktopWindows.register(window, projectId);

  if (isFirstWindow && settings.windowBounds?.maximized) window.maximize();
  window.once('ready-to-show', () => {
    window.show();
    if (parallelCleanupStarted || !ipcContext) return;
    parallelCleanupStarted = true;
    const context = ipcContext;
    void context.projects.list().then((projects) => cleanupParallelWorktrees(projects.map((project) => project.path), {
      activeDirectories: activeParallelDirectories,
      log: (message) => { context.logger.info('internal', message); },
    })).catch((error: unknown) => { context.logger.error('internal', 'Parallel copy cleanup failed', undefined, error); });
  });
  window.on('close', (event) => {
    if (forceClosing.has(session.id)) return;
    if (desktopShell?.shouldHideOnClose()) {
      event.preventDefault();
      window.hide();
      return;
    }
    event.preventDefault();
    void (async () => {
      if (ipcContext && !(await confirmEditorNavigation(ipcContext, session, 'close the window'))) return;
      await persistWindowState(window, isFirstWindow);
      if (ipcContext) {
        handleRendererWindowClosed(ipcContext, session.id);
        const replacement = desktopWindows.live().find((candidate) => candidate.id !== session.id)?.id ?? null;
        await ipcContext.workflows.ownerWindowClosed(session.id, replacement);
      }
      forceClosing.add(session.id);
      window.close();
    })();
  });
  window.on('closed', () => {
    ipcContext?.editorSessions.removeWindow(session.id);
    ipcContext?.notifications.removeWindow(session.id);
    desktopWindows.remove(session.id);
    forceClosing.delete(session.id);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isLocalPreviewUrl(params.src)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
  });
  window.webContents.on('did-attach-webview', (_event, guest) => {
    const allowLocalNavigation = (event: Electron.Event, url: string): void => {
      if (!isLocalPreviewUrl(url)) event.preventDefault();
    };
    guest.on('will-navigate', allowLocalNavigation);
    guest.on('will-redirect', allowLocalNavigation);
    guest.setWindowOpenHandler(({ url }) => {
      openExternalIfSafe(url);
      return { action: 'deny' };
    });
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isApplicationUrl(url)) event.preventDefault();
  });
  window.webContents.on('before-input-event', (event, input) => {
    const kind = reloadShortcut(input);
    if (!kind) return;
    event.preventDefault();
    void (async () => {
      if (ipcContext && !(await confirmEditorNavigation(ipcContext, session, 'reload the window'))) return;
      if (window.isDestroyed()) return;
      if (kind === 'force') window.webContents.reloadIgnoringCache();
      else window.webContents.reload();
    })();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    ipcContext?.logger.error('renderer_error', 'Renderer process exited', details.reason);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function installContentSecurityPolicy(): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const connectSources = devUrl ? `${devUrl} ws://localhost:* http://localhost:*` : "'self' http://127.0.0.1:*";
  const scriptSources = devUrl ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  const policy = [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function identifyBuild(version: string): Promise<string> {
  const supplied = process.env.KAI_BUILD_ID?.trim();
  if (supplied) return supplied;
  try {
    const hash = createHash('sha256').update(await readFile(__filename)).digest('hex').slice(0, 10);
    return `${version}+${hash}`;
  } catch {
    return `${version}+unidentified`;
  }
}

async function persistWindowState(window: BrowserWindow, isPrimary: boolean): Promise<void> {
  if (!ipcContext || !isPrimary) return;
  await ipcContext.settings.update((settings) => {
    const bounds = window.isMaximized() ? settings.windowBounds : window.getBounds();
    return {
      ...settings,
      windowBounds: bounds ? { ...bounds, maximized: window.isMaximized() } : null,
    };
  });
}

function restoreBounds(bounds: { x: number; y: number; width: number; height: number; maximized: boolean } | null): {
  x?: number;
  y?: number;
  width: number;
  height: number;
} {
  if (!bounds) return { width: 1440, height: 920 };
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = Math.min(Math.max(bounds.width, 960), workArea.width);
  const height = Math.min(Math.max(bounds.height, 640), workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function isApplicationUrl(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return true;
  return url.startsWith('file://') && url.includes('/out/renderer/');
}

function isLocalPreviewUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function openExternalIfSafe(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Invalid or unsupported URLs are ignored.
  }
}

async function reportStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  ipcContext?.logger.error('internal', 'Desktop startup failed', message, error);
  await dialog.showMessageBox({
    type: 'error',
    title: 'KAI could not start',
    message,
  });
  app.quit();
}
