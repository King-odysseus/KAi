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
/** The goal is the whole idea restated, so it gets room. */
export const STUDIO_MAX_GOAL_CHARS = 4_000;
/** How many assumptions one reply may draw, and how many the brief keeps. */
export const STUDIO_MAX_ASSUMPTIONS = 8;
/** A question is one conversational line; an assumption is a decision stated in a sentence. */
export const STUDIO_MAX_QUESTION_CHARS = 400;
export const STUDIO_MAX_ASSUMPTION_CHARS = 400;

const interviewOptionsSchema = z.array(z.string().trim().min(1).max(STUDIO_MAX_OPTION_CHARS)).max(STUDIO_MAX_OPTIONS);

/**
 * Text cut to a length, at a word boundary and marked with an ellipsis.
 *
 * Every field the model writes has a limit, and it is told each of them and overshoots them anyway. One field a few
 * characters over used to fail the whole reply, and the whole reply is the goal, the assumptions and the next
 * question together — so a long sentence in any one of them cost the entire round. Text this long is worth
 * shortening rather than throwing away.
 *
 * The cut is at a word boundary so it reads as a summary rather than a sentence that stops mid-word, and it only
 * falls back to cutting mid-word when there is no space in the second half to cut at, which means one enormous word
 * with nowhere to break.
 */
export function clipToLength(value: string, limit: number): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= limit) return collapsed;
  // Room for the ellipsis, which is what keeps the result inside the limit.
  const room = collapsed.slice(0, limit - 1);
  const lastSpace = room.lastIndexOf(' ');
  const cut = lastSpace >= limit / 2 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

/** A suggested answer cut to chip length. The recommended one is offered first, so it is shortened, never dropped. */
export function clipOption(option: string): string {
  return clipToLength(option, STUDIO_MAX_OPTION_CHARS);
}

export const interviewAnswerSchema = z
  .object({
    question: z.string().trim().min(1).max(400),
    // An empty answer means the user skipped the question, which is always allowed.
    // Interview answers are often a short requirements note, not a one-line reply.
    // Keep this aligned with the idea field so a complete v1 scope can be submitted.
    answer: z.string().trim().max(4_000),
    summary: z.string().trim().max(1_200).optional(),
  })
  .strict();
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

export const interviewRoundSchema = z
  .object({
    questions: z.array(z.string().trim().min(1).max(STUDIO_MAX_QUESTION_CHARS)).max(STUDIO_QUESTIONS_PER_ROUND),
    // Suggested answers, one list per question (same order). Empty for rounds written before choices existed.
    options: z.array(interviewOptionsSchema).max(STUDIO_QUESTIONS_PER_ROUND).default([]),
    answers: z.array(interviewAnswerSchema).max(STUDIO_QUESTIONS_PER_ROUND),
  })
  .strict();
export type InterviewRound = z.infer<typeof interviewRoundSchema>;

export const interviewAssumptionSchema = z.object({
  text: z.string().trim().min(1).max(STUDIO_MAX_ASSUMPTION_CHARS),
  risk: z.enum(['high', 'medium', 'low']),
  status: z.enum(['assumed', 'confirmed', 'changed']),
}).strict();
export type InterviewAssumption = z.infer<typeof interviewAssumptionSchema>;

export const INTERVIEW_TOPICS = {
  users: 'Users and roles',
  data: 'Data and where it lives',
  stack: 'Technology stack',
  hosting: 'Hosting',
  integrations: 'Integrations',
  auth: 'Accounts and permissions',
  payments: 'Payments',
  design: 'Design',
  acceptance: 'Acceptance criteria',
} as const;
export type InterviewTopic = keyof typeof INTERVIEW_TOPICS;
export const interviewTopicSchema = z.object({
  status: z.enum(['decided', 'assumed', 'open']),
  source: z.string().trim().min(1).max(120),
}).strict();
export const interviewTopicKeySchema = z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]]);
/**
 * Keeps the topics the interview knows, each in the shape it expects, and drops the rest. A model asked for nine
 * named topics will sometimes add its own ("technology", "accounts") or leave a source out; one such entry used to
 * refuse the whole reply, so the person saw an error and lost the round over a field that does not matter.
 */
function cleanTopics(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const cleaned: Record<string, { status: string; source: string }> = {};
  for (const key of Object.keys(INTERVIEW_TOPICS)) {
    const entry = input[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { status, source } = entry as { status?: unknown; source?: unknown };
    if (status !== 'decided' && status !== 'assumed' && status !== 'open') continue;
    const text = typeof source === 'string' ? source.trim().slice(0, 120) : '';
    cleaned[key] = { status, source: text || 'stated in the idea' };
  }
  return cleaned;
}
export const interviewTopicsSchema = z.preprocess(cleanTopics, z.object({
  users: interviewTopicSchema.optional(),
  data: interviewTopicSchema.optional(),
  stack: interviewTopicSchema.optional(),
  hosting: interviewTopicSchema.optional(),
  integrations: interviewTopicSchema.optional(),
  auth: interviewTopicSchema.optional(),
  payments: interviewTopicSchema.optional(),
  design: interviewTopicSchema.optional(),
  acceptance: interviewTopicSchema.optional(),
}).strict());
export type InterviewTopics = Partial<Record<InterviewTopic, z.infer<typeof interviewTopicSchema>>>;
export const interviewIdeaReadResultSchema = z.object({
  summary: z.string().trim().min(1).max(1_200),
  stated: z.array(z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]])),
  gaps: z.array(z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]])),
}).strict();
export type InterviewIdeaReadResult = z.infer<typeof interviewIdeaReadResultSchema>;
export const interviewLongAnswerResultSchema = z.object({
  summaries: z.array(z.object({
    question: z.string().trim().min(1).max(400),
    summary: z.string().trim().min(1).max(1_200),
    topics: z.array(interviewTopicKeySchema),
  }).strict()),
}).strict();
export type InterviewLongAnswerResult = z.infer<typeof interviewLongAnswerResultSchema>;

const savedAssumptionsSchema = z.preprocess((value) => Array.isArray(value)
  ? value.map((item) => typeof item === 'string' ? { text: item, risk: 'medium', status: 'assumed' } : item)
  : value, z.array(interviewAssumptionSchema).max(12).default([]));

export const interviewStatusSchema = z.enum(['asking', 'reviewing', 'done']);
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;

export const interviewStateSchema = z
  .object({
    projectId: z.string().min(1),
    // The code folder this discussion is attached to. Null means it lives only in KAI's Studio workspace.
    linkedProjectId: z.string().min(1).nullable().default(null),
    idea: z.string().trim().min(1).max(4_000),
    // Compact, local summary from the one-time idea read; the original idea stays intact for the brief.
    ideaSummary: z.string().trim().max(1_200).default(''),
    ideaStated: z.array(z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]])).default([]),
    ideaGaps: z.array(z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]])).default([]),
    // The idea restated as one clear goal, refreshed each round; empty until the first reply lands.
    goal: z.string().trim().max(STUDIO_MAX_GOAL_CHARS).default(''),
    // What the model assumed where the idea was silent. The user can correct any of them in the brief.
    assumptions: savedAssumptionsSchema,
    // Changes made from the assumption controls, retained as explicit user decisions in the brief.
    assumptionDecisions: z.array(interviewAnswerSchema).default([]),
    topics: interviewTopicsSchema,
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
    goal: z.string().trim().min(1).max(STUDIO_MAX_GOAL_CHARS),
    assumptions: z.array(interviewAssumptionSchema).max(STUDIO_MAX_ASSUMPTIONS).default([]),
    topics: interviewTopicsSchema,
    // A bare string is accepted too, for models that ignore the object shape.
    questions: z
      .array(z.union([
        z.string().trim().min(1).max(STUDIO_MAX_QUESTION_CHARS),
        z.object({ question: z.string().trim().min(1).max(STUDIO_MAX_QUESTION_CHARS), options: interviewOptionsSchema.default([]) }).strict(),
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

/**
 * A second go at a question already answered, named by the question rather than by its place in the interview.
 *
 * Position would be wrong for this: the question is the thing the user is correcting, and it is also how the
 * answers are stored and merged. Questions are never repeated, so naming one identifies the round it is in.
 */
export const interviewCorrectionInputSchema = z
  .object({
    projectId: z.string().min(1),
    question: z.string().trim().min(1).max(400),
    answer: z.string().trim().max(4_000),
  })
  .strict();
export type InterviewCorrectionInput = z.infer<typeof interviewCorrectionInputSchema>;

export const interviewAssumptionInputSchema = z.object({
  projectId: z.string().min(1),
  text: z.string().trim().min(1).max(STUDIO_MAX_ASSUMPTION_CHARS),
  action: z.enum(['confirm', 'change', 'ask']),
  replacement: z.string().trim().min(1).max(STUDIO_MAX_ASSUMPTION_CHARS).optional(),
}).strict();
export type InterviewAssumptionInput = z.infer<typeof interviewAssumptionInputSchema>;

export const interviewTopicAskInputSchema = z.object({
  projectId: z.string().min(1),
  topic: z.enum(Object.keys(INTERVIEW_TOPICS) as [InterviewTopic, ...InterviewTopic[]]),
}).strict();
export type InterviewTopicAskInput = z.infer<typeof interviewTopicAskInputSchema>;

export const interviewProjectInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type InterviewProjectInput = z.infer<typeof interviewProjectInputSchema>;

export const studioProjectArchiveInputSchema = z
  .object({ projectId: z.string().min(1), archived: z.boolean() })
  .strict();
export type StudioProjectArchiveInput = z.infer<typeof studioProjectArchiveInputSchema>;

export const studioProjectLaunchInputSchema = z
  .object({
    projectId: z.string().min(1),
    destination: z.enum(['composer', 'editor', 'generate', 'crew']),
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

/**
 * A short name for a project, out of the goal or the idea.
 *
 * Both are paragraphs — the goal is a full statement of what "done" looks like, and either can run to 4,000
 * characters. Everywhere a project needs a *name* took the goal whole, so a project was called by its entire brief:
 * it filled the project list and the Studio header, became the `#` heading of the brief, and was repeated into every
 * design prompt, which then said "The project: <the whole paragraph>" underneath the goal it had already been given.
 */
export function projectTitleFrom(...sources: Array<string | null | undefined>): string {
  const source = sources.find((candidate) => candidate?.trim());
  if (!source) return '';
  const text = source.trim().replace(/\s+/g, ' ');
  // The first sentence, when there is one: it is nearly always the name and the rest is elaboration.
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  if (sentence.length <= PROJECT_TITLE_MAX) return sentence;
  const clipped = sentence.slice(0, PROJECT_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > PROJECT_TITLE_MAX / 2 ? clipped.slice(0, lastSpace) : clipped).replace(/[.,;:\s]+$/, '')}…`;
}

/**
 * Long enough for a real one-sentence name — "SharpSite, a locked-template website builder for Nigerian small
 * businesses." is 71 — and short enough to sit in a list, a header and a heading without crowding any of them.
 */
export const PROJECT_TITLE_MAX = 80;

/** A project that exists because it was discussed in Studio, even before it is tied to a code folder. */
export const studioProjectSummarySchema = z
  .object({
    id: z.string().min(1),
    // A name, not the brief: `projectTitleFrom` is what produces it.
    title: z.string().trim().min(1).max(200),
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
  if (!last || state.status !== 'asking') return [];
  const answered = new Set(last.answers.map((item) => item.question));
  return last.questions.filter((question) => !answered.has(question));
}

/** The suggested answers for each open question, aligned with `interviewOpenQuestions`. */
export function interviewOpenOptions(state: InterviewState): string[][] {
  const last = state.rounds[state.rounds.length - 1];
  if (!last || state.status !== 'asking') return [];
  const answered = new Set(last.answers.map((item) => item.question));
  return last.questions.flatMap((question, index) => (answered.has(question) ? [] : [last.options[index] ?? []]));
}

/** Every answer the user gave, oldest round first, with the skipped ones dropped. */
export function interviewGivenAnswers(state: InterviewState): InterviewAnswer[] {
  return state.rounds.flatMap((round) => round.answers.filter((item) => item.answer));
}

/** Finished interview recap, preserving skipped questions as visible handoffs to the agents. */
export function interviewRecap(state: InterviewState): {
  asked: number;
  decided: InterviewAnswer[];
  leftToAgents: string[];
} {
  const asked = state.rounds.flatMap((round) => round.questions);
  const answers = new Map(state.rounds.flatMap((round) => round.answers.map((item) => [item.question, item.answer] as const)));
  return {
    asked: asked.length,
    decided: asked.flatMap((question) => {
      const answer = answers.get(question)?.trim();
      return answer ? [{ question, answer }] : [];
    }),
    leftToAgents: asked.filter((question) => !answers.get(question)?.trim()),
  };
}

/** Studio-to-Crew handoff: inline the decision context only when the whole goal fits Crew's limit. */
export function studioCrewGoal(state: InterviewState): string {
  const header = 'Build this project from the Project Studio plan. Read .kai/spec/brief.md first, then the other files under .kai/spec (artifacts, board) and follow them; the brief is the source of truth for the stack, roles and design.';
  const goal = state.goal.trim() || state.idea.trim();
  const pointer = `${header}\n\nGoal: ${goal}`;
  const coverage = ['| Topic | Status | Source |', '| --- | --- | --- |', ...Object.entries(INTERVIEW_TOPICS).map(([key, label]) => {
    const topic = state.topics[key as InterviewTopic];
    return `| ${label} | ${topic?.status ?? 'open'} | ${topic?.source ?? 'not covered'} |`;
  })].join('\n');
  const assumptions = state.assumptions.filter((item) => item.status === 'assumed');
  const enriched = `${pointer}\n\n## Coverage\n\n${coverage}\n\n## Open assumptions\n\n${assumptions.length ? assumptions.map((item) => `- ${item.text}`).join('\n') : '- None.'}`;
  return enriched.length <= STUDIO_MAX_GOAL_CHARS ? enriched : `${header}\n\nGoal: ${clipToLength(goal, 1_500)}`;
}

/** A compact line diff suitable for pasting to the Crew Lead as guidance. */
export function studioBriefChangeDiff(before: string, after: string): string | null {
  if (before === after) return null;
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `- ${line}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+ ${line}`);
  const text = ['Brief changed since this run began:', ...removed, ...added].join('\n');
  return text.length <= 3_500 ? text : `${text.slice(0, 3_450)}\n…diff shortened`;
}

/** Stack choices found in past answers, used only for a local recommendation in Project Studio. */
export function stackRecommendationFromHistory(states: readonly InterviewState[]): { stack: string; projectCount: number } | null {
  const counts = new Map<string, { stack: string; projectCount: number; newest: string }>();
  for (const state of [...states].filter((item) => item.status === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const stack = interviewChoice(state, 'stack');
    if (!stack) continue;
    const key = stack.toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = counts.get(key);
    if (existing) existing.projectCount += 1;
    else counts.set(key, { stack, projectCount: 1, newest: state.updatedAt });
  }
  const winner = [...counts.values()].filter((item) => item.projectCount >= 2).sort((a, b) => b.projectCount - a.projectCount || b.newest.localeCompare(a.newest))[0];
  return winner ? { stack: winner.stack, projectCount: winner.projectCount } : null;
}

/** Pulls a concise answer to a stack, hosting or design question from a locally saved interview. */
export function interviewChoice(state: InterviewState, kind: 'stack' | 'hosting' | 'design'): string | null {
  const patterns = {
    stack: /\b(stack|framework|technology|built with|database)\b/i,
    hosting: /\b(host|hosting|hosted|deploy|where.*run)\b/i,
    design: /\b(design|visual|look|style|theme|colour|color|brand)\b/i,
  } as const;
  const answer = [...state.rounds].reverse().flatMap((round) => [...round.answers].reverse())
    .find((item) => item.answer.trim() && patterns[kind].test(item.question) && !/not sure|you decide|i will decide/i.test(item.answer));
  if (!answer) return null;
  return clipToLength(answer.answer.replace(/\s*\(recommended\)/ig, '').trim(), 120);
}
