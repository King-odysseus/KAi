/**
 * How long a run will wait for its memory work.
 *
 * A run asks the brain four things before it starts — the project's name, any handoff to record, a session to open,
 * and a recall — and each of those waits 30 seconds on its own. When the engine is healthy none of them takes
 * measurable time; when it is hung, they add up to about two minutes of a run that has not started yet, with the
 * composer sitting there looking like it is thinking.
 *
 * So the pre-run work shares one deadline instead of each call carrying its own. Past it the run starts without
 * memory and says so. Nothing about a run's answer depends on the brain having answered: memory is grounding, and
 * grounding that arrives two minutes late is worth less than a run that starts.
 */
export const MEMORY_BUDGET_MS = 6_000;

export class MemoryBudget {
  private readonly until: number;

  constructor(totalMs: number = MEMORY_BUDGET_MS, private readonly now: () => number = Date.now) {
    this.until = now() + totalMs;
  }

  /** What is left of the budget. Zero means it is spent. */
  get remainingMs(): number {
    return Math.max(0, this.until - this.now());
  }

  get expired(): boolean {
    return this.remainingMs <= 0;
  }

  /**
   * Waits for one piece of memory work as long as there is budget left, then stops waiting.
   *
   * A null answer means "did not finish in time", and is not an error: the caller carries on without it.
   *
   * What this cannot do is stop the work: the caller has already started it, because the client's methods are how a
   * request is made and they return promises. So the request is left to resolve on its own and its result discarded.
   * That is deliberate — the alternatives are a per-call cancellation the client does not offer, or waiting, which is
   * the thing being fixed.
   */
  async run<T>(work: Promise<T>): Promise<T | null> {
    const remaining = this.remainingMs;
    if (remaining <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
