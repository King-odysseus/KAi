import { describe, expect, it } from 'vitest';
import type { BrainEntry } from '../packages/contracts/src';
import { withBrainTools, type BrainAccess } from '../apps/desktop/src/main/brain-tools';
import type { ExternalToolPort } from '../apps/desktop/src/main/project-tools';

const entry: BrainEntry = { date: '2026-11-18T10:00:00Z', title: 'Use zod at the boundary', agent: 'kai', type: 'decisions', tags: '', project: 'KAi', fields: { why: 'one place validates' }, status: null };

function access(overrides: Partial<BrainAccess> = {}): BrainAccess & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    recall: async () => ({ ok: true, entries: [entry] }),
    remember: async (_root, value) => { saved.push(value); return { ok: true }; },
    ...overrides,
  };
}

describe('brain tools for a direct API run', () => {
  it('adds both tools beside the ones already offered, allowed at every access level', async () => {
    const outside: ExternalToolPort = { definitions: async () => [{ name: 'other' }], policy: () => ({ decision: 'ask', title: 't', detail: 'd', risk: 'low' }), execute: async () => ({ ok: true, output: 'other ran' }) };
    const port = withBrainTools(outside, '/p', access());
    const names = (await port.definitions()).map((definition) => (definition as { name: string }).name);
    expect(names).toEqual(['other', 'brain_recall', 'brain_remember']);
    for (const autonomy of ['plan', 'ask', 'full'] as const) {
      expect(port.policy('brain_remember', autonomy)).toEqual({ decision: 'allow' });
      expect(port.policy('brain_recall', autonomy)).toEqual({ decision: 'allow' });
    }
    expect(port.policy('other', 'plan')?.decision).toBe('ask');
    expect(await port.execute('other', {})).toEqual({ ok: true, output: 'other ran' });
  });

  it('works with no other outside tools', async () => {
    const port = withBrainTools(undefined, '/p', access());
    expect(await port.definitions()).toHaveLength(2);
    expect(port.policy('nope', 'full')).toBeUndefined();
  });

  it('reads memories back as plain text, and says so when there are none', async () => {
    const found = await withBrainTools(undefined, '/p', access()).execute('brain_recall', { query: 'validation' });
    expect(found?.ok).toBe(true);
    expect(String(found?.output)).toContain('[decisions] Use zod at the boundary');
    expect(String(found?.output)).toContain('why: one place validates');
    const none = await withBrainTools(undefined, '/p', access({ recall: async () => ({ ok: true, entries: [] }) })).execute('brain_recall', { query: 'x' });
    expect(none?.output).toBe('The brain has nothing on that yet.');
  });

  it('keeps a fact with its reason, and refuses a call missing its title, note or a real type', async () => {
    const brain = access();
    const port = withBrainTools(undefined, '/p', brain);
    expect((await port.execute('brain_remember', { title: 'Compact at 20k locally', type: 'decisions', note: 'Local models fold sooner.', why: 'small windows' }))?.ok).toBe(true);
    expect(brain.saved).toEqual([{ title: 'Compact at 20k locally', type: 'decisions', note: 'Local models fold sooner.', why: 'small windows' }]);
    for (const bad of [{ type: 'decisions', note: 'n' }, { title: 't', type: 'decisions' }, { title: 't', type: 'insights', note: 'n' }]) {
      expect((await port.execute('brain_remember', bad))?.ok).toBe(false);
    }
    expect(brain.saved).toHaveLength(1);
  });

  it('hands the brain\'s refusal back to the model instead of throwing', async () => {
    const port = withBrainTools(undefined, '/p', access({ remember: async () => ({ ok: false, reason: 'The brain turned this entry away: too vague.' }) }));
    const result = await port.execute('brain_remember', { title: 't', type: 'bugs', note: 'n' });
    expect(result).toEqual({ ok: false, output: { error: 'The brain turned this entry away: too vague.' } });
  });
});
