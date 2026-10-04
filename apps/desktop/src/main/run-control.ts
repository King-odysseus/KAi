export interface RunControlPort {
  /** Whether the run was actually suspended. The API path only pauses between provider rounds, so a false here
   * means "asked, but nothing was held" rather than an error. */
  pause(conversationId: string): Promise<boolean>;
  resume(conversationId: string): boolean;
  isPaused(conversationId: string): boolean;
  waitIfPaused(conversationId: string, signal: AbortSignal): Promise<void>;
  forget(conversationId: string): void;
}

/** Coordinates cooperative pauses for API runs and process suspension for CLI runs. */
export class DesktopRunControl implements RunControlPort {
  private readonly paused = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly suspendRun?: (conversationId: string) => Promise<void> | void;
  private readonly resumeRun?: (conversationId: string) => Promise<void> | void;

  constructor(options: {
    suspendRun?: (conversationId: string) => Promise<void> | void;
    resumeRun?: (conversationId: string) => Promise<void> | void;
  } = {}) {
    this.suspendRun = options.suspendRun;
    this.resumeRun = options.resumeRun;
  }

  /**
   * Marks the run paused and asks the runtime to suspend it. Awaited, and its answer is the whole answer: a CLI run
   * with no child process yet cannot be suspended, and an API run can only pause between provider rounds, so saying
   * "paused, it will continue from the same point" without checking was a promise the app could not keep.
   */
  async pause(conversationId: string): Promise<boolean> {
    this.paused.add(conversationId);
    if (!this.suspendRun) return true;
    try {
      await this.suspendRun(conversationId);
      return true;
    } catch {
      this.paused.delete(conversationId);
      return false;
    }
  }

  resume(conversationId: string): boolean {
    const changed = this.paused.delete(conversationId);
    for (const resolve of this.waiters.get(conversationId) ?? []) resolve();
    this.waiters.delete(conversationId);
    if (changed) void this.resumeRun?.(conversationId);
    return true;
  }

  isPaused(conversationId: string): boolean {
    return this.paused.has(conversationId);
  }

  async waitIfPaused(conversationId: string, signal: AbortSignal): Promise<void> {
    if (!this.paused.has(conversationId)) return;
    if (signal.aborted) throw abortReason(signal);
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = (): void => {
        this.waiters.get(conversationId)?.delete(done);
        reject(abortReason(signal));
      };
      const waiters = this.waiters.get(conversationId) ?? new Set<() => void>();
      waiters.add(done);
      this.waiters.set(conversationId, waiters);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  forget(conversationId: string): void {
    this.paused.delete(conversationId);
    for (const resolve of this.waiters.get(conversationId) ?? []) resolve();
    this.waiters.delete(conversationId);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The run was cancelled while paused.');
}
