export interface RunControlPort {
  pause(conversationId: string): boolean;
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

  pause(conversationId: string): boolean {
    this.paused.add(conversationId);
    void this.suspendRun?.(conversationId);
    return true;
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
