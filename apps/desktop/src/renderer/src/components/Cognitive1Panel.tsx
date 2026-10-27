import {
  Activity,
  AlertTriangle,
  Archive,
  BookOpen,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Download,
  Eye,
  FileCode2,
  GitBranch,
  Info,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Play,
  RefreshCw,
  ShieldCheck,
  Siren,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Markdown } from './Markdown';
import { Pill } from './Pill';
import {
  cognitive1McpTools,
  cognitive1Operations,
  type BrainEntryType,
  type Cognitive1McpTool,
  type Cognitive1Operation,
  type ProjectRecord,
  type ServiceState,
  type AppSettings,
  type SettingsUpdate,
} from '@kai/contracts';
import { confirmDialog, messageDialog } from './AppDialog';
import { unwrap } from '../types';
import { BrainPanel } from './BrainView';
import { KnowledgeMap } from './KnowledgeMap';
import {
  applyClassifications,
  countOverrules,
  describeDecisions,
  draftCounts,
  draftRows,
  learnedCorrections,
  markFor,
  marksForAll,
  planDecisions,
  planTypeChanges,
  reviewRecap,
  type DraftMark,
  type DraftRow,
  type MarkBook,
} from './cognitive1-drafts';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
type Cognitive1Tab = 'overview' | 'review' | 'memory' | 'work' | 'toolbox';

const tabs: Array<{ id: Cognitive1Tab; label: string; help: string }> = [
  { id: 'overview', label: 'Overview', help: 'See whether C1 is working, what Overwatch has learned, and run its intelligence cycle.' },
  { id: 'review', label: 'Approvals', help: 'Only the decisions that need you: approve useful lessons, reject noise, or correct Overwatch.' },
  { id: 'memory', label: 'Knowledge', help: 'See and search everything your agents have learned about your projects and working style.' },
  { id: 'work', label: 'Agent work', help: 'Tasks, handoffs, reviews, regressions, and project Git status.' },
  { id: 'toolbox', label: 'Toolbox', help: 'Recovery, reusable skills, service diagnostics, and advanced controls.' },
];

/** What each tab needs before it can draw itself. Review is first because its queue is what usually needs a person. */
const tabLoads: Record<Cognitive1Tab, Cognitive1Operation[]> = {
  overview: ['brain-drafts', 'urgent-list', 'overwatch-status', 'overwatch-insights', 'metrics'],
  review: ['brain-drafts', 'urgent-list', 'overwatch-status', 'overwatch-insights'],
  memory: [],
  work: ['status', 'handoffs', 'tasks', 'reviews', 'regressions', 'git-status', 'integration-status'],
  toolbox: ['recover', 'recap-check', 'status', 'skills'],
};

/** The queue headline shown on the tab strip, so a backlog is visible from any tab. */
const headlineLoads: Cognitive1Operation[] = ['brain-drafts', 'urgent-list'];

interface OperationLoad {
  values: Partial<Record<Cognitive1Operation, unknown>>;
  failures: string[];
}

type Invoke = (operation: Cognitive1Operation, payload?: Record<string, unknown>) => Promise<unknown>;

export function Cognitive1Panel({
  service,
  projects,
  settings,
  onSaveSettings,
}: {
  service: ServiceState;
  projects: ProjectRecord[];
  settings: AppSettings;
  onSaveSettings: (update: SettingsUpdate) => Promise<boolean>;
}): ReactNode {
  const [tab, setTab] = useState<Cognitive1Tab>('overview');
  const [data, setData] = useState<Partial<Record<Cognitive1Operation, unknown>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the queue headline could not be read, when it could not. Kept apart from `error`, which is about an action. */
  const [headlineError, setHeadlineError] = useState<string | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const ready = service.status === 'ready';

  useEffect(() => {
    if (!ready) { setData({}); setBusy(null); setError(null); return; }
    const operations = tabLoads[tab];
    if (operations.length === 0) { setBusy(null); setError(null); return; }
    let active = true;
    setBusy(`Loading ${tab} data`);
    void loadOperations(operations).then(({ values, failures }) => {
      if (!active) return;
      setData((current) => ({ ...current, ...values }));
      setError(failures.length ? `${failures.length} C1 panel request(s) failed: ${failures[0]}` : null);
    }).finally(() => {
      if (active) setBusy(null);
    });
    return () => { active = false; };
  }, [ready, service.updatedAt, tab]);

  // The review queue decides nothing about the current tab, but its size belongs on the tab strip, so it is fetched
  // once per service change even while the user is somewhere else.
  useEffect(() => {
    if (!ready || tab === 'review') return;
    let active = true;
    // The failures matter as much as the values here. Without them a brain that cannot be reached renders as an empty
    // queue — the two are opposite facts and they used to look identical, which is exactly how a hundred waiting
    // drafts went unnoticed.
    void loadOperations(headlineLoads).then(({ values, failures }) => {
      if (!active) return;
      setData((current) => ({ ...current, ...values }));
      setHeadlineError(failures[0] ?? null);
    });
    return () => { active = false; };
  }, [ready, service.updatedAt, tab]);

  const queue = data['brain-drafts'];
  const headline = useMemo(() => draftCounts(draftRows(queue)), [queue]);
  const urgentCount = useMemo(() => records(data['urgent-list'], 'urgentNotes').length, [data]);

  async function invoke(operation: Cognitive1Operation, payload: Record<string, unknown> = {}): Promise<unknown> {
    setBusy(operationLabel(operation));
    setNotice(null);
    try {
      const result = await window.kaiDesktop.cognitive1Operation({ operation, payload }).then(unwrap);
      setData((current) => ({ ...current, [operation]: result }));
      setError(null);
      return result;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function run(
    operation: Cognitive1Operation,
    payload: Record<string, unknown> = {},
    message?: string,
    refresh = true,
  ): Promise<unknown> {
    const result = await invoke(operation, payload);
    if (result === null) return null;
    // What it produced, not just that it finished. "Cross-reference bugs completed." says nothing about whether it
    // matched forty bugs or none, which is the only thing the person wanted to know.
    setNotice(message ?? `${operationLabel(operation)}: ${describeOutcome(result)}`);
    if (refresh) await refreshCore();
    return result;
  }

  async function refreshCore(): Promise<void> {
    await reload(tabLoads[tab]);
  }

  /**
   * Re-reads chosen operations. Callers name what they actually changed so an unchanged draft queue keeps the
   * classifications already paid for: reloading it would return the same drafts under a new object, which the review
   * tab would read as a different queue and reset the verdicts on.
   */
  async function reload(operations: Cognitive1Operation[]): Promise<void> {
    if (!ready || operations.length === 0) return;
    const { values, failures } = await loadOperations(operations);
    setData((current) => ({ ...current, ...values }));
    setError(failures.length ? `${failures.length} C1 panel request(s) failed: ${failures[0]}` : null);
  }

  const disabled = !ready || Boolean(busy);

  async function setAutoApprove(enabled: boolean): Promise<void> {
    if (enabled) {
      const confirmed = await confirmDialog({
        title: 'Let Overwatch approve future lessons automatically?',
        detail: 'While KAI is running, Overwatch will check for new drafts every 15 minutes. It files drafts it judges keep, deletes high-confidence noise, and leaves uncertain drafts for you. These changes cannot be undone from this screen and may make model calls.',
        confirmLabel: 'Turn on automatic approval',
      });
      if (!confirmed) return;
    }
    setSavingAuto(true);
    try {
      const saved = await onSaveSettings({ cognitive1: { ...settings.cognitive1, overwatch: { ...settings.cognitive1.overwatch, autoApprove: enabled } } });
      if (saved) setNotice(enabled ? 'Automatic approval is on. Overwatch checks every 15 minutes while KAI runs.' : 'Automatic approval is off. Drafts will wait for your approval.');
    } finally { setSavingAuto(false); }
  }

  return (
    <section className="cognitive1-panel">
      <div className="cognitive1-control-heading">
        <div>
          <span className="eyebrow">C1 · your agents' shared intelligence</span>
          <h2>What your AI has learned</h2>
          <p>{headlineError
            ? `The brain could not be reached (${headlineError}).`
            : headline.total > 0
              ? `${headline.total} draft(s) are waiting right now.`
              : 'Nothing is waiting right now.'}</p>
          <details className="cognitive1-about"><summary>How C1 works</summary><p>C1 remembers useful lessons from every agent. Overwatch checks those lessons for quality, connects related knowledge, and learns from your corrections.</p></details>
        </div>
        <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void refreshCore()}>
          <RefreshCw size={14} className={busy?.startsWith('Loading') ? 'spin' : undefined} />
          <span>Refresh</span>
        </UiButton>
      </div>

      <nav className="cognitive1-tabs" aria-label="Cognitive1 sections">
        {tabs.map((item) => (
          <UiButton
            key={item.id}
            type="button"
            className={tab === item.id ? 'active' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'review' && headline.needsHuman > 0 && <Pill tone="warning">{headline.needsHuman}</Pill>}
          </UiButton>
        ))}
      </nav>

      <p className="cognitive1-tab-help">{tabs.find((item) => item.id === tab)?.help}</p>

      {notice && <div className="proxy-notice success"><CheckCircle2 size={15} /><span>{notice}</span><UiButton type="button" className="icon-button compact" aria-label="Dismiss C1 notice" onClick={() => setNotice(null)}><X size={14} /></UiButton></div>}
      {error && <div className="proxy-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><UiButton type="button" className="icon-button compact" aria-label="Dismiss C1 error" onClick={() => setError(null)}><X size={14} /></UiButton></div>}
      {busy && <div className="proxy-action-state"><RefreshCw size={14} className="spin" /><span>{busy}</span></div>}

      {tab === 'overview' && <OverwatchPanel data={data} projects={projects} disabled={disabled || savingAuto} onRun={run} autoApprove={settings.cognitive1.overwatch.autoApprove} onAutoApprove={setAutoApprove} />}
      {tab === 'review' && <ReviewPanel data={data} projects={projects} disabled={disabled} onInvoke={invoke} onReload={reload} onNotice={setNotice} />}
      {tab === 'memory' && <MemoryPanel data={data} projects={projects} disabled={disabled} onRun={run} onNotice={setNotice} service={service} />}
      {tab === 'work' && <WorkPanel data={data} projects={projects} disabled={disabled} onRun={run} />}
      {tab === 'toolbox' && <div className="cognitive1-toolbox"><RecoveryPanel data={data} projects={projects} disabled={disabled} onRun={run} /><SkillsPanel data={data} projects={projects} disabled={disabled} onRun={run} onInvoke={invoke} /><AdvancedPanel data={data} projects={projects} disabled={disabled} onRun={run} /></div>}
    </section>
  );
}

/**
 * The draft queue: what Overwatch decided, what it would not decide, and one place to act on either.
 *
 * Approving and rejecting are the same two endpoints the queue always had; what is new is that each draft carries an
 * Overwatch verdict and its own mark, so agreeing with Overwatch is a single click and disagreeing is one more.
 */
function ReviewPanel({
  data,
  projects,
  disabled,
  onInvoke,
  onReload,
  onNotice,
}: {
  data: PanelProps['data'];
  projects: ProjectRecord[];
  disabled: boolean;
  onInvoke: Invoke;
  onReload: (operations: Cognitive1Operation[]) => Promise<void>;
  onNotice: (message: string | null) => void;
}): ReactNode {
  const queue = data['brain-drafts'];
  const [marks, setMarks] = useState<MarkBook>({});
  const [adoptTypes, setAdoptTypes] = useState(true);
  const [applying, setApplying] = useState(false);
  const [classifying, setClassifying] = useState(false);
  // Classifications are keyed to the exact queue payload they came from: once the queue changes they describe drafts
  // that are no longer at those positions, so they are dropped rather than applied to the wrong entries.
  const [classified, setClassified] = useState<{ queue: unknown; value: unknown } | null>(null);

  const rows = useMemo(() => {
    const base = draftRows(queue);
    return classified && classified.queue === queue ? applyClassifications(base, classified.value) : base;
  }, [queue, classified]);
  const counts = useMemo(() => draftCounts(rows), [rows]);
  const decisions = useMemo(() => planDecisions(rows, marks), [rows, marks]);
  // `suggested` is every retype Overwatch would make, so the toggle can say how many it is holding back.
  const suggested = useMemo(() => planTypeChanges(rows, decisions, true), [rows, decisions]);
  const typeChanges = useMemo(() => planTypeChanges(rows, decisions, adoptTypes), [rows, decisions, adoptTypes]);
  const overrules = useMemo(() => countOverrules(rows, decisions), [rows, decisions]);
  const overwatchStatus = recordOf(data['overwatch-status']);
  const insights = arrayOf(recordOf(data['overwatch-insights']).insights);
  const urgentNotes = records(data['urgent-list'], 'urgentNotes');
  const pending = decisions.length + typeChanges.length;
  const recap = useMemo(() => reviewRecap({
    counts,
    overwatch: { enabled: overwatchStatus.enabled === true, ready: overwatchStatus.ready === true },
    urgentCount: urgentNotes.length,
    insights: insights.map((insight) => String(insight.message ?? '')).filter((message) => message.length > 0),
  }), [counts, overwatchStatus.enabled, overwatchStatus.ready, urgentNotes.length, insights]);

  function setMark(row: DraftRow, mark: DraftMark): void {
    setMarks((current) => ({ ...current, [row.index]: { title: row.title, mark } }));
  }

  async function classify(): Promise<void> {
    setClassifying(true);
    try {
      const result = await onInvoke('overwatch-resolve-preview');
      if (result === null) return;
      setClassified({ queue, value: result });
      const merged = draftCounts(applyClassifications(rows, result));
      onNotice(merged.unclassified === 0
        ? `Overwatch has a verdict on all ${merged.total} draft(s).`
        : `Overwatch classified ${merged.total - merged.unclassified} of ${merged.total} draft(s); ${merged.unclassified} came back without one.`);
    } finally {
      setClassifying(false);
    }
  }

  /** The note list is one of this tab's four loads, so only it is re-read; the draft queue is left untouched. */
  async function saveUrgentNote(payload: Record<string, unknown>): Promise<boolean> {
    if ((await onInvoke('urgent-set', payload)) === null) return false;
    await onReload(['urgent-list']);
    onNotice('Urgent note saved.');
    return true;
  }

  async function clearUrgentNotes(): Promise<void> {
    if (urgentNotes.length === 0) return;
    const confirmed = await confirmDialog({
      title: 'Clear every urgent note?',
      detail: `${urgentNotes.length} pinned warning(s) will be removed for every agent reading this brain.`,
      confirmLabel: 'Clear urgent notes',
      destructive: true,
    });
    if (!confirmed) return;
    if ((await onInvoke('urgent-clear')) === null) return;
    await onReload(['urgent-list']);
    onNotice('All urgent notes cleared.');
  }

  async function apply(): Promise<void> {
    if (pending === 0) return;
    const { approvals, rejections } = describeDecisions(decisions);
    const actions = [
      approvals > 0 ? `approve ${approvals} draft(s) into the brain` : null,
      rejections > 0 ? `delete ${rejections} draft(s) from the queue` : null,
      typeChanges.length > 0 ? `file ${typeChanges.length} approval(s) under the type Overwatch suggested` : null,
    ].filter(Boolean).join(', ');
    const detail = actions.charAt(0).toUpperCase() + actions.slice(1);
    const teaching = overrules > 0
      ? ` ${overrules} of these overrule Overwatch, and C1 will show it those corrections when it judges future drafts.`
      : '';
    const confirmed = await confirmDialog({
      title: 'Apply these draft decisions?',
      detail: `${detail}. Rejected drafts are removed without being filed, and approving cannot be undone from here.${teaching}`,
      confirmLabel: `Apply ${decisions.length} decision(s)`,
      destructive: rejections > 0,
    });
    if (!confirmed) return;

    setApplying(true);
    let failures = 0;
    try {
      // Types first: an approved block is copied verbatim, so its `#type:` has to be right before it is filed. Both
      // loops run highest index first because each call renumbers everything below it.
      for (const change of typeChanges) {
        if ((await onInvoke('brain-draft-type', { index: change.index, type: change.type })) === null) failures += 1;
      }
      for (const decision of decisions) {
        const operation = decision.action === 'approve' ? 'brain-draft-approve' : 'brain-draft-reject';
        if ((await onInvoke(operation, { index: decision.index })) === null) failures += 1;
      }
    } finally {
      setApplying(false);
    }
    setMarks({});
    // Status too: an overrule changes the count of corrections Overwatch has learned.
    await onReload(['brain-drafts', 'overwatch-status']);
    onNotice(failures === 0
      ? `Applied ${decisions.length} decision(s): ${approvals} approved, ${rejections} rejected.`
      : `Applied ${decisions.length - failures} of ${decisions.length} decision(s). ${failures} request(s) failed; the queue is unchanged for those.`);
  }

  return (
    <div className="cognitive1-page">
      <section className="cognitive1-card cognitive1-recap">
        <SectionHeading eyebrow="What needs you" title="Overwatch recap" icon={<Info size={16} />} />
        <ul className="cognitive1-recap-lines">
          {recap.map((line) => <li className={line.tone} key={line.text}>{line.text}</li>)}
        </ul>
      </section>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Quality queue" title={`Draft review (${counts.total})`} icon={<ClipboardCheck size={16} />} />
        <div className="cognitive1-verdict-summary">
          <VerdictCount label="Keep" value={counts.keep} tone="keep" />
          <VerdictCount label="Noise" value={counts.noise} tone="noise" />
          <VerdictCount label="Borderline" value={counts.borderline} tone="borderline" />
          <VerdictCount label="No verdict" value={counts.unclassified} tone="unknown" />
        </div>

        <div className="cognitive1-actions">
          <UiButton
            type="button"
            className="secondary-button"
            disabled={disabled || classifying || counts.unclassified === 0}
            title={counts.unclassified === 0 ? 'Every draft already carries a verdict.' : undefined}
            onClick={() => void classify()}
          >
            {classifying ? <RefreshCw size={13} className="spin" /> : <Eye size={13} />}
            <span>Ask Overwatch about {counts.unclassified} draft(s)</span>
          </UiButton>
          <UiButton type="button" className="secondary-button" disabled={disabled || counts.total === 0} onClick={() => setMarks({})}>Use Overwatch's verdicts</UiButton>
          <UiButton type="button" className="secondary-button" disabled={disabled || counts.total === 0} onClick={() => setMarks(marksForAll(rows, null))}>Hold everything</UiButton>
        </div>
        <p className="cognitive1-copy">
          Asking Overwatch costs one model call for each draft that has no verdict yet. Drafts it has already
          annotated are reused for free, and the answer is a preview: nothing is filed or deleted until you apply.
        </p>

        {pending > 0 && (
          <div className="cognitive1-mark-bar">
            <div>
              <strong>{decisions.length + typeChanges.length} change(s) ready</strong>
              <span>
                {describeDecisions(decisions).approvals} to approve, {describeDecisions(decisions).rejections} to reject
                {typeChanges.length > 0 ? `, ${typeChanges.length} to refile` : ''}
              </span>
              {overrules > 0 && (
                <span className="cognitive1-teaching">
                  {overrules} of these overrule Overwatch. It will be shown them as corrections next time.
                </span>
              )}
            </div>
            <div className="cognitive1-actions">
              <UiButton type="button" className="secondary-button" disabled={disabled || applying} onClick={() => setMarks({})}>Reset marks</UiButton>
              <UiButton type="button" className="primary-button" disabled={disabled || applying} onClick={() => void apply()}>
                {applying ? <RefreshCw size={13} className="spin" /> : <ListChecks size={13} />}
                <span>{applying ? 'Applying' : `Apply ${pending} change(s)`}</span>
              </UiButton>
            </div>
          </div>
        )}

        {suggested.length > 0 && (
          <label className="cognitive1-adopt">
            <Checkbox checked={adoptTypes} onChange={(event) => setAdoptTypes(event.target.checked)} />
            <span>File {suggested.length} approval(s) under the type Overwatch suggested before approving</span>
          </label>
        )}

        <div className="cognitive1-list">
          {rows.map((row) => (
            <DraftCard
              key={`${row.index}-${row.title}`}
              row={row}
              mark={markFor(row, marks)}
              disabled={disabled || applying}
              onMark={(mark) => setMark(row, mark)}
            />
          ))}
          {rows.length === 0 && <EmptyText>No drafts are waiting for review.</EmptyText>}
        </div>
      </section>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Attention" title={`Urgent notes (${urgentNotes.length})`} icon={<Siren size={16} />} />
        <div className="cognitive1-list compact">
          {urgentNotes.map((note, index) => (
            <div className="cognitive1-note" key={`${note.project ?? 'global'}-${index}`}>
              <strong>{String(note.project ?? 'global')}</strong>
              <span>{String(note.what ?? '')}</span>
              {Boolean(note.do) && <small>Do: {String(note.do)}</small>}
              {Boolean(note.doNot) && <small>Do not: {String(note.doNot)}</small>}
            </div>
          ))}
          {urgentNotes.length === 0 && <EmptyText>No urgent warnings.</EmptyText>}
        </div>
        <UrgentNoteForm projects={projects} disabled={disabled} onSave={saveUrgentNote} onClearAll={() => void clearUrgentNotes()} />
      </section>
    </div>
  );
}

/** One draft, its verdict, and its two marks. Clicking the active mark again clears it back to "leave it". */
function DraftCard({
  row,
  mark,
  disabled,
  onMark,
}: {
  row: DraftRow;
  mark: DraftMark;
  disabled: boolean;
  onMark: (mark: DraftMark) => void;
}): ReactNode {
  const refile = row.suggestedType !== null && row.suggestedType !== row.type;
  const meta = [
    row.type,
    row.project ? row.project : `from ${row.agent}`,
    row.tags.length > 0 ? row.tags.map((tag) => `#${tag}`).join(' ') : null,
  ].filter(Boolean).join(' - ');

  return (
    <article className="cognitive1-draft">
      <div className="cognitive1-draft-head">
        <VerdictBadge row={row} />
        <div className="cognitive1-draft-title">
          <strong>{row.title}</strong>
          <small>{meta}</small>
        </div>
        <div className="cognitive1-mark-pair" role="group" aria-label={`Decision for ${row.title}`}>
          <UiButton
            type="button"
            className={mark === 'approve' ? 'cognitive1-mark approve active' : 'cognitive1-mark approve'}
            aria-pressed={mark === 'approve'}
            disabled={disabled}
            onClick={() => onMark(mark === 'approve' ? null : 'approve')}
          >
            Approve
          </UiButton>
          <UiButton
            type="button"
            className={mark === 'reject' ? 'cognitive1-mark reject active' : 'cognitive1-mark reject'}
            aria-pressed={mark === 'reject'}
            disabled={disabled}
            onClick={() => onMark(mark === 'reject' ? null : 'reject')}
          >
            Reject
          </UiButton>
        </div>
      </div>
      {row.reason && <p className="cognitive1-draft-reason">{row.reason}</p>}
      {refile && <span className="cognitive1-suggested">Overwatch would file this under {row.suggestedType}</span>}
    </article>
  );
}

function VerdictBadge({ row }: { row: DraftRow }): ReactNode {
  const verdict = row.verdict ?? 'unclassified';
  const label = row.verdict === null ? 'No verdict' : row.verdict;
  const percent = row.confidence === null ? null : `${Math.round(row.confidence * 100)}%`;
  return (
    <span
      className={`cognitive1-verdict ${verdict}`}
      title={row.verdictSource === 'overwatch' ? 'From the last Overwatch classification' : row.verdictSource === 'annotation' ? "From Overwatch's own note in the draft" : 'Overwatch has not judged this draft'}
    >
      {label}{percent && <em>{percent}</em>}
    </span>
  );
}

function VerdictCount({ label, value, tone }: { label: string; value: number; tone: string }): ReactNode {
  return (
    <div className={`cognitive1-verdict-count ${tone} ${value === 0 ? 'zero' : ''}`}>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function UrgentNoteForm({ projects, disabled, onSave, onClearAll }: { projects: ProjectRecord[]; disabled: boolean; onSave: (payload: Record<string, unknown>) => Promise<boolean>; onClearAll: () => void }): ReactNode {
  const [project, setProject] = useState(projects[0]?.name ?? 'global');
  const [what, setWhat] = useState('');
  const [action, setAction] = useState('');
  const [doNot, setDoNot] = useState('');
  return (
    <form className="cognitive1-form" onSubmit={(event) => {
      event.preventDefault();
      void onSave({ project, what, do: action, do_not: doNot, agent: 'kai-desktop' }).then((saved) => {
        if (!saved) return;
        setWhat(''); setAction(''); setDoNot('');
      });
    }}>
      <ProjectPicker label="Project" value={project} projects={projects} onChange={setProject} />
      <TextField label="What is urgent" value={what} onChange={setWhat} />
      <TextField label="Required action" value={action} onChange={setAction} />
      <TextField label="Do not" value={doNot} onChange={setDoNot} />
      <div className="cognitive1-actions">
        <UiButton type="submit" className="primary-button" disabled={disabled || !what.trim()}>Set urgent note</UiButton>
        <UiButton type="button" className="secondary-button danger-button" disabled={disabled} onClick={onClearAll}>Clear all</UiButton>
      </div>
    </form>
  );
}

/**
 * The Overwatch engine on its own screen: what it is doing, what it has found, and the one place that says honestly
 * which of its judgements are automatic and which always come back to a person.
 */
function OverwatchPanel({ data, disabled, onRun, autoApprove, onAutoApprove }: PanelProps & { autoApprove: boolean; onAutoApprove: (enabled: boolean) => Promise<void> }): ReactNode {
  const overwatch = recordOf(data['overwatch-status']);
  const insights = arrayOf(recordOf(data['overwatch-insights']).insights);
  const metrics = recordOf(data.metrics);
  const queueCounts = draftCounts(draftRows(data['brain-drafts']));
  const learned = Number(overwatch.precedents ?? 0);
  const knowledgeTotal = Number(metrics.totalBugs ?? 0) + Number(metrics.totalDecisions ?? 0) + Number(metrics.totalGotchas ?? 0) + Number(metrics.totalPatterns ?? 0);
  const automationScore = overwatch.ready === true ? (queueCounts.total === 0 ? 100 : Math.round(((queueCounts.keep + queueCounts.noise) / queueCounts.total) * 100)) : 0;
  const duplicates = arrayOf(recordOf(data['overwatch-semantic-dupes']).duplicates);
  const bugRefs = arrayOf(recordOf(data['overwatch-cross-ref-bugs']).bugRefs);
  // A full cycle returns the audit alongside its classifications, so either action can be the one that produced it.
  const audited = recordOf(recordOf(data['overwatch-audit']).audit);
  const audit = Object.keys(audited).length > 0 ? audited : recordOf(recordOf(data['overwatch-run']).audit);
  const distill = recordOf(data['overwatch-distill-kernels']);
  const pushed = recordOf(data['overwatch-push-to-memory']);
  const resolved = recordOf(recordOf(data['overwatch-resolve']).resolved);
  const knowledgeGaps = stringsOf(audit.knowledgeGaps);
  const crossPatterns = stringsOf(audit.crossProjectPatterns);
  const kernels = stringsOf(distill.written);
  /** Whether anything was distilled or pushed, which is what decides if this card has a second column at all. */
  const hasDistillation = kernels.length > 0
    || arrayOf(distill.skipped).length > 0
    || arrayOf(pushed.pushed).length > 0
    || arrayOf(pushed.failed).length > 0;

  const state = overwatch.enabled !== true
    ? { tone: 'warn', title: 'Overwatch is not configured', detail: 'C1 can still store memory, but nothing judges the drafts it collects. Set a provider, a model and an API key under Settings, C1 Brain, AI Overwatch.' }
    : overwatch.ready !== true
      ? { tone: 'warn', title: 'Overwatch has no API key', detail: `It is set to ${String(overwatch.provider ?? 'a provider')} with ${String(overwatch.model ?? 'no model')}, but no key is stored, so drafting and auditing stay switched off.` }
      : { tone: 'good', title: 'Overwatch is ready', detail: `${String(overwatch.provider ?? '')} - ${String(overwatch.model ?? '')} - ${String(overwatch.baseUrl ?? '')}` };

  return (
    <div className="cognitive1-page">
      <section className="cognitive1-command-card">
        <div className="cognitive1-command-copy">
          <span className={`cognitive1-live-dot ${overwatch.ready === true ? 'good' : 'warn'}`} />
          <div>
            <span className="eyebrow">Intelligence status</span>
            <h3>{state.title}</h3>
            <p>{state.detail}</p>
          </div>
        </div>
        <div className="cognitive1-gauges" aria-label="C1 intelligence gauges">
          <IntelligenceGauge label="Reviewed" value={automationScore} detail={`${queueCounts.needsHuman} need you`} />
          <IntelligenceGauge label="Knowledge" value={Math.min(100, knowledgeTotal)} detail={`${knowledgeTotal} lessons`} />
          <IntelligenceGauge label="Adaptation" value={Math.min(100, learned * 10)} detail={`${learned} corrections learned`} />
        </div>
        <label className="toggle-row cognitive1-auto-toggle">
          <span><strong>Auto approve useful lessons</strong><small>{autoApprove ? 'On: Overwatch checks every 15 minutes while KAI runs. Uncertain drafts still wait for you.' : 'Off: Overwatch suggests; you decide in Approvals.'}</small></span>
          <Checkbox checked={autoApprove} disabled={disabled || (!autoApprove && overwatch.ready !== true)} onChange={(event) => void onAutoApprove(event.target.checked)} />
        </label>
      </section>

      <section className="cognitive1-card cognitive1-learning-loop">
        <SectionHeading eyebrow="How it works" title="C1's learning loop" icon={<Brain size={16} />} />
        <div className="cognitive1-flow">
          <div><span>1</span><strong>Agents notice</strong><small>Useful bugs, decisions, gotchas and patterns become draft lessons.</small></div>
          <i>→</i>
          <div><span>2</span><strong>Overwatch judges</strong><small>It removes noise, finds duplicates and spots missing knowledge.</small></div>
          <i>→</i>
          <div><span>3</span><strong>You teach</strong><small>Approve, reject, or correct uncertain calls in Approvals.</small></div>
          <i>→</i>
          <div><span>4</span><strong>Agents improve</strong><small>Approved knowledge and your corrections guide their next task.</small></div>
        </div>
      </section>

      <div className="cognitive1-metric-strip">
        <Metric label="Sessions" value={numberText(metrics.totalSessions)} />
        <Metric label="Bugs" value={numberText(metrics.totalBugs)} />
        <Metric label="Decisions" value={numberText(metrics.totalDecisions)} />
        <Metric label="Gotchas" value={numberText(metrics.totalGotchas)} />
        <Metric label="Patterns" value={numberText(metrics.totalPatterns)} />
        <Metric label="Overwatch" value={overwatch.ready === true ? 'Ready' : overwatch.enabled === true ? 'No key' : 'Off'} tone={overwatch.ready === true ? 'good' : 'warn'} />
      </div>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Engine" title="Overwatch status" icon={<Eye size={16} />} />
          <div className={`cognitive1-status ${state.tone}`}>
            <strong>{state.title}</strong>
            <span>{state.detail}</span>
          </div>
          <h4 className="cognitive1-subheading">How a verdict is acted on</h4>
          <ul className="cognitive1-rules">
            <li><b>keep</b> waits for you to approve it under Review. Only "Let Overwatch clear the queue" below files it without asking.</li>
            <li><b>noise</b> at or above the auto-reject threshold is deleted from the queue without asking.</li>
            <li><b>noise</b> below it, and every <b>borderline</b>, stays in the queue for you.</li>
          </ul>
          <p className="cognitive1-copy">
            The auto-reject threshold and the provider settings live under Settings, C1 Brain, AI Overwatch.
          </p>
          <LearningNote precedents={overwatch.precedents} />
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Recommended action" title="Improve the brain now" icon={<Play size={16} />} />
          <p className="cognitive1-copy"><b>Run intelligence cycle</b> reviews new drafts and audits existing memory in one pass. It finds quality problems but does not approve keep decisions for you.</p>
          <div className="cognitive1-actions">
            <UiButton type="button" className="primary-button" disabled={disabled} onClick={() => void onRun('overwatch-run', {}, 'Overwatch full cycle completed.')}><Play size={13} /><span>Run intelligence cycle</span></UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} title="Checks saved knowledge for duplicates, gaps and patterns. It does not approve or delete drafts." onClick={() => void onRun('overwatch-audit', {}, 'Audit completed.')}>Check memory quality</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-semantic-dupes', {}, 'Duplicate scan completed.')}>Find duplicates</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-cross-ref-bugs', {}, 'Bug cross-reference completed.')}>Cross-reference bugs</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} title="Turns a project's scattered lessons into a short guide agents can load quickly." onClick={() => void onRun('overwatch-distill-kernels', {}, 'Project kernels distilled.')}>Create project guides</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} title="Makes the new project guides available to connected agents." onClick={() => void onRun('overwatch-push-to-memory', {}, 'Kernels pushed to memory.')}>Send guides to agents</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} title="Compare every note and link the ones about the same thing, which is what fills the knowledge map" onClick={() => void onRun('overwatch-link', {}, 'Related notes linked. See the result on the Memory tab.')}>Link related notes</UiButton>
            <UiButton
              type="button"
              className="secondary-button danger-button"
              disabled={disabled}
              onClick={() => void confirmDialog({
                title: 'Delete heuristic noise drafts?',
                detail: 'Drafts whose titles match C1\'s noise keywords are deleted from the queue immediately, without a model call and without being filed. This cannot be undone.',
                confirmLabel: 'Delete noise drafts',
                destructive: true,
              }).then((confirmed) => {
                if (!confirmed) return;
                void onRun('overwatch-heuristic-clean', {}, 'Heuristic noise drafts deleted.');
              })}
            >Delete keyword noise…</UiButton>
          </div>
          {/*
            What each button does, written out rather than left in a `title`.

            Every one of these ran something and then said only "… completed." at the top of the panel, so the only
            way to know what a button had done was to hover it for a tooltip and then read a banner several cards
            away. The list says what the action changes — and, for the ones that change nothing, that they change
            nothing, which is the part that decides whether it is safe to press.
          */}
          <dl className="cognitive1-action-notes">
            <div><dt>Run intelligence cycle</dt><dd>Reviews new drafts and audits saved memory in one pass. Findings appear below; keep decisions still wait for you.</dd></div>
            <div><dt>Check memory quality</dt><dd>Reports duplicates, gaps and cross-project patterns. Changes nothing.</dd></div>
            <div><dt>Find duplicates</dt><dd>Lists pairs of notes that look like the same lesson, in the card on the left. Changes nothing.</dd></div>
            <div><dt>Cross-reference bugs</dt><dd>Matches bug notes to the commits that fixed them, in the card on the right. Changes nothing.</dd></div>
            <div><dt>Create project guides</dt><dd>Writes a short guide per project from its saved lessons, so an agent can load what matters without reading everything.</dd></div>
            <div><dt>Send guides to agents</dt><dd>Makes those guides available to connected agents. Nothing reaches an agent until this is pressed.</dd></div>
            <div><dt>Link related notes</dt><dd>Links notes about the same thing, which is what draws the lines on the Memory tab.</dd></div>
            <div><dt>Delete keyword noise…</dt><dd>Deletes saved drafts whose titles match C1's noise words, immediately and without asking a model. The only action here that removes anything — it asks first.</dd></div>
          </dl>
        </section>
      </div>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Memory approval" title="Who decides what gets saved?" icon={<Archive size={16} />} />
        <p className="cognitive1-copy">
          For a one-time pass, Overwatch files every draft it judges <b>keep</b> into the brain,
          <b> noise</b> at or above the auto-reject threshold is deleted, and uncertain noise and anything
          <b> borderline</b> is annotated and left for you. The Approvals tab lets you preview and choose each draft.
          A one-time automatic pass cannot be undone from this screen.
        </p>
        <div className="cognitive1-actions">
          <UiButton
            type="button"
            className="secondary-button danger-button"
            disabled={disabled || overwatch.ready !== true}
            onClick={() => void confirmDialog({
              title: 'Let Overwatch resolve the whole queue?',
              detail: 'It will file everything it judges keep without asking you, delete noise at or above the auto-reject threshold, and leave uncertain noise and borderline drafts annotated for you. This runs model calls and cannot be undone.',
              confirmLabel: 'Resolve the queue',
              destructive: true,
            }).then((confirmed) => {
              if (!confirmed) return;
              void onRun('overwatch-resolve', {}, 'Overwatch resolved the draft queue.');
            })}
          >Approve Overwatch's choices now…</UiButton>
        </div>
        {Object.keys(resolved).length > 0 && (
          <p className="cognitive1-copy">Last resolve: {String(resolved.approved ?? 0)} filed, {String(resolved.rejected ?? 0)} deleted, {String(resolved.skipped ?? 0)} left.</p>
        )}
      </section>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Findings" title={`Duplicate candidates (${duplicates.length})`} icon={<Archive size={16} />} />
          <p className="cognitive1-copy">
            Two saved notes that look like the same lesson, and how alike they read — <b>% alike</b> is a similarity
            score, not a confidence. Nothing has been merged or deleted: this is a list to look down, and the useful
            signal is a high score against two notes whose titles say the same thing in different words.
          </p>
          <div className="cognitive1-list compact">
            <Findings
              items={duplicates}
              empty={<EmptyText>No duplicate scan has run yet, or no candidates were found.</EmptyText>}
              render={(item, index) => {
                const pair = recordOf(item);
                return (
                  <div className="cognitive1-note" key={`dupe-${index}`}>
                    <strong>{Math.round(Number(pair.score ?? 0) * 100)}% alike</strong>
                    <span>{String(pair.entryA ?? '')}</span>
                    <span>{String(pair.entryB ?? '')}</span>
                  </div>
                );
              }}
            />
          </div>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Findings" title={`Bug cross-references (${bugRefs.length})`} icon={<GitBranch size={16} />} />
          <p className="cognitive1-copy">
            A bug note matched to the commit that appears to have fixed it, so a bug that keeps coming back can be
            traced to the change behind it. <b>% confident</b> is the matcher's own score. An empty list here usually
            means the bug notes name no commit, not that the work is missing.
          </p>
          <div className="cognitive1-list compact">
            <Findings
              items={bugRefs}
              empty={<EmptyText>No bug cross-reference has run yet, or nothing was matched.</EmptyText>}
              render={(item, index) => {
                const ref = recordOf(item);
                return (
                  <div className="cognitive1-note" key={`bugref-${index}`}>
                    <strong>{Math.round(Number(ref.confidence ?? 0) * 100)}% confident</strong>
                    <span>{String(ref.bug ?? '')}</span>
                    <span>commit {String(ref.commit ?? '')}</span>
                  </div>
                );
              }}
            />
          </div>
        </section>
      </div>

      {(Object.keys(audit).length > 0 || Object.keys(distill).length > 0 || Object.keys(pushed).length > 0) && (
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Findings" title="Audit and distillation" icon={<Activity size={16} />} />
          {/*
            What these two lists are, because the labels alone do not say and the entries are a model's sentences.

            A gap is a lesson the brain holds once, inside one entry about something else, that would be worth an entry
            of its own — the same mistake is likely to be made again by someone who never reads that entry. A
            cross-project pattern is the same lesson found in two projects: it is the evidence that a gap is real
            rather than a guess. Neither changes anything; they are candidates for you to agree with.
          */}
          <p className="cognitive1-copy">
            A model read the whole brain and named two kinds of thing. A <b>gap</b> is a lesson that appears inside one
            entry about something else, so only someone who happened to read that entry would find it. A
            <b> cross-project</b> row is the same lesson turning up in two projects, which is the evidence a gap is
            real rather than a guess. Nothing is written or changed by either: they are suggestions for entries you
            might add.
          </p>
          <div className={hasDistillation ? 'cognitive1-grid two' : undefined}>
            <div className="cognitive1-list compact">
              {Object.keys(audit).length > 0 && (
                <>
                  <div className="cognitive1-note">
                    <strong>What the audit found</strong>
                    <span>{countPhrase(knowledgeGaps.length, 'gap')}, {countPhrase(crossPatterns.length, 'cross-project pattern')} and {countPhrase(Number(audit.duplicatesFound) || 0, 'duplicate pair')}.</span>
                  </div>
                  {knowledgeGaps.length > 0 && (
                    <Findings
                      items={knowledgeGaps}
                      empty={null}
                      render={(item, index) => (
                        <div className="cognitive1-note" key={`gap-${index}`}>
                          <strong>Gap</strong>
                          <Markdown text={String(item)} />
                        </div>
                      )}
                    />
                  )}
                  {crossPatterns.length > 0 && (
                    <Findings
                      items={crossPatterns}
                      empty={null}
                      render={(item, index) => (
                        <div className="cognitive1-note" key={`pattern-${index}`}>
                          <strong>Cross-project</strong>
                          <Markdown text={String(item)} />
                        </div>
                      )}
                    />
                  )}
                </>
              )}
            </div>
            {/* Rendered only when there is something in it: an empty second column was half the card's width of
                nothing, which is what made this section look like it had failed to load. */}
            {hasDistillation && (
              <div className="cognitive1-list compact">
                {kernels.length > 0 && <div className="cognitive1-note"><strong>Kernels distilled</strong><span>{kernels.join(', ')}</span></div>}
                {arrayOf(distill.skipped).map((item, index) => <div className="cognitive1-note" key={`skip-${index}`}><strong>Skipped {String(item.project ?? '')}</strong><span>{String(item.reason ?? 'no reason given')}</span></div>)}
                {arrayOf(pushed.pushed).length > 0 && <div className="cognitive1-note"><strong>Pushed to memory</strong><span>{arrayOf(pushed.pushed).map((item) => String(item.project ?? '')).join(', ')}</span></div>}
                {arrayOf(pushed.failed).map((item, index) => <div className="cognitive1-note" key={`fail-${index}`}><strong>Push failed {String(item.project ?? '')}</strong><span>{String(item.error ?? '')}</span></div>)}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Recent activity" title={`Overwatch insights (${insights.length})`} icon={<Activity size={16} />} />
        <p className="cognitive1-copy">C1 keeps the last hundred insights in memory only, so they clear when the daemon restarts.</p>
        <div className="cognitive1-list compact">
          {insights.map((insight, index) => (
            <div className="cognitive1-note" key={`insight-${index}`}>
              <strong>{String(insight.category ?? 'overwatch')} - {timestampText(insight.timestamp)}</strong>
              <span>{String(insight.message ?? '')}</span>
              {Boolean(insight.detail) && <small>{String(insight.detail)}</small>}
            </div>
          ))}
          {insights.length === 0 && <EmptyText>No Overwatch activity has been recorded since the daemon started.</EmptyText>}
        </div>
      </section>
    </div>
  );
}

/** Memory: what C1 knows, how to add to it, and how to take things out. */
function MemoryPanel({ data, projects, disabled, onRun, onNotice, service }: PanelProps & { service: ServiceState; onNotice: (message: string) => void }): ReactNode {
  const prunePreview = recordOf(data['brain-prune']);
  const prunableTotal = (Number(prunePreview.handoffs ?? 0)) + (Number(prunePreview.dailyLogs ?? 0)) + (Number(prunePreview.resolvedEntries ?? 0));
  const [pruneTitle, setPruneTitle] = useState('');

  return (
    <div className="cognitive1-page">
      <KnowledgeMap disabled={disabled} onNotice={onNotice} />
      <div className="cognitive1-grid two">
        <BrainLearnCard projects={projects} disabled={disabled} onRun={onRun} />

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Retention" title="Prune and audit" icon={<Trash2 size={16} />} />
          <p className="cognitive1-copy">Run a non-destructive prune preview, or delete entries matching a title after confirmation.</p>
          <div className="cognitive1-actions">
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('brain-prune', {}, 'Prune preview loaded.')}>Preview age-based prune</UiButton>
            <UiButton
              type="button"
              className="secondary-button danger-button"
              disabled={disabled || prunableTotal === 0}
              title={prunableTotal === 0 ? 'Preview the prune first; nothing is deleted until you confirm.' : undefined}
              onClick={() => void confirmDialog({
                title: 'Apply age-based prune?',
                detail: `Delete ${prunePreview.handoffs ?? 0} old handoffs, ${prunePreview.dailyLogs ?? 0} old daily logs and ${prunePreview.resolvedEntries ?? 0} resolved entries? This cannot be undone.`,
                confirmLabel: 'Apply prune',
                destructive: true,
              }).then((confirmed) => {
                if (!confirmed) return;
                void window.kaiDesktop.cognitive1Tool({ tool: 'brain_prune', arguments: { execute: true } })
                  .then(() => onRun('brain-prune', {}, 'Age-based prune applied.'));
              })}
            >Apply prune…</UiButton>
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('brain-auto-learn', { source: 'manual', type: 'patterns', title: 'Manual auto-learn check', fields: { note: 'Desktop maintenance check' }, require_approval: true }, 'Auto-learn check completed.')}>Run auto-learn check</UiButton>
          </div>
          <div className="cognitive1-inline-form">
            <TextField label="Exact entry title" value={pruneTitle} onChange={setPruneTitle} />
            <UiButton
              type="button"
              className="secondary-button danger-button"
              disabled={disabled || !pruneTitle.trim()}
              onClick={() => void confirmDialog({
                title: 'Delete matching brain entries?',
                detail: `Delete brain entries titled "${pruneTitle.trim()}"?`,
                confirmLabel: 'Delete entries',
                destructive: true,
              }).then((confirmed) => {
                if (!confirmed) return;
                void onRun('brain-prune', { target_title: pruneTitle.trim() }, 'Targeted brain entries deleted.');
              })}
            >
              Delete matching titles
            </UiButton>
          </div>
          <JsonPreview value={data['brain-prune']} />
        </section>
      </div>

      <BrainPanel service={service} />
    </div>
  );
}

function BrainLearnCard({ projects, disabled, onRun }: { projects: ProjectRecord[]; disabled: boolean; onRun: PanelProps['onRun'] }): ReactNode {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<BrainEntryType>('gotchas');
  const [project, setProject] = useState(projects[0]?.name ?? '');
  const [agent, setAgent] = useState('kai-desktop');
  const [tags, setTags] = useState('');
  const [fact, setFact] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [fieldValue, setFieldValue] = useState('');

  async function learn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return;
    const payload: Record<string, unknown> = { title: title.trim(), type, project: project.trim() || 'global', agent, tags, fact };
    if (fieldName.trim() && fieldValue.trim()) payload[fieldName.trim()] = fieldValue.trim();
    const result = recordOf(await onRun('brain-learn', payload, 'Memory entry submitted.'));
    if (result.rejected) {
      void messageDialog({ title: 'Memory entry rejected', detail: String(result.reason ?? 'The quality gate rejected the entry.') });
      return;
    }
    setTitle(''); setFact(''); setFieldName(''); setFieldValue('');
  }

  return (
    <section className="cognitive1-card">
      <SectionHeading eyebrow="Durable knowledge" title="Learn an entry" icon={<Brain size={16} />} />
      <form className="cognitive1-form" onSubmit={(event) => void learn(event)}>
        <TextField label="Title" value={title} onChange={setTitle} />
        <div className="field-grid two">
          <label className="field"><span>Type</span><Select value={type} onChange={(event) => setType(event.target.value as BrainEntryType)}><option value="bugs">Bug</option><option value="decisions">Decision</option><option value="gotchas">Gotcha</option><option value="patterns">Pattern</option></Select></label>
          <ProjectPicker label="Project" value={project} projects={projects} onChange={setProject} />
          <TextField label="Agent" value={agent} onChange={setAgent} />
          <TextField label="Tags" value={tags} onChange={setTags} />
          <TextField label="Optional field name" value={fieldName} onChange={setFieldName} />
          <TextField label="Optional field value" value={fieldValue} onChange={setFieldValue} />
        </div>
        <label className="field"><span>Knowledge</span><Textarea rows={5} value={fact} onChange={(event) => setFact(event.target.value)} placeholder="What should future agents know?" /></label>
        <div className="cognitive1-actions"><UiButton type="submit" className="primary-button" disabled={disabled || !title.trim() || !fact.trim()}>Learn entry</UiButton></div>
      </form>
    </section>
  );
}

function WorkPanel({ data, projects, disabled, onRun }: PanelProps): ReactNode {
  const status = recordOf(data.status);
  const claims = arrayOf(status.activeClaims);
  const handoffs = arrayOf(recordOf(data.handoffs).handoffs);
  const taskList = arrayOf(recordOf(data.tasks).tasks);
  const tasks = taskList.length ? taskList : arrayOf(status.tasks);
  const reviews = arrayOf(recordOf(data.reviews).reviews);
  const regressions = arrayOf(recordOf(data.regressions).recentRuns);
  const git = recordOf(data['git-status']);
  const repos = arrayOf(git.repos);
  const integrations = arrayOf(recordOf(data['integration-status']).projects);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskProject, setTaskProject] = useState(projects[0]?.name ?? '');
  const [taskAgent, setTaskAgent] = useState('kai-desktop');
  const [claimAgent, setClaimAgent] = useState('kai-desktop');
  const [claimProject, setClaimProject] = useState(projects[0]?.name ?? '');
  const [claimWhat, setClaimWhat] = useState('');

  return (
    <div className="cognitive1-page">
      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Coordination" title={`Active claims (${claims.length})`} icon={<ShieldCheck size={16} />} />
          <div className="cognitive1-list compact">
            {claims.map((claim, index) => (
              <div className="cognitive1-note" key={`${claim.agent ?? 'agent'}-${index}`}>
                <strong>{String(claim.agent ?? 'unknown')}</strong>
                <span>{String(claim.project ?? 'unknown')} - {String(claim.what ?? '')}</span>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('active-release', { agent: String(claim.agent ?? '') }, 'Claim released.')}>Release</UiButton>
              </div>
            ))}
            {claims.length === 0 && <EmptyText>No active claims.</EmptyText>}
          </div>
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('active-claim', { agent: claimAgent, project: claimProject, what: claimWhat }, 'Work claim recorded.').then(() => setClaimWhat('')); }}>
            <TextField label="Agent" value={claimAgent} onChange={setClaimAgent} />
            <ProjectPicker label="Project" value={claimProject} projects={projects} onChange={setClaimProject} />
            <TextField label="What are you claiming" value={claimWhat} onChange={setClaimWhat} />
            <div className="cognitive1-actions"><UiButton type="submit" className="primary-button" disabled={disabled || !claimAgent.trim() || !claimWhat.trim()}>Claim work</UiButton><UiButton type="button" className="secondary-button danger-button" disabled={disabled} onClick={() => void onRun('active-release-all', {}, 'All work claims released.')}>Release all</UiButton></div>
          </form>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Inbox" title={`Pending handoffs (${handoffs.length})`} icon={<Terminal size={16} />} />
          <div className="cognitive1-list compact">
            {handoffs.map((handoff, index) => (
              <div className="cognitive1-note" key={`${handoff.fromAgent ?? 'from'}-${index}`}>
                <strong>{String(handoff.fromAgent ?? 'unknown')} to {String(handoff.toAgent ?? 'any')}</strong>
                <span>{String(handoff.project ?? '')}: {String(handoff.next ?? handoff.status ?? '')}</span>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('handoff-claim', { from_agent: String(handoff.fromAgent ?? ''), project: String(handoff.project ?? ''), date: String(handoff.date ?? ''), time: handoff.time ? String(handoff.time) : undefined }, 'Handoff claimed.')}>Claim</UiButton>
              </div>
            ))}
            {handoffs.length === 0 && <EmptyText>No pending handoffs.</EmptyText>}
          </div>
          <div className="cognitive1-actions"><UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('handoff-suggest', { project: projects[0]?.name ?? '' }, 'Agent handoff suggestions loaded.')}>Suggest best agent</UiButton></div>
        </section>
      </div>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Durable work" title={`Tasks (${tasks.length})`} icon={<ClipboardCheck size={16} />} />
        <div className="cognitive1-table-list">
          {tasks.map((task, index) => (
            <article className="cognitive1-task-row" key={`${task.title ?? 'task'}-${index}`}>
              <div><strong>{String(task.title ?? 'Untitled task')}</strong><small>{String(task.project ?? 'unknown')} - {String(task.status ?? 'open')} - {String(task.claimedBy ?? task.assignee ?? 'unassigned')}</small></div>
              <div className="cognitive1-row-actions">
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('task-claim', { title: String(task.title ?? ''), project: String(task.project ?? ''), agent: taskAgent }, 'Task claimed.')}>Claim</UiButton>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('task-complete', { title: String(task.title ?? ''), project: String(task.project ?? ''), agent: taskAgent }, 'Task completed.')}>Complete</UiButton>
              </div>
            </article>
          ))}
          {tasks.length === 0 && <EmptyText>No open tasks.</EmptyText>}
        </div>
        <form className="cognitive1-form cognitive1-form-inline" onSubmit={(event) => { event.preventDefault(); void onRun('task-create', { title: taskTitle, project: taskProject, agent: taskAgent, assignee: 'any' }, 'Task created.').then(() => setTaskTitle('')); }}>
          <TextField label="Task title" value={taskTitle} onChange={setTaskTitle} />
          <ProjectPicker label="Project" value={taskProject} projects={projects} onChange={setTaskProject} />
          <TextField label="Created by" value={taskAgent} onChange={setTaskAgent} />
          <UiButton type="submit" className="primary-button align-end" disabled={disabled || !taskTitle.trim()}>Create task</UiButton>
        </form>
      </section>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Verification" title={`Review queue (${reviews.length})`} icon={<ClipboardCheck size={16} />} />
          <div className="cognitive1-list compact">{reviews.map((review, index) => <JsonRow key={`review-${index}`} row={review} />)}{reviews.length === 0 && <EmptyText>No pending reviews.</EmptyText>}</div>
        </section>
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Regression history" title={`Recent runs (${regressions.length})`} icon={<Activity size={16} />} />
          <div className="cognitive1-list compact">{regressions.map((run, index) => <JsonRow key={`regression-${index}`} row={run} />)}{regressions.length === 0 && <EmptyText>No regression runs recorded.</EmptyText>}</div>
        </section>
      </div>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Repositories" title="Git monitor" icon={<GitBranch size={16} />} />
          <div className="cognitive1-list compact">
            {repos.map((repo, index) => (
              <div className="cognitive1-note" key={`${repo.name ?? index}`}><strong>{String(repo.name ?? 'repository')}</strong><span>{String(repo.branch ?? 'unknown')} - {String(repo.dirty ?? 0)} changed - {String(repo.lastCommit ?? '')}</span></div>
            ))}
            {repos.length === 0 && <EmptyText>No monitored repositories.</EmptyText>}
          </div>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Project wiring" title="Cognitive1 integration status" icon={<ShieldCheck size={16} />} />
          <div className="cognitive1-integration-grid">
            {integrations.map((item, index) => (
              <article className="cognitive1-integration-row" key={`${item.name ?? index}`}>
                <strong>{String(item.name ?? 'project')}</strong>
                <span className={item.instruct ? 'ok' : 'missing'}>Instruct</span>
                <span className={item.agentsMd ? 'ok' : 'missing'}>AGENTS</span>
                <span className={item.gitignoreOk ? 'ok' : 'missing'}>gitignore</span>
                <span className={item.hooksOk ? 'ok' : 'missing'}>hooks</span>
              </article>
            ))}
            {integrations.length === 0 && <EmptyText>No integration scan results.</EmptyText>}
          </div>
        </section>
      </div>
    </div>
  );
}

function RecoveryPanel({ data, projects, disabled, onRun }: PanelProps): ReactNode {
  const [agent, setAgent] = useState('kai-desktop');
  const [project, setProject] = useState(projects[0]?.name ?? '');
  const [what, setWhat] = useState('');
  const [files, setFiles] = useState('');
  const [notes, setNotes] = useState('');
  const [task, setTask] = useState('');
  const [recap, setRecap] = useState('');
  const recover = recordOf(data.recover);
  const recapEntries = arrayOf(recordOf(data['recap-check']).entries);
  const status = recordOf(data.status);

  return (
    <div className="cognitive1-page">
      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Interruption recovery" title="Recover work state" icon={<LifeBuoy size={16} />} />
          <div className="cognitive1-actions"><TextField label="Agent" value={agent} onChange={setAgent} /><UiButton type="button" className="secondary-button align-end" disabled={disabled} onClick={() => void onRun('recover', { agent }, 'Recovery state loaded.')}>Recover</UiButton><UiButton type="button" className="secondary-button align-end" disabled={disabled} onClick={() => void onRun('suggest', { agent, project }, 'Next-work suggestion loaded.')}>Suggest next work</UiButton></div>
          {Boolean(status.daemonWasRestarted) && <div className="proxy-inline-warning"><AlertTriangle size={14} /><span>The C1 daemon restarted with unfinished claims. Review recovery before editing.</span></div>}
          {Boolean(recover.checkpoint) && <pre className="cognitive1-code">{String(recover.checkpoint)}</pre>}
          <JsonPreview value={data.recover} />
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Mid-task state" title="Write checkpoint" icon={<Clock3 size={16} />} />
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('checkpoint', { agent, project, what, files, notes }, 'Checkpoint saved.'); }}>
            <TextField label="Agent" value={agent} onChange={setAgent} />
            <ProjectPicker label="Project" value={project} projects={projects} onChange={setProject} />
            <TextField label="Current work" value={what} onChange={setWhat} />
            <TextField label="Files" value={files} onChange={setFiles} />
            <label className="field"><span>Notes</span><Textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
            <div className="cognitive1-actions"><UiButton type="submit" className="primary-button" disabled={disabled || !what.trim()}>Save checkpoint</UiButton></div>
          </form>
        </section>
      </div>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Task alignment" title="Recap check" icon={<ClipboardCheck size={16} />} />
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('recap-check-log', { agent, project, task, recap }, 'Recap logged.').then(() => setRecap('')); }}>
            <TextField label="Task" value={task} onChange={setTask} />
            <label className="field"><span>Recap</span><Textarea rows={4} value={recap} onChange={(event) => setRecap(event.target.value)} /></label>
            <div className="cognitive1-actions"><UiButton type="submit" className="primary-button" disabled={disabled || !task.trim() || !recap.trim()}>Log recap</UiButton></div>
          </form>
          <div className="cognitive1-list compact">{recapEntries.slice(0, 5).map((entry, index) => <JsonRow key={`recap-${index}`} row={entry} />)}{recapEntries.length === 0 && <EmptyText>No recaps logged.</EmptyText>}</div>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Portability" title="Brain export" icon={<Download size={16} />} />
          <p className="cognitive1-copy">Export the complete memory, handoffs, urgent notes, and active claims as a portable JSON bundle.</p>
          <div className="cognitive1-actions"><UiButton type="button" className="primary-button" disabled={disabled} onClick={() => void exportBrainBundle(onRun)}><Download size={14} /><span>Export JSON bundle</span></UiButton></div>
          <JsonPreview value={data['brain-export']} />
        </section>
      </div>
    </div>
  );
}

function SkillsPanel({
  data,
  disabled,
  onRun,
  onInvoke,
}: PanelProps & { onInvoke: Invoke }): ReactNode {
  const skills = arrayOf(recordOf(data.skills).skills);
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');

  async function openSkill(name: string): Promise<void> {
    const result = recordOf(await onInvoke('skill-content', { name }));
    if (!result.content) return;
    setSelected(name);
    setContent(String(result.content));
  }

  return (
    <div className="cognitive1-page cognitive1-skills-layout">
      <section className="cognitive1-card cognitive1-skill-list-card">
        <SectionHeading eyebrow="Engine skills" title={`Skills (${skills.length})`} icon={<BookOpen size={16} />} />
        <div className="cognitive1-list compact">
          {skills.map((skill, index) => {
            const name = String(skill.dir ?? skill.name ?? '');
            return (
              <UiButton type="button" className={`cognitive1-skill-row ${selected === name ? 'active' : ''}`} key={`${name}-${index}`} disabled={disabled} onClick={() => void openSkill(name)}>
                <FileCode2 size={14} />
                <span><strong>{String(skill.name ?? name)}</strong><small>{String(skill.description ?? skill.path ?? '')}</small></span>
              </UiButton>
            );
          })}
          {skills.length === 0 && <EmptyText>No Cognitive1 skills were found.</EmptyText>}
        </div>
      </section>
      <section className="cognitive1-card cognitive1-skill-editor">
        <SectionHeading eyebrow={selected || 'Select a skill'} title="Skill content" icon={<BookOpen size={16} />} />
        <Textarea value={content} disabled={disabled || !selected} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        <div className="cognitive1-actions"><UiButton type="button" className="primary-button" disabled={disabled || !selected || !content.trim()} onClick={() => void onRun('skill-save', { name: selected, content }, 'Skill saved.')}>Save skill</UiButton></div>
      </section>
    </div>
  );
}

function AdvancedPanel({ data, disabled, onRun }: PanelProps): ReactNode {
  const [operation, setOperation] = useState<Cognitive1Operation>('status');
  const [payload, setPayload] = useState('{}');
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<unknown>(data[operation]);
  const [tool, setTool] = useState<Cognitive1McpTool>('brain_recall');
  const [toolArguments, setToolArguments] = useState('{}');
  const [toolInvalid, setToolInvalid] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolResult, setToolResult] = useState<unknown>();

  return (
    <div className="cognitive1-page">
      <section className="cognitive1-card">
        <SectionHeading eyebrow="Allowlisted API" title="Advanced C1 operation" icon={<KeyRound size={16} />} />
        <p className="cognitive1-copy">Run any allowlisted Cognitive1 operation with a JSON payload. The desktop never exposes an arbitrary URL or filesystem command.</p>
        <div className="cognitive1-advanced-grid">
          <label className="field"><span>Operation</span><Select value={operation} onChange={(event) => { const next = event.target.value as Cognitive1Operation; setOperation(next); setResult(data[next]); }}>{cognitive1Operations.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>
          <label className="field"><span>JSON payload {invalid && <em>Invalid JSON</em>}</span><Textarea rows={10} value={payload} spellCheck={false} onChange={(event) => { const next = event.target.value; setPayload(next); try { const parsed = JSON.parse(next) as unknown; setInvalid(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)); } catch { setInvalid(true); } }} /></label>
        </div>
        <div className="cognitive1-actions"><UiButton type="button" className="primary-button" disabled={disabled || invalid} onClick={async () => { const next = await onRun(operation, JSON.parse(payload) as Record<string, unknown>, `${operationLabel(operation)} completed.`); if (next !== null) setResult(next); }}>Run operation</UiButton></div>
        <JsonPreview value={result} />
      </section>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Complete MCP registry" title="Run any Cognitive1 tool" icon={<Terminal size={16} />} />
        <p className="cognitive1-copy">Invoke the same allowlisted MCP tools that Cognitive1 exposes to coding agents. Arguments stay local and are validated by the managed engine.</p>
        <div className="cognitive1-advanced-grid">
          <label className="field"><span>MCP tool</span><Select value={tool} onChange={(event) => setTool(event.target.value as Cognitive1McpTool)}>{cognitive1McpTools.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>
          <label className="field"><span>Tool arguments {toolInvalid && <em>Invalid JSON</em>}</span><Textarea rows={10} value={toolArguments} spellCheck={false} onChange={(event) => { const next = event.target.value; setToolArguments(next); try { const parsed = JSON.parse(next) as unknown; setToolInvalid(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)); } catch { setToolInvalid(true); } }} /></label>
        </div>
        <div className="cognitive1-actions">
          <UiButton type="button" className="primary-button" disabled={disabled || toolBusy || toolInvalid} onClick={async () => {
            setToolBusy(true);
            setToolError(null);
            try {
              const next = await window.kaiDesktop.cognitive1Tool({ tool, arguments: JSON.parse(toolArguments) as Record<string, unknown> }).then(unwrap);
              setToolResult(next);
            } catch (caught) {
              setToolError(messageOf(caught));
            } finally {
              setToolBusy(false);
            }
          }}>{toolBusy ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}<span>Run MCP tool</span></UiButton>
        </div>
        {toolError && <div className="proxy-error" role="alert"><AlertTriangle size={15} /><span>{toolError}</span></div>}
        <JsonPreview value={toolResult} />
      </section>
    </div>
  );
}

interface PanelProps {
  data: Partial<Record<Cognitive1Operation, unknown>>;
  projects: ProjectRecord[];
  disabled: boolean;
  onRun: (operation: Cognitive1Operation, payload?: Record<string, unknown>, message?: string, refresh?: boolean) => Promise<unknown>;
}

function SectionHeading({ eyebrow, title, icon }: { eyebrow: string; title: string; icon: ReactNode }): ReactNode {
  return <div className="cognitive1-card-heading"><div><span className="eyebrow">{eyebrow}</span><h3>{title}</h3></div>{icon}</div>;
}

function IntelligenceGauge({ label, value, detail }: { label: string; value: number; detail: string }): ReactNode {
  const safeValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="cognitive1-gauge">
      <div className="cognitive1-gauge-ring" style={{ '--gauge-value': `${safeValue * 3.6}deg` } as CSSProperties}>
        <span>{safeValue}%</span>
      </div>
      <div><strong>{label}</strong><small>{detail}</small></div>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><UiTextInput value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ProjectPicker({ label, value, projects, onChange }: { label: string; value: string; projects: ProjectRecord[]; onChange: (value: string) => void }): ReactNode {
  return (
    <label className="field">
      <span>{label}</span>
      <UiTextInput list="cognitive1-projects" value={value} onChange={(event) => onChange(event.target.value)} />
      <datalist id="cognitive1-projects">{projects.map((project) => <option key={project.id} value={project.name} />)}</datalist>
    </label>
  );
}

/**
 * How many of your corrections Overwatch now judges with. Renders nothing when the connected C1 engine predates
 * learning, because a missing count is not the same as zero corrections.
 */
function LearningNote({ precedents }: { precedents: unknown }): ReactNode {
  const learned = learnedCorrections(precedents);
  if (learned === null) return null;
  return (
    <div className="cognitive1-learning">
      <strong>{learned === 0 ? 'Not taught yet' : `Learning from ${learned} correction(s)`}</strong>
      <span>
        {learned === 0
          ? 'When you reject a draft Overwatch wanted to keep, or approve one it called noise, C1 remembers it and shows Overwatch that correction whenever it judges a new draft.'
          : 'Each is a draft where you overruled its verdict. Overwatch sees the most recent of them every time it judges a new draft, so it stops repeating calls you have already corrected.'}
      </span>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }): ReactNode {
  return <div className={`cognitive1-metric ${tone ?? ''}`}><small>{label}</small><strong>{value}</strong></div>;
}

/** "3 gaps", "1 gap", "none" — a count that reads as a sentence rather than as "0 knowledge gap(s)". */
function countPhrase(count: number, noun: string): string {
  if (count === 0) return `no ${noun}s`;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function EmptyText({ children }: { children: ReactNode }): ReactNode {
  return <div className="cognitive1-empty">{children}</div>;
}

/**
 * The numbers an action produced, out of whatever shape it answered with.
 *
 * Every Overwatch action answers with a different object — a count here, a list there, an audit nested under
 * `audit` — so this looks for the counts by name and reports the ones it finds, and says "completed" only when
 * there is genuinely nothing to report. Deliberately quiet about shapes it does not recognise rather than
 * inventing a number.
 */
function describeOutcome(result: unknown): string {
  const value = recordOf(result);
  const parts: string[] = [];
  const count = (label: string, raw: unknown): void => {
    if (typeof raw === 'number') parts.push(`${raw} ${label}${raw === 1 ? '' : 's'}`);
    else if (Array.isArray(raw)) parts.push(`${raw.length} ${label}${raw.length === 1 ? '' : 's'}`);
  };
  count('duplicate candidate', value.duplicates);
  count('bug match', value.bugRefs);
  count('note linked', value.linked ?? value.links);
  count('entry filed', value.filed ?? value.kept);
  count('entry deleted', value.deleted);
  count('guide written', value.written ?? value.kernels);
  count('guide sent', value.pushed);
  count('draft classified', value.classified ?? value.updated);
  const audit = recordOf(value.audit);
  count('knowledge gap', audit.knowledgeGaps);
  // An action that found nothing is a real answer, and a different one from an action that did not finish.
  if (parts.length === 0) return Object.keys(value).length === 0 ? 'completed, nothing to report.' : 'completed.';
  return `completed: ${parts.join(', ')}.`;
}

/**
 * How many findings one card shows before offering the rest.
 *
 * A duplicate scan over a real brain returns dozens, and the card rendered every one of them — a wall of pairs long
 * enough that the card's own explanation was above it, the card below it was off the bottom of the screen, and the
 * count in the heading was the only thing saying how many there were.
 */
const FINDINGS_PAGE = 10;

/** A findings list that shows the first page and offers the remainder, rather than emptying the screen. */
function Findings({ items, empty, render }: {
  items: readonly unknown[];
  /** Shown in place of the list. Says why it is empty, which for these lists is two different things. */
  empty: ReactNode;
  render: (item: unknown, index: number) => ReactNode;
}): ReactNode {
  const [page, setPage] = useState(1);
  if (items.length === 0) return <>{empty}</>;
  const shown = page * FINDINGS_PAGE;
  const visible = items.slice(0, shown);
  const remaining = items.length - visible.length;
  return (
    <>
      {visible.map((item, index) => render(item, index))}
      {remaining > 0 && (
        <UiButton type="button" className="secondary-button cognitive1-more" onClick={() => setPage((current) => current + 1)}>
          <span>Show {Math.min(remaining, FINDINGS_PAGE)} more ({remaining} left)</span>
        </UiButton>
      )}
    </>
  );
}

function JsonRow({ row }: { row: Record<string, unknown> }): ReactNode {
  const title = String(row.title ?? row.project ?? row.name ?? row.task ?? row.status ?? 'Record');
  const details = Object.entries(row).filter(([key]) => !['title', 'project', 'name', 'task'].includes(key)).slice(0, 4).map(([key, value]) => `${key}: ${compact(value)}`).join(' - ');
  return <div className="cognitive1-note"><strong>{title}</strong>{details && <span>{details}</span>}</div>;
}

function JsonPreview({ value }: { value: unknown }): ReactNode {
  if (value === undefined || value === null) return null;
  return <pre className="cognitive1-code">{JSON.stringify(value, null, 2)}</pre>;
}

function records(value: unknown, key?: string): Record<string, unknown>[] {
  const root = recordOf(value);
  const target = key ? root[key] : value;
  return arrayOf(target);
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

/** Audit findings and distilled kernels arrive as bare strings, which `arrayOf` would drop for not being objects. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value).slice(0, 120);
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? new Intl.NumberFormat().format(value) : '0';
}

function timestampText(value: unknown): string {
  if (typeof value !== 'string') return 'unknown time';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function operationLabel(operation: Cognitive1Operation): string {
  return operation.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function exportBrainBundle(onRun: PanelProps['onRun']): Promise<void> {
  const result = await onRun('brain-export', { format: 'json' }, 'Brain export loaded.', false);
  if (!result) return;
  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `kai-cognitive1-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The Cognitive1 operation failed.';
}

async function loadOperations(operations: Cognitive1Operation[]): Promise<OperationLoad> {
  const values: Partial<Record<Cognitive1Operation, unknown>> = {};
  const failures: string[] = [];
  for (const operation of operations) {
    try {
      values[operation] = await window.kaiDesktop.cognitive1Operation({ operation, payload: {} }).then(unwrap);
    } catch (error) {
      failures.push(messageOf(error));
    }
  }
  return { values, failures };
}
