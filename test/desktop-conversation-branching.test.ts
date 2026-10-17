import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../packages/contracts/src';
import { branchedConversation, rewoundConversation } from '../apps/desktop/src/main/conversation-branching';

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schemaVersion: 1,
    id: 'conv-original',
    projectId: 'project-1',
    title: 'Fix the parser',
    createdAt: '2026-10-17T09:00:00.000Z',
    updatedAt: '2026-10-17T09:05:00.000Z',
    archived: false,
    unread: true,
    activeAgent: 'claude',
    route: 'direct',
    autonomy: 'ask',
    execution: 'api',
    agentSessionId: 'session-1',
    turns: [
      { id: 'turn-1', role: 'user', text: 'First request', createdAt: '2026-10-17T09:00:00.000Z' },
      { id: 'turn-2', role: 'assistant', text: 'First answer', createdAt: '2026-10-17T09:01:00.000Z' },
      { id: 'turn-3', role: 'user', text: 'Second request', createdAt: '2026-10-17T09:02:00.000Z' },
      { id: 'turn-4', role: 'assistant', text: 'Second answer', createdAt: '2026-10-17T09:03:00.000Z' },
    ],
    events: [{ schemaVersion: 1, id: 'event-1', taskId: 'conv-original', timestamp: '2026-10-17T09:01:00.000Z', agent: 'claude', type: 'notice', message: 'Working.' }],
    ...overrides,
  };
}

describe('conversation fork', () => {
  it('copies the whole conversation with new ids and no provider session or run events', () => {
    const original = conversation();
    const copy = branchedConversation(original);

    expect(copy.id).not.toBe(original.id);
    expect(copy.title).toBe('Fix the parser (branch)');
    expect(copy.turns).toHaveLength(4);
    expect(copy.turns.map((turn) => turn.text)).toEqual(original.turns.map((turn) => turn.text));
    expect(copy.turns.every((turn) => turn.id.startsWith('turn_'))).toBe(true);
    expect(copy.turns.map((turn) => turn.id)).not.toEqual(original.turns.map((turn) => turn.id));
    expect(copy.agentSessionId).toBeUndefined();
    expect(copy.events).toEqual([]);
    expect(copy.unread).toBe(false);
  });

  it('copies through a chosen turn and leaves the original untouched', () => {
    const original = conversation();
    const copy = branchedConversation(original, 'turn-2');

    expect(copy.turns.map((turn) => turn.text)).toEqual(['First request', 'First answer']);
    expect(original.turns).toHaveLength(4);
    expect(original.agentSessionId).toBe('session-1');
    expect(original.events).toHaveLength(1);
  });

  it('drops a compaction summary that reaches past the branch point, and keeps one that does not', () => {
    const past = branchedConversation(conversation({
      compaction: { summary: 'Summary of everything', createdAt: '2026-10-17T09:04:00.000Z', throughTurnIndex: 3, originalTurns: 4, originalCharacters: 100 },
    }), 'turn-2');
    expect(past.compaction).toBeUndefined();

    const inside = branchedConversation(conversation({
      compaction: { summary: 'Summary of the first answer', createdAt: '2026-10-17T09:04:00.000Z', throughTurnIndex: 1, originalTurns: 2, originalCharacters: 100 },
    }), 'turn-2');
    expect(inside.compaction?.summary).toBe('Summary of the first answer');
  });

  it('refuses a turn that is not in the conversation', () => {
    expect(() => branchedConversation(conversation(), 'turn-missing')).toThrow(/Turn not found/);
  });
});

describe('conversation rewind', () => {
  it('removes the chosen user turn and everything after it', () => {
    const original = conversation();
    const rewound = rewoundConversation(original, 'turn-3');

    expect(rewound.turns.map((turn) => turn.text)).toEqual(['First request', 'First answer']);
    expect(rewound.events).toEqual([]);
    expect(rewound.agentSessionId).toBeUndefined();
    expect(rewound.id).toBe(original.id);
    expect(original.turns).toHaveLength(4);
  });

  it('clears a compaction that included the removed turns', () => {
    const rewound = rewoundConversation(conversation({
      compaction: { summary: 'Summary', createdAt: '2026-10-17T09:04:00.000Z', throughTurnIndex: 3, originalTurns: 4, originalCharacters: 100 },
    }), 'turn-3');
    expect(rewound.compaction).toBeUndefined();
  });

  it('keeps a compaction that lies entirely before the rewind point', () => {
    const rewound = rewoundConversation(conversation({
      compaction: { summary: 'Earlier summary', createdAt: '2026-10-17T09:01:00.000Z', throughTurnIndex: 0, originalTurns: 1, originalCharacters: 50 },
    }), 'turn-3');
    expect(rewound.compaction?.summary).toBe('Earlier summary');
  });

  it('refuses to rewind to an assistant reply or an unknown turn', () => {
    expect(() => rewoundConversation(conversation(), 'turn-2')).toThrow(/your own messages/);
    expect(() => rewoundConversation(conversation(), 'turn-missing')).toThrow(/Turn not found/);
  });
});
