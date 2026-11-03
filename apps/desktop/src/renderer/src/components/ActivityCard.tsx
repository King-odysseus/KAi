import { AlertTriangle, Check, ChevronDown, ChevronRight, FileCode2, Loader2, Pause, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { deriveActivitySteps, parseDiff, stepSentence, type ActivityStep } from '../activity-steps';
import { activeAgentCount, useLearningNugget, type AgentActivitySummary } from './AgentActivity';
import { UiButton } from './UiButton';

const DIFF_LINE_CLASS = {
  add: 'bg-[var(--success-soft)] text-[var(--success)]',
  remove: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  hunk: 'text-[var(--text-dim)]',
  file: 'text-[var(--text-dim)]',
  context: 'text-[var(--text-muted)]',
} as const;

function StepMark({ state }: { state: ActivityStep['state'] }): ReactNode {
  if (state === 'active') return <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden="true" />;
  if (state === 'failed') return <X size={14} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />;
  return <Check size={14} className="shrink-0 text-[var(--success)]" aria-hidden="true" />;
}

function Counts({ step }: { step: ActivityStep }): ReactNode {
  if (step.added === undefined && step.removed === undefined) return null;
  return (
    <span className="font-mono text-xs">
      <span className="text-[var(--success)]">+{step.added ?? 0}</span>{' '}
      <span className="text-[var(--danger)]">−{step.removed ?? 0}</span>
    </span>
  );
}

function DiffView({ diff }: { diff: string }): ReactNode {
  return (
    <div className="ml-[1.75rem] overflow-hidden rounded-[var(--radius-control)] border border-[color:var(--border-soft)] bg-[var(--bg-inset)] font-mono text-xs" role="region" aria-label="Changes in this file">
      {parseDiff(diff).map((line, index) => <div key={index} className={`whitespace-pre px-3 py-px ${DIFF_LINE_CLASS[line.kind]}`}>{line.text || ' '}</div>)}
    </div>
  );
}

/**
 * The live activity of a run, said once: a header with the current action, one row per file the agent read or edited,
 * and the raw commands behind an arrow. A finished edit opens in place to show what changed; one that is still being
 * written says so and cannot be opened yet. This replaces the strip above the composer and the progress line in the
 * transcript, which both repeated the same sentence.
 */
export function ActivityCard({ events, activity, running, paused, task, elapsedSeconds, tokenEstimate, onOpenFile }: {
  events: readonly PersistedEvent[];
  activity: AgentActivitySummary;
  running: boolean;
  paused: boolean;
  /** What the run was asked to do, in a few words. */
  task?: string;
  elapsedSeconds: number;
  tokenEstimate: number;
  onOpenFile: (path: string) => void;
}): ReactNode {
  const steps = deriveActivitySteps(events);
  const rows = steps.filter((step) => step.kind !== 'command');
  const commands = steps.filter((step) => step.kind === 'command');
  const edits = rows.filter((step) => step.kind === 'edit' && step.state === 'done');
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  // Follow the latest step only while the reader is already at the bottom, the way a terminal follows its output.
  // Scrolling up to read an earlier edit must not be yanked away by the next step.
  const followLatest = useRef(true);
  useEffect(() => {
    if (!running || !followLatest.current) return;
    const node = rowsRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length, running, openRows, allOpen]);

  // As each edit lands, open its comparison once and close the previous one, so the diff streams in place instead of
  // waiting for someone to notice a row became clickable.
  const lastAutoDiff = useRef<string | null>(null);
  useEffect(() => {
    const latest = [...rows].reverse().find((step) => step.kind === 'edit' && step.state === 'done' && step.diff);
    if (!latest || latest.id === lastAutoDiff.current) return;
    const previous = lastAutoDiff.current;
    lastAutoDiff.current = latest.id;
    setOpenRows((current) => {
      const next = new Set(current);
      if (previous) next.delete(previous);
      next.add(latest.id);
      return next;
    });
  }, [rows]);
  const nugget = useLearningNugget(events, running, activity.detail, elapsedSeconds);
  const agents = activeAgentCount(events);
  const stuck = activity.kind === 'waiting' || activity.kind === 'blocked';
  const heading = paused ? 'Paused' : stuck ? activity.label : 'Working';
  const toggleRow = (id: string): void => setOpenRows((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <section className="rounded-[var(--radius-card)] border border-[color:var(--border-soft)] bg-[var(--bg-shell)] p-1.5" aria-live="polite" aria-label="Agent activity">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-[13px]">
        {paused ? <Pause size={14} className="text-[var(--waiting)]" aria-hidden="true" /> : stuck ? <AlertTriangle size={14} className="text-[var(--waiting)]" aria-hidden="true" /> : <Loader2 size={14} className="animate-spin text-[var(--accent)]" aria-hidden="true" />}
        <strong className="font-semibold text-[var(--text)]">{heading}</strong>
        {task && <span className="min-w-0 truncate text-[var(--text-muted)]">· {task}</span>}
        <span className="ml-auto flex items-center gap-3 text-xs text-[var(--text-dim)]">
          {agents > 0 && <span>{agents} agent{agents === 1 ? '' : 's'}</span>}
          {tokenEstimate > 0 && <span>~{tokenEstimate >= 1_000 ? `${(tokenEstimate / 1_000).toFixed(tokenEstimate >= 10_000 ? 0 : 1)}k` : tokenEstimate} tokens</span>}
          <span>{elapsedSeconds}s</span>
        </span>
      </div>
      {stuck && <p className="m-0 px-2.5 pb-1.5 text-xs text-[var(--text-muted)]">{activity.detail}</p>}

      <div
        ref={rowsRef}
        className="activity-card-rows flex flex-col"
        onScroll={(event) => {
          const node = event.currentTarget;
          followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
      >
        {rows.map((step) => {
          const { verb, target } = stepSentence(step);
          const expandable = step.kind === 'edit' && step.state === 'done' && Boolean(step.diff);
          const open = expandable && (allOpen || openRows.has(step.id));
          const canOpenFile = step.kind === 'edit' && Boolean(step.target) && (/[\\/]/.test(step.target) || /\.[a-z0-9]{1,12}$/i.test(step.target));
          return (
            <div key={step.id}>
              <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] ${open ? 'bg-[var(--bg-raised)]' : ''}`}>
                {expandable
                  ? <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} changes in ${target}`} onClick={() => toggleRow(step.id)} className="inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-[var(--text-muted)] focus:outline-none focus-visible:text-[var(--text)]">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                  : <StepMark state={step.state} />}
                <span className="shrink-0 text-[var(--text-muted)]">{verb}</span>
                {canOpenFile
                  ? <button type="button" title={`Open ${step.target} beside the conversation`} onClick={() => onOpenFile(step.target)} className="min-w-0 truncate border-0 bg-transparent p-0 text-left font-mono text-[12.5px] text-[var(--accent)] underline decoration-transparent underline-offset-2 hover:decoration-current focus:outline-none focus-visible:decoration-current">{target}</button>
                  : <span className="min-w-0 truncate font-mono text-[12.5px] text-[var(--text)]" title={step.target}>{target}</span>}
                {step.state === 'active' && step.kind === 'edit' && <span className="text-[var(--text-dim)]">…</span>}
                <Counts step={step} />
                {canOpenFile && <button type="button" aria-label={`Open ${step.target}`} title="Open file beside conversation" onClick={() => onOpenFile(step.target)} className="ml-auto inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-1 text-[var(--text-dim)] hover:text-[var(--accent)] focus:outline-none focus-visible:text-[var(--accent)]"><FileCode2 size={13} /></button>}
              </div>
              {open && step.diff && <div className="pb-1.5"><DiffView diff={step.diff} /></div>}
            </div>
          );
        })}
      </div>

      {(commands.length > 0 || edits.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-1 pt-1.5 text-xs text-[var(--text-dim)]">
          {commands.length > 0 ? (
            <button type="button" aria-expanded={commandsOpen} onClick={() => setCommandsOpen((open) => !open)} className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-[var(--text-dim)] hover:text-[var(--text)] focus:outline-none focus-visible:text-[var(--text)]">
              {commandsOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              {commands.length} command{commands.length === 1 ? '' : 's'}
            </button>
          ) : <span />}
          {edits.length > 0 && <UiButton type="button" variant="quiet" className="!min-h-6 !px-2 !text-xs !text-[var(--accent)]" aria-pressed={allOpen} onClick={() => setAllOpen((open) => !open)}>{allOpen ? 'Hide all changes' : 'Show all changes'}</UiButton>}
        </div>
      )}
      {commandsOpen && (
        <ul className="m-0 mx-2.5 mb-1.5 flex list-none flex-col gap-1 rounded-[var(--radius-control)] bg-[var(--bg-inset)] p-2 font-mono text-xs text-[var(--text-muted)]">
          {commands.map((step) => <li key={step.id} className="flex items-start gap-2 break-all"><StepMark state={step.state} /><span>{step.target}</span></li>)}
        </ul>
      )}

      {nugget && <p className="m-0 border-t border-[color:var(--border-soft)] px-2.5 pb-1 pt-2 text-xs leading-relaxed text-[var(--text-dim)]" aria-label="Learning nugget"><strong className="font-semibold text-[var(--text-muted)]">Learning nugget · </strong>{nugget}</p>}
    </section>
  );
}
