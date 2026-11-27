import { describe, expect, it } from 'vitest';
import { renderConversationHandoff } from '../apps/desktop/src/main/conversation-handoff';
import type { ConversationRecord } from '@kai/contracts';

const turn = (role: 'user' | 'assistant', text: string): ConversationRecord['turns'][number] => ({
  id: `${role}-${text.length}`, role, text, createdAt: '2026-11-26T00:00:00.000Z', awaitingAnswer: false,
});

describe('conversation handoff', () => {
  it('keeps every Lead history turn and full text when switching to another model', () => {
    const turns = Array.from({ length: 16 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', `turn-${index}-${'x'.repeat(5_000)}`));
    const handoff = renderConversationHandoff(turns, true);
    expect(handoff).toContain('turn-0-');
    expect(handoff).toContain('turn-15-');
    expect(handoff.length).toBeGreaterThan(80_000);
  });

  it('keeps the normal handoff compact for other conversations', () => {
    const turns = Array.from({ length: 16 }, (_, index) => turn('user', `turn-${index}`));
    const handoff = renderConversationHandoff(turns);
    expect(handoff).not.toContain('turn-0');
    expect(handoff).toContain('turn-15');
  });
});
