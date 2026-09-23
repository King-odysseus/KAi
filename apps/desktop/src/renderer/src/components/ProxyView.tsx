import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ProxyHistoryDetail,
  ProxyHistorySummary,
  ProxyOverview,
  ProxyProviderHealth,
  ServiceState,
} from '@kai/contracts';
import { relativeTime, unwrap } from '../types';

type StatusFilter = '' | '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

interface HistoryFilters {
  search: string;
  status: StatusFilter;
}

const initialFilters: HistoryFilters = { search: '', status: '' };
const historyLimit = 25;

export function ProxyPanel({ service }: { service: ServiceState }): ReactNode {
  const [overview, setOverview] = useState<ProxyOverview | null>(null);
  const [history, setHistory] = useState<ProxyHistorySummary[]>([]);
  const [filters, setFilters] = useState<HistoryFilters>(initialFilters);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProxyHistoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);

  useEffect(() => {
    if (service.status !== 'ready') {
      setOverview(null);
      setHistory([]);
      setDetail(null);
      setSelectedId(null);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([window.kaiDesktop.proxyOverview().then(unwrap), loadHistory(initialFilters, 1)])
      .then(([nextOverview, nextHistory]) => {
        if (!active) return;
        setOverview(nextOverview);
        setHistory(nextHistory);
        setPage(1);
        setFilters(initialFilters);
      })
      .catch((caught) => {
        if (active) setError(messageOf(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [service.status, service.updatedAt]);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const [nextOverview, nextHistory] = await Promise.all([
        window.kaiDesktop.proxyOverview().then(unwrap),
        loadHistory(filters, page),
      ]);
      setOverview(nextOverview);
      setHistory(nextHistory);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setHistoryLoading(true);
    setSelectedId(null);
    setDetail(null);
    try {
      const nextHistory = await loadHistory(filters, 1);
      setHistory(nextHistory);
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
      const nextHistory = await loadHistory(filters, nextPage);
      setHistory(nextHistory);
      setPage(nextPage);
      setSelectedId(null);
      setDetail(null);
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
    try {
      const nextDetail = await window.kaiDesktop.proxyHistoryDetail(id).then(unwrap);
      setDetail(nextDetail);
      setError(null);
    } catch (caught) {
      setDetail(null);
      setError(messageOf(caught));
    } finally {
      setDetailLoading(false);
    }
  }

  async function clearHistory(): Promise<void> {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setLoading(true);
    try {
      await window.kaiDesktop.clearProxyHistory().then(unwrap);
      setHistory([]);
      setPage(1);
      setSelectedId(null);
      setDetail(null);
      setClearArmed(false);
      setError(null);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  if (service.status !== 'ready') {
    return (
      <section className="proxy-panel proxy-unavailable">
        <div className="proxy-empty-icon">
          <Activity size={22} />
        </div>
        <strong>Proxy activity is not available</strong>
        <span>{service.detail}</span>
      </section>
    );
  }

  const p95 = highestP95(overview);

  return (
    <section className="proxy-panel">
      <div className="proxy-section-heading">
        <div>
          <span className="eyebrow">Traffic and routing</span>
          <h2>Proxy activity</h2>
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {overview ? (
        <div className="proxy-metrics">
          <ProxyMetric label="Cost" value={formatCost(overview.totalCostUsd)} />
          <ProxyMetric label="Costed calls" value={formatInteger(overview.trackedCalls)} />
          <ProxyMetric label="Cache hit" value={`${formatPercent(overview.cacheHitRate)}%`} />
          <ProxyMetric label="Highest P95" value={formatLatency(p95)} />
        </div>
      ) : (
        <div className="proxy-loading-row">
          <RefreshCw size={14} className="spin" />
          <span>Loading proxy metrics</span>
        </div>
      )}

      <div className="proxy-health-grid">
        <ProviderHealthTable providers={overview?.providers ?? []} />
        <ModelUsageTable overview={overview} />
      </div>

      <div className="proxy-history-heading">
        <div>
          <span className="eyebrow">Request history</span>
          <h2>{history.length === 1 ? '1 request' : `${history.length} requests`}</h2>
        </div>
        <div className="proxy-history-actions">
          <button
            type="button"
            className={`secondary-button ${clearArmed ? 'danger-button' : ''}`}
            disabled={loading || history.length === 0}
            onBlur={() => setClearArmed(false)}
            onClick={() => void clearHistory()}
          >
            <Trash2 size={14} />
            <span>{clearArmed ? 'Confirm clear' : 'Clear history'}</span>
          </button>
        </div>
      </div>

      <form className="proxy-search-form" onSubmit={(event) => void search(event)}>
        <label className="proxy-search-query">
          <span>Search</span>
          <span className="input-with-icon">
            <Search size={15} />
            <input
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Model, provider, or prompt"
            />
          </span>
        </label>
        <label>
          <span>Status</span>
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value as StatusFilter }))
            }
          >
            <option value="">All statuses</option>
            <option value="2xx">Success</option>
            <option value="3xx">Redirect</option>
            <option value="4xx">Client error</option>
            <option value="5xx">Upstream error</option>
          </select>
        </label>
        <button type="submit" className="primary-button" disabled={historyLoading}>
          {historyLoading ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
          <span>Search</span>
        </button>
      </form>

      {error && (
        <div className="proxy-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" className="icon-button compact" aria-label="Dismiss proxy error" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="proxy-activity-grid">
        <div className="proxy-request-list">
          {history.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`proxy-request-row ${entry.id === selectedId ? 'active' : ''}`}
              onClick={() => void inspect(entry.id)}
            >
              <span className={`proxy-status-dot status-${statusTone(entry.statusCode)}`} />
              <span className="proxy-request-copy">
                <strong>{entry.model || entry.requestModel}</strong>
                <small>
                  {entry.provider} · {entry.agent}
                </small>
                {entry.promptSnippet && <em>{entry.promptSnippet}</em>}
              </span>
              <span className="proxy-request-stats">
                <strong className={`status-${statusTone(entry.statusCode)}`}>{entry.statusCode}</strong>
                <small>{formatLatency(entry.latencyMs)}</small>
                <time dateTime={entry.ts}>{relativeTime(entry.ts)}</time>
              </span>
            </button>
          ))}
          {!historyLoading && history.length === 0 && (
            <div className="proxy-empty">
              <Database size={24} />
              <strong>No matching requests</strong>
            </div>
          )}
          {historyLoading && (
            <div className="proxy-loading-row">
              <RefreshCw size={14} className="spin" />
              <span>Loading requests</span>
            </div>
          )}
          <div className="proxy-pagination">
            <button
              type="button"
              className="icon-button compact"
              disabled={page === 1 || historyLoading}
              onClick={() => void changePage(page - 1)}
              aria-label="Previous request page"
              title="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
            <span>Page {page}</span>
            <button
              type="button"
              className="icon-button compact"
              disabled={history.length < historyLimit || historyLoading}
              onClick={() => void changePage(page + 1)}
              aria-label="Next request page"
              title="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        <RequestDetail detail={detail} loading={detailLoading} selected={selectedId !== null} />
      </div>
    </section>
  );
}

function ProviderHealthTable({ providers }: { providers: ProxyProviderHealth[] }): ReactNode {
  return (
    <section className="proxy-data-section">
      <div className="proxy-data-heading">
        <div>
          <span className="eyebrow">Routing</span>
          <h3>Provider health</h3>
        </div>
        <Gauge size={15} />
      </div>
      <div className="proxy-table-scroll">
        <div className="proxy-provider-table">
          <div className="proxy-table-head">
            <span>Provider</span>
            <span>State</span>
            <span>Success</span>
            <span>Calls</span>
            <span>P95</span>
          </div>
          {providers.map((provider) => (
            <div className="proxy-table-row" key={provider.provider}>
              <strong className="truncate">{provider.provider}</strong>
              <span className={`provider-state state-${provider.state}`}>{provider.state}</span>
              <span>{formatPercent(provider.successRate * 100)}%</span>
              <span>{formatInteger(provider.count)}</span>
              <span>{formatLatency(provider.p95)}</span>
            </div>
          ))}
          {providers.length === 0 && <div className="proxy-table-empty">No provider traffic</div>}
        </div>
      </div>
    </section>
  );
}

function ModelUsageTable({ overview }: { overview: ProxyOverview | null }): ReactNode {
  const models = overview?.models ?? [];
  return (
    <section className="proxy-data-section">
      <div className="proxy-data-heading">
        <div>
          <span className="eyebrow">Usage</span>
          <h3>Models</h3>
        </div>
        <Activity size={15} />
      </div>
      <div className="proxy-model-list">
        {models.slice(0, 6).map((model) => (
          <div className="proxy-model-row" key={model.model}>
            <div>
              <strong className="truncate">{model.model}</strong>
              <small>
                {formatInteger(model.calls)} calls · {formatInteger(model.inputTokens + model.outputTokens)} tokens
              </small>
            </div>
            <span>{formatCost(model.costUsd)}</span>
          </div>
        ))}
        {models.length === 0 && <div className="proxy-table-empty">No measured usage</div>}
      </div>
    </section>
  );
}

function RequestDetail({
  detail,
  loading,
  selected,
}: {
  detail: ProxyHistoryDetail | null;
  loading: boolean;
  selected: boolean;
}): ReactNode {
  if (loading) {
    return (
      <aside className="proxy-detail proxy-detail-empty">
        <RefreshCw size={16} className="spin" />
        <span>Loading request</span>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="proxy-detail proxy-detail-empty">
        <CheckCircle2 size={18} />
        <span>{selected ? 'Request unavailable' : 'Select a request'}</span>
      </aside>
    );
  }

  return (
    <aside className="proxy-detail">
      <div className="proxy-detail-heading">
        <div>
          <span className="eyebrow">Request detail</span>
          <h3>{detail.model}</h3>
        </div>
        <span className={`proxy-status-badge status-${statusTone(detail.statusCode)}`}>{detail.statusCode}</span>
      </div>
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

      <div className="proxy-token-row">
        <span>Input <strong>{formatInteger(detail.tokens.input)}</strong></span>
        <span>Output <strong>{formatInteger(detail.tokens.output)}</strong></span>
        <span>Cost <strong>{formatCost(detail.costUsd)}</strong></span>
      </div>

      {detail.errorMessage && (
        <div className="proxy-detail-error">
          <AlertTriangle size={14} />
          <div>
            <strong>{detail.errorStage ?? 'error'}</strong>
            <span>{detail.errorMessage}</span>
          </div>
        </div>
      )}
      {detail.promptSnippet && <p className="proxy-prompt-snippet">{detail.promptSnippet}</p>}
    </aside>
  );
}

function ProxyMetric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="proxy-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

async function loadHistory(filters: HistoryFilters, page: number): Promise<ProxyHistorySummary[]> {
  return window.kaiDesktop
    .proxyHistory({
      search: filters.search,
      status: filters.status,
      page,
      limit: historyLimit,
    })
    .then(unwrap);
}

function highestP95(overview: ProxyOverview | null): number {
  if (!overview) return 0;
  return [...overview.latency.map((metric) => metric.p95), ...overview.providers.map((provider) => provider.p95)].reduce(
    (highest, value) => Math.max(highest, value),
    0,
  );
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The proxy request failed.';
}
