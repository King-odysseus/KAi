import type { AgentId, AutonomyMode, ConversationRecord, ExecutionMode, RouteMode } from '@kai/contracts';
import type { WorkspaceSendOptions } from './Workspace';

export interface QueuedPrompt {
  id: string;
  conversationId: string;
  text: string;
  options: WorkspaceSendOptions & {
    agent: AgentId;
    execution: ExecutionMode;
    route: RouteMode;
    autonomy: AutonomyMode;
    model?: string;
  };
  status: 'queued' | 'sending' | 'blocked';
  error?: string;
}

export const QUEUE_KEY = 'kai.composer.queuedPrompts';

export function loadComposerQueue(): Record<string, QueuedPrompt[]> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(QUEUE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const queues: Record<string, QueuedPrompt[]> = {};
    for (const [conversationId, items] of Object.entries(parsed)) {
      if (!Array.isArray(items)) continue;
      queues[conversationId] = items.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Partial<QueuedPrompt>;
        if (typeof record.id !== 'string' || typeof record.text !== 'string' || !record.options || typeof record.options !== 'object') return [];
        // Older queues did not store execution choices; the dispatcher uses the current composer choice for them.
        return [{ ...record, conversationId, status: record.status === 'blocked' ? 'blocked' : 'queued' } as QueuedPrompt];
      });
    }
    return queues;
  } catch {
    return {};
  }
}

export function saveComposerQueue(queues: Record<string, QueuedPrompt[]>): boolean {
  // Images are already saved under KAI's attachments directory. Keep their paths, not multi-megabyte data URLs,
  // in browser storage so a queued turn still survives a restart without exhausting the storage quota.
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queues, (key, value) => key === 'dataUrl' ? undefined : value));
    return true;
  } catch {
    return false;
  }
}

/** A persisted user turn is the commit point; a recovered queue must not send it again. */
export function queuedPromptWasAccepted(conversation: ConversationRecord, id: string): boolean {
  return conversation.turns.some((turn) => turn.role === 'user' && turn.clientMessageId === id);
}
