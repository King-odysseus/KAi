import { AlertTriangle, Bot, Loader2, Moon, Plane, Square, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AutoStatus, AutopilotStatus } from '@kai/contracts';
import { AUTO_ACTIVE, useAutoStatus } from './use-auto-status';
import { AUTOPILOT_ACTIVE, useAutopilotStatus } from './use-autopilot-status';
import { UiButton } from './UiButton';

/**
 * What the composer's border is saying. Red while a run is going, amber when it is not going anywhere on its own —
 * cooling on a rate limit, or waiting on a person — and muted red once it has failed, so red is always worth a look
 * and amber always means "this needs you eventually" rather than "this is broken".
 */
export type ComposerRunState = 'live' | 'waiting' | 'failed';

export interface ComposerRunLineState {
  who: 'autopilot' | 'auto';
  state: ComposerRunState;
  /** The bold opening, so the mode is readable before any of the rest of it is. */
  lead: string;
  /** The run's own sentence about what it is on now. */
  detail: string;
  /** The counters, in the terms that run counts in. */
  meta: string;
  /** Only a run that has not settled can be stopped. */
  canStop: boolean;
}

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
 * The one line the composer wears while a run owns it, or null when nothing does.
 *
 * Kept as a plain function of the two statuses so the wording and the colour can be tested without a DOM — the
 * renderer has no component test harness. Autopilot wins over Auto when both have something to say, because an
 * Autopilot conversation is on a card and the Auto session beside it would be about a different piece of work.
 */
export function composerRunLine(autopilot: AutopilotStatus | null, auto: AutoStatus | null, now = Date.now()): ComposerRunLineState | null {
  if (autopilot) {
    const counts = `${autopilot.cardsDone} of ${autopilot.cardsTotal} card${autopilot.cardsTotal === 1 ? '' : 's'} done`;
    if (AUTOPILOT_ACTIVE.has(autopilot.phase)) {
      const resting = autopilot.phase === 'cooling' && autopilot.resumeAt;
      return {
        who: 'autopilot',
        state: resting ? 'waiting' : 'live',
        lead: 'Autopilot is on',
        detail: resting
          ? `resting until ${clock(autopilot.resumeAt!)} (${remaining(autopilot.resumeAt!, now)} left)`
          : autopilot.message,
        meta: counts,
        canStop: true,
      };
    }
    // A finish is the board's own summary and is said in full on the Studio panel; a failure is the one ending worth
    // leaving on screen, since it is the one that needs a person to go and look at something.
    if (autopilot.phase === 'failed') {
      return { who: 'autopilot', state: 'failed', lead: 'Autopilot stopped', detail: autopilot.message, meta: counts, canStop: false };
    }
    return null;
  }
  if (auto) {
    // "turn 0" read as a run that had not begun while the plan beside it was already part done, so the first turn says
    // it is starting and the counter only appears once there is a turn to count.
    const meta = auto.turnCount === 0 ? 'starting' : auto.maxTurns > 0 ? `turn ${auto.turnCount} of ${auto.maxTurns}` : `turn ${auto.turnCount}`;
    if (AUTO_ACTIVE.has(auto.phase)) {
      const waiting = auto.phase === 'cooling' || auto.phase === 'waiting-for-you';
      const resting = auto.phase === 'cooling' && auto.resumeAt;
      return {
        who: 'auto',
        state: waiting ? 'waiting' : 'live',
        lead: 'Auto is on',
        detail: resting
          ? `resting until ${clock(auto.resumeAt!)} (${remaining(auto.resumeAt!, now)} left)`
          : auto.message,
        meta,
        canStop: true,
      };
    }
    if (auto.phase === 'failed') {
      return { who: 'auto', state: 'failed', lead: 'Auto stopped', detail: auto.message, meta, canStop: false };
    }
  }
  return null;
}

export interface ComposerRun {
  line: ComposerRunLineState;
  /** The run's own log, shown behind the line rather than beside the composer. */
  log: ReadonlyArray<{ at: string; kind: string; text: string }>;
}

/**
 * The live state for whatever is running in this composer, or null when nothing is.
 *
 * Both statuses are subscribed whichever way the answer goes, because which one is running is not known until they
 * arrive: Autopilot for the Studio plan this conversation came from, Auto for the conversation itself.
 */
export function useComposerRun(autopilotProjectId: string | null, conversationId: string | null): ComposerRun | null {
  const autopilot = useAutopilotStatus(autopilotProjectId);
  const auto = useAutoStatus(autopilotProjectId ? null : conversationId);
  const [now, setNow] = useState(() => Date.now());
  const counting = Boolean(autopilot?.resumeAt || auto?.resumeAt);
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);
  const line = composerRunLine(autopilot, auto, now);
  if (!line) return null;
  return { line, log: (line.who === 'autopilot' ? autopilot?.log : auto?.log) ?? [] };
}

interface LineProps {
  state: ComposerRunLineState;
  busy: boolean;
  onStop: () => void;
  onOpenDetails: () => void;
  /** The one step in hand ("Editing payment.service.ts"), from the live activity. */
  step?: string | null;
  /** The plan's own count, which says more than a turn counter does. */
  progress?: { done: number; total: number } | null;
}

/**
 * The composer's single status line: what is being done right now on the left, which run owns the box on the right.
 * The step comes from the live activity so the sentence is said once; the run's own message is only the fallback when
 * there is no step yet. It never repeats the activity card's header or a raw command.
 */
export function ComposerRunLine({ state, busy, onStop, onOpenDetails, step, progress }: LineProps): ReactNode {
  const tone = state.state === 'waiting' ? 'text-[var(--waiting)]' : state.state === 'failed' ? 'text-[var(--failed)]' : 'text-[var(--needs-you)]';
  const count = progress && progress.total > 0 ? `${progress.done} of ${progress.total}` : state.meta;
  return (
    <>
      <span aria-hidden="true" className={tone}>
        {state.state === 'waiting' ? <Moon size={13} /> : state.state === 'failed' ? <AlertTriangle size={13} /> : <Loader2 className="animate-spin" size={13} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text)]" title={step ?? state.detail}>{step ?? state.detail}</span>
      <button type="button" onClick={onOpenDetails} title="Show the run's log and settings" className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-0 bg-transparent p-0 text-xs focus:outline-none focus-visible:underline ${tone}`}>
        <strong className="font-semibold">{state.lead}</strong>
        <span className="text-[var(--text-dim)]">· {count}</span>
      </button>
      <span className="sr-only">{state.lead}. {state.detail}. {state.meta}.</span>
      {state.canStop && (
        <UiButton type="button" variant="secondary" className="!min-h-6 !px-2 !text-xs" onClick={onStop} disabled={busy}>
          <Square size={11} /> Stop
        </UiButton>
      )}
    </>
  );
}

/**
 * The run's log, one click behind the line.
 *
 * The standing panels that used to sit above the message box said all of this all of the time, which is most of why
 * they were hard to read: the answer to "what is it doing" is one sentence, and the rest is only wanted when
 * something looks wrong. `children` is where a run's own settings go, so Auto's tuning is still reachable without a
 * box in the way of the composer.
 */
export function ComposerRunDetails({ title, run, onClose, children }: {
  title: string;
  run: ComposerRun;
  onClose: () => void;
  children?: ReactNode;
}): ReactNode {
  const { line, log } = run;
  return (
    <div className="skills-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="skills-panel run-detail-panel">
        <div className="skills-panel-head">
          <div><span className="eyebrow">Run</span><h2>{title}</h2></div>
          <UiButton type="button" className="icon-button compact" aria-label="Close run details" onClick={onClose}><X size={15} /></UiButton>
        </div>
        <div className={`autopilot-status phase-${line.state}`}>
          <div className="autopilot-line">
            {line.who === 'autopilot' ? <Plane size={14} /> : <Bot size={14} />}
            <strong>{line.detail}</strong>
          </div>
          <p className="studio-note">{line.lead} · {line.meta}</p>
        </div>
        {children}
        {log.length > 0 && (
          <ol className="autopilot-log" aria-label="Run log">
            {[...log].reverse().slice(0, 30).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className={`log-${entry.kind}`}><time>{clock(entry.at)}</time> {entry.text}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
