import { z } from 'zod';

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();

export const proxyHistoryStatusFilterSchema = z.enum(['', '1xx', '2xx', '3xx', '4xx', '5xx']);

export const proxyHistoryQuerySchema = z
  .object({
    search: z.string().trim().max(500).optional().default(''),
    status: proxyHistoryStatusFilterSchema.optional().default(''),
    page: z.number().int().min(1).max(100_000).optional().default(1),
    limit: z.number().int().min(1).max(200).optional().default(50),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const proxyHistorySummarySchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().min(1),
    agent: z.string(),
    model: z.string(),
    provider: z.string(),
    input: nonNegativeIntegerSchema,
    output: nonNegativeIntegerSchema,
    latencyMs: nonNegativeNumberSchema,
    statusCode: z.number().int().min(100).max(599),
    requestModel: z.string(),
    promptSnippet: z.string(),
  })
  .strict();

export const proxyHistoryDetailSchema = z
  .object({
    id: z.string().min(1),
    agent: z.string(),
    timestamp: z.string().min(1),
    route: z.enum(['direct', 'proxy', 'misconfigured']),
    provider: z.string(),
    model: z.string(),
    requestMethod: z.string(),
    requestPath: z.string(),
    requestModel: z.string(),
    translatedModel: z.string(),
    promptSnippet: z.string(),
    statusCode: z.number().int().min(100).max(599),
    errorStage: z.enum(['routing', 'auth', 'translation', 'upstream', 'timeout', 'parse']).nullable(),
    errorMessage: z.string().nullable(),
    latency: z
      .object({
        clientToProxyMs: nonNegativeNumberSchema,
        queueMs: nonNegativeNumberSchema,
        upstreamFirstByteMs: nonNegativeNumberSchema,
        streamMs: nonNegativeNumberSchema,
        totalMs: nonNegativeNumberSchema,
      })
      .strict(),
    tokens: z
      .object({
        input: nonNegativeIntegerSchema,
        output: nonNegativeIntegerSchema,
        cacheRead: nonNegativeIntegerSchema,
        cacheWrite: nonNegativeIntegerSchema,
      })
      .strict(),
    costUsd: nonNegativeNumberSchema,
    retryAttempt: nonNegativeIntegerSchema,
    fallbackUsed: z.boolean(),
    fallbackProvider: z.string().nullable(),
    fallbackTransitions: z.array(z.string()),
    responseContentType: z.string().nullable(),
    responseBytes: nonNegativeIntegerSchema.nullable(),
    isVerification: z.boolean(),
  })
  .strict();

export const proxyProviderHealthSchema = z
  .object({
    provider: z.string(),
    state: z.enum(['closed', 'open', 'half-open']),
    reachable: z.boolean(),
    successRate: z.number().min(0).max(1),
    p50: nonNegativeNumberSchema,
    p95: nonNegativeNumberSchema,
    p99: nonNegativeNumberSchema,
    count: nonNegativeIntegerSchema,
    errorCount: nonNegativeIntegerSchema,
    errorCount24h: nonNegativeIntegerSchema,
    errorsByStatus: z.record(z.string(), nonNegativeIntegerSchema),
    lastCheck: nonNegativeNumberSchema.nullable(),
  })
  .strict();

export const proxyLatencyMetricSchema = z
  .object({
    provider: z.string(),
    p50: nonNegativeNumberSchema,
    p95: nonNegativeNumberSchema,
    p99: nonNegativeNumberSchema,
    count: nonNegativeIntegerSchema,
  })
  .strict();

export const proxyModelUsageSchema = z
  .object({
    model: z.string(),
    inputTokens: nonNegativeIntegerSchema,
    outputTokens: nonNegativeIntegerSchema,
    calls: nonNegativeIntegerSchema,
    costUsd: nonNegativeNumberSchema,
  })
  .strict();

export const proxyOverviewSchema = z
  .object({
    target: z.string(),
    totalCostUsd: nonNegativeNumberSchema,
    trackedCalls: nonNegativeIntegerSchema,
    cacheReadTokens: nonNegativeIntegerSchema,
    totalInputTokens: nonNegativeIntegerSchema,
    cacheHitRate: nonNegativeNumberSchema,
    providers: z.array(proxyProviderHealthSchema),
    latency: z.array(proxyLatencyMetricSchema),
    models: z.array(proxyModelUsageSchema),
  })
  .strict();

export const proxyHistoryClearResultSchema = z
  .object({
    cleared: nonNegativeIntegerSchema,
  })
  .strict();

export type ProxyHistoryQuery = z.input<typeof proxyHistoryQuerySchema>;
export type NormalizedProxyHistoryQuery = z.output<typeof proxyHistoryQuerySchema>;
export type ProxyHistorySummary = z.infer<typeof proxyHistorySummarySchema>;
export type ProxyHistoryDetail = z.infer<typeof proxyHistoryDetailSchema>;
export type ProxyProviderHealth = z.infer<typeof proxyProviderHealthSchema>;
export type ProxyOverview = z.infer<typeof proxyOverviewSchema>;
export type ProxyHistoryClearResult = z.infer<typeof proxyHistoryClearResultSchema>;
