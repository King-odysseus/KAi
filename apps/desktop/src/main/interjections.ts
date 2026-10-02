/**
 * Messages waiting to be handed to a run that is already going.
 *
 * Every other way of saying something during a run is a compromise. Queueing waits for the run to end, so a question
 * asked in the middle is answered at the end, by which time it may not matter. Steering cancels the run, which for an
 * agent in the middle of an edit throws away whatever it was doing.
 *
 * Interjecting is the third thing, and the one a person expects: the message is put to the agent at its next turn, so
 * it answers — or takes the correction — and carries on with what it was doing, plan intact.
 *
 * It only works for a run KAI is looping itself. A CLI run is one process invocation, and there is no moment between
 * turns to put anything to it; that case falls back to queueing, and the caller is told so rather than being promised
 * something that will not happen.
 */

const waiting = new Map<string, string[]>();

/** Puts a message in line for the conversation's next turn. */
export function interject(conversationId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const queue = waiting.get(conversationId);
  if (queue) queue.push(trimmed);
  else waiting.set(conversationId, [trimmed]);
}

/** Takes the oldest waiting message, or null when there is none. Called by the run between turns. */
export function takeInterjection(conversationId: string): string | null {
  const queue = waiting.get(conversationId);
  if (!queue || queue.length === 0) return null;
  const next = queue.shift() ?? null;
  if (queue.length === 0) waiting.delete(conversationId);
  return next;
}

/** Drops anything still waiting, so a message for a finished run is never handed to the next one. */
export function clearInterjections(conversationId: string): void {
  waiting.delete(conversationId);
}

export function hasInterjections(conversationId: string): boolean {
  return (waiting.get(conversationId)?.length ?? 0) > 0;
}
