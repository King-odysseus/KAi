import { useEffect, useState, type ReactNode } from 'react';
import type { ConversationRecord } from '@kai/contracts';
import { Composer, ago } from './views';
import { TopBar } from './chrome';
import { loadConversation, loadConversations, projectName, type RemoteState } from './store';

/** How many turns of a thread the phone shows. Enough to place the work; not a transcript. */
const TURN_LIMIT = 12;

/** The last thing said, so a row reads as a thread rather than as a title. */
function lastLine(record: ConversationRecord): string {
  const last = record.turns[record.turns.length - 1];
  if (!last) return 'No turns yet';
  const who = last.role === 'user' ? 'You' : 'KAI';
  const text = last.text.replace(/\s+/g, ' ').trim();
  if (!text) return `${who} sent something this screen does not show.`;
  return `${who}: ${text.length > 96 ? `${text.slice(0, 96)}…` : text}`;
}

/**
 * The desktop's Workspace, as a phone can hold it: the threads, newest first, and each one openable so a
 * turn can be sent into it. There is no file tree and no editor here — the point of this section is
 * finding the conversation that is doing the work, then talking to it.
 */
export function Workspace({ state, onOpen }: { state: RemoteState; onOpen: (conversationId: string) => void }): ReactNode {
  const [filter, setFilter] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const records = state.conversations;

  useEffect(() => {
    if (records) return;
    void loadConversations().catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'The conversations could not be read.');
    });
  }, [records]);

  const all = records ?? [];
  const projects = [...new Set(all.map((record) => record.projectId).filter((id): id is string => Boolean(id)))];
  const shown = filter ? all.filter((record) => record.projectId === filter) : all;

  return (
    <>
      <TopBar title="Workspace">
        <span className={`dot ${state.connected ? '' : 'off'}`} />
        {records ? `${records.length} thread${records.length === 1 ? '' : 's'}` : 'reading…'}
      </TopBar>
      <div className="scroll">
        {projects.length > 1 && (
          <div className="filters">
            <button type="button" className={filter === null ? 'on' : ''} onClick={() => setFilter(null)}>All projects</button>
            {projects.map((id) => (
              <button type="button" key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
                {projectName(state, id) ?? id}
              </button>
            ))}
          </div>
        )}

        {problem && (
          <div className="card">
            <div className="title">Could not read the conversations</div>
            <div className="meta">{problem}</div>
          </div>
        )}

        {!problem && records && records.length === 0 && (
          <div className="card">
            <div className="title">No conversations yet</div>
            <div className="meta">A thread started on the desktop appears here, and can be continued from the phone.</div>
          </div>
        )}

        {shown.map((record) => (
          <button type="button" key={record.id} className={`card ${record.unread ? 'live' : ''}`} onClick={() => onOpen(record.id)}>
            <div className="row">
              <span className={`chip ${record.unread ? 'wait' : 'soft'}`}>{record.unread ? 'Unread' : record.activeAgent ?? 'no agent'}</span>
              <span className="meta mono flush">{ago(record.updatedAt)}</span>
            </div>
            <div className="title">{record.title}</div>
            <div className="meta">{lastLine(record)}</div>
            <div className="meta dim">{projectName(state, record.projectId) ?? 'No project'}</div>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * One thread: the last turns, whatever is arriving on the live tail, and the bar that sends a turn into
 * it. This is the phone's half of "continue it" — the other half is a run's own detail, which is where
 * a run that is still stepping through a workflow is stopped and resumed.
 */
export function ConversationDetail({ state, conversationId, backLabel, onBack, onOpenRun }: {
  state: RemoteState;
  conversationId: string;
  backLabel: string;
  onBack: () => void;
  onOpenRun: (workflowId: string) => void;
}): ReactNode {
  // The list carries the turns already; a conversation opened from a run's own detail may not be in it.
  const fromList = state.conversations?.find((record) => record.id === conversationId) ?? null;
  const record = fromList ?? (state.conversation?.id === conversationId ? state.conversation : null);
  const live = state.tails[conversationId] ?? '';
  const queued = state.sent[conversationId] ?? [];
  const run = state.runs.find((candidate) => candidate.conversationId === conversationId) ?? null;

  useEffect(() => {
    // The composer's agent, route and autonomy come from the conversation's own record.
    void loadConversation(conversationId);
  }, [conversationId]);

  const turns = record?.turns.slice(-TURN_LIMIT) ?? [];
  return (
    <>
      <div className="detail-head">
        <button type="button" className="back" onClick={onBack}>‹ {backLabel}</button>
        <h2 className="detail-title">{record?.title ?? 'This conversation'}</h2>
        <div className="kv">
          <div><span className="k">Project</span><span className="v">{projectName(state, record?.projectId ?? null) ?? '—'}</span></div>
          <div><span className="k">Agent</span><span className="v">{record?.activeAgent ?? '—'}</span></div>
          <div><span className="k">Updated</span><span className="v">{record ? ago(record.updatedAt) : '—'}</span></div>
        </div>
      </div>
      <div className="scroll">
        {run && (
          <button type="button" className="card" onClick={() => onOpenRun(run.workflow.id)}>
            <div className="row">
              <span className={`chip ${run.workflow.status === 'running' ? 'run' : 'soft'}`}>{run.workflow.status}</span>
              <span className="meta mono flush">steps</span>
            </div>
            <div className="title">Open the run</div>
            <div className="meta">{run.workflow.title}</div>
          </button>
        )}

        {turns.length === 0 && !live && (
          <div className="card">
            <div className="title">Nothing said yet</div>
            <div className="meta">Send the first turn below, or wait for the desktop to write one.</div>
          </div>
        )}
        {turns.length > 0 && <div className="section-head">Last {turns.length === 1 ? 'turn' : `${turns.length} turns`}</div>}
        {turns.map((turn) => (
          <div className="card" key={turn.id}>
            <div className="row">
              <span className={`chip ${turn.role === 'user' ? 'soft' : 'run'}`}>{turn.role === 'user' ? 'You' : 'KAI'}</span>
              <span className="meta mono flush">{ago(turn.createdAt)}</span>
            </div>
            <div className="meta flush">{turn.text || '—'}</div>
          </div>
        ))}

        {live && (
          <>
            <div className="section-head">Live</div>
            <div className="log">{live}</div>
          </>
        )}

        {queued.length > 0 && (
          <>
            <div className="section-head">Sent from this phone</div>
            <div className="card">
              {queued.map((turn) => (
                <div className="row" key={`${turn.at}:${turn.text}`}>
                  <span className="meta flush">{turn.text}</span>
                  <span className="meta mono flush">{new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
              <div className="meta dim">Waiting for the agent to answer. It clears on its first line of output.</div>
            </div>
          </>
        )}
      </div>
      <Composer state={state} conversationId={conversationId} model={run?.workflow.model} workflow={run?.workflow} />
    </>
  );
}
