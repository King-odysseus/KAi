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
  INTERVIEW_TOPICS,
  STUDIO_ROUND_QUESTION_LIMITS,
  clipOption,
  clipToLength,
  interviewQuestionBudget,
  directProviderPreset,
  interviewReplySchema,
  interviewIdeaReadResultSchema,
  interviewLongAnswerResultSchema,
  interviewStateSchema,
  stackRecommendationFromHistory,
  isLocalProvider,
  type AppSettings,
  type InterviewAnswer,
  type InterviewAnswerInput,
  type InterviewAssumptionInput,
  type InterviewCorrectionInput,
  type InterviewProjectInput,
  type InterviewRound,
  type InterviewStartInput,
  type InterviewState,
  type InterviewTopicAskInput,
  type InterviewImportanceInput,
  type InterviewImportance,
  type InterviewDraftInput,
  type InterviewIdeaReadResult,
  type InterviewLongAnswerResult,
  type StudioProjectArchiveInput,
  type StudioReadiness,
  type StudioProjectSummary,
} from '@kai/contracts';
import { lenient } from '@kai/contracts';
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

/** How much a topic matters for this project and why: the model's list, read back into the importance record. */
const IMPORTANCE_JSON = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['topic', 'importance', 'reason'],
    properties: { topic: { type: 'string', enum: Object.keys(INTERVIEW_TOPICS) }, importance: { type: 'string', enum: ['must', 'worth', 'skip'] }, reason: { type: 'string' } },
  },
} as const;

const INTERVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'assumptions', 'questions'],
  properties: {
    goal: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, risk: { type: 'string', enum: ['high', 'medium', 'low'] }, status: { type: 'string', enum: ['assumed', 'confirmed', 'changed'] } }, required: ['text', 'risk', 'status'], additionalProperties: false } },
    topics: { type: 'object', properties: Object.fromEntries(Object.keys(INTERVIEW_TOPICS).map((key) => [key, { type: 'object', properties: { status: { type: 'string', enum: ['decided', 'assumed', 'open'] }, source: { type: 'string' } }, required: ['status', 'source'], additionalProperties: false }])), additionalProperties: false },
    importance: IMPORTANCE_JSON,
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
const IDEA_READ_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'stated', 'gaps', 'importance'],
  properties: {
    importance: IMPORTANCE_JSON,
    summary: { type: 'string' },
    stated: { type: 'array', items: { type: 'string', enum: Object.keys(INTERVIEW_TOPICS) } },
    gaps: { type: 'array', items: { type: 'string', enum: Object.keys(INTERVIEW_TOPICS) } },
  },
} as const;
const LONG_ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summaries'],
  properties: {
    summaries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'summary', 'topics'], properties: {
      question: { type: 'string' }, summary: { type: 'string' }, topics: { type: 'array', items: { type: 'string', enum: Object.keys(INTERVIEW_TOPICS) } },
    } } },
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
    // An interview that never got its first questions has nothing worth keeping, so a new idea replaces it.
    if (existing && existing.status === 'asking' && existing.pending !== 'start') {
      throw new Error('An interview is already in progress for this project. Finish it or start over.');
    }
    const readiness = await this.readiness();
    if (!readiness.ready) throw new Error(readiness.reason ?? 'The Project Studio is not ready.');
    // Saved before the model is asked, so a failed or interrupted call leaves the idea behind instead of losing it.
    const saved = await this.persist({
      projectId: input.projectId,
      linkedProjectId: input.linkedProjectId ?? null,
      idea: input.idea,
      ideaSummary: '',
      ideaStated: [],
      ideaGaps: [],
      goal: '',
      assumptions: [],
      assumptionDecisions: [],
      topics: {},
      importance: {},
      rounds: [],
      extraQuestions: 0,
      status: 'asking',
      pending: 'start',
      pendingError: null,
      draftAnswers: [],
      briefPath: null,
      archivedAt: null,
      updatedAt: this.ports.now(),
    });
    return this.begin(saved);
  }

  /**
   * Retries the step a failed or interrupted call left pending. What the person already typed is in the saved
   * state, so only the model call runs again.
   */
  async resume(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.requireAsking(input.projectId);
    if (!state.pending) return state;
    return state.pending === 'start' ? this.begin(state) : this.advance(state);
  }

  /** Keeps answers typed for the open round, so leaving the screen or closing the app does not lose them. */
  async saveDraft(input: InterviewDraftInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state) throw new Error('No interview is in progress for this project.');
    if (state.status !== 'asking') return state;
    return this.persist({ ...state, draftAnswers: input.answers });
  }

  /** Reads the idea, then asks the first questions. A failure keeps the saved idea and records why. */
  private async begin(state: InterviewState): Promise<InterviewState> {
    try {
      const read = await this.readIdea(state.idea);
      const topics: InterviewState['topics'] = {};
      for (const topic of read.stated) topics[topic] = { status: 'decided', source: 'idea' };
      for (const topic of read.gaps) if (!topics[topic]) topics[topic] = { status: 'open', source: 'not stated in idea' };
      const asked = await this.ask({ ...state, ideaSummary: read.summary, ideaStated: read.stated, ideaGaps: read.gaps, topics, importance: read.importance });
      return this.persist({ ...asked, pending: null, pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
    } catch (caught) {
      return this.persist({ ...state, pendingError: failureText(caught), updatedAt: this.ports.now() });
    }
  }

  /** Asks the model for the next round on a state that is already saved. A failure keeps every answer and says why. */
  private async advance(state: InterviewState): Promise<InterviewState> {
    try {
      const asked = await this.ask(state);
      return this.persist({ ...asked, pending: null, pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
    } catch (caught) {
      return this.persist({ ...state, pendingError: failureText(caught), updatedAt: this.ports.now() });
    }
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
    let rounds = [...state.rounds.slice(0, -1), { ...last, answers }];
    let topics = state.topics;
    const longAnswers = answers.filter((item) => item.answer.length > 600);
    if (longAnswers.length > 0) {
      // The summary only shortens later prompts. If the model call fails, the answer is still kept whole, so
      // a failure here must never reject the answer the user just typed.
      const analyzed: InterviewLongAnswerResult = await this.summarizeLongAnswers(longAnswers).catch(() => ({ summaries: [] }));
      let answerNumber = state.rounds.flatMap((round) => round.answers).filter((item) => item.answer).length;
      const summaries = new Map(analyzed.summaries.map((item) => [normalise(item.question), item]));
      const updatedAnswers = answers.map((item) => {
        if (item.answer) answerNumber += 1;
        const summary = summaries.get(normalise(item.question));
        if (!summary) return item;
        for (const topic of summary.topics) topics = { ...topics, [topic]: { status: 'decided', source: `answer ${answerNumber}` } };
        return { ...item, summary: summary.summary };
      });
      rounds = [...rounds.slice(0, -1), { ...last, answers: updatedAnswers }];
    }
    // The round budget is spent: ask the user to review before writing the brief.
    if (rounds.flatMap((round) => round.questions).length >= interviewQuestionBudget(state)) {
      return this.persist({ ...state, rounds, topics, status: 'reviewing', pending: null, pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
    }
    // The answers are written down before the model is asked for the next round, so a failed call loses nothing.
    const saved = await this.persist({ ...state, rounds, topics, pending: 'next', pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
    return this.advance(saved);
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
    const saved = await this.persist({ ...state, rounds, pending: 'next', pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
    return this.advance(saved);
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
    return this.persist({ ...state, status: 'reviewing', pending: null, pendingError: null, draftAnswers: [], updatedAt: this.ports.now() });
  }

  /** Writes the brief only after the user confirms the review screen. */
  async confirm(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state || state.status !== 'reviewing') throw new Error('This interview is not waiting for review.');
    return this.persist(await this.complete(state));
  }

  /** Returns to the saved questions and answers without clearing anything. */
  async reopen(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state || state.status !== 'reviewing') throw new Error('This interview is not waiting for review.');
    return this.persist({ ...state, status: 'asking', updatedAt: this.ports.now() });
  }

  async reset(input: InterviewProjectInput): Promise<null> {
    await this.ports.store.clear(input.projectId);
    return null;
  }

  /** Keeps, changes or turns an assumption into a question without discarding interview rounds. */
  async assumption(input: InterviewAssumptionInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state) throw new Error('Project not found.');
    const index = state.assumptions.findIndex((item) => item.text === input.text);
    if (index < 0) throw new Error('That assumption is no longer in this interview.');
    if (input.action === 'ask') {
      const asked = state.rounds.flatMap((round) => round.questions).length;
      if (asked >= interviewQuestionBudget(state)) throw new Error('The question budget is spent. Add five more questions to continue.');
      const question = `Should we keep this assumption: ${state.assumptions[index]!.text}?`;
      return this.persist({
        ...state,
        status: 'asking',
        rounds: [...state.rounds, { questions: [question], options: [['Yes, keep it', 'No, change it', 'Not sure']], answers: [] }],
        updatedAt: this.ports.now(),
      });
    }
    const current = state.assumptions[index]!;
    const replacement = input.action === 'change' ? input.replacement?.trim() : current.text;
    if (!replacement) throw new Error('Enter the new assumption text first.');
    const assumptions = [...state.assumptions];
    assumptions[index] = { ...current, text: replacement, status: input.action === 'confirm' ? 'confirmed' : 'changed' };
    let next: InterviewState = {
      ...state,
      assumptions,
      assumptionDecisions: input.action === 'change'
        ? [...state.assumptionDecisions, { question: current.text, answer: replacement }]
        : state.assumptionDecisions,
      updatedAt: this.ports.now(),
    };
    if (next.status === 'done') {
      const root = await this.ports.projectRoot(next.projectId, next.linkedProjectId);
      const written = await this.ports.spec.write(root, INTERVIEW_BRIEF_PATH, briefMarkdown(next, this.ports.now()));
      next = { ...next, briefPath: written.path };
    }
    return this.persist(next);
  }

  /** Queues open-to-the-user assumed topics, capped by the remaining question budget. */
  async askAssumedTopics(input: InterviewProjectInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state || (state.status !== 'reviewing' && state.status !== 'done')) throw new Error('Review the interview before asking about assumed topics.');
    const asked = state.rounds.flatMap((round) => round.questions).length;
    const remaining = Math.max(0, interviewQuestionBudget(state) - asked);
    if (!remaining) throw new Error('The question budget is spent. Add five more questions to continue.');
    const assumed = (Object.keys(INTERVIEW_TOPICS) as Array<keyof typeof INTERVIEW_TOPICS>)
      .filter((key) => state.topics[key]?.status === 'assumed')
      .slice(0, remaining);
    if (!assumed.length) throw new Error('There are no assumed topics left to ask about.');
    return this.queueTopicQuestions(state, assumed);
  }

  /**
   * The person's own call on whether a topic matters. It is kept for the rest of the interview, whatever the model
   * later thinks, and a topic they turn on that is still open is asked about before the interview finishes.
   */
  async setImportance(input: InterviewImportanceInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state) throw new Error('Project not found.');
    const importance: InterviewImportance = { ...state.importance, [input.topic]: { level: input.level, reason: YOUR_CALL } };
    const next = { ...state, importance, updatedAt: this.ports.now() };
    if (next.status === 'done') {
      const root = await this.ports.projectRoot(next.projectId, next.linkedProjectId);
      const written = await this.ports.spec.write(root, INTERVIEW_BRIEF_PATH, briefMarkdown(next, this.ports.now()));
      return this.persist({ ...next, briefPath: written.path });
    }
    return this.persist(next);
  }

  /** Queues one topic selected from the visible question menu. */
  async askTopic(input: InterviewTopicAskInput): Promise<InterviewState> {
    const state = await this.ports.store.read(input.projectId);
    if (!state || !['asking', 'reviewing', 'done'].includes(state.status)) throw new Error('This interview is not ready for another topic question.');
    if (state.topics[input.topic]?.status === 'decided') throw new Error('That topic is already decided.');
    return this.queueTopicQuestions(state, [input.topic]);
  }

  private async queueTopicQuestions(state: InterviewState, topics: Array<keyof typeof INTERVIEW_TOPICS>): Promise<InterviewState> {
    const asked = state.rounds.flatMap((round) => round.questions).length;
    const remaining = Math.max(0, interviewQuestionBudget(state) - asked);
    if (!remaining) throw new Error('The question budget is spent. Add five more questions to continue.');
    const questions = topics.slice(0, remaining).map(topicQuestion);
    if (!questions.length) throw new Error('There are no assumed topics left to ask about.');
    const rounds: InterviewRound[] = [];
    const previous = [...state.rounds];
    const last = previous[previous.length - 1];
    const availableInLast = last ? STUDIO_QUESTIONS_PER_ROUND - last.questions.length : 0;
    const appended = state.status === 'asking' ? questions.slice(0, availableInLast) : [];
    if (last && appended.length > 0) {
      previous[previous.length - 1] = {
        ...last,
        questions: [...last.questions, ...appended.map((item) => item.question)],
        options: [...last.questions.map((_question, index) => last.options[index] ?? []), ...appended.map((item) => item.options)],
      };
    }
    const rest = questions.slice(appended.length);
    for (let index = 0; index < rest.length; index += STUDIO_QUESTIONS_PER_ROUND) {
      const chunk = rest.slice(index, index + STUDIO_QUESTIONS_PER_ROUND);
      rounds.push({ questions: chunk.map((item) => item.question), options: chunk.map((item) => item.options), answers: [] });
    }
    return this.persist({ ...state, status: 'asking', rounds: [...previous, ...rounds], pending: null, pendingError: null, updatedAt: this.ports.now() });
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

  private async readIdea(idea: string): Promise<InterviewIdeaReadResult> {
    const settings = await this.ports.settings();
    return this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      {
        system: [
          'Read the project idea before the interview asks anything.',
          'Return JSON with a compact summary of at most three short sentences, the topic keys already stated, and the topic keys missing.',
          `Topic keys and labels: ${JSON.stringify(INTERVIEW_TOPICS)}.`,
          'Mark a topic stated only when the idea gives enough information to guide implementation. Missing topics belong in gaps.',
          'Do not infer a decision from a generic project name. A one-line idea may leave most topics in gaps.',
          'Also say how much each topic matters for THIS project, in "importance": must (a wrong guess would change what gets built, so it needs deciding), worth (useful to settle, but the agents could reasonably choose), or skip (it does not apply to this project). Give every topic a one-plain-sentence reason, written for someone who is not very technical.',
          'Do not assume a topic is skip because the idea is short or does not mention it; only mark skip when the kind of project makes it genuinely not apply (payments for an internal tool with no billing, a visual design for a command-line tool), and say so in the reason.',
        ].join('\n'),
        user: `Project idea:\n${idea.slice(0, 4_000)}`,
      },
      'kai_project_idea_read',
      IDEA_READ_JSON_SCHEMA,
      parseInterviewIdeaRead,
    );
  }

  private async summarizeLongAnswers(answers: InterviewAnswer[]): Promise<InterviewLongAnswerResult> {
    const settings = await this.ports.settings();
    return this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      {
        system: [
          'Summarize each long project interview answer for future turns.',
          'Return one result per question with a concise summary in at most three short lines and the topic keys the answer settles.',
          `Topic keys: ${Object.keys(INTERVIEW_TOPICS).join(', ')}. Only include topics the answer explicitly covers.`,
          'The original answer remains saved for the brief; later interview prompts use your summary instead.',
        ].join('\n'),
        user: JSON.stringify(answers.map(({ question, answer }) => ({ question, answer }))),
      },
      'kai_project_long_answer',
      LONG_ANSWER_JSON_SCHEMA,
      parseInterviewLongAnswer,
    );
  }

  /** Asks the model for the next round, updating the goal and assumptions as it learns more. */
  private async ask(state: InterviewState): Promise<InterviewState> {
    const [settings, root] = await Promise.all([
      this.ports.settings(),
      this.ports.projectRoot(state.projectId, state.linkedProjectId),
    ]);
    const context = await loadProjectContext(root, undefined, INTERVIEW_CONTEXT_CHARS).catch(() => null);
    const styleReference = (await this.ports.spec.read?.(root, STUDIO_STYLE_REFERENCE_NOTES_PATH).catch(() => null)) ?? null;
    const history = await this.ports.store.list();
    const stackRecommendation = stackRecommendationFromHistory(history.filter((item) => item.projectId !== state.projectId));
    const reply = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      buildInterviewPrompt({ ...state, stackRecommendation }, context, styleReference),
      'kai_project_interview',
      INTERVIEW_JSON_SCHEMA,
      parseInterviewReply,
    );
    // What the model has learned about which topics matter replaces the earlier weighing; the person's own calls are kept.
    const importance = mergeImportance(state.importance, reply.importance);
    const asked = new Set(state.rounds.flatMap((round) => round.questions.map(normalise)));
    const remaining = Math.max(0, interviewQuestionBudget(state) - asked.size);
    let fresh: Array<{ question: string; options: string[] }> = reply.questions
      .filter((item) => !asked.has(normalise(item.question)))
      .slice(0, Math.min(roundLimit(state.rounds.length), remaining));
    // The first question is about the first gap in the idea that matters here; a gap marked not needed is not asked.
    const firstGap = state.ideaGaps.find((gap) => importance[gap]?.level !== 'skip');
    if (state.rounds.length === 0 && firstGap && remaining > 0) {
      fresh = [topicQuestion(firstGap)];
    }
    const hasTopicMap = Object.keys(reply.topics).length > 0;
    const topics = { ...state.topics, ...reply.topics };
    // A topic-aware reply must resolve required gaps before finishing; old replies retain the legacy guard.
    const required = fresh.length === 0
      ? hasTopicMap ? missingOpenTopicQuestion(state.idea, reply.topics, importance) : missingRequiredQuestion(state)
      : null;
    if (required && remaining > 0) fresh.push(required);
    if (stackRecommendation) {
      const stack = clipToLength(stackRecommendation.stack, 72);
      const recommended = clipOption(`${stack} (recommended; used by last ${stackRecommendation.projectCount} projects)`);
      fresh = fresh.map((item) => /\b(stack|framework|technology|built with|database)\b/i.test(item.question)
        ? (() => {
          const alternatives = item.options.filter((option) => normalise(option) !== normalise(recommended));
          const notSure = alternatives.find((option) => /not sure|you decide/i.test(option));
          const options = [recommended, ...alternatives.filter((option) => option !== notSure)].slice(0, STUDIO_MAX_OPTIONS - (notSure ? 1 : 0));
          return { ...item, options: notSure ? [...options, notSure] : options };
        })()
        : item);
    }
    const questions = fresh.map((item) => item.question);
    const next: InterviewState = {
      ...state,
      goal: reply.goal,
      assumptions: mergeAssumptions(reply.assumptions, state.assumptions).slice(0, STUDIO_MAX_ASSUMPTIONS),
      topics,
      importance,
      rounds: [...state.rounds, { questions, options: fresh.map((item) => item.options), answers: [] }],
      updatedAt: this.ports.now(),
    };
    // A round with no questions means the model knows enough: stop asking and invite review.
    return questions.length > 0 ? next : { ...next, rounds: state.rounds, status: 'reviewing' };
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

/** True when the idea or any question or answer so far already covers the pattern. */
function covered(state: Pick<InterviewState, 'idea' | 'rounds'>, pattern: RegExp): boolean {
  const said = [state.idea, ...state.rounds.flatMap((round) => [...round.questions, ...round.answers.map((item) => item.answer)])];
  return said.some((text) => pattern.test(text));
}

const STACK_PATTERN = /\b(tech(nology)? stack|stack|framework|react|next\.?js|vue|svelte|angular|django|laravel|rails|node|python|typescript|php|postgres|mysql|sqlite|supabase|firebase|mongodb|flutter|electron|swift|kotlin)\b/i;
const DESIGN_PATTERN = /\b(colou?rs?|palette|visual design|look and feel|brand|dark mode|light mode|style|theme)\b/i;
const SCREEN_PATTERN = /\b(app|web ?site|dashboard|portal|page|screen|ui|interface|platform|store|game)\b/i;

/** The stack, then the design, when the interview is about to end without either having been settled. */
function missingRequiredQuestion(state: Pick<InterviewState, 'idea' | 'rounds'>): { question: string; options: string[] } | null {
  if (!covered(state, STACK_PATTERN)) {
    return {
      question: 'What should it be built with? Pick a stack, or let me choose one that suits it.',
      options: ['Next.js + TypeScript + PostgreSQL (recommended)', 'React + Node.js + a hosted database', 'Python (Django) + PostgreSQL', 'Laravel (PHP) + MySQL', 'Not sure, you decide'],
    };
  }
  if (SCREEN_PATTERN.test(state.idea) && !covered(state, DESIGN_PATTERN)) {
    return {
      question: 'What look should it have? You can attach reference images of a style you like with the image button.',
      options: ['Clean and light, one accent colour (recommended)', 'Dark and modern', 'Bold and colourful', 'Match my brand colours', 'Not sure, you decide'],
    };
  }
  return null;
}

/** The nine topics every interview used to force, which is what an interview saved before importance existed still uses. */
const LEGACY_TOPICS = ['users', 'data', 'stack', 'hosting', 'integrations', 'auth', 'payments', 'design', 'acceptance'] as const;

/**
 * The next topic the interview must ask about before it may finish. When the model has weighed the topics for this
 * project, that is the ones it marked "must" and still has open; a topic marked skip is never forced. An interview
 * saved before the weighing existed falls back to the old rule (every topic, with design only for something with a screen).
 */
function missingOpenTopicQuestion(idea: string, topics: InterviewState['topics'], importance: InterviewImportance = {}): { question: string; options: string[] } | null {
  const keys = Object.keys(INTERVIEW_TOPICS) as Array<keyof typeof INTERVIEW_TOPICS>;
  const weighed = Object.keys(importance).length > 0;
  const required = weighed
    ? keys.filter((key) => importance[key]?.level === 'must')
    : LEGACY_TOPICS.filter((key) => key !== 'design' || SCREEN_PATTERN.test(idea));
  const open = required.find((key) => topics[key]?.status === 'open');
  if (!open) return null;
  return topicQuestion(open);
}

/** The model's fresh weighing wins over its earlier one, except a topic the person set themselves, which stays. */
function mergeImportance(current: InterviewImportance, fresh: InterviewImportance): InterviewImportance {
  const merged: InterviewImportance = { ...current, ...fresh };
  for (const [key, entry] of Object.entries(current) as Array<[keyof InterviewImportance, NonNullable<InterviewImportance[keyof InterviewImportance]>]>) {
    if (entry.reason === YOUR_CALL) merged[key] = entry;
  }
  return merged;
}

/** The reason recorded when the person, not the model, decided whether a topic matters. */
export const YOUR_CALL = 'You decided this.';

function topicQuestion(topic: keyof typeof INTERVIEW_TOPICS): { question: string; options: string[] } {
  const questions: Record<keyof typeof INTERVIEW_TOPICS, string> = {
    users: 'Who will use it, and what should each person be able to do?',
    data: 'What information should it store, and where should that information live?',
    stack: 'What technology should it be built with, or should I recommend a stack?',
    hosting: 'Where should the finished app run?',
    integrations: 'Which services should it connect to?',
    auth: 'Do people need accounts, and what should each role be allowed to do?',
    payments: 'Will the app take or manage payments?',
    design: 'What should the visual style look like?',
    acceptance: 'How will you know the first version is working well?',
    scope: 'What must the first version do, and what can wait for later?',
    platform: 'Where will people use it: the web, a phone, a desktop app, or more than one?',
    security: 'How private is the information in it, and who must never be able to see it?',
    quality: 'How carefully should it be tested, and does it need to be fast or work offline?',
    constraints: 'Is there a deadline, a budget, or anything it must use or avoid?',
  };
  return { question: questions[topic], options: ['I will decide', 'Not sure, you decide'] };
}

/** The reason a model call failed, short enough to show in a notice. */
function failureText(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  return text.trim().slice(0, 600) || 'The model did not reply.';
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
export function buildInterviewPrompt(state: Pick<InterviewState, 'idea' | 'goal' | 'assumptions' | 'rounds'> & Partial<Pick<InterviewState, 'topics' | 'importance' | 'ideaSummary' | 'ideaGaps' | 'ideaStated'>> & { extraQuestions?: number; stackRecommendation?: { stack: string; projectCount: number } | null }, context: string | null, styleReference: string | null = null): { system: string; user: string } {
  const system = [
    'You are the Project Studio inside KAI, a desktop workbench where a team of coding agents builds software.',
    'The user has described a project in a paragraph. Your job is to close the gaps that would make the agents guess, before anything is written down as a requirement.',
    'Return only JSON matching the schema, with no markdown fences.',
    '',
    'Write:',
    '- "goal": the project restated as one clear, specific goal (what is built, for whom, and what "done" looks like).',
    `- "assumptions": objects with "text", "risk" (high, medium or low: how much a wrong guess changes what is built), and "status" (assumed). Keep them short and concrete, under ${STUDIO_MAX_ASSUMPTION_CHARS} characters, and order high risk first.`,
    '- "topics": for each project topic, return status decided, assumed or open, and a short source such as "idea", "answer 2" or "assumed: ...". Include all topic keys even when open.',
    '- "importance": for each topic, how much it matters for THIS project given everything the user has said: must, worth or skip, with a one-plain-sentence reason. Change an earlier judgement when an answer shows it was wrong. Never mark a topic skip just because it has not come up; a topic marked skip is not asked about, and the user can see why.',
    state.stackRecommendation ? `- The user's last ${state.stackRecommendation.projectCount} projects shared ${state.stackRecommendation.stack}. Offer it first as the recommended stack option.` : '',
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
    for (const item of round.answers) (item.answer ? answered : skipped).push(item.answer ? `Q: ${item.question}\nA: ${item.summary ?? item.answer}` : item.question);
  }
  const user = [
    `Project described by the user:\n${state.idea}`,
    state.goal ? `Goal so far:\n${state.goal}` : '',
    `Topic coverage so far:\n${JSON.stringify(state.topics ?? {})}`,
    state.importance && Object.keys(state.importance).length > 0 ? `How much each topic matters here, so far:\n${JSON.stringify(state.importance)}` : '',
    state.ideaSummary ? `Read idea summary:\n${state.ideaSummary}` : '',
    state.ideaStated?.length ? `Already covered in the idea: ${state.ideaStated.map((topic) => INTERVIEW_TOPICS[topic]).join(', ')}` : '',
    state.ideaGaps?.length ? `Gaps in the idea (ask about these first): ${state.ideaGaps.map((topic) => INTERVIEW_TOPICS[topic]).join(', ')}` : '',
    state.rounds.length === 0 ? `Original idea:\n${state.idea}` : '',
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
      .flatMap((item) => {
        if (typeof item === 'string') return item.trim() ? [{ text: clipToLength(item, STUDIO_MAX_ASSUMPTION_CHARS), risk: 'medium', status: 'assumed' }] : [];
        if (typeof item !== 'object' || item === null) return [];
        const assumption = item as Record<string, unknown>;
        if (typeof assumption.text !== 'string' || !assumption.text.trim()) return [];
        return [{ text: clipToLength(assumption.text, STUDIO_MAX_ASSUMPTION_CHARS), risk: assumption.risk, status: assumption.status }];
      })
      .slice(0, STUDIO_MAX_ASSUMPTIONS);
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
export function parseInterviewReply(content: string): { goal: string; assumptions: InterviewState['assumptions']; topics: InterviewState['topics']; importance: InterviewImportance; questions: Array<{ question: string; options: string[] }> } {
  const raw = withinShape(parseJsonResponse(content, 'Project Studio'));
  const parsed = lenient(interviewReplySchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  return {
    goal: parsed.data.goal,
    assumptions: parsed.data.assumptions.slice(0, STUDIO_MAX_ASSUMPTIONS),
    topics: parsed.data.topics,
    importance: parsed.data.importance,
    questions: dedupeReplyQuestions(parsed.data.questions),
  };
}

export function parseInterviewIdeaRead(content: string): InterviewIdeaReadResult {
  const parsed = lenient(interviewIdeaReadResultSchema).safeParse(parseJsonResponse(content, 'Project Studio idea read'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio idea read did not match the expected shape (${issue ? `${issue.path.join('.') || 'result'}: ${issue.message}` : 'unknown error'}).`);
  }
  return parsed.data;
}

export function parseInterviewLongAnswer(content: string): InterviewLongAnswerResult {
  const parsed = lenient(interviewLongAnswerResultSchema).safeParse(parseJsonResponse(content, 'Project Studio long answer summary'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The long answer summary did not match the expected shape (${issue ? `${issue.path.join('.') || 'result'}: ${issue.message}` : 'unknown error'}).`);
  }
  return parsed.data;
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
    state.assumptions.length > 0 ? state.assumptions.map((item) => `- [${item.risk} risk; ${item.status}] ${item.text}`).join('\n') : '- None recorded.',
    '## What you decided',
    [...state.assumptionDecisions, ...decided].length > 0 ? [...state.assumptionDecisions, ...decided].map((item) => `**${item.question}**\n\n${item.answer}`).join('\n\n') : 'No questions were answered.',
    open.length > 0 ? `## Left to the agents\n\n${open.map((question) => `- ${question}`).join('\n')}` : '',
    '## Coverage',
    ['| Topic | Matters here | Status | Source |', '| --- | --- | --- | --- |', ...Object.entries(INTERVIEW_TOPICS).map(([key, label]) => {
      const topic = state.topics[key as keyof typeof INTERVIEW_TOPICS];
      const weight = state.importance[key as keyof typeof INTERVIEW_TOPICS];
      const matters = weight ? `${weight.level === 'must' ? 'Needs deciding' : weight.level === 'worth' ? 'Worth settling' : 'Not needed'}${weight.reason ? `: ${weight.reason}` : ''}` : 'not weighed';
      return `| ${label} | ${matters} | ${topic?.status ?? 'open'} | ${topic?.source ?? 'not covered'} |`;
    })].join('\n'),
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

/** Retains user-confirmed or changed assumptions when the model supplies the next set. */
function mergeAssumptions(reply: InterviewState['assumptions'], previous: InterviewState['assumptions']): InterviewState['assumptions'] {
  const merged = [...reply];
  for (const item of previous) {
    if (item.status === 'assumed') continue;
    const at = merged.findIndex((candidate) => normalise(candidate.text) === normalise(item.text));
    if (at >= 0) merged[at] = item;
    else merged.push(item);
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return merged.sort((left, right) => order[left.risk] - order[right.risk]);
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
