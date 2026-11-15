import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@kai/contracts';
import { interleaveRun } from '../apps/desktop/src/renderer/src/transcript-order';
import { buildJumpList, launchIntentFromArgv } from '../apps/desktop/src/main/jump-list';

function edit(id: string, textOffset?: number): PersistedEvent {
  return {
    schemaVersion: 1, id, taskId: 't', timestamp: '2026-10-17T10:00:00.000Z', type: 'tool.call', name: 'edit', status: 'completed',
    ...(textOffset === undefined ? {} : { textOffset }),
  };
}

describe('interleaveRun', () => {
  it('puts each call between the sentences that came before and after it', () => {
    const text = 'First thing.\n\nSecond thing.';
    const parts = interleaveRun(text, [edit('a', 12), edit('b', 12)]);
    expect(parts?.map((part) => part.kind)).toEqual(['text', 'events', 'text']);
    expect(parts?.[0]).toEqual({ kind: 'text', text: 'First thing.' });
    expect(parts?.[2]).toEqual({ kind: 'text', text: 'Second thing.' });
    expect(parts?.[1]?.kind === 'events' && parts[1].events.length).toBe(2);
  });

  it('leads with the activity when it came first, and clamps a position past the end', () => {
    const parts = interleaveRun('Done.', [edit('a', 0), edit('b', 999)]);
    expect(parts?.map((part) => part.kind)).toEqual(['events', 'text', 'events']);
  });

  it('returns null for a record that kept no positions', () => {
    expect(interleaveRun('Hello', [edit('a')])).toBeNull();
  });
});

describe('taskbar menu', () => {
  it('reads the launch flags back', () => {
    expect(launchIntentFromArgv(['KAI.exe', '--new-window'])).toEqual({ kind: 'new-window' });
    expect(launchIntentFromArgv(['KAI.exe', '--open-project', 'p1'])).toEqual({ kind: 'project', projectId: 'p1' });
    expect(launchIntentFromArgv(['KAI.exe'])).toBeNull();
  });

  it('offers a new window and lists the projects', () => {
    const list = buildJumpList([{ id: 'p1', name: 'KAi', path: 'C:/KAi' }], 'KAI.exe', 'KAI.exe');
    // The task is a category of the same list as the projects: set separately, the project list replaced it and
    // Windows never showed "New window".
    expect(list.categories[0]).toMatchObject({ type: 'tasks' });
    expect(list.categories[0]?.items?.[0]).toMatchObject({ title: 'New window', args: '--new-window' });
    const projects = list.categories.find((category) => category.name === 'Projects');
    expect(projects?.items).toHaveLength(1);
    expect(projects?.items?.[0]).toMatchObject({ title: 'KAi', args: '--open-project p1' });
  });

  it('still offers a new window when there are no projects', () => {
    const list = buildJumpList([], 'KAI.exe', 'KAI.exe');
    expect(list.categories).toHaveLength(1);
    expect(list.categories[0]?.items?.[0]).toMatchObject({ title: 'New window' });
  });
});

describe('plain dashes', () => {
  it('replaces long dashes and keeps the rule that names them readable', async () => {
    const { plainDashes, buildExecutionRulesBriefing } = await import('../apps/desktop/src/main/execution-rules');
    expect(plainDashes('one \u2014 two\u2013three 5\u201310')).toBe('one - two - three 5-10');
    const briefing = buildExecutionRulesBriefing('47. **No em-dashes** \u2014 Do not use em-dashes (\u2014) or en-dashes (\u2013).');
    expect(briefing).not.toMatch(/[\u2013\u2014]/);
    expect(briefing).toContain('(U+2014)');
  });
});
