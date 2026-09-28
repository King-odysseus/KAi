import { AlertTriangle, Check, Eye, FileText, LayoutGrid, Loader2, NotebookPen, Palette, Play, RefreshCw, RotateCcw, Settings, SkipForward, Sparkles, Users, Wand2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ARTIFACT_KINDS,
  BOARD_STATUSES,
  interviewGivenAnswers,
  interviewOpenQuestions,
  STUDIO_MAX_ROUNDS,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type InterviewState,
  type StudioArtifacts,
  type StudioBoard,
  type StudioDesign,
  type StudioReadiness,
  type TeamPlanDraft,
} from '@kai/contracts';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';

/**
 * The Project Studio. The first part of it is the interview: one paragraph in, a short set of skippable questions,
 * and `.kai/spec/brief.md` out. The artifacts, the board and the design layer all read that brief, so this screen
 * is the front door to the rest of the studio.
 */
export function StudioView({ activeProject, onOpenSettings, onPlanForTeam }: { activeProject: { id: string; name: string } | null; onOpenSettings: () => void; onPlanForTeam: (plan: TeamPlanDraft) => void }): ReactNode {
  const [readiness, setReadiness] = useState<StudioReadiness | null>(null);
  const [state, setState] = useState<InterviewState | null>(null);
  const [artifacts, setArtifacts] = useState<StudioArtifacts | null>(null);
  const [board, setBoard] = useState<StudioBoard | null>(null);
  const [idea, setIdea] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState<'load' | 'start' | 'answer' | 'finish' | 'reset' | 'generate' | 'plan' | 'card' | 'team' | 'work' | 'design' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState<StudioDesign | null>(null);
  const projectId = activeProject?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setBusy('load');
    setError(null);
    setState(null);
    setArtifacts(null);
    setBoard(null);
    setDesign(null);
    setIdea('');
    setAnswers([]);
    setNotice(null);
    void Promise.all([
      window.kaiDesktop.studioReadiness().then(unwrap),
      projectId ? window.kaiDesktop.studioInterview(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioArtifacts(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioBoard(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioDesign(projectId).then(unwrap) : Promise.resolve(null),
    ]).then(([nextReadiness, interview, nextArtifacts, nextBoard, nextDesign]) => {
      if (cancelled) return;
      setReadiness(nextReadiness);
      setState(interview);
      setArtifacts(nextArtifacts);
      setBoard(nextBoard);
      setDesign(nextDesign);
      if (interview) setIdea(interview.idea);
      setAnswers(interview ? interviewOpenQuestions(interview).map(() => '') : []);
    }).catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    }).finally(() => {
      if (!cancelled) setBusy(null);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // The board is shared work: an agent, or the other window, can move a card while this screen is open.
  useEffect(() => {
    if (!projectId) return undefined;
    return window.kaiDesktop.onStudioBoardChanged((payload) => {
      if (payload.projectId === projectId) setBoard(payload.board);
    });
  }, [projectId]);

  function adopt(next: InterviewState): void {
    setState(next);
    setAnswers(interviewOpenQuestions(next).map(() => ''));
  }

  async function reloadReadiness(): Promise<void> {
    setBusy('load');
    setError(null);
    try {
      setReadiness(unwrap(await window.kaiDesktop.studioReadiness()));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function start(): Promise<void> {
    if (!projectId || !idea.trim()) return;
    setBusy('start');
    setError(null);
    try {
      adopt(unwrap(await window.kaiDesktop.startStudioInterview({ projectId, idea: idea.trim() })));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Sends the round on screen. A blank answer is sent as a skip, which tells the studio to decide that one itself. */
  async function sendAnswers(): Promise<void> {
    if (!projectId || !state) return;
    setBusy('answer');
    setError(null);
    try {
      adopt(unwrap(await window.kaiDesktop.answerStudioInterview({
        projectId,
        answers: interviewOpenQuestions(state).map((question, index) => ({ question, answer: (answers[index] ?? '').trim() })),
      })));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function finish(): Promise<void> {
    if (!projectId) return;
    setBusy('finish');
    setError(null);
    try {
      adopt(unwrap(await window.kaiDesktop.finishStudioInterview(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function reset(): Promise<void> {
    if (!projectId) return;
    const confirmed = await confirmDialog({
      title: 'Start over?',
      detail: 'This clears the questions and answers kept for this project. Any brief already written under .kai/spec stays on disk.',
      confirmLabel: 'Start over',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy('reset');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.resetStudioInterview(projectId));
      setState(null);
      setIdea('');
      setAnswers([]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the model over the whole artifact set. Each artifact is one call, so this is the expensive button. */
  async function generate(): Promise<void> {
    if (!projectId) return;
    setBusy('generate');
    setError(null);
    try {
      setArtifacts(unwrap(await window.kaiDesktop.generateStudioArtifacts(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function generateOne(kind: ArtifactKind): Promise<void> {
    if (!projectId) return;
    setBusy('generate');
    setError(null);
    try {
      setArtifacts(unwrap(await window.kaiDesktop.generateStudioArtifact({ projectId, kind })));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function plan(): Promise<void> {
    if (!projectId) return;
    setBusy('plan');
    setError(null);
    try {
      setBoard(unwrap(await window.kaiDesktop.planStudioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Reads the design from open-pencil: the tokens go to `.kai/spec`, and a changed node restales its card. */
  async function pullDesign(): Promise<void> {
    if (!projectId) return;
    setBusy('design');
    setError(null);
    try {
      const pulled = unwrap(await window.kaiDesktop.pullStudioDesign(projectId));
      setDesign(pulled.design);
      setBoard(pulled.board);
      setArtifacts(unwrap(await window.kaiDesktop.studioArtifacts(projectId)));
      setNotice(
        pulled.changed.length > 0
          ? `Pulled the design: ${pulled.changed.length} node${pulled.changed.length === 1 ? '' : 's'} changed, so the cards drawn from them are stale.`
          : pulled.tokensChanged
            ? `Pulled the design: ${pulled.tokenCount} token${pulled.tokenCount === 1 ? '' : 's'} written and no node had moved.`
            : 'The design has not changed since the last pull.',
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function move(cardId: string, status: BoardStatus): Promise<void> {
    if (!projectId) return;
    setBusy('card');
    setError(null);
    try {
      const moved = unwrap(await window.kaiDesktop.moveStudioCard({ projectId, cardId, status, note: '' }));
      setBoard((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === moved.id ? moved : card)) } : current));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the screenshots-and-DOM check on a UI card. The board it returns already reflects the result. */
  async function checkUi(cardId: string): Promise<void> {
    if (!projectId) return;
    setBusy('card');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.checkStudioCardUi(projectId, cardId));
      setBoard(unwrap(await window.kaiDesktop.studioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** One part per ready card, handed to the Workflows page, where the user reviews and starts it. */
  async function planForTeam(): Promise<void> {
    if (!projectId) return;
    setBusy('team');
    setError(null);
    try {
      onPlanForTeam(unwrap(await window.kaiDesktop.planStudioTeam(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the next ready card with one agent. The agent reports; the board decides what the card's status is. */
  async function workCard(): Promise<void> {
    if (!projectId) return;
    setBusy('work');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.workStudioBoard({ projectId, maxCards: 1 }));
      setBoard(unwrap(await window.kaiDesktop.studioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  const open = state ? interviewOpenQuestions(state) : [];
  const asking = state?.status === 'asking';
  const decided = state ? interviewGivenAnswers(state) : [];
  const briefReady = Boolean(artifacts?.artifacts.some((entry) => entry.kind === 'brief'));
  const staleCount = artifacts?.artifacts.filter((entry) => entry.stale).length ?? 0;

  return (
    <div className="page-view">
      <header className="page-header">
        <div>
          <h1>Project Studio</h1>
          <p>Describe the project in a paragraph. The studio asks what it still needs to know, then writes the brief the board and the agents work from.</p>
        </div>
        <div className="page-actions">
          {readiness && <span className="studio-model">{readiness.ready ? `${readiness.displayName} · ${readiness.model}` : 'Needs setup'}</span>}
          <button type="button" className="secondary-button" onClick={() => void reloadReadiness()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} Check connection
          </button>
          {state && <button type="button" className="secondary-button" onClick={() => void reset()} disabled={busy !== null}><RotateCcw size={14} /> Start over</button>}
        </div>
      </header>

      {error && <p className="studio-notice error" role="alert"><AlertTriangle size={14} /> {error}</p>}
      {notice && <p className="studio-notice" role="status"><Check size={14} /> {notice}</p>}
      {!activeProject && <p className="studio-notice warning" role="status"><AlertTriangle size={14} /> Choose a project first. The brief is written inside the project.</p>}
      {activeProject && readiness && !readiness.ready && (
        <p className="studio-notice warning" role="status">
          <AlertTriangle size={14} />
          <span>{readiness.reason ?? 'The Project Studio is not ready.'}</span>
          <button type="button" className="secondary-button" onClick={onOpenSettings}><Settings size={13} /> Open Settings</button>
        </p>
      )}

      <section className="studio-grid">
        <article className="studio-card">
          <h2><NotebookPen size={16} /> The idea</h2>
          {state?.status === 'done' ? (
            <>
              <p className="studio-goal">{state.goal || state.idea}</p>
              <p className="studio-note"><FileText size={13} /> Written to <code>{state.briefPath ?? '.kai/spec/brief.md'}</code></p>
              <p className="studio-note">The artifacts, the board, and the design layer are built from this brief. Scroll down to review them.</p>
            </>
          ) : (
            <>
              <textarea
                className="studio-idea"
                value={idea}
                onChange={(event) => setIdea(event.target.value)}
                placeholder="A booking site for a two-chair barber shop: customers pick a time, pay a deposit, and the owner sees the day's list on her phone."
                rows={6}
                disabled={Boolean(state) || busy !== null}
              />
              {state ? (
                <p className="studio-note">Interview in progress. A blank answer counts as a skip, and the studio decides those itself.</p>
              ) : (
                <button type="button" className="primary-button" onClick={() => void start()} disabled={!projectId || !readiness?.ready || !idea.trim() || busy !== null}>
                  {busy === 'start' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Start the interview
                </button>
              )}
            </>
          )}
        </article>

        <article className="studio-card">
          <h2><Sparkles size={16} /> Questions</h2>
          {busy === 'load' && <p className="studio-note"><Loader2 className="spin" size={13} /> Reading the project…</p>}
          {busy !== 'load' && !state && <p className="studio-note">Nothing to answer yet. Describe the idea on the left and start.</p>}
          {state?.status === 'done' && (
            <>
              <p className="studio-note"><Check size={13} /> The interview is finished.</p>
              {state.assumptions.length > 0 && <Notes title="Assumed" items={state.assumptions} />}
              {decided.length > 0 && (
                <>
                  <h3>Decided</h3>
                  <dl className="studio-decisions">
                    {decided.map((item) => <div key={item.question}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}
                  </dl>
                </>
              )}
            </>
          )}
          {asking && state && (
            <>
              <p className="studio-note">Round {state.rounds.length} of {STUDIO_MAX_ROUNDS}. Skip anything you would rather leave to the agents.</p>
              {state.goal && <p className="studio-goal">{state.goal}</p>}
              {state.assumptions.length > 0 && <Notes title="Assumed so far" items={state.assumptions} />}
              {open.map((question, index) => (
                <label key={question} className="studio-question">
                  <span>{question}</span>
                  <textarea
                    value={answers[index] ?? ''}
                    onChange={(event) => setAnswers((current) => current.map((value, position) => (position === index ? event.target.value : value)))}
                    rows={3}
                    placeholder="Answer, or leave it blank to skip"
                    disabled={busy !== null}
                  />
                </label>
              ))}
              {open.length === 0 && <p className="studio-note">No questions this round.</p>}
              <div className="studio-actions">
                <button type="button" className="primary-button" onClick={() => void sendAnswers()} disabled={busy !== null}>
                  {busy === 'answer' ? <Loader2 className="spin" size={14} /> : <SkipForward size={14} />} Send answers
                </button>
                <button type="button" className="secondary-button" onClick={() => void finish()} disabled={busy !== null}>
                  {busy === 'finish' ? <Loader2 className="spin" size={14} /> : <FileText size={14} />} Write the brief now
                </button>
              </div>
            </>
          )}
        </article>
      </section>

      {activeProject && briefReady && (
        <section className="studio-stack">
          <article className="studio-card">
            <h2><FileText size={16} /> Artifacts</h2>
            <p className="studio-note">
              One file each under <code>.kai/spec</code>. Regenerating one flags everything that reads it stale, so the board never trusts a document built on an old decision.
            </p>
            <div className="page-actions">
              <button type="button" className="primary-button" onClick={() => void generate()} disabled={busy !== null || !readiness?.ready}>
                {busy === 'generate' ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />} Generate all
              </button>
              {staleCount > 0 && <span className="studio-model">{staleCount} stale</span>}
            </div>
            <ul className="studio-artifacts">
              {ARTIFACT_KINDS.map((kind) => {
                const entry = artifacts?.artifacts.find((item) => item.kind === kind);
                return (
                  <li key={kind} className={entry?.stale ? 'stale' : undefined}>
                    <div>
                      <strong>{kind}</strong>
                      <span className="studio-note">
                        {entry ? <>{entry.generatedBy} · v{entry.version}{entry.stale ? ` · ${entry.staleReason ?? 'stale'}` : ''}</> : 'Not written yet'}
                      </span>
                    </div>
                    {kind !== 'brief' && kind !== 'tokens' && (
                      <button type="button" className="secondary-button" onClick={() => void generateOne(kind)} disabled={busy !== null || !readiness?.ready}>
                        {entry ? <RefreshCw size={13} /> : <Play size={13} />} {entry ? 'Regenerate' : 'Generate'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="studio-card">
            <h2><Palette size={16} /> Design</h2>
            <p className="studio-note">
              open-pencil is the source of truth for tokens and for which screens exist. Pulling writes <code>.kai/spec/design/tokens.json</code> (the style guide is written from those tokens), gives each component and page its card, and marks the cards drawn from a node you changed. The editor has to be running with the same token KAI holds in Settings.
            </p>
            <div className="page-actions">
              <button type="button" className="secondary-button" onClick={() => void pullDesign()} disabled={busy !== null}>
                {busy === 'design' ? <Loader2 className="spin" size={14} /> : <Palette size={14} />} Pull the design
              </button>
              {design?.pulledAt && design.pulledAt !== new Date(0).toISOString() && (
                <span className="studio-model">{design.components.length} in the design · last pulled {design.pulledAt.slice(0, 16).replace('T', ' ')}</span>
              )}
            </div>
            {design && design.components.length > 0 && (
              <ul className="studio-list">
                {design.components.slice(0, 20).map((component) => (
                  <li key={component.id}>{component.name} <span className="studio-kind">{component.screen ? 'page' : 'component'}</span></li>
                ))}
              </ul>
            )}
          </article>

          <article className="studio-card">
            <h2><LayoutGrid size={16} /> Board</h2>
            <p className="studio-note">Cards built from the stories. A card reaches done only through a passing check that still matches the working tree.</p>
            <div className="page-actions">
              <button type="button" className="primary-button" onClick={() => void plan()} disabled={busy !== null || !readiness?.ready}>
                {busy === 'plan' ? <Loader2 className="spin" size={14} /> : <LayoutGrid size={14} />} {board?.cards.length ? 'Rebuild the board' : 'Build the board'}
              </button>
              <button type="button" className="secondary-button" onClick={() => void planForTeam()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="One agent per ready card, reviewed on the Workflows page before anything runs">
                {busy === 'team' ? <Loader2 className="spin" size={14} /> : <Users size={14} />} Plan these for the team
              </button>
              <button type="button" className="secondary-button" onClick={() => void workCard()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="Runs the next ready card with one agent. The card stops at review; the board decides when it is done.">
                {busy === 'work' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Work the next card
              </button>
            </div>
            {board && board.cards.length > 0 ? (
              <div className="studio-board">
                {BOARD_STATUSES.map((status) => {
                  const cards = board.cards.filter((card) => card.status === status);
                  return (
                    <div key={status} className="studio-column">
                      <h3>{status} <span className="studio-count">{cards.length}</span></h3>
                      {cards.map((card) => <BoardCardView key={card.id} card={card} busy={busy !== null} onMove={move} onCheckUi={checkUi} />)}
                      {cards.length === 0 && <p className="studio-note">Empty</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="studio-note">No board yet. Generate the stories, then build the board.</p>
            )}
          </article>
        </section>
      )}
    </div>
  );
}

function BoardCardView({ card, busy, onMove, onCheckUi }: { card: BoardCard; busy: boolean; onMove: (id: string, status: BoardStatus) => Promise<void>; onCheckUi: (id: string) => Promise<void> }): ReactNode {
  return (
    <div className={`studio-tile${card.stale ? ' stale' : ''}`}>
      <div className="studio-tile-head">
        <strong>{card.title}</strong>
        <span className="studio-kind">{card.kind}</span>
      </div>
      {card.stale && <p className="studio-note"><AlertTriangle size={12} /> {card.staleReason ?? 'Something this card reads changed.'}</p>}
      {card.claimedBy && <p className="studio-note"><Loader2 size={12} /> Held by {card.claimedBy}</p>}
      {card.check && <p className="studio-note">{card.check.visual === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />} Visual check {card.check.visual ?? 'not run'} · {card.check.screenshots.length} shots</p>}
      {(card.kind === 'component' || card.kind === 'page') && (
        <button type="button" className="secondary-button" onClick={() => void onCheckUi(card.id)} disabled={busy || !card.route}>
          <Eye size={13} /> {card.route ? 'Check the screen' : 'No route set'}
        </button>
      )}
      <select
        className="studio-move"
        value={card.status}
        onChange={(event) => void onMove(card.id, event.target.value as BoardStatus)}
        disabled={busy}
        aria-label={`Move ${card.title}`}
      >
        {BOARD_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
    </div>
  );
}

function Notes({ title, items }: { title: string; items: string[] }): ReactNode {
  return (
    <>
      <h3>{title}</h3>
      <ul className="studio-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The Project Studio encountered an unexpected error.';
}
