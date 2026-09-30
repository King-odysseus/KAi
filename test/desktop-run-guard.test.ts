import { describe, expect, it } from 'vitest';
import { maxRunCostFromEnvironment, RunGuard, RunLimitError } from '../apps/desktop/src/main/run-guard';

describe('RunGuard', () => {
  it('stops a run once its estimated cost passes the ceiling', () => {
    const guard = new RunGuard(2);
    expect(() => guard.assertSpend(1.99)).not.toThrow();
    expect(() => guard.assertSpend(2)).toThrow(RunLimitError);
  });

  it('cannot check an unpriced model and can be switched off with zero', () => {
    expect(() => new RunGuard(1).assertSpend(null)).not.toThrow();
    expect(() => new RunGuard(0).assertSpend(999)).not.toThrow();
  });

  it('warns on the third identical call and result, and stops on the fifth', () => {
    const guard = new RunGuard();
    const verdicts = Array.from({ length: 5 }, () => guard.recordToolCall('run_command', { command: 'npm test' }, { exitCode: 1, durationMs: Math.random() }));
    expect(verdicts).toEqual(['ok', 'ok', 'warn', 'warn', 'stop']);
  });

  it('starts counting again when the call or its result changes', () => {
    const guard = new RunGuard();
    guard.recordToolCall('read_file', { path: 'a' }, 'x');
    guard.recordToolCall('read_file', { path: 'a' }, 'x');
    expect(guard.recordToolCall('read_file', { path: 'a' }, 'y')).toBe('ok');
    expect(guard.recordToolCall('read_file', { path: 'b' }, 'y')).toBe('ok');
    expect(guard.repeatCount).toBe(1);
  });

  it('treats argument key order as the same call', () => {
    const guard = new RunGuard();
    guard.recordToolCall('search_files', { query: 'a', path: 'src' }, []);
    guard.recordToolCall('search_files', { path: 'src', query: 'a' }, []);
    expect(guard.recordToolCall('search_files', { query: 'a', path: 'src' }, [])).toBe('warn');
  });

  it('reads the ceiling from the environment and ignores bad values', () => {
    expect(maxRunCostFromEnvironment({ KAI_MAX_RUN_COST_USD: '12.5' })).toBe(12.5);
    expect(maxRunCostFromEnvironment({ KAI_MAX_RUN_COST_USD: '0' })).toBe(0);
    expect(maxRunCostFromEnvironment({ KAI_MAX_RUN_COST_USD: 'lots' })).toBeUndefined();
    expect(maxRunCostFromEnvironment({})).toBeUndefined();
  });
});
