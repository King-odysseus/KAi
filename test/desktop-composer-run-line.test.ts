import { describe, expect, it } from 'vitest';
import type { AutoStatus, AutopilotStatus } from '@kai/contracts';
import { composerRunLine } from '../apps/desktop/src/renderer/src/components/ComposerRunLine';

/**
 * The composer's one line about the run that owns it.
 *
 * The wording and the colour are the whole feature — one sentence to read and a border to glance at — so they are
 * derived by a plain function of the two statuses and tested here, without a DOM. The renderer has no component test
 * harness; this file is the same shape as `desktop-composer-intent`.
 */

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

function autopilot(overrides: Partial<AutopilotStatus> = {}): AutopilotStatus {
  return {
    projectId: 'p1', phase: 'working', message: 'Working on "Pricing page".', cardId: 'pricing', cardTitle: 'Pricing page',
    conversationId: 'c1', attempt: 1, resumeAt: null, restReason: null, restStreak: 0, restsTotal: 0,
    cardsDone: 3, cardsBlocked: 0, cardsTotal: 52, cardsWorked: 4, costUsd: 0,
    startedAt: '2026-10-04T11:00:00.000Z', updatedAt: '2026-10-04T12:00:00.000Z', log: [],
    ...overrides,
  };
}

function auto(overrides: Partial<AutoStatus> = {}): AutoStatus {
  return {
    conversationId: 'c1', projectId: 'p1', phase: 'working', message: 'Working on the failing test.', turnCount: 4, maxTurns: 40,
    checkCommand: 'npm test', checkStatus: 'unknown', activeProvider: 'api', fallbackProvider: null,
    cliResumeAt: null, resumeAt: null, restReason: null, waitReason: null, waitDetail: null, splitCount: 0, costUsd: 0,
    startedAt: '2026-10-04T11:00:00.000Z', updatedAt: '2026-10-04T12:00:00.000Z', log: [],
    ...overrides,
  };
}

describe('composer run line', () => {
  it('says nothing at all when no run owns the composer', () => {
    expect(composerRunLine(null, null)).toBeNull();
    // A run that has settled is not owning anything either; its ending is reported where it happened, not here.
    expect(composerRunLine(autopilot({ phase: 'finished' }), null)).toBeNull();
    expect(composerRunLine(autopilot({ phase: 'stopped' }), null)).toBeNull();
    expect(composerRunLine(null, auto({ phase: 'finished' }))).toBeNull();
  });

  it('shows Autopilot working the board as a live, stoppable red line', () => {
    const line = composerRunLine(autopilot(), null, NOW)!;
    expect(line.who).toBe('autopilot');
    expect(line.state).toBe('live');
    expect(line.lead).toBe('Autopilot is on');
    expect(line.detail).toBe('Working on "Pricing page".');
    expect(line.meta).toBe('3 of 52 cards done');
    expect(line.canStop).toBe(true);
  });

  it('turns amber and counts down while Autopilot rests on a rate limit', () => {
    const resumeAt = new Date(NOW + 12 * 60_000).toISOString();
    const line = composerRunLine(autopilot({ phase: 'cooling', resumeAt, restReason: 'HTTP 429' }), null, NOW)!;
    expect(line.state).toBe('waiting');
    expect(line.detail).toContain('resting until');
    expect(line.detail).toContain('12m');
    // Resting is still running, so it can still be stopped — unlike an ending.
    expect(line.canStop).toBe(true);
  });

  it('leaves a failed Autopilot up to be read, with nothing to stop', () => {
    const line = composerRunLine(autopilot({ phase: 'failed', message: 'Two cards ended with the same error.' }), null, NOW)!;
    expect(line.state).toBe('failed');
    expect(line.lead).toBe('Autopilot stopped');
    expect(line.detail).toBe('Two cards ended with the same error.');
    expect(line.canStop).toBe(false);
  });

  it('shows Auto by its turns, and parks it in amber when it is waiting on a person', () => {
    expect(composerRunLine(null, auto(), NOW)).toMatchObject({ who: 'auto', state: 'live', lead: 'Auto is on', meta: 'turn 4 of 40' });
    expect(composerRunLine(null, auto({ turnCount: 0 }), NOW)).toMatchObject({ meta: 'starting' });
    expect(composerRunLine(null, auto({ phase: 'waiting-for-you', waitReason: 'cost-cap' }), NOW)).toMatchObject({ state: 'waiting', canStop: true });
    expect(composerRunLine(null, auto({ phase: 'cooling', resumeAt: new Date(NOW + 90_000).toISOString() }), NOW)).toMatchObject({ state: 'waiting', canStop: true });
    expect(composerRunLine(null, auto({ phase: 'failed', message: 'The check kept failing.' }), NOW)).toMatchObject({ state: 'failed', canStop: false });
  });

  it('counts an uncapped Auto run in turns rather than a fraction nobody set', () => {
    expect(composerRunLine(null, auto({ maxTurns: 0, turnCount: 7 }), NOW)?.meta).toBe('turn 7');
  });

  it('speaks for Autopilot when a conversation has both, since the Auto session beside it is about other work', () => {
    const line = composerRunLine(autopilot(), auto(), NOW)!;
    expect(line.who).toBe('autopilot');
  });
});
