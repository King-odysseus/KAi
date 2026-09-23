import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Upload,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AppSettings,
  CredentialStatus,
  LogEntry,
  ProxyAgentId,
  ProxyAgentRoute,
  ProxyCostPeriod,
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
import { ProxySettingsPanel } from './ProxySettingsPanel';

type ProxyTab = 'overview' | 'routing' | 'diagnostics' | 'history' | 'settings';
type StatusFilter = '' | '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
type ProxyCostWindow = Exclude<ProxyCostPeriod, 'session'>;

interface HistoryFilters {
  search: string;
  agent: '' | ProxyAgentId;
  status: StatusFilter;
}

function RequestDetail({
  detail,
  loading,
  selected,
  replayPreview,
  replayResult,
  busy,
  onPreview,
  onReplay,
}: {
  detail: ProxyHistoryDetail | null;
  loading: boolean;
  selected: boolean;
  replayPreview: ProxyReplayPreview | null;
  replayResult: ProxyReplayResult | null;
  busy: boolean;
  onPreview: () => void;
  onReplay: () => void;
}): ReactNode {
  if (loading) return <aside className="proxy-detail proxy-detail-empty"><RefreshCw size={16} className="spin" /><span>Loading request</span></aside>;
  if (!detail) return <aside className="proxy-detail proxy-detail-empty"><CheckCircle2 size={18} /><span>{selected ? 'Request unavailable' : 'Select a request'}</span></aside>;

  return (
    <aside className="proxy-detail">
      <div className="proxy-detail-heading"><div><span className="eyebrow">Request detail</span><h3>{detail.model}</h3></div><span className={`proxy-status-badge status-${statusTone(detail.statusCode)}`}>{detail.statusCode}</span></div>
      <dl className="proxy-detail-fields">
        <DetailField label="Agent" value={detail.agent} />
        <DetailField label="Provider" value={detail.provider} />
        <DetailField label="Route" value={detail.route} />
        <DetailField label="Time" value={new Date(detail.timestamp).toLocaleString()} />
        <DetailField label="Endpoint" value={`${detail.requestMethod} ${detail.requestPath}`} mono />
        <DetailField label="Request model" value={detail.requestModel} mono />
        <DetailField label="Upstream model" value={detail.translatedModel} mono />
        <DetailField label="Retries" value={String(detail.retryAttempt)} />
        <DetailField label="Fallback" value={detail.fallbackUsed ? detail.fallbackProvider ?? 'yes' : 'none'} />
      </dl>
      <div className="proxy-latency-grid">
        <DetailMetric label="Total" value={formatLatency(detail.latency.totalMs)} />
        <DetailMetric label="First byte" value={formatLatency(detail.latency.upstreamFirstByteMs)} />
        <DetailMetric label="Stream" value={formatLatency(detail.latency.streamMs)} />
        <DetailMetric label="Queue" value={formatLatency(detail.latency.queueMs)} />
      </div>
      <div className="proxy-token-row"><span>Input <strong>{formatInteger(detail.tokens.input)}</strong></span><span>Output <strong>{formatInteger(detail.tokens.output)}</strong></span><span>Cost <strong>{formatCost(detail.costUsd)}</strong></span></div>
      {detail.errorMessage && <div className="proxy-detail-error"><AlertTriangle size={14} /><div><strong>{detail.errorStage ?? 'error'}</strong><span>{detail.errorMessage}</span></div></div>}
      {detail.promptSnippet && <p className="proxy-prompt-snippet">{detail.promptSnippet}</p>}
      <div className="proxy-agent-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onPreview}><Search size={13} /><span>Preview replay</span></button>
        <button type="button" className="primary-button" disabled={busy || !replayPreview} onClick={onReplay}><Play size={13} /><span>Replay request</span></button>
      </div>
      {replayPreview && <pre className="proxy-code-block">{JSON.stringify(replayPreview, null, 2)}</pre>}
      {replayResult && <div className="proxy-replay-result"><strong>HTTP {replayResult.statusCode}</strong><span>{replayResult.contentType ?? 'unknown content type'} · {formatBytes(replayResult.body.length)}</span><pre>{replayResult.body.slice(0, 4_000)}</pre>{replayResult.truncated && <em>Response was truncated.</em>}</div>}
    </aside>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>;
}

function DetailMetric({ label, value }: { label: string; value: string }): ReactNode {
  return <div><small>{label}</small><strong>{value}</strong></div>;
}

function RouteField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>;
}

function LiveEventRow({ event }: { event: ProxyLiveEvent }): ReactNode {
  const payload = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
  return <div className={`proxy-live-event event-${event.event}`}><span>{event.event}</span><code>{payload.slice(0, 1_200)}</code></div>;
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

function highestP95(overview: ProxyOverview | null): number {
  if (!overview) return 0;
  return [...overview.latency.map((metric) => metric.p95), ...overview.providers.map((provider) => provider.p95)]
    .reduce((highest, value) => Math.max(highest, value), 0);
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

function agentLabel(agent: ProxyAgentId): string {
  return { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', qwen: 'Qwen Code' }[agent];
}

function routeDescription(route: ProxyAgentRoute): string {
  if (route.route === 'proxy') {
    return `${route.localEndpoint ?? 'proxy'} → ${route.upstreamProvider ?? 'configured provider'} · ${route.upstreamModel ?? 'provider default'}`;
  }
  if (route.route === 'misconfigured') return route.warnings[0] ?? 'Agent configuration is inconsistent.';
  return `Native/direct routing${route.upstreamProvider ? ` · ${route.upstreamProvider}` : ''}`;
}

function routingNotice(result: ProxyRoutingResult): string {
  if (!result.success) {
    return `${agentLabel(result.agentId)} ${result.action} failed: ${result.error ?? 'verification failed'}${result.rolledBack ? ' Configuration was rolled back.' : ''}`;
  }
  if (result.action === 'verify') return `${agentLabel(result.agentId)} route verification passed.`;
  if (result.action === 'rollback') return `${agentLabel(result.agentId)} configuration was rolled back.`;
  if (result.action === 'route') return `${agentLabel(result.agentId)} is routed through the proxy.${result.restartRequired ? ' Restart the agent to apply it.' : ''}`;
  return `${agentLabel(result.agentId)} was restored to native/direct routing.`;
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
  };
  if (action.startsWith('copy-env:')) return `Copying ${agentLabel(action.slice(9) as ProxyAgentId)} environment`;
  if (action.startsWith('launch:')) return `Launching ${agentLabel(action.slice(7) as ProxyAgentId)}`;
  if (action.endsWith(':route')) return `Routing ${agentLabel(action.split(':')[0] as ProxyAgentId)}`;
  if (action.endsWith(':direct')) return `Restoring ${agentLabel(action.split(':')[0] as ProxyAgentId)} to Direct`;
  if (action.endsWith(':verify')) return `Verifying ${agentLabel(action.split(':')[0] as ProxyAgentId)}`;
  if (action.endsWith(':rollback')) return `Rolling back ${agentLabel(action.split(':')[0] as ProxyAgentId)}`;
  return labels[action] ?? 'Working';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The proxy operation failed.';
}

function ProxyMetric({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="proxy-metric"><small>{label}</small><strong>{value}</strong></div>;
}

function ProviderHealthTable({ providers }: { providers: ProxyOverview['providers'] }): ReactNode {
  return (
    <section className="proxy-data-section">
      <div className="proxy-data-heading"><div><span className="eyebrow">Routing</span><h3>Provider health</h3></div><Gauge size={15} /></div>
      <div className="proxy-table-scroll">
        <div className="proxy-provider-table proxy-provider-table-wide">
          <div className="proxy-table-head"><span>Provider</span><span>State</span><span>Success</span><span>Calls</span><span>Errors 24h</span><span>P50</span><span>P95</span><span>P99</span></div>
          {providers.map((provider) => (
            <div className="proxy-table-row" key={provider.provider}>
              <strong className="truncate">{provider.provider}</strong>
              <span className={`provider-state state-${provider.state}`}>{provider.state}</span>
              <span>{formatPercent(provider.successRate * 100)}%</span>
              <span>{formatInteger(provider.count)}</span>
              <span>{formatInteger(provider.errorCount24h)}</span>
              <span>{formatLatency(provider.p50)}</span>
              <span>{formatLatency(provider.p95)}</span>
              <span>{formatLatency(provider.p99)}</span>
            </div>
          ))}
          {providers.length === 0 && <div className="proxy-table-empty">No provider traffic has been recorded.</div>}
        </div>
      </div>
    </section>
  );
}

function ModelUsageTable({ overview, models }: { overview: ProxyOverview | null; models: ProxyModel[] }): ReactNode {
  const usage = overview?.models ?? [];
  return (
    <section className="proxy-data-section">
      <div className="proxy-data-heading"><div><span className="eyebrow">Models</span><h3>Usage and discovery</h3></div><Activity size={15} /></div>
      <div className="proxy-model-list proxy-model-list-scroll">
        {usage.map((model) => (
          <div className="proxy-model-row" key={model.model}><div><strong className="truncate">{model.model}</strong><small>{formatInteger(model.calls)} calls · {formatInteger(model.inputTokens + model.outputTokens)} tokens</small></div><span>{formatCost(model.costUsd)}</span></div>
        ))}
        {usage.length === 0 && models.slice(0, 30).map((model) => (
          <div className="proxy-model-row" key={model.id}><div><strong className="truncate">{model.label ?? model.id}</strong><small>{model.id}</small></div><span>model</span></div>
        ))}
        {usage.length === 0 && models.length === 0 && <div className="proxy-table-empty">No measured usage or discovered models.</div>}
      </div>
    </section>
  );
}

function CostSummaryPanel({
  period,
  summary,
  loading,
  onPeriodChange,
}: {
  period: ProxyCostWindow;
  summary: ProxyCostSummary | null;
  loading: boolean;
  onPeriodChange: (period: ProxyCostWindow) => void;
}): ReactNode {
  const windows: Array<{ id: ProxyCostWindow; label: string }> = [
    { id: 'daily', label: 'Day' },
    { id: 'weekly', label: 'Week' },
    { id: 'monthly', label: 'Month' },
  ];
  const topModels = summary?.models.slice(0, 5) ?? [];
  const breakdown = summary?.breakdown.slice(-7).reverse() ?? [];

  return (
    <section className="proxy-data-section proxy-cost-summary">
      <div className="proxy-data-heading">
        <div><span className="eyebrow">Cognitive1 ledger</span><h3>Cost breakdown</h3></div>
        <Gauge size={15} />
      </div>
      <div className="proxy-cost-controls">
        <div className="proxy-segmented" role="group" aria-label="Cost period">
          {windows.map((item) => (
            <button
              key={item.id}
              type="button"
              className={period === item.id ? 'active' : ''}
              aria-pressed={period === item.id}
              onClick={() => onPeriodChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {loading && <RefreshCw size={14} className="spin" />}
      </div>
      <div className="proxy-cost-metrics">
        <ProxyMetric label="Spend" value={summary ? formatCost(summary.totalCostUsd) : '—'} />
        <ProxyMetric label="Calls" value={summary ? formatInteger(summary.totalCalls) : '—'} />
        <ProxyMetric label="Input tokens" value={summary ? formatInteger(summary.totalInputTokens) : '—'} />
        <ProxyMetric label="Output tokens" value={summary ? formatInteger(summary.totalOutputTokens) : '—'} />
      </div>
      <div className="proxy-cost-columns">
        <div>
          <strong>Top models</strong>
          <div className="proxy-model-list">
            {topModels.map((model) => (
              <div className="proxy-model-row" key={model.model}>
                <div><strong className="truncate">{model.model}</strong><small>{formatInteger(model.calls)} calls</small></div>
                <span>{formatCost(model.costUsd)}</span>
              </div>
            ))}
            {!loading && topModels.length === 0 && <div className="proxy-table-empty">No costed model usage in this window.</div>}
          </div>
        </div>
        <div>
          <strong>Recent buckets</strong>
          <div className="proxy-cost-breakdown">
            {breakdown.map((row) => (
              <div key={row.period}><span>{row.period}</span><strong>{formatCost(row.costUsd)}</strong><small>{formatInteger(row.calls)} calls</small></div>
            ))}
            {!loading && breakdown.length === 0 && <div className="proxy-table-empty">No period buckets recorded.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

const initialFilters: HistoryFilters = { search: '', agent: '', status: '' };
const historyLimit = 25;
const tabs: Array<{ id: ProxyTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'routing', label: 'Agent routing' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'history', label: 'History and replay' },
  { id: 'settings', label: 'Settings' },
];

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
}: {
  service: ServiceState;
  settings: AppSettings;
  busy: boolean;
  logs: LogEntry[];
  credentialStatus: CredentialStatus;
  onSave: (update: { proxy: AppSettings['proxy'] }) => Promise<void> | void;
  onSaveCredential: (id: string, value: string) => Promise<void> | void;
  onClearCredential: (id: string) => Promise<void> | void;
  onReload: () => Promise<void>;
}): ReactNode {
  const [tab, setTab] = useState<ProxyTab>('overview');
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
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [liveEvents, setLiveEvents] = useState<Array<{ id: number; event: ProxyLiveEvent }>>([]);
  const [pingResults, setPingResults] = useState<ProxyPingResult[]>([]);
  const [costPeriod, setCostPeriod] = useState<ProxyCostWindow>('daily');
  const [costSummary, setCostSummary] = useState<ProxyCostSummary | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [claudeResetArmed, setClaudeResetArmed] = useState(false);
  const [dryRunBody, setDryRunBody] = useState(() => JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Reply with one sentence.' }],
  }, null, 2));
  const [dryRunResult, setDryRunResult] = useState<unknown>(null);

  const ready = service.status === 'ready';
  const running = service.status === 'ready' || service.status === 'starting';

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
    setLoading(true);
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
      .catch((caught) => { if (active) setError(messageOf(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ready, service.updatedAt]);

  useEffect(() => {
    if (!ready) {
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

  async function refreshCore(): Promise<void> {
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
    setNotice('Proxy data refreshed.');
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

  async function routeAll(): Promise<void> {
    const results = await run('route-all', async () => {
      const next: ProxyRoutingResult[] = [];
      for (const agent of ['claude', 'codex', 'kimi', 'qwen'] as const) {
        next.push(await window.kaiDesktop.routeProxyAgent(agent, 'route').then(unwrap));
      }
      return next;
    });
    if (!results) return;
    await onReload();
    await refreshCore();
    setNotice(results.every((result) => result.success) ? 'Every supported agent is routed through the proxy.' : 'One or more agent route changes failed.');
  }

  async function directAll(): Promise<void> {
    const results = await run('direct-all', async () => {
      const next: ProxyRoutingResult[] = [];
      for (const agent of ['claude', 'codex', 'kimi', 'qwen'] as const) {
        next.push(await window.kaiDesktop.routeProxyAgent(agent, 'direct').then(unwrap));
      }
      return next;
    });
    if (!results) return;
    await onReload();
    await refreshCore();
    setNotice(results.every((result) => result.success) ? 'Every supported agent is back on native/direct routing.' : 'One or more agents could not be restored to Direct mode.');
  }

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setHistoryLoading(true);
    setSelectedId(null);
    setDetail(null);
    setReplayPreview(null);
    setReplayResult(null);
    try {
      setHistory(await loadHistory(filters, 1));
      setPage(1);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setHistoryLoading(false);
    }
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
    setNotice('Replay preview loaded. No request has been sent.');
  }

  async function runReplay(): Promise<void> {
    if (!detail) return;
    const previewText = replayPreview ? JSON.stringify(replayPreview, null, 2).slice(0, 1_500) : '{}';
    if (!window.confirm(`Replay ${detail.requestMethod} ${detail.requestPath} using the current credential and route?\n\nThis sends a real request to the upstream provider and may be billed to your API account.\n\n${previewText}`)) return;
    const result = await run('replay', () => window.kaiDesktop.replayProxyRequest(detail.id).then(unwrap));
    if (!result) return;
    setReplayResult(result);
    setNotice(`Replay completed with HTTP ${result.statusCode}.`);
  }

  async function clearHistory(): Promise<void> {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    const result = await run('clear-history', () => window.kaiDesktop.clearProxyHistory().then(unwrap));
    if (!result) return;
    setHistory([]);
    setDetail(null);
    setSelectedId(null);
    setClearArmed(false);
    setNotice(`Cleared ${result.cleared} history ${result.cleared === 1 ? 'entry' : 'entries'}.`);
    await refreshCore();
  }

  async function testConnection(): Promise<void> {
    const result = await run('test-connection', () => window.kaiDesktop.testProxyConnection().then(unwrap));
    if (!result) return;
    setNotice(result.ok ? `Upstream connection succeeded (${result.status ?? 200}).` : `Connection failed: ${result.error ?? 'unknown error'}`);
  }

  async function pingAll(): Promise<void> {
    const result = await run('ping-all', () => window.kaiDesktop.pingProxyProviders().then(unwrap));
    if (!result) return;
    setPingResults(result);
    setNotice(`${result.filter((item) => item.ok).length}/${result.length} providers responded.`);
    setTab('diagnostics');
  }

  async function clearCosts(): Promise<void> {
    if (!window.confirm('Clear the proxy session cost data?')) return;
    const result = await run('clear-costs', () => window.kaiDesktop.clearProxyCosts().then(unwrap));
    if (!result) return;
    setNotice(`Cleared ${result.cleared} costed calls.`);
    await refreshCore();
  }

  async function openClaudeSettings(): Promise<void> {
    const result = await run('open-claude-settings', () => window.kaiDesktop.openClaudeSettings().then(unwrap));
    if (!result) return;
    setNotice(result.detail);
  }

  async function resetClaude(): Promise<void> {
    if (!claudeResetArmed) {
      setClaudeResetArmed(true);
      return;
    }
    if (!window.confirm('Reset Claude Code configuration? This removes proxy environment variables, stops tracked Claude sessions, clears Claude credentials and session state, then reselects first-run onboarding. The action is not reversible.')) {
      setClaudeResetArmed(false);
      return;
    }
    const result = await run('reset-claude', () => window.kaiDesktop.resetClaudeCode().then(unwrap));
    setClaudeResetArmed(false);
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
    if (!result) return;
    setDryRunResult(result);
    setNotice('Dry-run translation completed without sending an upstream request.');
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
      direction === 'export'
        ? window.kaiDesktop.exportProxyConfig()
        : window.kaiDesktop.importProxyConfig()
    ).then(unwrap));
    if (!result || result.canceled) return;
    await onReload();
    setNotice(direction === 'export' ? `Exported proxy settings to ${result.path}` : `Imported proxy settings from ${result.path}`);
  }

  async function toggleLive(): Promise<void> {
    if (liveActive) {
      await window.kaiDesktop.stopProxyLiveTail().then(unwrap).catch(() => false);
      setLiveActive(false);
      return;
    }
    setLiveEvents([]);
    const started = await run('live-tail', () => window.kaiDesktop.startProxyLiveTail().then(unwrap));
    if (started) setLiveActive(true);
  }

  async function copyDiagnostics(): Promise<void> {
    const text = [
      `Universal Agent Proxy ${service.version ?? '1.9.0'}`,
      `State: ${service.status}`,
      `Endpoint: ${service.endpoint ?? 'none'}`,
      `Target: ${settings.proxy.targetBaseUrl}`,
      `Credential ID: ${settings.proxy.credentialId}`,
      `Vault: ${credentialStatus.available ? `${credentialStatus.ids.length} credentials` : 'unavailable'}`,
      '',
      'Recent diagnostics:',
      ...logs.slice(-30).map((entry) => `${entry.timestamp} ${entry.severity} ${entry.category}: ${entry.message}`),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setNotice('Proxy diagnostic information copied to the clipboard.');
  }

  function exportHistory(): void {
    const blob = new Blob([`${JSON.stringify(history, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'kai-proxy-history.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function enterLoginMode(): Promise<void> {
    if (!window.confirm('Claude Login Mode disables the proxy and restores Claude Code to its native login path. Continue?')) return;
    await onSave({ proxy: { ...settings.proxy, enabled: false, routeClaudeCode: false, routeClaudeCodeUntil: 0 } });
    await routeAction('claude', 'direct');
    setNotice('Claude Login Mode is active. Run `claude login`, then choose Restore Proxy.');
  }

  async function restoreProxy(): Promise<void> {
    await onSave({ proxy: { ...settings.proxy, enabled: true, routeClaudeCode: true, routeClaudeCodeUntil: 0 } });
    await routeAction('claude', 'route');
    setNotice('The proxy is enabled and Claude Code is routed through it.');
  }

  async function toggleProxy(): Promise<void> {
    await onSave({ proxy: { ...settings.proxy, enabled: !settings.proxy.enabled } });
    setNotice(settings.proxy.enabled ? 'Universal Proxy disabled.' : 'Universal Proxy enabled.');
  }

  return (
    <section className="proxy-control-centre">
      <div className="proxy-control-header">
        <div>
          <span className="eyebrow">Universal Agent Proxy</span>
          <h2>Proxy control centre</h2>
          <p>{service.endpoint ?? 'No endpoint'} · {settings.proxy.targetBaseUrl} · {settings.proxy.defaultModel}</p>
        </div>
        <div className="proxy-control-actions">
          <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void refreshCore()}>
            <RefreshCw size={14} className={action === 'refresh' ? 'spin' : undefined} />
            <span>Refresh</span>
          </button>
          <button type="button" className="secondary-button" onClick={() => void toggleProxy()}>
            {settings.proxy.enabled ? <Square size={13} /> : <Play size={14} />}
            <span>{settings.proxy.enabled ? 'Disable' : 'Enable'}</span>
          </button>
          <button type="button" className="secondary-button" onClick={() => void transfer('export')}>
            <Download size={14} />
            <span>Export</span>
          </button>
          <button type="button" className="secondary-button" onClick={() => void transfer('import')}>
            <Upload size={14} />
            <span>Import</span>
          </button>
        </div>
      </div>

      <nav className="proxy-control-tabs" aria-label="Proxy sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'active' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {notice && <div className="proxy-notice success"><CheckCircle2 size={15} /><span>{notice}</span><button type="button" className="icon-button compact" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={14} /></button></div>}
      {error && <div className="proxy-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" className="icon-button compact" aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button></div>}
      {action && <div className="proxy-action-state"><RefreshCw size={14} className="spin" /><span>{actionLabel(action)}</span></div>}

      {tab === 'overview' && (
        <div className="proxy-control-page">
          {!ready && (
            <div className={`proxy-service-notice ${service.status}`}>
              <Activity size={18} />
              <div><strong>{service.status === 'starting' ? 'Proxy is starting' : 'Proxy is not ready'}</strong><span>{service.detail}</span></div>
            </div>
          )}

          <div className="proxy-metrics proxy-metrics-wide">
            <ProxyMetric label="Total cost" value={overview ? formatCost(overview.totalCostUsd) : '—'} />
            <ProxyMetric label="Costed calls" value={overview ? formatInteger(overview.trackedCalls) : '—'} />
            <ProxyMetric label="Cache hit" value={overview ? `${formatPercent(overview.cacheHitRate)}%` : '—'} />
            <ProxyMetric label="Highest P95" value={overview ? formatLatency(highestP95(overview)) : '—'} />
            <ProxyMetric label="Providers" value={overview ? String(overview.providers.length) : '—'} />
            <ProxyMetric label="Known models" value={String(models.length)} />
          </div>

          <CostSummaryPanel
            period={costPeriod}
            summary={costSummary}
            loading={costLoading}
            onPeriodChange={setCostPeriod}
          />

          <div className="proxy-quick-actions">
            <button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void routeAll()}><Route size={14} /><span>Route all</span></button>
            <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void directAll()}><Square size={13} /><span>Direct all</span></button>
            <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void testConnection()}><Wifi size={14} /><span>Test connection</span></button>
            <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void pingAll()}><Zap size={14} /><span>Ping all providers</span></button>
            <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void clearCosts()}><Trash2 size={14} /><span>Clear costs</span></button>
            <button type="button" className="secondary-button" onClick={() => void copyDiagnostics()}><Copy size={14} /><span>Copy diagnostics</span></button>
          </div>

          <div className="proxy-agent-grid">
            {(['claude', 'codex', 'kimi', 'qwen'] as const).map((agent) => {
              const route = routes.find((candidate) => candidate.agentId === agent);
              return (
                <article className="proxy-agent-card" key={agent}>
                  <div className="proxy-agent-card-head">
                    <span className={`proxy-agent-mark agent-${agent}`}>{agent.slice(0, 1).toUpperCase()}</span>
                    <div><strong>{agentLabel(agent)}</strong><small>{route?.clientKind ?? 'agent routing'}</small></div>
                    <span className={`provider-state state-${route?.route === 'proxy' ? 'closed' : route?.route === 'misconfigured' ? 'open' : 'half-open'}`}>{route?.route ?? 'checking'}</span>
                  </div>
                  <p className="proxy-agent-route">{route ? routeDescription(route) : ready ? 'No resolved route was returned.' : 'Start the proxy to resolve routes.'}</p>
                  <dl className="proxy-agent-meta">
                    <div><dt>Credential</dt><dd>{route?.credentialSource ?? 'unknown'}</dd></div>
                    <div><dt>Provider</dt><dd>{route?.upstreamProvider ?? 'unknown'}</dd></div>
                    <div><dt>Model</dt><dd>{route?.upstreamModel ?? 'provider default'}</dd></div>
                  </dl>
                  <div className="proxy-agent-actions">
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'route')}><Route size={13} /><span>Route</span></button>
                    {agent === 'claude' && <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'route', Date.now() + 5 * 60 * 60 * 1000)}><Clock3 size={13} /><span>5h</span></button>}
                    {agent === 'claude' && <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'route', Date.now() + 8 * 60 * 60 * 1000)}><Clock3 size={13} /><span>8h</span></button>}
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'direct')}><Square size={12} /><span>Direct</span></button>
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'verify')}><CheckCircle2 size={13} /><span>Verify</span></button>
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'rollback')}><RefreshCw size={13} /><span>Rollback</span></button>
                    <button type="button" className="secondary-button" onClick={() => void copyEnv(agent)}><Copy size={13} /><span>Env</span></button>
                    {(agent === 'claude' || agent === 'codex') && <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void launchAgent(agent)}><Terminal size={13} /><span>Launch</span></button>}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'routing' && (
        <div className="proxy-control-page">
          <section className="proxy-data-section proxy-routing-intro">
            <div className="proxy-data-heading"><div><span className="eyebrow">Opt-in writes</span><h3>Agent routing</h3></div><Route size={16} /></div>
            <p>Route changes are transactional and only happen from these controls. Startup never rewrites agent configuration files.</p>
            <div className="proxy-quick-actions compact">
              <button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void routeAll()}><Route size={14} /><span>Route all agents</span></button>
              <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void directAll()}><Square size={13} /><span>Direct all agents</span></button>
              <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void testConnection()}><Wifi size={14} /><span>Test main route</span></button>
            </div>
          </section>

          <div className="proxy-routing-grid">
            {(['claude', 'codex', 'kimi', 'qwen'] as const).map((agent) => {
              const route = routes.find((candidate) => candidate.agentId === agent);
              return (
                <article className="proxy-route-detail" key={agent}>
                  <div className="proxy-route-detail-head">
                    <div><strong>{agentLabel(agent)}</strong><span>{route?.installed ? 'Installed' : 'Not detected'} · {route?.running === null || route?.running === undefined ? 'Running state unknown' : route.running ? 'Running' : 'Stopped'}</span></div>
                    <span className={`route-pill ${route?.route ?? 'unknown'}`}>{route?.route ?? 'unknown'}</span>
                  </div>
                  <dl className="proxy-route-fields">
                    <RouteField label="Local endpoint" value={route?.localEndpoint ?? '—'} mono />
                    <RouteField label="Upstream provider" value={route?.upstreamProvider ?? '—'} />
                    <RouteField label="Upstream model" value={route?.upstreamModel ?? '—'} />
                    <RouteField label="Credential source" value={route?.credentialSource ?? '—'} />
                    <RouteField label="Config files" value={route?.configSources.join(', ') || '—'} mono />
                    <RouteField label="Last verified" value={route?.lastVerified ? `${route.lastVerified.success ? 'Passed' : 'Failed'} · ${relativeTime(new Date(route.lastVerified.timestamp).toISOString())}` : 'Not verified'} />
                  </dl>
                  {route?.restartRequired && <div className="proxy-inline-warning"><AlertTriangle size={14} /><span>Restart the agent to apply its updated route.</span></div>}
                  {route?.warnings.map((warning) => <div className="proxy-inline-warning" key={warning}><AlertTriangle size={14} /><span>{warning}</span></div>)}
                  <div className="proxy-agent-actions">
                    <button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'route')}><Route size={13} /><span>Route</span></button>
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'direct')}><Square size={12} /><span>Direct</span></button>
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'verify')}><CheckCircle2 size={13} /><span>Verify</span></button>
                    <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void routeAction(agent, 'rollback')}><RefreshCw size={13} /><span>Rollback</span></button>
                    <button type="button" className="secondary-button" onClick={() => void copyEnv(agent)}><Copy size={13} /><span>Copy environment</span></button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="proxy-two-column">
            <section className="proxy-data-section">
              <div className="proxy-data-heading"><div><span className="eyebrow">Account login</span><h3>Claude Login Mode</h3></div><KeyRound size={16} /></div>
              <p>Temporarily restore Claude Code to its native subscription/login path, then put the routed configuration back.</p>
              <div className="proxy-agent-actions">
                <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void enterLoginMode()}><KeyRound size={13} /><span>Enter login mode</span></button>
                <button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void restoreProxy()}><RefreshCw size={13} /><span>Restore proxy</span></button>
              </div>
            </section>
            <section className="proxy-data-section">
              <div className="proxy-data-heading"><div><span className="eyebrow">Maintenance</span><h3>Claude Code recovery</h3></div><ShieldAlert size={16} /></div>
              <p>Open the native Claude settings file or perform the same full reset available in Universal Agent Proxy.</p>
              <div className="proxy-agent-actions">
                <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void openClaudeSettings()}><ExternalLink size={13} /><span>Open settings</span></button>
                <button type="button" className={`secondary-button ${claudeResetArmed ? 'danger-button' : ''}`} disabled={Boolean(action)} onBlur={() => setClaudeResetArmed(false)} onClick={() => void resetClaude()}><ShieldAlert size={13} /><span>{claudeResetArmed ? 'Confirm reset' : 'Reset Claude Code'}</span></button>
              </div>
            </section>
            <section className="proxy-data-section">
              <div className="proxy-data-heading"><div><span className="eyebrow">Terminal launch</span><h3>Open a routed agent</h3></div><Terminal size={16} /></div>
              <p>Launch Claude Code or Codex in a new terminal after ensuring its proxy route is active.</p>
              <div className="proxy-agent-actions">
                <button type="button" className="primary-button" disabled={Boolean(action)} onClick={() => void launchAgent('claude')}><Terminal size={13} /><span>Launch Claude Code</span></button>
                <button type="button" className="secondary-button" disabled={Boolean(action)} onClick={() => void launchAgent('codex')}><Terminal size={13} /><span>Launch Codex</span></button>
              </div>
            </section>
          </div>
        </div>
      )}

      {tab === 'diagnostics' && (
        <div className="proxy-control-page">
          <section className="proxy-data-section proxy-routing-intro">
            <div className="proxy-data-heading"><div><span className="eyebrow">Runtime checks</span><h3>Diagnostics</h3></div><Activity size={16} /></div>
            <p>Test the upstream route, check provider reachability, inspect translation output, and review recent proxy logs.</p>
          </section>

          <div className="proxy-quick-actions">
            <button type="button" className="primary-button" disabled={Boolean(action) || !ready} onClick={() => void testConnection()}><Wifi size={14} /><span>Test connection</span></button>
            <button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void pingAll()}><Zap size={14} /><span>Ping all providers</span></button>
            <button type="button" className="secondary-button" onClick={() => void copyDiagnostics()}><Copy size={14} /><span>Copy diagnostic report</span></button>
          </div>

          {pingResults.length > 0 && (
            <section className="proxy-data-section">
              <div className="proxy-data-heading"><div><span className="eyebrow">Reachability</span><h3>Provider ping results</h3></div><Zap size={15} /></div>
              <div className="proxy-ping-grid">
                {pingResults.map((result) => (
                  <div className={`proxy-ping-row ${result.ok ? 'ok' : 'failed'}`} key={`${result.provider}-${result.label}`}>
                    <span>{result.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
                    <div><strong>{result.label || result.provider}</strong><small>{result.provider} · {result.status ?? 'no status'} · {formatLatency(result.latencyMs)}</small></div>
                    <em>{result.error ?? (result.ok ? 'reachable' : 'failed')}</em>
                  </div>
                ))}
              </div>
            </section>
          )}

          <ProviderHealthTable providers={overview?.providers ?? []} />

          <div className="proxy-two-column">
            <ModelUsageTable overview={overview} models={models} />
            <section className="proxy-data-section">
              <div className="proxy-data-heading"><div><span className="eyebrow">Translation</span><h3>Dry run / preview</h3></div><Activity size={15} /></div>
              <label className="field proxy-json-field"><span>Request body (JSON)</span><textarea rows={8} spellCheck={false} value={dryRunBody} onChange={(event) => setDryRunBody(event.target.value)} /></label>
              <div className="proxy-agent-actions"><button type="button" className="secondary-button" disabled={Boolean(action) || !ready} onClick={() => void dryRun()}><Play size={13} /><span>Preview translation</span></button></div>
              {dryRunResult !== null && <pre className="proxy-code-block">{JSON.stringify(dryRunResult, null, 2)}</pre>}
            </section>
          </div>

          <section className="proxy-data-section">
            <div className="proxy-data-heading"><div><span className="eyebrow">Runtime</span><h3>Recent proxy logs</h3></div><Database size={15} /></div>
            <div className="proxy-log-list">
              {logs.slice(-30).reverse().map((entry, index) => (
                <div className={`log-row ${entry.severity}`} key={`${entry.timestamp}-${index}`}><span>{entry.severity}</span><strong>{entry.category}</strong><p>{entry.message}</p><time>{new Date(entry.timestamp).toLocaleTimeString()}</time></div>
              ))}
              {logs.length === 0 && <div className="empty-list">No diagnostics recorded.</div>}
            </div>
          </section>
        </div>
      )}

      {tab === 'history' && (
        <div className="proxy-control-page">
          <div className="proxy-history-heading">
            <div><span className="eyebrow">Request ledger</span><h2>{history.length === 1 ? '1 request' : `${history.length} requests`}</h2></div>
            <div className="proxy-history-actions">
              <button type="button" className={`secondary-button ${liveActive ? 'active-button' : ''}`} disabled={Boolean(action) || !ready} onClick={() => void toggleLive()}>
                {liveActive ? <Pause size={14} /> : <Radio size={14} />}
                <span>{liveActive ? 'Pause live tail' : 'Live tail'}</span>
              </button>
              <button type="button" className="secondary-button" disabled={history.length === 0} onClick={exportHistory}><Download size={14} /><span>Export JSON</span></button>
              <button type="button" className={`secondary-button ${clearArmed ? 'danger-button' : ''}`} disabled={Boolean(action) || history.length === 0} onBlur={() => setClearArmed(false)} onClick={() => void clearHistory()}>
                <Trash2 size={14} /><span>{clearArmed ? 'Confirm clear' : 'Clear history'}</span>
              </button>
            </div>
          </div>

          <form className="proxy-search-form proxy-search-form-wide" onSubmit={(event) => void search(event)}>
            <label className="proxy-search-query"><span>Search</span><span className="input-with-icon"><Search size={15} /><input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Model, provider, prompt, or path" /></span></label>
            <label><span>Agent</span><select value={filters.agent} onChange={(event) => setFilters((current) => ({ ...current, agent: event.target.value as HistoryFilters['agent'] }))}><option value="">All agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="kimi">Kimi Code</option><option value="qwen">Qwen Code</option></select></label>
            <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as StatusFilter }))}><option value="">All statuses</option><option value="2xx">2xx · Success</option><option value="3xx">3xx · Redirect</option><option value="4xx">4xx · Client error</option><option value="5xx">5xx · Upstream error</option></select></label>
            <button type="submit" className="primary-button" disabled={historyLoading}>{historyLoading ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}<span>Search</span></button>
          </form>

          {liveActive && (
            <section className="proxy-live-tail">
              <div className="proxy-data-heading"><div><span className="eyebrow">Server-sent events</span><h3>Live request tail</h3></div><Radio size={15} /></div>
              <div className="proxy-live-events">
                {liveEvents.map((item) => <LiveEventRow event={item.event} key={item.id} />)}
                {liveEvents.length === 0 && <div className="empty-list">Waiting for proxy events.</div>}
              </div>
            </section>
          )}

          <div className="proxy-activity-grid">
            <div className="proxy-request-list">
              {history.map((entry) => (
                <button key={entry.id} type="button" className={`proxy-request-row ${entry.id === selectedId ? 'active' : ''}`} onClick={() => void inspect(entry.id)}>
                  <span className={`proxy-status-dot status-${statusTone(entry.statusCode)}`} />
                  <span className="proxy-request-copy"><strong>{entry.model || entry.requestModel}</strong><small>{entry.provider} · {entry.agent}</small>{entry.promptSnippet && <em>{entry.promptSnippet}</em>}</span>
                  <span className="proxy-request-stats"><strong className={`status-${statusTone(entry.statusCode)}`}>{entry.statusCode}</strong><small>{formatLatency(entry.latencyMs)}</small><time dateTime={entry.ts}>{relativeTime(entry.ts)}</time></span>
                </button>
              ))}
              {!historyLoading && history.length === 0 && <div className="proxy-empty"><Database size={24} /><strong>No matching requests</strong></div>}
              {historyLoading && <div className="proxy-loading-row"><RefreshCw size={14} className="spin" /><span>Loading requests</span></div>}
              <div className="proxy-pagination">
                <button type="button" className="icon-button compact" disabled={page === 1 || historyLoading} onClick={() => void changePage(page - 1)} aria-label="Previous request page" title="Previous page"><ChevronLeft size={15} /></button>
                <span>Page {page}</span>
                <button type="button" className="icon-button compact" disabled={history.length < historyLimit || historyLoading} onClick={() => void changePage(page + 1)} aria-label="Next request page" title="Next page"><ChevronRight size={15} /></button>
              </div>
            </div>
            <RequestDetail
              detail={detail}
              loading={detailLoading}
              selected={selectedId !== null}
              replayPreview={replayPreview}
              replayResult={replayResult}
              busy={Boolean(action)}
              onPreview={() => void previewReplay()}
              onReplay={() => void runReplay()}
            />
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <ProxySettingsPanel
          settings={settings}
          busy={busy || Boolean(action)}
          credentialStatus={credentialStatus}
          onSave={onSave}
          onSaveCredential={onSaveCredential}
          onClearCredential={onClearCredential}
        />
      )}
    </section>
  );
}
