import {
  createStudioGuide,
  studioGuideSchema,
  studioGuideStepSchema,
  type BoardCard,
  type StudioGuide,
  type StudioGuideNarrative,
  type StudioGuideStep,
  type StudioGuideView,
} from '@kai/contracts';
import * as core from './guide-core';

/**
 * The Senior Dev: what to do next, decided by rules.
 *
 * Every judgement on this screen is made from facts the project already holds — the interview, the artifacts, the
 * board, the design — so it is free, instant, and cannot be wrong about the project. The model is asked only for the
 * words, in `guideNarrativePrompt`, and never for the next step. See the note in `@kai/contracts/studio-guide` for
 * why the two are kept apart.
 *
 * This file deliberately has no ports and no IO. It is a function from a description of the project to a list of
 * steps, which is what makes it testable without a board, a disk, or a provider.
 */

export const STUDIO_GUIDE_PATH = 'guide.json';

/** What the guide is told about one project. Gathered by the caller, never fetched from here. */
export interface GuideFacts {
  /** Empty before anything has been described. */
  idea: string;
  interview: { started: boolean; done: boolean; openQuestions: number };
  artifacts: { brief: boolean; written: number; total: number; stale: number };
  /** Pages the design holds, and how many of them have a card on the board already. */
  design: { pages: number; drawn: number };
  board: {
    total: number;
    backlog: number;
    ready: number;
    inProgress: number;
    review: number;
    done: number;
    blocked: number;
    /** Blocked cards a machine parked, which "put them back in the queue" can move. */
    parked: number;
    /** Screen cards that cannot pass a check because nothing says where they live. */
    noRoute: number;
    /** Screen cards on the board at all, which is what makes the design step apply. */
    screens: number;
  };
}

/** Reads a board and says which of its blocked cards a button may put back. Mirrors the board's own rule. */
export function countableForFacts(board: { cards: readonly BoardCard[] }): Pick<GuideFacts['board'], 'parked' | 'noRoute' | 'screens'> {
  const isScreen = (card: BoardCard): boolean => card.kind === 'component' || card.kind === 'page';
  return {
    parked: board.cards.filter((card) => card.status === 'blocked' && card.movedBy !== 'user').length,
    noRoute: board.cards.filter((card) => card.kind === 'page' && !card.route.trim()).length,
    screens: board.cards.filter(isScreen).length,
  };
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`);

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * The steps this project actually has, in order, each carrying the one thing to press.
 *
 * The first step that is not done becomes `current`, unless it is also waiting on the reader — a board with cards
 * parked by an agent is not merely "in progress", it is stuck on a person — in which case it is `blocked`. Everything
 * before it is `done`, everything after is `todo`. A step with no action is the reader's own to do, which is why the
 * action is nullable rather than every step growing a button that does nothing.
 */
export function guideSteps(facts: GuideFacts): StudioGuideStep[] {
  const { board } = facts;
  const allBuilt = board.total > 0 && board.done === board.total;
  const raw: Array<Omit<StudioGuideStep, 'state'> & { done: boolean; needsYou: boolean }> = [
    {
      id: 'describe',
      title: 'Say what you want built',
      why: 'Everything below is derived from this, so it is the one part only you can do.',
      detail: facts.idea.trim() ? `Started from: “${clip(facts.idea.trim(), 160)}”` : 'Nothing described yet.',
      action: null,
      actionLabel: null,
      done: facts.interview.started,
      needsYou: false,
    },
    {
      id: 'questions',
      title: 'Answer the questions',
      why: 'KAI asks what it cannot infer, so the plan is not built on guesses.',
      detail: facts.interview.done
        ? 'Answered. The brief was written from your answers.'
        : facts.interview.openQuestions > 0
          ? `${plural(facts.interview.openQuestions, 'question')} waiting for you on the Interview tab.`
          : 'Waiting for the first round of questions.',
      action: null,
      actionLabel: null,
      done: facts.interview.done,
      needsYou: !facts.interview.done && facts.interview.openQuestions > 0,
    },
    {
      id: 'brief',
      title: 'Write the brief',
      why: 'The brief is the source every artifact and every card is built from.',
      detail: facts.artifacts.brief ? 'Written. It is a normal file you can edit by hand.' : 'Not written yet.',
      action: null,
      actionLabel: null,
      done: facts.artifacts.brief,
      needsYou: false,
    },
    {
      id: 'artifacts',
      title: 'Write the plan documents',
      why: 'The spec, the stories and the data model, so the work is described before it is done.',
      detail: facts.artifacts.total === 0
        ? 'Nothing to write yet.'
        : facts.artifacts.written >= facts.artifacts.total
          ? `All ${facts.artifacts.total} written${facts.artifacts.stale > 0 ? `, ${facts.artifacts.stale} now out of date` : ''}.`
          : `${facts.artifacts.written} of ${facts.artifacts.total} written${facts.artifacts.stale > 0 ? `, ${facts.artifacts.stale} out of date` : ''}.`,
      action: 'write-artifacts',
      actionLabel: 'Write the rest',
      done: facts.artifacts.total > 0 && facts.artifacts.written >= facts.artifacts.total,
      needsYou: false,
    },
    {
      id: 'board',
      title: 'Break the work into cards',
      why: 'Each card is one agent’s job with its own check, so progress is visible and provable.',
      detail: board.total > 0
        ? `${plural(board.total, 'card')} on the board.`
        : 'The board is empty.',
      action: 'build-board',
      actionLabel: board.total > 0 ? 'Rebuild the board' : 'Build the board',
      done: board.total > 0,
      needsYou: false,
    },
    {
      id: 'design',
      title: 'Draw the screens',
      why: 'The screens a person sees are drawn first, so the cards are built against the design rather than guessed.',
      detail: facts.design.pages === 0
        ? 'Nothing drawn yet.'
        : `${facts.design.drawn} of ${facts.design.pages} screen${facts.design.pages === 1 ? '' : 's'} on the board.`,
      action: 'pull-design',
      actionLabel: 'Pull the design',
      done: facts.design.pages > 0 && facts.design.drawn >= facts.design.pages,
      needsYou: false,
    },
    {
      id: 'work',
      title: 'Build the cards',
      why: 'Autopilot runs one agent per card and only closes a card whose check passes.',
      detail: workDetail(facts),
      action: workAction(facts),
      actionLabel: workActionLabel(facts),
      done: allBuilt,
      // Cards parked by an agent, and screen cards with nowhere to point, are both work that stops until a person
      // acts. That is the whole reason this step can be `blocked` rather than `current`.
      needsYou: board.parked > 0 || board.noRoute > 0,
    },
    {
      id: 'finish',
      title: 'Everything is built',
      why: 'Every card has passed its check, and every screen has a passing look at it.',
      detail: allBuilt ? 'Nothing left on the board.' : `Waiting on ${plural(board.total - board.done, 'card')}.`,
      action: null,
      actionLabel: null,
      done: allBuilt,
      needsYou: false,
    },
  ];

  // A project with no screens never meets the design step, so it is left out rather than shown greyed out forever.
  const applicable = raw.filter((step) => step.id !== 'design' || board.screens > 0 || facts.design.pages > 0);
  const currentIndex = applicable.findIndex((step) => !step.done);
  return applicable.map((step, index) => {
    const state = step.done
      ? 'done'
      : index === currentIndex
        ? (step.needsYou ? 'blocked' : 'current')
        : 'todo';
    const { done: _done, needsYou: _needsYou, ...rest } = step;
    return studioGuideStepSchema.parse({ ...rest, state });
  });
}

function workDetail(facts: GuideFacts): string {
  const { board } = facts;
  if (board.total === 0) return 'Nothing to build yet.';
  if (board.done === board.total) return 'Every card is done.';
  const parts = [`${board.done} of ${board.total} done`];
  if (board.noRoute > 0) parts.push(`${plural(board.noRoute, 'screen card has', 'screen cards have')} no route, so they can never be checked`);
  if (board.parked > 0) parts.push(`${board.parked} parked by an agent`);
  if (board.review > 0) parts.push(`${board.review} waiting for you to look at`);
  const waiting = board.backlog + board.ready;
  if (waiting > 0 && board.blocked === 0) parts.push(`${waiting} waiting to be worked`);
  if (board.blocked > 0) parts.push(`${board.blocked} blocked`);
  return `${parts.join(', ')}.`;
}

/**
 * The one thing to press on the work step.
 *
 * Ordered by what actually unsticks the board. A screen card with no route is first because nothing else can move
 * while it exists: it holds every card behind it and no amount of running will close it. Parked cards come second —
 * they are the other way a board reaches zero ready. Only then is starting a run worth offering.
 */
function workAction(facts: GuideFacts): StudioGuideStep['action'] {
  const { board } = facts;
  if (board.done === board.total && board.total > 0) return null;
  if (board.noRoute > 0) return 'open-board';
  if (board.parked > 0) return 'requeue-blocked';
  if (board.ready > 0 || board.inProgress > 0) return 'run-autopilot';
  if (board.review > 0) return 'open-board';
  return null;
}

function workActionLabel(facts: GuideFacts): string | null {
  const { board } = facts;
  if (board.done === board.total && board.total > 0) return null;
  if (board.noRoute > 0) return 'Set the routes on the board';
  if (board.parked > 0) return 'Put them back in the queue';
  if (board.ready > 0 || board.inProgress > 0) return 'Start Autopilot';
  if (board.review > 0) return 'Look at what is in review';
  return null;
}

/**
 * The situation the explanation was written for.
 *
 * Deliberately coarse. A narrative that is rewritten every time a card moves costs a model call per card and says
 * almost the same thing; keyed on the step and on the things that need a person, it is rewritten when the guide
 * genuinely has something new to say. Card counts that move on their own are left out for that reason.
 */
export function guideStateKey(steps: readonly StudioGuideStep[], facts: GuideFacts): string {
  const current = steps.find((step) => step.state === 'current' || step.state === 'blocked');
  return [
    current?.id ?? 'none',
    current?.state ?? '',
    `parked:${facts.board.parked > 0}`,
    `noRoute:${facts.board.noRoute > 0}`,
    `review:${facts.board.review > 0}`,
    `stale:${facts.artifacts.stale > 0}`,
  ].join('|');
}

/**
 * Folds the steps into what the guide remembers, and says whether the explanation needs rewriting.
 *
 * The remembering itself is shared with the Code guide — see `guide-core`, which is where the two rules that are
 * easy to get wrong (record a milestone once, keep an explanation only while it fits) actually live. These three
 * keep their names and signatures so the screen and the tests read the same as before.
 */
export function recordProgress(
  guide: StudioGuide,
  steps: readonly StudioGuideStep[],
  at: string,
): { guide: StudioGuide; changed: boolean } {
  return core.recordProgress(guide, steps, at, (next) => studioGuideSchema.parse(next));
}

/**
 * Assembles the view the screen renders, offering the cached narrative only while it still fits the situation.
 *
 * The stored text is returned as it was written. The key decides one thing only: whether this is still the right
 * explanation for what is on screen — and what makes this guide's situations is `guideStateKey` below, not the
 * shared code, which knows nothing about boards or artifacts.
 */
export function guideView(guide: StudioGuide, steps: readonly StudioGuideStep[], facts: GuideFacts): StudioGuideView {
  return core.guideView(guide, steps, guideStateKey(steps, facts));
}

/** Files an explanation against the situation it was written for, so the next look can tell whether it still fits. */
export function keepNarrative(guide: StudioGuide, narrative: StudioGuideNarrative, key: string, at: string): StudioGuide {
  return core.keepNarrative(guide, narrative, key, at, (next) => studioGuideSchema.parse(next));
}

export function emptyGuide(): StudioGuide {
  return createStudioGuide();
}

/**
 * The one prompt the guide sends: explain where this project is, to someone who has not built one before.
 *
 * The steps arrive already decided, and the model is told plainly that they are not its to change — a guide that
 * decided its own next step could contradict the button underneath it. What it is for is the part rules cannot do:
 * saying why, in plain words, and naming the single next thing in the same breath.
 */
export function guideNarrativePrompt(facts: GuideFacts, steps: readonly StudioGuideStep[], history: readonly { title: string }[]): { system: string; user: string } {
  const system = [
    'You are a senior developer sitting beside someone who has never built a project this way, in a tool called KAI.',
    'You are given the current step of their project, decided in advance. Explain it; do not re-decide it, do not',
    'suggest a different order, and never tell them to do two things at once. Name the one next action, in the same',
    'words as the step, and say what it will do and roughly what happens after it.',
    '',
    'Write for a beginner: short sentences, no jargon without a plain gloss, no praise, no filler. Two or three',
    'paragraphs at most. If something is stuck, say what it is stuck on and that it is not their mistake. If they are',
    'on the last step, say so and stop.',
    '',
    'Reply with JSON only: {"headline": "...", "explanation": "..."}. The headline is one short line naming where they',
    'are. The explanation is the walkthrough.',
  ].join(' ');
  const board = facts.board;
  const user = [
    `STEPS (already decided, in order):\n${steps.map((step) => `- [${step.state}] ${step.title} — ${step.detail}`).join('\n')}`,
    '',
    `WHAT HAS BEEN DONE SO FAR:\n${history.length > 0 ? history.map((entry) => `- ${entry.title}`).join('\n') : '- Nothing yet.'}`,
    '',
    `THE BOARD: ${board.total} cards — ${board.done} done, ${board.blocked} blocked, ${board.review} in review, ${board.ready} ready, ${board.backlog} waiting.`,
    board.parked > 0 ? `${board.parked} of those blocked cards were parked by an agent and can be put back in the queue.` : '',
    board.noRoute > 0 ? `${board.noRoute} screen cards have no route, so they can never pass a screen check; a person has to give them one.` : '',
    '',
    'Write the headline and the explanation.',
  ].filter(Boolean).join('\n');
  return { system, user };
}
