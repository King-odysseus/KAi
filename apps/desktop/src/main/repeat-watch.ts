import { randomUUID } from 'node:crypto';
import type { AgentId, PersistedEvent } from '@kai/contracts';

/**
 * Spotting a model that is going round in circles: the same paragraph, word for word, again and again.
 *
 * It only ever says so. Ending a run on a guess would throw away the work of a model that was merely emphatic, and a
 * limit here asks rather than kills (see the run limits policy), so the callers show a notice and leave Stop to the
 * person, the way the silence watch does.
 */

const MIN_PARAGRAPH = 60;
export const REPEATS_BEFORE_NOTICE = 3;

/** Lower-case words only, so a copy that differs in punctuation or spacing still counts as the same paragraph. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when a paragraph of some length comes back three or more times in the same text. */
export function repeatsItself(output: string): boolean {
  const seen = new Map<string, number>();
  for (const part of output.split(/\n\s*\n/)) {
    const key = normalizeText(part);
    if (key.length < MIN_PARAGRAPH) continue;
    const count = (seen.get(key) ?? 0) + 1;
    if (count >= REPEATS_BEFORE_NOTICE) return true;
    seen.set(key, count);
  }
  return false;
}

/** Fed a run's text as it streams; says `true` once, the first time the text starts repeating itself. */
export class RepeatWatch {
  private buffer = '';
  private said = false;

  feed(text: string): boolean {
    if (this.said || !text) return false;
    this.buffer = (this.buffer + text).slice(-24_000);
    // Paragraphs end at a blank line, so there is nothing new to compare until one has gone by.
    if (!text.includes('\n')) return false;
    if (!repeatsItself(this.buffer)) return false;
    this.said = true;
    return true;
  }
}

/**
 * Wraps a run's event callback so that, the first time the assistant's text starts repeating itself, a notice follows it.
 * The run is never touched: the notice is the same kind the silence watch sends, and Stop stays the person's call.
 */
export function withRepeatNotice(
  onEvent: ((event: PersistedEvent) => void) | undefined,
  request: { agent: AgentId; conversationId: string },
): ((event: PersistedEvent) => void) | undefined {
  if (!onEvent) return onEvent;
  const watch = new RepeatWatch();
  return (event) => {
    onEvent(event);
    if (event.type !== 'text.delta' || event.channel !== 'assistant' || !watch.feed(event.text)) return;
    onEvent({
      schemaVersion: 1,
      id: `evt_${randomUUID()}`,
      taskId: request.conversationId,
      timestamp: new Date().toISOString(),
      agent: request.agent,
      type: 'notice',
      message: 'This run is repeating the same paragraph. It may be going in circles. Press Stop to end it, or leave it if it is still making progress.',
    });
  };
}
