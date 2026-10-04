import { z } from 'zod';
import { guideStepStateSchema } from './studio-guide';

/**
 * The Senior Dev, in the Code environment.
 *
 * Same split as the Studio guide (`./studio-guide`), and for the same reason: the step is decided by rules over facts
 * the project already holds, and the model is asked only for the words. What differs is the vocabulary. Studio's
 * steps read an interview, a catalog of plan documents, a board and a design — none of which a folder of source code
 * has. Asking a code project "what do you want built?" is a question it cannot answer, and a guide that led with it
 * would sit on that step forever.
 *
 * So this is a second, deliberately separate vocabulary rather than a widened one. The two guides write beside each
 * other in `.kai/spec` (`guide.json` and `code-guide.json`), and a folder can be both a Studio plan's linked folder
 * and the project open in Code — so sharing a file would let them overwrite each other's history. Sharing the step id
 * enum would be worse than untidy: `guideMilestoneSchema` parses a stored history against a closed set of ids, so an
 * id from the other guide would fail the parse and be read as an empty history, losing the record silently.
 */

/**
 * The steps this guide knows, in the order a code project meets them.
 *
 * The order is the priority: the first step that is not done is where the project is. It is arranged so that reads
 * as advice rather than as nagging — in particular `clean` sits near the end. An uncommitted working tree is the
 * normal state *while* working, so leading with "commit your changes" would both nag and drag the guide backwards
 * every time a file is edited.
 */
export const CODE_GUIDE_STEP_IDS = [
  'versioned',
  'committed',
  'understood',
  'tested',
  'board',
  'clean',
  'ready',
] as const;
export const codeGuideStepIdSchema = z.enum(CODE_GUIDE_STEP_IDS);
export type CodeGuideStepId = z.infer<typeof codeGuideStepIdSchema>;

/**
 * The things this guide can do for the reader.
 *
 * Deliberately small, and every one of them is navigation or setup rather than work. The guide coaches the parts a
 * person has to do themselves — commit, study, write a test — so it names those and says where they happen instead of
 * offering a button that does them. `init-git` is the exception because a folder with no repository has no Git tab
 * to point at yet, and starting one is a single idempotent act.
 */
export const codeGuideActionSchema = z.enum(['init-git', 'open-learn', 'open-review']);
export type CodeGuideAction = z.infer<typeof codeGuideActionSchema>;

export const codeGuideStepSchema = z
  .object({
    id: codeGuideStepIdSchema,
    /** Says what the step is, not what it is called. */
    title: z.string().min(1).max(120),
    /** Why this step exists, in one line, for someone who has not done it before. */
    why: z.string().min(1).max(400),
    state: guideStepStateSchema,
    /** What this project shows for this step right now, so the guide is about the work and not about the screen. */
    detail: z.string().max(600),
    /** The one thing to press, when there is one. Null when the step is the reader's own to do. */
    action: codeGuideActionSchema.nullable().default(null),
    actionLabel: z.string().max(60).nullable().default(null),
  })
  .strict();
export type CodeGuideStep = z.infer<typeof codeGuideStepSchema>;

/** The model's reply: the explanation alone. The steps themselves are never the model's to decide. */
export const codeGuideNarrativeSchema = z
  .object({
    headline: z.string().min(1).max(200),
    explanation: z.string().min(1).max(3_000),
  })
  .strict();
export type CodeGuideNarrative = z.infer<typeof codeGuideNarrativeSchema>;

/** One line of "what has been done", written when a step is first seen as passed. */
export const codeGuideMilestoneSchema = z
  .object({ at: z.string().min(1), stepId: codeGuideStepIdSchema, title: z.string().min(1).max(200) })
  .strict();
export type CodeGuideMilestone = z.infer<typeof codeGuideMilestoneSchema>;

/**
 * What this guide remembers, on disk beside the Studio guide's own file.
 *
 * Git already remembers every commit, so nothing here repeats it. What is not recorded anywhere else is the
 * narrative and the milestones — when a step was first passed, which is what makes the history readable later.
 */
export const codeGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    history: z.array(codeGuideMilestoneSchema).max(200).default([]),
    /** The model's own account of where the project stands, kept so it is not paid for again on every look. */
    narrative: codeGuideNarrativeSchema.nullable().default(null),
    /** The situation the narrative was written for; when this stops matching, it is rewritten on the next look. */
    narrativeFor: z.string().max(200).default(''),
    narrativeAt: z.string().nullable().default(null),
  })
  .strict();
export type CodeGuide = z.infer<typeof codeGuideSchema>;

export function createCodeGuide(): CodeGuide {
  return { schemaVersion: 1, history: [], narrative: null, narrativeFor: '', narrativeAt: null };
}

/** One top-level directory of a project, as the guide sees it. */
export const codeProjectAreaSchema = z
  .object({
    /** The top-level directory, or `.` for the files that sit at the repository root. */
    path: z.string().min(1).max(200),
    files: z.number().int().nonnegative(),
    /** How many of this area's files look like tests, so the panel can say where the tests live. */
    tests: z.number().int().nonnegative(),
  })
  .strict();
export type CodeProjectArea = z.infer<typeof codeProjectAreaSchema>;

/** One language family, named from the extension of the files that use it. */
export const codeProjectLanguageSchema = z
  .object({ label: z.string().min(1).max(40), files: z.number().int().nonnegative() })
  .strict();
export type CodeProjectLanguage = z.infer<typeof codeProjectLanguageSchema>;

/**
 * What the project is made of, counted from the paths of the files that are actually on disk.
 *
 * This is the "full picture" the step ladder cannot give: the ladder says where the project is in a process, and this
 * says what there is to work on. Every number is a count of real files, and a file is placed by its directory or named
 * by its extension and nothing else. Nothing here guesses that a file is an entry point because of what it is called:
 * the guide's standing rule is that it may be silent but must not be wrong, and "this looks like the entry point" is
 * exactly the claim it refuses to make.
 *
 * Both lists are capped and the smaller tails fall off the end. It is a picture of a project, not an inventory of one
 * — and a hundred rows of directories would be a worse picture than twelve.
 */
export const codeProjectBreakdownSchema = z
  .object({
    /** Every file the tree read returned, which is what the two lists below are counted out of. */
    files: z.number().int().nonnegative(),
    /** Biggest first, so the shape of the project is the first thing read. */
    areas: z.array(codeProjectAreaSchema).max(12),
    /** Biggest first. Extensions with no name in the guide's list are counted in `files` but not listed. */
    languages: z.array(codeProjectLanguageSchema).max(8),
  })
  .strict();
export type CodeProjectBreakdown = z.infer<typeof codeProjectBreakdownSchema>;

/** Everything the guide has to say about one project: the steps, and the words that go with them. */
export const codeGuideViewSchema = z
  .object({
    steps: z.array(codeGuideStepSchema),
    history: z.array(codeGuideMilestoneSchema),
    /** The current step's id, so the panel and the strip agree on where the project is. */
    currentStepId: codeGuideStepIdSchema,
    narrative: codeGuideNarrativeSchema.nullable(),
    narrativeAt: z.string().nullable(),
    /** What the project is made of. Free to read, so it is refreshed on the same schedule as the steps. */
    project: codeProjectBreakdownSchema,
  })
  .strict();
export type CodeGuideView = z.infer<typeof codeGuideViewSchema>;
