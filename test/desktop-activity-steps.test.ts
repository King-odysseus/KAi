import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '../packages/contracts/src';
import { currentStep, deriveActivitySteps, parseDiff, stepSentence } from '../apps/desktop/src/renderer/src/activity-steps';

let counter = 0;
const base = () => ({ id: `e${++counter}`, conversationId: 'c1', timestamp: '2026-11-03T10:00:00.000Z' });
const tool = (name: string, input: unknown, status: 'started' | 'completed' | 'failed', callId = `call-${name}-${JSON.stringify(input)}`): PersistedEvent => ({ ...base(), type: 'tool.call', name, input, status, callId } as unknown as PersistedEvent);
const change = (path: string, added: number, removed: number): PersistedEvent => ({ ...base(), type: 'file.change', path, action: 'edited', added, removed } as unknown as PersistedEvent);
const proposal = (filePath: string, diff: string): PersistedEvent => ({ ...base(), type: 'diff.proposal', filePath, summary: 'x', diff } as unknown as PersistedEvent);

describe('activity steps', () => {
  it('shows a file read once it has finished, and keeps one row per call', () => {
    const steps = deriveActivitySteps([tool('read_file', { path: 'src/a.ts' }, 'started'), tool('read_file', { path: 'src/a.ts' }, 'completed')]);
    expect(steps).toHaveLength(1);
    expect(stepSentence(steps[0]!)).toEqual({ verb: 'Read', target: 'a.ts' });
  });

  it('says Editing while a file is being written, and Updated with its counts once it is saved', () => {
    const editing = deriveActivitySteps([tool('edit_file', { path: String.raw`src\payment.service.ts` }, 'started', 'k1')]);
    expect(stepSentence(editing[0]!)).toEqual({ verb: 'Editing', target: 'payment.service.ts' });
    expect(currentStep(editing)).toBe('Editing payment.service.ts');
    const saved = deriveActivitySteps([tool('edit_file', { path: String.raw`src\payment.service.ts` }, 'started', 'k1'), tool('edit_file', { path: String.raw`src\payment.service.ts` }, 'completed', 'k1'), change(String.raw`src\payment.service.ts`, 4, 1)]);
    expect(saved).toHaveLength(1);
    expect(stepSentence(saved[0]!)).toEqual({ verb: 'Updated', target: 'payment.service.ts' });
    expect(saved[0]).toMatchObject({ added: 4, removed: 1, state: 'done' });
    expect(currentStep(saved)).toBeNull();
  });

  it('attaches the diff an edit proposed to that file\'s row', () => {
    const steps = deriveActivitySteps([change('a.ts', 1, 0), proposal('a.ts', '@@ -1 +1 @@\n-old\n+new')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.diff).toContain('+new');
  });

  it('keeps a raw command as a command row, never as a headline', () => {
    const steps = deriveActivitySteps([tool('run_command', { command: 'cd x && sed -n 1,5p a.ts' }, 'completed')]);
    expect(steps[0]).toMatchObject({ kind: 'command', target: 'cd x && sed -n 1,5p a.ts' });
    expect(stepSentence(steps[0]!).target).toBe('a command');
  });

  it('colours a diff by line kind', () => {
    expect(parseDiff('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n z').map((line) => line.kind)).toEqual(['file', 'file', 'hunk', 'remove', 'add', 'context']);
  });
});
