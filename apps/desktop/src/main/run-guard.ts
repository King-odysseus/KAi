/**
 * Default per-run spend ceiling for direct API runs, in USD. Zero turns the check off, which is the default: a run is
 * not cut off by a number unless the person set one under Usage.
 */
export const DEFAULT_MAX_RUN_COST_USD = 0;

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
  private wrapUp = false;
  private attempted = 0;
  private succeeded = 0;
  private blockedByPolicy = 0;

  constructor(private maxCostUsd: number = DEFAULT_MAX_RUN_COST_USD) {}

  setMaxCost(maxCostUsd: number): void {
    this.maxCostUsd = maxCostUsd;
  }

  /** The limit in force, so a caller can ask about it instead of only being refused by it. Zero means no limit. */
  get maxCostLimitUsd(): number {
    return this.maxCostUsd;
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

  /**
   * Note how a tool call ended, so the run can tell "the model did nothing" from "the model was not allowed to do
   * anything". `blockedByPolicy` is the access level refusing the call — not the person declining an approval, which
   * is an answer rather than a wall, and not a call that simply failed on its own.
   */
  noteToolOutcome(ok: boolean, blockedByPolicy = false): void {
    this.attempted += 1;
    if (ok) this.succeeded += 1;
    if (blockedByPolicy) this.blockedByPolicy += 1;
  }

  /**
   * Whether the run was walled off rather than merely unproductive: it tried to do something, every attempt was
   * refused by the access level, and nothing got through.
   *
   * This is what makes such a run a failure instead of a success. It used to be scored `completed` whenever the model
   * said something — so a run under Plan access that tried to edit files, had every edit refused, and then wrote "I
   * could not make the change" was recorded as a completed run, and Auto could finish on it.
   */
  get walledOffByPolicy(): boolean {
    return this.attempted > 0 && this.succeeded === 0 && this.blockedByPolicy > 0;
  }

  /** The count is set aside once the person has been asked, so it takes five more before they are asked again. */
  resetRepeat(): void {
    this.lastKey = '';
    this.streak = 0;
  }

  /**
   * Set when a guard has been told to stop, so the loops stop offering tools and ask the model to sum up what it did.
   * A run that ends this way keeps its work; one that ends with a thrown error throws it away.
   */
  get wrapUpRequested(): boolean {
    return this.wrapUp;
  }

  requestWrapUp(): void {
    this.wrapUp = true;
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
