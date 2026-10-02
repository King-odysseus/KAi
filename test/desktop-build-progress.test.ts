import { describe, expect, it } from 'vitest';
import { buildProgressSchema, deriveBuildProgress, type BoardCard, type BoardStatus, type StudioBoard } from '@kai/contracts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');

/** Minutes before NOW, so the pace arithmetic reads the way the failure does. */
function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function card(
  id: string,
  status: BoardStatus,
  options: { movedBy?: 'user' | 'agent' | 'check' | null; movedAt?: string | null } = {},
): BoardCard {
  return {
    id, title: `Card ${id}`, kind: 'backend', story: '', acceptance: [], prompt: '', designRef: null, route: '', dependsOn: [],
    needsArtifacts: [], status, checks: [], check: null, runs: [], notes: '', stale: false, staleReason: null, claimedBy: null,
    movedBy: options.movedBy ?? null, movedAt: options.movedAt ?? null,
    createdAt: ago(600), updatedAt: NOW !== undefined ? new Date(NOW).toISOString() : '',
  };
}

/** A board of finished cards 10 minutes apart, so the median pace is exactly 10 minutes. */
function boardWith(finished: number, extra: BoardCard[] = []): StudioBoard {
  const done = Array.from({ length: finished }, (_unused, index) =>
    card(`done-${index}`, 'done', { movedBy: 'agent', movedAt: ago((finished - index) * 10) }));
  return { schemaVersion: 1, cards: [...done, ...extra] };
}

describe('build progress from a board', () => {
  it('counts each status and leaves blocked cards out of the percentage', () => {
    const board = boardWith(5, [
      card('blocked-1', 'blocked'),
      card('blocked-2', 'blocked'),
      card('ready-1', 'ready'),
    ]);

    const progress = deriveBuildProgress({ board, nowMs: NOW });

    expect(progress).toMatchObject({
      cardsTotal: 8,
      cardsDone: 5,
      cardsBlocked: 2,
      cardsInFlight: 0,
      cardsWaiting: 1,
      // 5 of 6 buildable, not 5 of 8: a blocked card can never be finished, so it cannot hold the bar back.
      percent: 83,
    });
  });

  it('names the card Autopilot is on, and which attempt it is', () => {
    const board = boardWith(3, [card('live', 'inProgress')]);

    const progress = deriveBuildProgress({
      board,
      nowMs: NOW,
      autopilot: { phase: 'working', cardId: 'live', cardTitle: 'Card live', attempt: 2, startedAt: ago(40) },
    });

    expect(progress).toMatchObject({
      driver: 'autopilot',
      currentCardId: 'live',
      currentCardTitle: 'Card live',
      currentCardAttempt: 2,
      actor: 'Autopilot',
      elapsedMs: 40 * 60_000,
    });
  });

  it('falls back to the board when nothing is driving it', () => {
    expect(deriveBuildProgress({ board: boardWith(3), nowMs: NOW }).driver).toBe('idle');
    expect(deriveBuildProgress({ board: boardWith(3, [card('live', 'inProgress')]), nowMs: NOW }).driver).toBe('board');
    // A finished Autopilot run is not a live one.
    const stopped = deriveBuildProgress({ board: boardWith(3), nowMs: NOW, autopilot: { phase: 'finished' } });
    expect(stopped.driver).toBe('idle');
  });

  it('offers no guess until enough cards have finished', () => {
    const one = deriveBuildProgress({ board: boardWith(1, [card('ready-1', 'ready')]), nowMs: NOW });
    expect(one.pace).toBeNull();
    expect(one.paceNote).toContain('A pace appears once 2 cards are done.');
  });

  it('guesses from the gaps between finished cards, and gets shorter as cards are done', () => {
    const progress = deriveBuildProgress({ board: boardWith(4, [card('a', 'ready'), card('b', 'ready')]), nowMs: NOW });

    expect(progress.pace).toMatchObject({ observedCards: 4, source: 'board', confidence: 'medium' });
    expect(progress.pace!.msPerCard).toBe(10 * 60_000);
    expect(progress.pace!.cardsRemaining).toBe(2);
    // Two cards left at ten minutes each.
    expect(new Date(progress.pace!.etaAt).getTime() - NOW).toBe(20 * 60_000);

    const further = deriveBuildProgress({ board: boardWith(4, [card('a', 'ready')]), nowMs: NOW });
    expect(new Date(further.pace!.etaAt).getTime()).toBeLessThan(new Date(progress.pace!.etaAt).getTime());
  });

  it('ignores cards a person moved, since the pace being measured is the build\'s', () => {
    const board: StudioBoard = {
      schemaVersion: 1,
      cards: [
        card('mine-1', 'done', { movedBy: 'user', movedAt: ago(300) }),
        card('mine-2', 'done', { movedBy: 'user', movedAt: ago(290) }),
        card('next', 'ready'),
      ],
    };

    const progress = deriveBuildProgress({ board, nowMs: NOW });

    expect(progress.cardsDone).toBe(2);
    expect(progress.pace).toBeNull();
    expect(progress.paceNote).toContain('A pace appears once 2 cards are done.');
  });

  it('calls out a card that has outrun the pace the earlier ones set', () => {
    // Ten-minute cards, with one in flight and untouched for over half an hour.
    const board = boardWith(3, [card('slow', 'inProgress', { movedBy: 'agent', movedAt: ago(45) })]);

    const progress = deriveBuildProgress({ board, nowMs: NOW });

    expect(progress.pace).toMatchObject({ stalled: true, confidence: 'low' });
    expect(progress.paceNote).toContain('taking longer than the ones before it');
  });

  it('measures the live run rather than the whole board when Autopilot is driving', () => {
    const board = boardWith(6, [card('live', 'inProgress')]);

    const progress = deriveBuildProgress({
      board,
      nowMs: NOW,
      // Only the last two finished after the run started, so the run pace is 10 minutes a card, not the board's.
      autopilot: { phase: 'working', cardId: 'live', cardTitle: 'Card live', attempt: 1, startedAt: ago(20) },
    });

    expect(progress.pace).toMatchObject({ source: 'run', observedCards: 2 });
    expect(progress.paceNote).toContain('resting');
  });

  it('says Auto is working a task rather than the board', () => {
    const progress = deriveBuildProgress({
      board: boardWith(3, [card('live', 'inProgress')]),
      nowMs: NOW,
      auto: { phase: 'working', startedAt: ago(30), activeProvider: 'deepseek' },
    });

    expect(progress).toMatchObject({ driver: 'auto', actor: 'deepseek' });
    expect(progress.paceNote).toContain('Auto is working one task, not the board');
  });

  it('mentions the cards held back by blockers and by review', () => {
    const board = boardWith(3, [card('b', 'blocked'), card('r', 'review'), card('ready-1', 'ready')]);
    const progress = deriveBuildProgress({ board, nowMs: NOW });

    expect(progress.paceNote).toContain('1 blocked card is not counted.');
    expect(progress.paceNote).toContain('1 card is in review, waiting on a person.');
    // Neither counts as remaining work for the build.
    expect(progress.pace!.cardsRemaining).toBe(1);
  });

  it('stays valid against its own schema', () => {
    const progress = deriveBuildProgress({ board: boardWith(4, [card('ready-1', 'ready')]), nowMs: NOW });
    expect(buildProgressSchema.parse(progress)).toEqual(progress);
  });
});
