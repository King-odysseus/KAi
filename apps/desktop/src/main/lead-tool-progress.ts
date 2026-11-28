import { createHash } from 'node:crypto';
import type { AgentRunRequest } from '@kai/contracts';
import { isLeadRun } from './lead-run-policy';

export const LEAD_TOOL_ROUND_LIMIT = 12;
export const LEAD_FINAL_ANSWER = 'Finish the Lead reply now using the evidence already returned. Do not announce more reading, repeat inspection, execute a Builder task, or claim missing checks passed. Explain the current blocker, recommend a concrete next step or an independent planned task, and ask for a specific decision only when needed. If evidence is incomplete, say exactly what is missing. Keep any proposed Builder task clearly marked.';

export function leadToolRoundLimit(request: AgentRunRequest, otherwise: number): number {
  return isLeadRun(request) ? Math.min(otherwise, LEAD_TOOL_ROUND_LIMIT) : otherwise;
}

/** Run-local evidence, separate from provider history so folding cannot erase what was already inspected. */
export class LeadToolProgress {
  private readonly lines = new Map<string, Map<number, string>>();
  private readonly results = new Set<string>();
  private repeats = 0;

  observe(name: string, input: unknown, output: unknown): { finish: boolean; notice?: string } {
    if (!['read_file', 'outline_file', 'search_files', 'list_files'].includes(name)) return { finish: false };
    let repeated = false;
    const value = output && typeof output === 'object' ? output as Record<string, unknown> : null;
    if (name === 'read_file' && typeof value?.path === 'string' && typeof value.text === 'string' && value.text) {
      const key = value.path.replace(/\\/g, '/').replace(/^\.\//, '');
      const known = this.lines.get(key) ?? new Map<number, string>();
      const returned = value.text.split('\n').map((line) => /^(\d+): ?(.*)$/.exec(line));
      if (returned.every((line) => line !== null)) {
        repeated = returned.every((line) => known.get(Number(line![1])) === digest(line![2]!));
        for (const line of returned) known.set(Number(line![1]), digest(line![2]!));
        this.lines.set(key, known);
      } else repeated = this.seen(name, input, output);
    } else repeated = this.seen(name, input, output);
    this.repeats = repeated ? this.repeats + 1 : 0;
    return repeated ? {
      finish: this.repeats >= 2,
      notice: `This unchanged evidence was already read in this Lead reply. Use the returned evidence rather than rereading it.${this.repeats >= 2 ? ` ${LEAD_FINAL_ANSWER}` : ''}`,
    } : { finish: false };
  }

  private seen(name: string, input: unknown, output: unknown): boolean {
    const key = digest(stableJson([name, input, output]));
    const repeated = this.results.has(key);
    this.results.add(key);
    return repeated;
  }
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? '';
}

const runs = new WeakMap<object, LeadToolProgress>();
export function leadToolProgress(runtime: object): LeadToolProgress {
  let progress = runs.get(runtime);
  if (!progress) { progress = new LeadToolProgress(); runs.set(runtime, progress); }
  return progress;
}
