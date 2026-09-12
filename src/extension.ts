import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { AcpAgentAdapter } from './adapters/acp-adapter';
import { parseClaudeJsonLine } from './adapters/claude-parser';
import { parseCodexJsonLine } from './adapters/codex-parser';
import { parseGeminiJsonLine } from './adapters/gemini-parser';
import { buildClaudeArgs, buildCodexArgs, ProcessAgentAdapter } from './adapters/process-agent-adapter';
import { QwenAcpAdapter } from './adapters/qwen-acp-adapter';
import type { Cognitive1Client } from './cognitive1/cognitive1-client';
import { Cognitive1HttpClient, DisabledCognitive1Client } from './cognitive1/cognitive1-client';
import { EmbeddedCognitive1 } from './cognitive1/embedded-cognitive1';
import { CognitiveRuleStore } from './cognitive1/rule-store';
import { BackupManager } from './config/backup-manager';
import { CodexConfigWriter, defaultCodexConfigPath } from './config/codex-config';
import { ClaudeConfigWriter } from './config/claude-config';
import { loadOrCreateProxyToken } from './config/proxy-token';
import { QwenConfigWriter } from './config/qwen-config';
import { ProjectPreferences } from './config/project-preferences';
import { createEventId, nowIso } from './core/events';
import type { WorkbenchEvent } from './core/events';
import { getLogger, initLogger } from './core/logger';
import type { AgentId, AutonomyMode, RouteMode, WorkbenchState } from './core/types';
import { migrateAutonomyMode } from './core/types';
import { WorkbenchOrchestrator } from './orchestrator/orchestrator';
import { VSCodeDiffApplier } from './orchestrator/vscode-diff-applier';
import { EngineRoomViewProvider } from './panel/engine-room-view-provider';
import { SettingsViewProvider } from './panel/settings-view-provider';
import { SecretStore } from './config/secret-store';
import { resolveProxyConfig, toProxyServerConfig, migrateLegacyProxySecrets } from './config/proxy-config';
import { openListTab } from './panel/list-tab-panel';
import { MemoryTreeProvider } from './panel/memory-tree-provider';
import { SessionsTreeProvider } from './panel/sessions-tree-provider';
import { WorkbenchViewProvider } from './panel/workbench-view-provider';
import { RawEventInspector, registerRawInspectorCommand } from './panel/raw-event-inspector';
import { ProxyManager } from './proxy/proxy-manager';
import { KaiProxyServer, type ProxyServerConfig } from './proxy/proxy-server';

interface SessionRecoveryState {
  prompt: string;
  agent: AgentId;
  route: RouteMode;
  autonomy: AutonomyMode;
  taskId: string;
  savedAt: string;
}

let proxyManager: ProxyManager | undefined;
let kaiProxy: KaiProxyServer | undefined;
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
  const globalAutonomy = migrateAutonomyMode(config.get<string>('defaultAutonomy', 'ask'));
  const project = prefs.getState(globalAgent, globalRoute, globalAutonomy);
  const customPermissions = prefs.getCustomPermissions();

  const initialState: WorkbenchState = {
    activeAgent: project.agent,
    route: project.route,
    autonomy: project.autonomy,
    isRunning: false,
  };

  const cognitive1 = createCognitive1Client(config);
  const embeddedCognitive1 = cognitive1 instanceof EmbeddedCognitive1;
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const codexConfigWriter = new CodexConfigWriter();
  const claudeConfigWriter = new ClaudeConfigWriter();
  const qwenConfigWriter = new QwenConfigWriter();
  const backupManager = new BackupManager();
  const configDir = path.dirname(defaultCodexConfigPath());
  const proxyPort = config.get<number>('proxyPort', 8082);
  const proxyScript = config.get<string>('proxyScript', '');

  // KAI's embedded brain does not listen on the legacy C1 HTTP port. Remove
  // only that stale Codex MCP binding; leave all other MCP servers untouched.
  void codexConfigWriter.reconcileCognitive1Mcp({ removeCognitive1HttpServer: embeddedCognitive1 })
    .then((result) => {
      if (result.changed) logger.info('config_failure', `Removed stale embedded Cognitive1 MCP server from ${result.configPath}.`);
    })
    .catch((error: unknown) => logger.error('config_failure', 'Failed to reconcile Codex Cognitive1 MCP config.', undefined, error));

  // Migrate legacy plaintext proxy keys to SecretStorage (one-time, idempotent)
  const legacyCfg = vscode.workspace.getConfiguration('claudeProxy');
  void migrateLegacyProxySecrets(legacyCfg, config, secretStore).then((result) => {
    if (result.migrated.length > 0) {
      logger.info('internal', `Migrated legacy proxy keys: ${result.migrated.join(', ')}.`);
    }
  });

  // Token Claude sends back on every proxy-routed request (via
  // ANTHROPIC_AUTH_TOKEN — see claude-config.ts) so the proxy can tell KAI's
  // own Claude process apart from any other local caller. Stable per
  // installation — see loadOrCreateProxyToken.
  const proxyAuthToken = await loadOrCreateProxyToken(context.globalStorageUri.fsPath);

  // Start the built-in KAI proxy server (always)
  try {
    const resolved = await resolveProxyConfig(config, legacyCfg, secretStore);
    const proxyCfg: ProxyServerConfig = { ...toProxyServerConfig(resolved), authToken: proxyAuthToken };
    kaiProxy = new KaiProxyServer(proxyCfg);
    await kaiProxy.start();
    context.subscriptions.push({ dispose: () => { void kaiProxy?.stop(); } });
    logger.info('proxy_error', `KAI proxy server started on port ${proxyPort}.`);
  } catch (err) {
    logger.error('proxy_error', 'Failed to start KAI proxy server.', undefined, err);
  }

  // Optional external proxy script (for advanced/custom setups)
  if (proxyScript) {
    try {
      proxyManager = new ProxyManager(proxyPort + 1);
      void proxyManager.start(proxyScript);
      context.subscriptions.push({ dispose: () => { void proxyManager?.stop(); } });
      logger.info("proxy_error", `External proxy manager started on port ${proxyPort + 1}.`);
    } catch (err) {
      logger.error("proxy_error", "Failed to start external proxy manager.", undefined, err);
    }
  }
  const executionRulesPath = resolveExecutionRulesPath(
    config.get<string>('executionRulesPath', ''),
    projectPath,
  );
  const orchestrator = new WorkbenchOrchestrator(
    initialState,
    cognitive1,
    projectPath,
    new VSCodeDiffApplier(),
    new CognitiveRuleStore(executionRulesPath),
  );
  orchestrator.setCustomPermissions(customPermissions);
  orchestrator.setAlwaysAllowRules(prefs.getAlwaysAllowRules());
  orchestrator.on('approvalRuleChanged', (rules: string[]) => { void prefs.setAlwaysAllowRules(rules); });

  // Register Claude adapter — with dedicated parser + proxy config
  orchestrator.registerAdapter(
    new ProcessAgentAdapter({
      id: 'claude',
      displayName: 'Claude',
      command: config.get<string>('claudeCommand', 'claude'),
      buildArgs: buildClaudeArgs,
      parseLine: parseClaudeJsonLine,
      supportsApprovals: true,
      supportsMcp: true,
      beforeRun: async (req) => {
        if (req.route !== 'proxy') return [];
        try {
          const r = await claudeConfigWriter.ensureProxyConfig({ port: proxyPort, authToken: proxyAuthToken });
          return [
            {
              id: createEventId(),
              type: 'agent.lifecycle',
              taskId: req.taskId,
              timestamp: nowIso(),
              agent: 'claude',
              status: 'running',
              detail: r.changed
                ? 'Claude proxy config written to ~/.claude/settings.json.'
                : 'Claude proxy config up to date.',
            },
          ];
        } catch (err) {
          logger.error('config_failure', 'Failed to configure Claude proxy settings.', undefined, err);
          return [];
        }
      },
    }),
  );

  // Register Codex adapter â€” with proxy profile management
  orchestrator.registerAdapter(
    new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: config.get<string>('codexCommand', 'codex'),
      buildArgs: buildCodexArgs,
      parseLine: parseCodexJsonLine,
      supportsApprovals: true,
      supportsMcp: true,
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

  // Register Qwen adapter with the real JSON-RPC ACP client. The old
  // parser-only adapter piped the prompt to stdin and could never complete
  // ACP's initialize/session/prompt handshake.
  orchestrator.registerAdapter(
    new QwenAcpAdapter({
      command: config.get<string>('qwenCommand', 'qwen'),
    }),
  );

  // Register Gemini adapter â€” with dedicated parser
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
    const px = kaiProxy?.isRunning() ? 'proxy:on' : 'proxy:off';
    statusBar.text = `KAI: ${s.activeAgent} | ${s.route} | ${s.autonomy} | ${px} | ${run}`;
    statusBar.tooltip = 'Open KAI Agent Workbench';
    statusBar.show();
  };
  updateStatus(orchestrator.getState());

  // Register webview providers
  const attachmentsDir = path.join(context.globalStorageUri.fsPath, 'attachments');
  const workbenchProvider = new WorkbenchViewProvider(context.extensionUri, orchestrator, prefs, attachmentsDir, context.globalStorageUri.fsPath);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WorkbenchViewProvider.viewType, workbenchProvider),
    workbenchProvider.registerCheckpointContentProvider(),
  );

  // Active-file tracking for the composer's "active file" context chip.
  const postActiveEditor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      workbenchProvider.postActiveFile(undefined);
      return;
    }
    workbenchProvider.postActiveFile(vscode.workspace.asRelativePath(editor.document.uri, false));
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(postActiveEditor));
  postActiveEditor(vscode.window.activeTextEditor);

  const engineRoomProvider = new EngineRoomViewProvider(
    context.extensionUri,
    orchestrator,
    backupManager,
    configDir,
    proxyManager,
  );
  // No longer a sidebar view — reached from the workbench gear as an editor tab.

  const settingsProvider = new SettingsViewProvider(
    context.extensionUri,
    orchestrator,
    secretStore,
    proxyManager,
    claudeConfigWriter,
    qwenConfigWriter,
    codexConfigWriter,
    proxyAuthToken,
  );
  // Same — settings is an editor tab now, opened from the gear menu.

  // Not registered as tree views any more — the sidebar is chat-only, so these
  // back the Memory/Sessions editor tabs opened from the workbench gear menu.
  const memoryProvider = new MemoryTreeProvider(cognitive1);
  const sessionsProvider = new SessionsTreeProvider(cognitive1);

  const rawInspector = new RawEventInspector();

  // Orchestrator state listener
  orchestrator.on('state', (s: WorkbenchState) => {
    // When route switches to proxy, write Qwen config immediately
    // (Qwen uses AcpAgentAdapter which has no beforeRun hook)
    if (s.route === 'proxy') {
      void qwenConfigWriter.ensureProxyConfig({ port: proxyPort }).catch(err =>
        logger.error('config_failure', 'Failed to configure Qwen proxy settings.', undefined, err)
      );
    }
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
  const runStartedAt = new Map<string, number>();
  const NOTIFY_AFTER_MS = 20_000;
  orchestrator.on('event', (e: WorkbenchEvent) => {
    workbenchProvider.postEvent(e);
    memoryProvider.refresh();
    sessionsProvider.refresh();
    rawInspector.push(e);

    // Log errors through the centralized logger
    if (e.type === 'error') {
      getLogger().error('agent_crash', e.message, e.recoverable ? 'Recoverable' : 'Fatal');
    }

    // Notify + badge when something needs attention while the chat isn't
    // visible: a run that took a while to finish, or an approval waiting.
    if (e.type === 'agent.lifecycle' && e.status === 'starting') {
      runStartedAt.set(e.taskId, Date.now());
    } else if (e.type === 'agent.lifecycle' && (e.status === 'completed' || e.status === 'failed')) {
      const startedAt = runStartedAt.get(e.taskId);
      runStartedAt.delete(e.taskId);
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      if (elapsed >= NOTIFY_AFTER_MS && !workbenchProvider.isSidebarVisible()) {
        workbenchProvider.notifyUnseen();
        workbenchProvider.markCurrentConversationUnread();
        const verb = e.status === 'completed' ? 'finished' : 'failed';
        void vscode.window.showInformationMessage(`KAI: ${e.agent ?? 'Agent'} ${verb}.`, 'Open').then((choice) => {
          if (choice === 'Open') void vscode.commands.executeCommand('kai.openWorkbench');
        });
      }
    } else if (e.type === 'approval.request' && !workbenchProvider.isSidebarVisible()) {
      workbenchProvider.notifyUnseen();
      void vscode.window.showInformationMessage(`KAI: ${e.title} needs your approval.`, 'Open').then((choice) => {
        if (choice === 'Open') void vscode.commands.executeCommand('kai.openWorkbench');
      });
    }
  });

  // Session recovery
  void checkSessionRecovery(context, orchestrator);

  // Gear-menu destinations all open as editor tabs. They go through the same
  // attachWebview hook the (former) sidebar views used, so nothing needed a
  // second render path when the sidebar became chat-only.
  const openProviderTab = (
    id: string,
    title: string,
    provider: { attachWebview(w: vscode.Webview): void; detachWebview(w: vscode.Webview): void },
  ) => {
    const panel = vscode.window.createWebviewPanel(
      id,
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'kai-icon.png');
    provider.attachWebview(panel.webview);
    panel.onDidDispose(() => provider.detachWebview(panel.webview));
  };

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kai.openWorkbench', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.kai');
    }),

    vscode.commands.registerCommand('kai.openSettings', () => {
      openProviderTab('kai.settingsTab', 'KAI Settings', settingsProvider);
    }),

    vscode.commands.registerCommand('kai.openEngineRoom', () => {
      openProviderTab('kai.engineRoomTab', 'KAI Engine Room', engineRoomProvider);
    }),

    vscode.commands.registerCommand('kai.openMemory', () => {
      openListTab('KAI Memory', memoryProvider);
    }),

    vscode.commands.registerCommand('kai.openSessions', () => {
      openListTab('KAI Sessions', sessionsProvider);
    }),

    vscode.commands.registerCommand('kai.openChatTab', () => {
      openProviderTab('kai.chatTab', 'KAI Chat', workbenchProvider);
    }),

    vscode.commands.registerCommand('kai.openGoal', async () => {
      await workbenchProvider.openGoalEditor();
    }),

    vscode.commands.registerCommand('kai.openSkills', async () => {
      await workbenchProvider.openSkillsBrowser();
    }),

    vscode.commands.registerCommand('kai.openRules', async () => {
      await workbenchProvider.openRulesEditor();
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
      const picks: Array<{ label: string; description: string; mode: AutonomyMode }> = [
        { label: 'Plan', description: 'Read-only. Proposes a plan before touching any file.', mode: 'plan' },
        { label: 'Ask before edits', description: 'Asks before each file edit and command.', mode: 'ask' },
        { label: 'Edit automatically', description: 'Edits files without asking. Still asks before risky commands.', mode: 'autoEdit' },
        { label: 'Full access', description: 'Never asks. Best inside a worktree or a sandbox.', mode: 'full' },
        { label: 'Custom…', description: 'Choose which actions need approval.', mode: 'custom' },
      ];
      const s = await vscode.window.showQuickPick(picks, { title: 'Choose autonomy' });
      if (s) {
        orchestrator.setAutonomy(s.mode);
        void prefs.setAutonomy(s.mode);
      }
    }),

    vscode.commands.registerCommand('kai.cycleAutonomy', () => {
      const modes: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full'];
      const s = orchestrator.getState();
      const idx = modes.indexOf(s.autonomy);
      const n = modes[(idx === -1 ? 0 : idx + 1) % modes.length];
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
          description: `${new Date(b.timestamp).toLocaleString()} â€” ${(b.size / 1024).toFixed(1)} KB`,
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
      const running = kaiProxy?.isRunning() ?? false;
      void vscode.window.showInformationMessage(
        running ? `KAI proxy running on :${proxyPort}.` : 'KAI proxy not running.',
      );
    }),

    vscode.commands.registerCommand('kai.restartProxy', async () => {
      if (!kaiProxy) {
        void vscode.window.showWarningMessage('Proxy not configured.');
        return;
      }
      try {
        await kaiProxy.stop();
        await kaiProxy.start();
        void vscode.window.showInformationMessage('KAI proxy restarted.');
      } catch (e) {
        getLogger().error('proxy_error', 'Proxy restart failed', undefined, e);
      }
    }),

    vscode.commands.registerCommand('kai.openBrowser', () => {
      settingsProvider.openInBrowser();
    }),

    registerRawInspectorCommand(context, rawInspector),

    vscode.commands.registerCommand('kai.rejectCheckpointFile', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== 'kai-checkpoint') {
        void vscode.window.showWarningMessage('KAI: open a KAI diff review tab first (from a diff summary card\'s "Review in editor").');
        return;
      }
      const segments = input.original.path.split('/').filter(Boolean);
      const [taskId, ...fileParts] = segments;
      const filePath = fileParts.join('/');
      if (!taskId || !filePath) return;
      try {
        await orchestrator.restoreOneFileFromCheckpoint(taskId, filePath);
        void vscode.window.showInformationMessage(`KAI: reverted ${filePath}.`);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),

    vscode.commands.registerCommand('kai.addSelectionToChat', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('KAI: Select some text first.');
        return;
      }
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      workbenchProvider.postAddSelection(rel, editor.selection.start.line + 1, editor.selection.end.line + 1);
      await vscode.commands.executeCommand('kai.openWorkbench');
    }),
  );

  logger.info('internal', 'KAI Agent Workbench activated successfully.');
}

function createCognitive1Client(config: vscode.WorkspaceConfiguration): Cognitive1Client {
  // Default to embedded Cognitive1 (file-based, no external server needed).
  // Set kai.brainPath to "" and kai.cognitive1Enabled to true with a valid
  // kai.cognitive1Url to use an external Cognitive1 server instead.
  const brainPath = config.get<string>('brainPath') || defaultBrainPath();
  if (brainPath && config.get<boolean>('cognitive1Embedded', true)) {
    getLogger().info('internal', `Using embedded Cognitive1 at ${brainPath}.`);
    return new EmbeddedCognitive1(brainPath);
  }
  if (config.get<boolean>('cognitive1Enabled', false)) {
    const url = config.get<string>('cognitive1Url', 'http://127.0.0.1:9876');
    getLogger().info('internal', `Using Cognitive1 HTTP client at ${url}.`);
    return new Cognitive1HttpClient(url);
  }
  return new DisabledCognitive1Client();
}

function defaultBrainPath(): string {
  return path.join(require('os').homedir(), '.kai', 'brain');
}

function resolveExecutionRulesPath(configuredPath: string, projectPath?: string): string {
  const configured = configuredPath.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(projectPath || process.cwd(), configured);
  }

  const candidates = [
    projectPath ? path.join(path.dirname(projectPath), 'cognitive1', 'Instruct.md') : '',
    projectPath ? path.join(projectPath, 'Instruct.md') : '',
    path.join(defaultBrainPath(), 'Instruct.md'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
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
  void kaiProxy?.stop();
  void proxyManager?.stop();
}



