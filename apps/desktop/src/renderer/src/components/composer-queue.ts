import { composerQueueSchema, queuedPromptSchema, type ComposerQueue, type QueuedPrompt, type ConversationRecord } from '@kai/contracts';
export type { QueuedPrompt } from '@kai/contracts';

export const QUEUE_KEY = 'kai.composer.queuedPrompts';

export function loadComposerQueue(): ComposerQueue {
  const raw = window.localStorage.getItem(QUEUE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The saved composer queue is not a valid queue object. It has been left in browser storage for recovery.');
  const recovered: Record<string, QueuedPrompt[]> = {};
  for (const [conversationId, items] of Object.entries(parsed)) {
    if (!Array.isArray(items)) throw new Error(`The saved composer queue for ${conversationId} is invalid. It has been left in browser storage for recovery.`);
    recovered[conversationId] = items.map((rawItem) => {
      if (!rawItem || typeof rawItem !== 'object') throw new Error('A saved queued prompt is invalid. It has been left in browser storage for recovery.');
      const item = { ...rawItem as object, conversationId, status: (rawItem as { status?: unknown }).status === 'blocked' ? 'blocked' : 'queued' };
      const result = queuedPromptSchema.safeParse(item);
      if (!result.success) throw new Error('A saved queued prompt does not match the current format. It has been left in browser storage for recovery.');
      return result.data;
    });
  }
  return composerQueueSchema.parse(recovered);
}

/** A persisted user turn is the commit point; a recovered queue must not send it again. */
export function queuedPromptWasAccepted(conversation: ConversationRecord, id: string): boolean {
  return conversation.turns.some((turn) => turn.role === 'user' && turn.clientMessageId === id);
}
