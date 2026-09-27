import { Play, Plus, Route as RouteIcon, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  buildDecisionNote,
  buildTaskPrompt,
  parseHandoffs,
  parseReviews,
  parseTasks,
  type BoardHandoff,
  type BoardReview,
  type BoardTask,
  type BrainEntry,
  type ProjectRecord,
  type TaskColumn,
} from '@kai/contracts';
import { unwrap } from '../types';
import { SaveToBrainDialog } from './SaveToBrain';

type TasksTab = 'board' | 'reviews' | 'handoffs' | 'decisions';

const TABS: Array<{ id: TasksTab; label: string; help: string }> = [
  { id: 'board', label: 'Board', help: 'The shared to-do list. Start a task to open it in a new conversation; complete it when it is finished so other agents know.' },
  { id: 'reviews', label: 'Reviews', help: 'Second opinions on finished work. An agent asks for a review of a commit; another agent (or you) reads it and leaves feedback.' },
  { id: 'handoffs', label: 'Handoffs', help: 'Work one agent could not finish and passed on, with notes on what to do next. Claim one to take it over.' },
  { id: 'decisions', label: 'Decisions', help: 'A log of choices and the reasons behind them, so nobody has to re-argue them later.' },
];

const REVIEW_STATES: Array<{ id: 'pending' | 'claimed' | 'done'; label: string }> = [
  { id: 'pending', label: 'Waiting for a reviewer' },
  { id: 'claimed', label: 'Being reviewed' },
  { id: 'done', label: 'Reviewed' },
];

const COLUMNS: Array<{ id: TaskColumn; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

const AGENT_NAME = 'kai-desktop';

async function operation(name: Parameters<typeof window.kaiDesktop.cognitive1Operation>[0]['operation'], payload: Record<string, unknown> = {}): Promise<unknown> {
  return unwrap(await window.kaiDesktop.cognitive1Operation({ operation: name, payload }));
}

export function TasksView({ activeProject, cognitive1Ready, onStartTask }: {
  activeProject: ProjectRecord | null;
  cognitive1Ready: boolean;
  onStartTask: (prompt: string) => Promise<void>;
}): ReactNode {
  const [tab, setTab] = useState<TasksTab>('board');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(async (action: () => Promise<void>, done?: string): Promise<void> => {
    try {
      await action();
      setError(null);
      if (done) setMessage(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That action failed.');
    }
  }, []);

  return (
    <div className="page-view tasks-view">
      <header className="page-header">
        <div>
          <h1>Tasks</h1>
          <p>Work shared between you and your AI agents, stored in the C1 brain{activeProject ? ` · ${activeProject.name}` : ''}</p>
        </div>
      </header>
      <div className="ops-tabs" role="tablist" aria-label="Task sections">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`ops-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>
      <p className="tasks-tab-help">{TABS.find((item) => item.id === tab)?.help}</p>
      {!cognitive1Ready && <div className="empty-list">Cognitive1 is not running. Start it from the C1 Brain page to use tasks, reviews and handoffs.</div>}
      {cognitive1Ready && message && <div className="workbench-notice" role="status"><span>{message}</span></div>}
      {cognitive1Ready && error && <div className="workbench-error" role="alert">{error}</div>}
      {cognitive1Ready && tab === 'board' && <TaskBoard activeProject={activeProject} report={report} onStartTask={onStartTask} />}
      {cognitive1Ready && tab === 'reviews' && <ReviewQueue activeProject={activeProject} report={report} />}
      {cognitive1Ready && tab === 'handoffs' && <HandoffInbox report={report} />}
      {cognitive1Ready && tab === 'decisions' && <DecisionLog activeProject={activeProject} report={report} />}
    </div>
  );
}

type Report = (action: () => Promise<void>, done?: string) => Promise<void>;

function TaskBoard({ activeProject, report, onStartTask }: { activeProject: ProjectRecord | null; report: Report; onStartTask: (prompt: string) => Promise<void> }): ReactNode {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [allProjects, setAllProjects] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', tags: '' });
  const [routeText, setRouteText] = useState<{ title: string; text: string } | null>(null);
  const [brainDraft, setBrainDraft] = useState<{ text: string; project: string } | null>(null);
  const projectName = activeProject?.name ?? '';

  const load = useCallback(async () => {
    await report(async () => {
      setTasks(parseTasks(await operation('tasks', { all: 'true', ...(allProjects || !projectName ? {} : { project: projectName }) })));
    });
  }, [allProjects, projectName, report]);
  useEffect(() => {
    void load();
  }, [load]);

  const byColumn = useMemo(() => {
    const groups: Record<TaskColumn, BoardTask[]> = { todo: [], doing: [], done: [] };
    for (const task of tasks) groups[task.column].push(task);
    return groups;
  }, [tasks]);

  async function start(task: BoardTask): Promise<void> {
    await report(async () => {
      await operation('task-claim', { title: task.title, project: task.project, agent: AGENT_NAME, start: true, recap: `Started from KAI Desktop: ${task.title}` });
      await onStartTask(buildTaskPrompt(task));
      await load();
    }, `Started "${task.title}" in a new conversation.`);
  }

  async function complete(task: BoardTask): Promise<void> {
    await report(async () => {
      await operation('task-complete', { title: task.title, project: task.project, agent: AGENT_NAME });
      setBrainDraft({ text: `${task.title}\n\n${task.description}`.trim(), project: task.project || projectName || 'global' });
      await load();
    }, `Completed "${task.title}".`);
  }

  async function suggestAgent(task: BoardTask): Promise<void> {
    await report(async () => {
      const result = await window.kaiDesktop.cognitive1Tool({ tool: 'task_route', arguments: { description: `${task.title}. ${task.description}`, tags: task.tags } }).then(unwrap) as { content?: Array<{ text?: string }> };
      setRouteText({ title: task.title, text: (result.content ?? []).map((block) => block.text ?? '').join('\n').trim() || 'No suggestion returned.' });
    });
  }

  return (
    <div className="ops-panel">
      <div className="ops-actions">
        <label className="toggle-row history-archive-filter"><span><strong>All projects</strong><small>{projectName ? `Otherwise only ${projectName}` : 'No project open'}</small></span><input type="checkbox" checked={allProjects || !projectName} disabled={!projectName} onChange={(event) => setAllProjects(event.target.checked)} /></label>
        <button type="button" className="secondary-button" onClick={() => void load()}><RefreshCw size={14} /><span>Refresh</span></button>
      </div>
      {routeText && (
        <div className="workbench-notice" role="status">
          <span><strong>Suggested agent for "{routeText.title}":</strong> {routeText.text}</span>
          <button type="button" className="secondary-button" onClick={() => setRouteText(null)}>Dismiss</button>
        </div>
      )}
      <div className="kanban" role="list">
        {COLUMNS.map((column) => (
          <section key={column.id} className="kanban-column" role="listitem" aria-label={column.label}>
            <h3>{column.label} <small>{byColumn[column.id].length}</small></h3>
            {byColumn[column.id].map((task) => (
              <article key={`${task.project}-${task.title}`} className="kanban-card">
                <strong>{task.title}</strong>
                <small>{task.project}{task.claimedBy ? ` · ${task.claimedBy}` : task.assignee && task.assignee !== 'any' ? ` · for ${task.assignee}` : ''}</small>
                {task.description && <p>{task.description.slice(0, 160)}</p>}
                {task.subtasksTotal > 0 && <small>Subtasks {task.subtasksDone}/{task.subtasksTotal}</small>}
                {task.dependsOn && <small>Depends on {task.dependsOn}</small>}
                <div className="ops-actions">
                  {task.column === 'todo' && <button type="button" className="primary-button" onClick={() => void start(task)}><Play size={12} /><span>Start</span></button>}
                  {task.column === 'todo' && <button type="button" className="secondary-button" title="Ask Cognitive1 which agent fits this task" onClick={() => void suggestAgent(task)}><RouteIcon size={12} /><span>Suggest agent</span></button>}
                  {task.column === 'doing' && <button type="button" className="primary-button" onClick={() => void complete(task)}><span>Complete</span></button>}
                </div>
              </article>
            ))}
            {byColumn[column.id].length === 0 && <div className="empty-list">Nothing here</div>}
          </section>
        ))}
      </div>

      <section className="settings-section">
        <div className="section-title"><Plus size={16} /><span>New task</span></div>
        <div className="field-grid">
          <label className="field"><span>Title</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="field"><span>Tags</span><input value={form.tags} placeholder="frontend, css" onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label>
        </div>
        <label className="field"><span>Description</span><textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <button type="button" className="primary-button align-end" disabled={!form.title.trim() || !projectName} title={projectName ? undefined : 'Open a project first'} onClick={() => void report(async () => {
          await operation('task-create', { ...form, title: form.title.trim(), project: projectName, agent: AGENT_NAME });
          setForm({ title: '', description: '', tags: '' });
          await load();
        }, 'Task created.')}>Create task</button>
      </section>
      {brainDraft && <SaveToBrainDialog text={brainDraft.text} project={brainDraft.project} onClose={() => setBrainDraft(null)} onSaved={() => undefined} />}
    </div>
  );
}

function ReviewQueue({ activeProject, report }: { activeProject: ProjectRecord | null; report: Report }): ReactNode {
  const [reviews, setReviews] = useState<BoardReview[]>([]);
  const [status, setStatus] = useState<'pending' | 'claimed' | 'done'>('pending');
  const [form, setForm] = useState({ commit: '', files: '', summary: '' });
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const project = activeProject?.name ?? '';

  const load = useCallback(async () => {
    await report(async () => { setReviews(parseReviews(await operation('reviews', { status }))); });
  }, [report, status]);
  useEffect(() => {
    void load();
  }, [load]);

  async function tool(argumentsValue: Record<string, unknown>): Promise<void> {
    unwrap(await window.kaiDesktop.cognitive1Tool({ tool: 'review_request', arguments: { agent: AGENT_NAME, ...argumentsValue } }));
  }

  return (
    <div className="ops-panel">
      <div className="ops-segment" role="group" aria-label="Review state">
        {REVIEW_STATES.map((item) => (
          <button key={item.id} type="button" aria-pressed={status === item.id} className={status === item.id ? 'active' : ''} onClick={() => setStatus(item.id)}>{item.label}</button>
        ))}
      </div>
      {reviews.length === 0 && <div className="empty-list">No reviews in this state{status === 'pending' ? '. Use "Request a review" below to ask for one.' : ''}</div>}
      {reviews.map((review) => (
        <section key={review.id} className="settings-section ops-card">
          <div className="ops-card-head"><strong>{review.project}{review.commit && <code className="ops-chip">{review.commit}</code>}</strong><span>requested by {review.requestedBy}</span></div>
          <p className="settings-note">{review.summary}</p>
          {review.files && <small className="ops-note ops-files">Files: {review.files}</small>}
          {review.feedback && <p className="settings-note"><strong>Feedback:</strong> {review.feedback}</p>}
          {status !== 'done' && (
            <div className="ops-inline-form">
              <label className="field"><span>Your feedback</span><input value={feedback[review.id] ?? ''} placeholder="What should change, or what looks good" onChange={(event) => setFeedback({ ...feedback, [review.id]: event.target.value })} /></label>
              <button type="button" className="primary-button" disabled={!(feedback[review.id] ?? '').trim()} onClick={() => void report(async () => { await tool({ project: review.project, review_id: review.id, feedback: feedback[review.id], status: 'done' }); await load(); }, 'Review submitted.')}>Submit review</button>
            </div>
          )}
        </section>
      ))}
      <section className="settings-section">
        <div className="section-title"><span>Request a review</span></div>
        <p className="settings-note">Ask another agent to check work that was just done. Give the commit or branch, and say what changed and why.</p>
        <div className="field-grid">
          <label className="field"><span>Commit or branch</span><input value={form.commit} onChange={(event) => setForm({ ...form, commit: event.target.value })} /></label>
          <label className="field"><span>Changed files (comma separated)</span><input value={form.files} onChange={(event) => setForm({ ...form, files: event.target.value })} /></label>
        </div>
        <label className="field"><span>What changed and why</span><textarea rows={3} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
        <button type="button" className="primary-button align-end" disabled={!project || !form.summary.trim()} onClick={() => void report(async () => { await tool({ project, ...form }); setForm({ commit: '', files: '', summary: '' }); await load(); }, 'Review requested.')}>Request review</button>
      </section>
    </div>
  );
}

function HandoffInbox({ report }: { report: Report }): ReactNode {
  const [handoffs, setHandoffs] = useState<BoardHandoff[]>([]);
  const load = useCallback(async () => {
    await report(async () => { setHandoffs(parseHandoffs(await operation('handoffs'))); });
  }, [report]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="ops-panel">
      <p className="settings-note">Work another agent handed over. Claiming one tells the brain you are taking it on.</p>
      {handoffs.length === 0 && <div className="empty-list">No handoffs waiting</div>}
      {handoffs.map((handoff) => (
        <section key={`${handoff.date}-${handoff.time}-${handoff.fromAgent}-${handoff.project}`} className="settings-section ops-card">
          <div className="ops-card-head"><strong>{handoff.fromAgent} → {handoff.toAgent || 'any'} · {handoff.project}</strong><span>{handoff.date} {handoff.time}</span></div>
          <p className="settings-note">{handoff.next || handoff.notes}</p>
          <div className="ops-actions">
            <span className="ops-note">{handoff.status}</span>
            {handoff.status.toLowerCase().includes('pending') && <button type="button" className="primary-button" onClick={() => void report(async () => { await operation('handoff-claim', { from_agent: handoff.fromAgent, project: handoff.project, date: handoff.date, time: handoff.time, agent: AGENT_NAME }); await load(); }, 'Handoff claimed.')}>Claim</button>}
          </div>
        </section>
      ))}
    </div>
  );
}

function DecisionLog({ activeProject, report }: { activeProject: ProjectRecord | null; report: Report }): ReactNode {
  const [entries, setEntries] = useState<BrainEntry[]>([]);
  const [form, setForm] = useState({ title: '', context: '', chosen: '', alternatives: '', rationale: '' });
  const project = activeProject?.name ?? '';

  const load = useCallback(async () => {
    await report(async () => {
      const found = unwrap(await window.kaiDesktop.searchBrain({ type: 'decisions', ...(project ? { project } : {}), maxResults: 50 }));
      setEntries([...found].sort((left, right) => right.date.localeCompare(left.date)));
    });
  }, [project, report]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ops-panel">
      <section className="settings-section">
        <div className="section-title"><span>Record a decision</span></div>
        <div className="field-grid">
          <label className="field"><span>Title</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="field"><span>Chosen option</span><input value={form.chosen} onChange={(event) => setForm({ ...form, chosen: event.target.value })} /></label>
        </div>
        <label className="field"><span>What prompted it</span><textarea rows={2} value={form.context} onChange={(event) => setForm({ ...form, context: event.target.value })} /></label>
        <label className="field"><span>Other options considered</span><input value={form.alternatives} onChange={(event) => setForm({ ...form, alternatives: event.target.value })} /></label>
        <label className="field"><span>Why this one</span><textarea rows={2} value={form.rationale} onChange={(event) => setForm({ ...form, rationale: event.target.value })} /></label>
        <button type="button" className="primary-button align-end" disabled={!project || !form.title.trim() || !form.chosen.trim() || !form.context.trim() || !form.rationale.trim()} title={project ? undefined : 'Open a project first'} onClick={() => void report(async () => {
          unwrap(await window.kaiDesktop.cognitive1Tool({ tool: 'decision_log', arguments: { ...form, project, agent: AGENT_NAME } }));
          setForm({ title: '', context: '', chosen: '', alternatives: '', rationale: '' });
          await load();
        }, 'Decision recorded.')}>Record decision</button>
      </section>
      <section className="settings-section">
        <div className="section-title"><span>Timeline{project ? ` · ${project}` : ''}</span></div>
        {entries.length === 0 && <div className="empty-list">No decisions recorded yet</div>}
        <ol className="decision-timeline">
          {entries.map((entry) => (
            <li key={`${entry.date}-${entry.title}`}>
              <time dateTime={entry.date}>{entry.date}</time>
              <strong>{entry.title}</strong>
              <small>{entry.agent}</small>
              <p>{buildDecisionNote({ title: entry.title, context: entry.fields.context ?? entry.fields.note ?? '', chosen: entry.fields.chosen ?? entry.fields.decision ?? '', rationale: entry.fields.rationale ?? entry.fields.why ?? '' })}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
