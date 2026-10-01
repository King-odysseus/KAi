/**
 * Rate-limit awareness shared by the API runtime and Autopilot.
 *
 * Retrying a few times with a short wait (the API runtime's job) rides out a blip. A provider that keeps refusing,
 * or says "try again in ten minutes", needs a real rest, and that decision belongs to whoever is driving a long job.
 * This file gives both sides the same vocabulary: a typed error carrying the provider's own hint, a detector for
 * the plain-text limit messages the CLI agents print, and the schedule of rests.
 */

/** A provider kept refusing with a rate limit or a quota message after the runtime's own retries. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RateLimitSignal {
  /** How long the provider asked us to wait, when it said. */
  retryAfterMs?: number;
  /** A usage window (the CLIs' five-hour allowance) ran out, as opposed to a burst limit that clears in seconds. */
  window?: boolean;
}

const LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /usage limit/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /exceeded your (?:current )?quota/i,
  /overloaded/i,
  /resource[_\s]exhausted/i,
  /try again (?:in|after|later)/i,
  /limit (?:will )?reset/i,
];

const UNIT_MS: Record<string, number> = { s: 1_000, sec: 1_000, second: 1_000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000 };

/** Subscription CLIs meter usage in windows (about five hours); once spent, only the reset helps. */
const WINDOW_PATTERNS: readonly RegExp[] = [
  /\b\d+[\s-]?(?:hour|hr|h)\b.*\blimit/i,
  /\blimit\b.*\b\d+[\s-]?(?:hour|hr|h)\b/i,
  /usage limit/i,
  /limit (?:reached|hit|exceeded)/i,
  /(?:weekly|daily|monthly) limit/i,
];

/** Reads "in 2 hours 5 minutes", "after 30s", "in 1m30s" and the like; undefined when no duration is stated. */
export function parseWaitHint(text: string, now: number = Date.now()): number | undefined {
  const clockWait = parseResetClock(text, now);
  if (clockWait !== undefined) return clockWait;
  const lead = /(?:try again|retry|resets?|available|wait)\s*(?:in|after|for)?\s*((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text);
  if (!lead?.[1]) return undefined;
  let total = 0;
  for (const part of lead[1].matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const raw = (part[2] ?? '').toLowerCase();
    const unit = raw.length > 1 ? raw.replace(/s$/, '') : raw;
    const factor = UNIT_MS[unit] ?? UNIT_MS[unit.slice(0, 1)];
    if (factor) total += Number(part[1]) * factor;
  }
  return total > 0 ? Math.round(total) : undefined;
}

/**
 * Reads "resets at 3pm", "resets 3:30 pm", "reset at 15:00": the CLIs often name a time of day, not a duration. The
 * time is taken as the next one on this machine's clock; a zone in brackets after it is ignored, because the CLI
 * prints the user's own zone.
 */
function parseResetClock(text: string, now: number): number | undefined {
  const match = /\bresets?\s*(?:at|on)?\s*(?:[a-z]{3,9}\s+\d{1,2}\s*(?:,|at)?\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (!match?.[1]) return undefined;
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  // A bare number with no minutes or am/pm is more likely a count than a clock time.
  if (!meridiem && match[2] === undefined) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

/**
 * Whether a failure message reads as a rate limit or quota stop. A typed `RateLimitError` is trusted outright; for
 * anything else the text is matched, because a CLI agent only ever reports the limit as a sentence.
 */
export function detectRateLimit(error: unknown): RateLimitSignal | null {
  if (error instanceof RateLimitError) return error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs };
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Running out of context is the prompt's problem; resting would only repeat the same failure for hours.
  if (/context (?:length|window)|maximum context|prompt is too long|too many tokens/i.test(text)) return null;
  const window = WINDOW_PATTERNS.some((pattern) => pattern.test(text));
  if (!text || (!window && !LIMIT_PATTERNS.some((pattern) => pattern.test(text)))) return null;
  const hint = parseWaitHint(text);
  return { ...(hint === undefined ? {} : { retryAfterMs: hint }), ...(window ? { window: true } : {}) };
}

/** The rest taken after the nth limit in a row: a minute, then longer, never more than half an hour per step. */
const COOLDOWN_STEPS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000] as const;
export const MAX_HINTED_COOLDOWN_MS = 8 * 3_600_000;
const WINDOW_POLL_MS = 30 * 60_000;

/**
 * How long to rest. The provider's own hint wins when it is longer than the schedule, since resuming earlier only
 * earns another refusal; a hint is capped at six hours so a bad number cannot park a job for a day.
 */
export function cooldownMs(streak: number, hintMs?: number, window = false): number {
  // A spent usage window will not reopen in a minute. With no reset time to aim at, check back every half hour
  // rather than burning a request every few minutes for hours.
  if (window && (hintMs === undefined || hintMs <= 0)) return WINDOW_POLL_MS;
  const scheduled = COOLDOWN_STEPS_MS[Math.min(Math.max(streak, 1), COOLDOWN_STEPS_MS.length) - 1] ?? COOLDOWN_STEPS_MS[0];
  if (hintMs === undefined || !Number.isFinite(hintMs) || hintMs <= 0) return scheduled;
  // A little slack past the stated time, because the provider's clock and ours disagree by a second or two.
  return Math.min(MAX_HINTED_COOLDOWN_MS, Math.max(scheduled, hintMs + 5_000));
}

/** Sleeps, but wakes early (rejecting) when the signal aborts, so Stop is never stuck behind a cooldown. */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Cancelled.');
}

export interface PacerOptions {
  /** Requests allowed in flight at once. */
  maxConcurrent: number;
  /** The least time between one request starting and the next. */
  minGapMs: number;
  now?: () => number;
}

/**
 * Spaces requests out before the provider has to ask. It starts at the configured gap and widens it each time the
 * provider refuses, then eases back after a run of successes, so a long job settles at whatever pace the key allows.
 */
export class RequestPacer {
  private inFlight = 0;
  private nextStart = 0;
  private extraGapMs = 0;
  private successes = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: PacerOptions) {
    this.now = options.now ?? Date.now;
  }

  get gapMs(): number {
    return this.options.minGapMs + this.extraGapMs;
  }

  /** Resolves when a request may start. Pair every call with `release`. */
  async acquire(signal: AbortSignal): Promise<void> {
    while (this.inFlight >= Math.max(1, this.options.maxConcurrent)) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(abortReason(signal));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    this.inFlight += 1;
    const start = Math.max(this.now(), this.nextStart);
    this.nextStart = start + this.gapMs;
    const wait = start - this.now();
    if (wait > 0) {
      try {
        await sleepAbortable(wait, signal);
      } catch (error) {
        this.release();
        throw error;
      }
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiting.shift()?.();
  }

  /** Call with each response's status. A 429 slows the pace; a run of good responses speeds it back up. */
  report(status: number): void {
    if (status === 429) {
      this.successes = 0;
      this.extraGapMs = Math.min(30_000, Math.max(1_000, this.extraGapMs * 2));
    } else if (status >= 200 && status < 300 && this.extraGapMs > 0) {
      this.successes += 1;
      if (this.successes >= 10) {
        this.successes = 0;
        this.extraGapMs = this.extraGapMs <= 1_000 ? 0 : Math.floor(this.extraGapMs / 2);
      }
    }
  }
}
