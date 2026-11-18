import { describe, expect, it } from 'vitest';
import { historyNote, windowedHistory, withHistoryTools, type HistoryAccess } from '../apps/desktop/src/main/history-tools';

const turns = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: index === 5 ? 'We chose zod for the boundary because one place validates.' : `turn ${index + 1} ${'filler '.repeat(40)}`,
}));
const access: HistoryAccess = { turns: async () => turns };

describe('read_history', () => {
  const port = withHistoryTools(undefined, 'conv', access);

  it('is offered, and allowed at every access level', async () => {
    expect((await port.definitions()).map((definition) => (definition as { name: string }).name)).toEqual(['read_history']);
    for (const autonomy of ['plan', 'ask', 'full'] as const) expect(port.policy('read_history', autonomy)).toEqual({ decision: 'allow' });
    expect(port.policy('other', 'plan')).toBeUndefined();
  });

  it('lists the turns with no arguments, newest last', async () => {
    const result = await port.execute('read_history', {});
    const text = String(result?.output);
    expect(text).toContain('1. You were asked: turn 1');
    expect(text).toContain('12. You answered: turn 12');
  });

  it('reads one turn in full, and says when there is no such turn', async () => {
    expect(String((await port.execute('read_history', { turn: 6 }))?.output)).toContain('We chose zod for the boundary');
    expect((await port.execute('read_history', { turn: 99 }))?.ok).toBe(false);
  });

  it('finds the turns that mention a query', async () => {
    const found = String((await port.execute('read_history', { query: 'zod boundary' }))?.output);
    expect(found).toContain('6. You answered');
    expect(found).toContain('zod');
    expect(String((await port.execute('read_history', { query: 'kubernetes' }))?.output)).toContain('No earlier turn mentions');
  });

  it('says so when the conversation has no turns', async () => {
    const empty = withHistoryTools(undefined, 'conv', { turns: async () => [] });
    expect(String((await empty.execute('read_history', {}))?.output)).toBe('This conversation has no earlier turns.');
  });
});

describe('windowedHistory', () => {
  const long = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: `t${index} ${'x'.repeat(400)}` }));

  it('sends everything when the budget is off or the history is short', () => {
    expect(windowedHistory(long, 0)).toHaveLength(20);
    expect(windowedHistory(long.slice(0, 3), 10)).toHaveLength(3);
  });

  it('keeps the newest turns that fit, always the request, and says how many were left out', () => {
    const windowed = windowedHistory(long, 400);
    expect(windowed.at(-1)).toBe(long[19]);
    expect(windowed.length).toBeLessThan(20);
    expect(windowed.length).toBeGreaterThanOrEqual(3);
    const omitted = 20 - windowed.length;
    expect(windowed[0]!.text.startsWith(historyNote(omitted))).toBe(true);
    expect(windowed[0]!.text).toContain(long[20 - windowed.length]!.text);
  });

  it('never drops below the last two turns before the request', () => {
    expect(windowedHistory(long, 1).length).toBe(3);
  });
});
