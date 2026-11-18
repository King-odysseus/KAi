import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, protocol, screen, session, shell } from 'electron';
import { MOCKUP_CSP, MOCKUP_SCHEME, serveMockup } from './mockup-server';
import { DIRECT_PROVIDER_ORDER, cliApiKeyCredentialId, KAI_TERMINAL_CREDENTIAL_ID, KAI_WINDOW_CREDENTIAL_ID, OPENPENCIL_CREDENTIAL_ID, OPENPENCIL_ENDPOINT, OPENPENCIL_MCP_SERVER_ID, PLAYWRIGHT_MCP_SERVER_ID, directProviderPreset, isLocalProvider, migrateDeepSeekModel, type AgentRunRequest, type ConversationOrigin, type ConversationRecord, type PersistedEvent, type PlaywrightViewportStatus, type RemoteWindowSummary } from '@kai/contracts';
import { ConversationStore, NodeFileSystem, RedactedLogger, SettingsService } from '@kai/runtime';
import { Cognitive1Client } from './cognitive1-client';
import { cliApiKeyEnvironment, cliProxyEnvironment, DesktopAgentRuntime } from './agent-runtime';
import { installKaiProjectMcpForAgents, installKaiTerminalMcpForAgents, installKaiWindowMcpForAgents, withKaiWindowMcpSetting, installPlaywrightMcpForAgents, installPlaywrightSharedMcpForAgents, preparePlaywrightMcpSettings, syncCognitive1Mcp, withKaiTerminalMcpSetting, withOpenPencilMcpSetting } from './agent-mcp-config';
import { PLAYWRIGHT_HOST_PORT, realPlaywrightHostPorts, startPlaywrightHost, type PlaywrightHost } from './playwright-host';
import { installCrashRecord } from './crash-record';
import { UsageLedger } from './usage-ledger';
import { ComposerQueueStore } from './composer-queue-store';
import { PromptPresetStore } from './prompt-preset-store';
import { startSharedBrowser } from './shared-browser';
import type { SharedBrowserDeps } from './shared-browser';
import { inspectPlaywrightViewport } from './playwright-viewport';
import { PLAYWRIGHT_WINDOW_SYNC_SCRIPT, withWindowSync } from './playwright-window-sync';
import { AgentTerminal } from './agent-terminal';
import { startTerminalMcpHost, type TerminalMcpHost } from './terminal-mcp-host';
import { startWindowMcpHost, type WindowMcpHost } from './window-mcp-host';
import { WindowControl } from './window-control';
import { DesktopConfigBackupStore } from './backups';
import { CredentialVault } from './credential-vault';
import { DesktopDirectProviderRuntime } from './direct-provider-runtime';
import { DesktopExecutionRules } from './execution-rules';
import { listStylesheets } from './stylesheet-guard';
import { DesktopMcpRuntime } from './mcp-runtime';
import { ensureOpenPencilRunning, readOpenPencilDiscovery } from './open-pencil-launcher';
import { DesktopChangeReviewer } from './change-review';
import { loadFileAgents, withFileAgents } from './file-agents';
import { configureCopyCheckpoints } from './copy-checkpoints';
import { readPlan, writePlan } from './plan-store';
import { DesktopPlanReviewer, mergePlanItems } from './plan-review';
import { coverageNote, isSourceNeedingCoverage, testNamedFor } from './check-coverage';
import { jobFileFromArgv, processHeadlessJobFile } from './headless';
import { applyJumpList, jumpListIconPath, launchIntentFromArgv, type LaunchIntent } from './jump-list';
import { DesktopEvals, EvalStore } from './evals';
import { RunScoreStore } from './run-scores';
import { AgentExperienceStore } from './experience-store';
import { DesktopScheduler, ScheduleStore } from './scheduler';
import { cancelConversationRun, closeCompareRuns, closeMemorySessions, confirmEditorNavigation, ensureStudioDesktopProject, handleRendererWindowClosed, importBrainFromDirectory, cognitive1Ready, mirrorBrainNow, registerIpc, runConversationAgent, runInteractiveAgent, runScheduledGoal, type IpcContext } from './ipc';
import { createDesktopPaths } from './paths';
import { setBundledSkillsRoot } from './skills';
import { configureProjectKnowledge, stopProjectKnowledge } from './project-knowledge';
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
import { hashFile, recordVerification, runCheckCommand, suggestTestCommand, VerificationStore } from './verification';
import { runToolHooks, type ToolHookCall } from './automation';
import { gitDiffAgainstHead, gitOverview } from './git-tools';
import type { ArchitectReadiness, ArchitectSplit, ArchitectStatus, RoleTarget } from '@kai/contracts';
import { NotificationCenter } from './notification-rules';
import { DesktopServiceController } from './service-controller';
import { WorkflowTemplateStore } from './workflow-templates';
import { LearningProgressStore } from './learning-progress';
import { DesktopLearningTutor } from './learning-tutor';
import { TeachingLibraryStore } from './teaching-library';
import { SecurityFindingsStore } from './security-findings-store';
import { EditorSessionManager } from './editor-sessions';
import { LearningBudgetGuard, LearningUsageStore } from './learning-usage';
import { DesktopWorkflowRunner } from './workflow-runner';
import { DesktopCrewRunner } from './crew-runner';
import { CrewBlockerStore } from './crew-blockers';
import { createProjectCheckpoint, diffFromCheckpoint, git as runGit, restoreCheckpoint, textDiffFileFromCheckpoint } from './checkpoints';
import { ruleBlock } from './crew-engine';
import { DesktopCrewInterview } from './crew-interview';
import { CrewRunStore } from './crew-store';
import { CrewSupport } from './crew-support';
import { ConventionService } from './conventions-service';
import { DesktopTeamPlanner } from './team-planner';
import { DesktopAutopilot } from './autopilot';
import { DesktopAutoSession } from './auto-session';
import { ArchitectCoach, ArchitectLoop, targetLabel } from './architect-loop';
import { AutoWindowStore } from './auto-session-store';
import { AutopilotRunStore } from './autopilot-store';
import { BrainMirrorLoop } from './brain-mirror';
import { DesktopPromptGuide } from './prompt-guide';
import { DesktopInterview } from './interview';
import { InterviewStore } from './interview-store';
import { StudioArtifacts } from './artifacts';
import { StudioBoardStore } from './board';
import { DesktopStudio } from './studio';
import { DesktopGuideService } from './studio-guide-service';
import { DesktopCodeGuideService } from './code-guide-service';
import { writeHandoffFiles } from './handoff-files';
import { StudioStyleReferenceStore } from './style-references';
import { DesktopEqualizer, type EqualizerService } from './equalizer';
import { DESIGN_TOOLS, pagesFromReply, type DesignPorts } from './design-source';
import { createEqualizerPorts } from './equalizer-ports';
import { SPEC_ROOT, SpecStore, ensureSpecIgnore } from './spec-store';
import { DesktopUiCheck, failureSummary, playwrightUiCheckPorts } from './ui-check';
import { playwrightDesignScreenshot } from './design-screenshot';
import { DesktopDevCheck, playwrightDevCheckPorts } from './dev-check';
import { listProjectFiles, resolveInside } from './project-files';
import { completeTeam } from './team-assign';
import { TeamRecordStore } from './team-record-store';
import { activeParallelDirectories, createParallelSession, projectPathForCopy } from './parallel-session';
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

/**
 * Codex, Claude, Qwen and Gemini each hold an MCP entry that runs this very binary on `kai-project.cjs`, with
 * `ELECTRON_RUN_AS_NODE=1` so it behaves as plain Node. An app that drops that variable launches the whole of KAI
 * instead: with KAI running, the second-instance handler below pops its window up; with it closed, a window opens and
 * goes again. Every such launch ends here, before it can ask for the instance lock and so before it can signal the
 * copy that is running.
 */
const launchedAsBoardServer =
  !process.env.ELECTRON_RUN_AS_NODE && process.argv.slice(1).some((argument) => /[\\/]kai-project\.cjs$/i.test(argument));
if (launchedAsBoardServer) app.exit(0);
const hasSingleInstanceLock = launchedAsBoardServer ? false : app.requestSingleInstanceLock();
let ipcContext: IpcContext | null = null;
let serviceController: DesktopServiceController | null = null;
/** Held here as well as in `startApplication`, because the quit handler runs after that scope has gone. */
let proxyRoutingRef: DesktopProxyRouting | null = null;
let mcpRuntime: DesktopMcpRuntime | null = null;
let terminalMcpHost: TerminalMcpHost | null = null;
let windowMcpHost: WindowMcpHost | null = null;
/** The one Playwright browser every agent shares, once it is answering. Ended with KAI. */
let playwrightHost: PlaywrightHost | null = null;
let remoteGateway: RemoteGateway | null = null;
let shutdownPromise: Promise<void> | null = null;
/**
 * The two bounds on quitting, held where both the shutdown chain and the cancel path can reach them. A quit the
 * person cancels must take its deadlines with it: a timer left armed would force-kill a running app later.
 */
let quitDeadline: NodeJS.Timeout | null = null;
let forceExit: NodeJS.Timeout | null = null;
let desktopShell: DesktopShell | null = null;
/** Levels KAI's brain with the mirror brain in the background; null until the app is built. */
let mirrorLoop: BrainMirrorLoop | null = null;
let overwatchApprovalTimer: NodeJS.Timeout | null = null;
let routeHousekeepingTimer: NodeJS.Timeout | null = null;
let overwatchApprovalBusy = false;
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
    const intent = launchIntentFromArgv(commandLine);
    if (intent && ipcContext) {
      void openWindowForIntent(intent);
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

/** A taskbar menu pick: a separate window, or one on a project. A project that has gone falls back to a plain window. */
async function openWindowForIntent(intent: NonNullable<LaunchIntent>): Promise<void> {
  if (intent.kind === 'new-window') {
    await createMainWindow(null);
    return;
  }
  const known = ipcContext ? (await ipcContext.projects.list()).some((project) => project.id === intent.projectId) : false;
  await createMainWindow(known ? intent.projectId : undefined);
}

/** Keeps the taskbar menu in step with the projects the user has. */
function refreshJumpList(): void {
  const context = ipcContext;
  if (!context) return;
  void context.projects.list()
    .then((projects) => {
      const result = applyJumpList(projects, jumpListIconPath());
      // Windows says why when it refuses a menu (for example, recent items switched off); say so in the log too.
      if (result !== 'ok') context.logger.warn('internal', `The taskbar menu was not set: ${result}`);
    })
    .catch(() => undefined);
}

if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('ai.kai.desktop');
installCrashRecord();
// Mockups are served from their own scheme with their own policy; see mockup-server.ts. Registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: MOCKUP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!launchedAsBoardServer) app.whenReady().then(startApplication).catch(reportStartupFailure);

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // On the record, because its absence is the interesting case: a close that leaves this unsaid is a close that
  // never reached here, which is the state that used to leave KAI running with nothing on screen.
  ipcContext?.logger.info('internal', 'The last window closed; ending KAI and everything it started.');
  // Closing the last window ends KAI and every process it started (Cognitive1, the proxy, MCP servers, terminals),
  // even with KAI Remote on: the phone console is only reachable while KAI is open. Someone who wants KAI to keep
  // running in the background can turn on the tray option, which keeps the app alive while an agent is working.
  app.quit();
});

/**
 * How long the unsaved-changes prompt may hold up a quit before KAI leaves anyway. Long enough for someone to
 * read the dialog and choose, since the alternative is an app that cannot be closed at all.
 */
const QUIT_CONFIRMATION_MS = 120_000;

/**
 * The backstop for a quit that never reaches the handler below: the default one taken when the app is asked to
 * quit before its context exists, or on a second attempt while the first is still running. Those paths left KAI
 * without ending what it had started, which is the one thing the tree kill is for. `app.exit` does not emit this,
 * so it cannot re-enter the handler from here.
 */
app.on('will-quit', () => {
  // Best effort: what was learned since the last save is written before the process goes.
  void stopProjectKnowledge();
  endOwnProcessTree();
});

app.on('before-quit', (event) => {
  quitting = true;
  const activeContext = ipcContext;
  if (!activeContext || shutdownPromise) return;
  event.preventDefault();
  // Armed before the unsaved-changes prompt rather than after it, because that prompt is answered by a person and
  // can wait forever on an answer that never comes, which left quitting with no bound at all. The window is
  // generous because it is measured against someone reading a dialog, not against the shutdown that follows.
  quitDeadline = setTimeout(() => {
    if (!quitting) return;
    ipcContext?.logger.warn('internal', 'Quit was never confirmed; exiting anyway');
    endOwnProcessTree();
    app.exit(0);
  }, QUIT_CONFIRMATION_MS);
  quitDeadline.unref();
  shutdownPromise = (async () => {
    for (const session of desktopWindows.live()) {
      if (await confirmEditorNavigation(activeContext, session, 'quit KAI')) continue;
      quitting = false;
      throw new Error('QUIT_CANCELLED');
    }
    // The person has agreed to quit, so the confirmation's own window is done and the bound belongs to the
    // shutdown from here: if a service refuses to stop, leave anyway rather than linger as background processes
    // after the window is gone.
    if (quitDeadline) clearTimeout(quitDeadline);
    quitDeadline = null;
    forceExit = setTimeout(() => {
      // Checked for the same reason as the confirmation's own timer: leaving is only ever right while a quit is
      // actually happening.
      if (!quitting) return;
      ipcContext?.logger.warn('internal', 'Shutdown took too long; exiting anyway');
      // Exiting is not enough on its own: on Windows a child outlives its parent, so leaving without this strands
      // the services, the agents, the terminals and every dev server KAI started — the very thing this path was
      // written to avoid lingering. It is also the last chance, since nothing runs after it.
      endOwnProcessTree();
      app.exit(0);
    }, 15_000);
    forceExit.unref();
  })()
    .then(() => closeMemorySessions(activeContext))
    .then(() => (activeContext ? closeCompareRuns(activeContext) : Promise.resolve()))
    .then(() => activeContext?.workflows.dispose())
    .then(() => activeContext?.autopilot.dispose())
    .then(() => activeContext?.auto.dispose())
    .then(() => activeContext?.architect.dispose())
    // Written out now rather than on its timer. Nothing depends on it: it is rebuilt from the conversations if lost.
    .then(() => activeContext?.usageLedger?.flush())
    .then(() => mirrorLoop?.stop())
    // The conventions watcher stops with the app, after any scan or write in flight has finished.
    .then(async () => { activeContext?.conventions?.stop(); await activeContext?.conventions?.idle(); })
    .then(() => { if (overwatchApprovalTimer) clearInterval(overwatchApprovalTimer); overwatchApprovalTimer = null; })
    .then(() => { if (routeHousekeepingTimer) clearInterval(routeHousekeepingTimer); routeHousekeepingTimer = null; })
    // Before the services are disposed, which is what stops the proxy: a CLI whose config still points at KAI's proxy
    // would otherwise be left talking to a port with nothing listening, and only a person reopening KAI would fix it.
    .then(() => proxyRoutingRef?.revertOwnedRoutes('KAI is quitting').catch((error: unknown) => {
      ipcContext?.logger.warn('internal', 'Could not revert the agent proxy routes on quit', messageOf(error));
    }))
    .then(() => activeContext?.scheduler.stop())
    .then(() => activeContext?.terminal.stopAll())
    .then(() => activeContext?.preview.stopAll())
    .then(() => Promise.all([
      serviceController?.dispose() ?? Promise.resolve(),
      // On Windows the MCP servers are ended with everything else at the very end, while they are still attached to
      // KAI; closing them one by one first would leave the processes behind them running.
      process.platform === 'win32' ? Promise.resolve() : (mcpRuntime?.dispose() ?? Promise.resolve()),
      remoteGateway?.dispose() ?? Promise.resolve(),
      terminalMcpHost?.close() ?? Promise.resolve(),
      windowMcpHost?.close() ?? Promise.resolve(),
      playwrightHost?.close() ?? Promise.resolve(),
    ]))
    .then(() => undefined)
    .catch((error) => {
      if (messageOf(error) !== 'QUIT_CANCELLED') {
        ipcContext?.logger.error('service_error', 'Service shutdown failed', undefined, error);
      }
    })
    .finally(() => {
      if (!quitting) {
        // The person refused the prompt, so nothing is quitting: drop the bounds with the quit. Leaving either
        // armed would end the process tree under a KAI that is still running.
        if (quitDeadline) clearTimeout(quitDeadline);
        if (forceExit) clearTimeout(forceExit);
        quitDeadline = null;
        forceExit = null;
        shutdownPromise = null;
        return;
      }
      serviceController = null;
      mcpRuntime = null;
      remoteGateway = null;
      terminalMcpHost = null;
      windowMcpHost = null;
      playwrightHost = null;
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

/** The KAI icon for the window and taskbar. A packaged app carries it beside its resources; a dev run reads it from the source tree. */
function appIconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../build/icon.png');
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
  // Where KAI keeps what it learns about each project: on this machine, beside the rest of its data.
  configureProjectKnowledge(path.join(paths.root, 'knowledge'));
  const fileSystem = new NodeFileSystem();
  const logger = new RedactedLogger(new RotatingLogSink(paths.logs));
  const buildIdentifier = await identifyBuild(app.getVersion());
  const settings = new SettingsService(paths.settings, fileSystem);
  const projects = new ProjectStore(paths.projects, fileSystem);
  const preferences = new ProjectPreferenceStore(paths.preferences, fileSystem);
  const teamRecord = new TeamRecordStore(path.join(paths.root, 'team-record.json'), fileSystem);
  const conversations = new ConversationStore(paths.conversations, fileSystem);
  const composerQueue = new ComposerQueueStore(path.join(paths.root, 'composer-queue.json'), fileSystem);
  const promptPresets = new PromptPresetStore(path.join(paths.root, 'prompt-presets.json'), fileSystem);
  // What the paid runs have cost, followed as conversations are saved. A run checks the budget against this instead of
  // loading every saved conversation, which at eight runs starting together ran the main process out of memory.
  const usageLedgerFile = path.join(paths.root, 'usage-ledger.json');
  const usageLedger = new UsageLedger({
    stamps: () => conversations.stamps(),
    read: (id) => conversations.get(id),
    load: () => readFile(usageLedgerFile, 'utf8').catch(() => null),
    save: async (text) => { await writeFile(usageLedgerFile, text, 'utf8'); },
  });
  conversations.observe({
    saved: (conversation, stamp) => usageLedger.noteSaved(conversation, stamp),
    removed: (id) => usageLedger.noteRemoved(id),
  });
  // Built in the background on the first launch after this arrives (a few seconds), so no run is the one that waits.
  void usageLedger.runs().catch((error: unknown) => logger.warn('internal', 'Could not build the usage ledger', messageOf(error)));
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
  // KAI's terminal, for agents. The sessions are the app's own so the terminal dock shows them, which is why the
  // server runs in this process; the endpoint and token are new every launch, so the agents' entries are rewritten
  // every launch too. Without it an agent runs commands in whatever shell it brings, or opens a window of its own.
  const terminalManager = new TerminalManager((event, ownerWindowId) => {
    if (ownerWindowId !== null && desktopWindows.send(ownerWindowId, 'terminal:event', event)) return;
    const fallback = desktopWindows.focused();
    if (fallback) fallback.window.webContents.send('terminal:event', event);
  });
  try {
    const agentTerminal = new AgentTerminal(terminalManager, {
      activeProject: async () => {
        const current = await settings.load();
        const active = (await projects.list()).find((project) => project.id === current.activeProjectId);
        return active ? { id: active.id, path: active.path } : null;
      },
    });
    terminalMcpHost = await startTerminalMcpHost(agentTerminal);
    await credentials.set(KAI_TERMINAL_CREDENTIAL_ID, terminalMcpHost.authorization);
    const terminalSetting = withKaiTerminalMcpSetting(await settings.load(), { endpoint: terminalMcpHost.endpoint });
    if (terminalSetting.changed) await settings.save(terminalSetting.settings);
    for (const result of await installKaiTerminalMcpForAgents({ endpoint: terminalMcpHost.endpoint, authorization: terminalMcpHost.authorization })) {
      if (result.error) logger.warn('internal', `KAI terminal MCP could not be added to ${result.agent}`, `${result.configPath}: ${result.error}`);
    }
  } catch (error) {
    logger.warn('internal', 'KAI terminal MCP could not start', messageOf(error));
  }
  // KAI's own windows, for agents: a picture of a window, its controls, and input to it. It sees KAI's pages only,
  // never another application, and holds still while an approval is on screen. See window-control.ts.
  try {
    const windowControl = new WindowControl(() => desktopWindows.live().map((entry) => ({
      id: entry.id,
      title: entry.window.getTitle(),
      projectId: entry.projectId,
      focused: entry.window.isFocused(),
      webContents: entry.window.webContents as never,
    })));
    windowMcpHost = await startWindowMcpHost(windowControl);
    await credentials.set(KAI_WINDOW_CREDENTIAL_ID, windowMcpHost.authorization);
    const windowSetting = withKaiWindowMcpSetting(await settings.load(), { endpoint: windowMcpHost.endpoint });
    if (windowSetting.changed) await settings.save(windowSetting.settings);
    for (const result of await installKaiWindowMcpForAgents({ endpoint: windowMcpHost.endpoint, authorization: windowMcpHost.authorization })) {
      if (result.error) logger.warn('internal', `KAI window MCP could not be added to ${result.agent}`, `${result.configPath}: ${result.error}`);
    }
  } catch (error) {
    logger.warn('internal', 'KAI window MCP could not start', messageOf(error));
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
        findingsFile: path.join(paths.learning, 'security-findings.json'),
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
  setBundledSkillsRoot(app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(kaiRoot, '.agents', 'skills'));
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
    // A route outlives the proxy unless something puts it back, and then a CLI started afterwards talks to a port
    // with nothing behind it. Both the explicit stop and the whole-controller dispose land here.
    onServiceStopped: (kind) => {
      if (kind !== 'universalProxy') return;
      void proxyRouting.revertOwnedRoutes('the proxy stopped').then((reverted) => {
        for (const agent of reverted) logger.info('internal', `Put ${agent} back to its own provider after the proxy stopped`);
      }).catch((error) => logger.warn('internal', 'Could not revert the agent proxy routes', messageOf(error)));
    },
  });
  const cognitive1 = new Cognitive1Client({
    access: serviceController,
    // The second brain, when one is configured: every lesson KAI files is filed there too, so the daemon that
    // commits and pushes its brain keeps up without the two writing the same files.
    mirror: async () => {
      const current = (await settings.load()).cognitive1.mirror;
      return current.enabled && current.endpoint ? { endpoint: current.endpoint, ...(current.token ? { token: current.token } : {}) } : null;
    },
  });
  // Levels KAI's brain and the mirror brain every few minutes, which is what carries lessons an agent filed
  // straight to the daemon over MCP across as well.
  mirrorLoop = new BrainMirrorLoop({
    // Both halves matter: no point reading the brain's files while the daemon that owns them is stopped.
    ready: async () => (await settings.load()).cognitive1.mirror.enabled && (await cognitive1Ready(ipcContext!)),
    sync: async () => {
      const outcome = await mirrorBrainNow(ipcContext!, false);
      return outcome;
    },
    onError: (error) => logger.warn('internal', 'The brain mirror sync failed', error instanceof Error ? error.message : String(error)),
    onSync: (outcome) => logger.info(
      'internal',
      // What was skipped and what was refused are said too: "filed 8 entries" read as a clean sync even when the run
      // had also been turned away for eight others.
      `Brain mirror: filed ${outcome.posted} entr${outcome.posted === 1 ? 'y' : 'ies'} in the second brain`
      + (outcome.failed > 0 ? `, ${outcome.failed} failed` : ''),
    ),
  });
  // The mirror is quiet by design, so its failures go to the log rather than to the screen.
  cognitive1.onMirrorError = (error) =>
    logger.warn('internal', 'The brain mirror rejected a write', error instanceof Error ? error.message : String(error));
  const proxy = new UniversalProxyClient({ access: serviceController });
  const proxyRouting: DesktopProxyRouting = new DesktopProxyRouting({
    locateEngine: () => serviceController!.engineInstallation('universalProxy'),
    loopbackAccess: () => serviceController!.loopbackAccess('universalProxy'),
    loadSettings: () => settings.load(),
    saveSettings: (next) => settings.save(next),
    onProblem: (message) => logger.warn('internal', message),
  });
  proxyRoutingRef = proxyRouting;
  const agents = new DesktopAgentRuntime(undefined, undefined, {
    resolveApiKeyEnvironment: async (agent, model) => {
      if (!(await settings.load()).cliApiKeys[agent]) return null;
      const key = await credentials.get(cliApiKeyCredentialId(agent)).catch(() => undefined);
      return key ? cliApiKeyEnvironment(agent, key, process.env, model) : null;
    },
    resolveProxyEnvironment: async (agent, request, model) => {
      const controller = serviceController;
      if (!controller) throw new Error('The managed service controller is unavailable.');
      const service = (await controller.status()).find((candidate) => candidate.kind === 'universalProxy');
      if (service?.status !== 'ready') throw new Error('Start Universal Proxy before using its CLI route.');
      const access = await controller.loopbackAccess('universalProxy');
      return cliProxyEnvironment(agent, access, model, request.conversationId);
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
  const securityFindings = new SecurityFindingsStore(path.join(paths.learning, 'security-findings.json'), fileSystem);
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
    // Older Studio plans may use UUIDs without dashes. Keep their workspace reachable after upgrades.
    if (!/^studio_(?:[0-9a-f]{32}|[0-9a-f-]{36})$/i.test(projectId)) throw new Error('Project not found.');
    const root = path.join(paths.studio, 'projects', projectId);
    await mkdir(root, { recursive: true });
    return root;
  };
  /** True when a folder is actually there. A recorded project can outlive the folder it names. */
  const folderExists = async (target: string): Promise<boolean> => stat(target).then(() => true, () => false);

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
    // The record can outlive the folder it names. A rename or a move leaves the path pointing at nothing, and the
    // failure then surfaces deep in the filesystem as ENOENT with no clue in it about which folder or what to do.
    if (!(await folderExists(linkedProject.path))) {
      throw new Error(`The folder this Studio plan was linked to is no longer there: ${linkedProject.path}. If the folder was renamed or moved, open the plan and point it at where it lives now.`);
    }
    return linkedProject.path;
  };
  mcpRuntime = new DesktopMcpRuntime(settings, credentials, logger);
  const playwrightConfigPath = path.join(paths.root, 'playwright-mcp-window.json');
  let playwrightPortPreference = PLAYWRIGHT_HOST_PORT;
  let repairingPlaywrightServer = false;
  let playwrightViewportStatus: PlaywrightViewportStatus = {
    status: 'unavailable', viewportWidth: null, windowWidth: null, screenWidth: null,
    message: 'The shared browser opens when an agent first uses it.',
  };
  const playwrightWindowSyncPath = path.join(paths.root, 'playwright-window-sync.cjs');
  const startConfiguredPlaywright: SharedBrowserDeps['start'] = async (onStopped) => {
    await mkdir(paths.root, { recursive: true });
    // A fixed browser viewport is disconnected from the native window size. When Chrome is maximized it can
    // leave a wide white strip beside the page. A null viewport lets desktop tabs follow the real window; the
    // responsive checker still makes its small measurements on tabs that it immediately closes.
    // Playwright's default `--disable-blink-features=AutomationControlled` makes Chrome show an "unsupported
    // command-line flag" bar across the top of every page, which pushes the page down and is not KAI's to keep.
    await writeFile(playwrightConfigPath, JSON.stringify({
      browser: {
        launchOptions: { args: ['--start-maximized'], ignoreDefaultArgs: ['--disable-blink-features=AutomationControlled'] },
        contextOptions: { viewport: null },
      },
      sharedBrowserContext: true,
    }, null, 2), 'utf8');
    await writeFile(playwrightWindowSyncPath, PLAYWRIGHT_WINDOW_SYNC_SCRIPT, 'utf8');
    return startPlaywrightHost(realPlaywrightHostPorts(), {
      preferredPort: playwrightPortPreference,
      onStopped: (code) => { if (!repairingPlaywrightServer) onStopped(code); },
      environment: {
        PLAYWRIGHT_MCP_CONFIG: playwrightConfigPath,
        NODE_OPTIONS: withWindowSync(playwrightWindowSyncPath, process.env.NODE_OPTIONS),
      },
    });
  };
  const sharedBrowserDeps: SharedBrowserDeps = {
    start: startConfiguredPlaywright,
    updateSettings: (mutator) => settings.update(mutator),
    reconnect: () => mcpRuntime?.invalidate(PLAYWRIGHT_MCP_SERVER_ID),
    installShared: (endpoint) => installPlaywrightSharedMcpForAgents({ endpoint }),
    installOwn: () => installPlaywrightMcpForAgents({ backups: false }),
    info: (message, detail) => logger.info('internal', message, detail),
    warn: (message, detail) => logger.warn('internal', message, detail),
  };
  const playwrightServerLost = (): void => { playwrightHost = null; };
  const repairPlaywrightViewport = async (): Promise<PlaywrightViewportStatus> => {
    const previous = playwrightHost;
    // Never terminate a server owned by another process. Move KAI's clients to a fresh configured instance instead.
    if (previous?.adopted) playwrightPortPreference = await realPlaywrightHostPorts().anyFreePort();
    repairingPlaywrightServer = true;
    try {
      await previous?.close();
      playwrightHost = null;
      const replacement = await startSharedBrowser(sharedBrowserDeps, playwrightServerLost);
      if (!replacement) throw new Error('KAI could not start a fresh shared browser. Check the Playwright MCP server settings and try again.');
      playwrightHost = replacement;
      playwrightViewportStatus = await inspectPlaywrightViewport(mcpRuntime!);
      if (playwrightViewportStatus.status === 'needs-reset') {
        throw new Error(`The fresh browser still reports a narrow viewport (${playwrightViewportStatus.viewportWidth}px inside a ${playwrightViewportStatus.windowWidth}px window).`);
      }
      if (previous?.adopted && playwrightViewportStatus.status === 'ok') {
        playwrightViewportStatus = { ...playwrightViewportStatus, message: 'KAI switched to a fresh browser. The older externally managed browser window was left running.' };
      }
      desktopWindows.broadcast('app:playwright-viewport', playwrightViewportStatus);
      return playwrightViewportStatus;
    } finally {
      repairingPlaywrightServer = false;
    }
  };
  // One Playwright browser for KAI and every agent. The server starts here, silently and in the background, so the
  // shared endpoint is answering before a run needs it — but nothing is opened. Playwright creates the browser when
  // the first client connects to this server, which is when an agent (or a check) actually uses it. KAI used to probe
  // the viewport here, and that probe was itself an MCP call: it connected a client at every launch, which launched
  // a Chrome window nobody had asked for.
  void startSharedBrowser(sharedBrowserDeps, playwrightServerLost).then((host) => {
    playwrightHost = host;
    if (!host) return;
    logger.info('internal', 'The shared browser is ready, and opens when an agent first uses it', host.endpoint);
  });
  const directApiOptions = {
    waitIfPaused: (conversationId: string, signal: AbortSignal) => runControl.waitIfPaused(conversationId, signal),
    // Rules and tool hooks are user-owned project preferences. A run only sees the project it is working in.
    // A build running in a separate copy of the project (a parallel crew task) works in a folder that matches no project,
    // so the copy is traced back to the project it was made from; otherwise it ran without the project's rules.
    loadPermissionRules: async (projectRoot: string) => {
      const owner = projectPathForCopy(projectRoot) ?? projectRoot;
      const project = (await projects.list()).find((candidate) => candidate.path === owner);
      return project ? (await preferences.get(project.id))?.automation?.permissionRules ?? [] : [];
    },
    runToolHook: async (call: ToolHookCall) => {
      const owner = projectPathForCopy(call.projectRoot) ?? call.projectRoot;
      const project = (await projects.list()).find((candidate) => candidate.path === owner);
      const automation = project ? (await preferences.get(project.id))?.automation : undefined;
      return runToolHooks(automation?.hooks, call, (command, timeoutMs, env) => runCheckCommand(
        call.projectRoot,
        command,
        call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        env,
      ));
    },
    resolveProxyRoute: async (request: AgentRunRequest) => {
      const controller = serviceController;
      if (!controller) throw new Error('The managed service controller is unavailable.');
      const access = await controller.loopbackAccess('universalProxy');
      return {
        baseUrl: `${access.endpoint}/a/${request.agent}/v1`,
        apiKey: access.token,
      };
    },
  };
  const directApi = new DesktopDirectProviderRuntime(settings, credentials, mcpRuntime, directApiOptions);
  // A separate instance, not the shared one above: its external tools are open-pencil's alone (scopedToServer),
  // so a design-build run can allow them outright without the weaker 'plan' autonomy that would deny them, and
  // without the stronger 'full' that would also unlock the project's own file and shell tools or every other MCP
  // server the user has enabled. See runDesignAgent below.
  const designBuildDirectApi = new DesktopDirectProviderRuntime(
    settings,
    credentials,
    mcpRuntime.scopedToServer(OPENPENCIL_MCP_SERVER_ID),
    directApiOptions,
  );

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
    // A headless job has no window of its own, so the shell ending the process on a quiet moment would cut its
    // run short. It waits for those the same way the startup job path does.
    canExit: () => headlessJobsInFlight === 0,
    // A window that is minimized still counts: it is on the taskbar, so it can be reached. Only a window nobody
    // can see is one nobody can reach.
    hasVisibleWindow: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible()),
    log: (message) => ipcContext?.logger.info('internal', message),
  });
  shell.apply((await settings.load()).notifications);
  const editorSessions = new EditorSessionManager();
  // Filled in after registerIpc returns the handler registry the gateway dispatches through.
  let remote!: RemoteGateway;
  let workflowRunner!: DesktopWorkflowRunner;
  let crewRunner!: DesktopCrewRunner;
  let crewSupport!: CrewSupport;
  let conventionService!: ConventionService;
  let teamPlanner!: DesktopTeamPlanner;
  let autopilot!: DesktopAutopilot;
  let auto!: DesktopAutoSession;
  let architect!: ArchitectLoop;
  let architectReadiness!: (target: RoleTarget) => Promise<ArchitectReadiness>;
  let promptGuide!: DesktopPromptGuide;
  let interview!: DesktopInterview;
  let studio!: DesktopStudio;
  let guide!: DesktopGuideService;
  let codeGuide!: DesktopCodeGuideService;
  let scheduler!: DesktopScheduler;
  let evals!: DesktopEvals;
  let changeReviewer!: DesktopChangeReviewer;
  let planReviewer!: DesktopPlanReviewer;

  // open-pencil is reached through the same MCP runtime as every other server, so its token stays in the vault.
  const openPencilPorts = async (): Promise<DesignPorts | null> => {
    const current = await settings.load();
    const server = current.mcpServers.find((candidate) => candidate.id === OPENPENCIL_MCP_SERVER_ID && candidate.enabled);
    if (!server) return null;
    return {
      endpoint: () => (server.transport === 'http' ? server.url : OPENPENCIL_ENDPOINT),
      call: async (tool, input) => {
        if (!mcpRuntime) throw new Error('The MCP runtime is not running.');
        const blocks = await mcpRuntime.callServerTool(OPENPENCIL_MCP_SERVER_ID, tool, input);
        if (blocks === null) throw new Error('open-pencil is not connected. Check its token in Settings, then try again.');
        return blocks;
      },
    };
  };
  // Open-pencil's token is reissued on every start of the editor (when it has one at all — auth can be turned off
  // in the editor, in which case the discovery file carries no token to go stale), so the live file is re-read and
  // KAI's own connection re-synced before every user-initiated open-pencil action, launching the editor first when
  // it is not already running. A mismatch here is exactly the "open-pencil could not be found" failure a stale
  // token produces.
  const ensureOpenPencilReady = async (): Promise<void> => {
    const live = await ensureOpenPencilRunning();
    const noAuth = live.token === null;
    const wantedAuth = noAuth ? undefined : `Bearer ${live.token}`;
    const [stored, current] = await Promise.all([
      noAuth ? Promise.resolve(undefined) : credentials.get(OPENPENCIL_CREDENTIAL_ID).catch(() => undefined),
      settings.load(),
    ]);
    const found = current.mcpServers.find((candidate) => candidate.id === OPENPENCIL_MCP_SERVER_ID);
    const server = found?.transport === 'http' ? found : undefined;
    const headersMatch = noAuth ? Object.keys(server?.headerCredentialIds ?? { x: '' }).length === 0 : stored === wantedAuth;
    const upToDate = headersMatch && server?.enabled && server.url === live.endpoint;
    if (upToDate) return;
    if (wantedAuth) await credentials.set(OPENPENCIL_CREDENTIAL_ID, wantedAuth);
    await settings.update((value) => withOpenPencilMcpSetting(value, { endpoint: live.endpoint, enabled: true, noAuth }).settings);
    mcpRuntime?.invalidate(OPENPENCIL_MCP_SERVER_ID);
  };
  // Pull the design and Check connection go through this instead of the plain port above, so they also launch the
  // editor and re-sync first. The Equalizer keeps the plain one: its designConnected() is a background status
  // check, not a person asking KAI to reach open-pencil right now, so it must not launch an app or wait on one.
  const openPencilPortsEnsuring = async (): Promise<DesignPorts | null> => {
    await ensureOpenPencilReady();
    return openPencilPorts();
  };
  // The Equalizer is built once the preview runtime exists; until then a call to it says so.
  let equalizerService: EqualizerService | null = null;
  const equalizer: EqualizerService = {
    screens: (projectId) => (equalizerService ? equalizerService.screens(projectId) : Promise.reject(new Error('The Equalizer is still starting.'))),
    run: (input) => (equalizerService ? equalizerService.run(input) : Promise.reject(new Error('The Equalizer is still starting.'))),
  };
  const styleReferences = new StudioStyleReferenceStore({
    settings: () => settings.load(),
    projectRoot: studioProjectRoot,
    spec: specStore,
    vision: learningTutor,
  });
  // Reads a plan file the goal names (text only, and not a huge one) so the questions come from what is really in it.
  const crewInterview = new DesktopCrewInterview({
    settings: () => settings.load(),
    requester: learningTutor,
    projectRoot: async (projectId) => projectRootFor(projectId),
    readText: async (absolutePath) => {
      const info = await stat(absolutePath).catch(() => null);
      if (!info?.isFile() || info.size > 400_000) return null;
      return readFile(absolutePath, 'utf8').catch(() => null);
    },
    readBrief: async (projectId) => {
      const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
      return project ? readFile(path.join(project.path, '.kai', 'spec', 'brief.md'), 'utf8').catch(() => null) : null;
    },
  });
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
    composerQueue,
    promptPresets,
    playwrightViewportStatus: async () => playwrightViewportStatus,
    repairPlaywrightViewport,
    usageLedger,
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
    terminalMcp: terminalMcpHost !== null,
    windowMcp: windowMcpHost !== null,
    ensureOpenPencil: ensureOpenPencilReady,
    workflowTemplates,
    backups,
    learningProgress,
    learningTutor,
    preview,
    teachingLibrary,
    securityFindings,
    compareRuns: new Map(),
    memorySessions: new Map(),
    pendingApprovals: new Map(),
    windows: desktopWindows,
    editorSessions,
    learningUsage,
    learningBudget,
    workflows: workflowRunner,
    crew: crewRunner,
    crewInterview,
    crewSupport,
    conventions: conventionService,
    teamPlanner,
    autopilot,
    auto,
    architect,
    architectReadiness,
    promptGuide,
    interview,
    studio,
    guide,
    codeGuide,
    styleReferences,
    equalizer,
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
    terminal: terminalManager,
    desktopShell: shell,
    getMainWindow: () => desktopWindows.focused()?.window ?? null,
    createWindow: (projectId) => createMainWindow(projectId),
    remote,
  };
  async function createBlankConversation(projectId: string, firstPrompt: string, origin?: ConversationOrigin) {
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
      ...(origin ? { origin } : {}),
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
  const crewStore = new CrewRunStore(path.join(paths.root, 'crew-runs.json'), fileSystem);
  const crewBlockers = new CrewBlockerStore(path.join(paths.root, 'crew-blockers.json'), fileSystem);
  // How this developer builds: learned from their own projects, kept up to date, filed into C1, and handed to every
  // agent run (the composer, Studio, Autopilot, workflows and the crew all start runs the same way).
  conventionService = new ConventionService(path.join(paths.root, 'conventions.json'), fileSystem, {
    projects: async () => (await ipcContext!.projects.list()).map((project) => ({ id: project.id, name: project.name, path: project.path })),
    learn: (payload) => cognitive1.operation({ operation: 'brain-learn', payload }),
    onChange: (state) => { for (const session of desktopWindows.live()) desktopWindows.send(session.id, 'conventions:changed', state); },
  });
  ipcContext.conventions = conventionService;
  conventionService.start();
  // Saved crew defaults, and a look at Open Pencil for the Design tab.
  crewSupport = new CrewSupport(path.join(paths.root, 'crew-defaults.json'), fileSystem, {
    designStatus: () => crewDesignStatus(),
    designEnsure: () => ipcContext!.studio.openPencilEnsure(),
  });
  ipcContext.crewSupport = crewSupport;
  // The design as the crew sees it: Studio's own look at open-pencil, in the crew's shape.
  const crewDesignStatus = async (): Promise<import('@kai/contracts').CrewDesign> => {
    const seen = await ipcContext!.studio.openPencilLook();
    return seen.state === 'running' ? { state: 'running', pages: seen.pages } : { state: seen.state, pages: [] };
  };
  /** What each crew was last notified about, so one question or finish raises one notification, not one per save. */
  const crewNotified = new Map<string, string>();
  crewRunner = new DesktopCrewRunner({
    design: {
      status: crewDesignStatus,
      ensureRunning: () => ipcContext!.studio.openPencilEnsure(),
      draw: async (projectId, prompt, conversationId) => {
        const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
        if (!project) throw new Error('The crew project is no longer available.');
        return ipcContext!.studio.designAgentTurn(prompt, project.path, conversationId);
      },
    },
    createConversation: createBlankConversation,
    runAgent: (request, ownerWindowId, options) => runConversationAgent(ipcContext!, request, ownerWindowId, options),
    cancelAgent: (conversationId) => cancelConversationRun(ipcContext!, conversationId),
    runCheck: async (projectId, command, signal, options) => {
      const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('The crew project is no longer available.');
      const check = await runCheckCommand(options?.cwd ?? project.path, command, signal);
      if (options?.cwd) return { passed: check.exitCode === 0, output: check.output };
      await recordVerification(ipcContext!.verification, project.id, project.path, check).catch(() => undefined);
      return { passed: check.exitCode === 0, output: check.output };
    },
    save: (run) => crewStore.save(run),
    load: (id) => crewStore.get(id),
    list: (projectId) => crewStore.list(projectId),
    readBrief: async (projectId) => {
      const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) return null;
      return readFile(path.join(project.path, '.kai', 'spec', 'brief.md'), 'utf8').catch(() => null);
    },
    notifyChanged: (ownerWindowId, run) => {
      desktopWindows.send(ownerWindowId, 'crew:changed', run);
      // A crew that stops on a question, or finishes, tells the person once. A missed question used to leave it
      // waiting for hours with nothing to say so.
      const stateKey = run.status === 'needsYou' && run.ask ? `ask:${run.ask.message}` : run.status === 'completed' ? 'completed' : '';
      if (stateKey && crewNotified.get(run.id) !== stateKey) {
        crewNotified.set(run.id, stateKey);
        const title = run.goal.replace(/\s+/g, ' ').slice(0, 60);
        void notifications.notifyCrew(run.status === 'completed' ? 'finished' : 'needsYou', title, run.status === 'completed' ? (run.remaining.length > 0 ? `Not finished yet: ${run.remaining[0]}` : 'Every task is accepted.') : run.ask?.message ?? 'It is waiting for your answer.', ownerWindowId).catch(() => undefined);
      } else if (!stateKey && run.status === 'running') {
        crewNotified.delete(run.id);
      }
    },
    changedFiles: async (projectId) => {
      const project = (await ipcContext!.projects.list()).find((candidate) => candidate.id === projectId);
      return project ? (await gitOverview(project.path)).changes.map((change) => change.path) : [];
    },
    worktrees: { prepare: async (projectId, key) => createParallelSession(await projectRootFor(projectId), key) },
    // Undo: the project as it was before a task started, what would change if it were put back, and putting it back.
    checkpoint: async (projectId) => createProjectCheckpoint(await projectRootFor(projectId)),
    diffSince: async (projectId, checkpoint) => (await diffFromCheckpoint(await projectRootFor(projectId), checkpoint)).map((change) => ({ path: change.path, added: change.added ?? 0, removed: change.removed ?? 0 })),
    restore: async (projectId, checkpoint) => restoreCheckpoint(await projectRootFor(projectId), checkpoint),
    // What a task changed, as a diff per file against the checkpoint taken before it started.
    fileDiffs: async (projectId, checkpoint, limit) => {
      const root = await projectRootFor(projectId);
      const changes = await diffFromCheckpoint(root, checkpoint);
      const files = await Promise.all(changes.slice(0, limit).map(async (change) => ({ path: change.path, diff: await textDiffFileFromCheckpoint(root, checkpoint, change.path, 20_000).catch(() => '') })));
      return { files, more: Math.max(0, changes.length - limit) };
    },
    // A phase report is written inside the project; the path may not leave it.
    writeReport: async (projectId, relativePath, content) => {
      const root = await projectRootFor(projectId);
      const target = path.resolve(root, relativePath);
      if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('The report path leaves the project.');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return relativePath;
    },
    // The project's commit rules, tried with a sample message and nothing committed, so a blocker is known before any money is spent.
    preflight: async (projectId, goal) => {
      const root = await projectRootFor(projectId);
      const messageFile = path.join(app.getPath('temp'), `kai-preflight-${Date.now()}.txt`);
      await writeFile(messageFile, `Start work on the planned tasks\n\nSample message used to check the commit rules. Nothing is committed.\n\n${goal.replace(/\s+/g, ' ').slice(0, 6000)}\n`, 'utf8');
      try {
        await runGit(root, ['hook', 'run', '--ignore-missing', 'commit-msg', '--', messageFile]);
        return null;
      } catch (error) {
        const text = error instanceof Error ? `${(error as { stderr?: string }).stderr ?? ''} ${error.message}` : String(error);
        // Git older than 2.36 has no "hook run"; that is not a blocker.
        if (/is not a git command|unknown option|usage: git hook/i.test(text)) return null;
        const known = ruleBlock(text);
        if (known) return { key: known.key, note: known.note };
        return { key: 'hook:commit-msg', note: `The project's commit-message check rejected a plain sample message: ${text.replace(/\s+/g, ' ').trim().slice(0, 240)}. Word commit messages to satisfy it.` };
      } finally {
        await rm(messageFile, { force: true }).catch(() => undefined);
      }
    },
    // A crew conversation made before the crew marker existed is marked now, so the Workspace keeps it out of its tabs.
    adoptConversation: async (conversationId, origin) => {
      const existing = await conversations.get(conversationId);
      if (existing && !existing.origin) await conversations.save({ ...existing, origin });
    },
    blockers: { load: (projectId) => crewBlockers.load(projectId), save: (projectId, item) => crewBlockers.save(projectId, item) },
    conventions: async () => conventionService.briefing(),
  });
  ipcContext.crew = crewRunner;
  teamPlanner = new DesktopTeamPlanner({
    teamRecords: () => teamRecord.list(),
    settings: () => settings.load(),
    projectTeam: async (projectId) => (await preferences.get(projectId))?.agentTeam ?? null,
    fileAgents: async (projectId) => {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      return project ? loadFileAgents(project.path) : [];
    },
    agentCapabilities: () => agents.capabilities(),
    directApi: async () => {
      const capability = await directApi.capability();
      return {
        available: capability.available,
        displayName: capability.displayName,
        local: isLocalProvider(capability.provider),
        provider: capability.provider,
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
    team: async (projectId) => {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      const fileRoles = project ? await loadFileAgents(project.path) : [];
      return withFileAgents(completeTeam((await preferences.get(projectId))?.agentTeam ?? (await settings.load()).agentTeam), fileRoles);
    },
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
  // The same connection as the change review: whoever the person picked to read their work reads the plan too.
  planReviewer = new DesktopPlanReviewer({ pickConnection: () => promptGuide.pickConnection(), requester: learningTutor });
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
    // Every board write tells the windows, wherever it came from. See `BoardPorts.changed`.
    changed: (projectId, board) => { ipcContext?.windows.broadcast('studio:board-changed', { projectId, board }); },
  });
  // The browser and dev server both checks drive, built once. The screen check and the dev proof differ in what they
  // judge, not in how they open a page, so they share this rather than each carrying their own copy of it.
  const checkRuntime = {
    mcp: {
      callServerTool: (serverId: string, toolName: string, input: Record<string, unknown>): Promise<unknown[] | null> => {
        if (!mcpRuntime) return Promise.reject(new Error('The MCP runtime is not running.'));
        return mcpRuntime.callServerTool(serverId, toolName, input);
      },
    },
    preview: {
      start: (projectId: string, projectPath: string, command?: string) => preview.start(projectId, projectPath, command),
      status: (projectId: string, projectPath: string) => preview.status(projectId, projectPath),
    },
    sleep: (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
  const checkNow = (): string => new Date().toISOString();
  const devCheck = new DesktopDevCheck(playwrightDevCheckPorts(checkRuntime));
  // The visual check drives the Playwright MCP KAI already installs for its agents; screenshots land with the card.
  const uiCheck = new DesktopUiCheck(playwrightUiCheckPorts({
    ...checkRuntime,
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
      await ensureSpecIgnore(projectPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(base64, 'base64'));
    },
  }, checkNow));
  // Autonomy is 'plan': it keeps the project's own file and shell tools read-only, same as any other read-mostly
  // run. That used to also deny open-pencil's own write tools (DesktopMcpRuntime.policy() denies every non-read-
  // only MCP tool under 'plan') — fixed by running this through designBuildDirectApi instead of the shared
  // instance: its external tools are open-pencil's alone, scoped and always allowed regardless of autonomy (see
  // mcpRuntime.scopedToServer above), so open-pencil can draw while the project's own files stay untouched.
  const runDesignAgent = async (
    prompt: string,
    projectRoot: string,
    conversationId: string,
    onEvent?: (event: PersistedEvent) => void,
    contextChips?: import('@kai/contracts').ContextChip[],
  ): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> => {
    // The design agent draws the way this developer wants things to look: their buttons, their cards, their rules.
    const conventions = conventionService.briefing();
    const request: AgentRunRequest = {
      conversationId,
      prompt: conventions ? `${conventions}\n\n---\n\n${prompt}` : prompt,
      agent: 'codex',
      execution: 'api',
      route: 'direct',
      autonomy: 'plan',
      ...(contextChips ? { contextChips } : {}),
    };
    // A design step runs with no one at a prompt. When the runtime would stop and ask whether to carry on (the same call
    // five times running, or a run that keeps describing work without doing it) it is told to carry on a few times,
    // and only then to wrap up. Left without an answer it wraps up at the first such question, which ended a step
    // that was working, a screen half drawn, with nothing said.
    let extraStretches = 0;
    const approvals = { request: async (approval: { runQuestion?: unknown }) => approval.runQuestion !== undefined && (extraStretches += 1) <= 3 };
    const result = await designBuildDirectApi.run(request, projectRoot, undefined, onEvent, approvals);
    const costUsd = result.events.reduce((total, event) => (event.type === 'cost.update' && event.amountUsd ? total + event.amountUsd : total), 0);
    return {
      status: result.status,
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
    };
  };
  studio = new DesktopStudio({
    settings: () => settings.load(),
    projectRoot: studioProjectRoot,
    requester: learningTutor,
    interview: { readiness: () => interview.readiness() },
    artifacts: studioArtifacts,
    board: studioBoard,
    uiCheck,
    openPencil: openPencilPortsEnsuring,
    // A look that never launches the editor and never switches its page: the discovery file, then `list_pages`.
    openPencilStatus: async () => {
      if (!(await readOpenPencilDiscovery())) return { state: 'not-running' as const };
      const ports = await openPencilPorts();
      if (!ports) return { state: 'not-configured' as const };
      try {
        const reply = await Promise.race([
          ports.call(DESIGN_TOOLS.pages, {}),
          new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('timed out')), 5_000); }),
        ]);
        return { state: 'running' as const, pages: pagesFromReply(reply) };
      } catch (error) {
        return { state: /401|unauthor/i.test(error instanceof Error ? error.message : String(error)) ? 'token-mismatch' as const : 'unreachable' as const };
      }
    },
    ensureOpenPencilRunning: ensureOpenPencilReady,
    runDesignAgent,
    cancelDesignAgent: (conversationId) => designBuildDirectApi.cancel(conversationId),
    screenshotDesignPage: playwrightDesignScreenshot(checkRuntime),
    handoff: {
      write: async (projectId, board, catalog) => {
        await writeHandoffFiles(await studioProjectRoot(projectId), board, catalog, new Date().toISOString());
      },
    },
    now: () => new Date().toISOString(),
  });
  ipcContext.studio = studio;
  // The Senior Dev reads the same four records the Studio screen does, and borrows the same provider plumbing the
  // interview and the composer use — it adds no second HTTP client and no third answer to "which provider".
  guide = new DesktopGuideService({
    settings: () => settings.load(),
    requester: learningTutor,
    spec: specStore,
    projectRoot: studioProjectRoot,
    interview: (projectId) => interview.read({ projectId }),
    artifacts: (projectId) => studio.artifacts(projectId),
    board: (projectId) => studio.board(projectId),
    design: (projectId) => studio.design(projectId),
    now: () => new Date().toISOString(),
  });
  // Without this the handlers below reach `context.guide` on an object it was never put on, and every read of the
  // Senior dev fails with a TypeError the screen cannot show. Constructing the service is not the same as wiring it.
  ipcContext.guide = guide;
  // The same guide for a folder of source code. It borrows the provider plumbing and the spec store above, and reads
  // four things the Code screen already has: the repository, the file list, what has been studied, and the board.
  codeGuide = new DesktopCodeGuideService({
    settings: () => settings.load(),
    requester: learningTutor,
    spec: specStore,
    projectRoot: studioProjectRoot,
    git: (projectId) => studioProjectRoot(projectId).then((root) => gitOverview(root)),
    files: (projectId) => studioProjectRoot(projectId).then((root) => listProjectFiles(root)).then((tree) => tree.files),
    learn: (projectId) => learningProgress.get(projectId),
    board: (projectId) => studioBoard.read(projectId),
    now: () => new Date().toISOString(),
  });
  // Identical trap to `guide` above, and worth the same comment: the literal captured this as undefined.
  ipcContext.codeGuide = codeGuide;
  const equalizerPortsFor = createEqualizerPorts({
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
    openPencil: openPencilPorts,
    readSpec: async (root, relativePath) => {
      try {
        return await readFile(await resolveInside(root, path.join(SPEC_ROOT, relativePath)), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeSpec: async (root, relativePath, content) => {
      const target = await resolveInside(root, path.join(SPEC_ROOT, relativePath));
      await ensureSpecIgnore(root);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    resolveRoot: async (projectId) => {
      const project = (await projects.list()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error('Project not found.');
      return project.path;
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  }, () => new Date().toISOString(), (projectId, event) => desktopWindows.broadcast('equalizer:progress', { projectId, ...event }));
  equalizerService = {
    screens: (projectId) => new DesktopEqualizer(equalizerPortsFor(projectId)).screens(projectId),
    run: (input) => new DesktopEqualizer(equalizerPortsFor(input.projectId)).run(input),
  };
  const openConversationInWindow = (ownerWindowId: number, conversation: ConversationRecord, openTab: boolean, background = false): void => {
    desktopWindows.send(ownerWindowId, 'app:open-conversation', {
      conversationId: conversation.id,
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      ...(openTab ? { openTab: true } : {}),
      ...(background ? { background: true } : {}),
    });
  };
  autopilot = new DesktopAutopilot({
    settings: () => settings.load(),
    board: (projectId) => studio.board(projectId),
    artifactsFor: (projectId) => studio.artifactTexts(projectId),
    claimCard: (projectId, cardId, agent) => studio.claim(projectId, cardId, agent),
    recordCardRun: (projectId, cardId, run) => studio.recordRun(projectId, cardId, run),
    setCheck: (projectId, cardId, check) => studio.setCheck(projectId, cardId, check),
    moveCard: async (projectId, cardId, status, note, by) => {
      const card = await studio.move(projectId, cardId, status, note, by);
      desktopWindows.broadcast('studio:board-changed', { projectId, board: await studio.board(projectId) });
      return card;
    },
    checkUi: async (projectId, card) => {
      const { result } = await studio.checkUi(projectId, card.id);
      return { passed: result.passed, summary: failureSummary(result) };
    },
    // An agent can only work inside a project the app knows, and a Studio plan is not one until it is registered.
    createConversation: async (projectId, title, card) => {
      const conversation = await createBlankConversation((await ensureStudioDesktopProject(ipcContext!, projectId)).id, title);
      // Marked as Autopilot's own. It is the only thing that tells this conversation apart from one Auto is carrying:
      // the two loops look identical on screen, and the composer has to know which run panel speaks for this tab.
      const owned: ConversationRecord = { ...conversation, origin: { kind: 'autopilot', studioProjectId: projectId, cardId: card.id, cardTitle: card.title } };
      await conversations.save(owned);
      return owned;
    },
    preflight: async (projectId) => { await ensureStudioDesktopProject(ipcContext!, projectId); },
    // Its own tab, the way Auto opens one: a run that took over the tab someone was reading in is a run they cannot
    // see the rest of the app around. And in the background: showing it switched the window to the conversation,
    // which closed the Studio under a design build that was drawing and cancelled it without a word.
    openConversation: (ownerWindowId, conversation) => openConversationInWindow(ownerWindowId, conversation, true, true),
    runAgent: (request, ownerWindowId, options) => runConversationAgent(ipcContext!, request, ownerWindowId, options),
    cancelAgent: (conversationId) => cancelConversationRun(ipcContext!, conversationId),
    // Cards that do not wait on one another run side by side, each in its own copy of the project.
    worktrees: { prepare: async (projectId, key) => createParallelSession(await studioProjectRoot(projectId), key) },
    runCheck: async (projectId, command, signal, options) => {
      // In a card's own copy the check is an early filter only: it is not filed, because the board's done rule reads
      // the verification run of the project itself.
      if (options?.cwd) {
        const early = await runCheckCommand(options.cwd, command, signal);
        return { passed: early.exitCode === 0, exitCode: early.exitCode, output: early.output, runId: null };
      }
      const projectPath = await studioProjectRoot(projectId);
      const check = await runCheckCommand(projectPath, command, signal);
      const run = await recordVerification(ipcContext!.verification, projectId, projectPath, check).catch(() => null);
      return { passed: check.exitCode === 0, exitCode: check.exitCode, output: check.output, runId: run?.id ?? null };
    },
    suggestCheck: async (projectId) => suggestTestCommand(await studioProjectRoot(projectId)),
    // The run's own proof that the app runs, taken on the local dev server once the board is finished. It is the one
    // claim Autopilot makes about the project running, and the only environment it can put the project in is dev.
    checkDev: async (projectId, routes, signal) => devCheck.run(projectId, await studioProjectRoot(projectId), routes, signal),
    changedFilesFor: async (projectId) => (await gitOverview(await studioProjectRoot(projectId))).changes.map((change) => change.path),
    // The one-stylesheet rule, counted around a card's work. A listing rather than a count, so the card is told which
    // file it added and where the styles belong.
    listStylesheets: async (projectId) => listStylesheets(await studioProjectRoot(projectId)),
    setPacer: (pacer) => directApi.setPacer(pacer),
    announce: (ownerWindowId, status) => desktopWindows.send(ownerWindowId, 'autopilot:changed', status),
    journal: new AutopilotRunStore(path.join(paths.root, 'autopilot')),
    trace: (message) => logger.info('internal', message),
    now: () => Date.now(),
  });
  ipcContext.autopilot = autopilot;
  const projectRootFor = async (projectId: string): Promise<string> => {
    const project = (await projects.list()).find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('Project not found.');
    return project.path;
  };
  // The Architect / Implementer split. One set of ports serves both Auto and a normal send, so a role is judged
  // "ready" in exactly one way: a CLI that is signed in, an API with its key, or a local server that answers.
  const agentNames: Record<string, string> = {};
  const roleReadiness = async (target: RoleTarget): Promise<{ ready: boolean; reason?: string }> => {
    if (target.execution === 'cli') {
      const capabilities = await agents.capabilities();
      for (const capability of capabilities) agentNames[capability.id] = capability.displayName;
      const found = capabilities.find((capability) => capability.id === target.agent);
      if (!found) return { ready: false, reason: 'that agent is not known to this build' };
      return found.available ? { ready: true } : { ready: false, reason: found.unavailableReason ?? `${found.displayName} is ${found.state.replace('_', ' ')}` };
    }
    const capability = await directApi.capability(target.api);
    return capability.available ? { ready: true } : { ready: false, reason: capability.unavailableReason ?? 'the API is unavailable' };
  };
  // Each role's run records itself as the conversation's agent. When a split run ends, the composer's own choices go
  // back on the record, so a tab reopened elsewhere shows what the person had selected rather than the last role.
  const restoreComposerRecord = async (
    conversationId: string,
    composer: { agent: AgentRunRequest['agent']; execution: 'cli' | 'api'; route: AgentRunRequest['route']; autonomy: AgentRunRequest['autonomy'] },
  ): Promise<void> => {
    const conversation = await conversations.get(conversationId);
    if (!conversation) return;
    await conversations.save({ ...conversation, activeAgent: composer.agent, execution: composer.execution, route: composer.route, autonomy: composer.autonomy });
  };
  const architectPorts = {
    runAgent: (request: AgentRunRequest, ownerWindowId: number) => runConversationAgent(ipcContext!, request, ownerWindowId),
    cancelAgent: (conversationId: string) => cancelConversationRun(ipcContext!, conversationId),
    // The brief's check command, once it has passed the safe-command test. Recorded like any other verification run.
    runCheck: async (projectId: string, command: string, signal: AbortSignal) => {
      const projectPath = await projectRootFor(projectId);
      const check = await runCheckCommand(projectPath, command, signal);
      await recordVerification(ipcContext!.verification, projectId, projectPath, check).catch(() => null);
      return { passed: check.exitCode === 0, exitCode: check.exitCode, output: check.output };
    },
    suggestCheck: async (projectId: string) => suggestTestCommand(await projectRootFor(projectId)),
    restoreComposer: restoreComposerRecord,
    ready: roleReadiness,
    // A fingerprint of every changed file's actual content, for "did this turn change anything". The review material
    // below cannot answer that: it stops at 30 files, cuts each diff at 6,000 characters, and shows a new file as a bare
    // name, so editing a new file or the far end of a big diff looked like no change at all.
    fingerprint: async (projectId: string) => {
      const root = await projectRootFor(projectId);
      const changes = (await gitOverview(root)).changes.map((change) => change.path).sort();
      const hash = createHash('sha1');
      for (const file of changes) {
        hash.update(`${file}\0`);
        try {
          const info = await stat(path.join(root, file));
          // A file this large is told apart by size and time; reading it all for a hash is not worth it.
          if (info.size > 5 * 1024 * 1024) hash.update(`${info.size}:${info.mtimeMs}`);
          else hash.update(await readFile(path.join(root, file)));
        } catch {
          hash.update('missing');
        }
        hash.update('\0');
      }
      return `${changes.length}:${hash.digest('hex')}`;
    },
    // What the Architect reads to review: the changed files and their diffs, bounded so a big change cannot flood it.
    reviewMaterial: async (projectId: string) => {
      const root = await projectRootFor(projectId);
      const changes = (await gitOverview(root)).changes.map((change) => change.path).slice(0, 30);
      const parts: string[] = [];
      for (const file of changes) {
        const diff = await gitDiffAgainstHead(root, file).catch(() => '');
        parts.push(diff.trim() ? `--- ${file}\n${diff.slice(0, 6_000)}` : `--- ${file} (new or unreadable as a diff)`);
      }
      return parts.join('\n\n');
    },
    agentNames: () => agentNames,
    // A task started with no conversation gets one, shown in the window, exactly as Auto does for its own.
    openNewConversation: async (projectId: string, title: string, ownerWindowId: number) => {
      const created = await createBlankConversation(projectId, title);
      openConversationInWindow(ownerWindowId, created, true);
      return created;
    },
    // Saved on the conversation so the tab reopens with the same Architect, Implementer and fallback.
    rememberSplit: async (conversationId: string, split: ArchitectSplit) => {
      const conversation = await conversations.get(conversationId);
      if (!conversation) return;
      await conversations.save({ ...conversation, architect: split });
    },
    announce: (ownerWindowId: number, status: ArchitectStatus) => desktopWindows.send(ownerWindowId, 'architect:changed', status),
    now: () => Date.now(),
  };
  architect = new ArchitectLoop(architectPorts);
  architectReadiness = async (target) => {
    const ready = await roleReadiness(target);
    return { ready: ready.ready, label: targetLabel(target, agentNames), ...(ready.reason ? { reason: ready.reason } : {}) };
  };

  auto = new DesktopAutoSession({
    getConversation: (conversationId) => conversations.get(conversationId),
    saveConversation: async (conversation) => { await conversations.save(conversation); return conversation; },
    createConversation: (projectId, title) => createBlankConversation(projectId, title),
    runAgent: (request, ownerWindowId) => runConversationAgent(ipcContext!, request, ownerWindowId),
    cancelAgent: (conversationId) => cancelConversationRun(ipcContext!, conversationId),
    restoreComposer: restoreComposerRecord,
    runCheck: async (projectId, command, signal) => {
      const projectPath = await projectRootFor(projectId);
      const check = await runCheckCommand(projectPath, command, signal);
      await recordVerification(ipcContext!.verification, projectId, projectPath, check).catch(() => null);
      return { passed: check.exitCode === 0, exitCode: check.exitCode, output: check.output };
    },
    changedFilesFor: async (projectId) => (await gitOverview(await projectRootFor(projectId))).changes.map((change) => change.path),
    suggestCheck: async (projectId) => suggestTestCommand(await projectRootFor(projectId)),
    // Auto's finish signal: the agent's own plan, read fresh after every turn. A missing or unreadable plan is no
    // plan — readPlan says so rather than throwing, which leaves the check as the thing to judge by.
    readPlan: async (projectId, conversationId) => readPlan(await projectRootFor(projectId), conversationId),
    // A second model reads the plan against the task and KAI writes what it named. Nothing is removed, and a review
    // that cannot run — no connection, a refusal, a daft reply — leaves the plan exactly as the agent set it.
    reviewPlan: async (projectId, conversationId, request) => {
      const root = await projectRootFor(projectId);
      const plan = await readPlan(root, conversationId);
      if (!plan || plan.items.length === 0) return null;
      const review = await planReviewer.review(request, plan).catch(() => null);
      if (!review || review.missing.length === 0) return [];
      const merged = mergePlanItems(plan.items, review.missing);
      const added = merged.slice(plan.items.length);
      await writePlan(root, conversationId, merged, new Date().toISOString()).catch(() => undefined);
      return added;
    },
    checkCoverage: async (projectId, command, changedFiles) => {
      const root = await projectRootFor(projectId);
      const sources = changedFiles.filter(isSourceNeedingCoverage).slice(0, 20);
      const tested = new Map<string, boolean>();
      for (const file of sources) tested.set(file, await testNamedFor(root, file).catch(() => false));
      return coverageNote(command, changedFiles, (file) => tested.get(file) ?? false);
    },
    capability: async () => {
      const capability = await directApi.capability();
      return { available: capability.available, name: capability.displayName, model: capability.model ?? null };
    },
    setPacer: (pacer) => directApi.setPacer(pacer),
    // Auto always gives its conversation a tab: it is the one the run is working in, and a split's remainder needs
    // somewhere of its own to carry on.
    openConversation: (ownerWindowId, conversation) => openConversationInWindow(ownerWindowId, conversation, true),
    openNewTab: (ownerWindowId, conversation) => openConversationInWindow(ownerWindowId, conversation, true),
    announce: (ownerWindowId, status) => desktopWindows.send(ownerWindowId, 'auto:changed', status),
    now: () => Date.now(),
  }, new AutoWindowStore(path.join(paths.root, 'auto-windows.json')), architect.coach);
  ipcContext.auto = auto;
  ipcContext.architect = architect;
  ipcContext.architectReadiness = architectReadiness;
  desktopShell = shell;

  await importLocalCognitive1Brain(ipcContext, kaiRoot);
  // Started once the context is complete: the first pass waits a little so it does not race the app's own startup.
  mirrorLoop.start();
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
  if (!startupJobFile) {
    const launchIntent = launchIntentFromArgv(process.argv);
    await createMainWindow(launchIntent?.kind === 'project' ? launchIntent.projectId : undefined);
  }
  refreshJumpList();
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
  const approveWithOverwatch = async (): Promise<void> => {
    if (overwatchApprovalBusy || quitting) return;
    overwatchApprovalBusy = true;
    try {
      const current = await settings.load();
      if (!current.cognitive1.enabled || !current.cognitive1.overwatch.enabled || !current.cognitive1.overwatch.autoApprove) return;
      const service = (await serviceController!.status()).find((entry) => entry.kind === 'cognitive1');
      if (service?.status !== 'ready') return;
      const result = await cognitive1.operation({ operation: 'brain-drafts', payload: {} });
      const drafts = Array.isArray(result) ? result : result && typeof result === 'object' && 'drafts' in result ? result.drafts : null;
      if (!Array.isArray(drafts) || drafts.length === 0) return;
      await cognitive1.operation({ operation: 'overwatch-resolve', payload: {} });
      logger.info('internal', `Overwatch automatically reviewed ${drafts.length} draft(s)`);
    } catch (error) {
      logger.warn('internal', 'Automatic Overwatch approval could not run', messageOf(error));
    } finally { overwatchApprovalBusy = false; }
  };
  overwatchApprovalTimer = setInterval(() => void approveWithOverwatch(), 15 * 60_000);
  overwatchApprovalTimer.unref();
  // A route whose window has closed is put back, and a route a crashed session left behind is repaired once at
  // startup. Both are silent on the happy path and report through the log when they are not.
  routeHousekeepingTimer = setInterval(() => {
    void proxyRouting.revertExpiredRoutes().then((reverted) => {
      for (const agent of reverted) logger.info('internal', `Put ${agent} back to its own provider: its timed route ran out`);
    }).catch((error) => logger.warn('internal', 'Could not revert a timed proxy route', messageOf(error)));
  }, 60_000);
  routeHousekeepingTimer.unref();
  void proxyRouting.repairRoutesAtStartup().then((repaired) => {
    for (const agent of repaired) logger.info('internal', `Repaired the ${agent} route left over from a previous session`);
  }).catch((error) => logger.warn('internal', 'Could not repair leftover proxy routes', messageOf(error)));
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
    icon: appIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#08111f',
      symbolColor: '#d8e2f0',
      // The title bar is 38px tall (workspace-polish.css); a taller overlay leaves a block of a different colour under it.
      height: 38,
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
  refreshJumpList();

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
    if (desktopShell?.hideOnClose()) {
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
    // The window that just went may have been the only one on screen, with another left hidden behind it. Closing
    // the visible one fires no `window-all-closed` in that case, so the shell is asked directly.
    desktopShell?.windowVisibilityChanged();
  });
  window.on('hide', () => { desktopShell?.windowVisibilityChanged(); });
  window.on('show', () => { desktopShell?.windowVisibilityChanged(); });
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
  // Team sessions discover peers through secure signaling relays; project data travels over WebRTC.
  const connectSources = devUrl ? `${devUrl} ws://localhost:* http://localhost:* wss:` : "'self' http://127.0.0.1:* wss:";
  const scriptSources = devUrl ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  const policy = [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `frame-src ${MOCKUP_SCHEME}:`,
    "font-src 'self'",
    "worker-src 'self' blob:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  protocol.handle(MOCKUP_SCHEME, (request) => serveMockup(request.url));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // A mockup keeps the stricter-by-design policy it was served with, not the app's.
    if (details.url.startsWith(`${MOCKUP_SCHEME}:`)) { callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [MOCKUP_CSP] } }); return; }
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
