/**
 * Runs work one piece at a time per key, and lets overlapping callers share one piece of work.
 *
 * It exists for the service controller. Several parts of KAI can notice at the same moment that Cognitive1 has
 * stopped answering, and each used to ask for a restart. The restarts overlapped and raced for one port: the one that
 * lost cleaned up by forgetting the winner's gateway, which stayed bound to the port with nothing left able to close
 * it, so every later restart failed with "port already in use". Taking turns, and sharing one restart between
 * everyone who asked while it ran, removes the race instead of working around it.
 */
export class KeyedQueue<K> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly shared = new Map<K, Promise<unknown>>();

  /** Runs `work` after everything already queued for this key has finished, whether that succeeded or failed. */
  run<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /**
   * Like `run`, but a caller who arrives while the same key's shared work is still going gets that work's result
   * instead of starting another. Once it has finished, the next caller starts fresh.
   */
  share<T>(key: K, work: () => Promise<T>): Promise<T> {
    const running = this.shared.get(key) as Promise<T> | undefined;
    if (running) return running;
    const result = this.run(key, work);
    this.shared.set(key, result);
    const forget = (): void => {
      if (this.shared.get(key) === result) this.shared.delete(key);
    };
    void result.then(forget, forget);
    return result;
  }
}
