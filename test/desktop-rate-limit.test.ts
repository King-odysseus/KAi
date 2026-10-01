import { describe, expect, it } from 'vitest';
import { cooldownMs, detectRateLimit, parseWaitHint, RateLimitError, RequestPacer } from '../apps/desktop/src/main/rate-limit';

describe('rate limit detection', () => {
  it('trusts a typed error and carries its wait', () => {
    expect(detectRateLimit(new RateLimitError('slow down', 12_000))).toEqual({ retryAfterMs: 12_000 });
    expect(detectRateLimit(new RateLimitError('slow down'))).toEqual({});
  });

  it('recognises the plain-text limits CLI agents print', () => {
    expect(detectRateLimit(new Error('Provider request failed (429): Too Many Requests'))).not.toBeNull();
    expect(detectRateLimit('Claude usage limit reached. Your limit will reset in 2 hours 5 minutes.')).toEqual({ retryAfterMs: 7_500_000, window: true });
    expect(detectRateLimit('You exceeded your current quota, please check your plan')).not.toBeNull();
    expect(detectRateLimit('The model is overloaded. Try again later.')).not.toBeNull();
  });

  it('does not mistake an ordinary failure for a limit', () => {
    expect(detectRateLimit(new Error('Cannot find module "left-pad"'))).toBeNull();
    expect(detectRateLimit('Type error on line 4290')).toBeNull();
    expect(detectRateLimit('This model context length limit exceeded: 140000 tokens')).toBeNull();
    expect(detectRateLimit(undefined)).toBeNull();
  });

  it('treats a spent usage window as a window, even with no reset time', () => {
    expect(detectRateLimit('5-hour limit reached')).toEqual({ window: true });
    expect(detectRateLimit('Error: HTTP 429 Too Many Requests')).toEqual({});
  });

  it('reads a reset time of day as the next time it comes round', () => {
    const now = new Date(2026, 9, 1, 13, 0, 0).getTime();
    expect(parseWaitHint('5-hour limit reached - resets 3pm (Europe/London)', now)).toBe(2 * 3_600_000);
    expect(parseWaitHint('limit resets at 12:30 pm', now)).toBe(23.5 * 3_600_000);
    expect(parseWaitHint('resets at 15:00', now)).toBe(2 * 3_600_000);
    expect(parseWaitHint('resets in 2 hours', now)).toBe(2 * 3_600_000);
  });

  it('reads waits in several shapes', () => {
    expect(parseWaitHint('try again in 30s')).toBe(30_000);
    expect(parseWaitHint('Please retry after 2 minutes')).toBe(120_000);
    expect(parseWaitHint('resets in 1h 30m')).toBe(5_400_000);
    expect(parseWaitHint('no hint here')).toBeUndefined();
  });
});

describe('cooldown schedule', () => {
  it('rests longer each time in a row and stops growing at half an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((streak) => cooldownMs(streak))).toEqual([60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]);
  });

  it('follows a provider hint that is longer than the schedule, with a little slack', () => {
    expect(cooldownMs(1, 2 * 3_600_000)).toBe(2 * 3_600_000 + 5_000);
  });

  it('polls a spent window every half hour when it names no reset time', () => {
    expect([1, 3, 8].map((streak) => cooldownMs(streak, undefined, true))).toEqual([1_800_000, 1_800_000, 1_800_000]);
    expect(cooldownMs(1, 3 * 3_600_000, true)).toBe(3 * 3_600_000 + 5_000);
  });

  it('keeps the schedule when the hint is shorter, and caps an absurd hint', () => {
    expect(cooldownMs(2, 10_000)).toBe(120_000);
    expect(cooldownMs(1, 99 * 3_600_000)).toBe(8 * 3_600_000);
  });
});

describe('request pacer', () => {
  it('widens the gap on a 429 and eases back after a run of good responses', () => {
    const pacer = new RequestPacer({ maxConcurrent: 1, minGapMs: 0 });
    pacer.report(429);
    expect(pacer.gapMs).toBe(1_000);
    pacer.report(429);
    expect(pacer.gapMs).toBe(2_000);
    for (let index = 0; index < 10; index += 1) pacer.report(200);
    expect(pacer.gapMs).toBe(1_000);
    for (let index = 0; index < 10; index += 1) pacer.report(200);
    expect(pacer.gapMs).toBe(0);
  });

  it('holds a second request until the first is released', async () => {
    const pacer = new RequestPacer({ maxConcurrent: 1, minGapMs: 0 });
    const signal = new AbortController().signal;
    await pacer.acquire(signal);
    let second = false;
    const waiting = pacer.acquire(signal).then(() => { second = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second).toBe(false);
    pacer.release();
    await waiting;
    expect(second).toBe(true);
  });

  it('lets Stop interrupt a request that is waiting its turn', async () => {
    const pacer = new RequestPacer({ maxConcurrent: 1, minGapMs: 0 });
    const controller = new AbortController();
    await pacer.acquire(controller.signal);
    const waiting = pacer.acquire(controller.signal);
    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
  });
});
