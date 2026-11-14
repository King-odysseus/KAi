import * as fs from 'fs/promises';
import * as path from 'path';
import type { AgentId } from './types';

export type AutomationStatus = 'active' | 'paused';
export type AutomationRunStatus = 'running' | 'needsReview' | 'failed' | 'skipped';
export type AutomationTrigger = { kind: 'interval' } | { kind: 'fileSave'; pattern: string };

export interface KaiAutomation {
  id: string;
  name: string;
  prompt: string;
  agent: AgentId;
  intervalMinutes: number;
  /** Missing on older records means the original interval trigger. */
  trigger?: AutomationTrigger;
  status: AutomationStatus;
  skills: string[];
  nextRunAt: string;
  createdAt: string;
  lastRunAt?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  detail?: string;
}

interface AutomationData { automations: KaiAutomation[]; runs: AutomationRun[]; }

export class AutomationStore {
  private data: AutomationData = { automations: [], runs: [] };
  private loaded = false;
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<AutomationData>;
      this.data = {
        automations: Array.isArray(parsed.automations) ? parsed.automations : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      };
      // A process restart interrupts in-flight runs. Keep them visible for the user.
      this.data.runs = this.data.runs.map((run) => run.status === 'running'
        ? { ...run, status: 'failed', finishedAt: new Date().toISOString(), detail: 'KAI restarted before this run finished.' }
        : run);
    } catch { this.data = { automations: [], runs: [] }; }
    await this.save();
  }

  list(): KaiAutomation[] { return this.data.automations.map((item) => ({ ...item, skills: [...item.skills] })); }
  listRuns(): AutomationRun[] { return this.data.runs.map((run) => ({ ...run })); }

  async add(input: Omit<KaiAutomation, 'id' | 'createdAt' | 'nextRunAt'>): Promise<KaiAutomation> {
    const now = new Date();
    const item: KaiAutomation = {
      ...input, id: `automation_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
      skills: [...input.skills], createdAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString(),
    };
    this.data.automations.push(item); await this.save(); return item;
  }

  async remove(id: string): Promise<void> {
    this.data.automations = this.data.automations.filter((item) => item.id !== id);
    await this.save();
  }

  async setStatus(id: string, status: AutomationStatus): Promise<void> {
    const item = this.data.automations.find((entry) => entry.id === id);
    if (item) { item.status = status; if (status === 'active') item.nextRunAt = new Date(Date.now() + item.intervalMinutes * 60_000).toISOString(); }
    await this.save();
  }

  async due(now = new Date()): Promise<KaiAutomation[]> {
    const result = this.data.automations.filter((item) => (item.trigger?.kind ?? 'interval') === 'interval' && item.status === 'active' && Date.parse(item.nextRunAt) <= now.getTime());
    for (const item of result) {
      item.lastRunAt = now.toISOString();
      item.nextRunAt = new Date(now.getTime() + item.intervalMinutes * 60_000).toISOString();
    }
    if (result.length) await this.save();
    return result.map((item) => ({ ...item, skills: [...item.skills] }));
  }

  async dueForFileSave(filePath: string, now = new Date()): Promise<KaiAutomation[]> {
    const result = this.data.automations.filter((item) => item.status === 'active'
      && item.trigger?.kind === 'fileSave'
      && matchesFilePattern(item.trigger.pattern, filePath)
      && (!item.lastRunAt || now.getTime() - Date.parse(item.lastRunAt) >= item.intervalMinutes * 60_000));
    for (const item of result) {
      item.lastRunAt = now.toISOString();
      item.nextRunAt = new Date(now.getTime() + item.intervalMinutes * 60_000).toISOString();
    }
    if (result.length) await this.save();
    return result.map((item) => ({ ...item, skills: [...item.skills] }));
  }

  async beginRun(item: KaiAutomation): Promise<AutomationRun> {
    const run: AutomationRun = {
      id: `automation_run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      automationId: item.id, automationName: item.name, status: 'running', startedAt: new Date().toISOString(),
    };
    this.data.runs.unshift(run); this.data.runs = this.data.runs.slice(0, 100); await this.save(); return run;
  }

  async finishRun(id: string, status: AutomationRunStatus, detail?: string): Promise<void> {
    const run = this.data.runs.find((entry) => entry.id === id);
    if (run) { run.status = status; run.finishedAt = new Date().toISOString(); run.detail = detail; await this.save(); }
  }

  async acknowledgeRun(id: string): Promise<void> {
    this.data.runs = this.data.runs.filter((run) => run.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }
}

export function matchesFilePattern(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedPattern || normalizedPattern.includes('..')) return false;
  let source = '^';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      index += 1;
      if (normalizedPattern[index + 1] === '/') { source += '(?:.*/)?'; index += 1; }
      else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  try { return new RegExp(`${source}$`, 'i').test(normalizedPath); } catch { return false; }
}
