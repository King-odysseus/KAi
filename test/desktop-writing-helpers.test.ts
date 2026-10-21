import { describe, expect, it } from 'vitest';
import { taskInputSchema, projectToolDefinitions } from '../apps/desktop/src/main/project-tools';
import type { ParallelSession } from '../apps/desktop/src/main/parallel-session';
import {
  checkFailurePrompt,
  clashPrompt,
  describeOutcome,
  runWritingHelpers,
  type HelperRunResult,
  type WritingHelperPorts,
  type WritingTask,
} from '../apps/desktop/src/main/writing-helpers';

const signal = new AbortController().signal;
const tasks = (...ids: string[]): WritingTask[] => ids.map((id) => ({ id, prompt: `Build ${id}`, model: undefined }));

interface Fake {
  ports: WritingHelperPorts;
  /** Every helper run, in order: the folder it worked in and the prompt it got. */
  runs: Array<{ folder: string | undefined; prompt: string }>;
  checks: string[];
  mostAtOnce: () => number;
  disposed: () => boolean;
}

function fake(options: {
  files?: Record<string, string[]>;
  clash?: string[];
  integrateThrows?: boolean;
  checkResults?: Array<{ passed: boolean; output: string } | null>;
  runThrows?: (prompt: string, folder: string | undefined) => boolean;
  noSession?: boolean;
} = {}): Fake {
  const runs: Fake['runs'] = [];
  const checks: string[] = [];
  let live = 0;
  let most = 0;
  let disposed = false;
  let checkCall = 0;
  const session: ParallelSession = {
    checkout: async (id) => `/copy/${id}`,
    commit: async (id) => `commit-${id}`,
    filesChanged: async (commit) => options.files?.[commit.replace('commit-', '')] ?? [`${commit.replace('commit-', '')}.ts`],
    integrate: async (commits) => {
      if (options.integrateThrows) throw new Error('merge exploded');
      return {
        conflicts: commits.filter((item) => options.clash?.includes(item.stepId)).map((item) => ({ stepId: item.stepId, files: ['src/shared.ts'] })),
        applied: [],
        skipped: [],
        integrationCommit: 'merged',
      };
    },
    dispose: async () => { disposed = true; },
  };
  const ports: WritingHelperPorts = {
    prepare: async () => (options.noSession ? null : session),
    run: async (prompt, _model, folder): Promise<HelperRunResult> => {
      runs.push({ folder, prompt });
      live += 1;
      most = Math.max(most, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      if (options.runThrows?.(prompt, folder)) throw new Error('model refused');
      return { answer: `done: ${prompt.split('\n')[0]}`, costUsd: 0.01 };
    },
    check: async (folder) => {
      checks.push(folder);
      const result = options.checkResults ? options.checkResults[checkCall] : { passed: true, output: '' };
      checkCall += 1;
      return result ?? null;
    },
  };
  return { ports, runs, checks, mostAtOnce: () => most, disposed: () => disposed };
}

describe('writing helpers', () => {
  it('gives every helper its own copy, runs them together, and reports what each changed', async () => {
    const f = fake({ files: { a: ['src/a.ts', 'src/a.test.ts'], b: ['src/b.ts'] } });
    const { outcomes, notice } = await runWritingHelpers(tasks('a', 'b'), f.ports, signal);
    expect(notice).toBeNull();
    expect(f.runs.map((run) => run.folder).sort()).toEqual(['/copy/a', '/copy/b']);
    expect(f.mostAtOnce()).toBe(2);
    expect(outcomes.map((outcome) => [outcome.id, outcome.applied, outcome.files])).toEqual([
      ['a', true, ['src/a.ts', 'src/a.test.ts']],
      ['b', true, ['src/b.ts']],
    ]);
    expect(outcomes.every((outcome) => outcome.check === 'passed')).toBe(true);
    expect(f.disposed()).toBe(true);
  });

  it('never runs more helpers at once than the limit', async () => {
    const f = fake();
    await runWritingHelpers(tasks('a', 'b', 'c', 'd', 'e'), f.ports, signal, 2);
    expect(f.mostAtOnce()).toBe(2);
    expect(f.runs).toHaveLength(5);
  });

  it('hands a failed check back to the helper once, in its own copy, before merging', async () => {
    const f = fake({ checkResults: [{ passed: false, output: 'FAIL: expected 1 to be 2' }, { passed: true, output: '' }] });
    const { outcomes } = await runWritingHelpers(tasks('a'), f.ports, signal);
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]?.folder).toBe('/copy/a');
    expect(f.runs[1]?.prompt).toContain('FAIL: expected 1 to be 2');
    expect(outcomes[0]?.check).toBe('passed');
    expect(outcomes[0]?.costUsd).toBeCloseTo(0.02);
  });

  it('reports a check that still fails after the retry, and still merges the work', async () => {
    const f = fake({ checkResults: [{ passed: false, output: 'bad 1' }, { passed: false, output: 'bad 2' }] });
    const { outcomes } = await runWritingHelpers(tasks('a'), f.ports, signal);
    expect(f.runs).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ check: 'failed', applied: true });
    expect(outcomes[0]?.checkOutput).toContain('bad 2');
    expect(JSON.stringify(describeOutcome(outcomes[0]!))).toContain('failed in the helper');
  });

  it('says the check was not run when the project has none', async () => {
    const f = fake({ checkResults: [null] });
    const { outcomes } = await runWritingHelpers(tasks('a'), f.ports, signal);
    expect(outcomes[0]?.check).toBe('not run');
    expect(f.runs).toHaveLength(1);
  });

  it('runs a helper again on its own, in the project, when its changes clash with another\'s', async () => {
    const f = fake({ clash: ['b'] });
    const { outcomes } = await runWritingHelpers(tasks('a', 'b'), f.ports, signal);
    const again = f.runs.filter((run) => run.folder === undefined);
    expect(again).toHaveLength(1);
    expect(again[0]?.prompt).toContain('src/shared.ts');
    expect(again[0]?.prompt).toContain('on top of theirs');
    expect(outcomes.find((outcome) => outcome.id === 'b')).toMatchObject({ applied: true, reran: true });
    expect(outcomes.find((outcome) => outcome.id === 'a')).toMatchObject({ applied: true, reran: false });
  });

  it('runs every helper again alone when the merge itself fails', async () => {
    const f = fake({ integrateThrows: true });
    const { outcomes, notice } = await runWritingHelpers(tasks('a', 'b'), f.ports, signal);
    expect(notice).toContain('could not be merged');
    expect(f.runs.filter((run) => run.folder === undefined)).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.applied && outcome.reran)).toBe(true);
  });

  it('keeps one failing helper from taking the others down', async () => {
    const f = fake({ runThrows: (prompt) => prompt.includes('Build a') });
    const { outcomes } = await runWritingHelpers(tasks('a', 'b'), f.ports, signal);
    expect(outcomes.find((outcome) => outcome.id === 'a')).toMatchObject({ applied: false, error: 'model refused' });
    expect(outcomes.find((outcome) => outcome.id === 'b')).toMatchObject({ applied: true });
    expect(f.disposed()).toBe(true);
  });

  it('works through the helpers one after another, in the project, when copies cannot be made', async () => {
    const f = fake({ noSession: true });
    const { outcomes, notice } = await runWritingHelpers(tasks('a', 'b'), f.ports, signal);
    expect(notice).toContain('one after another');
    expect(f.mostAtOnce()).toBe(1);
    expect(f.runs.every((run) => run.folder === undefined)).toBe(true);
    expect(outcomes.every((outcome) => outcome.applied)).toBe(true);
  });

  it('does not run a clashed helper again once Stop has been pressed', async () => {
    const controller = new AbortController();
    const f = fake({ clash: ['a'] });
    const original = f.ports.run;
    f.ports.run = async (prompt, model, folder) => { const result = await original(prompt, model, folder); controller.abort(); return result; };
    const { outcomes } = await runWritingHelpers(tasks('a'), f.ports, controller.signal);
    expect(f.runs.filter((run) => run.folder === undefined)).toHaveLength(0);
    expect(outcomes[0]).toMatchObject({ applied: false });
  });

  it('describes an error and a clean result for the model that asked', () => {
    expect(describeOutcome({ id: 'a', answer: '', costUsd: 0, files: [], check: 'not run', checkOutput: '', applied: false, reran: false, error: 'boom' })).toEqual({ error: 'boom', applied: false, changed_files: [] });
    expect(describeOutcome({ id: 'a', answer: 'ok', costUsd: 0, files: ['x.ts'], check: 'passed', checkOutput: '', applied: true, reran: false })).toMatchObject({ answer: 'ok', applied: true, changed_files: ['x.ts'] });
  });

  it('builds prompts that carry the failure and the clash', () => {
    expect(checkFailurePrompt('Do it', 'oops')).toContain('oops');
    expect(clashPrompt('Do it', ['a.ts', 'b.ts'])).toContain('a.ts, b.ts');
  });
});

describe('the task tool', () => {
  it('accepts write as a boolean and nothing stranger', () => {
    expect(taskInputSchema.parse({ prompt: 'x', write: true }).write).toBe(true);
    expect(taskInputSchema.parse({ prompt: 'x' }).write).toBeUndefined();
    expect(() => taskInputSchema.parse({ prompt: 'x', write: 'yes' })).toThrow();
  });

  it('offers write to the model and says what it needs', () => {
    const task = projectToolDefinitions.find((definition) => definition.name === 'task');
    expect(JSON.stringify(task)).toContain('"write"');
    expect(task?.description).toContain('own copy of the project');
  });
});
