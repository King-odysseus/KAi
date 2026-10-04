import { describe, expect, it } from 'vitest';
import { settleWithin, type CancelScheduled, type Scheduler } from '../apps/desktop/src/renderer/src/async-deadline';

/**
 * The bound that stops the composer waiting on a call that may never return.
 *
 * Every transient flag in the composer is cleared in a `finally`, so a promise that never settles left the control
 * disabled for good with nothing on screen to explain it. These tests drive the clock by hand through the injected
 * scheduler rather than waiting on a real one, so nothing here depends on timing.
 */

/** A scheduler that only fires when the test says so, and reports what is still armed. */
function manual(): { schedule: Scheduler; fire: () => void; armed: () => number } {
  const queued = new Map<number, () => void>();
  let nextId = 0;
  return {
    schedule: (callback): CancelScheduled => {
      const id = nextId;
      nextId += 1;
      queued.set(id, callback);
      return () => { queued.delete(id); };
    },
    fire: () => {
      for (const [id, callback] of [...queued]) {
        queued.delete(id);
        callback();
      }
    },
    armed: () => queued.size,
  };
}

/** Lets the queued microtasks run, so a `Promise.race` inside `settleWithin` has had its chance to settle. */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('settleWithin', () => {
  it('returns the value when the work answers in time', async () => {
    const clock = manual();
    await expect(settleWithin(async () => 'done', 1_000, clock.schedule)).resolves.toEqual({ settled: true, value: 'done' });
  });

  it('disarms its own deadline once the work has settled', async () => {
    const clock = manual();
    await settleWithin(async () => 'done', 1_000, clock.schedule);
    // This is the bug the helper would otherwise introduce: a timer left armed fires later and reports a timeout
    // against whatever the caller wrapped next.
    expect(clock.armed()).toBe(0);
  });

  it('reports an unsettled deadline rather than waiting forever', async () => {
    const clock = manual();
    const never = new Promise<string>(() => undefined);
    const outcome = settleWithin(() => never, 1_000, clock.schedule);
    clock.fire();
    await expect(outcome).resolves.toEqual({ settled: false });
  });

  it('rethrows a rejection that arrives in time, so callers keep their own error notice', async () => {
    const clock = manual();
    await expect(settleWithin(async () => { throw new Error('refused'); }, 1_000, clock.schedule))
      .rejects.toThrow('refused');
  });

  it('drops a rejection that arrives after the deadline instead of raising it later', async () => {
    const clock = manual();
    let fail: (error: Error) => void = () => undefined;
    const pending = new Promise<string>((_resolve, reject) => { fail = reject; });
    const outcome = settleWithin(() => pending, 1_000, clock.schedule);
    clock.fire();
    await expect(outcome).resolves.toEqual({ settled: false });
    // There is no UI left waiting to be told about this one, so surfacing it would only be noise.
    fail(new Error('too late'));
    await flush();
  });

  it('keeps one call\'s deadline from reaching another', async () => {
    const clock = manual();
    const never = new Promise<string>(() => undefined);
    const abandoned = settleWithin(() => never, 1_000, clock.schedule);
    clock.fire();
    await expect(abandoned).resolves.toEqual({ settled: false });
    // The second call is unaffected by the first having timed out: it has its own deadline and its own result.
    await expect(settleWithin(async () => 'second', 1_000, clock.schedule)).resolves.toEqual({ settled: true, value: 'second' });
  });
});
