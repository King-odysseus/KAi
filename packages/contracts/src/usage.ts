import { z } from 'zod';

const usdSchema = z.number().finite().nonnegative();

export const usageBudgetSchema = z
  .object({
    mode: z.enum(['warn', 'block']).default('warn'),
    perConversationUsd: usdSchema.default(0),
    dailyUsd: usdSchema.default(0),
    monthlyUsd: usdSchema.default(0),
    providerDailyUsd: z.record(z.string().min(1), usdSchema).default({}),
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
  perConversationUsd: 0,
  dailyUsd: 0,
  monthlyUsd: 0,
  providerDailyUsd: {},
};
