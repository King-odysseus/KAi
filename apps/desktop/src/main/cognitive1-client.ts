import { z } from 'zod';
import {
  brainEntrySchema,
  brainFieldUpdateInputSchema,
  brainFieldUpdateResultSchema,
  brainOverviewSchema,
  brainSearchInputSchema,
  type AgentId,
  type BrainEntry,
  type BrainEntryType,
  type BrainFieldUpdateInput,
  type BrainFieldUpdateResult,
  type BrainOverview,
  type BrainSearchInput,
} from '@kai/contracts';
import type { ServiceKind } from '@kai/contracts';

export interface Cognitive1LoopbackAccess {
  loopbackAccess(kind: ServiceKind): Promise<{ endpoint: string; token: string }>;
}

export interface Cognitive1ClientOptions {
  access: Cognitive1LoopbackAccess;
  timeoutMs?: number;
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
  projects: z.array(z.unknown()).default([]),
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

export class Cognitive1Client {
  private readonly timeoutMs: number;

  constructor(private readonly options: Cognitive1ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async overview(): Promise<BrainOverview> {
    const [status, quality] = await Promise.all([
      this.requestJson('/api/status', undefined, rawStatusSchema),
      this.requestJson('/api/brain/quality', undefined, rawQualitySchema),
    ]);

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
