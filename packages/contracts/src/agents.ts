import { z } from 'zod';
import { cliModelNameSchema, conversationRecordV1Schema } from './domain';
import { contextChipSchema } from './context';
import { workLevelSchema } from './model-tiers';
import { persistedEventV1Schema } from './events';
import { type AgentId, agentIdSchema, autonomyModeSchema, executionModeSchema, providerIdSchema, routeModeSchema } from './primitives';
import { goalInputSchema } from './workbench';

export const agentCapabilitySchema = z
  .object({
    id: agentIdSchema,
    displayName: z.string().min(1),
    available: z.boolean(),
    state: z.enum(['ready', 'signed_out', 'not_installed', 'unavailable']),
    version: z.string().optional(),
    unavailableReason: z.string().optional(),
    command: z.string().min(1),
    signInCommand: z.string().min(1),
    // The official one-line install for this machine's OS, shown when the CLI is missing.
    installCommand: z.string().min(1).optional(),
    installUrl: z.string().url(),
    supportsRoutes: z.array(routeModeSchema),
    supportsAutonomy: z.array(autonomyModeSchema),
  })
  .strict();

/**
 * How the agent words what it tells the person. 'plain' is the default: short sentences, everyday words, and every
 * technical term explained the first time it appears.
 */
export const RESPONSE_STYLES = ['plain', 'concise', 'detailed', 'technical'] as const;
export const responseStyleSchema = z.enum(RESPONSE_STYLES);
export type ResponseStyle = z.infer<typeof responseStyleSchema>;

export const RESPONSE_STYLE_LABEL: Record<ResponseStyle, string> = {
  plain: 'Plain words',
  concise: 'Concise',
  detailed: 'Detailed',
  technical: 'Technical',
};

export const RESPONSE_STYLE_DESCRIPTION: Record<ResponseStyle, string> = {
  plain: 'Short sentences and everyday words. Explains any technical term the first time it appears.',
  concise: 'The answer and nothing else. No background, no recap.',
  detailed: 'Walks through what was done and why, step by step.',
  technical: 'Precise engineering language. Assumes you know the codebase.',
};

/** Thinking effort, in the words the CLIs themselves use. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const agentRunRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    prompt: z.string().trim().min(1).max(20_000),
    clientMessageId: z.string().min(1).max(128).optional(),
    agent: agentIdSchema,
    execution: executionModeSchema.optional(),
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    goal: goalInputSchema.optional(),
    skills: z.array(z.string().min(1).max(200)).max(50).optional(),
    selectedPaths: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    contextChips: z.array(contextChipSchema).max(50).optional(),
    // Model for this run only. Without it the run uses the model from Settings (or the CLI's own default).
    model: cliModelNameSchema.optional(),
    // How the agent words its replies; without it the run uses plain words.
    responseStyle: responseStyleSchema.optional(),
    // How hard the agent thinks on this run. Only agents that take an effort setting (see CLI_EFFORT_LEVELS) use it.
    reasoning: reasoningEffortSchema.optional(),
    // How heavy the work is, when the caller already knows (a workflow step judged on its own prompt). Without it,
    // and without a model, KAI estimates it from the prompt to pick a model.
    effort: workLevelSchema.optional(),
    // Start a new agent session even if the conversation could resume one. Team parts use this so a reviewer
    // never inherits the session of the agent that wrote the code.
    freshSession: z.boolean().optional(),
  })
  .strict();

// These are the models verified against the signed-in desktop account.  A model
// can still be typed when a different account or provider supports it.
export const CLI_MODEL_SUGGESTIONS: Record<AgentId, readonly string[]> = {
  claude: [
    'opus',
    'sonnet',
    'haiku',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
  ],
  codex: [
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
  ],
  qwen: [
    'qwen3.8-max',
    'qwen3.8-max-0902',
    'qwen3.8-flash',
    'qwen3.8-27b',
    'qwen3-coder-plus',
    'qwen3-coder-flash',
    'qwen-coder-plus',
  ],
  gemini: [
    'gemini-3.8-pro',
    'gemini-3.8-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'pro',
    'flash',
  ],
  kimi: [
    'kimi-for-coding',
  ],
};

/**
 * The thinking-effort levels each CLI accepts, from its own `--help`: Claude Code has `--effort`, and Codex reads
 * `model_reasoning_effort` from its config. The others have no such setting, so they list nothing and the composer
 * shows no effort control for them.
 */
export const CLI_EFFORT_LEVELS: Record<AgentId, readonly ReasoningEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high'],
  qwen: [],
  gemini: [],
  kimi: [],
};

export const REASONING_LABEL: Record<ReasoningEffort, string> = {
  low: 'Light',
  medium: 'Balanced',
  high: 'Deep',
  xhigh: 'Very deep',
  max: 'Maximum',
};

/** True when `effort` is something this agent's CLI accepts. */
export function effortFitsAgent(agent: AgentId, effort: string | undefined): effort is ReasoningEffort {
  return Boolean(effort) && (CLI_EFFORT_LEVELS[agent] as readonly string[]).includes(effort as string);
}

/**
 * True when `model` is one of the names KAI lists for a *different* agent. A model typed by hand for this agent is
 * left alone; a name that is plainly another agent's (a Codex model on a Claude run) is not, because the CLI
 * rejects it and the run fails before it starts.
 */
export function modelBelongsToOtherAgent(agent: AgentId, model: string): boolean {
  if (!model || CLI_MODEL_SUGGESTIONS[agent].includes(model)) return false;
  return (Object.keys(CLI_MODEL_SUGGESTIONS) as AgentId[]).some((other) => other !== agent && CLI_MODEL_SUGGESTIONS[other].includes(model));
}

export const agentRunResultSchema = z
  .object({
    conversation: conversationRecordV1Schema,
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    error: z.string().optional(),
    /**
     * The person stopped this run rather than it breaking. `status` is still `failed` — a stopped run did not
     * complete — but there is no `error` and no red box, so anything deciding what a run means reads this rather
     * than matching the word "cancel" inside the error text.
     */
    cancelled: z.boolean().optional(),
    // The CLI reported that it is signed out; the UI offers Sign in.
    signInRequired: z.boolean().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const agentCancelInputSchema = z
  .object({
    conversationId: z.string().min(1),
  })
  .strict();

export const agentSignInInputSchema = z
  .object({
    agent: agentIdSchema,
  })
  .strict();

export const agentSignInResultSchema = z
  .object({
    agent: agentIdSchema,
    started: z.boolean(),
    command: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const agentApprovalResponseInputSchema = z
  .object({
    conversationId: z.string().min(1),
    requestId: z.string().min(1),
    approved: z.boolean(),
    // The option text the person picked, for a request that asked a question rather than asked for permission
    // (`approval.request` events carrying `options`). Absent for an ordinary allow/deny response.
    answer: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const directApiCapabilitySchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    provider: providerIdSchema,
    displayName: z.string().min(1),
    model: z.string(),
    baseUrl: z.string().url(),
    credentialId: z.string().min(1),
    credentialStored: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsTools: z.boolean(),
    unavailableReason: z.string().optional(),
  })
  .strict();

export const agentRunEventSchema = z
  .object({
    conversationId: z.string().min(1),
    event: persistedEventV1Schema,
  })
  .strict();

/**
 * A run arriving and leaving, announced to every window. A window renders an agent's events only for the
 * conversations it has taken up, and the composer's own send was the only thing that ever took one up — so a run
 * started in the main process worked with nothing appearing in the conversation it was working in.
 */
export const agentRunStateSchema = z
  .object({
    conversationId: z.string().min(1),
    status: z.enum(['started', 'finished']),
  })
  .strict();

export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;
export type AgentCancelInput = z.infer<typeof agentCancelInputSchema>;
export type AgentSignInInput = z.infer<typeof agentSignInInputSchema>;
export type AgentSignInResult = z.infer<typeof agentSignInResultSchema>;
export type AgentApprovalResponseInput = z.infer<typeof agentApprovalResponseInputSchema>;
export type DirectApiCapability = z.infer<typeof directApiCapabilitySchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export type AgentRunState = z.infer<typeof agentRunStateSchema>;
