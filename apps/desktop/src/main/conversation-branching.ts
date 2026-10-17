import type { ConversationRecord } from '@kai/contracts';

/**
 * Copies a conversation up to a chosen turn into a new conversation. The copy has new turn IDs so it can diverge
 * without touching the original, and it starts with no provider session, run events or compaction: none of those
 * refer to the new branch.
 */
export function branchedConversation(original: ConversationRecord, throughTurnId?: string): ConversationRecord {
  const throughIndex = throughTurnId ? original.turns.findIndex((turn) => turn.id === throughTurnId) : original.turns.length - 1;
  if (throughTurnId && throughIndex < 0) throw new Error('Turn not found.');

  const now = new Date().toISOString();
  const turns = original.turns.slice(0, throughIndex + 1).map((turn) => ({ ...turn, id: `turn_${crypto.randomUUID()}` }));
  // A summary that reaches past the branch point describes text the copy does not contain.
  const compaction = original.compaction && original.compaction.throughTurnIndex <= throughIndex ? original.compaction : undefined;
  return {
    schemaVersion: 1,
    id: `conv_${crypto.randomUUID()}`,
    projectId: original.projectId,
    title: `${original.title} (branch)`,
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: false,
    activeAgent: original.activeAgent,
    route: original.route,
    autonomy: original.autonomy,
    ...(original.execution ? { execution: original.execution } : {}),
    ...(original.goal ? { goal: original.goal } : {}),
    ...(original.workflow ? { workflow: original.workflow } : {}),
    ...(compaction ? { compaction } : {}),
    turns,
    events: [],
  };
}

/**
 * Removes a user turn and everything after it. The caller restores files first when asked; this function only owns
 * the transcript, so a conversation cut short and a conversation left alone take the same path.
 */
export function rewoundConversation(original: ConversationRecord, turnId: string): ConversationRecord {
  const index = original.turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) throw new Error('Turn not found.');
  if (original.turns[index].role !== 'user') throw new Error('Rewind to one of your own messages, not an assistant reply.');

  const conversation: ConversationRecord = {
    ...original,
    turns: original.turns.slice(0, index),
    events: [],
    updatedAt: new Date().toISOString(),
    unread: false,
  };
  delete conversation.agentSessionId;
  if (conversation.compaction && conversation.compaction.throughTurnIndex >= index) delete conversation.compaction;
  return conversation;
}
