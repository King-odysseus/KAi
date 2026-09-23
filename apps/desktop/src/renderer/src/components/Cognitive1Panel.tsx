import {
  Activity,
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Download,
  FileCode2,
  GitBranch,
  KeyRound,
  LifeBuoy,
  Play,
  RefreshCw,
  ShieldCheck,
  Siren,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  cognitive1McpTools,
  cognitive1Operations,
  type BrainEntryType,
  type Cognitive1McpTool,
  type Cognitive1Operation,
  type ProjectRecord,
  type ServiceState,
} from '@kai/contracts';
import { unwrap } from '../types';
import { BrainPanel } from './BrainView';

type Cognitive1Tab = 'memory' | 'maintenance' | 'work' | 'recovery' | 'skills' | 'system' | 'advanced';

const tabs: Array<{ id: Cognitive1Tab; label: string }> = [
  { id: 'memory', label: 'Memory' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'work', label: 'Work' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'skills', label: 'Skills' },
  { id: 'system', label: 'System' },
  { id: 'advanced', label: 'Advanced' },
];

const tabLoads: Record<Cognitive1Tab, Cognitive1Operation[]> = {
  memory: [],
  maintenance: ['brain-drafts', 'urgent-list'],
  work: ['status', 'handoffs', 'tasks', 'reviews', 'regressions'],
  recovery: ['recover', 'recap-check', 'status'],
  skills: ['skills'],
  system: ['metrics', 'git-status', 'integration-status', 'overwatch-status', 'overwatch-insights'],
  advanced: ['status'],
};

interface OperationLoad {
  values: Partial<Record<Cognitive1Operation, unknown>>;
  failures: string[];
}

export function Cognitive1Panel({
  service,
  projects,
}: {
  service: ServiceState;
  projects: ProjectRecord[];
}): ReactNode {
  const [tab, setTab] = useState<Cognitive1Tab>('memory');
  const [data, setData] = useState<Partial<Record<Cognitive1Operation, unknown>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setNotice(message ?? `${operationLabel(operation)} completed.`);
    if (refresh) await refreshCore();
    return result;
  }

  async function refreshCore(): Promise<void> {
    if (!ready) return;
    const { values, failures } = await loadOperations(tabLoads[tab]);
    setData((current) => ({ ...current, ...values }));
    setError(failures.length ? `${failures.length} C1 panel request(s) failed: ${failures[0]}` : null);
  }

  return (
    <section className="cognitive1-panel">
      <div className="cognitive1-control-heading">
        <div>
          <span className="eyebrow">Cognitive1 control centre</span>
          <h2>Brain operations</h2>
          <p>Native desktop access to memory, maintenance, tasks, recovery, skills, and Overwatch.</p>
        </div>
        <button type="button" className="secondary-button" disabled={!ready || Boolean(busy)} onClick={() => void refreshCore()}>
          <RefreshCw size={14} className={busy?.startsWith('Loading') ? 'spin' : undefined} />
          <span>Refresh all</span>
        </button>
      </div>

      <nav className="cognitive1-tabs" aria-label="Cognitive1 sections">
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

      {notice && <div className="proxy-notice success"><CheckCircle2 size={15} /><span>{notice}</span><button type="button" className="icon-button compact" aria-label="Dismiss C1 notice" onClick={() => setNotice(null)}><X size={14} /></button></div>}
      {error && <div className="proxy-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" className="icon-button compact" aria-label="Dismiss C1 error" onClick={() => setError(null)}><X size={14} /></button></div>}
      {busy && <div className="proxy-action-state"><RefreshCw size={14} className="spin" /><span>{busy}</span></div>}

      {tab === 'memory' && <BrainPanel service={service} />}
      {tab === 'maintenance' && <MaintenancePanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} />}
      {tab === 'work' && <WorkPanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} />}
      {tab === 'recovery' && <RecoveryPanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} />}
      {tab === 'skills' && <SkillsPanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} onInvoke={invoke} />}
      {tab === 'system' && <SystemPanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} />}
      {tab === 'advanced' && <AdvancedPanel data={data} projects={projects} disabled={!ready || Boolean(busy)} onRun={run} />}
    </section>
  );
}

function MaintenancePanel({
  data,
  projects,
  disabled,
  onRun,
}: PanelProps): ReactNode {
  // The age-based prune only becomes available once a preview has reported something to delete.
  const prunePreview = (data['brain-prune'] ?? {}) as { handoffs?: number; dailyLogs?: number; resolvedEntries?: number };
  const prunableTotal = (prunePreview.handoffs ?? 0) + (prunePreview.dailyLogs ?? 0) + (prunePreview.resolvedEntries ?? 0);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<BrainEntryType>('gotchas');
  const [project, setProject] = useState(projects[0]?.name ?? '');
  const [agent, setAgent] = useState('kai-desktop');
  const [tags, setTags] = useState('');
  const [fact, setFact] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [urgentProject, setUrgentProject] = useState(projects[0]?.name ?? 'global');
  const [urgentWhat, setUrgentWhat] = useState('');
  const [urgentDo, setUrgentDo] = useState('');
  const [urgentDoNot, setUrgentDoNot] = useState('');
  const [pruneTitle, setPruneTitle] = useState('');
  const drafts = records(data['brain-drafts'], 'drafts');
  const urgentNotes = records(data['urgent-list'], 'urgentNotes');

  async function learn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return;
    const payload: Record<string, unknown> = {
      title: title.trim(),
      type,
      project: project.trim() || 'global',
      agent,
      tags,
      fact,
    };
    if (fieldName.trim() && fieldValue.trim()) payload[fieldName.trim()] = fieldValue.trim();
    const result = recordOf(await onRun('brain-learn', payload, 'Memory entry submitted.'));
    if (result.rejected) {
      window.alert(String(result.reason ?? 'The quality gate rejected the entry.'));
      return;
    }
    setTitle('');
    setFact('');
    setFieldName('');
    setFieldValue('');
  }

  return (
    <div className="cognitive1-page">
      <div className="cognitive1-grid two">
        <BrainLearnCard
          title={title}
          type={type}
          project={project}
          agent={agent}
          tags={tags}
          fact={fact}
          fieldName={fieldName}
          fieldValue={fieldValue}
          projects={projects}
          disabled={disabled}
          onTitle={setTitle}
          onType={setType}
          onProject={setProject}
          onAgent={setAgent}
          onTags={setTags}
          onFact={setFact}
          onFieldName={setFieldName}
          onFieldValue={setFieldValue}
          onSubmit={(event) => void learn(event)}
        />

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Quality queue" title={`Draft review (${drafts.length})`} icon={<ClipboardCheck size={16} />} />
          <div className="cognitive1-list">
            {drafts.map((draft, index) => (
              <article className="cognitive1-row" key={`${draft.index ?? index}-${draft.title ?? 'draft'}`}>
                <div>
                  <strong>{String(draft.title ?? `Draft ${index + 1}`)}</strong>
                  <small>{String(draft.type ?? 'untyped')} {draft.project ? `- ${String(draft.project)}` : ''}</small>
                </div>
                <div className="cognitive1-row-actions">
                  <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('brain-draft-approve', { index: Number(draft.index ?? index) }, 'Draft approved.')}>Approve</button>
                  <button type="button" className="secondary-button danger-button" disabled={disabled} onClick={() => void onRun('brain-draft-reject', { index: Number(draft.index ?? index) }, 'Draft rejected.')}>Reject</button>
                </div>
              </article>
            ))}
            {drafts.length === 0 && <EmptyText>No drafts are waiting for review.</EmptyText>}
          </div>
          <div className="cognitive1-actions">
            <button type="button" className="secondary-button" disabled={disabled || drafts.length === 0} onClick={() => void onRun('brain-draft-approve-all', {}, 'All drafts approved.')}>Approve all</button>
          </div>
        </section>
      </div>

      <div className="cognitive1-grid two">
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
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('urgent-set', { project: urgentProject, what: urgentWhat, do: urgentDo, do_not: urgentDoNot, agent }, 'Urgent note saved.').then(() => { setUrgentWhat(''); setUrgentDo(''); setUrgentDoNot(''); }); }}>
            <ProjectPicker label="Project" value={urgentProject} projects={projects} onChange={setUrgentProject} />
            <TextField label="What is urgent" value={urgentWhat} onChange={setUrgentWhat} />
            <TextField label="Required action" value={urgentDo} onChange={setUrgentDo} />
            <TextField label="Do not" value={urgentDoNot} onChange={setUrgentDoNot} />
            <div className="cognitive1-actions">
              <button type="submit" className="primary-button" disabled={disabled || !urgentWhat.trim()}>Set urgent note</button>
              <button type="button" className="secondary-button danger-button" disabled={disabled} onClick={() => void onRun('urgent-clear', {}, 'All urgent notes cleared.')}>Clear all</button>
            </div>
          </form>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Retention" title="Prune and audit" icon={<Trash2 size={16} />} />
          <p className="cognitive1-copy">Run a non-destructive prune preview, or delete entries matching a title after confirmation.</p>
          <div className="cognitive1-actions">
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('brain-prune', {}, 'Prune preview loaded.')}>Preview age-based prune</button>
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={disabled || prunableTotal === 0}
              title={prunableTotal === 0 ? 'Preview the prune first; nothing is deleted until you confirm.' : undefined}
              onClick={() => {
                if (!window.confirm(`Delete ${prunePreview.handoffs ?? 0} old handoffs, ${prunePreview.dailyLogs ?? 0} old daily logs and ${prunePreview.resolvedEntries ?? 0} resolved entries? This cannot be undone.`)) return;
                void window.kaiDesktop.cognitive1Tool({ tool: 'brain_prune', arguments: { execute: true } })
                  .then(() => onRun('brain-prune', {}, 'Age-based prune applied.'));
              }}
            >Apply prune…</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('brain-auto-learn', { source: 'manual', type: 'patterns', title: 'Manual auto-learn check', fields: { note: 'Desktop maintenance check' }, require_approval: true }, 'Auto-learn check completed.')}>Run auto-learn check</button>
          </div>
          <div className="cognitive1-inline-form">
            <TextField label="Exact entry title" value={pruneTitle} onChange={setPruneTitle} />
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={disabled || !pruneTitle.trim()}
              onClick={() => {
                if (!window.confirm(`Delete brain entries titled "${pruneTitle.trim()}"?`)) return;
                void onRun('brain-prune', { target_title: pruneTitle.trim() }, 'Targeted brain entries deleted.');
              }}
            >
              Delete matching titles
            </button>
          </div>
          <JsonPreview value={data['brain-prune']} />
        </section>
      </div>
    </div>
  );
}

function BrainLearnCard(props: {
  title: string;
  type: BrainEntryType;
  project: string;
  agent: string;
  tags: string;
  fact: string;
  fieldName: string;
  fieldValue: string;
  projects: ProjectRecord[];
  disabled: boolean;
  onTitle: (value: string) => void;
  onType: (value: BrainEntryType) => void;
  onProject: (value: string) => void;
  onAgent: (value: string) => void;
  onTags: (value: string) => void;
  onFact: (value: string) => void;
  onFieldName: (value: string) => void;
  onFieldValue: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactNode {
  return (
    <section className="cognitive1-card">
      <SectionHeading eyebrow="Durable knowledge" title="Learn an entry" icon={<Brain size={16} />} />
      <form className="cognitive1-form" onSubmit={props.onSubmit}>
        <TextField label="Title" value={props.title} onChange={props.onTitle} />
        <div className="field-grid two">
          <label className="field"><span>Type</span><select value={props.type} onChange={(event) => props.onType(event.target.value as BrainEntryType)}><option value="bugs">Bug</option><option value="decisions">Decision</option><option value="gotchas">Gotcha</option><option value="patterns">Pattern</option></select></label>
          <ProjectPicker label="Project" value={props.project} projects={props.projects} onChange={props.onProject} />
          <TextField label="Agent" value={props.agent} onChange={props.onAgent} />
          <TextField label="Tags" value={props.tags} onChange={props.onTags} />
          <TextField label="Optional field name" value={props.fieldName} onChange={props.onFieldName} />
          <TextField label="Optional field value" value={props.fieldValue} onChange={props.onFieldValue} />
        </div>
        <label className="field"><span>Knowledge</span><textarea rows={5} value={props.fact} onChange={(event) => props.onFact(event.target.value)} placeholder="What should future agents know?" /></label>
        <div className="cognitive1-actions"><button type="submit" className="primary-button" disabled={props.disabled || !props.title.trim() || !props.fact.trim()}>Learn entry</button></div>
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
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('active-release', { agent: String(claim.agent ?? '') }, 'Claim released.')}>Release</button>
              </div>
            ))}
            {claims.length === 0 && <EmptyText>No active claims.</EmptyText>}
          </div>
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('active-claim', { agent: claimAgent, project: claimProject, what: claimWhat }, 'Work claim recorded.').then(() => setClaimWhat('')); }}>
            <TextField label="Agent" value={claimAgent} onChange={setClaimAgent} />
            <ProjectPicker label="Project" value={claimProject} projects={projects} onChange={setClaimProject} />
            <TextField label="What are you claiming" value={claimWhat} onChange={setClaimWhat} />
            <div className="cognitive1-actions"><button type="submit" className="primary-button" disabled={disabled || !claimAgent.trim() || !claimWhat.trim()}>Claim work</button><button type="button" className="secondary-button danger-button" disabled={disabled} onClick={() => void onRun('active-release-all', {}, 'All work claims released.')}>Release all</button></div>
          </form>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Inbox" title={`Pending handoffs (${handoffs.length})`} icon={<Terminal size={16} />} />
          <div className="cognitive1-list compact">
            {handoffs.map((handoff, index) => (
              <div className="cognitive1-note" key={`${handoff.fromAgent ?? 'from'}-${index}`}>
                <strong>{String(handoff.fromAgent ?? 'unknown')} to {String(handoff.toAgent ?? 'any')}</strong>
                <span>{String(handoff.project ?? '')}: {String(handoff.next ?? handoff.status ?? '')}</span>
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('handoff-claim', { from_agent: String(handoff.fromAgent ?? ''), project: String(handoff.project ?? ''), date: String(handoff.date ?? ''), time: handoff.time ? String(handoff.time) : undefined }, 'Handoff claimed.')}>Claim</button>
              </div>
            ))}
            {handoffs.length === 0 && <EmptyText>No pending handoffs.</EmptyText>}
          </div>
          <div className="cognitive1-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('handoff-suggest', { project: projects[0]?.name ?? '' }, 'Agent handoff suggestions loaded.')}>Suggest best agent</button></div>
        </section>
      </div>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Durable work" title={`Tasks (${tasks.length})`} icon={<ClipboardCheck size={16} />} />
        <div className="cognitive1-table-list">
          {tasks.map((task, index) => (
            <article className="cognitive1-task-row" key={`${task.title ?? 'task'}-${index}`}>
              <div><strong>{String(task.title ?? 'Untitled task')}</strong><small>{String(task.project ?? 'unknown')} - {String(task.status ?? 'open')} - {String(task.claimedBy ?? task.assignee ?? 'unassigned')}</small></div>
              <div className="cognitive1-row-actions">
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('task-claim', { title: String(task.title ?? ''), project: String(task.project ?? ''), agent: taskAgent }, 'Task claimed.')}>Claim</button>
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('task-complete', { title: String(task.title ?? ''), project: String(task.project ?? ''), agent: taskAgent }, 'Task completed.')}>Complete</button>
              </div>
            </article>
          ))}
          {tasks.length === 0 && <EmptyText>No open tasks.</EmptyText>}
        </div>
        <form className="cognitive1-form cognitive1-form-inline" onSubmit={(event) => { event.preventDefault(); void onRun('task-create', { title: taskTitle, project: taskProject, agent: taskAgent, assignee: 'any' }, 'Task created.').then(() => setTaskTitle('')); }}>
          <TextField label="Task title" value={taskTitle} onChange={setTaskTitle} />
          <ProjectPicker label="Project" value={taskProject} projects={projects} onChange={setTaskProject} />
          <TextField label="Created by" value={taskAgent} onChange={setTaskAgent} />
          <button type="submit" className="primary-button align-end" disabled={disabled || !taskTitle.trim()}>Create task</button>
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
          <div className="cognitive1-actions"><TextField label="Agent" value={agent} onChange={setAgent} /><button type="button" className="secondary-button align-end" disabled={disabled} onClick={() => void onRun('recover', { agent }, 'Recovery state loaded.')}>Recover</button><button type="button" className="secondary-button align-end" disabled={disabled} onClick={() => void onRun('suggest', { agent, project }, 'Next-work suggestion loaded.')}>Suggest next work</button></div>
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
            <label className="field"><span>Notes</span><textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
            <div className="cognitive1-actions"><button type="submit" className="primary-button" disabled={disabled || !what.trim()}>Save checkpoint</button></div>
          </form>
        </section>
      </div>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Task alignment" title="Recap check" icon={<ClipboardCheck size={16} />} />
          <form className="cognitive1-form" onSubmit={(event) => { event.preventDefault(); void onRun('recap-check-log', { agent, project, task, recap }, 'Recap logged.').then(() => setRecap('')); }}>
            <TextField label="Task" value={task} onChange={setTask} />
            <label className="field"><span>Recap</span><textarea rows={4} value={recap} onChange={(event) => setRecap(event.target.value)} /></label>
            <div className="cognitive1-actions"><button type="submit" className="primary-button" disabled={disabled || !task.trim() || !recap.trim()}>Log recap</button></div>
          </form>
          <div className="cognitive1-list compact">{recapEntries.slice(0, 5).map((entry, index) => <JsonRow key={`recap-${index}`} row={entry} />)}{recapEntries.length === 0 && <EmptyText>No recaps logged.</EmptyText>}</div>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Portability" title="Brain export" icon={<Download size={16} />} />
          <p className="cognitive1-copy">Export the complete memory, handoffs, urgent notes, and active claims as a portable JSON bundle.</p>
          <div className="cognitive1-actions"><button type="button" className="primary-button" disabled={disabled} onClick={() => void exportBrainBundle(onRun)}><Download size={14} /><span>Export JSON bundle</span></button></div>
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
}: PanelProps & { onInvoke: (operation: Cognitive1Operation, payload?: Record<string, unknown>) => Promise<unknown> }): ReactNode {
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
              <button type="button" className={`cognitive1-skill-row ${selected === name ? 'active' : ''}`} key={`${name}-${index}`} disabled={disabled} onClick={() => void openSkill(name)}>
                <FileCode2 size={14} />
                <span><strong>{String(skill.name ?? name)}</strong><small>{String(skill.description ?? skill.path ?? '')}</small></span>
              </button>
            );
          })}
          {skills.length === 0 && <EmptyText>No Cognitive1 skills were found.</EmptyText>}
        </div>
      </section>
      <section className="cognitive1-card cognitive1-skill-editor">
        <SectionHeading eyebrow={selected || 'Select a skill'} title="Skill content" icon={<BookOpen size={16} />} />
        <textarea value={content} disabled={disabled || !selected} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        <div className="cognitive1-actions"><button type="button" className="primary-button" disabled={disabled || !selected || !content.trim()} onClick={() => void onRun('skill-save', { name: selected, content }, 'Skill saved.')}>Save skill</button></div>
      </section>
    </div>
  );
}

function SystemPanel({ data, disabled, onRun }: PanelProps): ReactNode {
  const metrics = recordOf(data.metrics);
  const git = recordOf(data['git-status']);
  const integration = recordOf(data['integration-status']);
  const overwatch = recordOf(data['overwatch-status']);
  const insights = arrayOf(recordOf(data['overwatch-insights']).insights);
  const repos = arrayOf(git.repos);
  const integrations = arrayOf(integration.projects);

  return (
    <div className="cognitive1-page">
      <div className="cognitive1-metric-strip">
        <Metric label="Sessions" value={numberText(metrics.totalSessions)} />
        <Metric label="Bugs" value={numberText(metrics.totalBugs)} />
        <Metric label="Decisions" value={numberText(metrics.totalDecisions)} />
        <Metric label="Gotchas" value={numberText(metrics.totalGotchas)} />
        <Metric label="Patterns" value={numberText(metrics.totalPatterns)} />
        <Metric label="Overwatch" value={overwatch.ready ? 'Ready' : overwatch.enabled ? 'Enabled' : 'Off'} tone={overwatch.ready ? 'good' : 'warn'} />
      </div>

      <div className="cognitive1-grid two">
        <section className="cognitive1-card">
          <SectionHeading eyebrow="Knowledge quality" title="System intelligence" icon={<Activity size={16} />} />
          <div className="cognitive1-actions">
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-run', {}, 'Overwatch full cycle completed.')}><Play size={13} /><span>Run Overwatch cycle</span></button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-audit', {}, 'Overwatch audit completed.')}>Run audit</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-semantic-dupes', {}, 'Semantic duplicate scan completed.')}>Find duplicates</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-cross-ref-bugs', {}, 'Bug cross-reference completed.')}>Cross-reference bugs</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-distill-kernels', {}, 'Project kernels distilled.')}>Distill kernels</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => void onRun('overwatch-push-to-memory', {}, 'Kernels pushed to memory.')}>Push kernels</button>
          </div>
          <div className="cognitive1-note">
            <strong>{overwatch.enabled ? 'Overwatch configured' : 'Overwatch disabled'}</strong>
            <span>{String(overwatch.provider ?? 'No provider')} - {String(overwatch.model ?? 'No model')} - {overwatch.hasKey ? 'API key ready' : 'API key missing'}</span>
            <span>{String(overwatch.baseUrl ?? 'No base URL configured')}</span>
          </div>
          <div className="cognitive1-list compact">{insights.slice(-6).reverse().map((insight, index) => <JsonRow key={`insight-${index}`} row={insight} />)}{insights.length === 0 && <EmptyText>No Overwatch insights recorded.</EmptyText>}</div>
        </section>

        <section className="cognitive1-card">
          <SectionHeading eyebrow="Repositories" title="Git monitor" icon={<GitBranch size={16} />} />
          <div className="cognitive1-list compact">
            {repos.map((repo, index) => (
              <div className="cognitive1-note" key={`${repo.name ?? index}`}><strong>{String(repo.name ?? 'repository')}</strong><span>{String(repo.branch ?? 'unknown')} - {String(repo.dirty ?? 0)} changed - {String(repo.lastCommit ?? '')}</span></div>
            ))}
            {repos.length === 0 && <EmptyText>No monitored repositories.</EmptyText>}
          </div>
        </section>
      </div>

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
          <label className="field"><span>Operation</span><select value={operation} onChange={(event) => { const next = event.target.value as Cognitive1Operation; setOperation(next); setResult(data[next]); }}>{cognitive1Operations.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="field"><span>JSON payload {invalid && <em>Invalid JSON</em>}</span><textarea rows={10} value={payload} spellCheck={false} onChange={(event) => { const next = event.target.value; setPayload(next); try { const parsed = JSON.parse(next) as unknown; setInvalid(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)); } catch { setInvalid(true); } }} /></label>
        </div>
        <div className="cognitive1-actions"><button type="button" className="primary-button" disabled={disabled || invalid} onClick={async () => { const next = await onRun(operation, JSON.parse(payload) as Record<string, unknown>, `${operationLabel(operation)} completed.`); if (next !== null) setResult(next); }}>Run operation</button></div>
        <JsonPreview value={result} />
      </section>

      <section className="cognitive1-card">
        <SectionHeading eyebrow="Complete MCP registry" title="Run any Cognitive1 tool" icon={<Terminal size={16} />} />
        <p className="cognitive1-copy">Invoke the same allowlisted MCP tools that Cognitive1 exposes to coding agents. Arguments stay local and are validated by the managed engine.</p>
        <div className="cognitive1-advanced-grid">
          <label className="field"><span>MCP tool</span><select value={tool} onChange={(event) => setTool(event.target.value as Cognitive1McpTool)}>{cognitive1McpTools.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="field"><span>Tool arguments {toolInvalid && <em>Invalid JSON</em>}</span><textarea rows={10} value={toolArguments} spellCheck={false} onChange={(event) => { const next = event.target.value; setToolArguments(next); try { const parsed = JSON.parse(next) as unknown; setToolInvalid(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)); } catch { setToolInvalid(true); } }} /></label>
        </div>
        <div className="cognitive1-actions">
          <button type="button" className="primary-button" disabled={disabled || toolBusy || toolInvalid} onClick={async () => {
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
          }}>{toolBusy ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}<span>Run MCP tool</span></button>
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

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  return <label className="field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ProjectPicker({ label, value, projects, onChange }: { label: string; value: string; projects: ProjectRecord[]; onChange: (value: string) => void }): ReactNode {
  return (
    <label className="field">
      <span>{label}</span>
      <input list="cognitive1-projects" value={value} onChange={(event) => onChange(event.target.value)} />
      <datalist id="cognitive1-projects">{projects.map((project) => <option key={project.id} value={project.name} />)}</datalist>
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }): ReactNode {
  return <div className={`cognitive1-metric ${tone ?? ''}`}><small>{label}</small><strong>{value}</strong></div>;
}

function EmptyText({ children }: { children: ReactNode }): ReactNode {
  return <div className="cognitive1-empty">{children}</div>;
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
