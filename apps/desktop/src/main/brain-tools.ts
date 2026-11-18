import type { BrainEntry } from '@kai/contracts';
import type { ExternalToolPort, ProjectToolExecution, ProjectToolPolicy } from './project-tools';

/**
 * What a run needs from the brain (C1) to read and write it for one project. The project name is worked out from
 * the folder, so a model never has to know it; a failure is an answer, not an exception.
 */
export interface BrainAccess {
  recall(projectRoot: string, query: string): Promise<{ ok: true; entries: readonly BrainEntry[] } | { ok: false; reason: string }>;
  remember(projectRoot: string, entry: BrainRemembered): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface BrainRemembered {
  title: string;
  type: 'decisions' | 'patterns' | 'bugs' | 'gotchas';
  note: string;
  why?: string;
  how?: string;
  tags?: string;
}

export const BRAIN_RECALL_TOOL = 'brain_recall';
export const BRAIN_REMEMBER_TOOL = 'brain_remember';
const ENTRY_TYPES = ['decisions', 'patterns', 'bugs', 'gotchas'] as const;
const MAX_FIELD = 1_500;

/** What a model that can use the brain is told about it, appended to its project context. */
export const BRAIN_TOOLS_GUIDANCE = [
  '# The project brain',
  `Two tools reach the project's long-term memory, which outlives this conversation and every summary of it: ${BRAIN_RECALL_TOOL} to look something up, ${BRAIN_REMEMBER_TOOL} to keep something.`,
  `Before you change code in an area you have not seen, call ${BRAIN_RECALL_TOOL} with what you are about to touch. Decisions, constraints and past mistakes are kept there.`,
  `Call ${BRAIN_REMEMBER_TOOL} when you learn something a later run would need and could not read from the code: a decision and the reason for it, the direction the user chose, a rule the code must follow, a bug and what fixed it, a gotcha or a command that works here. One fact per call, in plain words. Do not keep secrets, or what the code already says.`,
  "The Architect's plans and decisions are filed here by KAI as they are made, and also kept in .kai/ARCHITECT.md, which is loaded above. Read both before you build.",
].join('\n');

function text(value: unknown, limit = MAX_FIELD): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function describe(entry: BrainEntry): string {
  const fields = Object.entries(entry.fields)
    .filter(([, value]) => value.trim())
    .map(([name, value]) => `${name}: ${value.trim().slice(0, 400)}`)
    .join('\n');
  return `[${entry.type}] ${entry.title} (${entry.date.slice(0, 10)})${fields ? `\n${fields}` : ''}`;
}

/**
 * Adds the two brain tools to a run's outside tools. They change memory, not files, so every access level may use
 * them: a planning run is exactly the one that should be recording decisions.
 */
export function withBrainTools(port: ExternalToolPort | undefined, projectRoot: string, brain: BrainAccess): ExternalToolPort {
  const definitions = [
    {
      type: 'function',
      name: BRAIN_RECALL_TOOL,
      description: 'Look up what the project brain remembers: decisions, constraints, past bugs and how they were fixed. Use it before changing code you have not seen.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What you are about to work on, in a few words (a feature, file or topic).' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: BRAIN_REMEMBER_TOOL,
      description: 'Keep one fact in the project brain so later runs and other agents have it: a decision and its reason, a rule the code must follow, a bug and its fix, a command that works. Not for secrets or what the code already shows.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short headline for the fact.' },
          type: { type: 'string', enum: [...ENTRY_TYPES], description: 'decisions (a choice made and why), patterns (how the code should be written), bugs (a problem and its fix), gotchas (a trap or a command that works only a certain way).' },
          note: { type: 'string', description: 'The fact itself, in plain words.' },
          why: { type: 'string', description: 'Why it is so, or why it was chosen.' },
          how: { type: 'string', description: 'How to apply it next time.' },
          tags: { type: 'string', description: 'Comma-separated topics.' },
        },
        required: ['title', 'type', 'note'],
        additionalProperties: false,
      },
    },
  ];
  const own = new Set([BRAIN_RECALL_TOOL, BRAIN_REMEMBER_TOOL]);
  return {
    definitions: async () => [...(port ? await port.definitions().catch(() => []) : []), ...definitions],
    policy: (name, autonomy): ProjectToolPolicy | undefined => own.has(name) ? { decision: 'allow' } : port?.policy(name, autonomy),
    execute: async (name, input, signal): Promise<ProjectToolExecution | undefined> => {
      if (!own.has(name)) return port?.execute(name, input, signal);
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (name === BRAIN_RECALL_TOOL) {
        const query = text(args.query, 300);
        if (!query) return { ok: false, output: { error: 'Say what to look up: pass a short query.' } };
        const found = await brain.recall(projectRoot, query);
        if (!found.ok) return { ok: false, output: { error: found.reason } };
        return { ok: true, output: found.entries.length === 0 ? 'The brain has nothing on that yet.' : found.entries.map(describe).join('\n\n') };
      }
      const title = text(args.title, 160);
      const note = text(args.note);
      const type = ENTRY_TYPES.find((candidate) => candidate === args.type);
      if (!title || !note || !type) return { ok: false, output: { error: `Give a title, a note and a type (${ENTRY_TYPES.join(', ')}).` } };
      const why = text(args.why);
      const how = text(args.how);
      const tags = text(args.tags, 200);
      const saved = await brain.remember(projectRoot, { title, type, note, ...(why ? { why } : {}), ...(how ? { how } : {}), ...(tags ? { tags } : {}) });
      return saved.ok
        ? { ok: true, output: 'Kept in the project brain.' }
        : { ok: false, output: { error: saved.reason } };
    },
  };
}
