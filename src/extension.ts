import * as path from 'path';
import * as vscode from 'vscode';
import { AcpAgentAdapter } from './adapters/acp-adapter';
import { parseClaudeJsonLine } from './adapters/claude-parser';
import { parseCodexJsonLine } from './adapters/codex-parser';
import { parseQwenJsonLine } from './adapters/qwen-parser';
import { parseGeminiJsonLine } from './adapters/gemini-parser';
import { buildClaudeArgs, buildCodexArgs, ProcessAgentAdapter } from './adapters/process-agent-adapter';
import type { Cognitive1Client } from './cognitive1/cognitive1-client';
import { Cognitive1HttpClient, DisabledCognitive1Client } from './cognitive1/cognitive1-client';
import { EmbeddedCognitive1 } from './cognitive1/embedded-cognitive1';
import { BackupManager } from './config/backup-manager';
import { CodexConfigWriter, defaultCodexConfigPath } from './config/codex-config';
import { ProjectPreferences } from './config/project-preferences';
import { createEventId, nowIso } from './core/events';
import type { WorkbenchEvent } from './core/events';
import { getLogger, initLogger } from './core/logger';
import type { AgentId, AutonomyMode, RouteMode, WorkbenchState } from './core/types';
import { WorkbenchOrchestrator } from './orchestrator/orchestrator';
import { VSCodeDiffApplier } from './orchestrator/vscode-diff-applier';
import { EngineRoomViewProvider } from './panel/engine-room-view-provider';
import { SettingsViewProvider } from './panel/settings-view-provider';
import { SecretStore } from './config/secret-store';
import { MemoryTreeProvider } from './panel/memory-tree-provider';
import { SessionsTreeProvider } from './panel/sessions-tree-provider';
import { WorkbenchViewProvider } from './panel/workbench-view-provider';
import { RawEventInspector, registerRawInspectorCommand } from './panel/raw-event-inspector';
import { ProxyManager } from './proxy/proxy-manager';

interface SessionRecoveryState {
  prompt: string;
  agent: AgentId;
  route: RouteMode;
  autonomy: AutonomyMode;
  taskId: string;
  savedAt: string;
}

let proxyManager: ProxyManager | undefined;
const AGENT_IDS: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];
const RECOVERY_KEY = 'kai.lastSession';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize structured logger
  const logger = initLogger('KAI Agent Workbench', { showUserThreshold: 'warn' });
  context.subscriptions.push({ dispose: () => logger.dispose() });

  logger.info('internal', 'KAI Agent Workbench activating...');

  const config = vscode.workspace.getConfiguration('kai');
  const prefs = new ProjectPreferences(context.workspaceState);

  // Load stored API keys into the process env so spawned agent CLIs and the
  // proxy inherit them. Must run before the proxy is started below.
  const secretStore = new SecretStore(context.secrets);
  await secretStore.loadIntoEnv();

  const globalAgent = config.get<AgentId>('defaultAgent', 'claude');
  const globalRoute = config.get<RouteMode>('defaultRoute', 'direct');
  const globalAutonomy = config.get<AutonomyMode>('defaultAutonomy', 'review');
  const project = prefs.getState(globalAgent, globalRoute, globalAutonomy);

  const initialState: WorkbenchState = {
    activeAgent: project.agent,
    route: project.route,
    autonomy: project.autonomy,
    isRunning: false,
  };

  const cognitive1 = createCognitive1Client(config);
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const codexConfigWriter = new CodexConfigWriter();
  const backupManager = new BackupManager();
  const configDir = path.dirname(defaultCodexConfigPath());
  const proxyPort = config.get<number>('proxyPort', 8082);
  const proxyScript = config.get<string>('proxyScript', '');

  if (proxyScript) {
    try {
      proxyManager = new ProxyManager(proxyPort);
      void proxyManager.start(proxyScript);
      context.subscriptions.push({ dispose: () => { void proxyManager?.stop(); } });
      logger.info('proxy_error', `Proxy manager started on port ${proxyPort}.`);
    } catch (err) {
      logger.error('proxy_error', 'Failed to start proxy manager.', undefined, err);
    }
  }

  const orchestrator = new WorkbenchOrchestrator(
    initialState,
    cognitive1,
    projectPath,
    new VSCodeDiffApplier(),
  );

  // Register Claude adapter — with dedicated parser
  orchestrator.registerAdapter(
    new ProcessAgentAdapter({
      id: 'claude',
      displayName: 'Claude',
      command: config.get<string>('claudeCommand', 'claude'),
      buildArgs: buildClaudeArgs,
      parseLine: parseClaudeJsonLine,
      supportsApprovals: true,
      supportsMcp: true,
    }),
  );

  // Register Codex adapter — with proxy profile management
  orchestrator.registerAdapter(
    new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: config.get<string>('codexCommand', 'codex'),
      buildArgs: (r) => buildCodexArgs(config.get<string>('codexProxyProfile', 'codeproxy'), r),
      parseLine: parseCodexJsonLine,
      supportsApprovals: true,
      beforeRun: async (req) => {
        if (req.route !== 'proxy') return [];
        try {
          const profile = config.get<string>('codexProxyProfile', 'codeproxy');
          const r = await codexConfigWriter.ensureProxyProfile({
            profile,
            port: proxyPort,
            model: config.get<string>('codexConfigModel', 'gpt-5.5'),
          });
          return [
            {
              id: createEventId(),
              type: 'agent.lifecycle',
              taskId: req.taskId,
              timestamp: nowIso(),
              agent: 'codex',
              status: 'running',
              detail: r.changed
                ? `Prepared Codex proxy profile "${profile}".`
                : `Codex proxy profile "${profile}" up to date.`,
            },
          ];
        } catch (err) {
          logger.error('config_failure', 'Failed to configure Codex proxy profile.', undefined, err);
          return [];
        }
      },
    }),
  );

  // Register Qwen adapter — with dedicated parser
  orchestrator.registerAdapter(
    new AcpAgentAdapter(
      {
        id: 'qwen',
        displayName: 'Qwen Code',
        command: config.get<string>('qwenCommand', 'qwen'),
        parseLine: parseQwenJsonLine,
      },
    ),
  );

  // Register Gemini adapter — with dedicated parser
  orchestrator.registerAdapter(
    new AcpAgentAdapter(
      {
        id: 'gemini',
        displayName: 'Gemini CLI',
        command: config.get<string>('geminiCommand', 'gemini'),
        parseLine: parseGeminiJsonLine,
      },
    ),
  );

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'kai.openWorkbench';
  context.subscriptions.push(statusBar);

  const updateStatus = (s: WorkbenchState) => {
    const run = s.isRunning ? 'running' : 'idle';
    const px = proxyManager?.getStatus().running ? 'proxy:on' : 'proxy:off';
    statusBar.text = `KAI: ${s.activeAgent} | ${s.route} | ${s.autonomy} | ${px} | ${run}`;
    statusBar.tooltip = 'Open KAI Agent Workbench';
    statusBar.show();
  };
  updateStatus(orchestrator.getState());

  // Register webview providers
  const workbenchProvider = new WorkbenchViewProvider(context.extensionUri, orchestrator);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WorkbenchViewProvider.viewType, workbenchProvider),
  );

  const engineRoomProvider = new EngineRoomViewProvider(
    context.extensionUri,
    orchestrator,
    backupManager,
    configDir,
    proxyManager,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EngineRoomViewProvider.viewType, engineRoomProvider),
  );

  const settingsProvider = new SettingsViewProvider(
    context.extensionUri,
    orchestrator,
    secretStore,
    proxyManager,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settingsProvider),
  );

  const memoryProvider = new MemoryTreeProvider(cognitive1);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kai.memory', memoryProvider),
  );

  const sessionsProvider = new SessionsTreeProvider(cognitive1);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kai.sessions', sessionsProvider),
  );

  const rawInspector = new RawEventInspector();

  // Orchestrator state listener
  orchestrator.on('state', (s: WorkbenchState) => {
    updateStatus(s);
    void workbenchProvider.postState();
    engineRoomProvider.refresh();
    settingsProvider.refresh();
    void prefs.setAgent(s.activeAgent);
    void prefs.setRoute(s.route);
    void prefs.setAutonomy(s.autonomy);
    if (s.activeTaskId && s.isRunning) {
      void context.workspaceState.update(RECOVERY_KEY, {
        prompt: orchestrator.getLastPrompt(),
        agent: s.activeAgent,
        route: s.route,
        autonomy: s.autonomy,
        taskId: s.activeTaskId,
        savedAt: new Date().toISOString(),
      } satisfies SessionRecoveryState);
    } else if (!s.isRunning) {
      void context.workspaceState.update(RECOVERY_KEY, undefined);
    }
  });

  // Orchestrator event listener
  orchestrator.on('event', (e: WorkbenchEvent) => {
    workbenchProvider.postEvent(e);
    memoryProvider.refresh();
    sessionsProvider.refresh();
    rawInspector.push(e);

    // Log errors through the centralized logger
    if (e.type === 'error') {
      getLogger().error('agent_crash', e.message, e.recoverable ? 'Recoverable' : 'Fatal');
    }
  });

  // Session recovery
  void checkSessionRecovery(context, orchestrator);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kai.openWorkbench', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.kai');
    }),

    vscode.commands.registerCommand('kai.openSettings', async () => {
      await vscode.commands.executeCommand('kai.settings.focus');
    }),

    vscode.commands.registerCommand('kai.openChatTab', () => {
      const panel = vscode.window.createWebviewPanel(
        'kai.chatTab',
        'KAI Chat',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
      );
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'kai.svg');
      workbenchProvider.attachWebview(panel.webview);
      panel.onDidDispose(() => workbenchProvider.detachWebview(panel.webview));
    }),

    vscode.commands.registerCommand('kai.setAgent', async () => {
      const s = await vscode.window.showQuickPick(AGENT_IDS, { title: 'Choose KAI agent' });
      if (s) {
        orchestrator.setAgent(s as AgentId);
        void prefs.setAgent(s as AgentId);
      }
    }),

    vscode.commands.registerCommand('kai.setRoute', async () => {
      const s = await vscode.window.showQuickPick(['direct', 'proxy'], {
        title: 'Choose KAI route',
      });
      if (s) {
        orchestrator.setRoute(s as RouteMode);
        void prefs.setRoute(s as RouteMode);
      }
    }),

    vscode.commands.registerCommand('kai.toggleRoute', () => {
      const s = orchestrator.getState();
      const n = s.route === 'direct' ? 'proxy' : 'direct';
      orchestrator.setRoute(n as RouteMode);
      void prefs.setRoute(n as RouteMode);
      void vscode.window.showInformationMessage(`KAI route: ${n}`);
    }),

    vscode.commands.registerCommand('kai.setAutonomy', async () => {
      const s = await vscode.window.showQuickPick(['review', 'auto', 'custom'], {
        title: 'Choose autonomy',
      });
      if (s) {
        orchestrator.setAutonomy(s as AutonomyMode);
        void prefs.setAutonomy(s as AutonomyMode);
      }
    }),

    vscode.commands.registerCommand('kai.cycleAutonomy', () => {
      const modes: AutonomyMode[] = ['review', 'auto', 'custom'];
      const s = orchestrator.getState();
      const n = modes[(modes.indexOf(s.autonomy) + 1) % modes.length];
      orchestrator.setAutonomy(n);
      void prefs.setAutonomy(n);
      void vscode.window.showInformationMessage(`KAI autonomy: ${n}`);
    }),

    vscode.commands.registerCommand('kai.handoff', async () => {
      const s = orchestrator.getState();
      const targets = AGENT_IDS.filter((id) => id !== s.activeAgent);
      const sel = await vscode.window.showQuickPick(targets, {
        title: `Handoff from ${s.activeAgent} to...`,
      });
      if (sel) {
        try {
          await orchestrator.handoff(sel as AgentId);
          void vscode.window.showInformationMessage(`Handed off to ${sel}.`);
        } catch (e) {
          getLogger().error('handoff_failed', 'Handoff failed', undefined, e);
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
      }
    }),

    vscode.commands.registerCommand('kai.listBackups', async () => {
      const backups = await backupManager.listBackups(configDir);
      if (!backups.length) {
        void vscode.window.showInformationMessage('No config backups found.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        backups.map((b) => ({
          label: b.originalName,
          description: `${new Date(b.timestamp).toLocaleString()} — ${(b.size / 1024).toFixed(1)} KB`,
          detail: b.path,
          backup: b,
        })),
        { title: 'KAI Config Backups' },
      );
      if (!pick) return;
      const action = await vscode.window.showQuickPick(['Restore', 'Delete', 'Cancel'], {
        title: pick.label,
      });
      if (action === 'Restore') {
        try {
          const r = await backupManager.restoreBackup(
            pick.backup.path,
            path.join(configDir, pick.backup.originalName),
          );
          void vscode.window.showInformationMessage(r.detail);
          engineRoomProvider.refresh();
        } catch (e) {
          getLogger().error('config_failure', 'Backup restore failed', undefined, e);
        }
      } else if (action === 'Delete') {
        await backupManager.deleteBackup(pick.backup.path);
        void vscode.window.showInformationMessage('Backup deleted.');
        engineRoomProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('kai.restoreBackup', async () => {
      await vscode.commands.executeCommand('kai.listBackups');
    }),

    vscode.commands.registerCommand('kai.getProxyStatus', () => {
      const s = proxyManager?.getStatus();
      void vscode.window.showInformationMessage(
        s?.running ? `Proxy running on :${s.port} (pid ${s.pid}).` : 'Proxy not running.',
      );
    }),

    vscode.commands.registerCommand('kai.restartProxy', async () => {
      if (!proxyManager) {
        void vscode.window.showWarningMessage('Proxy not configured.');
        return;
      }
      try {
        await proxyManager.stop();
        await proxyManager.start(proxyScript);
        void vscode.window.showInformationMessage('Proxy restarted.');
      } catch (e) {
        getLogger().error('proxy_error', 'Proxy restart failed', undefined, e);
      }
    }),

    registerRawInspectorCommand(context, rawInspector),
  );

  logger.info('internal', 'KAI Agent Workbench activated successfully.');
}

function createCognitive1Client(config: vscode.WorkspaceConfiguration): Cognitive1Client {
  const brainPath = config.get<string>('brainPath', '');
  if (brainPath) {
    getLogger().info('internal', `Using embedded Cognitive1 at ${brainPath}.`);
    return new EmbeddedCognitive1(brainPath);
  }
  if (config.get<boolean>('cognitive1Enabled', true)) {
    const url = config.get<string>('cognitive1Url', 'http://127.0.0.1:9876');
    getLogger().info('internal', `Using Cognitive1 HTTP client at ${url}.`);
    return new Cognitive1HttpClient(url);
  }
  return new DisabledCognitive1Client();
}

async function checkSessionRecovery(
  ctx: vscode.ExtensionContext,
  orch: WorkbenchOrchestrator,
): Promise<void> {
  const recovery = ctx.workspaceState.get<SessionRecoveryState>(RECOVERY_KEY);
  if (!recovery) return;
  const age = Date.now() - new Date(recovery.savedAt).getTime();
  if (age > 30 * 60 * 1000) {
    void ctx.workspaceState.update(RECOVERY_KEY, undefined);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `KAI: A task was interrupted ${Math.round(age / 1000)}s ago. Restore?`,
    'Restore',
    'Dismiss',
  );
  if (choice === 'Restore') {
    orch.setAgent(recovery.agent);
    orch.setRoute(recovery.route);
    orch.setAutonomy(recovery.autonomy);
    getLogger().info('internal', 'Session restored from recovery state.');
  }
  void ctx.workspaceState.update(RECOVERY_KEY, undefined);
}

export function deactivate(): void {
  getLogger().info('internal', 'KAI Agent Workbench deactivating...');
  void proxyManager?.stop();
}
