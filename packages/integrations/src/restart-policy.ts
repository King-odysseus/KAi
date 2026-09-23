export interface RestartPolicyOptions {
  /** Restarts allowed within one window before giving up. */
  maxRestarts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Crashes older than this no longer count, so a long-lived service earns its budget back. */
  windowMs?: number;
}

export type RestartDecision =
  | { action: 'restart'; attempt: number; delayMs: number }
  | { action: 'give-up'; attempts: number };

/** Bounded automatic restarts with exponential backoff. Pure: the caller supplies the clock. */
export class RestartPolicy {
  private readonly crashes: number[] = [];
  private readonly maxRestarts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly windowMs: number;

  constructor(options: RestartPolicyOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.windowMs = options.windowMs ?? 10 * 60_000;
  }

  onCrash(now: number): RestartDecision {
    while (this.crashes.length > 0 && now - this.crashes[0]! > this.windowMs) this.crashes.shift();
    if (this.crashes.length >= this.maxRestarts) return { action: 'give-up', attempts: this.crashes.length };
    this.crashes.push(now);
    const attempt = this.crashes.length;
    return { action: 'restart', attempt, delayMs: Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs) };
  }

  /** Forget history, for example after the user restarts the service by hand. */
  reset(): void {
    this.crashes.length = 0;
  }

  restartCount(now: number): number {
    return this.crashes.filter((at) => now - at <= this.windowMs).length;
  }
}
