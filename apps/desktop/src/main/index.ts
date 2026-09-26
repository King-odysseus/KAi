import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import { DIRECT_PROVIDER_ORDER, directProviderPreset, isLocalProvider, migrateDeepSeekModel } from '@kai/contracts';
import { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import { Cognitive1Client } from './cognitive1-client';
import { cliProxyEnvironment, DesktopAgentRuntime } from './agent-runtime';
import { preparePlaywrightMcpSettings, syncCognitive1Mcp } from './agent-mcp-config';
import { DesktopConfigBackupStore } from './backups';
import { CredentialVault } from './credential-vault';
import { DesktopDirectProviderRuntime } from './direct-provider-runtime';
import { DesktopExecutionRules } from './execution-rules';
import { DesktopMcpRuntime } from './mcp-runtime';
import { cancelConversationRun, closeCompareRuns, closeMemorySessions, confirmEditorNavigation, handleRendererWindowClosed, importBrainFromDirectory, registerIpc, runConversationAgent, type IpcContext } from './ipc';
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
import { recordVerification, runCheckCommand, VerificationStore } from './verification';
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
import { TeamRecordStore } from './team-record-store';
import { activeParallelDirectories, createParallelSession } from './parallel-session';
import { cleanupParallelWorktrees } from './git-worktrees';
import { DesktopRunControl } from './run-control';
import { DesktopWindowRegistry } from './desktop-windows';
import { PreviewRuntime } from './preview-runtime';

app.setName('KAI');
if (process.env.KAI_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.KAI_DESKTOP_USER_DATA));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let ipcContext: IpcContext | null = null;
let serviceController: DesktopServiceController | null = null;
let mcpRuntime: DesktopMcpRuntime | null = null;
let shutdownPromise: Promise<void> | null = null;
let desktopShell: DesktopShell | null = null;
let quitting = false;
const desktopWindows = new DesktopWindowRegistry();
const forceClosing = new Set<number>();
let parallelCleanupStarted = false;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = desktopWindows.focused()?.window;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

app.whenReady().then(startApplication).catch(reportStartupFailure);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
  })()
    .then(() => closeMemorySessions(activeContext))
    .then(() => (activeContext ? closeCompareRuns(activeContext) : Promise.resolve()))
    .then(() => activeContext?.workflows.dispose())
    .then(() => activeContext?.terminal.stopAll())
    .then(() => activeContext?.preview.stopAll())
    .then(() => Promise.all([
      serviceController?.dispose() ?? Promise.resolve(),
      mcpRuntime?.dispose() ?? Promise.resolve(),
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
      desktopShell?.dispose();
      app.exit(0);
    });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
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
  let workflowRunner!: DesktopWorkflowRunner;
  let teamPlanner!: DesktopTeamPlanner;

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
    createWindow: () => createMainWindow(null),
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
  });
  ipcContext.teamPlanner = teamPlanner;
  desktopShell = shell;

  await importLocalCognitive1Brain(ipcContext, kaiRoot);
  registerIpc(ipcContext);
  installContentSecurityPolicy();
  await createMainWindow();
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
