import { Bot, ChevronDown, ChevronUp, Loader2, Moon, Pause, Play, Square } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  AgentId,
  AutoStatus,
  AutoStartRequest,
  AutonomyMode,
  ContextChip,
  ExecutionMode,
  GoalInput,
  RouteMode,
} from '@kai/contracts';
import { unwrap } from '../types';
import { useRunPanelCollapsed } from './run-panel-collapse';

interface Props {
  projectId: string | null;
  /** The open conversation Auto would carry on; without one it opens a conversation of its own. */
  conversationId: string | null;
  /** The composer's text, sent as the first turn. */
  prompt: string;
  agent: AgentId;
  route: RouteMode;
  autonomy: AutonomyMode;
  execution: ExecutionMode;
  model: string;
  goal?: GoalInput;
  skills?: string[];
  selectedPaths?: string[];
  contextChips?: ContextChip[];
  disabled: boolean;
}

const ACTIVE = new Set<AutoStatus['phase']>([
  'starting', 'working', 'checking', 'switching-provider', 'cooling', 'waiting-for-you', 'splitting',
]);

/** The levels Auto can run at: below these the model stops to ask, and Auto has nobody to ask. */
const WORKING_AUTONOMY = new Set<AutonomyMode>(['autoEdit', 'full']);

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function remaining(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Auto mode: hand one task to the agents and let it run, carrying it across turns until the check command passes.
 * It is not the Studio's Autopilot. That works a board of cards; this works the one task in front of it, and when
 * the CLI's usage window runs out it moves to the API model and back rather than sitting out the wait.
 */
export function AutoModePanel({
  projectId, conversationId, prompt, agent, route, autonomy, execution, model,
  goal, skills, selectedPaths, contextChips, disabled,
}: Props): ReactNode {
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [tracked, setTracked] = useState<string | null>(conversationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [checkCommand, setCheckCommand] = useState('');
  const [apiFallback, setApiFallback] = useState(true);
  const [maxTurns, setMaxTurns] = useState(40);
  const [maxHours, setMaxHours] = useState(12);
  const [maxCostUsd, setMaxCostUsd] = useState(0);
  const [minGapSeconds, setMinGapSeconds] = useState(0);
  const [collapsed, toggleCollapsed] = useRunPanelCollapsed('auto');

  useEffect(() => { setTracked(conversationId); }, [conversationId]);

  useEffect(() => {
    if (!tracked) { setStatus(null); return undefined; }
    let cancelled = false;
    setStatus(null);
    void window.kaiDesktop.autoStatus({ conversationId: tracked })
      .then((result) => { if (!cancelled) setStatus(unwrap(result)); })
      .catch(() => undefined);
    const off = window.kaiDesktop.onAutoChanged((next) => {
      if (next.conversationId === tracked) setStatus(next);
    });
    return () => { cancelled = true; off(); };
  }, [tracked]);

  const running = Boolean(status && ACTIVE.has(status.phase));
  const counting = Boolean(status && (status.resumeAt || status.cliResumeAt));
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);

  const text = prompt.trim();
  const canStart = Boolean(projectId && text) && WORKING_AUTONOMY.has(autonomy);

  async function start(): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const request: AutoStartRequest = {
        ...(tracked ? { conversationId: tracked } : {}),
        projectId,
        prompt: text,
        execution,
        agent,
        ...(model ? { model } : {}),
        route,
        autonomy,
        checkCommand,
        maxTurns,
        maxCostUsd,
        maxHours,
        apiFallback,
        minGapSeconds,
        ...(goal ? { goal } : {}),
        ...(skills?.length ? { skills } : {}),
        ...(selectedPaths?.length ? { selectedPaths } : {}),
        ...(contextChips?.length ? { contextChips } : {}),
      };
      const started = unwrap(await window.kaiDesktop.startAuto(request));
      setTracked(started.conversationId);
      setStatus(started);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (!tracked) return;
    setBusy(true);
    try {
      setStatus(unwrap(await window.kaiDesktop.stopAuto({ conversationId: tracked })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function togglePause(): Promise<void> {
    if (!tracked) return;
    setBusy(true);
    try {
      const call = status?.phase === 'waiting-for-you' ? window.kaiDesktop.resumeAuto : window.kaiDesktop.pauseAuto;
      setStatus(unwrap(await call({ conversationId: tracked })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const progress = status && status.maxTurns > 0 ? Math.min(100, Math.round((status.turnCount / status.maxTurns) * 100)) : 0;
  const provider = status?.activeProvider === 'api'
    ? (status.fallbackProvider ? `${status.fallbackProvider.name}${status.fallbackProvider.model ? ` · ${status.fallbackProvider.model}` : ''}` : 'the API provider')
    : `${agent} (CLI)`;

  return (
    <section className={`autopilot-panel${collapsed ? ' collapsed' : ''}`} aria-label="Auto">
      <div className="autopilot-head">
        <h3><Bot size={15} /> Auto</h3>
        <div className="autopilot-head-actions">
          {running ? (
            <>
              <button type="button" className="secondary-button" onClick={() => void togglePause()} disabled={busy}>
                {busy ? <Loader2 className="spin" size={14} /> : status?.phase === 'waiting-for-you' ? <Play size={14} /> : <Pause size={14} />}
                {status?.phase === 'waiting-for-you' ? 'Resume' : 'Pause'}
              </button>
              <button type="button" className="secondary-button" onClick={() => void stop()} disabled={busy}>
                {busy ? <Loader2 className="spin" size={14} /> : <Square size={14} />} Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={() => void start()}
              disabled={busy || disabled || !canStart}
              title={!text ? 'Describe the task in the composer first' : !projectId ? 'Open a project first' : !WORKING_AUTONOMY.has(autonomy) ? `Auto needs Edit files or Full access, not ${autonomy}. It cannot answer the questions a lower level asks.` : 'Carries this task across turns until the check command passes, switching provider when a limit is hit'}
            >
              {busy ? <Loader2 className="spin" size={14} /> : <Bot size={14} />} {status?.phase === 'finished' || status?.phase === 'stopped' || status?.phase === 'failed' ? 'Run again' : 'Start Auto'}
            </button>
          )}
          <button
            type="button"
            className="composer-icon-button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show Auto details' : 'Minimise Auto'}
            aria-label={collapsed ? 'Show Auto details' : 'Minimise Auto'}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>
      {collapsed && <p className="studio-note run-panel-summary">{status ? status.message : 'Ready when you are.'}</p>}
      {!collapsed && <>
      <p className="studio-note">
        Works the task in the composer on its own, one turn after another, until the check command passes. A burst limit
        is rested out; when the CLI's usage window is spent it carries on with the API provider and returns to the CLI
        when the window reopens. Anything it cannot decide, it stops and asks about.
      </p>

      {!running && (
        <details className="autopilot-settings">
          <summary>Settings</summary>
          <div className="autopilot-fields">
            <label>
              <span>Check command</span>
              <input value={checkCommand} onChange={(event) => setCheckCommand(event.target.value)} placeholder="Blank: detect the project's test command" />
            </label>
            {execution === 'cli' && (
              <label>
                <span>When the CLI window is spent</span>
                <select value={apiFallback ? 'api' : 'wait'} onChange={(event) => setApiFallback(event.target.value === 'api')}>
                  <option value="api">Carry on with the API provider, then return to the CLI</option>
                  <option value="wait">Wait for the CLI window to reopen</option>
                </select>
              </label>
            )}
            <label>
              <span>Most turns</span>
              <input type="number" min={1} max={500} value={maxTurns} onChange={(event) => setMaxTurns(Math.min(500, Math.max(1, Number(event.target.value) || 1)))} />
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
          <p className="studio-note">A cap parks the run for you to raise, rather than ending it. The check command is the only thing that closes the task.</p>
        </details>
      )}

      {!canStart && !running && text && !WORKING_AUTONOMY.has(autonomy) && (
        <p className="studio-note">Auto runs at <strong>Edit files</strong> or <strong>Full access</strong>. At a lower level the model stops to ask, and an unattended run has nobody to ask.</p>
      )}
      {error && <p className="studio-error" role="alert">{error}</p>}

      {status && (
        <div className={`autopilot-status phase-${status.phase}`} aria-live="polite">
          <div className="autopilot-line">
            {status.phase === 'cooling' ? <Moon size={14} /> : running ? <Loader2 className="spin" size={14} /> : null}
            <strong>{status.message}</strong>
          </div>
          {status.phase === 'cooling' && status.resumeAt && (
            <p className="studio-note">Resting until {clock(status.resumeAt)} ({remaining(status.resumeAt, now)} left). {status.restReason ? `Reason: ${status.restReason}` : ''}</p>
          )}
          {status.cliResumeAt && (
            <p className="studio-note">The CLI window reopens at {clock(status.cliResumeAt)} ({remaining(status.cliResumeAt, now)} left); working on {provider} until then.</p>
          )}
          <div className="autopilot-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Turns used"><span style={{ width: `${progress}%` }} /></div>
          <p className="studio-note">
            {status.turnCount} of {status.maxTurns} turns · on {provider}
            {status.checkStatus !== 'unknown' ? ` · check ${status.checkStatus}` : ''}
            {status.splitCount > 0 ? ` · ${status.splitCount} split${status.splitCount === 1 ? '' : 's'}` : ''}
            {status.costUsd > 0 ? ` · about $${status.costUsd.toFixed(2)}` : ''}
          </p>
          {status.log.length > 0 && (
            <ol className="autopilot-log" aria-label="Auto log">
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
