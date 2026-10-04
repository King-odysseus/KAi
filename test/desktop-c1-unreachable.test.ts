import { describe, expect, it } from 'vitest';
import { looksUnreachable } from '../apps/desktop/src/main/ipc';
import { MemoryBudget } from '../apps/desktop/src/main/memory-budget';

/**
 * This decides whether KAI restarts the brain, so both directions matter. Restarting on a refusal would throw away
 * whatever the daemon was in the middle of saying; *not* restarting on a dead endpoint is the bug this exists to fix —
 * the daemon had stopped answering without ever exiting, so the restart policy never heard about it and every recall
 * and every draft silently failed against a closed port.
 */
describe('deciding whether the brain could be reached', () => {
  it('recognises the ways a closed port fails, since that is the case worth restarting', () => {
    const failures = [
      new Error('fetch failed'),
      new Error('connect ECONNREFUSED 127.0.0.1:9877'),
      new Error('socket hang up'),
      new Error('connect ETIMEDOUT 127.0.0.1:9877'),
      'ERROR: ECONNRESET',
    ];
    for (const failure of failures) {
      expect(looksUnreachable(failure), String(failure)).toBe(true);
    }
  });

  it('leaves the daemon alone when it answered, however unhappily', () => {
    // Each of these is the daemon talking, so restarting it would lose the answer rather than fix anything.
    const refusals = [
      new Error('Cognitive1 returned 401 Unauthorized'),
      new Error('The brain rejected the entry: too similar to an existing one'),
      new Error('Cognitive1 operation brain-drafts failed: 500'),
      undefined,
      null,
      '',
    ];
    for (const failure of refusals) {
      expect(looksUnreachable(failure), String(failure)).toBe(false);
    }
  });

  it('recognises the client\'s own wording for a daemon that accepted the request and never answered', () => {
    // The one failure this check exists for, and the one it used to miss: the daemon is alive, so the connection is
    // made, and it never replies. Nothing threw at connect time, so before this it was not treated as unreachable
    // and the restart never happened.
    expect(looksUnreachable(new Error('Cognitive1 did not respond before the request timed out.'))).toBe(true);
    expect(looksUnreachable(new Error('The request timed out.'))).toBe(true);
  });
});

/**
 * How long a run waits for its memory work.
 *
 * A run asks the brain four things before it starts, each willing to wait 30 seconds, so a hung brain added up to
 * about two minutes of a run that had not begun — the composer showing a spinner for work nobody was doing. One
 * shared deadline replaces that: past it the run starts without memory and says so.
 */
describe('the memory budget', () => {
  it('lets work that finishes inside the budget through, with its answer', async () => {
    const budget = new MemoryBudget(1_000);

    expect(await budget.run(Promise.resolve('recalled'))).toBe('recalled');
    expect(budget.expired).toBe(false);
  });

  it('gives up on work that runs past it, rather than waiting for the 30-second client timeout', async () => {
    let resolveLate: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => { resolveLate = resolve; });
    const budget = new MemoryBudget(30);

    expect(await budget.run(slow)).toBeNull();
    expect(budget.expired).toBe(true);

    // The work is left to finish on its own; resolving it afterwards must not throw or leak into anything.
    resolveLate('too late');
  });

  it('spends one budget across the whole run\'s worth of calls, not one per call', async () => {
    // Each call would fit comfortably on its own; together they do not. This is the two-minutes-of-nothing bug
    // restated as an assertion.
    const budget = new MemoryBudget(60);
    const slow = async (): Promise<string> => new Promise((resolve) => { setTimeout(() => resolve('ok'), 40); });

    expect(await budget.run(slow())).toBe('ok');
    expect(await budget.run(slow())).toBeNull();
  });

  it('gives up at once, and says nothing, when the budget is already spent', async () => {
    const budget = new MemoryBudget(0);

    // Note what this can and cannot promise: the work has already been started by the caller by the time it arrives
    // here, because the client's methods return promises. What the budget controls is how long the run waits for
    // them, and a spent budget waits for nothing at all.
    const never = new Promise<string>(() => {});
    expect(await budget.run(never)).toBeNull();
  });
});
