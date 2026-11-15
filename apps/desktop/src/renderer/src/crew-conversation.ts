import type { ConversationRecord } from '@kai/contracts';

/**
 * Whether a conversation is a crew's work log rather than one of the person's chats. New ones carry a crew marker.
 * Ones made before the marker existed are told apart by the title the crew gave them, so they leave the tab bar and
 * the history too instead of staying behind as clutter.
 */
export function isCrewConversation(conversation: Pick<ConversationRecord, 'origin' | 'title'>): boolean {
  if (conversation.origin) return conversation.origin.kind === 'crew';
  return conversation.title.startsWith('Crew: ') || conversation.title.startsWith('Crew task: ');
}
