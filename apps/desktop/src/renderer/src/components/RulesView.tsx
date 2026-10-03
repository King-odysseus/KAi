import { AlertTriangle, Check, FileText, FolderInput, Pencil, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ExecutionRule, ExecutionRuleDocument, ExecutionRuleInjectionReport } from '@kai/contracts';
import { unwrap } from '../types';

interface RuleEditor {
  id: string;
  title: string;
  body: string;
  number?: number;
}

export function RulesView(): ReactNode {
  const [document, setDocument] = useState<ExecutionRuleDocument | null>(null);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [injecting, setInjecting] = useState(false);
  const [injection, setInjection] = useState<ExecutionRuleInjectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRules();
  }, []);

  async function loadRules(): Promise<void> {
    setLoading(true);
    try {
      setDocument(await window.kaiDesktop.getRules().then(unwrap));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  async function saveRule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    try {
      const next = await window.kaiDesktop
        .saveRule({ id: editor.id, title: editor.title, body: editor.body })
        .then(unwrap);
      setDocument(next);
      setEditor(null);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  }

  async function injectIntoProjects(): Promise<void> {
    setInjecting(true);
    try {
      setInjection(await window.kaiDesktop.injectRulesIntoProjects().then(unwrap));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setInjecting(false);
    }
  }

  const rules = document?.rules ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRules = rules.filter((rule) => {
    if (!normalizedQuery) return true;
    return [rule.number, rule.section, rule.title, rule.body]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });

  return (
    <div className="page-view rules-view">
      <header className="page-header">
        <div>
          <h1>Execution Rules</h1>
          <p>Authoritative Cognitive1 instructions applied to every KAI agent</p>
        </div>
        <div className="page-actions">
          <button type="button" className="secondary-button" disabled={loading} onClick={() => void loadRules()}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!document || loading || injecting}
            title="Writes these rules into the .kai/instructions.md of every project KAI has open, so a project still carries them if a run does not."
            onClick={() => void injectIntoProjects()}
          >
            <FolderInput size={15} className={injecting ? 'spin' : undefined} />
            <span>Inject into projects</span>
          </button>
          <button type="button" className="primary-button" disabled={!document || saving} onClick={() => setEditor({ id: '', title: '', body: '' })}>
            <Plus size={16} />
            <span>Add rule</span>
          </button>
        </div>
      </header>

      <section className="rules-source-card">
        <ShieldCheck size={18} />
        <div>
          <strong>{rules.length ? `${rules.length} authoritative rules loaded` : 'Loading authoritative rules'}</strong>
          <span>{document?.path ?? 'The rules file is prepared on first use.'}</span>
        </div>
      </section>

      {injection && (
        <section className="rules-injection" aria-label="Rule injection results">
          <div className="rules-injection-heading">
            {injection.results.some((result) => result.status === 'failed') ? <AlertTriangle size={15} /> : <Check size={15} />}
            <strong>{describeInjection(injection)}</strong>
            <button type="button" className="icon-button compact" aria-label="Dismiss injection results" onClick={() => setInjection(null)}>
              <X size={14} />
            </button>
          </div>
          {injection.results.map((result) => (
            <div key={result.file} className={`rules-injection-row is-${result.status}`}>
              <span className="rules-injection-name">{result.name}</span>
              <span className="rules-injection-file" title={result.file}>{result.file}</span>
              <span className="rules-injection-status">{result.message}</span>
            </div>
          ))}
        </section>
      )}

      {error && (
        <div className="rules-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" className="icon-button compact" aria-label="Dismiss rules error" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {editor && (
        <form className="rule-editor" onSubmit={(event) => void saveRule(event)}>
          <div className="rule-editor-heading">
            <div>
              <span className="eyebrow">{editor.id ? `Rule ${editor.number}` : 'Custom rule'}</span>
              <h2>{editor.id ? 'Edit rule' : 'Add rule'}</h2>
            </div>
            <button type="button" className="icon-button compact" aria-label="Close rule editor" disabled={saving} onClick={() => setEditor(null)}>
              <X size={15} />
            </button>
          </div>
          <label className="field">
            <span>Title</span>
            <input autoFocus value={editor.title} onChange={(event) => setEditor((current) => current ? { ...current, title: event.target.value } : current)} />
          </label>
          <label className="field">
            <span>Rule text</span>
            <textarea rows={7} value={editor.body} onChange={(event) => setEditor((current) => current ? { ...current, body: event.target.value } : current)} />
          </label>
          <div className="button-row align-end">
            <button type="button" className="secondary-button" disabled={saving} onClick={() => setEditor(null)}>Cancel</button>
            <button type="submit" className="primary-button" disabled={saving || !editor.title.trim() || !editor.body.trim()}>
              {saving ? <RefreshCw size={15} className="spin" /> : <Check size={15} />}
              <span>Save rule</span>
            </button>
          </div>
        </form>
      )}

      <div className="rules-toolbar">
        <label className="input-with-icon rules-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rules by number, section, or text" />
        </label>
        <span>{visibleRules.length} shown</span>
      </div>

      <div className="rules-list">
        {visibleRules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onEdit={() => setEditor({ id: rule.id, title: rule.title, body: rule.body, number: rule.number })} />
        ))}
        {!loading && visibleRules.length === 0 && (
          <div className="rules-empty">
            <FileText size={24} />
            <strong>{rules.length ? 'No matching rules' : 'No rules loaded'}</strong>
          </div>
        )}
        {loading && (
          <div className="brain-loading-row">
            <RefreshCw size={14} className="spin" />
            <span>Loading execution rules</span>
          </div>
        )}
      </div>
    </div>
  );
}

function RuleRow({ rule, onEdit }: { rule: ExecutionRule; onEdit: () => void }): ReactNode {
  return (
    <article className="rule-row">
      <span className="rule-number">{rule.number}</span>
      <div className="rule-copy">
        <div className="rule-row-heading">
          <h3>{rule.title}</h3>
          <span>{rule.section || 'Rules'}</span>
        </div>
        <p>{rule.body || 'No additional rule text.'}</p>
      </div>
      <button type="button" className="icon-button compact" aria-label={`Edit rule ${rule.number}`} onClick={onEdit}>
        <Pencil size={14} />
      </button>
    </article>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The rules request failed.';
}

/** Said as a sentence rather than a count, because "nothing to do" and "wrote it" are read very differently. */
function describeInjection(report: ExecutionRuleInjectionReport): string {
  const { results } = report;
  if (results.length === 0) return 'No projects are open, so there was nothing to write into.';
  const written = results.filter((result) => result.status === 'written').length;
  const unchanged = results.filter((result) => result.status === 'unchanged').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  if (!written && !failed) return `All ${results.length} projects already carry the current rules.`;
  return [
    written ? `${written} written` : '',
    unchanged ? `${unchanged} already current` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(', ');
}
