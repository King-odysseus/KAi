import {
  STUDIO_MAX_ROUNDS,
  STUDIO_QUESTIONS_PER_ROUND,
  directProviderPreset,
  interviewReplySchema,
  interviewStateSchema,
  isLocalProvider,
  type AppSettings,
  type InterviewAnswer,
  type InterviewAnswerInput,
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
 * The interview that starts the Project Studio. It reads one paragraph, asks at most a dozen skippable questions
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
    questions: { type: 'array', items: { type: 'string' } },
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
    if (rounds.length >= STUDIO_MAX_ROUNDS) {
      return this.persist(await this.complete({ ...state, rounds }));
    }
    return this.persist(await this.ask({ ...state, rounds }));
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
    const reply = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      buildInterviewPrompt(state, context),
      'kai_project_interview',
      INTERVIEW_JSON_SCHEMA,
      parseInterviewReply,
    );
    const asked = new Set(state.rounds.flatMap((round) => round.questions.map(normalise)));
    const questions = dedupeQuestions(reply.questions).filter((question) => !asked.has(normalise(question))).slice(0, STUDIO_QUESTIONS_PER_ROUND);
    const next: InterviewState = {
      ...state,
      goal: reply.goal,
      assumptions: reply.assumptions.slice(0, 12),
      rounds: [...state.rounds, { questions, answers: [] }],
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
    title: state.goal.trim() || state.idea.trim(),
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
export function buildInterviewPrompt(state: Pick<InterviewState, 'idea' | 'goal' | 'assumptions' | 'rounds'>, context: string | null): { system: string; user: string } {
  const system = [
    'You are the Project Studio inside KAI, a desktop workbench where a team of coding agents builds software.',
    'The user has described a project in a paragraph. Your job is to close the gaps that would make the agents guess, before anything is written down as a requirement.',
    'Return only JSON matching the schema, with no markdown fences.',
    '',
    'Write:',
    '- "goal": the project restated as one clear, specific goal (what is built, for whom, and what "done" looks like).',
    '- "assumptions": decisions you made where the description was silent, each short and concrete. Carry forward the ones you still believe.',
    `- "questions": up to ${STUDIO_QUESTIONS_PER_ROUND} questions only the user can answer, most important first. Ask about the things that would change what gets built: who uses it, the data and where it lives, accounts and permissions, payments, the platform, and how the result is judged.`,
    'Ask none when you can already write the goal, the stack and the acceptance criteria from what you have. Fewer, better questions beat a full set.',
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
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : 'No project snapshot is available.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Reads the model's reply, dropping duplicates and clearing up anything long enough to break the round limit. */
export function parseInterviewReply(content: string): { goal: string; assumptions: string[]; questions: string[] } {
  const raw = parseJsonResponse(content, 'Project Studio');
  const parsed = interviewReplySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  return {
    goal: parsed.data.goal,
    assumptions: parsed.data.assumptions.slice(0, 12),
    questions: dedupeQuestions(parsed.data.questions),
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
    `# ${state.goal || 'Project brief'}`,
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

/** Keeps the questions the model returned, minus exact repeats, capped at a round. */
function dedupeQuestions(questions: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const question of questions) {
    const key = normalise(question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(question.trim());
  }
  return kept;
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
