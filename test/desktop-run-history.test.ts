import { describe, expect, it } from 'vitest';
import type { RunScore } from '@kai/contracts';
import { buildHistoryNote, dayLabel } from '../apps/desktop/src/main/run-history';

/**
 * What KAI says at the start of a run about what it has already tried here.
 *
 * It reads the scores every scored run writes, so it works with the brain stopped and never leaves the machine. The
 * rules that matter: only runs with a recorded outcome, chosen by the files in play when there are any, capped, and
 * nothing at all when there is nothing to say.
 */

const NOW = Date.parse('2026-10-02T12:00:00.000Z');

function run(overrides: Partial<RunScore> = {}): RunScore {
  return {
    at: '2026-10-02T09:00:00.000Z',
    projectId: 'p1',
    agent: 'codex',
    execution: 'cli',
    level: 'standard',
    completed: true,
    checkPassed: true,
    fixRounds: 0,
    filesChanged: 2,
    durationMs: 60_000,
    ...overrides,
  };
}

describe('the history a run starts with', () => {
  it('says what happened to the files this run is about', () => {
    const note = buildHistoryNote({
      runs: [
        run({ files: ['src/app.tsx', 'src/other.ts'] }),
        run({ at: '2026-10-01T09:00:00.000Z', files: ['src/unrelated.ts'], checkPassed: false, completed: false }),
      ],
      files: ['src/app.tsx'],
      projectId: 'p1',
      now: NOW,
    });
    expect(note).toEqual(['- today: changed src/app.tsx, src/other.ts — the check passed.']);
  });

  it('says when the last run on these files did not work', () => {
    const note = buildHistoryNote({
      runs: [run({ files: ['src/app.tsx'], checkPassed: false, completed: false })],
      files: ['src/app.tsx'],
      projectId: 'p1',
      now: NOW,
    });
    expect(note?.[0]).toContain('the check failed, the run failed');
    expect(note?.[1]).toContain('did not finish cleanly');
  });

  it('falls back to the project recent runs when the task names no files yet', () => {
    const note = buildHistoryNote({
      runs: [run({ files: ['src/anything.ts'] })],
      files: [],
      projectId: 'p1',
      now: NOW,
    });
    expect(note).toHaveLength(1);
    expect(note?.[0]).toContain('the check passed');
  });

  it('keeps out of the way: no runs, no note', () => {
    expect(buildHistoryNote({ runs: [], files: [], projectId: 'p1', now: NOW })).toBeNull();
    // Another project is another history.
    expect(buildHistoryNote({ runs: [run({ projectId: 'p2', files: ['src/app.tsx'] })], files: ['src/app.tsx'], projectId: 'p1', now: NOW })).toBeNull();
    // Nothing shares a file with this task, so nothing here is worth saying.
    expect(buildHistoryNote({ runs: [run({ files: ['src/elsewhere.ts'] })], files: ['src/app.tsx'], projectId: 'p1', now: NOW })).toBeNull();
  });

  it('names a few files and counts the rest, and never lists more than three runs', () => {
    const note = buildHistoryNote({
      runs: [
        run({ at: '2026-10-02T11:00:00.000Z', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }),
        run({ at: '2026-10-02T10:00:00.000Z', files: ['a.ts'] }),
        run({ at: '2026-10-02T09:00:00.000Z', files: ['a.ts'] }),
        run({ at: '2026-10-01T09:00:00.000Z', files: ['a.ts'] }),
      ],
      files: ['a.ts'],
      projectId: 'p1',
      now: NOW,
    });
    expect(note?.[0]).toContain('a.ts, b.ts, c.ts and 2 more');
    expect(note).toHaveLength(3);
  });

  it('writes the day the way a person would say it', () => {
    expect(dayLabel('2026-10-02T09:00:00.000Z', NOW)).toBe('today');
    expect(dayLabel('2026-10-01T09:00:00.000Z', NOW)).toBe('yesterday');
    expect(dayLabel('2026-09-28T09:00:00.000Z', NOW)).toMatch(/^28 Sep/);
    expect(dayLabel('not a date', NOW)).toBe('earlier');
  });
});
