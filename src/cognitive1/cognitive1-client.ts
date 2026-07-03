export interface CognitiveSessionStart {
  projectPath?: string;
  task: string;
  agent: string;
}

export interface CognitiveRecall {
  query: string;
  project?: string;
}

export interface CognitiveHandoff {
  fromAgent: string;
  toAgent: string;
  summary: string;
  projectPath?: string;
}

export interface Cognitive1Client {
  health(): Promise<Cognitive1Health>;
  sessionStart(input: CognitiveSessionStart): Promise<string>;
  recall(input: CognitiveRecall): Promise<string>;
  handoff(input: CognitiveHandoff): Promise<string>;
}

export interface Cognitive1Health {
  available: boolean;
  detail: string;
}

export class DisabledCognitive1Client implements Cognitive1Client {
  async health(): Promise<Cognitive1Health> {
    return { available: false, detail: 'Cognitive1 disabled in KAI settings.' };
  }

  async sessionStart(input: CognitiveSessionStart): Promise<string> {
    return `Cognitive1 disabled: session_start pending for ${input.agent}.`;
  }

  async recall(input: CognitiveRecall): Promise<string> {
    return `Cognitive1 disabled: recall pending for "${input.query}".`;
  }

  async handoff(input: CognitiveHandoff): Promise<string> {
    return `Cognitive1 disabled: handoff pending from ${input.fromAgent} to ${input.toAgent}.`;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface SessionStartResponse {
  briefed?: boolean;
  briefing?: string;
  message?: string;
  project?: string;
  claimed?: boolean;
  conflicts?: { agent: string; what: string }[];
  error?: string;
}

interface RecallResponse {
  mode?: string;
  results?: {
    date: string;
    title: string;
    agent: string;
    type: string;
    tags?: string;
    fields?: Record<string, string>;
  }[];
  error?: string;
}

interface HandoffResponse {
  ok?: boolean;
  handoff?: {
    project?: string;
    status?: string;
    next?: string;
  };
  error?: string;
}

export class Cognitive1HttpClient implements Cognitive1Client {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(baseUrl: string, fetcher: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetcher = fetcher;
  }

  async health(): Promise<Cognitive1Health> {
    try {
      const response = await this.fetchJson<{ status?: string; uptime?: number }>('/health', undefined, 'GET');
      if (response.status === 'ok') {
        return { available: true, detail: `Cognitive1 ready${typeof response.uptime === 'number' ? ` (${Math.round(response.uptime)}s uptime)` : ''}.` };
      }
      return { available: false, detail: 'Cognitive1 health response was not ok.' };
    } catch (error) {
      return { available: false, detail: `Cognitive1 unavailable: ${errorMessage(error)}` };
    }
  }

  async sessionStart(input: CognitiveSessionStart): Promise<string> {
    try {
      const data = await this.fetchJson<SessionStartResponse>('/api/session/start', {
        agent: input.agent,
        project_path: input.projectPath,
        task: input.task,
        format: 'json'
      });
      if (data.error) {
        return `Cognitive1 session_start failed: ${data.error}`;
      }
      const conflictNote = data.conflicts?.length
        ? ` Conflicts: ${data.conflicts.map((conflict) => `${conflict.agent} (${conflict.what})`).join(', ')}.`
        : '';
      if (data.briefing) {
        return `Briefing for ${data.project || 'workspace'} ready.${conflictNote}\n${truncate(data.briefing, 1200)}`;
      }
      return `${data.message || `Session claimed for ${data.project || 'workspace'}.`}${conflictNote}`;
    } catch (error) {
      return `Cognitive1 session_start unavailable: ${errorMessage(error)}`;
    }
  }

  async recall(input: CognitiveRecall): Promise<string> {
    try {
      const data = await this.fetchJson<RecallResponse>('/api/brain/recall', {
        query: input.query,
        project: input.project,
        max_results: 5,
        format: 'json'
      });
      if (data.error) {
        return `Cognitive1 recall failed: ${data.error}`;
      }
      const results = data.results || [];
      if (results.length === 0) {
        return 'No Cognitive1 recall results found.';
      }
      return `Recall found ${results.length} result(s): ${results
        .map((result) => `[${result.type}] ${result.title}`)
        .join('; ')}`;
    } catch (error) {
      return `Cognitive1 recall unavailable: ${errorMessage(error)}`;
    }
  }

  async handoff(input: CognitiveHandoff): Promise<string> {
    try {
      const data = await this.fetchJson<HandoffResponse>('/api/brain/handoff', {
        from_agent: input.fromAgent,
        to_agent: input.toAgent,
        project: input.projectPath,
        notes: input.summary
      });
      if (data.error) {
        return `Cognitive1 handoff failed: ${data.error}`;
      }
      return data.ok ? 'Cognitive1 handoff recorded.' : 'Cognitive1 handoff response was not acknowledged.';
    } catch (error) {
      return `Cognitive1 handoff unavailable: ${errorMessage(error)}`;
    }
  }

  private async fetchJson<T>(path: string, body?: Record<string, unknown>, method = 'POST'): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as T : {} as T;
    if (!response.ok) {
      const maybeError = parsed as { error?: string };
      throw new Error(maybeError.error || `HTTP ${response.status}`);
    }
    return parsed;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
