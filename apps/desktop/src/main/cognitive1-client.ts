import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  brainEntrySchema,
  brainFieldUpdateInputSchema,
  brainFieldUpdateResultSchema,
  brainOverviewSchema,
  brainSearchInputSchema,
  cognitive1McpToolInputSchema,
  cognitive1OperationInputSchema,
  type AgentId,
  type BrainEntry,
  type BrainEntryType,
  type BrainFieldUpdateInput,
  type BrainFieldUpdateResult,
  type BrainOverview,
  type BrainSearchInput,
  type Cognitive1Operation,
  type Cognitive1OperationInput,
  type Cognitive1OperationResult,
  type Cognitive1McpToolInput,
  type Cognitive1McpToolResult,
  type ProxyCostPeriod,
  type ProxyCostSummary,
} from '@kai/contracts';
import type { ServiceKind } from '@kai/contracts';
import type { KnownBrainProject } from './brain-project';

const KNOWN_PROJECTS_TTL_MS = 30_000;

export interface Cognitive1LoopbackAccess {
  loopbackAccess(kind: ServiceKind): Promise<{ endpoint: string; token: string }>;
}

export interface Cognitive1MirrorTarget {
  endpoint: string;
  /** Sent as a bearer token when the mirrored daemon is one KAI manages; the standalone one wants none. */
  token?: string;
}

export interface Cognitive1ClientOptions {
  access: Cognitive1LoopbackAccess;
  timeoutMs?: number;
  /** The second daemon every lesson is copied to, or null when the mirror is off. Read per write, so a settings change takes effect at once. */
  mirror?: () => Promise<Cognitive1MirrorTarget | null>;
}

const rawRecallEntrySchema = z.object({
  date: z.string().min(1),
  title: z.string().min(1),
  agent: z.string().default('unknown'),
  type: z.enum(['bugs', 'decisions', 'gotchas', 'patterns']),
  tags: z.string().optional().default(''),
  project: z.string().optional(),
  fields: z.record(z.string()).default({}),
});

const rawStatusSchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  health: z
    .array(
      z.object({
        type: z.string(),
        total: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  agents: z
    .array(
      z.object({
        presence: z.enum(['active', 'idle', 'offline']),
      }),
    )
    .default([]),
  // Named projects the brain already files memories under, with the path its notes recorded when they have one.
  projects: z
    .array(
      z
        .object({
          name: z.string().min(1),
          path: z.string().optional().nullable(),
        })
        .passthrough(),
    )
    .catch([])
    .default([]),
  // The names entries are really filed under, with how many each carries. Older engines do not send it.
  entryProjects: z
    .array(z.object({ name: z.string().min(1), count: z.number().int().nonnegative() }).passthrough())
    .catch([])
    .default([]),
  recentEntries: z.array(rawRecallEntrySchema).default([]),
  brainHunger: z.object({
    daysSinceLearn: z.number().int().nonnegative(),
    level: z.enum(['satisfied', 'peckish', 'hungry', 'starving']),
    lastEntryDate: z.string().nullable(),
  }),
});

const rawQualitySchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  noiseScore: z.number().int(),
  signalRatio: z.number().int(),
  duplicateCount: z.number().int().nonnegative(),
  untaggedTotal: z.number().int().nonnegative(),
  deadWeightCount: z.number().int().nonnegative(),
});

const rawRecallResponseSchema = z.object({
  mode: z.string(),
  results: z.array(rawRecallEntrySchema),
});

const rawFieldUpdateResponseSchema = z.object({
  ok: z.literal(true),
  title: z.string().min(1),
  field: z.string().min(1),
  value: z.string(),
});

const rawCostSummarySchema = z.object({
  days: z.number().int().nonnegative().default(0),
  totalUsd: z.number().nonnegative().default(0),
  totalCalls: z.number().int().nonnegative().default(0),
  totalInputTokens: z.number().int().nonnegative().default(0),
  totalOutputTokens: z.number().int().nonnegative().default(0),
  byModel: z
    .record(
      z.string(),
      z.object({
        usd: z.number().nonnegative().default(0),
        calls: z.number().int().nonnegative().default(0),
        inputTokens: z.number().int().nonnegative().default(0),
        outputTokens: z.number().int().nonnegative().default(0),
      }),
    )
    .default({}),
  breakdown: z
    .array(
      z.object({
        period: z.string(),
        usd: z.number().nonnegative().default(0),
        calls: z.number().int().nonnegative().default(0),
        inputTokens: z.number().int().nonnegative().default(0),
        outputTokens: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
});

const rawSessionStartResponseSchema = z.object({
  briefed: z.boolean(),
  message: z.string().optional(),
  briefing: z.string().optional(),
  project: z.string().default('unknown'),
  claimed: z.boolean().default(false),
  conflicts: z
    .array(
      z.object({
        agent: z.string(),
        what: z.string(),
      }),
    )
    .default([]),
});

const rawSessionEndResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.string(),
  summary: z.string(),
  autoHandoff: z.boolean().default(false),
});

const rawHandoffResponseSchema = z.object({
  ok: z.literal(true),
  handoff: z
    .object({
      date: z.string().optional(),
      fromAgent: z.string().optional(),
      toAgent: z.string().optional(),
      project: z.string().optional(),
      status: z.string().optional(),
      next: z.string().optional(),
    })
    .passthrough(),
});

export interface Cognitive1SessionStartInput {
  agent: AgentId;
  projectPath: string;
  task?: string;
  force?: boolean;
}

export interface Cognitive1SessionStartResult {
  briefed: boolean;
  message?: string;
  briefing?: string;
  project: string;
  claimed: boolean;
  conflicts: Array<{ agent: string; what: string }>;
}

export interface Cognitive1SessionEndResult {
  agent: string;
  summary: string;
  autoHandoff: boolean;
}

export interface Cognitive1HandoffInput {
  fromAgent: AgentId;
  toAgent: AgentId | 'any';
  project: string;
  status: string;
  next: string;
  files?: string;
  blockers?: string;
  notes?: string;
}

export interface Cognitive1HandoffResult {
  fromAgent?: string;
  toAgent?: string;
  project?: string;
  status?: string;
  next?: string;
}

/** The routes a lesson travels on. Everything else stays with the daemon that owns it. */
const MIRRORED_PATHS = new Set(['/api/brain/learn', '/api/brain/auto-learn']);
const MIRROR_TIMEOUT_MS = 10_000;

export class Cognitive1Client {
  private readonly timeoutMs: number;
  /** Set by the caller once the logger is available, so a quiet mirror still leaves a trace. */
  onMirrorError: ((error: unknown) => void) | undefined;
  private mcpConnection: { fingerprint: string; client: Client } | undefined;

  private knownProjectsCache: { at: number; projects: KnownBrainProject[] } | null = null;

  constructor(private readonly options: Cognitive1ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async overview(): Promise<BrainOverview> {
    const status = await this.requestJson('/api/status', undefined, rawStatusSchema);
    // Cognitive1's quality scan compares every entry title with every other one.
    // On a mature brain that blocks the daemon event loop long enough to stall
    // search and edits, so only run it eagerly while the index is small.
    const quality = status.totalEntries <= 300
      ? await this.requestJson('/api/brain/quality', undefined, rawQualitySchema)
      : null;

    const typeCounts: Record<BrainEntryType, number> = {
      bugs: 0,
      decisions: 0,
      gotchas: 0,
      patterns: 0,
    };
    for (const item of status.health) {
      if (isBrainEntryType(item.type)) typeCounts[item.type] = item.total;
    }

    return brainOverviewSchema.parse({
      totalEntries: status.totalEntries,
      typeCounts,
      activeAgents: status.agents.filter((agent) => agent.presence === 'active').length,
      projectCount: status.projects.length,
      hunger: status.brainHunger,
      recentEntries: status.recentEntries.map(toBrainEntry),
      quality,
    });
  }

  /** Project names the brain already files memories under, so a recall can ask for one that exists. */
  async knownProjects(): Promise<KnownBrainProject[]> {
    // Every read and write of a run asks for the name, and the status scan walks the project notes, so share one answer.
    const cached = this.knownProjectsCache;
    if (cached && Date.now() - cached.at < KNOWN_PROJECTS_TTL_MS) return cached.projects;
    const status = await this.requestJson('/api/status', undefined, rawStatusSchema);
    const projects = mergeKnownProjects(
      status.projects.map((project) => ({ name: project.name, path: project.path ?? null })),
      status.entryProjects,
    );
    this.knownProjectsCache = { at: Date.now(), projects };
    return projects;
  }

  async search(input: BrainSearchInput): Promise<BrainEntry[]> {
    const query = brainSearchInputSchema.parse(input);
    const response = await this.requestJson(
      '/api/brain/recall',
      {
        method: 'POST',
        body: {
          query: query.query || undefined,
          tag: query.tag || undefined,
          type: query.type,
          project: query.global ? undefined : query.project || undefined,
          global: query.global,
          mode: query.mode,
          max_results: query.maxResults,
        },
      },
      rawRecallResponseSchema,
    );
    return response.results.map(toBrainEntry);
  }

  async updateField(input: BrainFieldUpdateInput): Promise<BrainFieldUpdateResult> {
    const update = brainFieldUpdateInputSchema.parse(input);
    const response = await this.requestJson(
      '/api/brain/edit-field',
      { method: 'POST', body: update },
      rawFieldUpdateResponseSchema,
    );
    return brainFieldUpdateResultSchema.parse({
      title: response.title,
      field: response.field,
      value: response.value,
    });
  }

  async costSummary(period: Exclude<ProxyCostPeriod, 'session'>): Promise<ProxyCostSummary> {
    const days = period === 'daily' ? 30 : period === 'weekly' ? 90 : 365;
    const response = await this.requestJson(
      `/api/costs?days=${days}&breakdown=${period}`,
      undefined,
      rawCostSummarySchema,
    );
    return {
      period,
      days: response.days,
      totalCostUsd: nonNegative(response.totalUsd),
      totalCalls: nonNegativeInteger(response.totalCalls),
      totalInputTokens: nonNegativeInteger(response.totalInputTokens),
      totalOutputTokens: nonNegativeInteger(response.totalOutputTokens),
      models: Object.entries(response.byModel)
        .map(([model, usage]) => ({
          model,
          costUsd: nonNegative(usage.usd),
          calls: nonNegativeInteger(usage.calls),
          inputTokens: nonNegativeInteger(usage.inputTokens),
          outputTokens: nonNegativeInteger(usage.outputTokens),
        }))
        .sort((left, right) => right.costUsd - left.costUsd || left.model.localeCompare(right.model)),
      breakdown: response.breakdown
        .map((row) => ({
          period: row.period,
          costUsd: nonNegative(row.usd),
          calls: nonNegativeInteger(row.calls),
          inputTokens: nonNegativeInteger(row.inputTokens),
          outputTokens: nonNegativeInteger(row.outputTokens),
        }))
        .sort((left, right) => right.period.localeCompare(left.period)),
    };
  }

  async operation(input: Cognitive1OperationInput): Promise<Cognitive1OperationResult> {
    const request = cognitive1OperationInputSchema.parse(input);
    const route = operationRoute(request.operation, request.payload);
    const result = await this.requestJson(route.path, { method: route.method, body: route.body }, z.unknown());
    // Fire and forget: the write here has already succeeded, and the second brain is never allowed to fail it.
    void this.mirrorLearn(route);
    return result;
  }

  /**
   * Files the same lesson into the second brain. Only the two learn routes are mirrored: claims, sessions and
   * handoffs are state about *this* daemon, and copying them would make the other one disagree with reality.
   */
  private async mirrorLearn(route: { path: string; method: string; body?: Record<string, unknown> }): Promise<void> {
    if (route.method !== 'POST' || !MIRRORED_PATHS.has(route.path)) return;
    try {
      const mirror = await this.options.mirror?.();
      if (!mirror?.endpoint) return;
      await fetch(new URL(route.path, mirror.endpoint), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(mirror.token ? { Authorization: `Bearer ${mirror.token}` } : {}),
        },
        body: JSON.stringify(route.body ?? {}),
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
      });
    } catch (error) {
      this.onMirrorError?.(error);
    }
  }

  async tool(input: Cognitive1McpToolInput): Promise<Cognitive1McpToolResult> {
    const request = cognitive1McpToolInputSchema.parse(input);
    const client = await this.mcpClient();
    const result = await client.callTool(
      { name: request.tool, arguments: request.arguments },
      undefined,
      { timeout: this.timeoutMs },
    );
    return {
      content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  }

  async dispose(): Promise<void> {
    const connection = this.mcpConnection;
    this.mcpConnection = undefined;
    await connection?.client.close().catch(() => undefined);
  }

  async startSession(input: Cognitive1SessionStartInput): Promise<Cognitive1SessionStartResult> {
    const response = await this.requestJson(
      '/api/session/start',
      {
        method: 'POST',
        body: {
          agent: input.agent,
          project_path: input.projectPath,
          task: input.task || undefined,
          force: input.force,
        },
      },
      rawSessionStartResponseSchema,
    );
    return {
      briefed: response.briefed,
      message: response.message,
      briefing: response.briefing,
      project: response.project,
      claimed: response.claimed,
      conflicts: response.conflicts,
    };
  }

  async endSession(agent: AgentId, summary: string): Promise<Cognitive1SessionEndResult> {
    const response = await this.requestJson(
      '/api/session/end',
      { method: 'POST', body: { agent, summary } },
      rawSessionEndResponseSchema,
    );
    return {
      agent: response.agent,
      summary: response.summary,
      autoHandoff: response.autoHandoff,
    };
  }

  async recordHandoff(input: Cognitive1HandoffInput): Promise<Cognitive1HandoffResult> {
    const response = await this.requestJson(
      '/api/brain/handoff',
      {
        method: 'POST',
        body: {
          from_agent: input.fromAgent,
          to_agent: input.toAgent,
          project: input.project,
          status: input.status,
          next: input.next,
          files: input.files || undefined,
          blockers: input.blockers || undefined,
          notes: input.notes || undefined,
        },
      },
      rawHandoffResponseSchema,
    );
    return {
      fromAgent: response.handoff.fromAgent,
      toAgent: response.handoff.toAgent,
      project: response.handoff.project,
      status: response.handoff.status,
      next: response.handoff.next,
    };
  }

  private async requestJson<TSchema extends z.ZodTypeAny>(
    path: string,
    options: { method?: string; body?: unknown } | undefined,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    const access = await this.options.access.loopbackAccess('cognitive1');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(new URL(path, access.endpoint), {
        method: options?.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${access.token}`,
          ...(options?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(errorMessage(payload, response.status));
      }
      return schema.parse(payload);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fields = error.issues.map((issue) => issue.path.join('.') || 'response').join(', ');
        throw new Error(`Cognitive1 returned an unexpected response (${fields}).`);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Cognitive1 did not respond before the request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mcpClient(): Promise<Client> {
    const access = await this.options.access.loopbackAccess('cognitive1');
    const fingerprint = `${access.endpoint}\n${access.token}`;
    if (this.mcpConnection?.fingerprint === fingerprint) return this.mcpConnection.client;

    const previous = this.mcpConnection;
    this.mcpConnection = undefined;
    if (previous) await previous.client.close().catch(() => undefined);

    const transport = new StreamableHTTPClientTransport(new URL('/mcp', access.endpoint), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${access.token}`,
        },
      },
      reconnectionOptions: {
        maxReconnectionDelay: 5_000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 1,
      },
    });
    const client = new Client({ name: 'KAI Desktop', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.mcpConnection = { fingerprint, client };
    return client;
  }
}

function toBrainEntry(raw: z.infer<typeof rawRecallEntrySchema>): BrainEntry {
  const fields = raw.fields ?? {};
  return brainEntrySchema.parse({
    date: raw.date,
    title: raw.title,
    agent: raw.agent,
    type: raw.type,
    tags: raw.tags,
    project: raw.project || fields.project || fields.Project || 'global',
    fields,
    status: fields.status || fields.Status || null,
  });
}

function isBrainEntryType(value: string): value is BrainEntryType {
  return value === 'bugs' || value === 'decisions' || value === 'gotchas' || value === 'patterns';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Project notes carry a path and entries carry the names actually used; keep both, one row per exact spelling. */
function mergeKnownProjects(
  notes: readonly KnownBrainProject[],
  used: ReadonlyArray<{ name: string; count: number }>,
): KnownBrainProject[] {
  const merged = new Map<string, KnownBrainProject>();
  for (const project of notes) merged.set(project.name, { ...project });
  for (const { name, count } of used) {
    const existing = merged.get(name);
    if (existing) existing.count = count;
    else merged.set(name, { name, path: null, count });
  }
  return [...merged.values()];
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function operationRoute(
  operation: Cognitive1Operation,
  payload: Record<string, unknown>,
): { path: string; method: string; body?: Record<string, unknown> } {
  const get = (path: string, query: Record<string, unknown> = payload): { path: string; method: string } => ({
    path: withQuery(path, query),
    method: 'GET',
  });
  const post = (path: string, body: Record<string, unknown> = payload): { path: string; method: string; body: Record<string, unknown> } => ({
    path,
    method: 'POST',
    body,
  });

  switch (operation) {
    case 'status': return get('/api/status', {});
    case 'metrics': return get('/api/metrics', {});
    case 'self-review': return post('/api/self-review', {});
    case 'brain-learn': return post('/api/brain/learn');
    case 'brain-auto-learn': return post('/api/brain/auto-learn');
    case 'brain-prune': return post('/api/brain/prune');
    case 'brain-ping': return get('/api/brain/ping', {});
    case 'brain-export': return get('/api/brain/export', { format: payload.format ?? 'json' });
    case 'brain-drafts': return get('/api/brain/drafts', {});
    case 'brain-draft-approve': return post('/api/brain/drafts/approve');
    case 'brain-draft-approve-all': return post('/api/brain/drafts/approve-all', {});
    case 'brain-draft-reject': return post('/api/brain/drafts/reject');
    case 'brain-draft-type': return post('/api/brain/drafts/type');
    case 'brain-recall-feedback': return post('/api/brain/recall-feedback');
    case 'active-claim': return post('/api/active/claim');
    case 'active-release': return post('/api/active/release');
    case 'active-release-all': return post('/api/active/release-all');
    case 'handoffs': return get('/api/handoffs');
    case 'handoff-claim': return post('/api/handoff/claim');
    case 'handoff-suggest': return get('/api/brain/handoff/suggest');
    case 'urgent-list': return get('/api/urgent', {});
    case 'urgent-set': return post('/api/urgent');
    case 'urgent-clear': return post('/api/urgent/clear');
    case 'todo-projects': return get('/api/todo-projects', {});
    case 'todo-project-create': return post('/api/todo-projects');
    case 'task-create': return post('/api/task/create');
    case 'tasks': return get('/api/tasks');
    case 'task-claim': return post('/api/task/claim');
    case 'task-complete': return post('/api/task/complete');
    case 'reviews': return get('/api/reviews');
    case 'regressions': return get('/api/regressions');
    case 'costs': return get('/api/costs');
    case 'cost-log': return post('/api/costs');
    case 'cost-clear': return { path: '/api/costs', method: 'DELETE' };
    case 'recap-check': return get('/api/recap-check');
    case 'recap-check-log': return post('/api/recap-check');
    case 'graph': return get('/api/graph');
    case 'skills': return get('/api/skills', {});
    case 'skill-content': return get('/api/skill/content');
    case 'skill-save': return post('/api/skill/save');
    case 'overwatch-status': return get('/api/overwatch/status', {});
    case 'overwatch-config': return post('/api/overwatch/config');
    case 'overwatch-insights': return get('/api/overwatch/insights', {});
    case 'overwatch-run': return post('/api/overwatch/run', {});
    case 'overwatch-audit': return post('/api/overwatch/audit', {});
    case 'overwatch-resolve-preview': return post('/api/overwatch/resolve-preview', {});
    case 'overwatch-resolve': return post('/api/overwatch/resolve', {});
    case 'overwatch-triage-recovery': return post('/api/overwatch/triage-recovery', {});
    case 'overwatch-release-stale': return post('/api/overwatch/release-stale', {});
    case 'overwatch-release-one': return post('/api/overwatch/release-one');
    case 'overwatch-semantic-dupes': return post('/api/overwatch/semantic-dupes', {});
    case 'overwatch-auto-fix': return post('/api/overwatch/auto-fix');
    case 'overwatch-cross-ref-bugs': return post('/api/overwatch/cross-ref-bugs', {});
    case 'overwatch-heuristic-clean': return post('/api/overwatch/heuristic-clean', {});
    case 'overwatch-distill-kernels': return post('/api/overwatch/distill-kernels', {});
    case 'overwatch-push-to-memory': return post('/api/overwatch/push-to-memory', {});
    case 'overwatch-link': return post('/api/overwatch/link', {});
    case 'integration-status': return get('/api/projects/integration-status', {});
    case 'deploy-c1': return post('/api/projects/deploy-c1', {});
    case 'project-update': return post('/api/project/update');
    case 'git-status': return get('/api/git-status', {});
    case 'checkpoint': return post('/api/checkpoint');
    case 'recover': return get('/api/recover');
    case 'suggest': return get('/api/suggest');
    case 'theme': return get('/api/theme', {});
    case 'theme-save': return post('/api/theme');
  }
}

function withQuery(path: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) params.set(key, value.map(String).join(','));
    else if (typeof value !== 'object') params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Cognitive1 returned non-JSON content (${response.status}).`);
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  return `Cognitive1 request failed with status ${status}.`;
}
