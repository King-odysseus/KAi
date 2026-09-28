import { z } from 'zod';
import { agentIdSchema, type AgentId } from './primitives';

/**
 * How much thinking a piece of work needs. KAI uses it to pick a CLI model, so a typo fix does not spend the
 * limits of the largest model and a redesign does not land on the smallest one.
 */
export const WORK_LEVELS = ['light', 'standard', 'heavy'] as const;
export const workLevelSchema = z.enum(WORK_LEVELS);
export type WorkLevel = z.infer<typeof workLevelSchema>;

// Same rule as cliModelNameSchema in domain.ts; repeated so the settings schema does not import domain.ts back.
const tierModelNameSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.5 or claude-sonnet-5.');

/** The model a CLI is asked to use for each level. A missing level keeps whatever model the run would have used. */
export const modelTierSchema = z
  .object({
    light: tierModelNameSchema.optional(),
    standard: tierModelNameSchema.optional(),
    heavy: tierModelNameSchema.optional(),
  })
  .strict();
export type ModelTier = z.infer<typeof modelTierSchema>;

export const autoModelSettingsSchema = z
  .object({
    enabled: z.boolean(),
    tiers: z.record(agentIdSchema, modelTierSchema),
  })
  .strict();
export type AutoModelSettings = z.infer<typeof autoModelSettingsSchema>;

/**
 * Starting points the user can change in Settings. Claude Code's aliases follow its newest model of each size.
 * Kimi Code has one coding model, so it is left alone.
 */
export const DEFAULT_MODEL_TIERS: Readonly<Record<AgentId, ModelTier>> = {
  claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  codex: { light: 'gpt-6-luna', standard: 'gpt-6-sol', heavy: 'gpt-6-astra' },
  gemini: { light: 'flash', standard: 'pro', heavy: 'pro' },
  qwen: { light: 'qwen3-coder-flash', standard: 'qwen3-coder-plus', heavy: 'qwen3.8-max' },
  kimi: {},
};

export function createDefaultAutoModel(): AutoModelSettings {
  return {
    enabled: true,
    tiers: Object.fromEntries(Object.entries(DEFAULT_MODEL_TIERS).map(([agent, tier]) => [agent, { ...tier }])),
  };
}

export const WORK_LEVEL_LABEL: Record<WorkLevel, string> = { light: 'Light', standard: 'Standard', heavy: 'Heavy' };

export interface WorkEstimate {
  level: WorkLevel;
  /** Plain words shown beside the chosen model, for example "a small, contained edit". */
  why: string;
}

// Work that needs the strongest model: design, cross-cutting change, and problems whose cause is not yet known.
const HEAVY =
  /\b(architect\w*|re-?design\w*|design (?:a|an|the)\b|refactor\w*|re-?writ\w*|migrat\w*|from scratch|root cause|race condition|deadlock|concurren\w*|memory leak|performance|optimi[sz]\w*|security (?:audit|review)|investigat\w*|end[- ]to[- ]end|across (?:the|all|every)|whole (?:app|project|codebase)|entire\w*|multi-?step|new (?:feature|system|service|app)|implement\w* (?:a|an|the) \w+ (?:system|feature|flow|engine|pipeline))\b/gi;
// Work a small model does well: contained, mechanical, or a question about existing code.
const LIGHT =
  /\b(typos?|spelling|rename\w*|re-?word\w*|wording|copy ?edit|comments?|docstrings?|lint\w*|format\w*|indent\w*|bump|version number|one[- ]liner?|single line|small|quick|tiny|simple|minor|tweak\w*|colou?r|padding|margin|font size|label|placeholder|import order|unused imports?|what does|where is|explain)\b/gi;

const LONG_PROMPT = 1_500;
const SHORT_PROMPT = 300;
const MANY_FILES = 6;

/**
 * A quick, local estimate of how heavy a request is. It never calls a model, so it costs nothing and cannot fail.
 * It leans to "standard": only clear signals move a request up or down, so a short follow-up such as "ok, do it"
 * stays standard instead of dropping a plan's second half onto the smallest model.
 */
export function classifyWork(prompt: string, options: { fileCount?: number } = {}): WorkEstimate {
  const text = prompt.trim();
  const heavy = [...new Set([...text.matchAll(HEAVY)].map((match) => match[0].toLowerCase()))];
  const light = [...new Set([...text.matchAll(LIGHT)].map((match) => match[0].toLowerCase()))];
  const files = options.fileCount ?? 0;

  if (heavy.length > 0) return { level: 'heavy', why: `mentions ${heavy.slice(0, 2).join(' and ')}` };
  if (text.length > LONG_PROMPT) return { level: 'heavy', why: 'a long, detailed request' };
  if (files >= MANY_FILES) return { level: 'heavy', why: `it spans ${files} files` };
  if (light.length > 0 && text.length <= SHORT_PROMPT && files <= 2) {
    return { level: 'light', why: `a small, contained edit (${light.slice(0, 2).join(', ')})` };
  }
  return { level: 'standard', why: 'ordinary coding work' };
}

/** The model for a level, or undefined when auto selection is off or has nothing set for this agent and level. */
export function tierModelFor(settings: AutoModelSettings | undefined, agent: AgentId, level: WorkLevel): string | undefined {
  if (!settings?.enabled) return undefined;
  return settings.tiers[agent]?.[level]?.trim() || undefined;
}
