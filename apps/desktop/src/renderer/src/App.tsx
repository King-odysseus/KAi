import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type {
  AgentCapability,
  AgentId,
  AutonomyMode,
  BootstrapPayload,
  ConversationRecord,
  ContextPreview,
  CredentialStatus,
  DirectApiCapability,
  ExecutionMode,
  LogEntry,
  RouteMode,
  SettingsUpdate,
} from '@kai/contracts';
import { ConversationSidebar, NavigationRail, navigation, TitleBar } from './components/Chrome';
import { HistoryView, ProjectsView, ServiceView, WorkflowsView } from './components/Pages';
import { BrainPanel } from './components/BrainView';
import { ProxyPanel } from './components/ProxyView';
import { SettingsView } from './components/SettingsView';
import { ContextPanel, WorkspaceView } from './components/Workspace';
import { clamp, unwrap, type ViewId } from './types';

const emptyCredentials: CredentialStatus = { available: false, ids: [] };

interface PendingApproval {
  conversationId: string;
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  tool?: string;
}

export function App(): ReactNode {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus>(emptyCredentials);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapability[]>([]);
  const [directApiCapability, setDirectApiCapability] = useState<DirectApiCapability | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreview | null>(null);
  const [contextPreviewLoading, setContextPreviewLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('codex');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('cli');
  const [selectedRoute, setSelectedRoute] = useState<RouteMode>('direct');
  const [selectedAutonomy, setSelectedAutonomy] = useState<AutonomyMode>('ask');
  const [view, setView] = useState<ViewId>('workspace');
  const [contextOpen, setContextOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [contextWidth, setContextWidth] = useState(286);
  const [resizing, setResizing] = useState<'sidebar' | 'context' | null>(null);
  const [busy, setBusy] = useState('Starting KAI');
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const resizeOrigin = useRef<{ kind: 'sidebar' | 'context'; x: number; width: number } | null>(null);

  const activeProject = bootstrap?.projects.find((project) => project.id === bootstrap.activeProjectId) ?? null;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  useEffect(() => {
    if (!activeProject) {
      setContextPreview(null);
      setContextPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setContextPreviewLoading(true);
    void window.kaiDesktop
      .previewContext({
        projectId: activeProject.id,
        ...(activeConversation ? { conversationId: activeConversation.id } : {}),
      })
      .then(unwrap)
      .then((preview) => {
        if (!cancelled) setContextPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setContextPreview(null);
      })
      .finally(() => {
        if (!cancelled) setContextPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, activeConversation?.id, activeConversation?.updatedAt, activeConversation?.events.length]);

  async function perform<T>(task: () => Promise<T>, message?: string): Promise<T | null> {
    if (message) setBusy(message);
    try {
      const result = await task();
      setError(null);
      return result;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function loadApplication(): Promise<void> {
    setBusy('Starting KAI');
    try {
      const [
        nextBootstrap,
        nextConversations,
        nextCredentials,
        nextLogs,
        nextAgentCapabilities,
        nextDirectApiCapability,
      ] = await Promise.all([
        window.kaiDesktop.bootstrap().then(unwrap),
        window.kaiDesktop.listConversations().then(unwrap),
        window.kaiDesktop.credentialStatus().then(unwrap),
        window.kaiDesktop.recentLogs(50).then(unwrap),
        window.kaiDesktop.agentCapabilities().then(unwrap),
        window.kaiDesktop.directApiCapability().then(unwrap),
      ]);
      setBootstrap(nextBootstrap);
      setConversations(nextConversations);
      setActiveConversationId((current) => current ?? nextConversations[0]?.id ?? null);
      setCredentials(nextCredentials);
      setLogs(nextLogs);
      setAgentCapabilities(nextAgentCapabilities);
      setDirectApiCapability(nextDirectApiCapability);
      setSelectedAgent(nextBootstrap.settings.defaultAgent);
      setExecutionMode('cli');
      setSelectedRoute('direct');
      setSelectedAutonomy(nextBootstrap.settings.defaultAutonomy);
      setAgentNotice(null);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadApplication();
  }, []);

  const servicesStarting = Boolean(
    bootstrap &&
    ((bootstrap.settings.cognitive1.enabled && serviceNeedsPolling(serviceFor(bootstrap, 'cognitive1').status)) ||
      (bootstrap.settings.proxy.enabled && serviceNeedsPolling(serviceFor(bootstrap, 'universalProxy').status))),
  );

  useEffect(() => {
    if (!servicesStarting) return;
    const timer = window.setInterval(() => {
      void window.kaiDesktop
        .serviceStatus()
        .then(unwrap)
        .then((services) => {
          setBootstrap((current) => (current ? { ...current, services } : current));
        })
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [servicesStarting]);

  useEffect(() => {
    if (!runningConversationId) return;
    return window.kaiDesktop.onAgentEvent(({ conversationId, event }) => {
      if (conversationId !== runningConversationId) return;
      if (event.type === 'text.delta' && event.channel === 'assistant') {
        setStreamingText((current) => current + event.text);
      }
      if (event.type === 'approval.request' && event.requestId) {
        setPendingApproval({
          conversationId,
          requestId: event.requestId,
          title: event.title,
          detail: event.detail,
          risk: event.risk,
          tool: event.tool,
        });
      }
    });
  }, [runningConversationId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setContextOpen((open) => !open);
        return;
      }
      const index = Number.parseInt(event.key, 10) - 1;
      const destination = navigation[index];
      if (destination) {
        event.preventDefault();
        setView(destination.id);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function chooseProject(): Promise<void> {
    const project = await perform(() => window.kaiDesktop.chooseProject().then(unwrap), 'Opening project');
    if (!project) return;
    const next = await perform(() => window.kaiDesktop.bootstrap().then(unwrap), 'Refreshing workspace');
    if (next) setBootstrap(next);
  }

  async function openProject(id: string): Promise<void> {
    const next = await perform(() => window.kaiDesktop.openProject(id).then(unwrap), 'Opening project');
    if (next) setBootstrap(next);
  }

  async function removeProject(id: string): Promise<void> {
    const next = await perform(() => window.kaiDesktop.removeProject(id).then(unwrap), 'Removing project');
    if (next) setBootstrap(next);
  }

  async function openConversation(id: string): Promise<void> {
    const existing = conversations.find((conversation) => conversation.id === id);
    if (existing) {
      setActiveConversationId(id);
      setSelectedAgent(existing.activeAgent ?? bootstrap?.settings.defaultAgent ?? 'codex');
      const mode = existing.execution ?? 'cli';
      setExecutionMode(mode);
      setSelectedRoute(mode === 'api' ? existing.route ?? bootstrap?.settings.defaultRoute ?? 'direct' : 'direct');
      setSelectedAutonomy(existing.autonomy ?? bootstrap?.settings.defaultAutonomy ?? 'ask');
      setView('workspace');
      return;
    }
    const conversation = await perform(
      () => window.kaiDesktop.getConversation(id).then(unwrap),
      'Loading conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== id)]);
    setActiveConversationId(id);
    setSelectedAgent(conversation.activeAgent ?? bootstrap?.settings.defaultAgent ?? 'codex');
    const mode = conversation.execution ?? 'cli';
    setExecutionMode(mode);
    setSelectedRoute(mode === 'api' ? conversation.route ?? bootstrap?.settings.defaultRoute ?? 'direct' : 'direct');
    setSelectedAutonomy(conversation.autonomy ?? bootstrap?.settings.defaultAutonomy ?? 'ask');
    setView('workspace');
  }

  async function createConversation(prompt: string): Promise<void> {
    if (!bootstrap || !activeProject) return;
    const conversation = await perform(
      () => window.kaiDesktop.createConversation(activeProject.id, prompt).then(unwrap),
      'Creating conversation',
    );
    if (!conversation) return;
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setView('workspace');
    await runConversation(conversation, prompt);
  }

  async function sendPrompt(prompt: string): Promise<void> {
    if (!bootstrap || !activeConversation) {
      await createConversation(prompt);
      return;
    }
    await runConversation(activeConversation, prompt);
  }

  async function runConversation(conversation: ConversationRecord, prompt: string): Promise<void> {
    if (!bootstrap) return;
    const apiRun = executionMode === 'api';
    const capability = agentCapabilities.find((agent) => agent.id === selectedAgent);
    if (!apiRun && !capability?.available) {
      setError(capability?.unavailableReason ?? `${selectedAgent} CLI is not available.`);
      return;
    }
    if (apiRun && !directApiCapability?.available) {
      setError(directApiCapability?.unavailableReason ?? 'Direct API mode is not available.');
      return;
    }

    setAgentNotice(null);
    setStreamingText('');
    setPendingApproval(null);
    setRunningConversationId(conversation.id);
    try {
      const result = await perform(
        () => window.kaiDesktop.runAgent({
          conversationId: conversation.id,
          prompt,
          agent: selectedAgent,
          execution: executionMode,
          route: apiRun ? selectedRoute : 'direct',
          autonomy: selectedAutonomy,
        }).then(unwrap),
        apiRun
          ? `${directApiCapability?.displayName} is working`
          : `${capability?.displayName} is working`,
      );
      if (!result) return;
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      if (result.error) setError(result.error);
    } finally {
      setRunningConversationId(null);
      setStreamingText('');
      setPendingApproval(null);
    }
  }

  async function cancelConversation(): Promise<void> {
    if (!runningConversationId) return;
    const cancelled = await perform(
      () => window.kaiDesktop.cancelAgent(runningConversationId).then(unwrap),
      'Stopping agent',
    );
    if (cancelled) {
      setPendingApproval(null);
      setAgentNotice('Stopping the current agent run.');
    }
  }

  async function respondToApproval(approved: boolean): Promise<void> {
    const approval = pendingApproval;
    if (!approval) return;
    setPendingApproval(null);
    await perform(
      () => window.kaiDesktop.respondToApproval({
        conversationId: approval.conversationId,
        requestId: approval.requestId,
        approved,
      }).then(unwrap),
      approved ? 'Approving project change' : 'Denying project change',
    );
  }

  async function refreshAgentCapabilities(): Promise<void> {
    const statuses = await perform(
      () => Promise.all([
        window.kaiDesktop.agentCapabilities().then(unwrap),
        window.kaiDesktop.directApiCapability().then(unwrap),
      ]),
      'Refreshing agent status',
    );
    if (!statuses) return;
    const [capabilities, apiCapability] = statuses;
    setAgentCapabilities(capabilities);
    setDirectApiCapability(apiCapability);
    if (executionMode === 'api') {
      setAgentNotice(apiCapability.available
        ? `${apiCapability.displayName} is ready.`
        : apiCapability.unavailableReason ?? 'Direct API status was refreshed.');
      return;
    }
    const selected = capabilities.find((agent) => agent.id === selectedAgent);
    setAgentNotice(selected?.available
      ? `${selected.displayName} is ready.`
      : selected?.unavailableReason ?? 'Agent status was refreshed.');
  }

  async function signInAgent(agent: AgentId): Promise<void> {
    const result = await perform(
      () => window.kaiDesktop.signInAgent(agent).then(unwrap),
      `Opening ${agent} sign-in`,
    );
    if (result) setAgentNotice(result.message);
  }

  async function deleteConversation(id: string): Promise<void> {
    const removed = await perform(() => window.kaiDesktop.deleteConversation(id).then(unwrap), 'Deleting conversation');
    if (removed === null) return;
    setConversations((current) => {
      const next = current.filter((conversation) => conversation.id !== id);
      if (activeConversationId === id) setActiveConversationId(next[0]?.id ?? null);
      return next;
    });
  }

  async function saveSettings(update: SettingsUpdate): Promise<void> {
    const settings = await perform(() => window.kaiDesktop.updateSettings(update).then(unwrap), 'Saving settings');
    if (settings) {
      const services = await window.kaiDesktop.serviceStatus().then(unwrap);
      setBootstrap((current) => (current ? { ...current, settings, services } : current));
      if (!activeConversation) setSelectedAgent(settings.defaultAgent);
      await refreshDirectApiStatus();
    }
  }

  async function refreshDirectApiStatus(): Promise<void> {
    try {
      setDirectApiCapability(await window.kaiDesktop.directApiCapability().then(unwrap));
    } catch {
      // The next explicit refresh will surface an error if the main process is unavailable.
    }
  }

  async function controlService(
    kind: 'cognitive1' | 'universalProxy',
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const request =
      action === 'start'
        ? window.kaiDesktop.startService(kind)
        : action === 'stop'
          ? window.kaiDesktop.stopService(kind)
          : window.kaiDesktop.restartService(kind);
    const services = await perform(
      () => request.then(unwrap),
      `${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} service`,
    );
    if (services) setBootstrap((current) => (current ? { ...current, services } : current));
  }

  async function copyServiceToken(kind: 'cognitive1' | 'universalProxy'): Promise<void> {
    await perform(() => window.kaiDesktop.copyServiceToken(kind).then(unwrap), 'Copying access token');
  }

  async function rotateServiceToken(kind: 'cognitive1' | 'universalProxy'): Promise<void> {
    const services = await perform(
      () => window.kaiDesktop.rotateServiceToken(kind).then(unwrap),
      'Rotating access token',
    );
    if (services) setBootstrap((current) => (current ? { ...current, services } : current));
  }

  async function saveCredential(id: string, value: string): Promise<void> {
    const status = await perform(() => window.kaiDesktop.setCredential(id, value).then(unwrap), 'Saving credential');
    if (status) {
      setCredentials(status);
      await refreshDirectApiStatus();
    }
  }

  async function clearCredential(id: string): Promise<void> {
    const status = await perform(() => window.kaiDesktop.clearCredential(id).then(unwrap), 'Removing credential');
    if (status) {
      setCredentials(status);
      await refreshDirectApiStatus();
    }
  }

  function beginResize(kind: 'sidebar' | 'context', event: ReactPointerEvent<HTMLDivElement>): void {
    const width = kind === 'sidebar' ? sidebarWidth : contextWidth;
    resizeOrigin.current = { kind, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(kind);
  }

  function continueResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const origin = resizeOrigin.current;
    if (!origin) return;
    const delta = event.clientX - origin.x;
    if (origin.kind === 'sidebar') setSidebarWidth(clamp(origin.width + delta, 190, 360));
    else setContextWidth(clamp(origin.width - delta, 230, 430));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeOrigin.current = null;
    setResizing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function renderCurrentView(): ReactNode {
    if (!bootstrap) return null;
    switch (view) {
      case 'projects':
        return (
          <ProjectsView
            projects={bootstrap.projects}
            activeProjectId={bootstrap.activeProjectId}
            onChoose={() => void chooseProject()}
            onOpen={(id) => void openProject(id)}
            onRemove={(id) => void removeProject(id)}
          />
        );
      case 'brain':
        return (
          <ServiceView
            service={serviceFor(bootstrap, 'cognitive1')}
            kind="brain"
            busy={Boolean(busy)}
            onConfigure={() => setView('settings')}
            onStart={() => void controlService('cognitive1', 'start')}
            onStop={() => void controlService('cognitive1', 'stop')}
            onRestart={() => void controlService('cognitive1', 'restart')}
            onCopyToken={() => void copyServiceToken('cognitive1')}
            onRotateToken={() => void rotateServiceToken('cognitive1')}
          >
            <BrainPanel service={serviceFor(bootstrap, 'cognitive1')} />
          </ServiceView>
        );
      case 'proxy':
        return (
          <ServiceView
            service={serviceFor(bootstrap, 'universalProxy')}
            kind="proxy"
            busy={Boolean(busy)}
            onConfigure={() => setView('settings')}
            onStart={() => void controlService('universalProxy', 'start')}
            onStop={() => void controlService('universalProxy', 'stop')}
            onRestart={() => void controlService('universalProxy', 'restart')}
            onCopyToken={() => void copyServiceToken('universalProxy')}
            onRotateToken={() => void rotateServiceToken('universalProxy')}
          >
            <ProxyPanel service={serviceFor(bootstrap, 'universalProxy')} />
          </ServiceView>
        );
      case 'workflows':
        return <WorkflowsView />;
      case 'history':
        return (
          <HistoryView
            conversations={conversations}
            activeId={activeConversationId}
            onOpen={(id) => void openConversation(id)}
          />
        );
      case 'settings':
        return (
          <SettingsView
            settings={bootstrap.settings}
            credentialStatus={credentials}
            dataLocations={bootstrap.dataLocations}
            logs={logs}
            busy={Boolean(busy)}
            onSave={(update) => void saveSettings(update)}
            onSaveCredential={(id, value) => void saveCredential(id, value)}
            onClearCredential={(id) => void clearCredential(id)}
          />
        );
      case 'workspace':
      default:
        return (
          <WorkspaceView
            activeProject={activeProject}
            activeConversation={activeConversation}
            settings={bootstrap.settings}
            busy={Boolean(busy)}
            agentCapabilities={agentCapabilities}
            directApiCapability={directApiCapability}
            selectedAgent={selectedAgent}
            executionMode={executionMode}
            selectedRoute={selectedRoute}
            selectedAutonomy={selectedAutonomy}
            proxyReady={serviceFor(bootstrap, 'universalProxy').status === 'ready'}
            streamingText={streamingText}
            pendingApproval={pendingApproval}
            running={runningConversationId === activeConversation?.id}
            notice={agentNotice}
            onSelectExecution={(mode) => {
              setExecutionMode(mode);
              if (mode === 'cli') setSelectedRoute('direct');
              setAgentNotice(null);
            }}
            onSelectAgent={(agent) => {
              setSelectedAgent(agent);
              setAgentNotice(null);
            }}
            onSelectRoute={(route) => {
              setSelectedRoute(route);
              setAgentNotice(null);
            }}
            onSelectAutonomy={(autonomy) => {
              setSelectedAutonomy(autonomy);
              setAgentNotice(null);
            }}
            onChooseProject={() => void chooseProject()}
            onCreateConversation={(prompt) => void createConversation(prompt)}
            onSend={(prompt) => void sendPrompt(prompt)}
            onCancel={() => void cancelConversation()}
            onApprovalResponse={(approved) => void respondToApproval(approved)}
            onSignIn={(agent) => void signInAgent(agent)}
            onRefreshAgents={() => void refreshAgentCapabilities()}
            onOpenSettings={() => setView('settings')}
          />
        );
    }
  }

  if (!bootstrap) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">K</div>
        <h1>KAI</h1>
        <p>{error ?? busy ?? 'Preparing workspace'}</p>
        {error && (
          <button type="button" className="primary-button" onClick={() => void loadApplication()}>
            <RefreshCw size={15} />
            <span>Retry</span>
          </button>
        )}
      </div>
    );
  }

  const showThreads = view === 'workspace';
  const showContext = view === 'workspace' && contextOpen;

  return (
    <div className={`app-shell ${resizing ? 'is-resizing' : ''}`}>
      <TitleBar
        projects={bootstrap.projects}
        activeProject={activeProject}
        rightOpen={contextOpen}
        onChoose={() => void chooseProject()}
        onOpenProject={(id) => void openProject(id)}
        onToggleContext={() => setContextOpen((open) => !open)}
      />
      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button
            type="button"
            className="icon-button compact"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="app-body">
        <NavigationRail
          view={view}
          version={`v${bootstrap.version}`}
          serviceStatus={serviceFor(bootstrap, 'universalProxy').status}
          onChange={setView}
        />
        {showThreads && (
          <>
            <div className="conversation-column" style={{ width: sidebarWidth }}>
              <ConversationSidebar
                conversations={conversations}
                activeId={activeConversationId}
                onOpen={(id) => void openConversation(id)}
                onDelete={(id) => void deleteConversation(id)}
                onNew={() => {
                  setActiveConversationId(null);
                  setSelectedAgent(bootstrap.settings.defaultAgent);
                  setExecutionMode('cli');
                  setStreamingText('');
                  setView('workspace');
                }}
              />
            </div>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize conversations"
              aria-orientation="vertical"
              onPointerDown={(event) => beginResize('sidebar', event)}
              onPointerMove={continueResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          </>
        )}
        <main className={`app-main view-${view}`}>{renderCurrentView()}</main>
        {showContext && (
          <>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize context panel"
              aria-orientation="vertical"
              onPointerDown={(event) => beginResize('context', event)}
              onPointerMove={continueResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
            <div className="context-column" style={{ width: contextWidth }}>
              <ContextPanel
                activeProject={activeProject}
                conversation={activeConversation}
                services={bootstrap.services}
                contextPreview={contextPreview}
                contextPreviewLoading={contextPreviewLoading}
              />
            </div>
          </>
        )}
      </div>
      {busy && (
        <div className="busy-indicator" role="status">
          <span />
          {busy}
        </div>
      )}
    </div>
  );
}

function serviceFor(bootstrap: BootstrapPayload, kind: 'cognitive1' | 'universalProxy') {
  return (
    bootstrap.services.find((service) => service.kind === kind) ?? {
      kind,
      status: 'not_configured' as const,
      detail: 'Service status is unavailable.',
      endpoint: null,
      version: null,
      updatedAt: new Date().toISOString(),
    }
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'KAI encountered an unexpected error.';
}

function serviceNeedsPolling(status: string): boolean {
  return status === 'starting' || status === 'stopped';
}
