import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '@kai/contracts';
import { addPendingSteer, visiblePendingSteers } from '../apps/desktop/src/renderer/src/pending-steers';

const image = { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' };
const firstTurn: ConversationTurn = {
  id: 'first', role: 'user', text: 'First message', createdAt: '2026-10-31T12:00:00.000Z', attachments: [image],
};

describe('steered messages in the live transcript', () => {
  it('shows later image steers until their saved turns arrive', () => {
    const next = { id: 'steer-1', conversationId: 'conversation', text: 'Look again', images: [image] };
    const pending = addPendingSteer([], next, [firstTurn]);
    expect(visiblePendingSteers(pending, 'conversation', [firstTurn])).toHaveLength(1);

    const saved: ConversationTurn = { ...firstTurn, id: 'saved-steer', text: next.text };
    expect(visiblePendingSteers(pending, 'conversation', [firstTurn, saved])).toEqual([]);
  });

  it('keeps repeated identical steers distinct as each one is saved', () => {
    const message = { conversationId: 'conversation', text: 'Check this', images: [image] };
    const first = addPendingSteer([], { ...message, id: 'one' }, [firstTurn]);
    const both = addPendingSteer(first, { ...message, id: 'two' }, [firstTurn]);
    const saved: ConversationTurn = { ...firstTurn, id: 'saved-one', text: message.text };
    expect(visiblePendingSteers(both, 'conversation', [firstTurn, saved]).map((item) => item.id)).toEqual(['two']);
    expect(visiblePendingSteers(both, 'conversation', [firstTurn, saved, { ...saved, id: 'saved-two' }])).toEqual([]);
  });
});
