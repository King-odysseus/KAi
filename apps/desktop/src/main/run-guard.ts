/** Default per-run spend ceiling for direct API runs, in USD. Zero turns the check off. */
export const DEFAULT_MAX_RUN_COST_USD = 5;

const REPEAT_WARN_AT = 3;
const REPEAT_STOP_AT = 5;

export class RunLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLimitError';
  }
}

export type RepeatVerdict = 'ok' | 'warn' | 'stop';

/** An override from the environment (`KAI_MAX_RUN_COST_USD`), or undefined when it is unset or not a valid amount. */
export function maxRunCostFromEnvironment(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.KAI_MAX_RUN_COST_USD?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Guards one direct API run against two ways of burning money: spending past a ceiling, and an agent calling the
 * same tool with the same arguments and getting the same answer over and over.
 */
export class RunGuard {
  private lastKey = '';
  private streak = 0;

  constructor(private maxCostUsd: number = DEFAULT_MAX_RUN_COST_USD) {}

  setMaxCost(maxCostUsd: number): void {
    this.maxCostUsd = maxCostUsd;
  }

  /** Throws once the run's estimated cost passes the ceiling. An unpriced model (null) cannot be checked. */
  assertSpend(costUsd: number | null | undefined): void {
    if (this.maxCostUsd <= 0 || costUsd === null || costUsd === undefined) return;
    if (costUsd >= this.maxCostUsd) {
      throw new RunLimitError(
        `Stopped: this run has spent about $${costUsd.toFixed(2)}, past the $${this.maxCostUsd.toFixed(2)} per-run limit. `
        + 'Raise the per-run limit under Usage (0 turns it off) to let a run go further.',
      );
    }
  }

  /**
   * Note a finished tool call. The same call with the same result several times in a row means the agent is stuck,
   * so it is warned first and then stopped. Any different call or result starts the count again.
   */
  recordToolCall(name: string, input: unknown, output: unknown): RepeatVerdict {
    const key = `${name}\u0000${stableJson(input)}\u0000${stableJson(output)}`;
    this.streak = key === this.lastKey ? this.streak + 1 : 1;
    this.lastKey = key;
    if (this.streak >= REPEAT_STOP_AT) return 'stop';
    return this.streak >= REPEAT_WARN_AT ? 'warn' : 'ok';
  }

  get repeatCount(): number {
    return this.streak;
  }
}

export const REPEAT_WARNING =
  'You have made this exact call and received this exact result several times in a row. Repeating it will not change the outcome. '
  + 'Try a different approach, or stop and tell the user what is blocking you.';

export const REPEAT_STOP_MESSAGE =
  `Stopped: the agent repeated the same tool call with the same result ${REPEAT_STOP_AT} times in a row.`;

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        // Timings differ on every run of an otherwise identical command, so they must not hide a repeat.
        return Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .filter(([key]) => key !== 'durationMs')
            .sort(([left], [right]) => left.localeCompare(right)),
        );
      }
      return item;
    }) ?? '';
  } catch {
    return String(value);
  }
}
