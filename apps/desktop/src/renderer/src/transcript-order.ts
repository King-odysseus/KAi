import type { PersistedEvent } from '@kai/contracts';

/** One stretch of a run as it happened: some of what the agent wrote, or the things it did next. */
export type RunSegment =
  | { kind: 'text'; text: string }
  | { kind: 'events'; events: PersistedEvent[] };

/**
 * Lays a run's reply and its activity out in the order they happened.
 *
 * The reply is one string and the activity is a separate list, so a transcript drawn from them as they are lists all of
 * the prose and then all of the calls, and the reader has to scroll between what KAI said and what it did. Each event
 * carries `textOffset`, how much of the reply existed when it happened, and that is enough to cut the reply back into
 * the pieces that came between them.
 *
 * Returns null when no event has a position (a record from before positions were kept), so the caller can keep
 * drawing the old layout rather than guess.
 */
export function interleaveRun(text: string, events: readonly PersistedEvent[]): RunSegment[] | null {
  if (!events.some((event) => event.textOffset !== undefined)) return null;
  const segments: RunSegment[] = [];
  let cursor = 0;
  let pending: PersistedEvent[] = [];
  const flushEvents = (): void => {
    if (pending.length > 0) segments.push({ kind: 'events', events: pending });
    pending = [];
  };
  for (const event of events) {
    // An event with no position stays where the previous one was, and a position never moves backwards.
    const at = Math.min(text.length, Math.max(cursor, event.textOffset ?? cursor));
    if (at > cursor) {
      const piece = text.slice(cursor, at);
      cursor = at;
      if (piece.trim()) {
        flushEvents();
        segments.push({ kind: 'text', text: piece.trim() });
      }
    }
    pending.push(event);
  }
  flushEvents();
  const rest = text.slice(cursor);
  if (rest.trim()) segments.push({ kind: 'text', text: rest.trim() });
  return segments;
}
