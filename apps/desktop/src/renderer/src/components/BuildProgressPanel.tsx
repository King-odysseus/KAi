import { Loader2, Moon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { deriveBuildProgress, type AutoStatus, type AutopilotStatus, type StudioBoard } from '@kai/contracts';
import { unwrap } from '../types';

interface Props {
  projectId: string | null;
  conversationId: string | null;
  /** Told when a build is running, so the tab can say so while Context is the pane on show. */
  onBuildingChange?: (building: boolean) => void;
}

/** How long a card has been going, or how long is left, in words a person reads at a glance. */
function humanMs(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * How far through the project's board the build is, and a guess at what is left.
 *
 * The board is read from `studio:board-changed`, which every window receives. The running statuses are not: Autopilot
 * and Auto push only to the window that started them, so a pane in another window has to ask again — on every board
 * change, which is the one signal it does get, and on a slow timer while something is running.
 */
export function BuildProgressPanel({ projectId, conversationId, onBuildingChange }: Props): ReactNode {
  const [board, setBoard] = useState<StudioBoard | null>(null);
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const pullStatuses = useMemo(() => async (): Promise<void> => {
    const [nextAutopilot, nextAuto] = await Promise.all([
      projectId ? window.kaiDesktop.autopilotStatus({ projectId }).then(unwrap).catch(() => null) : Promise.resolve(null),
      conversationId ? window.kaiDesktop.autoStatus({ conversationId }).then(unwrap).catch(() => null) : Promise.resolve(null),
    ]);
    setAutopilot(nextAutopilot);
    setAuto(nextAuto);
  }, [projectId, conversationId]);

  useEffect(() => {
    if (!projectId) { setBoard(null); setAutopilot(null); return undefined; }
    let cancelled = false;
    setBoard(null);
    void window.kaiDesktop.studioBoard(projectId).then(unwrap)
      .then((next) => { if (!cancelled) setBoard(next); })
      .catch(() => { if (!cancelled) setBoard(null); });
    void pullStatuses();
    return () => { cancelled = true; };
  }, [projectId, pullStatuses]);

  useEffect(() => {
    if (!projectId) return undefined;
    const offBoard = window.kaiDesktop.onStudioBoardChanged((payload) => {
      if (payload.projectId !== projectId) return;
      setBoard(payload.board);
      // The board moved, so whatever is driving it moved too. Refresh what the pushes may not have reached us with.
      void pullStatuses();
    });
    const offAutopilot = window.kaiDesktop.onAutopilotChanged((next) => { setAutopilot(next); });
    const offAuto = window.kaiDesktop.onAutoChanged((next) => { setAuto(next); });
    return () => { offBoard(); offAutopilot(); offAuto(); };
  }, [projectId, pullStatuses]);

  const running = (autopilot !== null && ['working', 'checking', 'cooling'].includes(autopilot.phase))
    || (auto !== null && ['starting', 'working', 'checking', 'waiting-for-you'].includes(auto.phase));

  // A window that did not start the run gets no pushes, so ask again while something is going.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void pullStatuses(); }, 15_000);
    return () => clearInterval(timer);
  }, [running, pullStatuses]);

  // The elapsed time and the countdown are derived from timestamps already held, so a plain tick moves them without
  // asking the main process for anything.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const progress = board ? deriveBuildProgress({ board, nowMs: now, autopilot, auto }) : null;
  const building = progress !== null && progress.driver !== 'idle';

  // Keyed on the boolean, not on the progress object: that is a new value every render, which would run this on each
  // one just to set the same state back.
  useEffect(() => { onBuildingChange?.(building); }, [building, onBuildingChange]);

  if (!projectId) return <p className="studio-note">Open a project to see its build.</p>;
  if (!board) return <p className="studio-note">Reading the board…</p>;
  if (board.cards.length === 0) return <p className="studio-note">This project has no board yet. Build one in the Studio.</p>;

  const { pace } = progress!;
  const driverLine = progress!.driver === 'autopilot'
    ? 'Autopilot is working the board.'
    : progress!.driver === 'auto'
      ? 'Auto is working a task in this conversation.'
      : progress!.driver === 'board'
        ? 'A card is being worked.'
        : 'Nothing is running. These are the board\'s own figures.';

  return (
    <div className="build-progress">
      <div className="build-head">
        <div>
          <span className="eyebrow">Build</span>
          <h2>{progress!.cardsDone} of {progress!.cardsTotal} done</h2>
        </div>
        {progress!.driver !== 'idle' && <Loader2 className="spin" size={16} />}
      </div>

      <p className="studio-note">{driverLine}</p>

      {progress!.currentCardTitle && (
        <div className="build-now">
          <div className="build-now-label">
            {progress!.driver === 'autopilot' && autopilot?.phase === 'cooling' ? <Moon size={13} /> : null}
            <span>Now</span>
          </div>
          <div className="build-now-card">
            <span>{progress!.currentCardTitle}</span>
            <small>{progress!.currentCardAttempt ? `attempt ${progress!.currentCardAttempt}` : (progress!.actor ?? '')}</small>
          </div>
        </div>
      )}

      <div className="autopilot-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress!.percent} aria-label="Project done">
        <span style={{ width: `${progress!.percent}%` }} />
      </div>

      <p className="studio-note">
        {progress!.cardsDone} done
        {progress!.cardsInFlight > 0 ? ` · ${progress!.cardsInFlight} in progress` : ''}
        {progress!.cardsWaiting > 0 ? ` · ${progress!.cardsWaiting} waiting` : ''}
        {progress!.cardsBlocked > 0 ? ` · ${progress!.cardsBlocked} blocked` : ''}
        {progress!.cardsReview > 0 ? ` · ${progress!.cardsReview} in review` : ''}
        {progress!.elapsedMs !== null ? ` · ${humanMs(progress!.elapsedMs)} so far` : ''}
      </p>

      {pace ? (
        <p className="studio-note">
          <strong className="build-eta">About {humanMs(new Date(pace.etaAt).getTime() - now)} left</strong>{' '}
          ({clock(pace.etaAt)}), roughly {humanMs(pace.msPerCard)} a card.
        </p>
      ) : null}

      {progress!.paceNote && <p className="studio-note build-caveat">{progress!.paceNote}</p>}
    </div>
  );
}
