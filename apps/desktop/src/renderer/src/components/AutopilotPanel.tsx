import { ChevronDown, ChevronUp, Loader2, Moon, Plane, Square } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AutopilotStatus } from '@kai/contracts';
import { unwrap } from '../types';
import { useRunPanelCollapsed } from './run-panel-collapse';

interface Props {
  projectId: string;
  /** True when the board has a card to start from. */
  hasWork: boolean;
  /** Cards currently blocked, so a way to put them back can be offered. */
  blockedCount: number;
  /** Another action on the screen is running, so starting is held back. */
  disabled: boolean;
}

const ACTIVE = new Set<AutopilotStatus['phase']>(['working', 'checking', 'cooling']);

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
export function AutopilotPanel({ projectId, hasWork, blockedCount, disabled }: Props): ReactNode {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [execution, setExecution] = useState<'api' | 'cli'>('api');
  const [checkCommand, setCheckCommand] = useState('');
  const [maxHours, setMaxHours] = useState(12);
  const [maxCostUsd, setMaxCostUsd] = useState(0);
  const [attemptsPerCard, setAttemptsPerCard] = useState(3);
  const [minGapSeconds, setMinGapSeconds] = useState(0);
  const [collapsed, toggleCollapsed] = useRunPanelCollapsed('autopilot');

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void window.kaiDesktop.autopilotStatus({ projectId }).then((result) => {
      if (!cancelled) setStatus(unwrap(result));
    }).catch(() => undefined);
    const off = window.kaiDesktop.onAutopilotChanged((next) => {
      if (next.projectId === projectId) setStatus(next);
    });
    return () => { cancelled = true; off(); };
  }, [projectId]);

  const running = Boolean(status && ACTIVE.has(status.phase));
  const cooling = status?.phase === 'cooling' && Boolean(status.resumeAt);
  useEffect(() => {
    if (!cooling) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [cooling]);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(unwrap(await window.kaiDesktop.startAutopilot({ projectId, execution, checkCommand, maxCards: 100, maxHours, maxCostUsd, attemptsPerCard, minGapSeconds })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requeue(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { requeued } = unwrap(await window.kaiDesktop.requeueAutopilot({ projectId }));
      setError(requeued === 0 ? 'No cards Autopilot gave up on were found.' : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    try {
      setStatus(unwrap(await window.kaiDesktop.stopAutopilot({ projectId })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const progress = status && status.cardsTotal > 0 ? Math.round((status.cardsDone / status.cardsTotal) * 100) : 0;

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
            <button type="button" className="primary-button" onClick={() => void start()} disabled={busy || disabled || !hasWork} title={hasWork ? 'Works every card on the board, one after another, and rests when a provider rate-limits' : blockedCount > 0 ? 'Every card on the board is blocked. Put them back in the queue below, then start.' : 'Build the board first'}>
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
      {collapsed && <p className="studio-note run-panel-summary">{status ? status.message : 'Ready when you are.'}</p>}
      {!collapsed && <>
      <p className="studio-note">
        Works the whole board on its own: one agent per card, a check after each, a retry with the failure when it fails, and a rest when the provider rate-limits.
        A card is only closed when its check passes; a card that never passes is parked as blocked and the rest carry on.
      </p>

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

      {error && <p className="studio-error" role="alert">{error}</p>}

      {!running && blockedCount > 0 && (
        <p className="studio-note">
          {blockedCount} card{blockedCount === 1 ? ' is' : 's are'} blocked.{' '}
          <button type="button" className="link-button" onClick={() => void requeue()} disabled={busy}>Put the ones Autopilot gave up on back in the queue</button>
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
