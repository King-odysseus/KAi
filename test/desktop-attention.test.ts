import { describe, expect, it } from 'vitest';
import { studioAttention, type AttentionCard, type StudioAttentionInput } from '../packages/contracts/src';

/**
 * The "needs you" rules.
 *
 * Pure, like the guide's step rules, so the priority order can be argued about here rather than discovered by
 * watching a board. Every case names what the person is told and what they are offered, because a rule that picks the
 * right situation but the wrong button is just as stuck as one that picks the wrong situation.
 */

function card(overrides: Partial<AttentionCard> = {}): AttentionCard {
  return {
    id: 'c1',
    title: 'Card',
    kind: 'backend',
    status: 'backlog',
    notes: '',
    movedBy: null,
    route: '',
    needsArtifacts: [],
    stale: false,
    ...overrides,
  };
}

function input(overrides: Partial<StudioAttentionInput> = {}): StudioAttentionInput {
  return {
    cards: [],
    writtenArtifacts: [],
    designPages: 0,
    steps: [],
    run: null,
    now: Date.parse('2026-10-05T14:20:00Z'),
    ...overrides,
  };
}

const parked = (overrides: Partial<AttentionCard> = {}): AttentionCard =>
  card({ status: 'blocked', movedBy: 'agent', notes: 'Autopilot gave up after 3 attempts. The check `npm test` failed.', ...overrides });

describe('studioAttention', () => {
  it('says nothing at all when nothing is being asked of anyone', () => {
    expect(studioAttention(input({ cards: [card({ status: 'ready' })] }))).toBeNull();
  });

  it('reads a rest as waiting, not as stuck, and asks for nothing', () => {
    const said = studioAttention(input({
      cards: [parked()],
      run: { phase: 'cooling', message: 'Resting.', resumeAt: '2026-10-05T16:00:00Z', restReason: 'Rate limited.', devCheck: null },
    }));
    expect(said?.tone).toBe('waiting');
    expect(said?.action).toBeNull();
    expect(said?.detail).toContain('Nothing is needed from you.');
  });

  it('offers to put back the cards a stopped run left parked', () => {
    const said = studioAttention(input({
      cards: [parked(), parked({ id: 'c2' })],
      run: { phase: 'stopped', message: 'Autopilot was stopped.', resumeAt: null, restReason: null, devCheck: null },
    }));
    expect(said?.tone).toBe('needs-you');
    expect(said?.action).toBe('requeue-blocked');
    expect(said?.cardIds).toEqual(['c1', 'c2']);
  });

  it('points at the design, not the queue, when the design is what the parked cards are waiting on', () => {
    // Putting these cards back without saying the design is missing would send the person round the same loop twice.
    const said = studioAttention(input({
      cards: [parked({ notes: 'tokens were never written, so the card could not be built.' })],
    }));
    expect(said?.action).toBe('open-design');
  });

  it('names screens with no route before anything else that is movable', () => {
    const said = studioAttention(input({
      cards: [parked(), card({ id: 'page', kind: 'page', status: 'ready', route: '  ' })],
    }));
    expect(said?.action).toBe('repair-routes');
    expect(said?.headline).toContain('no route');
    expect(said?.cardIds).toEqual(['page']);
  });

  it('treats a design document a card reads but does not have as a provisional look, not a stop', () => {
    const said = studioAttention(input({
      cards: [card({ id: 'page', kind: 'page', status: 'ready', route: '/pricing', needsArtifacts: ['tokens'] })],
      writtenArtifacts: [],
      designPages: 3,
    }));
    // Amber, not red: the cards are still being built, so this is worth a hand rather than a stall.
    expect(said?.tone).toBe('waiting');
    expect(said?.action).toBe('open-design');
    expect(said?.detail).toContain('still being built');
  });

  it('says nothing about the design once the artifact is there and nothing is stale', () => {
    const said = studioAttention(input({
      cards: [card({ id: 'page', kind: 'page', status: 'ready', route: '/pricing', needsArtifacts: ['tokens'] })],
      writtenArtifacts: ['tokens'],
      designPages: 3,
    }));
    expect(said).toBeNull();
  });

  it('falls back to the guide’s own stuck step, so the two never disagree', () => {
    const said = studioAttention(input({
      cards: [card({ status: 'ready' })],
      steps: [{ id: 'questions', state: 'blocked', title: 'Answer the questions', detail: '2 waiting for you.', action: null, actionLabel: null }],
    }));
    expect(said?.headline).toBe('Answer the questions');
    expect(said?.detail).toBe('2 waiting for you.');
  });

  it('names the failing route when the app did not come up, and says nothing was deployed', () => {
    const said = studioAttention(input({
      cards: [card({ status: 'done' })],
      run: {
        phase: 'finished',
        message: 'Everything is built.',
        resumeAt: null,
        restReason: null,
        devCheck: { passed: false, summary: 'The app does not run cleanly on dev: / — rendered nothing.', url: null },
      },
    }));
    expect(said?.tone).toBe('needs-you');
    expect(said?.headline).toContain('does not run');
    expect(said?.detail).toContain('Nothing has been committed or deployed');
  });

  it('says the app is running on dev when everything is done and it came up', () => {
    const said = studioAttention(input({
      cards: [card({ status: 'done' }), card({ id: 'c2', status: 'done' })],
      run: {
        phase: 'finished',
        message: 'Everything is built. The app runs on dev at http://localhost:5173.',
        resumeAt: null,
        restReason: null,
        devCheck: { passed: true, summary: 'The app runs on dev at http://localhost:5173.', url: 'http://localhost:5173' },
      },
    }));
    expect(said?.tone).toBe('done');
    expect(said?.action).toBeNull();
    expect(said?.detail).toContain('http://localhost:5173');
    expect(said?.detail).toContain('Nothing has been committed or deployed');
  });

  it('does not claim a live app when the cards were finished without a dev proof', () => {
    const said = studioAttention(input({ cards: [card({ status: 'done' })] }));
    expect(said?.tone).toBe('done');
    expect(said?.detail).toContain('Start Autopilot to confirm');
  });
});
