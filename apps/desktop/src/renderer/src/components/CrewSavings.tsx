import type { ReactNode } from 'react';
import { Cpu } from 'lucide-react';
import { crewSavings } from '@kai/contracts';
import type { CrewRun } from '@kai/contracts';

const money = (value: number): string => `$${value.toFixed(2)}`;

/**
 * How much of the building stayed on the person's own models. It reads the run's own counts, and the estimate compares
 * each local build with what this run's paid builds cost on average, so it is never a guess from a price list. With no
 * paid build to compare against it says so instead of showing a number.
 */
export function CrewSavingsStrip({ run }: { run: Pick<CrewRun, 'tasks' | 'tiers' | 'spentUsd'> }): ReactNode {
  const saved = crewSavings(run);
  const builds = saved.localBuilds + saved.cloudBuilds;
  if (builds === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-panel)] px-3 py-2 text-xs text-[var(--text)]" role="status" aria-label="Savings so far">
      <span className="inline-flex items-center gap-1.5 font-semibold"><Cpu size={13} aria-hidden="true" /> {saved.localBuilds} of {builds} builds ran on your own models</span>
      {saved.escalations > 0 && <span className="text-[var(--text-dim)]">{saved.escalations} moved to a stronger model after the local one got stuck</span>}
      <span className="text-[var(--text-dim)]">Paid spend {money(saved.spentUsd)}</span>
      {saved.estimatedSavedUsd !== null
        ? <span className="text-[var(--text-dim)]" title="Each local build compared with the average cost of this run's paid builds">About {money(saved.estimatedSavedUsd)} saved (estimate)</span>
        : <span className="text-[var(--text-dim)]">A savings estimate appears once one paid build gives it something to compare with</span>}
    </div>
  );
}
