import { z } from 'zod';

/**
 * The Project Studio turns one paragraph into the spec files under `.kai/spec`, which the board and the coding
 * agents then work from. The first step is the interview: a short, skippable conversation that closes the gaps in
 * the idea before anything is written down as a requirement.
 *
 * The interview reuses the Prompt Guide's provider connection on purpose. One API key, one model choice, and no
 * second bill: the studio never asks for its own subscription or a hosted service.
 */

/** Questions asked per round, the maximum rounds, and the interview-wide question budget. */
export const STUDIO_QUESTIONS_PER_ROUND = 4;
export const STUDIO_MAX_ROUNDS = 10;
export const STUDIO_MAX_QUESTIONS = 10;
/** A newcomer can ask for more: five at a time, twice, so the interview never passes twenty questions. */
export const STUDIO_EXTRA_QUESTIONS = 5;
export const STUDIO_MAX_EXTENSIONS = 2;
export const STUDIO_QUESTION_CEILING = STUDIO_MAX_QUESTIONS + STUDIO_EXTRA_QUESTIONS * STUDIO_MAX_EXTENSIONS;
/** Each round is one question, asked in its own model call so it can react to the answer before it. */
export const STUDIO_ROUND_QUESTION_LIMITS = Array.from({ length: STUDIO_QUESTION_CEILING }, () => 1) as readonly number[];
/** Suggested answers offered under one question. The user can always type their own instead. */
export const STUDIO_MAX_OPTIONS = 6;
/** How long one suggested answer may be. They are chips beside the answer box, so a paragraph does not fit. */
export const STUDIO_MAX_OPTION_CHARS = 120;

const interviewOptionsSchema = z.array(z.string().trim().min(1).max(STUDIO_MAX_OPTION_CHARS)).max(STUDIO_MAX_OPTIONS);

/**
 * A suggested answer cut down to chip length.
 *
 * The model is told the limit and overshoots it anyway, and one option a character too long used to fail the whole
 * reply — taking the question, the sharpened goal and every assumption with it. A suggestion is worth shortening
 * rather than throwing away, and the recommended one is offered first, so dropping it would be the worse trade.
 * The cut is at a word boundary, so the chip reads as a summary instead of a sentence that stops mid-word.
 */
export function clipOption(option: string): string {
  const collapsed = option.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= STUDIO_MAX_OPTION_CHARS) return collapsed;
  // Room for the ellipsis, which is what keeps the result inside the limit.
  const room = collapsed.slice(0, STUDIO_MAX_OPTION_CHARS - 1);
  const lastSpace = room.lastIndexOf(' ');
  // Only cut at a space if that still leaves most of the option; a very long first word is cut where it falls.
  const cut = lastSpace >= STUDIO_MAX_OPTION_CHARS / 2 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

export const interviewAnswerSchema = z
  .object({
    question: z.string().trim().min(1).max(400),
    // An empty answer means the user skipped the question, which is always allowed.
    // Interview answers are often a short requirements note, not a one-line reply.
    // Keep this aligned with the idea field so a complete v1 scope can be submitted.
    answer: z.string().trim().max(4_000),
  })
  .strict();
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

export const interviewRoundSchema = z
  .object({
    questions: z.array(z.string().trim().min(1).max(400)).max(STUDIO_QUESTIONS_PER_ROUND),
    // Suggested answers, one list per question (same order). Empty for rounds written before choices existed.
    options: z.array(interviewOptionsSchema).max(STUDIO_QUESTIONS_PER_ROUND).default([]),
    answers: z.array(interviewAnswerSchema).max(STUDIO_QUESTIONS_PER_ROUND),
  })
  .strict();
export type InterviewRound = z.infer<typeof interviewRoundSchema>;

export const interviewStatusSchema = z.enum(['asking', 'done']);
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;

export const interviewStateSchema = z
  .object({
    projectId: z.string().min(1),
    // The code folder this discussion is attached to. Null means it lives only in KAI's Studio workspace.
    linkedProjectId: z.string().min(1).nullable().default(null),
    idea: z.string().trim().min(1).max(4_000),
    // The idea restated as one clear goal, refreshed each round; empty until the first reply lands.
    goal: z.string().trim().max(4_000).default(''),
    // What the model assumed where the idea was silent. The user can correct any of them in the brief.
    assumptions: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
    rounds: z.array(interviewRoundSchema).max(STUDIO_QUESTION_CEILING).default([]),
    // Questions the user asked for beyond the first ten, because they wanted to be walked through more.
    extraQuestions: z.number().int().min(0).max(STUDIO_EXTRA_QUESTIONS * STUDIO_MAX_EXTENSIONS).default(0),
    status: interviewStatusSchema.default('asking'),
    // Relative path of the written brief once the interview is done, so the UI can point at a real file.
    briefPath: z.string().max(300).nullable().default(null),
    // Archived discussions stay on disk but are moved out of the active Studio list until restored.
    archivedAt: z.string().min(1).nullable().default(null),
    updatedAt: z.string().min(1),
  })
  .strict();
export type InterviewState = z.infer<typeof interviewStateSchema>;

export const interviewStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    idea: z.string().trim().min(1).max(4_000),
    linkedProjectId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type InterviewStartInput = z.infer<typeof interviewStartInputSchema>;

/** The shape the model is asked to return. Goal and assumptions are refreshed each round, questions drive the next. */
export const interviewReplySchema = z
  .object({
    goal: z.string().trim().min(1).max(4_000),
    assumptions: z.array(z.string().trim().min(1).max(400)).max(8).default([]),
    // A bare string is accepted too, for models that ignore the object shape.
    questions: z
      .array(z.union([
        z.string().trim().min(1).max(400),
        z.object({ question: z.string().trim().min(1).max(400), options: interviewOptionsSchema.default([]) }).strict(),
      ]))
      .max(STUDIO_QUESTIONS_PER_ROUND)
      .default([]),
  })
  .strict();
export type InterviewReply = z.infer<typeof interviewReplySchema>;

export const interviewAnswerInputSchema = z
  .object({
    projectId: z.string().min(1),
    answers: z.array(interviewAnswerSchema).max(STUDIO_QUESTIONS_PER_ROUND),
  })
  .strict();
export type InterviewAnswerInput = z.infer<typeof interviewAnswerInputSchema>;

export const interviewProjectInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type InterviewProjectInput = z.infer<typeof interviewProjectInputSchema>;

export const studioProjectArchiveInputSchema = z
  .object({ projectId: z.string().min(1), archived: z.boolean() })
  .strict();
export type StudioProjectArchiveInput = z.infer<typeof studioProjectArchiveInputSchema>;

export const studioProjectLaunchInputSchema = z
  .object({
    projectId: z.string().min(1),
    destination: z.enum(['composer', 'editor', 'generate']),
  })
  .strict();
export type StudioProjectLaunchInput = z.infer<typeof studioProjectLaunchInputSchema>;

/** What the desktop shell needs to open a finished Studio plan in either surface. */
export const studioProjectLaunchResultSchema = z
  .object({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict();
export type StudioProjectLaunchResult = z.infer<typeof studioProjectLaunchResultSchema>;

export const studioProjectFolderInputSchema = interviewProjectInputSchema;
export type StudioProjectFolderInput = z.infer<typeof studioProjectFolderInputSchema>;

export const studioProjectFolderResultSchema = z
  .object({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
export type StudioProjectFolderResult = z.infer<typeof studioProjectFolderResultSchema>;

/** A project that exists because it was discussed in Studio, even before it is tied to a code folder. */
export const studioProjectSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(4_000),
    idea: z.string().trim().min(1).max(4_000),
    linkedProjectId: z.string().min(1).nullable(),
    status: interviewStatusSchema,
    briefPath: z.string().max(300).nullable(),
    archivedAt: z.string().min(1).nullable(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type StudioProjectSummary = z.infer<typeof studioProjectSummarySchema>;

export interface StudioReadiness {
  ready: boolean;
  displayName: string;
  model: string;
  reason: string | null;
}

/** How many questions this interview may ask in all: ten, plus any the user asked for. */
export function interviewQuestionBudget(state: { extraQuestions?: number }): number {
  return STUDIO_MAX_QUESTIONS + (state.extraQuestions ?? 0);
}

/** The questions of the round the user still has to answer, empty when the interview is done. */
export function interviewOpenQuestions(state: InterviewState): string[] {
  const last = state.rounds[state.rounds.length - 1];
  if (!last || state.status === 'done') return [];
  const answered = new Set(last.answers.map((item) => item.question));
  return last.questions.filter((question) => !answered.has(question));
}

/** The suggested answers for each open question, aligned with `interviewOpenQuestions`. */
export function interviewOpenOptions(state: InterviewState): string[][] {
  const last = state.rounds[state.rounds.length - 1];
  if (!last || state.status === 'done') return [];
  const answered = new Set(last.answers.map((item) => item.question));
  return last.questions.flatMap((question, index) => (answered.has(question) ? [] : [last.options[index] ?? []]));
}

/** Every answer the user gave, oldest round first, with the skipped ones dropped. */
export function interviewGivenAnswers(state: InterviewState): InterviewAnswer[] {
  return state.rounds.flatMap((round) => round.answers.filter((item) => item.answer));
}
