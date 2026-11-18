import { z } from 'zod';
import { contextChipSchema } from './context';
import { agentIdSchema, executionModeSchema, providerIdSchema, type AgentId, type ProviderId } from './primitives';
import { goalInputSchema } from './workbench';

/**
 * The Architect / Implementer split.
 *
 * One agent (the Architect) plans, reviews and sends work back; another (the Implementer) writes the code. Each role
 * is a *target*: either a CLI agent signed in on this machine, or an API connection — a provider, optionally its own
 * address and credential, and a model. Two roles can therefore use two different keys, two different vendors, or a
 * model running on this computer.
 */

/**
 * An API connection for one run. Anything left out comes from the provider's preset, and the credential from the
 * preset's own credential id, so `{ provider: 'anthropic' }` alone means "the Anthropic key already saved".
 */
export const apiConnectionSchema = z
  .object({
    provider: providerIdSchema,
    baseUrl: z.string().url().max(500).optional(),
    credentialId: z.string().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ApiConnection = z.infer<typeof apiConnectionSchema>;

export const roleTargetSchema = z
  .object({
    execution: executionModeSchema,
    /** The CLI agent, when `execution` is `cli`. */
    agent: agentIdSchema.optional(),
    /** The CLI model for this role; without it the agent's own default (or Auto's tiering) applies. */
    model: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.6-sol or claude-sonnet-5.')
      .optional(),
    /** The API connection, when `execution` is `api`. */
    api: apiConnectionSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.execution === 'cli' && !target.agent) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['agent'], message: 'A CLI role needs an agent.' });
    }
    if (target.execution === 'api' && !target.api) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['api'], message: 'An API role needs a connection.' });
    }
  });
export type RoleTarget = z.infer<typeof roleTargetSchema>;

export const ARCHITECT_ROLES = ['architect', 'implementer', 'worker', 'fallback'] as const;
export type ArchitectRole = (typeof ARCHITECT_ROLES)[number];

export const architectSplitSchema = z
  .object({
    enabled: z.boolean(),
    architect: roleTargetSchema.nullable(),
    implementer: roleTargetSchema.nullable(),
    /** Stands in when the Architect is unavailable. Null means "the Implementer". */
    fallback: roleTargetSchema.nullable(),
    /**
     * An optional second builder, usually a model on this computer, for the routine edits: the steps the Architect
     * marks mechanical and the corrections it says are mechanical. The Implementer keeps the hard parts. Left out, the
     * Implementer does everything, exactly as before.
     */
    worker: roleTargetSchema.nullable().optional(),
  })
  .strict();
export type ArchitectSplit = z.infer<typeof architectSplitSchema>;

export function defaultArchitectSplit(): ArchitectSplit {
  return { enabled: false, architect: null, implementer: null, fallback: null };
}

/** A split that is on and has both main roles chosen. */
export type ActiveArchitectSplit = ArchitectSplit & { enabled: true; architect: RoleTarget; implementer: RoleTarget };

/** The Worker, when the split is active and one is chosen. */
export function splitWorker(split: ArchitectSplit | null | undefined): RoleTarget | null {
  return architectSplitActive(split) ? (split.worker ?? null) : null;
}

/** The split only does anything once it is on and both main roles are chosen. */
export function architectSplitActive(split: ArchitectSplit | null | undefined): split is ActiveArchitectSplit {
  return Boolean(split?.enabled && split.architect && split.implementer);
}

/** A stable identity for a target, so a selection can be compared and remembered without display names. */
export function roleTargetKey(target: RoleTarget): string {
  if (target.execution === 'cli') return `cli:${target.agent ?? ''}:${target.model ?? ''}`;
  const api = target.api;
  return `api:${api?.provider ?? ''}:${api?.credentialId ?? ''}:${api?.baseUrl ?? ''}:${api?.model ?? ''}`;
}

/** The provider an API role talks to, or null for a CLI role. */
export function roleProvider(target: RoleTarget): ProviderId | null {
  return target.execution === 'api' ? (target.api?.provider ?? null) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The brief and the verdict
// ---------------------------------------------------------------------------------------------------------------------

/** What the Architect hands the Implementer: small and structured, so the Implementer works from it and not from chat. */
export const architectBriefSchema = z
  .object({
    goal: z.string().trim().min(1).max(2_000),
    /** Files the work is expected to touch. */
    files: z.array(z.string().trim().min(1).max(500)).max(60).default([]),
    /** Things the Implementer must leave alone. */
    avoid: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
    /** What must be true when the work is done; the review is judged against exactly these. */
    doneChecks: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
    /**
     * A test or typecheck command that proves the work, which KAI runs before the review and which can overrule an
     * approval. Only a command on the safe list is ever run (see `isSafeCheckCommand`): the Architect is read-only, and
     * a command it writes must not be a way round that.
     */
    checkCommand: z.string().trim().max(300).optional(),
    /**
     * Mechanical steps for the Worker, when there is one: renames, boilerplate, tests, docs, applying a listed edit.
     * Each must be specific enough to do without judgement. Left out, the Implementer does all the work.
     */
    routine: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  })
  .strict();
export type ArchitectBrief = z.infer<typeof architectBriefSchema>;

export const ARCHITECT_VERDICTS = ['approve', 'revise', 'replan'] as const;
export type ArchitectVerdictKind = (typeof ARCHITECT_VERDICTS)[number];

export const architectVerdictSchema = z
  .object({
    verdict: z.enum(ARCHITECT_VERDICTS),
    summary: z.string().trim().min(1).max(1_000),
    /** Specific things to fix, for `revise`. */
    corrections: z.array(z.string().trim().min(1).max(600)).max(30).default([]),
    /** A replacement brief, for `replan`. */
    brief: architectBriefSchema.optional(),
    /** For `revise`: true when every correction is mechanical, so the Worker can apply them instead of the Implementer. */
    routine: z.boolean().optional(),
  })
  .strict();
export type ArchitectVerdict = z.infer<typeof architectVerdictSchema>;

/** Exact markers, like the Auto split directive: intent is read from a token and JSON, never guessed from prose. */
export const ARCHITECT_BRIEF_SENTINEL = '<<KAI_BRIEF>>';
export const ARCHITECT_VERDICT_SENTINEL = '<<KAI_VERDICT>>';
/** The Implementer's closing report, on its own line followed by JSON of this shape, after every turn. */
export const ARCHITECT_REPORT_SENTINEL = '<<KAI_REPORT>>';
export const architectReportSchema = z
  .object({
    /** Project-relative paths it says it changed. */
    filesChanged: z.array(z.string().trim().min(1).max(400)).max(200).default([]),
    /** Commands it ran, with how they came out. */
    checksRun: z.array(z.string().trim().min(1).max(400)).max(50).default([]),
    /** What it did not get to. */
    unfinished: z.array(z.string().trim().min(1).max(400)).max(50).default([]),
  })
  .strict();
export type ArchitectReport = z.infer<typeof architectReportSchema>;
/** Printed by the Implementer, on its own line, when it cannot make progress and wants the Architect to step in. */
export const ARCHITECT_STUCK_SENTINEL = '<<KAI_STUCK>>';

// ---------------------------------------------------------------------------------------------------------------------
// What the person sees while a split run is going
// ---------------------------------------------------------------------------------------------------------------------

export const ARCHITECT_PHASES = [
  'preparing',
  'planning',
  'implementing',
  'reviewing',
  'correcting',
  'replanning',
  'waiting-for-you',
  'finished',
  'stopped',
  'failed',
] as const;
export type ArchitectPhase = (typeof ARCHITECT_PHASES)[number];

export const architectLogEntrySchema = z
  .object({
    at: z.string().min(1),
    /** Who said it; null for the loop itself. */
    role: z.enum(['architect', 'implementer']).nullable(),
    text: z.string().max(600),
  })
  .strict();
export type ArchitectLogEntry = z.infer<typeof architectLogEntrySchema>;

export const architectStatusSchema = z
  .object({
    conversationId: z.string().min(1),
    projectId: z.string().min(1),
    phase: z.enum(ARCHITECT_PHASES),
    /** The role working right now. */
    role: z.enum(['architect', 'implementer']).nullable(),
    /** Who is working, in words: "Claude · opus", "DeepSeek API · deepseek-v4-pro". */
    label: z.string().max(200),
    message: z.string().max(600),
    /** Implement → review rounds so far. */
    round: z.number().int().min(0),
    /** Set when the Architect was unavailable and its stand-in is working instead. */
    fallbackUsed: z.boolean(),
    architectLabel: z.string().max(200),
    implementerLabel: z.string().max(200),
    /** What each role has cost so far, in USD, so a strong planner's share is visible next to the builder's. */
    architectCostUsd: z.number().min(0).default(0),
    implementerCostUsd: z.number().min(0).default(0),
    startedAt: z.string().nullable(),
    updatedAt: z.string().min(1),
    log: z.array(architectLogEntrySchema).max(80),
  })
  .strict();
export type ArchitectStatus = z.infer<typeof architectStatusSchema>;
export const architectStatusResponseSchema = architectStatusSchema.nullable();

export const architectRunInputSchema = z
  .object({
    /** Continue an open conversation; without it one is created and opened for the task. */
    conversationId: z.string().min(1).optional(),
    projectId: z.string().min(1),
    prompt: z.string().trim().min(1).max(20_000),
    split: architectSplitSchema,
    route: z.enum(['direct', 'proxy']),
    autonomy: z.enum(['plan', 'ask', 'autoEdit', 'full', 'custom']),
    /** The composer's agent, used only where a request must name one and the role is an API. */
    agent: agentIdSchema,
    /** The composer's execution mode, put back on the conversation when the run ends. */
    execution: executionModeSchema.optional(),
    goal: goalInputSchema.optional(),
    skills: z.array(z.string().min(1).max(200)).max(50).optional(),
    selectedPaths: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    contextChips: z.array(contextChipSchema).max(50).optional(),
  })
  .strict();
export type ArchitectRunInput = z.infer<typeof architectRunInputSchema>;

export const architectAnswerInputSchema = z
  .object({ conversationId: z.string().min(1), carryOn: z.boolean() })
  .strict();
export type ArchitectAnswerInput = z.infer<typeof architectAnswerInputSchema>;

export const architectConversationInputSchema = z.object({ conversationId: z.string().min(1) }).strict();
export type ArchitectConversationInput = z.infer<typeof architectConversationInputSchema>;

export const architectReadinessInputSchema = z.object({ target: roleTargetSchema }).strict();
export const architectReadinessSchema = z
  .object({
    ready: z.boolean(),
    label: z.string().max(200),
    reason: z.string().max(600).optional(),
  })
  .strict();
export type ArchitectReadiness = z.infer<typeof architectReadinessSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Which models suit planning
// ---------------------------------------------------------------------------------------------------------------------

/** Names that mark a model as a small, fast tier: good for routine edits, a poor choice to plan or review with. */
const LIGHT_TIER = /(^|[-/:._\s])(haiku|flash|luna|mini|nano|lite|instant|small|tiny|fast|8b|7b|3b|1b)([-/:._\s]|$)/i;
/** Names that mark a top tier. */
const TOP_TIER = /(opus|fable|sonnet|astra|sol|terra|argon|\bpro\b|-pro|max|k3|glm-5|grok-4|large|reasoner|gpt-oss-120b|o3|o4|r1|405b|70b|235b|480b)/i;

/**
 * Whether a model is the kind KAI suggests for the Architect. It is a hint for sorting and badges, never a gate: any
 * model can be chosen. A model the list does not recognise is simply not flagged.
 */
export function isPlanningGradeModel(model: string | null | undefined): boolean {
  if (!model) return false;
  if (LIGHT_TIER.test(model)) return false;
  return TOP_TIER.test(model);
}

/** CLI agents whose own default model is a strong one; the others are judged by the model chosen. */
const PLANNING_CLI_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex']);

export function isPlanningGradeTarget(target: RoleTarget): boolean {
  if (target.execution === 'cli') {
    if (target.model) return isPlanningGradeModel(target.model);
    return target.agent ? PLANNING_CLI_AGENTS.has(target.agent) : false;
  }
  const api = target.api;
  if (!api) return false;
  if (api.model) return isPlanningGradeModel(api.model);
  return api.provider === 'anthropic' || api.provider === 'openai';
}

// ---------------------------------------------------------------------------------------------------------------------
// The check command the Architect may ask for
// ---------------------------------------------------------------------------------------------------------------------

/** The test, typecheck and build runners a project check is normally made of, each followed by plain flags only. */
const SAFE_CHECK_COMMAND = new RegExp(
  '^(npm (test|run [\\w:.-]+)|pnpm (test|run [\\w:.-]+)|yarn (test|[\\w:.-]+)|bun (test|run [\\w:.-]+)'
  + '|npx (vitest|tsc|jest|eslint|playwright test)'
  + '|pytest|python -m (pytest|unittest)'
  + '|cargo (test|check|clippy|build)|go (test|vet|build)|dotnet (test|build)|mvn (test|verify)|gradle (test|check|build))'
  + '(\\s+[\\w:=./@-]+|\\s+--?[\\w:=./@-]+)*$',
);

/**
 * Whether a command is one KAI will run on the Architect's say-so: a plain test, check or build command with no shell
 * operators, redirects or substitutions. The Architect is read-only by permission, so anything it names that could
 * change files or reach beyond the project is refused rather than run; the person's own check command is unaffected.
 */
export function isSafeCheckCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return false;
  if (/[\n\r;&|<>`$(){}\\]/.test(trimmed)) return false;
  return SAFE_CHECK_COMMAND.test(trimmed);
}
