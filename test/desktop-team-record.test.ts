import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAgentTeam, type TeamRecordEntry, type TeamResolvedAssignee, type WorkflowRun } from '../packages/contracts/src';
import { NodeFileSystem } from '../packages/runtime/src';
import { betterRecord, recordsForRun, roleRecord } from '../apps/desktop/src/main/team-record';
import { TeamRecordStore } from '../apps/desktop/src/main/team-record-store';
import { assignTeam, teamAdvice, type AssignmentEnvironment } from '../apps/desktop/src/main/team-assign';

const startedAt = '2026-09-01T12:00:00.000Z';
function entry(overrides: Partial<TeamRecordEntry> = {}): TeamRecordEntry {
  return { id: 'job:part', projectId: 'project', role: 'backend', custom: false, assignee: 'codex', route: 'direct', startedAt,
    durationMs: 60_000, outcome: 'completed', neededFix: false, blockedByReview: false, overridden: false, ...overrides };
}
function history(assignee: TeamResolvedAssignee, passed: number, jobs = 5, overrides: Partial<TeamRecordEntry> = {}): TeamRecordEntry[] {
  return Array.from({ length: jobs }, (_, index) => entry({ id: `${assignee}:${index}`, assignee, outcome: index < passed ? 'completed' : 'failed', ...overrides }));
}

describe('team track record', () => {
  it('counts only original finished parts, sums fix effort, and remembers blocks and overrides', () => {
    const run: WorkflowRun = {
      conversationId: 'conversation', projectId: 'project', workflow: {
        id: 'job', title: 'Team job', status: 'paused', createdAt: startedAt, currentStepIndex: 3, execution: 'cli', route: 'direct', autonomy: 'autoEdit',
        steps: [
          { id: 'part', agent: 'qwen', suggestedAssignee: 'codex', role: 'custom-db', access: 'edit', prompt: 'Build', status: 'completed', startedAt, completedAt: '2026-09-01T12:01:00.000Z', costUsd: 0.1 },
          { id: 'fix', agent: 'qwen', role: 'custom-db', prompt: 'Fix', status: 'failed', fixOf: 'part', round: 1, startedAt, completedAt: '2026-09-01T12:02:00.000Z', costUsd: 0.2 },
          { id: 'review', agent: 'claude', role: 'securityReviewer', prompt: 'Review', status: 'completed', startedAt, completedAt: startedAt, gate: 'security', verdict: { result: 'block', reason: 'bad', acknowledged: true } },
          { id: 'review-again', agent: 'claude', role: 'securityReviewer', prompt: 'Review fix', status: 'completed', round: 1, startedAt, completedAt: startedAt },
          { id: 'pending', agent: 'codex', role: 'frontend', prompt: 'Later', status: 'pending' },
        ],
      },
    };
    const records = recordsForRun(run);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: 'job:part', assignee: 'qwen', custom: true, neededFix: true, blockedByReview: true, overridden: true, durationMs: 180_000 });
    expect(records[0]?.costUsd).toBeCloseTo(0.3);
    expect(recordsForRun({ ...run, projectId: undefined })).toEqual([]);
    run.workflow.steps[0] = { ...run.workflow.steps[0], id: 'part', agent: 'qwen', prompt: 'Build', status: 'failed', execution: 'api' };
    expect(recordsForRun(run)[0]).toMatchObject({ assignee: 'api', outcome: 'failed' });
  });

  it('computes first-time success, the median and total known cost', () => {
    const entries = [entry({ durationMs: 100, costUsd: 1 }), entry({ durationMs: 200, neededFix: true }), entry({ durationMs: 800, blockedByReview: true }), entry({ durationMs: 400, outcome: 'failed', costUsd: 2 })];
    expect(roleRecord(entries, 'backend', 'codex')).toMatchObject({ jobs: 4, passed: 1, successRate: 0.25, medianDurationMs: 300, totalCostUsd: 3, scope: 'all' });
    expect(roleRecord(entries.slice(0, 3), 'backend', 'codex')?.medianDurationMs).toBe(200);
    expect(roleRecord(entries, 'frontend', 'codex')).toBeNull();
  });

  it('uses project history only at five entries for that role and agent, otherwise all projects', () => {
    const entries = [...history('codex', 4, 4), ...history('codex', 0, 5, { projectId: 'other' }), ...history('qwen', 5, 5)];
    expect(roleRecord(entries, 'backend', 'codex', 'project')).toMatchObject({ scope: 'all', jobs: 9, passed: 4 });
    expect(roleRecord(entries, 'backend', 'qwen', 'project')).toMatchObject({ scope: 'project', jobs: 5 });
    entries.push(entry({ id: 'fifth' }));
    expect(roleRecord(entries, 'backend', 'codex', 'project')).toMatchObject({ scope: 'project', jobs: 5, passed: 5 });
  });

  it('requires five jobs on both sides and at least fifteen percentage points', () => {
    const current = roleRecord(history('codex', 13, 20), 'backend', 'codex');
    const enough = roleRecord(history('qwen', 16, 20), 'backend', 'qwen');
    expect(betterRecord(current, enough ? [enough] : [])?.assignee).toBe('qwen');
    const close = roleRecord(history('qwen', 15, 20), 'backend', 'qwen');
    expect(betterRecord(current, close ? [close] : [])).toBeNull();
    const few = roleRecord(history('qwen', 4, 4), 'backend', 'qwen');
    expect(betterRecord(current, few ? [few] : [])).toBeNull();
    expect(betterRecord(few, enough ? [enough] : [])).toBeNull();
  });
});

const env = (records: TeamRecordEntry[] = [], ids: string[] = ['claude', 'codex', 'qwen']): AssignmentEnvironment => ({
  capabilities: ids.map((id) => ({ id: id as 'claude' | 'codex' | 'qwen', displayName: id, available: true, state: 'ready', supportsRoutes: ['direct', 'proxy'] })),
  api: { available: false, displayName: 'API' }, proxyReady: true, records, projectId: 'project',
});
const part = { id: 'part', title: 'Part', role: 'backend' as const, prompt: 'Build', dependsOn: [], paths: [] };

describe('track record assignment advice', () => {
  it('breaks a near tie, but never a pin or a larger score gap, and preserves the original assignment', () => {
    const team = createDefaultAgentTeam();
    const records = [...history('codex', 1), ...history('claude', 5), ...history('qwen', 5)];
    // Editing parts are steered off the premium subscriptions, so Claude and Codex tie and Qwen leads by a larger gap.
    const premium = ['claude', 'codex'];
    expect(assignTeam([part], team, env([], premium)).assignments[0]?.assignee).toBe('claude');
    const codexRecords = [...history('claude', 1), ...history('codex', 5)];
    expect(assignTeam([part], team, env(codexRecords, premium)).assignments[0]).toMatchObject({ assignee: 'codex', suggestedAssignee: 'codex' });
    expect(assignTeam([part], team, env([...history('codex', 1), ...history('qwen', 5)])).assignments[0]?.assignee).toBe('qwen');
    team.roles.backend = { assignee: 'codex', route: 'auto', instructions: '' };
    const assigned = assignTeam([part], team, env(records)).assignments[0];
    expect(assigned.assignee).toBe('codex');
    expect(assigned.reason).toContain('passed first time in 1 of 5 jobs here');
  });

  it('never uses history to undo a preset penalty', () => {
    const team = createDefaultAgentTeam();
    const records = [...history('qwen', 0, 5, { role: 'tests' }), ...history('codex', 5, 5, { role: 'tests' }), ...history('claude', 5, 5, { role: 'tests' })];
    expect(assignTeam([{ ...part, role: 'tests' }], team, env(records)).assignments[0]?.assignee).toBe('qwen');
  });

  it('suggests only ready agents and changes the dismissal fingerprint with the numbers', () => {
    const team = createDefaultAgentTeam();
    team.roles.backend = { assignee: 'codex', route: 'direct', instructions: '' };
    const records = [...history('codex', 1), ...history('qwen', 5)];
    const first = teamAdvice(team, env(records)).find((advice) => advice.role === 'backend');
    expect(first?.suggestion?.assignee).toBe('qwen');
    expect(first?.suggestion?.text).toContain('5 of 5 jobs here');
    expect(team.roles.backend.assignee).toBe('codex');
    const next = teamAdvice(team, env([...records, entry({ id: 'new', assignee: 'qwen' })])).find((advice) => advice.role === 'backend');
    expect(next?.suggestion?.fingerprint).not.toBe(first?.suggestion?.fingerprint);
    const offline = env(records);
    offline.capabilities = offline.capabilities.filter((capability) => capability.id !== 'qwen');
    expect(teamAdvice(team, offline).find((advice) => advice.role === 'backend')?.suggestion).toBeUndefined();
  });
});

describe('team record store', () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
  async function setup(): Promise<{ store: TeamRecordStore; file: string; fs: NodeFileSystem }> {
    const folder = await mkdtemp(path.join(tmpdir(), 'kai-record-'));
    folders.push(folder);
    const file = path.join(folder, 'record.json');
    const fs = new NodeFileSystem();
    return { file, fs, store: new TeamRecordStore(file, fs) };
  }

  it('tolerates missing, corrupt and wrong-version files', async () => {
    const { store, file } = await setup();
    expect(await store.list()).toEqual([]);
    await writeFile(file, '{bad');
    expect(await store.list()).toEqual([]);
    await writeFile(file, '{"schemaVersion":99,"entries":[]}');
    expect(await store.list()).toEqual([]);
    await store.upsert([entry()]);
    expect(await store.list()).toEqual([entry()]);
  });

  it('writes atomically, serializes concurrent writes and upserts a resumed part without duplication', async () => {
    const { store, fs, file } = await setup();
    const rename = vi.spyOn(fs, 'rename');
    await Promise.all([store.upsert([entry()]), store.upsert([entry({ id: 'second' })])]);
    expect(await store.list()).toHaveLength(2);
    expect(rename.mock.calls[0]?.[0]).toMatch(/\.tmp$/);
    expect(rename.mock.calls[0]?.[1]).toBe(file);
    await store.upsert([entry({ neededFix: true })]);
    expect(await store.list()).toHaveLength(2);
    expect((await store.list()).find((value) => value.id === 'job:part')?.neededFix).toBe(true);
    const before = await readFile(file, 'utf8');
    rename.mockRejectedValueOnce(new Error('disk failure'));
    await expect(store.upsert([entry({ id: 'failed-write' })])).rejects.toThrow('disk failure');
    expect(await readFile(file, 'utf8')).toBe(before);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('keeps the most recent 5,000 entries', async () => {
    const { store } = await setup();
    await store.upsert(Array.from({ length: 5_010 }, (_, index) => entry({ id: String(index), startedAt: new Date(Date.parse(startedAt) + index * 1000).toISOString() })));
    const values = await store.list();
    expect(values).toHaveLength(5_000);
    expect(values[0]?.id).toBe('10');
    expect(values.at(-1)?.id).toBe('5009');
  });
});
