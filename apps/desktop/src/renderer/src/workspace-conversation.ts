import type { BootstrapPayload, ConversationRecord } from '@kai/contracts';

export function preferredConversationId(
  bootstrap: BootstrapPayload,
  conversations: readonly ConversationRecord[],
): string | null {
  if (bootstrap.activeConversationId && conversations.some((conversation) => conversation.id === bootstrap.activeConversationId && conversation.origin?.kind !== 'lead')) {
    return bootstrap.activeConversationId;
  }
  return conversations
    .filter((conversation) => conversation.projectId === bootstrap.activeProjectId && !conversation.archived && conversation.origin?.kind !== 'lead')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null;
}

