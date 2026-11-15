import * as path from 'node:path';
import { CREW_INTERVIEW_TOPICS, crewInterviewSchema, type AppSettings, type CrewInterview, type CrewInterviewInput, type CrewInterviewTopic } from '@kai/contracts';
import type { StructuredRequester } from './prompt-guide';
import { ReplyShapeError } from './learning-tutor';

const NAMES = { feature: 'the Crew', card: 'Crew' };
/** Enough of a plan file to see its parts and rules, without sending a long document whole. */
const DIGEST_CHARS = 26_000;
const MAX_FILES = 3;
const MAX_MODEL_QUESTIONS = 3;

export interface CrewInterviewPorts {
  settings(): Promise<AppSettings>;
  requester: StructuredRequester;
  /** The folder a relative path in the goal is read from. */
  projectRoot(projectId: string): Promise<string>;
  /** A text file's contents, or null when it is missing, too big or not text. */
  readText(absolutePath: string): Promise<string | null>;
  /** The project's Studio brief, if it has one. */
  readBrief(projectId: string): Promise<string | null>;
}

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'phases', 'topics', 'questions'],
  properties: {
    summary: { type: 'string' },
    phases: { type: 'array', items: { type: 'string' } },
    topics: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'importance', 'reason'],
        properties: { key: { type: 'string', enum: ['scope', 'done', 'run'] }, importance: { type: 'string', enum: ['must', 'worth', 'skip'] }, reason: { type: 'string' } },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['topic', 'question', 'why', 'options'],
        properties: { topic: { type: 'string', enum: ['scope', 'done', 'run'] }, question: { type: 'string' }, why: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
} as const;

/** File paths a goal points at: quoted or bare, ending in a text-document extension. */
export function goalFilePaths(goal: string): string[] {
  const found: string[] = [];
  const quoted = /"([^"\r\n]+\.(?:md|markdown|txt|rst|adoc))"/gi;
  const bare = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']*[\\/][^\s"']+\.(?:md|markdown|txt|rst|adoc))(?=\s|$|[.,;:!?)])/gi;
  for (const pattern of [quoted, bare]) {
    for (const match of goal.matchAll(pattern)) {
      const file = match[1]?.trim();
      if (file && !found.includes(file)) found.push(file);
    }
  }
  return found.slice(0, MAX_FILES);
}

/**
 * The parts of a plan document worth reading before planning: every heading, the opening, and the sections whose
 * heading says they hold phases, scope, acceptance, approvals or rules. A long plan keeps its shape in about 26k
 * characters instead of being cut off before the part that matters.
 */
export function digestPlanText(text: string, budget = DIGEST_CHARS): string {
  if (text.length <= budget) return text;
  const lines = text.split(/\r?\n/);
  const headingAt = lines.flatMap((line, index) => (/^#{1,4}\s/.test(line) ? [index] : []));
  const outline = headingAt.map((index) => lines[index]!.trim()).join('\n');
  const opening = text.slice(0, 5_000);
  const wanted = /phase|milestone|roadmap|scope|acceptance|approv|rule|constraint|done when|out of scope|risk/i;
  const sections: string[] = [];
  for (let i = 0; i < headingAt.length; i += 1) {
    const heading = lines[headingAt[i]!]!;
    if (!wanted.test(heading)) continue;
    const end = headingAt[i + 1] ?? lines.length;
    sections.push(lines.slice(headingAt[i]!, end).join('\n').slice(0, 2_500));
  }
  const parts = ['[Outline]', outline, '', '[Opening]', opening, '', '[Sections about phases, scope, acceptance and rules]', sections.join('\n\n')];
  const joined = parts.join('\n');
  return joined.length > budget ? `${joined.slice(0, budget - 1)}…` : joined;
}

export function buildCrewInterviewPrompt(input: { goal: string; digest: string; brief: string | null; files: readonly string[] }): { system: string; user: string } {
  const system = [
    'You prepare a crew of coding agents before it plans a build. Work out what you cannot tell from the goal and the material below.',
    'Never assume. Ask only about things whose answer would change what gets built, and at most three questions in all.',
    'Write for someone who is not very technical: short sentences, no jargon, and say what a term means the first time.',
    'Topics: scope is how much to do now (when the goal or plan has several phases, which of them); done is what proves it is finished; run is how it is run or installed, and only matters when there is something to run.',
    'For each topic say whether it matters for this goal (must, worth or skip) and why in one plain sentence. A topic the goal already answers is skip, and the reason names where it is answered.',
    'Give every question two to five short answer options a person could choose between. When the plan itself recommends an answer, make it the first option.',
    'List "phases" only when the goal or the plan is split into named parts; otherwise leave it empty.',
    'Reply with only the JSON object.',
  ].join('\n');
  const user = [
    `Goal:\n${input.goal}`,
    ...(input.brief ? [`\nThe project's brief:\n${input.brief.slice(0, 3_000)}`] : []),
    ...(input.digest ? [`\nFiles the goal points at (${input.files.join(', ')}):\n${input.digest}`] : []),
  ].join('\n');
  return { system, user };
}

/** Reads the model's reply into an interview: questions only for topics that matter, and the rest listed as left out. */
export function parseCrewInterview(text: string): CrewInterview | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const raw = value as { summary?: unknown; phases?: unknown; topics?: unknown; questions?: unknown };
  const topics = Array.isArray(raw.topics) ? raw.topics : [];
  const importance = new Map<CrewInterviewTopic, { level: string; reason: string }>();
  for (const item of topics) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { key?: unknown; importance?: unknown; reason?: unknown };
    if (entry.key !== 'scope' && entry.key !== 'done' && entry.key !== 'run') continue;
    importance.set(entry.key, { level: String(entry.importance ?? 'worth'), reason: typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 300) : '' });
  }
  const items: CrewInterview['items'] = [];
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  for (const item of questions) {
    if (items.length >= MAX_MODEL_QUESTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const entry = item as { topic?: unknown; question?: unknown; why?: unknown; options?: unknown };
    if (entry.topic !== 'scope' && entry.topic !== 'done' && entry.topic !== 'run') continue;
    // A question for a topic the model itself marked as not needed is dropped rather than asked.
    if (importance.get(entry.topic)?.level === 'skip') continue;
    const question = typeof entry.question === 'string' ? entry.question.trim().slice(0, 400) : '';
    if (!question) continue;
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).map((option) => option.trim().slice(0, 160)).slice(0, 5)
      : [];
    items.push({ id: `q${items.length + 1}`, topic: entry.topic, question, why: typeof entry.why === 'string' ? entry.why.trim().slice(0, 400) : '', options });
  }
  const asked = new Set(items.map((item) => item.topic));
  const left = [...importance.entries()]
    .filter(([topic, info]) => info.level === 'skip' && !asked.has(topic))
    .map(([topic, info]) => ({ topic, reason: info.reason }));
  const phases = Array.isArray(raw.phases)
    ? raw.phases.filter((phase): phase is string => typeof phase === 'string' && phase.trim().length > 0).map((phase) => phase.trim().slice(0, 200)).slice(0, 20)
    : [];
  const parsed = crewInterviewSchema.safeParse({ summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 1_200) : '', phases, items, left, usedFiles: [], note: '' });
  return parsed.success ? parsed.data : null;
}

/**
 * Adds the one question the model is not trusted to word: how far to go without checking in. It is asked only when the
 * work has more than one phase, because with a single part there is nothing to stop between.
 */
export function withAutonomyQuestion(interview: CrewInterview): CrewInterview {
  if (interview.phases.length < 2 || interview.items.some((item) => item.topic === 'autonomy')) return interview;
  return {
    ...interview,
    items: [...interview.items, {
      id: 'autonomy',
      topic: 'autonomy' as const,
      question: 'How far should the crew go before it checks in with you?',
      why: `This work has ${interview.phases.length} parts. You can have it stop after each one, or carry on through all of them.`,
      options: ['Stop after each phase and ask me', 'Keep going through every phase'],
    }].slice(0, 6),
  };
}

export class DesktopCrewInterview {
  constructor(private readonly ports: CrewInterviewPorts) {}

  /**
   * Reads the goal, and any plan file it names, and returns the few questions worth asking. It is optional help: when
   * the model is not set up or does not answer, the result says so and has no questions, and the crew simply plans.
   */
  async run(input: CrewInterviewInput): Promise<CrewInterview> {
    const empty = (note: string): CrewInterview => ({ summary: '', phases: [], items: [], left: [], usedFiles: [], note });
    const settings = await this.ports.settings();
    if (!settings.promptGuide.enabled) return empty('The Prompt Guide model is off, so there are no questions. Turn it on under Settings to be asked before the crew plans.');

    const root = await this.ports.projectRoot(input.projectId).catch(() => '');
    const used: string[] = [];
    const digests: string[] = [];
    for (const file of goalFilePaths(input.goal)) {
      const absolute = path.isAbsolute(file) ? file : root ? path.join(root, file) : '';
      if (!absolute) continue;
      const text = await this.ports.readText(absolute).catch(() => null);
      if (!text) continue;
      used.push(path.basename(absolute));
      digests.push(`--- ${path.basename(absolute)} ---\n${digestPlanText(text, Math.floor(DIGEST_CHARS / Math.min(MAX_FILES, Math.max(1, goalFilePaths(input.goal).length))))}`);
    }
    const brief = await this.ports.readBrief(input.projectId).catch(() => null);

    try {
      const parsed = await this.ports.requester.structuredRequest(
        settings.promptGuide,
        NAMES,
        buildCrewInterviewPrompt({ goal: input.goal, digest: digests.join('\n\n'), brief, files: used }),
        'kai_crew_interview',
        JSON_SCHEMA,
        (content) => {
          const read = parseCrewInterview(content);
          if (!read) throw new ReplyShapeError('The Lead\'s reply was not the questions in the shape asked for.');
          return read;
        },
      );
      return withAutonomyQuestion({ ...parsed, usedFiles: used });
    } catch (error) {
      return empty(`The Lead could not read the goal just now (${error instanceof Error ? error.message.slice(0, 160) : 'no reply'}), so the crew will plan without questions.`);
    }
  }
}

export { CREW_INTERVIEW_TOPICS };
