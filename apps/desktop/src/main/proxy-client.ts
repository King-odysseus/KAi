import { z } from 'zod';
import {
  proxyConnectionTestSchema,
  proxyCostsClearResultSchema,
  proxyDryRunResultSchema,
  proxyHistoryClearResultSchema,
  proxyHistoryDetailSchema,
  proxyHistoryQuerySchema,
  proxyHistorySummarySchema,
  proxyOverviewSchema,
  proxyPingResultSchema,
  proxyReplayPreviewSchema,
  proxyReplayResultSchema,
  type ProxyLiveEvent,
  type ProxyModel,
  type ProxyConnectionTest,
  type ProxyCostsClearResult,
  type ProxyDryRunResult,
  type ProxyHistoryClearResult,
  type ProxyHistoryDetail,
  type ProxyHistoryQuery,
  type ProxyHistorySummary,
  type ProxyOverview,
  type ProxyPingResult,
  type ProxyReplayPreview,
  type ProxyReplayResult,
} from '@kai/contracts';
import type { ServiceKind } from '@kai/contracts';

export interface UniversalProxyLoopbackAccess {
  loopbackAccess(kind: ServiceKind): Promise<{ endpoint: string; token: string }>;
}

export interface UniversalProxyClientOptions {
  access: UniversalProxyLoopbackAccess;
  timeoutMs?: number;
}

const providerHealthSchema = z.object({
  provider: z.string(),
  state: z.enum(['closed', 'open', 'half-open']),
  reachable: z.boolean().optional().default(true),
  successRate: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  count: z.number(),
  errorCount: z.number(),
  errorCount24h: z.number().optional().default(0),
  errorsByStatus: z.record(z.string(), z.number()).default({}),
  lastCheck: z.number().nullable(),
});

const providerHealthResponseSchema = z.object({
  status: z.literal('ok'),
  target: z.string(),
  providers: z.record(z.string(), providerHealthSchema).default({}),
});

const metricsResponseSchema = z.object({
  byProvider: z
    .record(
      z.string(),
      z.object({
        p50: z.number(),
        p95: z.number(),
        p99: z.number(),
        count: z.number(),
      }),
    )
    .default({}),
});

const costsResponseSchema = z.object({
  totalCost: z.number(),
  byModel: z
    .record(
      z.string(),
      z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        calls: z.number(),
        cost: z.number(),
      }),
    )
    .default({}),
});

const cacheStatsResponseSchema = z.object({
  cacheReadTokens: z.number(),
  totalInputTokens: z.number(),
  hitRate: z.number(),
  calls: z.number(),
});

const modelsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
            label: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
            label: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const historyDetailResponseSchema = z.object({
  id: z.string().min(1),
  agentId: z.string(),
  timestamp: z.number(),
  route: z.enum(['direct', 'proxy', 'misconfigured']),
  upstreamProvider: z.string(),
  upstreamModel: z.string(),
  requestMethod: z.string(),
  requestPath: z.string(),
  requestModel: z.string(),
  translatedModel: z.string(),
  promptSnippet: z.string().optional().default(''),
  statusCode: z.number(),
  errorStage: z.enum(['routing', 'auth', 'translation', 'upstream', 'timeout', 'parse']).optional(),
  errorMessage: z.string().optional(),
  latency: z.object({
    clientToProxyMs: z.number(),
    queueMs: z.number(),
    upstreamFirstByteMs: z.number(),
    streamMs: z.number(),
    totalMs: z.number(),
  }),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  costUsd: z.number(),
  retryAttempt: z.number(),
  fallbackUsed: z.boolean(),
  fallbackProvider: z.string().optional(),
  fallbackTransitions: z.array(z.string()).optional().default([]),
  responseSummary: z
    .object({
      contentType: z.string().optional(),
      bytes: z.number().optional(),
    })
    .optional(),
  isVerification: z.boolean(),
});

export class UniversalProxyClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: UniversalProxyClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async overview(): Promise<ProxyOverview> {
    const [health, metrics, costs, cache] = await Promise.all([
      this.requestJson('/v1/provider-health', undefined, providerHealthResponseSchema),
      this.requestJson('/v1/metrics', undefined, metricsResponseSchema),
      this.requestJson('/v1/costs', undefined, costsResponseSchema),
      this.requestJson('/v1/cache-stats', undefined, cacheStatsResponseSchema),
    ]);

    return proxyOverviewSchema.parse({
      target: health.target,
      totalCostUsd: nonNegative(costs.totalCost),
      trackedCalls: nonNegative(cache.calls),
      cacheReadTokens: nonNegative(cache.cacheReadTokens),
      totalInputTokens: nonNegative(cache.totalInputTokens),
      cacheHitRate: nonNegative(cache.hitRate),
      providers: Object.values(health.providers)
        .map((provider) => ({
          provider: provider.provider,
          state: provider.state,
          reachable: provider.reachable,
          successRate: clamp(provider.successRate, 0, 1),
          p50: nonNegative(provider.p50),
          p95: nonNegative(provider.p95),
          p99: nonNegative(provider.p99),
          count: nonNegativeInteger(provider.count),
          errorCount: nonNegativeInteger(provider.errorCount),
          errorCount24h: nonNegativeInteger(provider.errorCount24h),
          errorsByStatus: mapIntegerRecord(provider.errorsByStatus),
          lastCheck: provider.lastCheck === null ? null : nonNegative(provider.lastCheck),
        }))
        .sort((left, right) => left.provider.localeCompare(right.provider)),
      latency: Object.entries(metrics.byProvider)
        .map(([provider, metric]) => ({
          provider,
          p50: nonNegative(metric.p50),
          p95: nonNegative(metric.p95),
          p99: nonNegative(metric.p99),
          count: nonNegativeInteger(metric.count),
        }))
        .sort((left, right) => left.provider.localeCompare(right.provider)),
      models: Object.entries(costs.byModel)
        .map(([model, usage]) => ({
          model,
          inputTokens: nonNegativeInteger(usage.input_tokens),
          outputTokens: nonNegativeInteger(usage.output_tokens),
          calls: nonNegativeInteger(usage.calls),
          costUsd: nonNegative(usage.cost),
        }))
        .sort((left, right) => right.costUsd - left.costUsd || left.model.localeCompare(right.model)),
    });
  }

  async history(request: ProxyHistoryQuery = {}): Promise<ProxyHistorySummary[]> {
    const query = proxyHistoryQuerySchema.parse(request);
    const search = new URLSearchParams({
      limit: String(query.limit),
      page: String(query.page),
    });
    if (query.search) search.set('search', query.search);
    if (query.agent) search.set('agent', query.agent);
    if (query.status) search.set('status', query.status);
    if (query.from) search.set('from', query.from);
    if (query.to) search.set('to', query.to);

    const history = await this.requestJson(
      `/v1/history?${search.toString()}`,
      undefined,
      z.array(proxyHistorySummarySchema),
    );
    return history;
  }

  async historyDetail(id: string): Promise<ProxyHistoryDetail> {
    const detail = await this.requestJson(
      `/v1/history/${encodeURIComponent(id)}`,
      undefined,
      historyDetailResponseSchema,
    );
    return proxyHistoryDetailSchema.parse({
      id: detail.id,
      agent: detail.agentId,
      timestamp: new Date(detail.timestamp).toISOString(),
      route: detail.route,
      provider: detail.upstreamProvider,
      model: detail.upstreamModel,
      requestMethod: detail.requestMethod,
      requestPath: detail.requestPath,
      requestModel: detail.requestModel,
      translatedModel: detail.translatedModel,
      promptSnippet: detail.promptSnippet,
      statusCode: detail.statusCode,
      errorStage: detail.errorStage ?? null,
      errorMessage: detail.errorMessage ?? null,
      latency: mapNonNegativeNumbers(detail.latency),
      tokens: mapNonNegativeIntegers(detail.tokens),
      costUsd: nonNegative(detail.costUsd),
      retryAttempt: nonNegativeInteger(detail.retryAttempt),
      fallbackUsed: detail.fallbackUsed,
      fallbackProvider: detail.fallbackProvider ?? null,
      fallbackTransitions: detail.fallbackTransitions,
      responseContentType: detail.responseSummary?.contentType ?? null,
      responseBytes:
        detail.responseSummary?.bytes === undefined ? null : nonNegativeInteger(detail.responseSummary.bytes),
      isVerification: detail.isVerification,
    });
  }

  async clearHistory(): Promise<ProxyHistoryClearResult> {
    const result = await this.requestJson('/v1/history/clear', { method: 'POST' }, proxyHistoryClearResultSchema);
    return result;
  }

  async testConnection(agent?: string): Promise<ProxyConnectionTest> {
    const path = agent ? `/a/${encodeURIComponent(agent)}/v1/test` : '/v1/test';
    return this.withResponse(path, undefined, async (response) => {
      const payload = await readJson(response).catch(() => ({}));
      return proxyConnectionTestSchema.parse({
        ...(payload && typeof payload === 'object' ? payload : {}),
        ok: response.ok && (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== false),
        status: response.status,
      });
    });
  }

  async pingAll(): Promise<ProxyPingResult[]> {
    return this.requestJson('/v1/ping-all', undefined, z.array(proxyPingResultSchema));
  }

  async dryRun(body: unknown): Promise<ProxyDryRunResult> {
    return this.requestJson('/v1/dry-run', { method: 'POST', body }, proxyDryRunResultSchema);
  }

  async clearCosts(): Promise<ProxyCostsClearResult> {
    return this.requestJson('/v1/costs/clear', { method: 'POST' }, proxyCostsClearResultSchema);
  }

  async replayPreview(id: string): Promise<ProxyReplayPreview> {
    return this.requestJson(
      `/v1/history/replay/${encodeURIComponent(id)}`,
      undefined,
      proxyReplayPreviewSchema,
    );
  }

  async replay(id: string): Promise<ProxyReplayResult> {
    return this.withResponse('/v1/history/replay', {
      method: 'POST',
      body: { id, confirm: true },
    }, async (response) => {
      const fullBody = await response.text();
      const maxCharacters = 512_000;
      return proxyReplayResultSchema.parse({
        statusCode: response.status,
        contentType: response.headers.get('content-type'),
        body: fullBody.slice(0, maxCharacters),
        truncated: fullBody.length > maxCharacters,
      });
    });
  }

  async models(): Promise<ProxyModel[]> {
    const response = await this.requestJson('/v1/models', undefined, modelsResponseSchema);
    const models = response.data.length > 0 ? response.data : response.models ?? [];
    return [...new Map(models.map((model) => [model.id, {
      id: model.id,
      ...(model.label || model.name ? { label: model.label ?? model.name } : {}),
    }])).values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async watchLive(
    listener: (event: ProxyLiveEvent) => void,
    signal: AbortSignal,
    agent?: string,
  ): Promise<void> {
    const access = await this.options.access.loopbackAccess('universalProxy');
    const path = agent
      ? `/v1/history/live?agent=${encodeURIComponent(agent)}`
      : '/v1/history/live';
    const response = await fetch(new URL(path, access.endpoint), {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${access.token}`,
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Universal Agent Proxy live tail failed with status ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName: ProxyLiveEvent['event'] = 'response';
    let dataLines: string[] = [];

    const flush = () => {
      if (dataLines.length === 0) return;
      const raw = dataLines.join('\n');
      dataLines = [];
      let payload: unknown = raw;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        // Keep the raw SSE data when an engine event is not JSON.
      }
      listener({ event: eventName, payload });
      eventName = 'response';
    };

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) {
          flush();
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          const candidate = line.slice(6).trim();
          if (candidate === 'start' || candidate === 'response' || candidate === 'error') eventName = candidate;
          continue;
        }
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
    flush();
  }

  private async requestJson<TSchema extends z.ZodTypeAny>(
    path: string,
    options: { method?: string; body?: unknown } | undefined,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    try {
      return await this.withResponse(path, options, async (response) => {
        const payload = await readJson(response);
        if (!response.ok) throw new Error(errorMessage(payload, response.status));
        return schema.parse(payload);
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fields = error.issues.map((issue) => issue.path.join('.') || 'response').join(', ');
        throw new Error(`Universal Agent Proxy returned an unexpected response (${fields}).`);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Universal Agent Proxy did not respond before the request timed out.');
      }
      throw error;
    }
  }

  private async withResponse<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const access = await this.options.access.loopbackAccess('universalProxy');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(new URL(path, access.endpoint), {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${access.token}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapIntegerRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, nonNegativeInteger(value)]),
  );
}

function mapNonNegativeIntegers<T extends Record<string, number>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, nonNegativeInteger(value)]),
  ) as T;
}

function mapNonNegativeNumbers<T extends Record<string, number>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, nonNegative(value)]),
  ) as T;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : minimum;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Universal Agent Proxy returned non-JSON content (${response.status}).`);
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    if ('error' in payload) {
      const error = payload.error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
      }
    }
  }
  return `Universal Agent Proxy request failed with status ${status}.`;
}
