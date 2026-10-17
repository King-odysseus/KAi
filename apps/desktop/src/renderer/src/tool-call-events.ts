import type { PersistedEvent } from '@kai/contracts';

/**
 * One row per tool call, in the state the call has reached.
 *
 * A call is stored as two events: one when it starts and one when it ends. The transcript drew every event, so each
 * finished edit appeared twice — its result, and the "started" card that, in a run that was parked or interrupted,
 * stayed on screen as a spinner for good. It also counted every call twice in the command totals.
 *
 * Each call is shown once, at the place it began and as the last thing that was recorded about it. An event with no
 * call id (older records, or tools that report none) cannot be matched to another, so it is left as it is.
 */
export function collapseToolCalls<T extends PersistedEvent>(events: readonly T[]): T[] {
  const latest = new Map<string, T>();
  const firstOffset = new Map<string, number | undefined>();
  for (const event of events) {
    if (event.type === 'tool.call' && event.callId) {
      latest.set(event.callId, event);
      if (!firstOffset.has(event.callId)) firstOffset.set(event.callId, event.textOffset);
    }
  }
  const placed = new Set<string>();
  const collapsed: T[] = [];
  for (const event of events) {
    if (event.type !== 'tool.call' || !event.callId) {
      collapsed.push(event);
      continue;
    }
    if (placed.has(event.callId)) continue;
    placed.add(event.callId);
    // The row keeps the place where the call began, so it also keeps that call's position in the reply.
    const row = latest.get(event.callId)!;
    const offset = firstOffset.get(event.callId);
    collapsed.push(offset === undefined || row.textOffset === offset ? row : { ...row, textOffset: offset });
  }
  return collapsed;
}
