import { Bot, ChevronDown, ChevronUp, Loader2, Moon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AutoStatus, AutoWaitReason, ExecutionMode } from '@kai/contracts';
import { unwrap } from '../types';
import { readAutoSettings, writeAutoSettings, type AutoSettings } from './auto-settings';
import { useRunPanelCollapsed } from './run-panel-collapse';

interface Props {
  projectId: string | null;
  /** The open conversation Auto would be working in; without one the panel shows nothing to track. */
  conversationId: string | null;
  /** The mode the composer is set to, which is what the provider note below is about. */
  execution: ExecutionMode;
}

const ACTIVE = new Set<AutoStatus['phase']>([
  'starting', 'working', 'checking', 'switching-provider', 'cooling', 'waiting-for-you', 'splitting',
]);

/** What each way of parking on a person reads as in the panel. */
const WAIT_LABELS: Record<AutoWaitReason, string> = {
  approval: 'Waiting for your answer',
  'repeated-failure': 'Waiting: nothing is moving',
  'no-fallback': 'Waiting: no provider to carry on with',
  'cost-cap': 'Waiting: spend limit reached',
  'time-cap': 'Waiting: time limit reached',
  'turn-cap': 'Waiting: turn limit reached',
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

/**
 * Auto's status, log and settings — not its launcher.
 *
 * The task goes in the composer and the composer's send starts the run, the way a mode is chosen and used in one
 * place. This panel used to carry a Start button of its own (and Pause and Stop beside it), which made the same text
 * have two launchers and the running run two sets of controls. It now reports: what the run is doing, what it has
 * done, and the tuning the composer will start the next one with.
 */
export function AutoModePanel({ projectId, conversationId, execution }: Props): ReactNode {
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [tracked, setTracked] = useState<string | null>(conversationId);
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<AutoSettings>(() => readAutoSettings(projectId));
  const [collapsed, toggleCollapsed] = useRunPanelCollapsed('auto');

  useEffect(() => { setTracked(conversationId); }, [conversationId]);

  // The composer reads the same store when it starts a run, so both sides have to be on the same project.
  useEffect(() => { setSettings(readAutoSettings(projectId)); }, [projectId]);
  const update = (change: Partial<AutoSettings>): void => {
    setSettings((current) => {
      const next = { ...current, ...change };
      if (projectId) writeAutoSettings(projectId, next);
      return next;
    });
  };

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

  const progress = status && status.maxTurns > 0 ? Math.min(100, Math.round((status.turnCount / status.maxTurns) * 100)) : 0;
  const provider = status?.activeProvider === 'api'
    ? (status.fallbackProvider ? `${status.fallbackProvider.name}${status.fallbackProvider.model ? ` · ${status.fallbackProvider.model}` : ''}` : 'the API provider')
    : 'the CLI';

  return (
    <section className={`autopilot-panel${collapsed ? ' collapsed' : ''}`} aria-label="Auto">
      <div className="autopilot-head">
        <h3><Bot size={15} /> Auto</h3>
        <div className="autopilot-head-actions">
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
        Send the task above and Auto works it on its own, one turn after another, until the agent&rsquo;s own plan is
        done &mdash; the plan the run keeps in <code>.kai/plan.json</code>. The check command is then run to confirm
        it, and a failure goes straight back to the agent. A burst limit is rested out; when the CLI&rsquo;s usage
        window is spent it carries on with the API provider and returns to the CLI when the window reopens. Anything
        it cannot decide, it stops and asks about.
      </p>

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
          {status.waitReason && !running && WAIT_LABELS[status.waitReason] && (
            <p className="studio-note">{WAIT_LABELS[status.waitReason]}. Press Resume above to carry on from here.</p>
          )}
          {/* An uncapped run has no fraction to draw, so it draws nothing rather than an empty bar. */}
          {status.maxTurns > 0 && (
            <div className="autopilot-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Turns used"><span style={{ width: `${progress}%` }} /></div>
          )}
          <p className="studio-note">
            {status.maxTurns > 0
              ? `${status.turnCount} of ${status.maxTurns} turns`
              : `${status.turnCount} turn${status.turnCount === 1 ? '' : 's'}`} · on {provider}
            {status.checkCommand
              ? ` · check ${status.checkStatus === 'unknown' ? 'pending' : status.checkStatus} (\`${status.checkCommand}\`)`
              : ' · no check command'}
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

      {/* Only while nothing is running: these are what the next send starts with, not what a run in flight is using. */}
      {!running && (
        <details className="autopilot-settings">
          <summary>Settings</summary>
          <div className="autopilot-fields">
            <label>
              <span>Check command</span>
              <input value={settings.checkCommand} onChange={(event) => update({ checkCommand: event.target.value })} placeholder="Blank: the project's test command, when it has one" />
            </label>
            {execution === 'cli' && (
              <label>
                <span>When the CLI window is spent</span>
                <select value={settings.apiFallback ? 'api' : 'wait'} onChange={(event) => update({ apiFallback: event.target.value === 'api' })}>
                  <option value="api">Carry on with the API provider, then return to the CLI</option>
                  <option value="wait">Wait for the CLI window to reopen</option>
                </select>
              </label>
            )}
            <label>
              <span>Most turns (0 = no limit)</span>
              <input type="number" min={0} max={500} value={settings.maxTurns} onChange={(event) => update({ maxTurns: Math.min(500, Math.max(0, Number(event.target.value) || 0)) })} />
            </label>
            <label>
              <span>Stop after (hours, 0 = never)</span>
              <input type="number" min={0} max={168} value={settings.maxHours} onChange={(event) => update({ maxHours: Math.min(168, Math.max(0, Number(event.target.value) || 0)) })} />
            </label>
            <label>
              <span>Stop at spend (USD, 0 = no limit)</span>
              <input type="number" min={0} step={1} value={settings.maxCostUsd} onChange={(event) => update({ maxCostUsd: Math.max(0, Number(event.target.value) || 0) })} />
            </label>
            <label>
              <span>Seconds between API requests</span>
              <input type="number" min={0} max={120} value={settings.minGapSeconds} onChange={(event) => update({ minGapSeconds: Math.min(120, Math.max(0, Number(event.target.value) || 0)) })} />
            </label>
          </div>
          <p className="studio-note">A cap parks the run for you to raise, rather than ending it. The agent&rsquo;s own plan is what closes the task; the check command confirms it once the plan is done.</p>
        </details>
      )}
      </>}
    </section>
  );
}
