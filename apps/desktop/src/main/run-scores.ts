import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runScoreSchema, type AgentId, type AgentScorecard, type RunScore, type WorkLevel } from '@kai/contracts';

const MAX_STORED = 500;
/** Only the most recent runs in a bucket count, so an agent that improves is not held back by old failures. */
const RECENT_WINDOW = 30;
export const MIN_RUNS_TO_JUDGE = 5;
/** An agent is sent up a level only when more than this share of its recent runs went wrong. */
export const ESCALATE_ABOVE_FAILURE_RATE = 0.5;

const NEXT_LEVEL: Record<WorkLevel, WorkLevel> = { light: 'standard', standard: 'heavy', heavy: 'heavy' };

export class RunScoreStore {
  constructor(private readonly file: string) {}

  async list(): Promise<RunScore[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown[];
      return parsed.flatMap((item) => {
        const score = runScoreSchema.safeParse(item);
        return score.success ? [score.data] : [];
      });
    } catch {
      return [];
    }
  }

  async add(score: RunScore): Promise<void> {
    const next = [...(await this.list()), score].slice(-MAX_STORED);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(next), 'utf8');
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}

/** A run counts as clean when it finished, and neither its checks nor a fix round said otherwise. */
export function isCleanRun(score: RunScore): boolean {
  // Missing verification is not evidence of success. Only explicit passing checks qualify.
  return score.completed && score.checkPassed === true && score.fixRounds === 0;
}

/**
 * A run that went wrong: it did not finish, a check failed, or it needed a fix round. A run with no check is neither
 * clean nor failed, so agents are never moved up a level just because nothing verified their work.
 */
export function isFailedRun(score: RunScore): boolean {
  return !score.completed || score.checkPassed === false || score.fixRounds > 0;
}

export function summarizeScores(scores: readonly RunScore[]): AgentScorecard[] {
  const buckets = new Map<string, RunScore[]>();
  for (const score of scores) {
    const key = `${score.agent}|${score.execution}|${score.level}`;
    buckets.set(key, [...(buckets.get(key) ?? []), score]);
  }
  return [...buckets.values()]
    .map((entries): AgentScorecard => {
      const recent = entries.slice(-RECENT_WINDOW);
      const first = recent[0]!;
      const clean = recent.filter(isCleanRun).length;
      const failed = recent.filter(isFailedRun).length;
      const durations = recent.map((entry) => entry.durationMs).sort((a, b) => a - b);
      const middle = Math.floor(durations.length / 2);
      const median = durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
      const cleanRate = clean / recent.length;
      return {
        agent: first.agent,
        execution: first.execution,
        level: first.level,
        runs: recent.length,
        cleanRuns: clean,
        cleanRate,
        medianDurationMs: median,
        totalCostUsd: recent.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
        escalated: first.execution === 'cli' && first.level !== 'heavy' && recent.length >= MIN_RUNS_TO_JUDGE && failed / recent.length > ESCALATE_ABOVE_FAILURE_RATE,
      };
    })
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.execution.localeCompare(b.execution) || levelRank(a.level) - levelRank(b.level));
}

function levelRank(level: WorkLevel): number {
  return level === 'light' ? 0 : level === 'standard' ? 1 : 2;
}

/**
 * The level to use for a request once the agent's own record is taken into account: an agent that keeps failing at
 * a level gets that kind of work handed to a stronger model instead.
 */
export function escalatedLevel(level: WorkLevel, agent: AgentId, scores: readonly RunScore[]): { level: WorkLevel; why?: string } {
  const card = summarizeScores(scores).find((entry) => entry.agent === agent && entry.execution === 'cli' && entry.level === level);
  if (!card?.escalated) return { level };
  const next = NEXT_LEVEL[level];
  return {
    level: next,
    why: `${agent} has had trouble with its last ${card.runs} ${level} runs, so this goes one level up`,
  };
}
