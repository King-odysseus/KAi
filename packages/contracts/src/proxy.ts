import { z } from 'zod';

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();
export const proxyAgentIdSchema = z.enum(['claude', 'codex', 'kimi', 'qwen']);
export const proxyRoutingActionSchema = z.enum(['route', 'direct', 'verify', 'rollback']);

export const proxyHistoryStatusFilterSchema = z.enum(['', '1xx', '2xx', '3xx', '4xx', '5xx']);

export const proxyHistoryQuerySchema = z
  .object({
    search: z.string().trim().max(500).optional().default(''),
    agent: proxyAgentIdSchema.optional(),
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

export const proxyConnectionTestSchema = z
  .object({
    ok: z.boolean(),
    status: z.number().int().min(100).max(599).optional(),
    error: z.string().optional(),
    provider: z.string(),
  })
  .strict();

export const proxyPingResultSchema = z
  .object({
    label: z.string(),
    ok: z.boolean(),
    status: z.number().int().min(100).max(599).optional(),
    error: z.string().optional(),
    provider: z.string(),
    latencyMs: nonNegativeNumberSchema,
  })
  .strict();

export const proxyDryRunResultSchema = z
  .object({
    originalModel: z.unknown().optional(),
    targetModel: z.unknown().optional(),
    targetUrl: z.unknown().optional(),
    estimatedTokens: z.unknown().optional(),
    translatedBody: z.unknown().optional(),
    originalBody: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export const proxyReplayPreviewSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

export const proxyReplayResultSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    contentType: z.string().nullable(),
    body: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const proxyCostsClearResultSchema = z
  .object({
    cleared: nonNegativeIntegerSchema,
  })
  .strict();

export const proxyCostPeriodSchema = z.enum(['session', 'daily', 'weekly', 'monthly']);

export const proxyCostBreakdownRowSchema = z
  .object({
    period: z.string().min(1),
    costUsd: nonNegativeNumberSchema,
    calls: nonNegativeIntegerSchema,
    inputTokens: nonNegativeIntegerSchema,
    outputTokens: nonNegativeIntegerSchema,
  })
  .strict();

export const proxyCostSummarySchema = z
  .object({
    period: proxyCostPeriodSchema,
    days: nonNegativeIntegerSchema,
    totalCostUsd: nonNegativeNumberSchema,
    totalCalls: nonNegativeIntegerSchema,
    totalInputTokens: nonNegativeIntegerSchema,
    totalOutputTokens: nonNegativeIntegerSchema,
    models: z.array(
      z
        .object({
          model: z.string(),
          costUsd: nonNegativeNumberSchema,
          calls: nonNegativeIntegerSchema,
          inputTokens: nonNegativeIntegerSchema,
          outputTokens: nonNegativeIntegerSchema,
        })
        .strict(),
    ),
    breakdown: z.array(proxyCostBreakdownRowSchema),
  })
  .strict();

export const proxyClaudeResetResultSchema = z
  .object({
    settingsUpdated: z.boolean(),
    sessionsRemoved: nonNegativeIntegerSchema,
    processesStopped: nonNegativeIntegerSchema,
    credentialsCleared: z.boolean(),
    sessionEnvRemoved: nonNegativeIntegerSchema,
    onboardingReset: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

export const proxyClaudeSettingsResultSchema = z
  .object({
    opened: z.boolean(),
    path: z.string().min(1),
    detail: z.string(),
  })
  .strict();

export const proxyModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
  })
  .strict();

export const proxyAgentRouteSchema = z
  .object({
    agentId: proxyAgentIdSchema,
    clientKind: z.enum(['cli', 'vscode', 'both']),
    installed: z.boolean(),
    running: z.boolean().nullable(),
    route: z.enum(['direct', 'proxy', 'misconfigured']),
    localEndpoint: z.string().optional(),
    upstreamProvider: z.string().optional(),
    upstreamModel: z.string().optional(),
    credentialSource: z.enum(['subscription', 'agent-oauth', 'proxy-key', 'agent-key', 'none']),
    credentialFingerprint: z.string().optional(),
    restartRequired: z.boolean(),
    configSources: z.array(z.string()),
    configBackupDate: z.number().optional(),
    warnings: z.array(z.string()),
    lastVerified: z
      .object({
        timestamp: z.number(),
        success: z.boolean(),
        latencyMs: nonNegativeNumberSchema,
      })
      .optional(),
  })
  .strict();

export const proxyRoutingResultSchema = z
  .object({
    agentId: proxyAgentIdSchema,
    action: proxyRoutingActionSchema,
    success: z.boolean(),
    rolledBack: z.boolean(),
    restartRequired: z.boolean(),
    error: z.string().optional(),
    warnings: z.array(z.string()),
    verification: z
      .object({
        timestamp: z.number(),
        success: z.boolean(),
        latencyMs: nonNegativeNumberSchema,
        statusCode: z.number().int().min(100).max(599).optional(),
        error: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export const proxyConfigTransferResultSchema = z
  .object({
    canceled: z.boolean(),
    path: z.string().optional(),
    imported: z.boolean().optional(),
  })
  .strict();

export const proxyEnvCopyResultSchema = z
  .object({
    copied: z.literal(true),
    value: z.string(),
  })
  .strict();

export const proxyLaunchResultSchema = z
  .object({
    launched: z.boolean(),
    agent: z.enum(['claude', 'codex']),
    command: z.string(),
    detail: z.string(),
  })
  .strict();

export const proxyLiveEventSchema = z
  .object({
    event: z.enum(['start', 'response', 'error']),
    payload: z.unknown(),
  })
  .strict();

export type ProxyHistoryQuery = z.input<typeof proxyHistoryQuerySchema>;
export type NormalizedProxyHistoryQuery = z.output<typeof proxyHistoryQuerySchema>;
export type ProxyHistorySummary = z.infer<typeof proxyHistorySummarySchema>;
export type ProxyHistoryDetail = z.infer<typeof proxyHistoryDetailSchema>;
export type ProxyProviderHealth = z.infer<typeof proxyProviderHealthSchema>;
export type ProxyOverview = z.infer<typeof proxyOverviewSchema>;
export type ProxyHistoryClearResult = z.infer<typeof proxyHistoryClearResultSchema>;
export type ProxyConnectionTest = z.infer<typeof proxyConnectionTestSchema>;
export type ProxyPingResult = z.infer<typeof proxyPingResultSchema>;
export type ProxyDryRunResult = z.infer<typeof proxyDryRunResultSchema>;
export type ProxyReplayPreview = z.infer<typeof proxyReplayPreviewSchema>;
export type ProxyReplayResult = z.infer<typeof proxyReplayResultSchema>;
export type ProxyCostsClearResult = z.infer<typeof proxyCostsClearResultSchema>;
export type ProxyCostPeriod = z.infer<typeof proxyCostPeriodSchema>;
export type ProxyCostBreakdownRow = z.infer<typeof proxyCostBreakdownRowSchema>;
export type ProxyCostSummary = z.infer<typeof proxyCostSummarySchema>;
export type ProxyClaudeResetResult = z.infer<typeof proxyClaudeResetResultSchema>;
export type ProxyClaudeSettingsResult = z.infer<typeof proxyClaudeSettingsResultSchema>;
export type ProxyAgentId = z.infer<typeof proxyAgentIdSchema>;
export type ProxyRoutingAction = z.infer<typeof proxyRoutingActionSchema>;
export type ProxyModel = z.infer<typeof proxyModelSchema>;
export type ProxyAgentRoute = z.infer<typeof proxyAgentRouteSchema>;
export type ProxyRoutingResult = z.infer<typeof proxyRoutingResultSchema>;
export type ProxyConfigTransferResult = z.infer<typeof proxyConfigTransferResultSchema>;
export type ProxyEnvCopyResult = z.infer<typeof proxyEnvCopyResultSchema>;
export type ProxyLaunchResult = z.infer<typeof proxyLaunchResultSchema>;
export type ProxyLiveEvent = z.infer<typeof proxyLiveEventSchema>;
