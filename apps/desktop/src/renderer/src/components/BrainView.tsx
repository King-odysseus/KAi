import {
  AlertTriangle,
  Brain,
  Check,
  CloudDownload,
  CloudUpload,
  FileText,
  Copy,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Pencil,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  BrainEntry,
  BrainEntryType,
  BrainGitStatus,
  BrainGitSyncAction,
  BrainOverview,
  BrainSearchInput,
  ServiceState,
} from '@kai/contracts';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
interface SearchFilters {
  query: string;
  tag: string;
  type: '' | BrainEntryType;
  project: string;
  global: boolean;
  mode: 'lexical' | 'semantic';
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
  mode: 'lexical',
};

const BRAIN_SECTIONS: ReadonlyArray<{ label: string; detail: string; filters: Partial<SearchFilters> }> = [
  { label: 'Architecture', detail: 'System shape and patterns', filters: { query: 'architecture', type: 'patterns' } },
  { label: 'Security', detail: 'Trust, secrets, and access', filters: { query: 'security' } },
  { label: 'Decisions', detail: 'What was chosen and why', filters: { query: '', type: 'decisions' } },
  { label: 'Lessons', detail: 'Gotchas and past fixes', filters: { query: '', type: 'gotchas' } },
];

export function BrainPanel({ service }: { service: ServiceState }): ReactNode {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [results, setResults] = useState<BrainEntry[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<FieldEditor | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<BrainGitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState<BrainGitSyncAction | 'refresh' | null>(null);
  const [gitFeedback, setGitFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorFeedback, setMirrorFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (service.status !== 'ready') {
      setOverview(null);
      setResults([]);
      setLoading(false);
      setError(null);
      setGitStatus(null);
      setGitFeedback(null);
      return;
    }

    let active = true;
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    void Promise.all([
      window.kaiDesktop.brainOverview().then(unwrap),
      window.kaiDesktop.searchBrain(searchRequest(initialFilters)).then(unwrap),
      window.kaiDesktop.brainGitStatus().then(unwrap),
    ])
      .then(([nextOverview, nextResults, nextGitStatus]) => {
        if (!active || requestId !== latestRequest.current) return;
        setOverview(nextOverview);
        setResults(nextResults);
        setGitStatus(nextGitStatus);
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

  async function refreshGitStatus(): Promise<void> {
    setGitBusy('refresh');
    try {
      const status = await window.kaiDesktop.brainGitStatus().then(unwrap);
      setGitStatus(status);
      setGitFeedback(status.error ? { kind: 'error', message: status.error } : null);
    } catch (caught) {
      setGitFeedback({ kind: 'error', message: messageOf(caught) });
    } finally {
      setGitBusy(null);
    }
  }

  async function runGitAction(action: BrainGitSyncAction): Promise<void> {
    if (action === 'pull' && !(await confirmDialog({
      title: 'Pull brain changes?',
      detail: 'KAI will fast-forward the brain repository from its configured remote. Local conflicts are never overwritten.',
      confirmLabel: 'Pull changes',
    }))) return;
    if (action === 'push' && !(await confirmDialog({
      title: 'Push brain changes?',
      detail: 'KAI will push the current brain branch to its configured remote. This sends brain data off this machine.',
      confirmLabel: 'Push changes',
      destructive: true,
    }))) return;

    setGitBusy(action);
    setGitFeedback(null);
    try {
      const result = await window.kaiDesktop.brainGitSync(action).then(unwrap);
      setGitStatus(result.status);
      setGitFeedback({
        kind: result.success ? 'success' : 'error',
        message: result.message || `${titleCase(action)} completed.`,
      });
      if (result.success) await refresh();
    } catch (caught) {
      setGitFeedback({ kind: 'error', message: messageOf(caught) });
    } finally {
      setGitBusy(null);
    }
  }

  /**
   * Copies the entries this brain already holds into the mirror. The receiving daemon compares titles itself, so
   * nothing is duplicated by running it twice; what it turns away is reported rather than hidden.
   */
  async function copyIntoMirror(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Bring the mirror up to date?',
      detail: 'Entries this brain holds that the mirror does not are filed into it. The mirror applies its own duplicate and quality rules, and it already keeps itself level every 15 minutes, so this only forces a pass early.',
      confirmLabel: 'Copy entries',
    });
    if (!confirmed) return;
    setMirrorBusy(true);
    setMirrorFeedback(null);
    try {
      const outcome = await window.kaiDesktop.mirrorBrain({ dryRun: false }).then(unwrap);
      setMirrorFeedback({
        kind: 'success',
        message: `Read ${outcome.read} entries: ${outcome.posted} filed, ${outcome.skipped} already in the mirror, ${outcome.rejected} turned away, ${outcome.failed} failed.`,
      });
    } catch (caught) {
      setMirrorFeedback({ kind: 'error', message: messageOf(caught) });
    } finally {
      setMirrorBusy(false);
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
        <UiButton type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          <span>Refresh</span>
        </UiButton>
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

      <section className="brain-handbook" aria-label="Project handbook sections">
        <div><strong>Your project handbook</strong><small>Open a section to check the knowledge agents should use before they work.</small></div>
        <div className="brain-handbook-options">
          {BRAIN_SECTIONS.map((section) => (
            <UiButton key={section.label} type="button" onClick={() => {
              const next = { ...initialFilters, ...section.filters };
              setFilters(next);
              void runSearch(next);
            }}>
              <strong>{section.label}</strong><small>{section.detail}</small>
            </UiButton>
          ))}
        </div>
      </section>

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
            <UiTextInput
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              placeholder="Title, field, agent, or project"
            />
          </span>
        </label>
        <label>
          <span>Type</span>
          <Select
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
          </Select>
        </label>
        <label>
          <span>Tag</span>
          <UiTextInput
            value={filters.tag}
            onChange={(event) => setFilters((current) => ({ ...current, tag: event.target.value }))}
            placeholder="Optional tag"
          />
        </label>
        <label>
          <span>Project</span>
          <UiTextInput
            value={filters.project}
            disabled={filters.global}
            onChange={(event) => setFilters((current) => ({ ...current, project: event.target.value }))}
            placeholder="Project name"
          />
        </label>
        <label>
          <span>Search mode</span>
          <Select
            value={filters.mode}
            onChange={(event) => setFilters((current) => ({
              ...current,
              mode: event.target.value as SearchFilters['mode'],
            }))}
          >
            <option value="lexical">Exact words</option>
            <option value="semantic">By meaning</option>
          </Select>
        </label>
        <label className="brain-global-filter">
          <Checkbox
            checked={filters.global}
            onChange={(event) => setFilters((current) => ({ ...current, global: event.target.checked }))}
          />
          <span>All projects</span>
        </label>
        <UiButton type="submit" className="primary-button" disabled={searching}>
          {searching ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
          <span>Search</span>
        </UiButton>
      </form>

      {error && (
        <div className="brain-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <UiButton type="button" className="icon-button compact" aria-label="Dismiss brain error" onClick={() => setError(null)}>
            <X size={14} />
          </UiButton>
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

      {gitStatus && (
        <section className="brain-git-panel" aria-labelledby="brain-git-title">
          <div className="brain-section-heading">
            <div>
              <span className="eyebrow">Portable memory</span>
              <h2 id="brain-git-title">Brain Git sync</h2>
            </div>
            <UiButton type="button" className="secondary-button" disabled={Boolean(gitBusy)} onClick={() => void refreshGitStatus()}>
              <RefreshCw size={14} className={gitBusy === 'refresh' ? 'spin' : undefined} />
              <span>Refresh</span>
            </UiButton>
          </div>
          <div className="brain-git-status">
            <div>
              <GitBranch size={15} />
              <span>{gitStatus.repository ? gitStatus.branch || 'Detached HEAD' : 'Git not initialized'}</span>
            </div>
            <div>
              <FileText size={15} />
              <span>{gitStatus.clean ? 'Working tree clean' : `${gitStatus.changedFiles} changed file${gitStatus.changedFiles === 1 ? '' : 's'}`}</span>
            </div>
            <div>
              <CloudUpload size={15} />
              <span>{gitStatus.remote ? `${gitStatus.ahead} ahead / ${gitStatus.behind} behind` : 'No remote configured'}</span>
            </div>
            <code title={gitStatus.path}>{gitStatus.path}</code>
          </div>
          <div className="brain-git-actions">
            <UiButton type="button" className="secondary-button" disabled={Boolean(gitBusy) || gitStatus.repository} onClick={() => void runGitAction('init')}>
              <FolderPlus size={14} /><span>Initialize</span>
            </UiButton>
            <UiButton type="button" className="secondary-button" disabled={Boolean(gitBusy) || !gitStatus.repository || gitStatus.clean} onClick={() => void runGitAction('commit')}>
              <GitCommitHorizontal size={14} /><span>{gitBusy === 'commit' ? 'Committing' : 'Commit all'}</span>
            </UiButton>
            <UiButton type="button" className="secondary-button" disabled={Boolean(gitBusy) || !gitStatus.repository || !gitStatus.remote} onClick={() => void runGitAction('pull')}>
              <CloudDownload size={14} /><span>{gitBusy === 'pull' ? 'Pulling' : 'Pull'}</span>
            </UiButton>
            <UiButton type="button" className="secondary-button" disabled={Boolean(gitBusy) || !gitStatus.repository || !gitStatus.remote} onClick={() => void runGitAction('push')}>
              <CloudUpload size={14} /><span>{gitBusy === 'push' ? 'Pushing' : 'Push'}</span>
            </UiButton>
            <UiButton type="button" className="secondary-button" disabled={mirrorBusy} onClick={() => void copyIntoMirror()} title="Files any entry this brain holds that the mirror is missing. Agents writing through MCP are carried over by this too.">
              <Copy size={14} /><span>{mirrorBusy ? 'Syncing' : 'Sync the mirror now'}</span>
            </UiButton>
          </div>
          {gitStatus.error && !gitFeedback && (
            <div className="brain-git-feedback error" role="alert">
              <AlertTriangle size={14} /><span>{gitStatus.error}</span>
            </div>
          )}
          {gitFeedback && (
            <div className={`brain-git-feedback ${gitFeedback.kind}`} role={gitFeedback.kind === 'error' ? 'alert' : 'status'}>
              {gitFeedback.kind === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
              <span>{gitFeedback.message}</span>
            </div>
          )}
          {mirrorFeedback && (
            <div className={`brain-git-feedback ${mirrorFeedback.kind}`} role={mirrorFeedback.kind === 'error' ? 'alert' : 'status'}>
              {mirrorFeedback.kind === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
              <span>{mirrorFeedback.message}</span>
            </div>
          )}
        </section>
      )}
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
                  <Textarea autoFocus value={editor.value} onChange={(event) => onChange(event.target.value)} />
                  <UiButton type="submit" className="icon-button compact" disabled={saving} aria-label={`Save ${field}`}>
                    {saving ? <RefreshCw size={13} className="spin" /> : <Check size={14} />}
                  </UiButton>
                  <UiButton type="button" className="icon-button compact" disabled={saving} onClick={onCancel} aria-label={`Cancel ${field}`}>
                    <X size={14} />
                  </UiButton>
                </form>
              ) : (
                <>
                  <dd>{value}</dd>
                  <UiButton
                    type="button"
                    className="icon-button compact field-edit-button"
                    aria-label={`Edit ${field}`}
                    onClick={() => onEdit({ title: entry.title, field, value })}
                  >
                    <Pencil size={13} />
                  </UiButton>
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

function searchRequest(filters: SearchFilters, maxResults = 25): BrainSearchInput {
  return {
    query: filters.query,
    tag: filters.tag,
    type: filters.type || undefined,
    project: filters.project,
    global: filters.global,
    mode: filters.mode,
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
      <UiButton type="button" className={`icon-button compact ${sent === 'up' ? 'active' : ''}`} aria-pressed={sent === 'up'} title="Useful: rank this higher" aria-label="Useful" onClick={() => void send(true)}><ThumbsUp size={13} /></UiButton>
      <UiButton type="button" className={`icon-button compact ${sent === 'down' ? 'active' : ''}`} aria-pressed={sent === 'down'} title="Not useful: rank this lower" aria-label="Not useful" onClick={() => void send(false)}><ThumbsDown size={13} /></UiButton>
      {failed && <small role="alert">Could not send</small>}
    </span>
  );
}
