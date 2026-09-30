import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunScore, Schedule } from '../packages/contracts/src';
import { autoCliModel } from '../apps/desktop/src/main/auto-model';
import { parseReview, renderReview } from '../apps/desktop/src/main/change-review';
import { escalatedLevel, RunScoreStore, summarizeScores } from '../apps/desktop/src/main/run-scores';
import { DesktopScheduler, isDue, nextRunTime, ScheduleStore } from '../apps/desktop/src/main/scheduler';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'kai-auto-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

function score(overrides: Partial<RunScore> = {}): RunScore {
  return {
    at: '2026-01-01T00:00:00.000Z', projectId: 'p1', agent: 'claude', execution: 'cli', level: 'standard',
    completed: true, checkPassed: null, fixRounds: 0, filesChanged: 1, durationMs: 1_000, ...overrides,
  };
}

describe('run scorecards', () => {
  it('counts a run as clean only when it finished with no failing check and no fix round', () => {
    const cards = summarizeScores([
      score(), score({ checkPassed: true }), score({ checkPassed: false }), score({ fixRounds: 1 }), score({ completed: false }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ runs: 5, cleanRuns: 2, cleanRate: 0.4 });
  });

  it('escalates a level only after enough runs, and only for CLI agents below heavy', () => {
    const bad = (level: RunScore['level'], count: number, execution: RunScore['execution'] = 'cli') =>
      Array.from({ length: count }, () => score({ level, execution, completed: false }));
    expect(escalatedLevel('standard', 'claude', bad('standard', 4)).level).toBe('standard');
    const escalated = escalatedLevel('standard', 'claude', bad('standard', 5));
    expect(escalated.level).toBe('heavy');
    expect(escalated.why).toContain('one level up');
    expect(escalatedLevel('light', 'claude', bad('light', 6)).level).toBe('standard');
    expect(escalatedLevel('heavy', 'claude', bad('heavy', 9)).level).toBe('heavy');
    expect(escalatedLevel('standard', 'claude', bad('standard', 9, 'api')).level).toBe('standard');
    expect(escalatedLevel('standard', 'codex', bad('standard', 9)).level).toBe('standard');
  });

  it('lets an improving agent recover because only recent runs count', () => {
    const history = [...Array.from({ length: 10 }, () => score({ completed: false })), ...Array.from({ length: 30 }, () => score())];
    expect(summarizeScores(history)[0]?.escalated).toBe(false);
  });

  it('steers the automatic model choice one tier up, and says why', () => {
    const settings = { autoModel: { enabled: true, tiers: { claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' } } } } as never;
    const failing = Array.from({ length: 6 }, () => score({ completed: false }));
    const choice = autoCliModel({ agent: 'claude', route: 'direct', prompt: 'ok do it', effort: undefined }, settings, 0, (level, agent) => escalatedLevel(level, agent, failing));
    expect(choice?.model).toBe('opus');
    expect(choice?.note).toContain('one level up');
    const plain = autoCliModel({ agent: 'claude', route: 'direct', prompt: 'ok do it', effort: undefined }, settings, 0);
    expect(plain?.model).toBe('sonnet');
  });

  it('stores scores on disk and ignores malformed rows', async () => {
    const store = new RunScoreStore(path.join(directory, 'scores.json'));
    await store.add(score());
    await store.add(score({ agent: 'codex' }));
    expect((await store.list()).map((item) => item.agent)).toEqual(['claude', 'codex']);
  });
});

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1', projectId: 'p1', name: 'Nightly', prompt: 'run the tests', agent: 'claude', execution: 'cli', route: 'direct',
    autonomy: 'plan', frequency: { kind: 'interval', everyMinutes: 60 }, enabled: true, createdAt: '2026-05-01T10:00:00.000Z', ...overrides,
  };
}

describe('schedules', () => {
  it('is due once an interval has passed since it last ran', () => {
    expect(isDue(schedule(), new Date('2026-05-01T10:59:00.000Z'))).toBe(false);
    expect(isDue(schedule(), new Date('2026-05-01T11:00:00.000Z'))).toBe(true);
    expect(isDue(schedule({ lastRunAt: '2026-05-01T11:00:00.000Z' }), new Date('2026-05-01T11:30:00.000Z'))).toBe(false);
    expect(isDue(schedule({ enabled: false }), new Date('2026-06-01T00:00:00.000Z'))).toBe(false);
  });

  it('fires a daily schedule once its time has passed, never twice in a day, and catches up once', () => {
    const daily = schedule({ frequency: { kind: 'daily', at: '07:30' }, createdAt: '2026-05-01T00:00:00.000Z' });
    const local = (hours: number, minutes: number, day = 2): Date => new Date(2026, 4, day, hours, minutes, 0, 0);
    expect(isDue({ ...daily, createdAt: local(0, 0, 2).toISOString() }, local(7, 29))).toBe(false);
    expect(isDue({ ...daily, createdAt: local(0, 0, 2).toISOString() }, local(7, 31))).toBe(true);
    expect(isDue({ ...daily, lastRunAt: local(7, 31).toISOString() }, local(23, 0))).toBe(false);
    expect(isDue({ ...daily, lastRunAt: local(7, 31).toISOString() }, local(7, 31, 3))).toBe(true);
    // Created after today's time: the first run is tomorrow.
    expect(isDue({ ...daily, createdAt: local(9, 0).toISOString() }, local(12, 0))).toBe(false);
  });

  it('reports when the next run will be', () => {
    const next = nextRunTime(schedule({ lastRunAt: '2026-05-01T10:00:00.000Z' }), new Date('2026-05-01T10:10:00.000Z'));
    expect(next?.toISOString()).toBe('2026-05-01T11:00:00.000Z');
    expect(nextRunTime(schedule({ enabled: false }), new Date())).toBeNull();
  });

  it('runs a due schedule once, records the outcome, and does not run a disabled one', async () => {
    const store = new ScheduleStore(path.join(directory, 'schedules.json'));
    const ran: string[] = [];
    const now = new Date('2026-05-01T12:00:00.000Z');
    const scheduler = new DesktopScheduler(store, {
      now: () => now,
      run: async (item) => { ran.push(item.id); return { status: 'completed', summary: 'All good', conversationId: 'conv1' }; },
    });
    const saved = await scheduler.save({ projectId: 'p1', name: 'Nightly', prompt: 'run the tests', agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', frequency: { kind: 'interval', everyMinutes: 60 }, enabled: true });
    await store.put({ ...saved, createdAt: '2026-05-01T09:00:00.000Z' });
    await scheduler.save({ projectId: 'p1', name: 'Off', prompt: 'x', agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', frequency: { kind: 'interval', everyMinutes: 15 }, enabled: false });

    await scheduler.tick();
    await scheduler.tick();

    expect(ran).toEqual([saved.id]);
    const after = await store.get(saved.id);
    expect(after).toMatchObject({ lastStatus: 'completed', lastSummary: 'All good', lastConversationId: 'conv1', lastRunAt: now.toISOString() });
    expect((await scheduler.list('p1'))).toHaveLength(2);
    expect(await scheduler.list('other')).toEqual([]);
  });

  it('records a thrown run as failed instead of losing it, and can delete a schedule', async () => {
    const store = new ScheduleStore(path.join(directory, 'schedules.json'));
    const scheduler = new DesktopScheduler(store, { run: async () => { throw new Error('boom'); } });
    const saved = await scheduler.save({ projectId: 'p1', name: 'Bad', prompt: 'x', agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', frequency: { kind: 'interval', everyMinutes: 15 }, enabled: true });
    const result = await scheduler.runNow(saved.id);
    expect(result).toMatchObject({ lastStatus: 'failed', lastSummary: 'boom' });
    expect(await scheduler.remove(saved.id)).toBe(true);
    expect(await scheduler.remove(saved.id)).toBe(false);
  });
});

describe('change review', () => {
  it('parses a reply, treating unknown severities as medium and low-only findings as ok', () => {
    const review = parseReview(JSON.stringify({ ok: true, summary: 'Looks right.', issues: [{ file: 'a.ts', severity: 'weird', note: 'Missing null check' }, { file: '', severity: 'low', note: '' }] }));
    expect(review.issues).toEqual([{ file: 'a.ts', severity: 'medium', note: 'Missing null check' }]);
    expect(review.ok).toBe(false);
    expect(parseReview(JSON.stringify({ ok: true, summary: 'Fine.', issues: [{ file: 'a.ts', severity: 'low', note: 'Naming' }] })).ok).toBe(true);
    expect(() => parseReview(JSON.stringify({ summary: 'x' }))).toThrow(/expected shape/);
  });

  it('renders a short verdict', () => {
    expect(renderReview({ ok: true, summary: 'Nothing to fix.', issues: [] })).toBe('Review: no problems found. Nothing to fix.');
    const text = renderReview({ ok: false, summary: 'Tests were removed.', issues: [{ file: 'a.test.ts', severity: 'high', note: 'Deleted the failing test' }] });
    expect(text).toContain('needs your attention');
    expect(text).toContain('- HIGH in a.test.ts: Deleted the failing test');
  });
});
