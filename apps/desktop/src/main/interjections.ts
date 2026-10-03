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

interface WaitingMessage { text: string; resolve: (delivered: boolean) => void }
const waiting = new Map<string, WaitingMessage[]>();
const active = new Set<string>();
const delivered = new Map<string, string[]>();

export function setInterjectionActive(conversationId: string, enabled: boolean): void {
  if (enabled) active.add(conversationId);
  else active.delete(conversationId);
}

export function canInterject(conversationId: string): boolean {
  return active.has(conversationId);
}

/** Puts a message in line for the conversation's next turn. */
export function interject(conversationId: string, text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || !active.has(conversationId)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const queue = waiting.get(conversationId);
    const item = { text: trimmed, resolve };
    if (queue) queue.push(item);
    else waiting.set(conversationId, [item]);
  });
}

/** Takes the oldest waiting message, or null when there is none. Called by the run between turns. */
export function takeInterjection(conversationId: string): string | null {
  const queue = waiting.get(conversationId);
  if (!queue || queue.length === 0) return null;
  const next = queue.shift() ?? null;
  if (queue.length === 0) waiting.delete(conversationId);
  if (next) delivered.set(conversationId, [...(delivered.get(conversationId) ?? []), next.text]);
  next?.resolve(true);
  return next?.text ?? null;
}

export function takeDeliveredInterjections(conversationId: string): string[] {
  const messages = delivered.get(conversationId) ?? [];
  delivered.delete(conversationId);
  return messages;
}

/** Drops anything still waiting, so a message for a finished run is never handed to the next one. */
export function clearInterjections(conversationId: string): void {
  for (const item of waiting.get(conversationId) ?? []) item.resolve(false);
  waiting.delete(conversationId);
  active.delete(conversationId);
}

export function hasInterjections(conversationId: string): boolean {
  return (waiting.get(conversationId)?.length ?? 0) > 0;
}
