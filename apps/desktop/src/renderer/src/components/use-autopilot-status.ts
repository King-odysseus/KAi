import { useEffect, useState } from 'react';
import type { AutopilotStatus } from '@kai/contracts';
import { unwrap } from '../types';

/** Phases where Autopilot is still going and has something to stop. Mirrors the board panel's own set. */
export const AUTOPILOT_ACTIVE: ReadonlySet<AutopilotStatus['phase']> = new Set(['working', 'checking', 'cooling']);

/**
 * The live Autopilot status for one Studio plan, or null when nothing has run for it.
 *
 * Autopilot pushes its status only to the window that started the run, and only while it is going, so the first read
 * and the subscription are both needed: the read covers a window opened later or a run that has since settled, the
 * push covers everything after. The Studio's board panel and the composer's run line want exactly this, so it is one
 * hook rather than two effects that could quietly drift apart.
 */
export function useAutopilotStatus(projectId: string | null): AutopilotStatus | null {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!projectId) return undefined;
    let cancelled = false;
    void window.kaiDesktop.autopilotStatus({ projectId }).then((result) => {
      if (!cancelled) setStatus(unwrap(result));
    }).catch(() => undefined);
    const off = window.kaiDesktop.onAutopilotChanged((next) => {
      if (next.projectId === projectId) setStatus(next);
    });
    return () => { cancelled = true; off(); };
  }, [projectId]);
  return status;
}
