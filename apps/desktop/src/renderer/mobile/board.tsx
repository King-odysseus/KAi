import { useEffect, useState, type ReactNode } from 'react';
import type { ArtifactEntry, BoardCard, BoardStatus } from '@kai/contracts';
import { TopBar } from './chrome';
import { board as boardActions, type RemoteState } from './store';

/** The columns in the order the work moves through them, with the word the phone uses for each. */
const COLUMNS: Array<{ status: BoardStatus; label: string }> = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'ready', label: 'Ready' },
  { status: 'inProgress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
  { status: 'blocked', label: 'Blocked' },
];

function useAction(): { busy: boolean; problem: string | null; run: (work: () => Promise<void>) => void } {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setProblem(null);
    void work()
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'That did not work.'))
      .finally(() => setBusy(false));
  };
  return { busy, problem, run };
}

function cardTone(card: BoardCard): string {
  if (card.status === 'done') return 'done';
  if (card.status === 'blocked' || card.stale) return 'fail';
  if (card.status === 'inProgress') return 'run';
  if (card.status === 'ready') return 'wait';
  return 'soft';
}

/** Where a card can go from here. `done` is offered like any other move: the board itself refuses it. */
function movesFrom(card: BoardCard): BoardStatus[] {
  return COLUMNS.map((column) => column.status).filter((status) => status !== card.status);
}

function CardSheet({ card, state, onClose }: { card: BoardCard; state: RemoteState; onClose: () => void }) {
  const [note, setNote] = useState('');
  const { busy, problem, run } = useAction();
  // Holding a card records *who* is on it, so the name offered is the agent the desktop would run.
  const holder = state.bootstrap?.settings.defaultAgent ?? 'codex';
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="row">
          <span className={`chip ${cardTone(card)}`}>{card.kind}</span>
          <span className="meta mono flush">{card.status}</span>
        </div>
        <h2 className="detail-title">{card.title}</h2>
        {card.stale && <div className="meta danger">Stale: {card.staleReason ?? 'an artifact it reads has changed'}</div>}
        {card.claimedBy && <div className="meta dim">Held by {card.claimedBy}</div>}
        {card.dependsOn.length > 0 && <div className="meta dim">Needs {card.dependsOn.join(', ')} done first</div>}

        {card.acceptance.length > 0 && (
          <>
            <div className="section-head">Acceptance</div>
            {card.acceptance.map((line) => <div className="meta" key={line}>· {line}</div>)}
          </>
        )}
        {card.notes && (
          <>
            <div className="section-head">Notes</div>
            <div className="meta">{card.notes}</div>
          </>
        )}

        <div className="section-head">Note for the move</div>
        <input className="note-field" value={note} placeholder="Why it is moving (optional)" onChange={(event) => setNote(event.target.value)} />
        {problem && <div className="meta danger">{problem}</div>}

        <div className="section-head">Move to</div>
        <div className="moves">
          {movesFrom(card).map((status) => (
            <button
              type="button"
              key={status}
              className="verb"
              disabled={busy}
              onClick={() => run(async () => {
                await boardActions.move(card.id, status, note);
                onClose();
              })}
            >
              {COLUMNS.find((column) => column.status === status)?.label ?? status}
            </button>
          ))}
        </div>

        {card.status === 'ready' && !card.claimedBy && (
          <button
            type="button"
            className="act approve"
            disabled={busy}
            onClick={() => run(async () => {
              // Holding a card is claiming it for the agent that would work it — the phone does not run it.
              await boardActions.claim(card.id, holder);
              onClose();
            })}
          >
            Hold for {holder}
          </button>
        )}
        <button type="button" className="linky" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ArtifactRow({ entry }: { entry: ArtifactEntry }) {
  return (
    <div className="card">
      <div className="row">
        <span className={`chip ${entry.stale ? 'fail' : entry.version > 0 ? 'done' : 'soft'}`}>{entry.kind}</span>
        <span className="meta mono flush">v{entry.version}</span>
      </div>
      <div className="meta">{entry.path}</div>
      <div className="meta dim">
        {entry.version === 0 ? 'Not written yet' : `${entry.generatedBy} · ${new Date(entry.updatedAt).toLocaleString()}`}
      </div>
      {entry.stale && <div className="meta danger">Stale: {entry.staleReason ?? 'something it reads changed'}</div>}
    </div>
  );
}

/**
 * One project's Studio board. The project is chosen by the console rather than by this screen, because
 * the Projects section opens the same board for a project the user picked there — so the selection has
 * to outlive the tab it was made on, and there is one place that owns it.
 */
export function Board({ state, projectId, onProjectChange }: {
  state: RemoteState;
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
}): ReactNode {
  const projects = state.bootstrap?.projects ?? [];
  const [open, setOpen] = useState<BoardCard | null>(null);

  useEffect(() => {
    if (projectId) void boardActions.reload(projectId).catch(() => undefined);
  }, [projectId]);

  const view = state.board?.projectId === projectId ? state.board : null;
  return (
    <>
      <TopBar title="Studio">
        <span className={`dot ${state.connected ? '' : 'off'}`} />
        {view ? `${view.cards.length} cards` : 'reading…'}
      </TopBar>
      <div className="scroll">
        <div className="filters">
          {projects.map((project) => (
            <button type="button" key={project.id} className={projectId === project.id ? 'on' : ''} onClick={() => onProjectChange(project.id)}>
              {project.name}
            </button>
          ))}
        </div>

        {!view && <div className="card"><div className="title">Reading the board…</div></div>}

        {view && view.cards.length === 0 && (
          <div className="card">
            <div className="title">No cards yet</div>
            <div className="meta">The Project Studio on the desktop plans a board from the brief and the design.</div>
          </div>
        )}

        {view && COLUMNS.map((column) => {
          const cards = view.cards.filter((card) => card.status === column.status);
          if (cards.length === 0) return null;
          return (
            <div className="stack" key={column.status}>
              <div className="section-head">{column.label} · {cards.length}</div>
              {cards.map((card) => (
                <button type="button" key={card.id} className={`card ${card.status === 'inProgress' ? 'live' : ''}`} onClick={() => setOpen(card)}>
                  <div className="row">
                    <span className={`chip ${cardTone(card)}`}>{card.kind}</span>
                    <span className="meta mono flush">{card.runs.length > 0 ? `${card.runs.length} run${card.runs.length === 1 ? '' : 's'}` : ''}</span>
                  </div>
                  <div className="title">{card.title}</div>
                  <div className="meta">
                    {card.claimedBy ? `Held by ${card.claimedBy}` : card.check ? `Checked ${card.check.at}` : card.route || 'no route yet'}
                  </div>
                  {card.stale && <div className="meta danger">Stale</div>}
                </button>
              ))}
            </div>
          );
        })}

        {view && (
          <>
            <div className="section-head">Spec</div>
            {view.artifacts.length === 0 && <div className="card"><div className="meta">Nothing written under .kai/spec yet.</div></div>}
            {view.artifacts.map((entry) => <ArtifactRow key={entry.kind} entry={entry} />)}
            {view.files.length > 0 && (
              <div className="card">
                <div className="meta dim">Also under .kai/spec:</div>
                {view.files.slice(0, 12).map((file) => <div className="meta mono" key={file}>{file}</div>)}
              </div>
            )}
          </>
        )}
      </div>

      {open && <CardSheet card={open} state={state} onClose={() => setOpen(null)} />}
    </>
  );
}
