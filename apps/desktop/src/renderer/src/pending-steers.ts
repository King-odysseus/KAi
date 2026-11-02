import type { ConversationTurn } from '@kai/contracts';

export interface PendingSteer {
  id: string;
  conversationId: string;
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
  /** The ordinal of this same message in the transcript once it has been saved. */
  matchNumber: number;
}

function matches(turn: ConversationTurn, message: Pick<PendingSteer, 'text' | 'images'>): boolean {
  return turn.role === 'user' && turn.text === message.text
    && (turn.attachments ?? []).length === message.images.length
    && message.images.every((image, index) => turn.attachments?.[index]?.name === image.name
      && turn.attachments[index]?.dataUrl === image.dataUrl);
}

export function addPendingSteer(
  pending: PendingSteer[],
  next: Omit<PendingSteer, 'matchNumber'>,
  turns: readonly ConversationTurn[],
): PendingSteer[] {
  const matchNumber = turns.filter((turn) => matches(turn, next)).length
    + pending.filter((item) => item.conversationId === next.conversationId && item.text === next.text
      && item.images.length === next.images.length
      && item.images.every((image, index) => image.name === next.images[index]?.name && image.dataUrl === next.images[index]?.dataUrl)).length + 1;
  return [...pending, { ...next, matchNumber }];
}

export function visiblePendingSteers(
  pending: readonly PendingSteer[],
  conversationId: string | undefined,
  turns: readonly ConversationTurn[],
): PendingSteer[] {
  return pending.filter((item) => item.conversationId === conversationId
    && turns.filter((turn) => matches(turn, item)).length < item.matchNumber);
}
