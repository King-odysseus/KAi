import {
  AlertTriangle,
  Brain,
  Check,
  FileText,
  Pencil,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { BrainEntry, BrainEntryType, BrainOverview, ServiceState } from '@kai/contracts';
import { unwrap } from '../types';

interface SearchFilters {
  query: string;
  tag: string;
  type: '' | BrainEntryType;
  project: string;
  global: boolean;
}

interface FieldEditor {
  title: string;
  field: string;
  value: string;
}

const initialFilters: SearchFilters = {
  query: '',
  tag: '',
  type: '',
  project: '',
  global: false,
};

export function BrainPanel({ service }: { service: ServiceState }): ReactNode {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [results, setResults] = useState<BrainEntry[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<FieldEditor | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (service.status !== 'ready') {
      setOverview(null);
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    void Promise.all([
      window.kaiDesktop.brainOverview().then(unwrap),
      window.kaiDesktop.searchBrain(searchRequest(initialFilters)).then(unwrap),
    ])
      .then(([nextOverview, nextResults]) => {
        if (!active || requestId !== latestRequest.current) return;
        setOverview(nextOverview);
        setResults(nextResults);
      })
      .catch((caught) => {
        if (active && requestId === latestRequest.current) setError(messageOf(caught));
      })
      .finally(() => {
        if (active && requestId === latestRequest.current) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [service.status, service.updatedAt]);

  async function runSearch(nextFilters: SearchFilters): Promise<void> {
    const requestId = ++latestRequest.current;
    setSearching(true);
    setEditor(null);
    try {
      const nextResults = await window.kaiDesktop
        .searchBrain(searchRequest(nextFilters, 50))
        .then(unwrap);
      if (requestId === latestRequest.current) {
        setResults(nextResults);
        setError(null);
      }
    } catch (caught) {
      if (requestId === latestRequest.current) setError(messageOf(caught));
    } finally {
      if (requestId === latestRequest.current) setSearching(false);
    }
  }

  async function refresh(): Promise<void> {
    const requestId = ++latestRequest.current;
    setLoading(true);
    try {
      const [overviewResult, resultsResult] = await Promise.allSettled([
        window.kaiDesktop.brainOverview().then(unwrap),
        window.kaiDesktop
          .searchBrain(searchRequest(filters, 50))
          .then(unwrap),
      ]);
      if (requestId === latestRequest.current) {
        if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
        if (resultsResult.status === 'fulfilled') setResults(resultsResult.value);
        const failure = [overviewResult, resultsResult].find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        setError(failure ? messageOf(failure.reason) : null);
      }
    } catch (caught) {
      if (requestId === latestRequest.current) setError(messageOf(caught));
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }

  async function saveField(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor) return;
    const key = fieldKey(editor);
    setSavingField(key);
    try {
      const updated = await window.kaiDesktop.updateBrainField(editor).then(unwrap);
      setResults((current) => current.map((entry) => entry.title === updated.title
        ? {
            ...entry,
            fields: { ...entry.fields, [updated.field]: updated.value },
            status: updated.field.toLowerCase() === 'status' ? updated.value : entry.status,
          }
        : entry));
      setEditor(null);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSavingField(null);
    }
  }

  if (service.status !== 'ready') {
    return (
      <section className="brain-panel brain-unavailable">
        <div className="brain-empty-icon">
          <Brain size={22} />
        </div>
        <strong>C1 Brain is not available</strong>
        <span>{service.detail}</span>
      </section>
    );
  }

  return (
    <section className="brain-panel">
      <div className="brain-section-heading">
        <div>
          <span className="eyebrow">Knowledge state</span>
          <h2>Brain overview</h2>
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {overview ? (
        <div className="brain-metrics">
          <BrainMetric label="Entries" value={String(overview.totalEntries)} />
          <BrainMetric label="Active agents" value={String(overview.activeAgents)} />
          <BrainMetric label="Projects" value={String(overview.projectCount)} />
          <BrainMetric label="Hunger" value={titleCase(overview.hunger.level)} tone={overview.hunger.level === 'satisfied' ? 'good' : 'warn'} />
          {overview.quality ? (
            <>
              <BrainMetric label="Signal" value={`${overview.quality.signalRatio}%`} tone={overview.quality.signalRatio >= 80 ? 'good' : 'warn'} />
              <BrainMetric label="Duplicates" value={String(overview.quality.duplicateCount)} tone={overview.quality.duplicateCount ? 'warn' : 'good'} />
              <BrainMetric label="Untagged" value={String(overview.quality.untaggedTotal)} />
              <BrainMetric label="Noise" value={`${overview.quality.noiseScore}%`} tone={overview.quality.noiseScore <= 10 ? 'good' : 'warn'} />
            </>
          ) : (
            <div className="brain-quality-deferred">
              <small>Quality audit deferred for this large brain to keep Cognitive1 responsive.</small>
            </div>
          )}
        </div>
      ) : (
        <div className="brain-loading-row">
          <RefreshCw size={14} className="spin" />
          <span>Loading brain state</span>
        </div>
      )}

      <form
        className="brain-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(filters);
        }}
      >
        <label className="brain-search-query">
          <span>Search</span>
          <span className="input-with-icon">
            <Search size={15} />
            <input
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              placeholder="Title, field, agent, or project"
            />
          </span>
        </label>
        <label>
          <span>Type</span>
          <select
            value={filters.type}
            onChange={(event) =>
              setFilters((current) => ({ ...current, type: event.target.value as SearchFilters['type'] }))
            }
          >
            <option value="">All types</option>
            <option value="bugs">Bugs ({overview?.typeCounts.bugs ?? 0})</option>
            <option value="decisions">Decisions ({overview?.typeCounts.decisions ?? 0})</option>
            <option value="gotchas">Gotchas ({overview?.typeCounts.gotchas ?? 0})</option>
            <option value="patterns">Patterns ({overview?.typeCounts.patterns ?? 0})</option>
          </select>
        </label>
        <label>
          <span>Tag</span>
          <input
            value={filters.tag}
            onChange={(event) => setFilters((current) => ({ ...current, tag: event.target.value }))}
            placeholder="Optional tag"
          />
        </label>
        <label>
          <span>Project</span>
          <input
            value={filters.project}
            disabled={filters.global}
            onChange={(event) => setFilters((current) => ({ ...current, project: event.target.value }))}
            placeholder="Project name"
          />
        </label>
        <label className="brain-global-filter">
          <input
            type="checkbox"
            checked={filters.global}
            onChange={(event) => setFilters((current) => ({ ...current, global: event.target.checked }))}
          />
          <span>All projects</span>
        </label>
        <button type="submit" className="primary-button" disabled={searching}>
          {searching ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
          <span>Search</span>
        </button>
      </form>

      {error && (
        <div className="brain-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" className="icon-button compact" aria-label="Dismiss brain error" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="brain-results-heading">
        <div>
          <span className="eyebrow">Memory</span>
          <h2>{results.length === 1 ? '1 entry' : `${results.length} entries`}</h2>
        </div>
        <SlidersHorizontal size={15} />
      </div>

      <div className="brain-results">
        {results.map((entry) => (
          <BrainEntryCard
            key={`${entry.type}:${entry.date}:${entry.title}`}
            entry={entry}
            editor={editor}
            savingField={savingField}
            onEdit={setEditor}
            onCancel={() => setEditor(null)}
            onChange={(value) => setEditor((current) => (current ? { ...current, value } : current))}
            onSubmit={(event) => void saveField(event)}
          />
        ))}
        {!loading && results.length === 0 && (
          <div className="brain-empty">
            <FileText size={24} />
            <strong>No matching entries</strong>
          </div>
        )}
        {loading && (
          <div className="brain-loading-row">
            <RefreshCw size={14} className="spin" />
            <span>Refreshing memory</span>
          </div>
        )}
      </div>
    </section>
  );
}

function BrainEntryCard({
  entry,
  editor,
  savingField,
  onEdit,
  onCancel,
  onChange,
  onSubmit,
}: {
  entry: BrainEntry;
  editor: FieldEditor | null;
  savingField: string | null;
  onEdit: (editor: FieldEditor) => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactNode {
  const fields = Object.entries(entry.fields).sort(([left], [right]) => left.localeCompare(right));
  const tags = entry.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  return (
    <article className="brain-entry">
      <div className="brain-entry-heading">
        <span className={`brain-type type-${entry.type}`}>{entry.type.slice(0, -1)}</span>
        <RecallFeedback entry={entry} />
        <div>
          <h3>{entry.title}</h3>
          <div className="brain-entry-meta">
            <span>{entry.project || 'global'}</span>
            <span>{entry.agent}</span>
            <time dateTime={entry.date}>{entry.date}</time>
            {entry.status && <span className="brain-status">{entry.status}</span>}
          </div>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="brain-tags">
          {tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}

      <dl className="brain-fields">
        {fields.map(([field, value]) => {
          const editing = editor?.title === entry.title && editor.field === field;
          const saving = savingField === fieldKey({ title: entry.title, field, value });
          return (
            <div className={`brain-field ${editing ? 'editing' : ''}`} key={field}>
              <dt>{field}</dt>
              {editing ? (
                <form className="brain-field-form" onSubmit={onSubmit}>
                  <textarea autoFocus value={editor.value} onChange={(event) => onChange(event.target.value)} />
                  <button type="submit" className="icon-button compact" disabled={saving} aria-label={`Save ${field}`}>
                    {saving ? <RefreshCw size={13} className="spin" /> : <Check size={14} />}
                  </button>
                  <button type="button" className="icon-button compact" disabled={saving} onClick={onCancel} aria-label={`Cancel ${field}`}>
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <>
                  <dd>{value}</dd>
                  <button
                    type="button"
                    className="icon-button compact field-edit-button"
                    aria-label={`Edit ${field}`}
                    onClick={() => onEdit({ title: entry.title, field, value })}
                  >
                    <Pencil size={13} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </dl>
    </article>
  );
}

function BrainMetric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }): ReactNode {
  return (
    <div className={`brain-metric ${tone ?? ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function fieldKey(editor: FieldEditor): string {
  return `${editor.title}:${editor.field}`;
}

function searchRequest(filters: SearchFilters, maxResults = 25) {
  return {
    query: filters.query,
    tag: filters.tag,
    type: filters.type || undefined,
    project: filters.project,
    global: filters.global,
    maxResults,
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The brain request failed.';
}

/** Thumbs on a recalled entry. Useful entries rank higher in later searches; unhelpful ones rank lower. */
function RecallFeedback({ entry }: { entry: BrainEntry }): ReactNode {
  const [sent, setSent] = useState<'up' | 'down' | null>(null);
  const [failed, setFailed] = useState(false);

  async function send(useful: boolean): Promise<void> {
    try {
      unwrap(await window.kaiDesktop.cognitive1Operation({
        operation: 'brain-recall-feedback',
        payload: { title: entry.title, type: entry.type, date: entry.date, useful },
      }));
      setSent(useful ? 'up' : 'down');
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className="recall-feedback" role="group" aria-label={`Was "${entry.title}" useful?`}>
      <button type="button" className={`icon-button compact ${sent === 'up' ? 'active' : ''}`} aria-pressed={sent === 'up'} title="Useful: rank this higher" aria-label="Useful" onClick={() => void send(true)}><ThumbsUp size={13} /></button>
      <button type="button" className={`icon-button compact ${sent === 'down' ? 'active' : ''}`} aria-pressed={sent === 'down'} title="Not useful: rank this lower" aria-label="Not useful" onClick={() => void send(false)}><ThumbsDown size={13} /></button>
      {failed && <small role="alert">Could not send</small>}
    </span>
  );
}
