import { z } from 'zod';
import { isLocalProvider } from './direct-providers';

const usdSchema = z.number().finite().nonnegative();

export const usageBudgetSchema = z
  .object({
    mode: z.enum(['warn', 'block']).default('warn'),
    // Asks before one direct API run goes past this much, whatever the other limits say. Zero turns it off, which is
    // the default: a run is not interrupted by a number the person did not choose.
    perRunUsd: usdSchema.default(0),
    perConversationUsd: usdSchema.default(0),
    dailyUsd: usdSchema.default(0),
    monthlyUsd: usdSchema.default(0),
    providerDailyUsd: z.record(z.string().min(1), usdSchema).default({}),
    // When a conversation's history reaches about this many tokens, KAI summarises the older turns before the next
    // request. It applies to every place an agent runs (composer, Crew, Studio, workflows). Zero turns it off.
    compactAtTokens: z.number().int().min(0).max(2_000_000).default(60_000),
    // The same, for a model running on this machine or the home network (LM Studio, Ollama and the like). Those have
    // small context windows and slow prompt processing, so they fold much earlier. Zero uses the size above instead.
    compactAtTokensLocal: z.number().int().min(0).max(2_000_000).default(20_000),
  })
  .strict();

export const usageLimitScopeSchema = z.enum(['conversation', 'daily', 'monthly', 'provider']);

export const usageLimitStatusSchema = z
  .object({
    scope: usageLimitScopeSchema,
    provider: z.string().optional(),
    limitUsd: usdSchema,
    spentUsd: usdSchema,
    ratio: z.number().nonnegative(),
    level: z.enum(['ok', 'warning', 'exceeded']),
  })
  .strict();

const usageTotalsSchema = z
  .object({
    usd: usdSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
  })
  .strict();

export const usageSummarySchema = z
  .object({
    generatedAt: z.string().min(1),
    currency: z.literal('USD'),
    // Dollar amounts are computed from reported token counts and a price catalogue.
    estimate: z.literal(true),
    todayUsd: usdSchema,
    monthUsd: usdSchema,
    conversationUsd: usdSchema.nullable(),
    unpricedRuns: z.number().int().nonnegative(),
    byDay: z.array(z.object({ day: z.string().min(1), usd: usdSchema }).strict()),
    byProvider: z.array(usageTotalsSchema.extend({ provider: z.string().min(1) }).strict()),
    byModel: z.array(usageTotalsSchema.extend({ provider: z.string().min(1), model: z.string().min(1) }).strict()),
    byConversation: z.array(
      z.object({ conversationId: z.string().min(1), title: z.string(), usd: usdSchema }).strict(),
    ),
    budget: usageBudgetSchema,
    limits: z.array(usageLimitStatusSchema),
    blocked: z.boolean(),
    blockedReason: z.string().nullable(),
  })
  .strict();

export type UsageBudget = z.infer<typeof usageBudgetSchema>;
export type UsageLimitStatus = z.infer<typeof usageLimitStatusSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const defaultUsageBudget: UsageBudget = {
  mode: 'warn',
  perRunUsd: 0,
  perConversationUsd: 0,
  dailyUsd: 0,
  monthlyUsd: 0,
  providerDailyUsd: {},
  compactAtTokens: 60_000,
  compactAtTokensLocal: 20_000,
};

/**
 * The history size at which a run for this provider is summarised. Hosted models use the main setting; a local one
 * uses its own, smaller, setting. Turning the main setting off turns every automatic compaction off, so the person's
 * "never compact on my own" is honoured whichever model runs.
 */
export function compactThresholdFor(
  budget: Pick<UsageBudget, 'compactAtTokens' | 'compactAtTokensLocal'>,
  provider: string | null | undefined,
  /** The model's own context window, when the server reported it. A local model then folds at half of what it holds. */
  contextWindow?: number | null,
): number {
  if (budget.compactAtTokens <= 0) return 0;
  const local = Boolean(provider && isLocalProvider(provider as Parameters<typeof isLocalProvider>[0]));
  // A gateway fronts local models too, so it folds by its model's window rather than the hosted-model setting.
  const windowAware = local || provider === 'openai-compatible';
  if (windowAware && contextWindow && contextWindow > 0) return Math.max(4_000, Math.floor(contextWindow * LOCAL_WINDOW_SHARE));
  if (local && budget.compactAtTokensLocal > 0) return budget.compactAtTokensLocal;
  return budget.compactAtTokens;
}

/**
 * The share of a local model's window its conversation may use before it folds. The rest is for the instructions, the
 * tool list and the reply, which go with every request.
 */
export const LOCAL_WINDOW_SHARE = 0.5;

/**
 * The window to plan a run around: the person's own override for the model if they set one, otherwise what the server
 * last reported for it in its model list.
 */
export function modelContextFor(
  settings: { modelContextOverride?: Record<string, number>; localModelContext?: Record<string, number> },
  model: string | null | undefined,
): number | undefined {
  if (!model) return undefined;
  return settings.modelContextOverride?.[model] ?? settings.localModelContext?.[model] ?? gatewayContextFor(model);
}

/** Gateway aliases omit context lengths from /v1/models, so use the gateway's configured loaded windows. */
export function gatewayContextFor(model: string): number | undefined {
  if (/^gateway\/(?:general|vision|research)$/i.test(model)) return 65_536;
  // The coding route has no fallback: it is served by the coder model or refused.
  if (/^gateway\/coding$/i.test(model)) return 131_072;
  return undefined;
}
