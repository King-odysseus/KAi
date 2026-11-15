import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRoadmap, createDefaultCrewConfig, crewConfigSchema, crewRunSchema, phaseKey } from '@kai/contracts';
import type { CrewRun } from '@kai/contracts';
import { NodeFileSystem } from '../packages/runtime/src';
import {
  acceptPhase, addTasks, openTasks, phaseFromFollowUp, reopenOpenTasks, resetForRevert, setTaskCheckpoint, taskBrief, tasksToRebuild, teachBlockers,
} from '../apps/desktop/src/main/crew-engine';
import { parsePlan, planPrompt } from '../apps/desktop/src/main/crew-prompts';
import { withCrewException } from '../apps/desktop/src/main/execution-rules';
import { CrewBlockerStore } from '../apps/desktop/src/main/crew-blockers';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';

function newRun(patch: Partial<CrewRun['config']> = {}): CrewRun {
  const config = crewConfigSchema.parse({ ...createDefaultCrewConfig('claude', 'codex'), ...patch });
  return crewRunSchema.parse({
    schemaVersion: 1, id: 'run_1', projectId: 'p1', goal: 'Build Zuri from the plan', status: 'running', config,
    tasks: [], feed: [], startedAt: T0, updatedAt: T0,
  });
}

/** Two phases: Phase 0 finished (two tasks, $1.50 and $0.50), Phase 1 half built, and Phase 2 only known from the Lead. */
function phased(): CrewRun {
  const { run } = addTasks(newRun(), [
    { id: 'a', title: 'Spike', role: 'builder', acceptance: ['Works'], phase: 'Phase 0: Spike' },
    { id: 'b', title: 'Report', role: 'builder', acceptance: ['Written'], phase: 'Phase 0 - Spike' },
    { id: 'c', title: 'Shell', role: 'builder', acceptance: ['Opens'], phase: 'Phase 1: Shell' },
    { id: 'd', title: 'Gating', role: 'builder', acceptance: ['Gates'], phase: 'Phase 1: Shell' },
  ], T0);
  const costs: Record<string, number> = { a: 1.5, b: 0.5, c: 0.25, d: 0 };
  return {
    ...run,
    remaining: ['Phase 1: Shell, gating, access', 'Phase 2: Provider layer'],
    tasks: run.tasks.map((task) => ({
      ...task,
      costUsd: costs[task.id] ?? 0,
      status: task.id === 'a' || task.id === 'b' ? 'accepted' as const : task.id === 'c' ? 'building' as const : 'backlog' as const,
    })),
  };
}

describe('the plan as phases', () => {
  it('reads "Phase 1: Shell" and "Phase 1 - Shell, gating" as the same phase', () => {
    expect(phaseKey('Phase 1: Shell')).toBe('phase 1');
    expect(phaseKey('Phase 1 - Shell, gating, access')).toBe('phase 1');
    expect(phaseKey('The spike')).toBe('the spike');
  });

  it('lists each phase with where it stands, merging what the Lead found undone', () => {
    const rows = buildRoadmap(phased());
    expect(rows.map((row) => [row.key, row.status, row.finished, row.tasks])).toEqual([
      ['phase 0', 'done', 2, 2],
      ['phase 1', 'building', 0, 2],
      ['phase 2', 'notStarted', 0, 0],
    ]);
    expect(rows[0]?.costUsd).toBe(2);
  });

  it('estimates a phase not started from the finished ones, and not before any has finished', () => {
    expect(buildRoadmap(phased()).find((row) => row.key === 'phase 2')?.estimateUsd).toBe(2);
    const none = { ...phased(), tasks: phased().tasks.map((task) => ({ ...task, status: 'backlog' as const })) };
    expect(buildRoadmap(none).find((row) => row.key === 'phase 2')?.estimateUsd).toBeNull();
  });

  it('shows nothing for a plan that was never split into phases', () => {
    const { run } = addTasks(newRun(), [{ id: 'a', title: 'Do it', role: 'builder', acceptance: ['Done'] }], T0);
    expect(buildRoadmap(run)).toEqual([]);
  });

  it('takes the phase a follow-up asked for, so its tasks are filed under it', () => {
    expect(phaseFromFollowUp('Continue the plan with: Phase 1: Shell. Still to do after it: Phase 2.')).toBe('Phase 1: Shell');
    expect(phaseFromFollowUp('Continue the plan with: Phase 3: Providers.')).toBe('Phase 3: Providers');
    expect(phaseFromFollowUp('Add a dark mode.')).toBeNull();
    expect(phaseFromFollowUp(null)).toBeNull();
  });

  it('has the planner file every task under its phase, and says so in the prompt', () => {
    const plan = parsePlan(JSON.stringify({ tasks: [{ id: 'x', title: 'Shell', role: 'builder', acceptance: ['Opens'], phase: 'Phase 1: Shell' }, { id: 'y', title: 'Loose', role: 'builder', acceptance: ['Ok'] }] }));
    expect(plan?.map((task) => task.phase)).toEqual(['Phase 1: Shell', null]);
    const run = newRun();
    expect(planPrompt(run.goal, run.config, '', run)).toContain('give every task a "phase"');
  });
});

describe('accepting a phase', () => {
  it('records the acceptance of a finished phase once, and says so on the thread', () => {
    const next = acceptPhase(phased(), 'Phase 0: Spike', T1);
    expect(next.acceptedPhases).toEqual(['phase 0']);
    expect(buildRoadmap(next)[0]?.status).toBe('accepted');
    expect(next.chat.at(-1)).toMatchObject({ from: 'you', kind: 'note', text: 'Accepted: Phase 0: Spike' });
    expect(acceptPhase(next, 'Phase 0: Spike', T1)).toBe(next);
  });

  it('refuses a phase that is not finished or not on the plan', () => {
    expect(() => acceptPhase(phased(), 'Phase 1: Shell', T1)).toThrow(/not finished yet/);
    expect(() => acceptPhase(phased(), 'Phase 9', T1)).toThrow(/not on this crew/);
  });
});

describe('going back to before a task', () => {
  const checkpoint = (at: string) => ({ ref: `ref-${at}`, untracked: [], createdAt: at });

  function withCheckpoints(): CrewRun {
    let run = phased();
    run = setTaskCheckpoint(run, 'a', checkpoint('2026-11-01T10:01:00.000Z'), T1);
    run = setTaskCheckpoint(run, 'b', checkpoint('2026-11-01T10:02:00.000Z'), T1);
    run = setTaskCheckpoint(run, 'c', checkpoint('2026-11-01T10:03:00.000Z'), T1);
    return run;
  }

  it('keeps a task\'s first checkpoint, not a later one', () => {
    const run = withCheckpoints();
    expect(setTaskCheckpoint(run, 'a', checkpoint('2026-11-01T11:00:00.000Z'), T1).tasks.find((task) => task.id === 'a')?.checkpoint?.ref).toBe('ref-2026-11-01T10:01:00.000Z');
  });

  it('rebuilds the task and every task that started after it, and nothing that started before', () => {
    expect(tasksToRebuild(withCheckpoints(), 'b').map((task) => task.id)).toEqual(['b', 'c']);
    expect(tasksToRebuild(phased(), 'a')).toEqual([]);
  });

  it('puts those tasks back to waiting, pauses the crew, and un-accepts a phase it reopens', () => {
    const accepted = { ...withCheckpoints(), acceptedPhases: ['phase 0'] };
    const next = resetForRevert(accepted, 'b', 'Went back to before "Report".', T1);
    expect(next.status).toBe('paused');
    expect(next.tasks.find((task) => task.id === 'a')?.status).toBe('accepted');
    expect(next.tasks.find((task) => task.id === 'b')).toMatchObject({ status: 'backlog', round: 0, files: [], checkpoint: null });
    expect(next.tasks.find((task) => task.id === 'c')).toMatchObject({ status: 'backlog', checkpoint: null });
    expect(next.acceptedPhases).toEqual([]);
    expect(next.chat.at(-1)?.text).toContain('Went back to before "Report"');
  });
});

describe('committing, and what earlier crews learned', () => {
  it('tells a builder not to commit unless the crew is set to', () => {
    const quiet = addTasks(newRun(), [{ id: 'a', title: 'Do it', role: 'builder', acceptance: ['Done'] }], T0).run;
    expect(taskBrief(quiet, 'a')).toContain('Do not run git commit or git push');
    const committing = addTasks(newRun({ commitWork: true }), [{ id: 'a', title: 'Do it', role: 'builder', acceptance: ['Done'] }], T0).run;
    expect(taskBrief(committing, 'a')).not.toContain('Do not run git commit');
  });

  it('writes the crew\'s exception inside the standing rules, where it outranks them', () => {
    const rules = withCrewException('## Rules\n\n1. **Commit** always.');
    expect(rules).toContain('Exception for Crew runs');
    expect(rules).toContain('do not run git add, git commit or git push');
  });

  it('starts a new crew knowing what earlier crews learned, without telling it twice', () => {
    const learned = [{ key: 'selftag:copilot', note: 'A commit hook rejects the word "copilot".' }];
    const taught = teachBlockers(newRun(), learned);
    expect(taught.goal).toContain('What the crew has learned');
    expect(taught.goal).toContain('rejects the word "copilot"');
    expect(taught.knownBlockers).toEqual(['selftag:copilot']);
    expect(teachBlockers(taught, learned).goal).toBe(taught.goal);
  });
});

describe('the project\'s remembered blockers', () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });

  it('keeps a blocker for its project only, once, and loads it back', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-blockers-'));
    folders.push(folder);
    const store = new CrewBlockerStore(path.join(folder, 'crew-blockers.json'), new NodeFileSystem());
    await store.save('p1', { key: 'selftag:copilot', note: 'Leave the word out of commit messages.' });
    await store.save('p1', { key: 'selftag:copilot', note: 'Leave the word out of commit messages.' });
    await store.save('p2', { key: 'hook:other', note: 'Something else.' });
    expect(await store.load('p1')).toEqual([{ key: 'selftag:copilot', note: 'Leave the word out of commit messages.' }]);
    expect(await store.load('p2')).toHaveLength(1);
    expect(await store.load('nobody')).toEqual([]);
  });
});

describe('carrying on with what is already on the board', () => {
  it('counts the tasks that are planned and not done, and nothing accepted or skipped', () => {
    expect(openTasks(phased()).map((task) => task.id)).toEqual(['c', 'd']);
  });

  it('sets a stopped crew running again, putting work that was mid-build back to waiting', () => {
    const stopped = { ...phased(), status: 'stopped' as const, completedAt: T0 };
    const next = reopenOpenTasks(stopped, 'Carrying on.', T1);
    expect(next.status).toBe('running');
    expect(next.completedAt).toBeNull();
    expect(next.tasks.find((task) => task.id === 'c')?.status).toBe('backlog');
    expect(next.tasks.find((task) => task.id === 'a')?.status).toBe('accepted');
    expect(next.chat.at(-1)?.text).toBe('Carrying on.');
  });
});
