import {
  projectTitleFrom,
  STUDIO_EXTRA_QUESTIONS,
  STUDIO_MAX_ASSUMPTION_CHARS,
  STUDIO_MAX_ASSUMPTIONS,
  STUDIO_MAX_EXTENSIONS,
  STUDIO_MAX_GOAL_CHARS,
  STUDIO_MAX_QUESTION_CHARS,
  STUDIO_MAX_OPTIONS,
  STUDIO_MAX_OPTION_CHARS,
  STUDIO_QUESTION_CEILING,
  STUDIO_QUESTIONS_PER_ROUND,
  STUDIO_STYLE_REFERENCE_NOTES_PATH,
  STUDIO_ROUND_QUESTION_LIMITS,
  clipOption,
  clipToLength,
  interviewQuestionBudget,
  directProviderPreset,
  interviewReplySchema,
  interviewStateSchema,
  isLocalProvider,
  type AppSettings,
  type InterviewAnswer,
  type InterviewAnswerInput,
  type InterviewCorrectionInput,
  type InterviewProjectInput,
  type InterviewRound,
  type InterviewStartInput,
  type InterviewState,
  type StudioProjectArchiveInput,
  type StudioReadiness,
  type StudioProjectSummary,
} from '@kai/contracts';
import { loadProjectContext, parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';

/**
 * The interview that starts the Project Studio. It reads one paragraph, asks at most ten skippable questions
 * across three rounds, and writes `.kai/spec/brief.md` when it has enough to be specific.
 *
 * It reuses the Prompt Guide's provider connection: the studio adds no second key, no hosted service and no
 * subscription. Nothing here changes the project — the only file it writes is the brief.
 */

const NAMES = { feature: 'the Project Studio', card: 'Project Studio' };
/** Enough of the project to name real files and folders, without sending the whole tree on every round. */
const INTERVIEW_CONTEXT_CHARS = 6_000;
export const INTERVIEW_BRIEF_PATH = 'brief.md';

const INTERVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'assumptions', 'questions'],
  properties: {
    goal: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface InterviewStorePort {
  list(): Promise<InterviewState[]>;
  read(projectId: string): Promise<InterviewState | null>;
  write(state: InterviewState): Promise<void>;
  clear(projectId: string): Promise<void>;
}

/** Only the one spec write the interview needs; the full spec store arrives with the artifacts phase. */
export interface SpecWriterPort {
  write(projectRoot: string, relativePath: string, content: string): Promise<{ path: string }>;
  /** Optional: lets the interview read what the user's reference images were described as. */
  read?(projectRoot: string, relativePath: string): Promise<string | null>;
}

export interface InterviewPorts {
  settings(): Promise<AppSettings>;
  projectRoot(projectId: string, linkedProjectId?: string | null): Promise<string>;
  credentialStored(id: string): Promise<boolean>;
  vaultAvailable(): boolean;
  requester: StructuredRequester;
  store: InterviewStorePort;
  spec: SpecWriterPort;
  now(): string;
}

export class DesktopInterview {
  constructor(private readonly ports: InterviewPorts) {}

  /**
   * The interview runs on the Prompt Guide's connection, so its readiness is the same question asked in different
   * words. Saying which key to fix is more useful than saying "the studio is unavailable".
   */
  async readiness(): Promise<StudioReadiness> {
    const guide = (await this.ports.settings()).promptGuide;
    const displayName = directProviderPreset(guide.provider).displayName;
    const local = isLocalProvider(guide.provider);
    let reason: string | null = null;
    if (!guide.enabled) reason = 'The Project Studio uses the Prompt Guide’s model connection. Turn it on and add its API key under Settings, Prompt Guide.';
    else if (!guide.model.trim()) reason = 'Choose a Prompt Guide model under Settings, Prompt Guide.';
    else if (!local && !this.ports.vaultAvailable()) reason = 'The OS credential vault is unavailable, so the Project Studio cannot read its key.';
    else if (!local && !(await this.ports.credentialStored(guide.credentialId))) reason = `Save the ${guide.credentialId} key under Settings, Prompt Guide.`;
    return { ready: reason === null, displayName, model: guide.model, reason };
  }

  async read(input: InterviewProjectInput): Promise<InterviewState | null> {
    return this.ports.store.read(input.projectId);
  }

  async list(): Promise<StudioProjectSummary[]> {
    const interviews = await this.ports.store.list();
    return interviews.map(summaryOf);
  }

  /** Starts an interview, or replaces a finished one. A half-answered interview has to be reset first. */
  async start(input: InterviewStartInput): Promise<InterviewState> {
    const existing = await this.ports.store.read(input.projectId);
    if (existing && existing.status === 'asking') {
      throw new Error('An interview is already in progress for this project. Finish it or start over.');
    }
    const readiness = await this.readiness();
    if (!readiness.ready) throw new Error(readiness.reason ?? 'The Project Studio is not ready.');
    const state = await this.ask({
      projectId: input.projectId,
      linkedProjectId: input.linkedProjectId ?? null,
      idea: input.idea,
      goal: '',
      assumptions: [],
      rounds: [],
      extraQuestions: 0,
      status: 'asking',
      briefPath: null,
      archivedAt: null,
      updatedAt: this.ports.now(),
    });
    return this.persist(state);
  }

  /**
   * Records the answers to the round on screen. Skipped questions are stored as empty answers, so the brief can say
   * what was left open instead of pretending it was decided.
   */
  async answer(input: InterviewAnswerInput): Promise<InterviewState> {
    const state = await this.requireAsking(input.projectId);
    const last = state.rounds[state.rounds.length - 1];
    if (!last) throw new Error('The interview has no questions waiting.');
    const answers = mergeAnswers(last, input.answers);
    const rounds = [...state.rounds.slice(0, -1), { ...last, answers }];
    // The round budget is spent: write the brief from what we have instead of paying for another round.
    if (rounds.length >= interviewQuestionBudget(state)) {
      return this.persist(await this.complete({ ...state, rounds }));
    }
    return this.persist(await this.ask({ ...state, rounds }));
  }

  /**
   * Replaces an answer already given, and asks again from that point.
   *
   * A question the user has answered stops being writable the moment they answer it, because answering asks the
   * next question and the round it belonged to is no longer the newest one. That left a wrong or misread answer
   * with nowhere to go: it kept being sent as something already settled, and the model kept building on it. The
   * only recourse was to correct it inside the next answer, which works about as well as it sounds.
   *
   * The rounds after the corrected one are dropped rather than kept. Their questions were chosen from the answer
   * being corrected, so keeping them beside the correction would leave the interview arguing with itself. That
   * costs the answers given in those rounds; the model asks them again from the corrected point, which is the
   * point of correcting at all. Correcting the newest answer drops nothing.
   */
  async correct(input: InterviewCorrectionInput): Promise<InterviewState> {
    const state = await this.requireAsking(input.projectId);
    const wanted = normalise(input.question);
    const at = state.rounds.findIndex((round) => round.questions.some((question) => normalise(question) === wanted));
    if (at === -1) throw new Error('That question is not part of this interview.');

    const round = state.rounds[at];
    // Sent through mergeAnswers like any other answer, so only questions this round actually asked are stored, and
    // the round's other answers are carried over rather than blanked by the one being corrected.
    const corrected = round.answers.map((item) => (normalise(item.question) === wanted ? { ...item, answer: input.answer.trim() } : item));
    const rounds = [...state.rounds.slice(0, at), { ...round, answers: mergeAnswers(round, corrected) }];
    return this.persist(await this.ask({ ...state, rounds }));
  }

  /** Five more questions, for someone who wants to be walked through. Twenty is the ceiling, so it never drags on. */
  async extend(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.requireAsking(input.projectId);
    if (state.extraQuestions >= STUDIO_EXTRA_QUESTIONS * STUDIO_MAX_EXTENSIONS) {
      throw new Error(`The interview already allows its most: ${STUDIO_QUESTION_CEILING} questions.`);
    }
    return this.persist({ ...state, extraQuestions: state.extraQuestions + STUDIO_EXTRA_QUESTIONS });
  }

  /** Writes the brief on demand, for a user who would rather stop answering now. */
  async finish(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.requireAsking(input.projectId);
    return this.persist(await this.complete(state));
  }

  async reset(input: InterviewProjectInput): Promise<null> {
    await this.ports.store.clear(input.projectId);
    return null;
  }

  async setArchived(input: StudioProjectArchiveInput): Promise<StudioProjectSummary> {
    const state = await this.ports.store.read(input.projectId);
    if (!state) throw new Error('Project not found.');
    const next = interviewStateSchema.parse({
      ...state,
      archivedAt: input.archived ? this.ports.now() : null,
      updatedAt: this.ports.now(),
    });
    await this.ports.store.write(next);
    return summaryOf(next);
  }

  async setLinkedProject(projectId: string, linkedProjectId: string | null): Promise<StudioProjectSummary> {
    const state = await this.ports.store.read(projectId);
    if (!state) throw new Error('Project not found.');
    const next = interviewStateSchema.parse({
      ...state,
      linkedProjectId,
      updatedAt: this.ports.now(),
    });
    await this.ports.store.write(next);
    return summaryOf(next);
  }

  async remove(input: InterviewProjectInput): Promise<null> {
    await this.ports.store.clear(input.projectId);
    return null;
  }

  /** Asks the model for the next round, updating the goal and assumptions as it learns more. */
  private async ask(state: InterviewState): Promise<InterviewState> {
    const [settings, root] = await Promise.all([
      this.ports.settings(),
      this.ports.projectRoot(state.projectId, state.linkedProjectId),
    ]);
    const context = await loadProjectContext(root, undefined, INTERVIEW_CONTEXT_CHARS).catch(() => null);
    const styleReference = (await this.ports.spec.read?.(root, STUDIO_STYLE_REFERENCE_NOTES_PATH).catch(() => null)) ?? null;
    const reply = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      buildInterviewPrompt(state, context, styleReference),
      'kai_project_interview',
      INTERVIEW_JSON_SCHEMA,
      parseInterviewReply,
    );
    const asked = new Set(state.rounds.flatMap((round) => round.questions.map(normalise)));
    const remaining = Math.max(0, interviewQuestionBudget(state) - asked.size);
    const fresh = reply.questions
      .filter((item) => !asked.has(normalise(item.question)))
      .slice(0, Math.min(roundLimit(state.rounds.length), remaining));
    const questions = fresh.map((item) => item.question);
    const next: InterviewState = {
      ...state,
      goal: reply.goal,
      assumptions: reply.assumptions.slice(0, STUDIO_MAX_ASSUMPTIONS),
      rounds: [...state.rounds, { questions, options: fresh.map((item) => item.options), answers: [] }],
      updatedAt: this.ports.now(),
    };
    // A round with no questions means the model knows enough: stop asking and write the brief.
    return questions.length > 0 ? next : this.complete({ ...next, rounds: state.rounds });
  }

  /** Marks the interview done and writes the brief the rest of the studio reads. */
  private async complete(state: InterviewState): Promise<InterviewState> {
    const root = await this.ports.projectRoot(state.projectId, state.linkedProjectId);
    const written = await this.ports.spec.write(root, INTERVIEW_BRIEF_PATH, briefMarkdown(state, this.ports.now()));
    return { ...state, status: 'done', briefPath: written.path, updatedAt: this.ports.now() };
  }

  private async persist(state: InterviewState): Promise<InterviewState> {
    const parsed = interviewStateSchema.parse(state);
    await this.ports.store.write(parsed);
    return parsed;
  }

  private async requireAsking(projectId: string): Promise<InterviewState> {
    const state = await this.ports.store.read(projectId);
    if (!state) throw new Error('No interview is in progress for this project.');
    if (state.status !== 'asking') throw new Error('This interview is already finished. Start over to change it.');
    return state;
  }
}

function summaryOf(state: InterviewState): StudioProjectSummary {
  return {
    id: state.projectId,
    title: projectTitleFrom(state.goal, state.idea) || state.idea.trim().slice(0, 64),
    idea: state.idea,
    linkedProjectId: state.linkedProjectId,
    status: state.status,
    briefPath: state.briefPath,
    archivedAt: state.archivedAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * The interview prompt. It shows everything the user has said so far, marks what they skipped, and tells the model
 * to stop asking when it can already write a specific goal.
 */
export function buildInterviewPrompt(state: Pick<InterviewState, 'idea' | 'goal' | 'assumptions' | 'rounds'> & { extraQuestions?: number }, context: string | null, styleReference: string | null = null): { system: string; user: string } {
  const system = [
    'You are the Project Studio inside KAI, a desktop workbench where a team of coding agents builds software.',
    'The user has described a project in a paragraph. Your job is to close the gaps that would make the agents guess, before anything is written down as a requirement.',
    'Return only JSON matching the schema, with no markdown fences.',
    '',
    'Write:',
    '- "goal": the project restated as one clear, specific goal (what is built, for whom, and what "done" looks like).',
    '- "assumptions": decisions you made where the description was silent, each short and concrete and under ${STUDIO_MAX_ASSUMPTION_CHARS} characters. Carry forward the ones you still believe.',
    `- "questions": at most ${roundLimit(state.rounds.length)} question, the single most important one only the user can answer, as an object {"question", "options"}. The whole interview may ask no more than ${interviewQuestionBudget(state)} questions; it has already asked ${state.rounds.flatMap((round) => round.questions).length}. It is shown in a chat, so write it as one short, conversational question of at most ${STUDIO_MAX_QUESTION_CHARS} characters that opens with a few words acknowledging the user's last answer (nothing, when there is none yet). Ask about the things that would change what gets built: who uses it, the data and where it lives, accounts and permissions, payments, the platform, and how the result is judged.`,
    `Give each question 2 to ${STUDIO_MAX_OPTIONS} "options": short, concrete answers fitted to THIS project and to everything the user has told you so far, so that a later question's options follow from the earlier answers (a payment question after "deposit" offers deposit styles, not generic ones). Keep every option to ${STUDIO_MAX_OPTION_CHARS} characters or fewer: they are shown as chips beside the answer box, and a longer one is cut short. Put the option you would recommend first and end its text with " (recommended)". Always make the last option "Not sure, you decide". If the user picked it, or skipped, decide yourself and add the decision to "assumptions" with a few words of reason. Use an empty options array only for a question that is truly open-ended.`,
    'Many users are new to building software. When their wording suggests that (no technical terms, "I don\'t know", very broad answers), write in plain language, explain what each option means in a few words, and prefer the simplest choice that works. Never assume they know what a framework, database or hosting service is.',
    'The documents written after this interview need: who uses it and in which roles, the data and where it lives, integrations and hosting, how the result is judged, and, for anything with a screen, the visual design (brand or preferred colours, light or dark, the feel, products it should resemble). Use your questions on whatever of that the user has not already said. Two topics are required before you finish: (1) the technology to build it with (language and framework, where it is hosted, the database), unless the user already chose it; offer options suited to the project with a recommended one, and for a newcomer explain the recommendation in a few words; (2) for anything with a screen, the visual design, with options such as palettes or styles. Do not finish without either. When you ask about the visual design, add that they can attach reference images of a look they like with the image button next to the answer box.',
    'Ask none when you can already write the goal, the stack, the design direction and the acceptance criteria from what you have. Fewer, better questions beat a full set.',
    'Never repeat a question the user has already answered, and never re-ask one they skipped: a skip means they want you to decide.',
    'Never invent files that the snapshot shows do not exist; say "a new file under <folder>" instead.',
    'Do not ask for secrets, API keys or account credentials.',
  ].join('\n');
  const answered: string[] = [];
  const skipped: string[] = [];
  for (const round of state.rounds) {
    for (const item of round.answers) (item.answer ? answered : skipped).push(item.answer ? `Q: ${item.question}\nA: ${item.answer}` : item.question);
  }
  const user = [
    `Project described by the user:\n${state.idea}`,
    state.goal ? `Goal so far:\n${state.goal}` : '',
    answered.length > 0 ? `Already answered:\n${answered.join('\n\n')}` : '',
    skipped.length > 0 ? `Skipped (decide these yourself):\n${skipped.map((question) => `- ${question}`).join('\n')}` : '',
    styleReference?.trim() ? `The user attached reference images; a model described them as:\n${styleReference.trim().slice(0, 2_500)}\nTreat this as their stated taste and do not ask again for what it already answers.` : '',
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : 'No project snapshot is available.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/**
 * Holds a reply to the shape before it is validated: text cut to its limit, empty entries dropped, lists capped.
 *
 * The prompt states every one of these limits and the model overshoots them anyway, and validating the reply as it
 * arrived meant one field a few characters too long rejected all of it — the goal, the assumptions and the next
 * question together, because a reply is one object. What fits is kept and what does not is shortened, so a reply
 * that is substantially right still becomes a round.
 *
 * A reply with no goal is still rejected. That one is not too long, it is missing, and nothing here can invent it.
 */
function withinShape(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const reply = { ...(raw as Record<string, unknown>) };
  if (typeof reply.goal === 'string') reply.goal = clipToLength(reply.goal, STUDIO_MAX_GOAL_CHARS);
  if (Array.isArray(reply.assumptions)) {
    const stated: unknown[] = reply.assumptions;
    reply.assumptions = stated
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, STUDIO_MAX_ASSUMPTIONS)
      .map((item) => clipToLength(item, STUDIO_MAX_ASSUMPTION_CHARS));
  }
  if (Array.isArray(reply.questions)) {
    const listed: unknown[] = reply.questions;
    reply.questions = listed.slice(0, STUDIO_QUESTIONS_PER_ROUND).map(heldQuestion);
  }
  return reply;
}

/** A question is either the bare text or an object with suggested answers under it; both are held to the shape. */
function heldQuestion(item: unknown): unknown {
  if (typeof item === 'string') return clipToLength(item, STUDIO_MAX_QUESTION_CHARS);
  if (typeof item !== 'object' || item === null) return item;
  const question = { ...(item as Record<string, unknown>) };
  if (typeof question.question === 'string') question.question = clipToLength(question.question, STUDIO_MAX_QUESTION_CHARS);
  if (Array.isArray(question.options)) {
    const offered: unknown[] = question.options;
    question.options = offered
      .filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
      .slice(0, STUDIO_MAX_OPTIONS)
      .map(clipOption);
  }
  return question;
}

/** Reads the model's reply, dropping duplicate questions and options. */
export function parseInterviewReply(content: string): { goal: string; assumptions: string[]; questions: Array<{ question: string; options: string[] }> } {
  const raw = withinShape(parseJsonResponse(content, 'Project Studio'));
  const parsed = interviewReplySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  return {
    goal: parsed.data.goal,
    assumptions: parsed.data.assumptions.slice(0, STUDIO_MAX_ASSUMPTIONS),
    questions: dedupeReplyQuestions(parsed.data.questions),
  };
}

/** The brief the rest of the studio reads. Plain markdown, and honest about what was skipped. */
export function briefMarkdown(state: InterviewState, writtenAt: string): string {
  const open: string[] = [];
  const decided: InterviewAnswer[] = [];
  for (const round of state.rounds) {
    for (const item of round.answers) {
      if (item.answer) decided.push(item);
      else open.push(item.question);
    }
  }
  const unanswered = state.rounds.flatMap((round) => round.questions).filter((question) => !decided.some((item) => item.question === question) && !open.includes(question));
  const sections = [
    `# ${projectTitleFrom(state.goal, state.idea) || 'Project brief'}`,
    `_Written by the KAI Project Studio on ${writtenAt}._`,
    '## The idea',
    state.idea,
    '## Assumptions',
    state.assumptions.length > 0 ? state.assumptions.map((item) => `- ${item}`).join('\n') : '- None recorded.',
    '## What you decided',
    decided.length > 0 ? decided.map((item) => `**${item.question}**\n\n${item.answer}`).join('\n\n') : 'No questions were answered.',
    open.length > 0 ? `## Left to the agents\n\n${open.map((question) => `- ${question}`).join('\n')}` : '',
    unanswered.length > 0 ? `## Still open\n\n${unanswered.map((question) => `- ${question}`).join('\n')}` : '',
    '## Next',
    'The board, the components and the pages are built from this brief in the Project Studio. This file is the source: edit it by hand whenever you like, and KAI reads your version, not a copy.',
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/** Keeps the questions the model returned, minus exact repeats, with their suggested answers cleaned up. */
function dedupeReplyQuestions(questions: ReadonlyArray<string | { question: string; options?: readonly string[] }>): Array<{ question: string; options: string[] }> {
  const seen = new Set<string>();
  const kept: Array<{ question: string; options: string[] }> = [];
  for (const item of questions) {
    const question = typeof item === 'string' ? item : item.question;
    const key = normalise(question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const options = typeof item === 'string' ? [] : dedupeOptions(item.options ?? []);
    kept.push({ question: question.trim(), options });
  }
  return kept;
}

function dedupeOptions(options: readonly string[]): string[] {
  const seen = new Set<string>();
  return options
    .map((option) => option.trim())
    .filter((option) => {
      const key = normalise(option);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, STUDIO_MAX_OPTIONS);
}

/** Questions the next round may ask: 3, then 3, then 4, so the interview never passes ten. */
function roundLimit(roundsAsked: number): number {
  return STUDIO_ROUND_QUESTION_LIMITS[roundsAsked] ?? 0;
}

/** Answers for the questions actually asked; anything else in the payload is ignored rather than stored. */
function mergeAnswers(round: InterviewRound, incoming: readonly InterviewAnswer[]): InterviewAnswer[] {
  return round.questions.map((question) => {
    const given = incoming.find((item) => normalise(item.question) === normalise(question));
    return { question, answer: given?.answer.trim() ?? '' };
  });
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
