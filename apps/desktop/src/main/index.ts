import * as path from 'node:path';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import { Cognitive1Client } from './cognitive1-client';
import { DesktopAgentRuntime } from './agent-runtime';
import { DesktopConfigBackupStore } from './backups';
import { CredentialVault } from './credential-vault';
import { DesktopDirectProviderRuntime } from './direct-provider-runtime';
import { DesktopExecutionRules } from './execution-rules';
import { DesktopMcpRuntime } from './mcp-runtime';
import { closeCompareRuns, closeMemorySessions, registerIpc, type IpcContext } from './ipc';
import { createDesktopPaths } from './paths';
import { UniversalProxyClient } from './proxy-client';
import { ProjectPreferenceStore } from './project-preference-store';
import { ProjectStore } from './project-store';
import { RotatingLogSink } from './rotating-log-sink';
import { DesktopServiceController } from './service-controller';
import { WorkflowTemplateStore } from './workflow-templates';

app.setName('KAI');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | null = null;
let ipcContext: IpcContext | null = null;
let serviceController: DesktopServiceController | null = null;
let mcpRuntime: DesktopMcpRuntime | null = null;
let shutdownPromise: Promise<void> | null = null;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(startApplication).catch(reportStartupFailure);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if ((!serviceController && !mcpRuntime) || shutdownPromise) return;
  event.preventDefault();
  const activeContext = ipcContext;
  shutdownPromise = (activeContext ? closeMemorySessions(activeContext) : Promise.resolve())
    .then(() => (activeContext ? closeCompareRuns(activeContext) : Promise.resolve()))
    .then(() => Promise.all([
      serviceController?.dispose() ?? Promise.resolve(),
      mcpRuntime?.dispose() ?? Promise.resolve(),
    ]))
    .then(() => undefined)
    .catch((error) => ipcContext?.logger.error('service_error', 'Service shutdown failed', undefined, error))
    .finally(() => {
      serviceController = null;
      mcpRuntime = null;
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
  const settings = new SettingsService(paths.settings, fileSystem);
  const projects = new ProjectStore(paths.projects, fileSystem);
  const preferences = new ProjectPreferenceStore(paths.preferences, fileSystem);
  const conversations = new ConversationStore(paths.conversations, fileSystem);
  const credentials = new CredentialVault(paths.credentials, fileSystem);
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
  });
  const cognitive1 = new Cognitive1Client({ access: serviceController });
  const proxy = new UniversalProxyClient({ access: serviceController });
  const agents = new DesktopAgentRuntime();
  const bundledRulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-rules', 'Cognitive1-Rules.md')
    : path.join(kaiRoot, 'apps', 'desktop', 'resources', 'agent-rules', 'Cognitive1-Rules.md');
  const executionRules = new DesktopExecutionRules(
    bundledRulesPath,
    path.join(paths.root, 'agent-rules', 'Cognitive1-Rules.md'),
  );
  const workflowTemplates = new WorkflowTemplateStore(path.join(paths.root, 'workflows'));
  const backups = new DesktopConfigBackupStore(paths);
  mcpRuntime = new DesktopMcpRuntime(settings, credentials, logger);
  const directApi = new DesktopDirectProviderRuntime(settings, credentials, mcpRuntime, {
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

  ipcContext = {
    appName: 'KAI',
    version: app.getVersion(),
    paths,
    fileSystem,
    logger,
    settings,
    projects,
    preferences,
    conversations,
    credentials,
    services: serviceController,
    cognitive1,
    proxy,
    agents,
    executionRules,
    directApi,
    mcp: mcpRuntime,
    workflowTemplates,
    backups,
    compareRuns: new Map(),
    memorySessions: new Map(),
    pendingApprovals: new Map(),
    getMainWindow: () => mainWindow,
  };

  registerIpc(ipcContext);
  installContentSecurityPolicy();
  await createMainWindow();
  void serviceController
    .startConfigured()
    .catch((error) => logger.error('service_error', 'Managed service startup failed', undefined, error));
}

async function createMainWindow(): Promise<void> {
  if (!ipcContext) return;
  const settings = await ipcContext.settings.load();
  const restored = restoreBounds(settings.windowBounds);

  mainWindow = new BrowserWindow({
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
      devTools: !app.isPackaged || process.env.KAI_DESKTOP_DEVTOOLS === 'true',
    },
  });

  if (settings.windowBounds?.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => {
    void persistWindowState();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isApplicationUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    ipcContext?.logger.error('renderer_error', 'Renderer process exited', details.reason);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
}

async function persistWindowState(): Promise<void> {
  if (!ipcContext || !mainWindow) return;
  const settings = await ipcContext.settings.load();
  const bounds = mainWindow.isMaximized() ? settings.windowBounds : mainWindow.getBounds();
  await ipcContext.settings.save({
    ...settings,
    windowBounds: bounds ? { ...bounds, maximized: mainWindow.isMaximized() } : null,
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
