/**
 * One load for everyone who asks at about the same time.
 *
 * Every API run began by loading every saved conversation to work out what had been spent. Starting eight runs in the
 * same moment loaded all of them eight times over — 661 conversations, 718 MB of JSON, a few gigabytes of objects each
 * time — and KAI's main process ran out of memory seconds later. A run does not need a figure that is fresh to the
 * second, so callers inside a short window share a single load, and a load that failed is never kept.
 */

interface Held<T> {
  at: number;
  value: Promise<T>;
}

const held = new WeakMap<object, Held<unknown>>();

/**
 * The result of `load`, shared by every caller for `windowMs` after it started.
 * `owner` says what is being loaded and keeps two different sources from sharing a result.
 */
export function sharedLoad<T>(owner: object, load: () => Promise<T>, windowMs: number, now: number = Date.now()): Promise<T> {
  const current = held.get(owner) as Held<T> | undefined;
  if (current && now - current.at < windowMs) return current.value;
  const value = load();
  const entry: Held<T> = { at: now, value };
  held.set(owner, entry);
  // A failure is not worth keeping: the next caller should try again, not be handed the same error.
  value.catch(() => {
    if (held.get(owner) === entry) held.delete(owner);
  });
  return value;
}
