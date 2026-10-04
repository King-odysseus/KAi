import { useEffect, useState } from 'react';
import type { AutoStatus } from '@kai/contracts';
import { unwrap } from '../types';

/** Phases where Auto is still going, having not stopped itself and not parked on a person. */
export const AUTO_ACTIVE: ReadonlySet<AutoStatus['phase']> = new Set([
  'starting', 'working', 'checking', 'switching-provider', 'cooling', 'waiting-for-you', 'splitting',
]);

/**
 * The live Auto status for one conversation, or null when Auto has never run in it.
 *
 * The same two halves as the Autopilot hook — one read for a panel that mounted late, one subscription for what
 * happens next — kept here so both run panels read their status the same way.
 */
export function useAutoStatus(conversationId: string | null): AutoStatus | null {
  const [status, setStatus] = useState<AutoStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!conversationId) return undefined;
    let cancelled = false;
    void window.kaiDesktop.autoStatus({ conversationId }).then((result) => {
      if (!cancelled) setStatus(unwrap(result));
    }).catch(() => undefined);
    const off = window.kaiDesktop.onAutoChanged((next) => {
      if (next.conversationId === conversationId) setStatus(next);
    });
    return () => { cancelled = true; off(); };
  }, [conversationId]);
  return status;
}
