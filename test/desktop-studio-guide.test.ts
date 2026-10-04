import { describe, expect, it } from 'vitest';
import { boardCardSchema, createStudioGuide } from '../packages/contracts/src';
import {
  countableForFacts,
  guideNarrativePrompt,
  guideStateKey,
  guideSteps,
  guideView,
  keepNarrative,
  recordProgress,
  type GuideFacts,
} from '../apps/desktop/src/main/studio-guide';

const NOW = '2026-10-04T12:00:00.000Z';

/** A project that has not started, so each test only states the one thing it is about. */
function facts(over: Partial<GuideFacts> = {}, board: Partial<GuideFacts['board']> = {}): GuideFacts {
  return {
    idea: '',
    interview: { started: false, done: false, openQuestions: 0 },
    artifacts: { brief: false, written: 0, total: 0, stale: 0 },
    design: { pages: 0, drawn: 0 },
    board: { total: 0, backlog: 0, ready: 0, inProgress: 0, review: 0, done: 0, blocked: 0, parked: 0, noRoute: 0, screens: 0, ...board },
    ...over,
  };
}

/**
 * A project that has passed everything up to and including the board, so a test about a late step does not have to
 * restate the four steps before it.
 */
function onBoard(board: Partial<GuideFacts['board']> = {}, over: Partial<GuideFacts> = {}): GuideFacts {
  return facts({
    idea: 'A booking site for a two-chair barber shop',
    interview: { started: true, done: true, openQuestions: 0 },
    artifacts: { brief: true, written: 4, total: 4, stale: 0 },
    ...over,
  }, { total: 10, ...board });
}

function card(over: Record<string, unknown> = {}) {
  return boardCardSchema.parse({ id: 'c1', title: 'Sign up', kind: 'backend', createdAt: NOW, updatedAt: NOW, ...over });
}

const idOf = (steps: ReturnType<typeof guideSteps>): string | undefined =>
  steps.find((step) => step.state === 'current' || step.state === 'blocked')?.id;

describe('the studio guide decides by rules', () => {
  it('starts a project at the one step only the reader can do', () => {
    const steps = guideSteps(facts());

    expect(idOf(steps)).toBe('describe');
    expect(steps.every((step) => step.state === 'todo' || step.state === 'current')).toBe(true);
    // Nothing to press: describing the project happens in the interview composer.
    expect(steps[0]?.action).toBeNull();
  });

  it('walks the steps forward as the project passes them', () => {
    const described = guideSteps(facts({ idea: 'A booking site', interview: { started: true, done: false, openQuestions: 0 } }));
    expect(idOf(described)).toBe('questions');
    expect(described[0]?.state).toBe('done');

    const answered = guideSteps(facts({ idea: 'A booking site', interview: { started: true, done: true, openQuestions: 0 } }));
    expect(idOf(answered)).toBe('brief');

    const briefed = guideSteps(facts({
      interview: { started: true, done: true, openQuestions: 0 },
      artifacts: { brief: true, written: 1, total: 4, stale: 0 },
    }));
    expect(idOf(briefed)).toBe('artifacts');
    expect(briefed.find((step) => step.id === 'artifacts')?.action).toBe('write-artifacts');

    const written = guideSteps(facts({
      idea: 'A booking site',
      interview: { started: true, done: true, openQuestions: 0 },
      artifacts: { brief: true, written: 4, total: 4, stale: 0 },
    }));
    expect(idOf(written)).toBe('board');
    expect(written.find((step) => step.id === 'board')?.action).toBe('build-board');
  });

  it('leaves the design step out of a project with no screens', () => {
    const backend = guideSteps(onBoard({ screens: 0 }));

    expect(idOf(backend)).toBe('work');
    expect(backend.map((step) => step.id)).not.toContain('design');
  });

  it('shows the design step once a project has screens on the board', () => {
    const withScreens = guideSteps(onBoard({ screens: 2 }));

    expect(idOf(withScreens)).toBe('design');
    expect(withScreens.find((step) => step.id === 'design')?.action).toBe('pull-design');
  });

  it('says a board is stuck, not merely in progress, when cards are parked', () => {
    const steps = guideSteps(onBoard({ total: 46, done: 6, blocked: 6, parked: 6, backlog: 34 }));
    const work = steps.find((step) => step.id === 'work');

    // `blocked` is not an exception to `current`: the step you are on can be the one that is stuck.
    expect(work?.state).toBe('blocked');
    expect(work?.action).toBe('requeue-blocked');
    expect(work?.actionLabel).toBe('Put them back in the queue');
    expect(work?.detail).toContain('6 parked by an agent');
  });

  it('puts a route-less screen card ahead of everything else, because nothing else can move', () => {
    // A screen card with no route can never pass its check, so it gates every card behind it however often a run is
    // started. Offering "put them back in the queue" first would send the reader round the same loop again.
    const steps = guideSteps(onBoard(
      { total: 10, done: 6, blocked: 3, parked: 3, noRoute: 2, screens: 2 },
      // The design is drawn, so the design step is behind us and the board is the step we are actually on.
      { design: { pages: 2, drawn: 2 } },
    ));
    const work = steps.find((step) => step.id === 'work');

    expect(work?.state).toBe('blocked');
    expect(work?.action).toBe('open-board');
    expect(work?.actionLabel).toBe('Set the routes on the board');
    expect(work?.detail).toContain('no route');
  });

  it('offers a run only when a run could actually work something', () => {
    const readyToRun = guideSteps(onBoard({ ready: 4, backlog: 6 }));
    expect(readyToRun.find((step) => step.id === 'work')?.state).toBe('current');
    expect(readyToRun.find((step) => step.id === 'work')?.action).toBe('run-autopilot');

    // Everything waiting on something else: starting a run would finish immediately having done nothing.
    const waiting = guideSteps(onBoard({ backlog: 10 }));
    expect(waiting.find((step) => step.id === 'work')?.action).toBeNull();
  });

  it('leaves every step done when the whole board is done', () => {
    const finished = onBoard({ total: 6, done: 6 });
    const steps = guideSteps(finished);

    expect(steps.every((step) => step.state === 'done')).toBe(true);
    expect(guideView(createStudioGuide(), steps, finished).currentStepId).toBe('finish');
  });

  it('counts what a button could actually put back, and what needs a person', () => {
    const board = {
      cards: [
        card({ id: 'parked', status: 'blocked', movedBy: 'agent' }),
        // A card a person blocked is theirs to keep blocked.
        card({ id: 'mine', status: 'blocked', movedBy: 'user' }),
        card({ id: 'old', status: 'blocked', movedBy: null, notes: 'Autopilot gave up after 3 attempts.' }),
        card({ id: 'screen', kind: 'page', route: '' }),
        card({ id: 'routed', kind: 'page', route: '/pricing' }),
      ],
    };

    expect(countableForFacts(board)).toEqual({ parked: 2, noRoute: 1, screens: 2 });
  });
});

describe('what the guide remembers', () => {
  it('records a step once, the first time it is finished', () => {
    const steps = guideSteps(facts({ idea: 'A booking site', interview: { started: true, done: true, openQuestions: 0 } }));
    const first = recordProgress(createStudioGuide(), steps, NOW);
    const second = recordProgress(first.guide, steps, '2026-10-05T12:00:00.000Z');

    expect(first.changed).toBe(true);
    expect(first.guide.history.map((entry) => entry.stepId)).toEqual(['describe', 'questions']);
    // Looking again is not progress, so nothing is written the second time.
    expect(second.changed).toBe(false);
    expect(second.guide.history).toHaveLength(2);
  });
});

describe('when the explanation is worth paying for again', () => {
  const base = onBoard({ ready: 4, backlog: 6 });

  it('keeps the words while the situation is the same, even as cards move', () => {
    // Three cards move. The guide has nothing new to say, so the explanation is not rewritten for each of them.
    const moved = onBoard({ ready: 1, done: 3, backlog: 6 });

    expect(guideStateKey(guideSteps(moved), moved)).toBe(guideStateKey(guideSteps(base), base));
  });

  it('rewrites when the step changes or when something starts needing a person', () => {
    const stuck = onBoard({ blocked: 2, parked: 2, ready: 2 });

    expect(guideStateKey(guideSteps(stuck), stuck)).not.toBe(guideStateKey(guideSteps(base), base));
  });

  it('offers the stored explanation only while it still fits', () => {
    const steps = guideSteps(base);
    const kept = keepNarrative(createStudioGuide(), { headline: 'Where you are', explanation: 'Start a run.' }, guideStateKey(steps, base), NOW);
    const stuck = onBoard({ blocked: 1, parked: 1, ready: 3, backlog: 6 });

    expect(guideView(kept, steps, base).narrative?.explanation).toBe('Start a run.');
    // The board has moved on, so the stale explanation is withheld rather than shown beside the wrong step.
    expect(guideView(kept, steps, stuck).narrative).toBeNull();
  });
});

describe('the one prompt the guide sends', () => {
  it('gives the model the decided steps and forbids it from re-deciding them', () => {
    const f = onBoard({ total: 46, done: 6, blocked: 6, parked: 6, backlog: 34 });
    const steps = guideSteps(f);
    const prompt = guideNarrativePrompt(f, steps, [{ title: 'Say what you want built' }]);

    expect(prompt.system).toContain('do not re-decide it');
    expect(prompt.user).toContain('Say what you want built');
    expect(prompt.user).toContain('6 blocked');
    expect(prompt.user).toContain('can be put back in the queue');
  });
});
