import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { redactText } from '@kai/runtime';

export interface AgentExperience {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  projectId: string;
  conversationId: string;
  request: string;
  response: string;
  agent: string;
  execution: 'cli' | 'api';
  model?: string;
  outcome: 'verified' | 'unverified' | 'failed' | 'cancelled';
  verification: Array<{ command?: string; passed: boolean | null; detail?: string }>;
  changes: Array<{ path: string; additions: number; removals: number; patch?: string }>;
  reviewedForTraining: boolean;
  /** This run has already been promoted to Brain memory or dismissed as a suggestion. */
  memorySuggestionReviewed?: boolean;
}

const CAP = 500;
const TEXT_CAP = 20_000;
const DIFF_CAP = 80_000;

/** Explicitly local, bounded, secret-redacted experience records. No hidden reasoning is collected. */
export class AgentExperienceStore {
  constructor(private readonly file: string) {}

  async list(): Promise<AgentExperience[]> {
    try {
      const rows = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown;
      return Array.isArray(rows) ? rows.filter(isExperience) : [];
    } catch { return []; }
  }

  async add(record: AgentExperience, retentionDays: number): Promise<void> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const next = [...(await this.list()).filter((item) => Date.parse(item.createdAt) >= cutoff), record].slice(-CAP);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next), 'utf8');
    await fs.rename(temporary, this.file);
  }

  async clear(): Promise<void> { await fs.rm(this.file, { force: true }); }

  async markMemorySuggestionsReviewed(ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    if (!wanted.size) return;
    const next = (await this.list()).map((item) => wanted.has(item.id) ? { ...item, memorySuggestionReviewed: true } : item);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next), 'utf8');
    await fs.rename(temporary, this.file);
  }

  async exportReviewed(): Promise<string> {
    return (await this.list()).map((item) => JSON.stringify(item)).join('\n');
  }
}

function isExperience(value: unknown): value is AgentExperience {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AgentExperience>;
  return row.schemaVersion === 1 && typeof row.id === 'string' && typeof row.createdAt === 'string'
    && typeof row.request === 'string' && typeof row.response === 'string' && Array.isArray(row.changes);
}

export function makeAgentExperience(input: Omit<AgentExperience, 'request' | 'response' | 'changes'> & {
  request: string; response: string; changes: Array<{ path: string; additions: number; removals: number; patch?: string }>;
}, includeContent: boolean): AgentExperience {
  return {
    ...input,
    request: includeContent ? redactText(input.request).slice(0, TEXT_CAP) : '',
    response: includeContent ? redactText(input.response).slice(0, TEXT_CAP) : '',
    changes: input.changes.slice(0, 100).map((change) => ({
      path: redactText(change.path).slice(0, 500),
      additions: change.additions,
      removals: change.removals,
      ...(includeContent && change.patch ? { patch: redactText(change.patch).slice(0, DIFF_CAP) } : {}),
    })),
    verification: input.verification.slice(0, 100).map((item) => ({
      ...item,
      ...(item.command ? { command: redactText(item.command).slice(0, 1000) } : {}),
      ...(item.detail ? { detail: redactText(item.detail).slice(0, 2_000) } : {}),
    })),
  };
}
