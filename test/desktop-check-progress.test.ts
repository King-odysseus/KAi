import { describe, expect, it } from 'vitest';
import { CheckProgress, failureSignature } from '../apps/desktop/src/main/check-progress';

const failing = (detail: string, duration = '7.98s') => ({
  exitCode: 1,
  stdout: ` \u001b[31m\u00d7\u001b[39m ${detail} 497ms\n Tests  2 failed | 12 passed (14)\n Start at  16:34:13\n Duration  ${duration}`,
  stderr: '',
});
const passing = { exitCode: 0, stdout: 'Tests  14 passed (14)', stderr: '' };
const run = (progress: CheckProgress, output: unknown, command = 'npx vitest run a.test.jsx') => progress.observe('run_command', { command }, output).kind;

describe('stuck detection', () => {
  it('reads the same failure as the same, whatever the timings say', () => {
    expect(failureSignature('run_command', failing('opens the menu', '7.98s'))).toBe(failureSignature('run_command', failing('opens the menu', '12.01s')));
    expect(failureSignature('run_command', failing('opens the menu'))).not.toBe(failureSignature('run_command', failing('groups the projects')));
    expect(failureSignature('run_command', passing)).toBeUndefined();
    expect(failureSignature('read_file', failing('opens the menu'))).toBeUndefined();
  });

  it('warns on the third and stops on the fourth', () => {
    const progress = new CheckProgress();
    expect([1, 2, 3, 4].map(() => run(progress, failing('opens the menu')))).toEqual(['ok', 'ok', 'warn', 'stuck']);
  });

  it('counts a run that swings between two failures', () => {
    const progress = new CheckProgress();
    const kinds = ['a', 'b', 'a', 'b', 'a', 'b', 'a'].map((name) => run(progress, failing(name)));
    expect(kinds.at(-1)).toBe('stuck');
  });

  it('forgets a failure once that command passes, with or without changing folder first', () => {
    const progress = new CheckProgress();
    for (let index = 0; index < 3; index += 1) run(progress, failing('x'));
    run(progress, passing, 'cd "C:\\some project" && npx vitest run a.test.jsx');
    expect(run(progress, failing('x'))).toBe('ok');
  });

  it('keeps counting when a different command passes in between', () => {
    const progress = new CheckProgress();
    for (let index = 0; index < 3; index += 1) {
      run(progress, failing('x'));
      run(progress, passing, 'npm run lint');
    }
    expect(run(progress, failing('x'))).toBe('stuck');
  });
});
