/**
 * Stops the UI waiting on one call, so a promise that never settles cannot hold a control disabled for good.
 *
 * Every transient flag in the composer is cleared in a `finally`, which means the clearing never happens if the
 * awaited call never returns: the spinner keeps spinning, the send button keeps its `disabled`, and nothing on
 * screen says why. This does not cancel the work underneath — nothing here can — it only stops the UI waiting, so
 * the caller can say what happened and offer a way out.
 */

export type DeadlineOutcome<T> = { settled: true; value: T } | { settled: false };

/** Cancels a scheduled callback. */
export type CancelScheduled = () => void;

/**
 * `setTimeout`, narrowed to what this needs and injected, so a test drives the clock by hand rather than waiting
 * on a real one.
 */
export type Scheduler = (fire: () => void, delayMs: number) => CancelScheduled;

const realScheduler: Scheduler = (fire, delayMs) => {
  const handle = setTimeout(fire, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Resolves to the call's value, or to `{ settled: false }` once `ms` has passed without one.
 *
 * A rejection that arrives in time is rethrown, so a caller keeps relying on `unwrap` to reach its error notice.
 * A rejection that arrives *after* the deadline is dropped: `Promise.race` attached its handlers to the work
 * already, so nothing is left unhandled, and there is no UI left waiting to be told about it.
 */
export async function settleWithin<T>(
  work: () => Promise<T>,
  ms: number,
  schedule: Scheduler = realScheduler,
): Promise<DeadlineOutcome<T>> {
  const timedOut = Symbol('deadline');
  let expire: (value: typeof timedOut) => void = () => undefined;
  const expired = new Promise<typeof timedOut>((resolve) => { expire = resolve; });
  const cancel = schedule(() => expire(timedOut), ms);
  try {
    const outcome = await Promise.race([work(), expired]);
    return outcome === timedOut ? { settled: false } : { settled: true, value: outcome };
  } finally {
    // The deadline has to be dropped on the settling path too. A call that finishes in time and leaves its timer
    // armed would fire later and report a timeout against whatever the caller wrapped next.
    cancel();
  }
}
