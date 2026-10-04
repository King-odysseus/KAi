import { ChevronDown, ChevronUp, Loader2, Moon, Plane, Square } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AutopilotRunRecord } from '@kai/contracts';
import { unwrap } from '../types';
import { useRunPanelCollapsed } from './run-panel-collapse';
import { AUTOPILOT_ACTIVE, useAutopilotStatus } from './use-autopilot-status';

interface Props {
  projectId: string;
  /** The board's own figures, so a run that cannot start says why instead of only disabling the button. */
  ready: number;
  inProgress: number;
  /** Cards in the backlog: work that exists but is waiting on something else to be done first. */
  waiting: number;
  blocked: number;
  /** Another action on the screen is running, so starting is held back. */
  disabled: boolean;
}

/**
 * The settings a run starts with when nobody has changed them.
 *
 * Shared with the Senior Dev, whose "Start Autopilot" button starts the same run this panel's own button does —
 * otherwise the guide would carry a second set of defaults, and the two would drift apart with nobody to notice.
 */
export const DEFAULT_AUTOPILOT_START = {
  execution: 'api' as const,
  checkCommand: '',
  maxCards: 100,
  maxHours: 12,
  maxCostUsd: 0,
  attemptsPerCard: 3,
  minGapSeconds: 0,
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function remaining(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Autopilot: hand the board to the agents and let it run, resting when the provider says it has had enough. */
export function AutopilotPanel({ projectId, ready, inProgress, waiting, blocked, disabled }: Props): ReactNode {
  const status = useAutopilotStatus(projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [execution, setExecution] = useState<'api' | 'cli'>(DEFAULT_AUTOPILOT_START.execution);
  const [checkCommand, setCheckCommand] = useState(DEFAULT_AUTOPILOT_START.checkCommand);
  const [maxHours, setMaxHours] = useState(DEFAULT_AUTOPILOT_START.maxHours);
  const [maxCostUsd, setMaxCostUsd] = useState(DEFAULT_AUTOPILOT_START.maxCostUsd);
  const [attemptsPerCard, setAttemptsPerCard] = useState(DEFAULT_AUTOPILOT_START.attemptsPerCard);
  const [minGapSeconds, setMinGapSeconds] = useState(DEFAULT_AUTOPILOT_START.minGapSeconds);
  const [collapsed, toggleCollapsed] = useRunPanelCollapsed('autopilot');
  const [interrupted, setInterrupted] = useState<AutopilotRunRecord | null>(null);

  const running = Boolean(status && AUTOPILOT_ACTIVE.has(status.phase));
  const cooling = status?.phase === 'cooling' && Boolean(status.resumeAt);
  const hasWork = ready > 0 || inProgress > 0;

  useEffect(() => {
    if (!cooling) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [cooling]);

  /**
   * A run KAI was closed in the middle of: its status died with the process, so nothing else on this screen knows the
   * board is still holding one of its cards. Only asked for while nothing is running, since a live run is the answer.
   */
  useEffect(() => {
    setInterrupted(null);
    if (running) return undefined;
    let cancelled = false;
    void window.kaiDesktop.autopilotInterrupted().then(unwrap)
      .then((runs) => { if (!cancelled) setInterrupted(runs.find((record) => record.studioProjectId === projectId) ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, running]);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await window.kaiDesktop.startAutopilot({ projectId, execution, checkCommand, maxCards: DEFAULT_AUTOPILOT_START.maxCards, maxHours, maxCostUsd, attemptsPerCard, minGapSeconds }).then(unwrap);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requeue(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { requeued } = unwrap(await window.kaiDesktop.requeueAutopilot({ projectId }));
      setNotice(requeued === 0
        ? 'No cards parked by an agent were found. A card is only left alone here if you moved it to Blocked yourself.'
        : `${requeued} card${requeued === 1 ? '' : 's'} back in the queue.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.kaiDesktop.stopAutopilot({ projectId }).then(unwrap);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Starts the recorded run again from the settings it was given; the loop takes back the card it still holds. */
  async function carryOn(): Promise<void> {
    if (!interrupted) return;
    setBusy(true);
    setError(null);
    try {
      setInterrupted(null);
      await window.kaiDesktop.resumeInterruptedAutopilot({ studioProjectId: interrupted.studioProjectId }).then(unwrap);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Hands that card back to the board instead, for someone who would rather start the card clean. */
  async function putBack(): Promise<void> {
    if (!interrupted) return;
    setBusy(true);
    setError(null);
    try {
      await window.kaiDesktop.releaseInterruptedAutopilot({ studioProjectId: interrupted.studioProjectId }).then(unwrap);
      setInterrupted(null);
      setNotice(`"${interrupted.cardTitle}" is back in the queue.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const progress = status && status.cardsTotal > 0 ? Math.round((status.cardsDone / status.cardsTotal) * 100) : 0;

  // Why Start is not available, in words. This used to live only in the button's tooltip, so a board with nothing
  // ready to work looked like a button that simply did not do anything — and the line that replaced it, "Nothing is
  // ready to start.", said the same nothing in a different place.
  const blockedReason = blocked > 0
    ? `No card is ready: ${blocked} card${blocked === 1 ? ' is' : 's are'} blocked, and the other ${waiting} wait ${blocked === 1 ? 'on it' : 'on them'}. Put the blocked ones back in the queue, then start.`
    : 'No card is ready yet: every card is waiting on another card that is not done.';
  // A stalled board is the one case where the screen has something to say and nothing else to show, so the reason
  // goes in the line itself rather than behind a hover. Behind it: the run's own last message, or an honest wait.
  const stalled = !running && !hasWork;
  const summary = stalled ? blockedReason : status ? status.message : 'Ready when you are.';

  return (
    <section className={`autopilot-panel${collapsed ? ' collapsed' : ''}`} aria-label="Autopilot">
      <div className="autopilot-head">
        <h3><Plane size={15} /> Autopilot</h3>
        <div className="autopilot-head-actions">
          {running ? (
            <button type="button" className="secondary-button" onClick={() => void stop()} disabled={busy}>
              {busy ? <Loader2 className="spin" size={14} /> : <Square size={14} />} Stop
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={() => void start()} disabled={busy || disabled || !hasWork} title={hasWork ? 'Works every card on the board, one after another, and rests when a provider rate-limits' : blockedReason}>
              {busy ? <Loader2 className="spin" size={14} /> : <Plane size={14} />} {status?.phase === 'finished' || status?.phase === 'stopped' || status?.phase === 'failed' ? 'Run again' : 'Start Autopilot'}
            </button>
          )}
          <button
            type="button"
            className="composer-icon-button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show Autopilot details' : 'Minimise Autopilot'}
            aria-label={collapsed ? 'Show Autopilot details' : 'Minimise Autopilot'}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>
      {/* On a collapsed panel this line is the whole screen, so the way out of a stall lives in it. It used to be
          inside the expanded half only — which is the half a person with nothing to start never opens. */}
      {collapsed && (
        <p className="studio-note run-panel-summary">
          {summary}{' '}
          {stalled && blocked > 0 && (
            <button type="button" className="link-button" onClick={() => void requeue()} disabled={busy}>Put them back in the queue</button>
          )}
        </p>
      )}
      {/* Outside the collapsed half on purpose: a refused start, and the answer to the button just pressed, are the
          two things a person needs whether or not the panel is open. */}
      {error && <p className="studio-error" role="alert">{error}</p>}
      {notice && <p className="studio-note" role="status">{notice}</p>}
      {!collapsed && <>
      <p className="studio-note">
        Works the whole board on its own: one agent per card, a check after each, a retry with the failure when it fails, and a rest when the provider rate-limits.
        A card is only closed when its check passes; a card that never passes is parked as blocked and the rest carry on.
      </p>

      {interrupted && !running && (
        <p className="studio-note run-interrupted" role="status">
          The board still has &ldquo;{interrupted.cardTitle}&rdquo; marked In progress from an Autopilot run that is no longer going.{' '}
          <button type="button" className="link-button" disabled={busy} onClick={() => void carryOn()}>Carry on where it stopped</button>
          {' or '}
          <button type="button" className="link-button" disabled={busy} onClick={() => void putBack()}>put the card back in the queue</button>.
        </p>
      )}

      {!running && !hasWork && <p className="studio-note run-stalled">{blockedReason}</p>}

      {!running && (
        <details className="autopilot-settings">
          <summary>Settings</summary>
          <div className="autopilot-fields">
            <label>
              <span>Runs through</span>
              <select value={execution} onChange={(event) => setExecution(event.target.value as 'api' | 'cli')}>
                <option value="api">Direct API (your provider, such as DeepSeek)</option>
                <option value="cli">The default CLI agent</option>
              </select>
            </label>
            <label>
              <span>Check command</span>
              <input value={checkCommand} onChange={(event) => setCheckCommand(event.target.value)} placeholder="Blank: detect the project's test command" />
            </label>
            <label>
              <span>Attempts per card</span>
              <input type="number" min={1} max={5} value={attemptsPerCard} onChange={(event) => setAttemptsPerCard(Math.min(5, Math.max(1, Number(event.target.value) || 1)))} />
            </label>
            <label>
              <span>Stop after (hours, 0 = never)</span>
              <input type="number" min={0} max={168} value={maxHours} onChange={(event) => setMaxHours(Math.min(168, Math.max(0, Number(event.target.value) || 0)))} />
            </label>
            <label>
              <span>Stop at spend (USD, 0 = no limit)</span>
              <input type="number" min={0} step={1} value={maxCostUsd} onChange={(event) => setMaxCostUsd(Math.max(0, Number(event.target.value) || 0))} />
            </label>
            <label>
              <span>Seconds between API requests</span>
              <input type="number" min={0} max={120} value={minGapSeconds} onChange={(event) => setMinGapSeconds(Math.min(120, Math.max(0, Number(event.target.value) || 0)))} />
            </label>
          </div>
          <p className="studio-note">The pace also slows by itself after a 429 and speeds back up when the provider stops pushing back.</p>
        </details>
      )}

      {!running && blocked > 0 && (
        <p className="studio-note">
          {blocked} card{blocked === 1 ? ' is' : 's are'} blocked, and each one's reason is on the card.{' '}
          <button type="button" className="link-button" onClick={() => void requeue()} disabled={busy} title="Every card an agent or a check parked. A card you blocked yourself is left where it is.">Put the ones an agent stopped on back in the queue</button>
        </p>
      )}

      {status && (
        <div className={`autopilot-status phase-${status.phase}`} aria-live="polite">
          <div className="autopilot-line">
            {status.phase === 'cooling' ? <Moon size={14} /> : running ? <Loader2 className="spin" size={14} /> : null}
            <strong>{status.message}</strong>
          </div>
          {cooling && status.resumeAt && (
            <p className="studio-note">Resting until {clock(status.resumeAt)} ({remaining(status.resumeAt, now)} left). {status.restReason ? `Reason: ${status.restReason}` : ''}</p>
          )}
          <div className="autopilot-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Cards done"><span style={{ width: `${progress}%` }} /></div>
          <p className="studio-note">
            {status.cardsDone} of {status.cardsTotal} done{status.cardsBlocked > 0 ? ` · ${status.cardsBlocked} blocked` : ''}
            {status.restsTotal > 0 ? ` · ${status.restsTotal} rest${status.restsTotal === 1 ? '' : 's'}` : ''}
            {status.costUsd > 0 ? ` · about $${status.costUsd.toFixed(2)}` : ''}
          </p>
          {status.log.length > 0 && (
            <ol className="autopilot-log" aria-label="Autopilot log">
              {[...status.log].reverse().slice(0, 12).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className={`log-${entry.kind}`}><time>{clock(entry.at)}</time> {entry.text}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      </>}
    </section>
  );
}
