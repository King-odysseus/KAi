import { Check, CircleHelp, Play } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { buildRoadmap, type CrewRoadmapPhase, type CrewRun } from '@kai/contracts';
import { Pill, type PillTone } from './Pill';
import { UiButton } from './UiButton';

const STATUS: Record<CrewRoadmapPhase['status'], { label: string; tone: PillTone }> = {
  notStarted: { label: 'Not started', tone: 'neutral' },
  waiting: { label: 'Planned', tone: 'neutral' },
  building: { label: 'In progress', tone: 'info' },
  done: { label: 'Finished, needs your OK', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'success' },
};

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** The part of a phase's name before its description, so a button can say "Accept and start Phase 2". */
function shortName(name: string): string {
  const head = name.split(/[:\-–—]/)[0]?.trim() ?? name;
  return head.length > 0 && head.length <= 30 ? head : name.slice(0, 30);
}

/**
 * The plan phase by phase, instead of one flat board: where each phase stands, what it has cost, a rough cost for the
 * ones not started, and the buttons that matter at each point. A finished phase waits for the person's OK (the plan
 * asks for it), given here by a button that is recorded, with a choice to start the next phase in the same click.
 */
export function CrewRoadmap({ run, busy, onStart, onExplain, onAccept }: {
  run: CrewRun;
  busy: boolean;
  onStart: (phase: string) => void;
  onExplain: (phase: string) => void;
  onAccept: (phase: string, thenStart?: string) => void;
}): ReactNode {
  const rows = useMemo(() => buildRoadmap(run), [run]);
  if (rows.length === 0) return null;
  const finished = run.status === 'completed' || run.status === 'stopped';
  const waitingOnOk = run.approvals.some((item) => item.status === 'pending');
  return (
    <section className="ops-panel crew-roadmap" aria-label="The plan, phase by phase">
      <h3 className="crew-subheading">The plan, phase by phase</h3>
      <ol className="crew-roadmap-list">
        {rows.map((row, index) => {
          const next = rows.slice(index + 1).find((item) => item.status === 'notStarted' || item.status === 'waiting');
          const status = STATUS[row.status];
          const detail = row.tasks > 0
            ? `${row.finished} of ${row.tasks} tasks · ${money(row.costUsd)} spent`
            : row.estimateUsd !== null ? `About ${money(row.estimateUsd)}, going by the finished phases` : 'No tasks yet';
          return (
            <li key={row.key} className={`crew-roadmap-row ${row.status}`}>
              <span className="crew-roadmap-name"><strong>{row.name}</strong><small>{detail}</small></span>
              <Pill tone={status.tone}>{status.label}</Pill>
              <span className="crew-roadmap-actions">
                {row.status === 'notStarted' && (
                  <UiButton type="button" className="primary-button" disabled={busy || !finished || waitingOnOk} onClick={() => onStart(row.name)} title={finished ? `Start ${row.name}` : 'Available when the crew has finished or been stopped'}>
                    <Play size={13} /> Start
                  </UiButton>
                )}
                {row.status === 'done' && (
                  <>
                    <UiButton type="button" className="primary-button" disabled={busy} onClick={() => onAccept(row.name)} title="Record that you are happy with this phase"><Check size={13} /> Accept</UiButton>
                    {next && finished && (
                      <UiButton type="button" className="secondary-button" disabled={busy || waitingOnOk} onClick={() => onAccept(row.name, next.name)} title={`Accept ${shortName(row.name)} and start ${next.name}`}>Accept and start {shortName(next.name)}</UiButton>
                    )}
                  </>
                )}
                <UiButton type="button" className="composer-text-button" disabled={busy} aria-label={`What does "${row.name}" mean?`} title="Explain this phase in plain words" onClick={() => onExplain(row.name)}><CircleHelp size={13} /></UiButton>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
