// Universal Agent Proxy dashboard. Mirrors the ClaudeCode-Proxy VS Code extension's "Proxy Control
// Centre" (dashboard.html): the same header, the same five tabs, and the same sections in each tab.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AppSettings,
  CredentialStatus,
  LogEntry,
  ProxyAgentId,
  ProxyAgentRoute,
  ProxyCostSummary,
  ProxyHistoryDetail,
  ProxyHistorySummary,
  ProxyLiveEvent,
  ProxyModel,
  ProxyOverview,
  ProxyPingResult,
  ProxyReplayPreview,
  ProxyReplayResult,
  ProxyRoutingAction,
  ProxyRoutingResult,
  ServiceState,
} from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { AdvancedTab, AgentsTab, KeyField, ModelSelect, ProvidersTab } from './ProxySettingsPanel';
import {
  AGENTS,
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MARKS,
  OVERVIEW_AGENTS,
  PROVIDER_LABELS,
  agentCredentialId,
  agentProviderKey,
  agentUpstream,
  applyAgentModel,
  applyAgentProvider,
  backendKey,
  hostLabel,
  presetsFor,
  type ProxySettings,
} from './proxy-dashboard-data';

type ProxyTab = 'overview' | 'agents' | 'providers' | 'traffic' | 'advanced';
type StatusFilter = '' | '2xx' | '4xx' | '5xx';
type CostPeriod = 'session' | 'daily' | 'weekly' | 'monthly';

interface HistoryFilters {
  search: string;
  agent: '' | ProxyAgentId;
  status: StatusFilter;
}

const tabs: Array<{ id: ProxyTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'providers', label: 'Providers' },
  { id: 'traffic', label: 'Traffic & costs' },
  { id: 'advanced', label: 'Advanced' },
];

const initialFilters: HistoryFilters = { search: '', agent: '', status: '' };
const historyLimit = 25;

const PILL_TITLES: Record<string, string> = {
  proxy: 'Route configured — use Verify to confirm it',
  repair: 'Local URL does not match this proxy — click Route to rewrite',
  direct: 'Using direct provider URL',
  unavailable: 'Agent not installed',
};

export function ProxyPanel({
  service,
  settings,
  busy,
  logs,
  credentialStatus,
  onSave,
  onSaveCredential,
  onClearCredential,
  onReload,
  onStart,
  onStop,
  onRestart,
  onCopyToken,
  onRotateToken,
}: {
  service: ServiceState;
  settings: AppSettings;
  busy: boolean;
  logs: LogEntry[];
  credentialStatus: CredentialStatus;
  onSave: (update: { proxy: AppSettings['proxy'] }) => Promise<boolean | void> | void;
  onSaveCredential: (id: string, value: string) => Promise<boolean | void> | void;
  onClearCredential: (id: string) => Promise<boolean | void> | void;
  onReload: () => Promise<void>;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onCopyToken: () => void;
  onRotateToken: () => void;
}): ReactNode {
  const [tab, setTab] = useState<ProxyTab>('overview');
  const [draft, setDraft] = useState<ProxySettings>(settings.proxy);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [openAgentSection, setOpenAgentSection] = useState<ProxyAgentId | null>(null);
  const [overview, setOverview] = useState<ProxyOverview | null>(null);
  const [routes, setRoutes] = useState<ProxyAgentRoute[]>([]);
  const [models, setModels] = useState<ProxyModel[]>([]);
  const [history, setHistory] = useState<ProxyHistorySummary[]>([]);
  const [filters, setFilters] = useState<HistoryFilters>(initialFilters);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProxyHistoryDetail | null>(null);
  const [replayPreview, setReplayPreview] = useState<ProxyReplayPreview | null>(null);
  const [replayResult, setReplayResult] = useState<ProxyReplayResult | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [historyClearArmed, setHistoryClearArmed] = useState(false);
  const [costClearArmed, setCostClearArmed] = useState(false);
  const [claudeResetArmed, setClaudeResetArmed] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const [liveFilter, setLiveFilter] = useState('');
  const [liveEvents, setLiveEvents] = useState<Array<{ id: number; event: ProxyLiveEvent }>>([]);
  const [pingResults, setPingResults] = useState<ProxyPingResult[]>([]);
  const [costPeriod, setCostPeriod] = useState<CostPeriod>('session');
  const [costSummary, setCostSummary] = useState<ProxyCostSummary | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [dryRunBody, setDryRunBody] = useState(() => JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Reply with one sentence.' }],
  }, null, 2));
  const [dryRunResult, setDryRunResult] = useState<unknown>(null);

  const ready = service.status === 'ready';
  const running = service.status === 'ready' || service.status === 'starting' || service.status === 'degraded';
  const working = busy || Boolean(action);
  const loginMode = !settings.proxy.enabled;

  useEffect(() => {
    setDraft(settings.proxy);
  }, [settings.proxy]);

  useEffect(() => window.kaiDesktop.onProxyLiveEvent((event) => {
    setLiveEvents((current) => [...current.slice(-199), { id: Date.now() + Math.random(), event }]);
  }), []);

  useEffect(() => () => {
    void window.kaiDesktop.stopProxyLiveTail().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ready) {
      setOverview(null);
      setRoutes([]);
      setModels([]);
      setHistory([]);
      setDetail(null);
      setSelectedId(null);
      return;
    }
    let active = true;
    void Promise.all([
      window.kaiDesktop.proxyOverview().then(unwrap),
      window.kaiDesktop.proxyRoutes().then(unwrap),
      window.kaiDesktop.proxyModels().then(unwrap),
      loadHistory(initialFilters, 1),
    ])
      .then(([nextOverview, nextRoutes, nextModels, nextHistory]) => {
        if (!active) return;
        setOverview(nextOverview);
        setRoutes(nextRoutes);
        setModels(nextModels);
        setHistory(nextHistory);
        setFilters(initialFilters);
        setPage(1);
        setError(null);
      })
      .catch((caught) => { if (active) setError(messageOf(caught)); });
    return () => { active = false; };
  }, [ready, service.updatedAt]);

  useEffect(() => {
    if (!ready || costPeriod === 'session') {
      setCostSummary(null);
      setCostLoading(false);
      return;
    }
    let active = true;
    setCostLoading(true);
    void window.kaiDesktop.proxyCostSummary(costPeriod)
      .then(unwrap)
      .then((summary) => { if (active) setCostSummary(summary); })
      .catch((caught) => { if (active) setError(messageOf(caught)); })
      .finally(() => { if (active) setCostLoading(false); });
    return () => { active = false; };
  }, [ready, service.updatedAt, costPeriod]);

  function patch(update: Partial<ProxySettings>): void {
    setSavedSection(null);
    setDraft((current) => ({ ...current, ...update }));
  }

  /** Save the whole draft, as each Save button in the extension does. */
  function save(section: string, next: ProxySettings = draft): void {
    setDraft(next);
    setError(null);
    void Promise.resolve(onSave({ proxy: next }))
      .then((ok) => { if (ok !== false) setSavedSection(section); })
      .catch((caught) => setError(messageOf(caught)));
  }

  function saveAgentKey(agent: ProxyAgentId, value: string): void {
    const credentialId = agentCredentialId(draft, agent);
    if (agent !== 'claude') {
      const field = backendKey(agent);
      if (!draft[field].credentialId) save(`key:${agent}`, { ...draft, [field]: { ...draft[field], credentialId } });
    }
    void Promise.resolve(onSaveCredential(credentialId, value)).catch((caught) => setError(messageOf(caught)));
  }

  async function run<T>(label: string, task: () => Promise<T>): Promise<T | null> {
    setAction(label);
    setNotice(null);
    try {
      const result = await task();
      setError(null);
      return result;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setAction(null);
    }
  }

  async function refreshCore(announce = false): Promise<void> {
    if (!ready) return;
    const result = await run('refresh', async () => Promise.all([
      window.kaiDesktop.proxyOverview().then(unwrap),
      window.kaiDesktop.proxyRoutes().then(unwrap),
      window.kaiDesktop.proxyModels().then(unwrap),
      loadHistory(filters, page),
    ]));
    if (!result) return;
    const [nextOverview, nextRoutes, nextModels, nextHistory] = result;
    setOverview(nextOverview);
    setRoutes(nextRoutes);
    setModels(nextModels);
    setHistory(nextHistory);
    if (announce) setNotice('Proxy data refreshed.');
  }

  async function routeAction(agent: ProxyAgentId, nextAction: ProxyRoutingAction, routeUntil?: number): Promise<void> {
    const result = await run(`${agent}:${nextAction}`, () =>
      window.kaiDesktop.routeProxyAgent(agent, nextAction, routeUntil).then(unwrap),
    );
    if (!result) return;
    await onReload();
    await refreshCore();
    setNotice(routingNotice(result));
  }

  async function routeEvery(nextAction: 'route' | 'direct'): Promise<void> {
    const results = await run(nextAction === 'route' ? 'route-all' : 'direct-all', async () => {
      const next: ProxyRoutingResult[] = [];
      for (const agent of AGENTS) next.push(await window.kaiDesktop.routeProxyAgent(agent, nextAction).then(unwrap));
      return next;
    });
    if (!results) return;
    await onReload();
    await refreshCore();
    const allOk = results.every((result) => result.success);
    setActionResult(nextAction === 'route'
      ? allOk ? 'Every supported agent is routed through the proxy.' : 'One or more agent route changes failed.'
      : allOk ? 'Every supported agent is back on native/direct routing.' : 'One or more agents could not be restored to Direct mode.');
  }

  async function testConnection(): Promise<void> {
    const result = await run('test-connection', () => window.kaiDesktop.testProxyConnection().then(unwrap));
    if (!result) return;
    setActionResult(result.ok ? `✓ Upstream connection succeeded (${result.status ?? 200}).` : `✕ Connection failed: ${result.error ?? 'unknown error'}`);
  }

  async function pingAll(): Promise<void> {
    const result = await run('ping-all', () => window.kaiDesktop.pingProxyProviders().then(unwrap));
    if (!result) return;
    setPingResults(result);
    setActionResult(`${result.filter((item) => item.ok).length}/${result.length} providers responded.`);
  }

  async function clearCosts(): Promise<void> {
    setCostClearArmed(false);
    const result = await run('clear-costs', () => window.kaiDesktop.clearProxyCosts().then(unwrap));
    if (!result) return;
    setNotice(`Cleared ${result.cleared} costed calls.`);
    await refreshCore();
  }

  async function clearHistory(): Promise<void> {
    setHistoryClearArmed(false);
    const result = await run('clear-history', () => window.kaiDesktop.clearProxyHistory().then(unwrap));
    if (!result) return;
    setHistory([]);
    setDetail(null);
    setSelectedId(null);
    setNotice(`Cleared ${result.cleared} history ${result.cleared === 1 ? 'entry' : 'entries'}.`);
    await refreshCore();
  }

  async function searchHistory(event?: FormEvent<HTMLFormElement>, next: HistoryFilters = filters): Promise<void> {
    event?.preventDefault();
    setHistoryLoading(true);
    setSelectedId(null);
    setDetail(null);
    setReplayPreview(null);
    setReplayResult(null);
    try {
      setHistory(await loadHistory(next, 1));
      setPage(1);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setHistoryLoading(false);
    }
  }

  function updateFilters(update: Partial<HistoryFilters>): void {
    const next = { ...filters, ...update };
    setFilters(next);
    if (update.agent !== undefined || update.status !== undefined) void searchHistory(undefined, next);
  }

  async function changePage(nextPage: number): Promise<void> {
    if (nextPage < 1) return;
    setHistoryLoading(true);
    try {
      setHistory(await loadHistory(filters, nextPage));
      setPage(nextPage);
      setSelectedId(null);
      setDetail(null);
      setReplayPreview(null);
      setReplayResult(null);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function inspect(id: string): Promise<void> {
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(id);
    setDetailLoading(true);
    setReplayPreview(null);
    setReplayResult(null);
    try {
      setDetail(await window.kaiDesktop.proxyHistoryDetail(id).then(unwrap));
      setError(null);
    } catch (caught) {
      setDetail(null);
      setError(messageOf(caught));
    } finally {
      setDetailLoading(false);
    }
  }

  async function previewReplay(): Promise<void> {
    if (!detail) return;
    const preview = await run('replay-preview', () => window.kaiDesktop.previewProxyReplay(detail.id).then(unwrap));
    if (!preview) return;
    setReplayPreview(preview);
    setReplayResult(null);
  }

  async function runReplay(): Promise<void> {
    if (!detail) return;
    const previewText = replayPreview ? JSON.stringify(replayPreview, null, 2).slice(0, 1_500) : '{}';
    if (!(await confirmDialog({
      title: 'Replay this request?',
      detail: `Replay ${detail.requestMethod} ${detail.requestPath} using the current credential and route?\n\nThis sends a real request to the upstream provider and may be billed to your API account.\n\n${previewText}`,
      confirmLabel: 'Send replay',
    }))) return;
    const result = await run('replay', () => window.kaiDesktop.replayProxyRequest(detail.id).then(unwrap));
    if (!result) return;
    setReplayResult(result);
  }

  async function toggleLive(): Promise<void> {
    if (liveActive) {
      await window.kaiDesktop.stopProxyLiveTail().then(unwrap).catch(() => false);
      setLiveActive(false);
      return;
    }
    setLiveEvents([]);
    setLivePaused(false);
    const started = await run('live-tail', () => window.kaiDesktop.startProxyLiveTail().then(unwrap));
    if (started) setLiveActive(true);
  }

  function exportHistory(): void {
    const blob = new Blob([`${JSON.stringify(history, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'kai-proxy-history.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function openClaudeSettings(): Promise<void> {
    const result = await run('open-claude-settings', () => window.kaiDesktop.openClaudeSettings().then(unwrap));
    if (result) setNotice(result.detail);
  }

  async function resetClaude(): Promise<void> {
    if (!claudeResetArmed) {
      setClaudeResetArmed(true);
      return;
    }
    setClaudeResetArmed(false);
    const result = await run('reset-claude', () => window.kaiDesktop.resetClaudeCode().then(unwrap));
    if (!result) return;
    const summary = [
      result.settingsUpdated ? 'settings cleaned' : 'settings unchanged',
      `${result.sessionsRemoved} sessions removed`,
      `${result.processesStopped} processes stopped`,
      result.credentialsCleared ? 'credentials cleared' : 'credentials unchanged',
      result.onboardingReset ? 'onboarding reset' : 'onboarding unchanged',
    ].join(' · ');
    setNotice(`Claude Code reset complete: ${summary}.${result.warnings.length ? ` ${result.warnings.length} warning(s).` : ''}`);
    await onReload();
    await refreshCore();
  }

  async function dryRun(): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(dryRunBody) as unknown;
    } catch {
      setError('Dry-run body must be valid JSON.');
      return;
    }
    const result = await run('dry-run', () => window.kaiDesktop.dryRunProxy(body).then(unwrap));
    if (result) setDryRunResult(result);
  }

  async function copyEnv(agent: ProxyAgentId): Promise<void> {
    const result = await run(`copy-env:${agent}`, () => window.kaiDesktop.copyProxyEnv(agent).then(unwrap));
    if (result) setNotice(`Copied ${result.value}`);
  }

  async function launchAgent(agent: 'claude' | 'codex'): Promise<void> {
    const result = await run(`launch:${agent}`, () => window.kaiDesktop.launchProxyAgent(agent).then(unwrap));
    if (!result) return;
    setNotice(result.detail);
    await refreshCore();
  }

  async function transfer(direction: 'export' | 'import'): Promise<void> {
    const result = await run(direction, () => (
      direction === 'export' ? window.kaiDesktop.exportProxyConfig() : window.kaiDesktop.importProxyConfig()
    ).then(unwrap));
    if (!result || result.canceled) return;
    await onReload();
    setNotice(direction === 'export' ? `Exported proxy settings to ${result.path}` : `Imported proxy settings from ${result.path}`);
  }

  async function copyDiagnostics(): Promise<void> {
    const text = [
      `Universal Agent Proxy (UAP) v${service.version ?? '?'}`,
      `KAI Desktop`,
      `Platform: ${navigator.platform}`,
      '',
      '--- Config ---',
      `Enabled: ${settings.proxy.enabled}`,
      `Port: ${settings.proxy.port}`,
      `Base URL: ${settings.proxy.targetBaseUrl || '(not set)'}`,
      `API Key: ${credentialStatus.ids.includes(settings.proxy.credentialId) ? '✓ set' : '✗ not set'} (${settings.proxy.credentialId})`,
      `Default Model: ${settings.proxy.defaultModel || '(not set)'}`,
      '',
      '--- Status ---',
      `Proxy: ${service.status}`,
      `Endpoint: ${service.endpoint ?? 'none'}`,
      ...routes.map((route) => `${AGENT_LABELS[route.agentId]}: ${route.route}${route.installed ? '' : ' (not installed)'}`),
      '',
      '--- Recent Logs ---',
      ...logs.slice(-30).map((entry) => `${entry.timestamp} ${entry.severity} ${entry.category}: ${entry.message}`),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setNotice('Diagnostic info copied to clipboard.');
  }

  async function enterLoginMode(): Promise<void> {
    if (!(await confirmDialog({
      title: 'Enter Claude Login Mode?',
      detail: 'Claude Login Mode disables the proxy and restores Claude Code to its native login path.',
      confirmLabel: 'Enter Login Mode',
    }))) return;
    await onSave({ proxy: { ...settings.proxy, enabled: false, routeClaudeCode: false, routeClaudeCodeUntil: 0 } });
    await routeAction('claude', 'direct');
  }

  async function restoreProxy(): Promise<void> {
    await onSave({ proxy: { ...settings.proxy, enabled: true, routeClaudeCode: true, routeClaudeCodeUntil: 0 } });
    await routeAction('claude', 'route');
  }

  function configureAgent(agent: ProxyAgentId): void {
    setOpenAgentSection(agent);
    setTab('agents');
  }

  const chip = statusChip(service);
  const mainRoute = `${hostLabel(service.endpoint ?? `http://127.0.0.1:${settings.proxy.port}`)} → ${hostLabel(settings.proxy.targetBaseUrl)} · ${settings.proxy.defaultModel || 'model mapping'}`;
  const configProps = {
    draft,
    patch,
    save,
    savedSection,
    busy: working,
    credentialStatus,
    onSaveCredential,
    onClearCredential,
  };

  return (
    <section className="uap proxy-control-centre">
      <div className="header">
        <div className="header-copy">
          <h1>Proxy Control Centre</h1>
          <span className="header-subtitle">Route, inspect, and manage every coding agent from one place.</span>
        </div>
        <span className={`status-chip ${chip.tone}`} role="status" aria-live="polite"><span aria-hidden="true">{chip.glyph}</span><span>{chip.label}</span></span>
        <div className="header-btns">
          <button type="button" className="btn sec" title="Reload dashboard" disabled={working || !ready} onClick={() => void refreshCore(true)}>↺ Refresh</button>
          <button type="button" className="btn sec" title="Restart the proxy server" disabled={busy || !running} onClick={onRestart}>Restart</button>
          {running
            ? <button type="button" className="btn sec" disabled={busy} onClick={onStop}>Stop</button>
            : <button type="button" className="btn" disabled={busy} onClick={onStart}>Start</button>}
        </div>
      </div>

      <nav className="dashboard-tabs" role="tablist" aria-label="Dashboard sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={`dashboard-tab ${tab === item.id ? 'active' : ''}`}
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {notice && <Notice tone="ok" onDismiss={() => setNotice(null)}>{notice}</Notice>}
      {error && <Notice tone="err" title="Proxy operation failed" onDismiss={() => setError(null)}>{error}</Notice>}
      {action && <p className="hint" role="status" style={{ margin: '-6px 0 12px' }}>{actionLabel(action)}…</p>}

      {tab === 'overview' && (
        <div role="tabpanel" aria-label="Overview">
          {!ready && (
            <Notice tone="warn" title={service.status === 'starting' ? 'Proxy is starting' : 'Proxy is not running'}>
              {service.detail}
            </Notice>
          )}
          <section className="section overview-hero">
            <div className="eyebrow">Effective routing</div>
            <div className="hero-row">
              <div>
                <div className="hero-title">{ready ? 'Proxy online and ready to route' : service.status === 'failed' ? 'Proxy needs attention' : `Proxy is currently ${chip.label.toLowerCase()}`}</div>
                <p className="hero-copy">
                  {ready
                    ? 'Cards show saved route configuration. Test Connection verifies the upstream; restart an already-open agent after changing its route.'
                    : 'Start the proxy before routing agents. Existing native subscriptions remain available while an agent is Direct.'}
                </p>
              </div>
              <div className="hero-route">
                <div className="hero-route-label">Main proxy route</div>
                <div className="hero-route-value">{mainRoute}</div>
              </div>
            </div>
          </section>

          <div className="agent-grid">
            {OVERVIEW_AGENTS.map((agent) => (
              <AgentCard
                key={agent}
                agent={agent}
                route={routes.find((candidate) => candidate.agentId === agent)}
                draft={draft}
                ready={ready}
                busy={working}
                credentialStatus={credentialStatus}
                onSaveKey={(value) => saveAgentKey(agent, value)}
                onProvider={(key) => {
                  if (key === 'custom') {
                    configureAgent(agent);
                    return;
                  }
                  save(`card:${agent}`, applyAgentProvider(draft, agent, key));
                }}
                onModel={(model) => save(`card:${agent}`, applyAgentModel(draft, agent, model))}
                onRoute={(hours) => void routeAction(agent, 'route', hours ? Date.now() + hours * 60 * 60 * 1000 : undefined)}
                onDirect={() => void routeAction(agent, 'direct')}
                onVerify={() => void routeAction(agent, 'verify')}
                onRollback={() => void routeAction(agent, 'rollback')}
                onLaunch={() => void launchAgent(agent === 'codex' ? 'codex' : 'claude')}
                onConfigure={() => configureAgent(agent)}
              />
            ))}
          </div>

          <section className="section">
            <div className="section-title-row"><h2>Quick actions</h2><span className="hint" role="status" aria-live="polite" style={{ margin: 0 }} /></div>
            <div className="quick-actions">
              <button type="button" className="btn" disabled={working} onClick={() => void routeEvery('route')}>Route all</button>
              <button type="button" className="btn sec" disabled={working} onClick={() => void routeEvery('direct')}>Direct all</button>
              <button type="button" className="btn sec" disabled={working || !ready} onClick={() => void testConnection()}>Test connection</button>
              <button type="button" className="btn sec" disabled={working || !ready} onClick={() => void pingAll()}>Ping all providers</button>
              <button type="button" className="btn sec" onClick={() => setTab('traffic')}>View traffic</button>
            </div>
            <p className="hint" role="status" aria-live="polite" style={{ margin: '8px 0 0', minHeight: '1.2em' }}>{actionResult}</p>
          </section>

          <section className="section">
            <h2>Diagnostics</h2>
            <p className="hint lead">Routing controls live on the agent cards above. This panel holds the raw proxy log, provider pings, and live performance numbers.</p>
            {pingResults.length > 0 && (
              <div className="ping-list" role="status" aria-live="polite">
                {pingResults.map((result) => (
                  <div key={`${result.provider}-${result.label}`}>
                    <span className={result.ok ? 'ok-text' : 'err-text'}>{result.ok ? '✓' : '✕'}</span>{' '}
                    <strong>{result.label || result.provider}</strong> · {result.status ?? 'no status'} · {formatLatency(result.latencyMs)}
                    {result.error ? ` · ${result.error}` : ''}
                  </div>
                ))}
              </div>
            )}
            <div className="logbox">
              {logs.slice(-20).reverse().map((entry) => `${new Date(entry.timestamp).toLocaleTimeString()} [${entry.severity}] ${entry.category}: ${entry.message}`).join('\n') || 'No proxy log lines yet.'}
            </div>
            {overview && overview.providers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="hint" style={{ margin: '0 0 4px' }}>Performance (last 200 requests)</div>
                <table className="data-table">
                  <thead><tr><th>Provider</th><th>State</th><th className="num-cell">Success</th><th className="num-cell">P50</th><th className="num-cell">P95</th><th className="num-cell">P99</th><th className="num-cell">Count</th></tr></thead>
                  <tbody>
                    {overview.providers.map((provider) => (
                      <tr key={provider.provider}>
                        <td>{provider.provider}</td>
                        <td className={provider.state === 'closed' ? 'ok-text' : provider.state === 'open' ? 'err-text' : 'status-warn'}>{provider.state}</td>
                        <td className="num-cell">{formatPercent(provider.successRate * 100)}%</td>
                        <td className="num-cell">{formatLatency(provider.p50)}</td>
                        <td className="num-cell">{formatLatency(provider.p95)}</td>
                        <td className="num-cell">{formatLatency(provider.p99)}</td>
                        <td className="num-cell">{formatInteger(provider.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'agents' && (
        <div role="tabpanel" aria-label="Agents">
          <AgentsTab
            {...configProps}
            routes={routes}
            openSection={openAgentSection}
            loginMode={loginMode}
            onSaveAgentKey={saveAgentKey}
            onCopyEnv={(agent) => void copyEnv(agent)}
            onEnterLoginMode={() => void enterLoginMode()}
            onRestoreProxy={() => void restoreProxy()}
            onLaunch={(agent) => void launchAgent(agent)}
          />
        </div>
      )}

      {tab === 'providers' && (
        <div role="tabpanel" aria-label="Providers">
          <ProvidersTab
            {...configProps}
            claudeResetArmed={claudeResetArmed}
            onOpenClaudeSettings={() => void openClaudeSettings()}
            onResetClaude={() => void resetClaude()}
            onCancelReset={() => setClaudeResetArmed(false)}
            onExport={() => void transfer('export')}
            onImport={() => void transfer('import')}
            onCopyDiagnostics={() => void copyDiagnostics()}
          />
        </div>
      )}

      {tab === 'traffic' && (
        <div role="tabpanel" aria-label="Traffic and costs">
          {!ready && (
            <Notice tone="err" title="Proxy is not responding on this port">
              Cost, history, and health panels below show the last data received and are not updating.
            </Notice>
          )}
          <section className="section">
            <div className="section-title-row">
              <h2>API Spend</h2>
              {costClearArmed ? (
                <span className="confirm-group">
                  <span>Clear session costs?</span>
                  <button type="button" className="btn confirm" onClick={() => void clearCosts()}>Confirm</button>
                  <button type="button" className="btn sec" onClick={() => setCostClearArmed(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="btn danger small" title="Clear session cost data" disabled={working || !ready} onClick={() => setCostClearArmed(true)}>Clear</button>
              )}
            </div>
            <div className="cost-period-tabs">
              {(['session', 'daily', 'weekly', 'monthly'] as const).map((period) => (
                <button key={period} type="button" className={`cost-period-tab ${costPeriod === period ? 'active' : ''}`} aria-pressed={costPeriod === period} onClick={() => setCostPeriod(period)}>
                  {{ session: 'Session', daily: 'Day', weekly: 'Week', monthly: 'Month' }[period]}
                </button>
              ))}
              {costLoading && <span className="hint" style={{ margin: '0 0 0 8px' }}>Loading…</span>}
            </div>
            <CostPanel period={costPeriod} overview={overview} summary={costSummary} loading={costLoading} />
          </section>

          <section className="section">
            <div className="section-title-row">
              <h2>History</h2>
              <span className="spacer" />
              <button type="button" className={`btn sec small ${liveActive ? 'active' : ''}`} disabled={working || !ready} onClick={() => void toggleLive()}>{liveActive ? 'Stop live tail' : 'Live tail'}</button>
            </div>
            <form className="filter-row" onSubmit={(event) => void searchHistory(event)}>
              <input type="text" aria-label="Search history" placeholder="Search prompt, model, path…" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} />
              <select aria-label="Filter history by agent" value={filters.agent} onChange={(event) => updateFilters({ agent: event.target.value as HistoryFilters['agent'] })}>
                <option value="">All agents</option>
                <option value="claude">Claude Code</option>
                <option value="qwen">Qwen Code</option>
                <option value="kimi">Kimi Code</option>
                <option value="codex">Codex</option>
              </select>
              <select aria-label="Filter history by status" value={filters.status} onChange={(event) => updateFilters({ status: event.target.value as StatusFilter })}>
                <option value="">All statuses</option>
                <option value="2xx">2xx · Success</option>
                <option value="4xx">4xx · Client error</option>
                <option value="5xx">5xx · Upstream error</option>
              </select>
              <button type="submit" className="btn sec small" disabled={historyLoading}>Search</button>
              <span className="result-count" role="status" aria-live="polite">{historyLoading ? 'Loading…' : `${history.length} ${history.length === 1 ? 'request' : 'requests'}`}</span>
              {historyClearArmed ? (
                <span className="confirm-group">
                  <span>Clear request history?</span>
                  <button type="button" className="btn confirm" onClick={() => void clearHistory()}>Confirm</button>
                  <button type="button" className="btn sec" onClick={() => setHistoryClearArmed(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="btn danger small" title="Clear request history" disabled={working || history.length === 0} onClick={() => setHistoryClearArmed(true)}>Clear</button>
              )}
            </form>

            <div className="history-scroll">
              {history.length === 0 && !historyLoading ? <span className="empty">No requests yet</span> : (
                <table className="history-table">
                  <thead><tr><th>Time</th><th>Agent</th><th>Model</th><th>Provider</th><th>Status</th><th className="num-cell">Latency</th><th>Prompt</th></tr></thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id} className={`proxy-request-row ${entry.id === selectedId ? 'active' : ''}`} onClick={() => void inspect(entry.id)}>
                        <td><time dateTime={entry.ts}>{relativeTime(entry.ts)}</time></td>
                        <td>{entry.agent}</td>
                        <td>{entry.model || entry.requestModel}</td>
                        <td>{entry.provider}</td>
                        <td className={`status-${statusTone(entry.statusCode)}`}>{entry.statusCode}</td>
                        <td className="num-cell">{formatLatency(entry.latencyMs)}</td>
                        <td className="snippet">{entry.promptSnippet ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="pager">
              <button type="button" className="btn sec small" disabled={page === 1 || historyLoading} aria-label="Previous request page" onClick={() => void changePage(page - 1)}>‹</button>
              <span>Page {page}</span>
              <button type="button" className="btn sec small" disabled={history.length < historyLimit || historyLoading} aria-label="Next request page" onClick={() => void changePage(page + 1)}>›</button>
            </div>

            {liveActive && (
              <>
                <div className="filter-row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn sec small" onClick={() => setLivePaused((paused) => !paused)}>{livePaused ? 'Resume' : 'Pause'}</button>
                  <button type="button" className="btn sec small" disabled={history.length === 0} onClick={exportHistory}>Export JSON</button>
                  <input type="text" aria-label="Live tail agent filter" placeholder="Agent filter" value={liveFilter} onChange={(event) => setLiveFilter(event.target.value)} />
                </div>
                <LiveTail events={liveEvents} paused={livePaused} filter={liveFilter} />
              </>
            )}

            {(detailLoading || detail || selectedId) && (
              <RequestDetail
                detail={detail}
                loading={detailLoading}
                replayPreview={replayPreview}
                replayResult={replayResult}
                busy={working}
                onPreview={() => void previewReplay()}
                onReplay={() => void runReplay()}
              />
            )}
          </section>

          <section className="section">
            <h2>Models</h2>
            {overview && overview.models.length > 0 ? (
              <table className="data-table">
                <thead><tr><th>Model</th><th className="num-cell">Calls</th><th className="num-cell">Tokens</th><th className="num-cell">Cost</th></tr></thead>
                <tbody>
                  {overview.models.map((model) => (
                    <tr key={model.model}><td>{model.model}</td><td className="num-cell">{formatInteger(model.calls)}</td><td className="num-cell">{formatInteger(model.inputTokens + model.outputTokens)}</td><td className="num-cell">{formatCost(model.costUsd)}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : models.length > 0 ? (
              <p className="hint" style={{ margin: 0 }}>No measured usage yet. The proxy advertises {models.length} model{models.length === 1 ? '' : 's'}: {models.slice(0, 12).map((model) => model.id).join(', ')}{models.length > 12 ? '…' : ''}</p>
            ) : <span className="empty">No measured usage or discovered models.</span>}
          </section>
        </div>
      )}

      {tab === 'advanced' && (
        <div role="tabpanel" aria-label="Advanced">
          <AdvancedTab
            {...configProps}
            ready={ready}
            tokenStored={Boolean(service.tokenStored)}
            dryRunBody={dryRunBody}
            dryRunResult={dryRunResult}
            onDryRunBody={setDryRunBody}
            onDryRun={() => void dryRun()}
            onCopyToken={onCopyToken}
            onRotateToken={onRotateToken}
          />
        </div>
      )}
    </section>
  );
}

function AgentCard({
  agent,
  route,
  draft,
  ready,
  busy,
  credentialStatus,
  onSaveKey,
  onProvider,
  onModel,
  onRoute,
  onDirect,
  onVerify,
  onRollback,
  onLaunch,
  onConfigure,
}: {
  agent: ProxyAgentId;
  route: ProxyAgentRoute | undefined;
  draft: ProxySettings;
  ready: boolean;
  busy: boolean;
  credentialStatus: CredentialStatus;
  onSaveKey: (value: string) => void;
  onProvider: (key: string) => void;
  onModel: (model: string) => void;
  onRoute: (hours?: number) => void;
  onDirect: () => void;
  onVerify: () => void;
  onRollback: () => void;
  onLaunch: () => void;
  onConfigure: () => void;
}): ReactNode {
  const upstream = agentUpstream(draft, agent);
  const providerKey = agentProviderKey(draft, agent);
  const modelProviderKey = providerKey === 'main' ? agentProviderKey(draft, 'claude') : providerKey;
  const unavailable = route ? !route.installed : false;
  const state = !route ? 'checking' : unavailable ? 'unavailable' : route.route === 'misconfigured' ? 'repair' : route.route === 'proxy' ? 'proxy' : 'direct';
  const pillLabel = { checking: 'Checking', unavailable: 'Unavailable', repair: 'Repair', proxy: 'Proxy', direct: 'Direct' }[state];
  const routeText = !route
    ? ready ? 'Resolving route…' : 'Start the proxy to resolve routes.'
    : unavailable
      ? 'Agent not detected on this machine'
      : route.route === 'proxy'
        ? `${agent} → ${hostLabel(route.localEndpoint || route.upstreamProvider || 'proxy')} → ${hostLabel(upstream.baseUrl)} · ${route.upstreamModel || upstream.model || 'provider default'}`
        : route.route === 'misconfigured'
          ? `${agent} → configuration needs attention${route.warnings[0] ? ` · ${route.warnings[0]}` : ''}`
          : `${agent} → native provider / subscription`;
  const credential = route ? (route.credentialSource === 'none' ? 'No credential detected' : route.credentialSource.replace(/-/g, ' ')) : '—';
  const status = route ? (route.running === true ? 'Running' : route.running === false ? 'Stopped' : 'Unknown') : '—';
  const placeholders: Record<ProxyAgentId, string> = {
    claude: 'Blank = Claude OAuth',
    qwen: 'Enter Qwen API key',
    kimi: 'Blank = Kimi OAuth',
    codex: 'Enter Codex API key',
  };
  const providerOptions = [
    ...(agent === 'claude' ? [] : ['main']),
    ...Object.keys(presetsFor(agent)),
    'custom',
  ];
  return (
    <article className="agent-card proxy-agent-card" aria-label={AGENT_LABELS[agent]}>
      <div className="agent-card-head">
        <div className="agent-mark" aria-hidden="true">{AGENT_MARKS[agent]}</div>
        <div><div className="agent-name">{AGENT_LABELS[agent]}</div><div className="agent-kind">{AGENT_KINDS[agent]}</div></div>
        <span className={`route-pill ${state}`} title={PILL_TITLES[state]}>{pillLabel}</span>
      </div>
      <div className="agent-route">{routeText}</div>
      <div className="agent-meta"><span>Status<strong>{status}</strong></span><span>Credential<strong>{credential}</strong></span></div>
      <div className="agent-key">
        <KeyField
          label="API key"
          credentialId={agentCredentialId(draft, agent)}
          placeholder={placeholders[agent]}
          credentialStatus={credentialStatus}
          busy={busy}
          onSave={onSaveKey}
        />
      </div>
      <div className="agent-select-grid">
        <div className="agent-select">
          <label htmlFor={`uap-card-provider-${agent}`}>Provider</label>
          <select id={`uap-card-provider-${agent}`} value={providerKey} disabled={busy} onChange={(event) => onProvider(event.target.value)}>
            {providerOptions.map((key) => <option key={key} value={key}>{PROVIDER_LABELS[key] ?? key}</option>)}
          </select>
        </div>
        <div className="agent-select">
          <ModelSelect id={`uap-card-model-${agent}`} label="Model" providerKey={modelProviderKey} value={upstream.model} onChange={onModel} />
        </div>
      </div>
      <div className="agent-actions">
        <button type="button" className="btn" disabled={busy || unavailable} onClick={() => onRoute()}>Route</button>
        {agent === 'claude' && <button type="button" className="btn sec" title="Route through the proxy for 5 hours, then revert to Direct" disabled={busy || unavailable} onClick={() => onRoute(5)}>5h</button>}
        {agent === 'claude' && <button type="button" className="btn sec" title="Route through the proxy for 8 hours, then revert to Direct" disabled={busy || unavailable} onClick={() => onRoute(8)}>8h</button>}
        <button type="button" className="btn sec" disabled={busy || unavailable} onClick={onDirect}>Direct</button>
        <button type="button" className="btn sec" disabled={busy} onClick={onVerify}>Verify</button>
        <button type="button" className="btn sec" disabled={busy} onClick={onRollback}>Rollback</button>
        {agent === 'claude' && <button type="button" className="btn sec" disabled={busy} onClick={onLaunch}>Launch</button>}
        {agent === 'codex' && <button type="button" className="btn sec" disabled={busy} onClick={onLaunch}>Open</button>}
        {(agent === 'qwen' || agent === 'kimi') && <button type="button" className="btn sec" onClick={onConfigure}>Configure</button>}
      </div>
    </article>
  );
}

function CostPanel({ period, overview, summary, loading }: {
  period: CostPeriod;
  overview: ProxyOverview | null;
  summary: ProxyCostSummary | null;
  loading: boolean;
}): ReactNode {
  if (period === 'session') {
    const models = overview?.models ?? [];
    const tokens = models.reduce((total, model) => total + model.inputTokens + model.outputTokens, 0);
    return (
      <>
        <div className="cost-grid">
          <CostStat label="Total cost" value={overview ? formatCost(overview.totalCostUsd) : '--'} />
          <CostStat label="API calls" value={overview ? formatInteger(overview.trackedCalls) : '--'} />
          <CostStat label="Total tokens" value={overview ? formatInteger(tokens) : '--'} />
          <CostStat label="Cache hit rate" value={overview ? `${formatPercent(overview.cacheHitRate)}%` : '--'} />
        </div>
        <div className="scroll-box" style={{ maxHeight: 160 }}>
          {models.length === 0 ? <span className="empty">No tracked calls yet -- costs appear as API calls complete.</span> : (
            <table className="cost-table">
              <thead><tr><th>Model</th><th className="num-cell">Calls</th><th className="num-cell">Input</th><th className="num-cell">Output</th><th className="num-cell">Cost</th></tr></thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.model}><td>{model.model}</td><td className="num-cell">{formatInteger(model.calls)}</td><td className="num-cell">{formatInteger(model.inputTokens)}</td><td className="num-cell">{formatInteger(model.outputTokens)}</td><td className="num-cell">{formatCost(model.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </>
    );
  }
  const breakdown = summary?.breakdown.slice().reverse() ?? [];
  const peak = breakdown.reduce((highest, row) => Math.max(highest, row.costUsd), 0);
  return (
    <>
      <div className="cost-grid">
        <CostStat label="Total cost" value={summary ? formatCost(summary.totalCostUsd) : '--'} />
        <CostStat label="API calls" value={summary ? formatInteger(summary.totalCalls) : '--'} />
        <CostStat label="Total tokens" value={summary ? formatInteger(summary.totalInputTokens + summary.totalOutputTokens) : '--'} />
        <CostStat label="Output tokens" value={summary ? formatInteger(summary.totalOutputTokens) : '--'} />
      </div>
      <div className="scroll-box">
        {!loading && breakdown.length === 0 ? <span className="empty">No period buckets recorded.</span> : (
          <table className="cost-table">
            <thead><tr><th>Period</th><th className="num-cell">Calls</th><th className="num-cell">Cost</th><th /></tr></thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.period}>
                  <td>{row.period}</td>
                  <td className="num-cell">{formatInteger(row.calls)}</td>
                  <td className="num-cell">{formatCost(row.costUsd)}</td>
                  <td style={{ width: 60 }}><div className="bar-fill" style={{ width: `${peak ? Math.max(4, (row.costUsd / peak) * 100) : 0}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {summary && summary.models.length > 0 && (
        <table className="cost-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Model</th><th className="num-cell">Calls</th><th className="num-cell">Cost</th></tr></thead>
          <tbody>
            {summary.models.slice(0, 8).map((model) => (
              <tr key={model.model}><td>{model.model}</td><td className="num-cell">{formatInteger(model.calls)}</td><td className="num-cell">{formatCost(model.costUsd)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function CostStat({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="cost-stat"><div className="num">{value}</div><div className="label">{label}</div></div>;
}

function LiveTail({ events, paused, filter }: { events: Array<{ id: number; event: ProxyLiveEvent }>; paused: boolean; filter: string }): ReactNode {
  const [frozen, setFrozen] = useState(events);
  useEffect(() => {
    if (!paused) setFrozen(events);
  }, [events, paused]);
  const needle = filter.trim().toLowerCase();
  const shown = frozen.filter(({ event }) => !needle || JSON.stringify(event.payload).toLowerCase().includes(needle));
  return (
    <div className="live-body">
      {shown.length === 0 ? <div>Waiting for proxy events.</div> : shown.slice().reverse().map(({ id, event }) => {
        const payload = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
        return <div key={id}><strong>{event.event}</strong> {payload.slice(0, 600)}</div>;
      })}
    </div>
  );
}

function RequestDetail({ detail, loading, replayPreview, replayResult, busy, onPreview, onReplay }: {
  detail: ProxyHistoryDetail | null;
  loading: boolean;
  replayPreview: ProxyReplayPreview | null;
  replayResult: ProxyReplayResult | null;
  busy: boolean;
  onPreview: () => void;
  onReplay: () => void;
}): ReactNode {
  if (loading) return <div className="history-detail">Loading request…</div>;
  if (!detail) return <div className="history-detail">Request unavailable.</div>;
  return (
    <div className="history-detail">
      <h4>Request detail · {detail.model} <span className={`status-${statusTone(detail.statusCode)}`}>{detail.statusCode}</span></h4>
      <dl className="detail-grid">
        <DetailField label="Agent" value={detail.agent} />
        <DetailField label="Provider" value={detail.provider} />
        <DetailField label="Route" value={detail.route} />
        <DetailField label="Time" value={new Date(detail.timestamp).toLocaleString()} />
        <DetailField label="Endpoint" value={`${detail.requestMethod} ${detail.requestPath}`} mono />
        <DetailField label="Request model" value={detail.requestModel} mono />
        <DetailField label="Upstream model" value={detail.translatedModel} mono />
        <DetailField label="Retries" value={String(detail.retryAttempt)} />
        <DetailField label="Fallback" value={detail.fallbackUsed ? detail.fallbackProvider ?? 'yes' : 'none'} />
        <DetailField label="Total" value={formatLatency(detail.latency.totalMs)} />
        <DetailField label="First byte" value={formatLatency(detail.latency.upstreamFirstByteMs)} />
        <DetailField label="Stream" value={formatLatency(detail.latency.streamMs)} />
        <DetailField label="Input tokens" value={formatInteger(detail.tokens.input)} />
        <DetailField label="Output tokens" value={formatInteger(detail.tokens.output)} />
        <DetailField label="Cost" value={formatCost(detail.costUsd)} />
      </dl>
      {detail.errorMessage && <p className="err-text" style={{ margin: '0 0 8px' }}><strong>{detail.errorStage ?? 'error'}:</strong> {detail.errorMessage}</p>}
      {detail.promptSnippet && <p className="hint" style={{ margin: '0 0 8px' }}>{detail.promptSnippet}</p>}
      <div className="button-row">
        <button type="button" className="btn sec small" disabled={busy} onClick={onPreview}>Preview replay</button>
        <button type="button" className="btn small" disabled={busy || !replayPreview} onClick={onReplay}>Replay request</button>
      </div>
      {replayPreview && <pre className="logbox">{JSON.stringify(replayPreview, null, 2)}</pre>}
      {replayResult && (
        <pre className="logbox">{`HTTP ${replayResult.statusCode} · ${replayResult.contentType ?? 'unknown content type'} · ${formatBytes(replayResult.body.length)}${replayResult.truncated ? ' (truncated)' : ''}\n\n${replayResult.body.slice(0, 4_000)}`}</pre>
      )}
    </div>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined} title={value}>{value}</dd></div>;
}

function Notice({ tone, title, children, onDismiss }: { tone: 'ok' | 'warn' | 'err'; title?: string; children: ReactNode; onDismiss?: () => void }): ReactNode {
  return (
    <div className={`notice ${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <span className="icon" aria-hidden="true">{tone === 'ok' ? '✓' : '⚠'}</span>
      <div className="body">{title && <div className="title">{title}</div>}{children}</div>
      {onDismiss && <button type="button" className="dismiss" aria-label="Dismiss" onClick={onDismiss}>✕</button>}
    </div>
  );
}

function statusChip(service: ServiceState): { tone: 'ok' | 'warn' | 'err' | 'idle'; glyph: string; label: string } {
  switch (service.status) {
    case 'ready': return { tone: 'ok', glyph: '✓', label: 'Running' };
    case 'starting': return { tone: 'warn', glyph: '…', label: 'Starting' };
    case 'stopping': return { tone: 'warn', glyph: '…', label: 'Stopping' };
    case 'degraded': return { tone: 'warn', glyph: '!', label: 'Degraded' };
    case 'failed': return { tone: 'err', glyph: '✕', label: 'Error' };
    case 'not_configured': return { tone: 'idle', glyph: '■', label: 'Not configured' };
    default: return { tone: 'idle', glyph: '■', label: 'Stopped' };
  }
}

async function loadHistory(filters: HistoryFilters, page: number): Promise<ProxyHistorySummary[]> {
  return window.kaiDesktop.proxyHistory({
    search: filters.search,
    ...(filters.agent ? { agent: filters.agent } : {}),
    status: filters.status,
    page,
    limit: historyLimit,
  }).then(unwrap);
}

function routingNotice(result: ProxyRoutingResult): string {
  const name = AGENT_LABELS[result.agentId];
  if (!result.success) {
    return `${name} ${result.action} failed: ${result.error ?? 'verification failed'}${result.rolledBack ? ' Configuration was rolled back.' : ''}`;
  }
  if (result.action === 'verify') return `${name} route verification passed.`;
  if (result.action === 'rollback') return `${name} configuration was rolled back.`;
  if (result.action === 'route') return `${name} is routed through the proxy.${result.restartRequired ? ' Restart the agent to apply it.' : ''}`;
  return `${name} was restored to native/direct routing.`;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    refresh: 'Refreshing proxy data',
    'route-all': 'Routing every agent',
    'direct-all': 'Restoring every agent to Direct',
    'test-connection': 'Testing the upstream connection',
    'ping-all': 'Pinging configured providers',
    'clear-costs': 'Clearing session costs',
    'dry-run': 'Translating the preview request',
    'replay-preview': 'Loading the replay preview',
    replay: 'Replaying the request',
    'clear-history': 'Clearing request history',
    'live-tail': 'Starting the live event tail',
    'reset-claude': 'Resetting Claude Code configuration',
    'open-claude-settings': 'Opening Claude Code settings',
    export: 'Exporting proxy settings',
    import: 'Importing proxy settings',
  };
  const [agent, verb] = action.split(':') as [string, string | undefined];
  if (agent === 'copy-env' && verb) return `Copying ${AGENT_LABELS[verb as ProxyAgentId]} environment`;
  if (agent === 'launch' && verb) return `Launching ${AGENT_LABELS[verb as ProxyAgentId]}`;
  if (verb && agent in AGENT_LABELS) {
    const name = AGENT_LABELS[agent as ProxyAgentId];
    return { route: `Routing ${name}`, direct: `Restoring ${name} to Direct`, verify: `Verifying ${name}`, rollback: `Rolling back ${name}` }[verb] ?? 'Working';
  }
  return labels[action] ?? 'Working';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The proxy operation failed.';
}

function statusTone(statusCode: number): 'good' | 'warn' | 'bad' {
  if (statusCode >= 500) return 'bad';
  if (statusCode >= 400) return 'warn';
  return 'good';
}

function formatCost(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatLatency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 ms';
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
