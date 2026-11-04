import { ChevronDown, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { relativeTime } from '../types';
import { BLOCKED_BY_LABEL, blockedActions } from './blocked-actions';
import { UiButton } from './UiButton';

/**
 * Every call this conversation tried that something stopped, collapsed to a count until opened.
 *
 * A run that is quietly stuck is often stuck on the same blocked call, repeated, and today the only way to see that
 * is to scroll the whole transcript looking for it. This reads the conversation's own events instead, so the
 * pattern — three refused pushes, a hook that keeps saying no — is visible at a glance.
 */
const DISMISSED_PREFIX = 'kai.blockedActions.dismissedThrough.';

function readDismissed(conversationId: string): string {
  try { return window.localStorage.getItem(`${DISMISSED_PREFIX}${conversationId}`) ?? ''; } catch { return ''; }
}

export function BlockedActionsStrip({ conversationId, events }: { conversationId: string; events: readonly PersistedEvent[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  // The newest block the person has put away. A block is history once the run has gone on past it, and the strip had no
  // way to say so, so a refusal from hours ago kept an amber warning on a conversation that had long recovered.
  // Compared by the event's own timestamp, so a block that happens after the dismissal still shows.
  const [dismissedThrough, setDismissedThrough] = useState(() => readDismissed(conversationId));
  useEffect(() => { setDismissedThrough(readDismissed(conversationId)); }, [conversationId]);
  const blocked = blockedActions(events).filter((entry) => entry.timestamp > dismissedThrough);
  if (blocked.length === 0) return null;
  const dismiss = (): void => {
    const newest = blocked.reduce((latest, entry) => (entry.timestamp > latest ? entry.timestamp : latest), '');
    try { window.localStorage.setItem(`${DISMISSED_PREFIX}${conversationId}`, newest); } catch { /* memory only */ }
    setDismissedThrough(newest);
    setExpanded(false);
  };
  return (
    <section className="blocked-actions" aria-label="Blocked actions in this conversation">
      <div className="blocked-actions-head">
        <UiButton type="button" className="blocked-actions-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <ShieldAlert size={13} />
          <span>{blocked.length} action{blocked.length === 1 ? '' : 's'} blocked in this conversation</span>
          <ChevronDown className="blocked-actions-chevron" size={13} />
        </UiButton>
        <UiButton type="button" className="blocked-actions-dismiss" onClick={dismiss} aria-label="Dismiss blocked actions" title="Dismiss. A new block will show again.">
          <X size={13} />
        </UiButton>
      </div>
      {expanded && (
        <ol className="blocked-actions-list">
          {[...blocked].reverse().slice(0, 20).map((entry) => (
            <li key={entry.id}>
              <span className="blocked-actions-source">{BLOCKED_BY_LABEL[entry.blockedBy]}</span>
              <span className="blocked-actions-detail"><strong>{entry.tool}</strong> — {entry.reason}</span>
              <time>{relativeTime(entry.timestamp)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
