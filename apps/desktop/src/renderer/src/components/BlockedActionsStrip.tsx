import { ChevronDown, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { relativeTime } from '../types';
import { BLOCKED_BY_LABEL, blockedActions } from './blocked-actions';

/**
 * Every call this conversation tried that something stopped, collapsed to a count until opened.
 *
 * A run that is quietly stuck is often stuck on the same blocked call, repeated, and today the only way to see that
 * is to scroll the whole transcript looking for it. This reads the conversation's own events instead, so the
 * pattern — three refused pushes, a hook that keeps saying no — is visible at a glance.
 */
export function BlockedActionsStrip({ events }: { events: readonly PersistedEvent[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const blocked = blockedActions(events);
  if (blocked.length === 0) return null;
  return (
    <section className="blocked-actions" aria-label="Blocked actions in this conversation">
      <button type="button" className="blocked-actions-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <ShieldAlert size={13} />
        <span>{blocked.length} action{blocked.length === 1 ? '' : 's'} blocked in this conversation</span>
        <ChevronDown className="blocked-actions-chevron" size={13} />
      </button>
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
