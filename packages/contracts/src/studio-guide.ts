import { z } from 'zod';

/**
 * The Senior Dev: the Studio's guide for someone doing this for the first time.
 *
 * Two things are kept apart on purpose, and the split is the whole design.
 *
 * **What to do next is decided by rules, not by a model.** `guideSteps` reads the same facts the board, the artifacts
 * and the design already hold and says which step the project is on and what to press. It is free, instant, and it
 * cannot be wrong about the project — where a model call would be a round trip that could be.
 *
 * **The words are the model's.** One call explains the step in plain language, for someone who has not built a
 * project this way before, and it is cached until the step or the situation actually changes. That is the part worth
 * paying for: not knowing which card moved, but knowing why it matters.
 *
 * The run doctor reached the same conclusion for the same reason — a diagnosis that costs a round trip and may be
 * wrong is worse than none — so a screen is not reading.
 */

/**
 * Every step the guide knows, in the order a project meets them.
 *
 * `design` is the one that does not apply to every project — a service with no screens never meets it, and the rules
 * leave it out rather than showing a step that can never be done. The rest are met by everything, even if only to be
 * passed through in a moment.
 */
export const GUIDE_STEP_IDS = [
  'describe',
  'questions',
  'brief',
  'artifacts',
  'board',
  'design',
  'work',
  'finish',
] as const;
export const guideStepIdSchema = z.enum(GUIDE_STEP_IDS);
export type GuideStepId = z.infer<typeof guideStepIdSchema>;

/**
 * `done` is behind you, `current` is where you are, `blocked` is where you are *and it needs you*, `todo` is ahead.
 * `blocked` is deliberately not an exception to `current`: the step you are on can be the step that is stuck.
 */
export const guideStepStateSchema = z.enum(['done', 'current', 'todo', 'blocked']);
export type GuideStepState = z.infer<typeof guideStepStateSchema>;

/**
 * The things the guide can do for the reader. Each one is an existing Studio operation, named here so the renderer
 * has one list to switch on — a step that says "press Build the board" and a button that presses it are the same act.
 */
export const guideActionSchema = z.enum([
  'write-artifacts',
  'build-board',
  'pull-design',
  'draw-screens',
  'run-autopilot',
  'requeue-blocked',
  'open-board',
  'open-design',
]);
export type GuideAction = z.infer<typeof guideActionSchema>;

export const studioGuideStepSchema = z
  .object({
    id: guideStepIdSchema,
    /** Says what the step is, not what it is called. */
    title: z.string().min(1).max(120),
    /** Why this step exists, in one line, for someone who has not done it before. */
    why: z.string().min(1).max(400),
    state: guideStepStateSchema,
    /** What this project shows for this step right now, so the guide is about the work and not about the screen. */
    detail: z.string().max(600),
    /** The one thing to press, when the Studio can press it. Null when the step is the reader's own to do. */
    action: guideActionSchema.nullable().default(null),
    actionLabel: z.string().max(60).nullable().default(null),
  })
  .strict();
export type StudioGuideStep = z.infer<typeof studioGuideStepSchema>;

/** The model's reply: the explanation alone. The steps themselves are never the model's to decide. */
export const studioGuideNarrativeSchema = z
  .object({
    headline: z.string().min(1).max(200),
    explanation: z.string().min(1).max(3_000),
  })
  .strict();
export type StudioGuideNarrative = z.infer<typeof studioGuideNarrativeSchema>;

/** One line of "what has been done", written when a step is first seen as passed. */
export const guideMilestoneSchema = z
  .object({ at: z.string().min(1), stepId: guideStepIdSchema, title: z.string().min(1).max(200) })
  .strict();
export type GuideMilestone = z.infer<typeof guideMilestoneSchema>;

/**
 * What the guide remembers, on disk beside the rest of the project's spec.
 *
 * The board already remembers every card it moved, so nothing here repeats it. What is not recorded anywhere else is
 * the narrative — the model's own account of where the project stands — and the milestones, which mark when a step
 * was first passed rather than when a card last moved.
 */
export const studioGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    history: z.array(guideMilestoneSchema).max(200).default([]),
    /** The model's own account of where the project stands, kept so it is not paid for again on every look. */
    narrative: studioGuideNarrativeSchema.nullable().default(null),
    /**
     * The situation the narrative was written for. When this stops matching, the narrative is stale and is rewritten
     * on the next look — which is what keeps a run of ten card moves from costing ten model calls.
     */
    narrativeFor: z.string().max(200).default(''),
    narrativeAt: z.string().nullable().default(null),
  })
  .strict();
export type StudioGuide = z.infer<typeof studioGuideSchema>;

export function createStudioGuide(): StudioGuide {
  return { schemaVersion: 1, history: [], narrative: null, narrativeFor: '', narrativeAt: null };
}

/** Everything the guide has to say about one project: the steps, and the words that go with them. */
export const studioGuideViewSchema = z
  .object({
    steps: z.array(studioGuideStepSchema),
    history: z.array(guideMilestoneSchema),
    /** The current step's id, so the screen and the board strip agree on where the project is. */
    currentStepId: guideStepIdSchema,
    narrative: studioGuideNarrativeSchema.nullable(),
    narrativeAt: z.string().nullable(),
  })
  .strict();
export type StudioGuideView = z.infer<typeof studioGuideViewSchema>;
