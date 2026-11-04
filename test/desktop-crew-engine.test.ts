import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig, crewConfigSchema, crewRunSchema } from '@kai/contracts';
import type { CrewRun } from '@kai/contracts';
import {
  acceptProposal, addTasks, answerAsk, buildReport, enforceLimits, isFinished, parseReview, pickTasks, proposeTask, readyTasks,
  reviewTask, roleAccess, sameFeedback, settle, startTask, subAgentsFor, submitTask, taskBrief, unfinishedReason,
} from '../apps/desktop/src/main/crew-engine';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';

function newRun(patch: Partial<CrewRun['config']> = {}): CrewRun {
  const config = crewConfigSchema.parse({ ...createDefaultCrewConfig('claude', 'codex'), ...patch });
  return crewRunSchema.parse({
    schemaVersion: 1, id: 'run_1', projectId: 'p1', goal: 'Build Zuri Log', status: 'running', config,
    tasks: [], feed: [], startedAt: T0, updatedAt: T0,
  });
}

function withTasks(run: CrewRun): CrewRun {
  const { run: next, refused } = addTasks(run, [
    { id: 'schema', title: 'Log schema', role: 'builder', acceptance: ['Migrations run cleanly'] },
    { id: 'ingest', title: 'Ingestion endpoint', role: 'builder', acceptance: ['Rate limit is 100 per minute per key'], dependsOn: ['schema'] },
  ], T0);
  expect(refused).toEqual([]);
  return next;
}

describe('crew contracts', () => {
  it('needs a Lead and refuses two roles with the same id', () => {
    const base = createDefaultCrewConfig();
    expect(() => crewConfigSchema.parse({ ...base, roles: base.roles.filter((role) => role.kind !== 'lead') })).toThrow(/needs a Lead/);
    expect(() => crewConfigSchema.parse({ ...base, roles: [...base.roles, base.roles[1]] })).toThrow(/share the id/);
  });

  it('gives every role its own agent, execution mode and sub-agent count', () => {
    const config = createDefaultCrewConfig('claude', 'codex');
    expect(config.roles.find((role) => role.id === 'builder')).toMatchObject({ agent: 'codex', execution: 'cli', access: 'edit' });
    expect(config.roles.find((role) => role.id === 'lead')?.agent).toBe('claude');
  });
});

describe('crew access', () => {
  it('keeps the Lead, planner, reviewers and security read-only even if a config says otherwise', () => {
    expect(roleAccess({ kind: 'lead', access: 'edit' })).toBe('read');
    expect(roleAccess({ kind: 'security', access: 'edit' })).toBe('read');
    expect(roleAccess({ kind: 'tester', access: 'edit' })).toBe('read');
    expect(roleAccess({ kind: 'auditor', access: 'edit' })).toBe('read');
    expect(roleAccess({ kind: 'builder', access: 'edit' })).toBe('edit');
    expect(roleAccess({ kind: 'operator', access: 'edit' })).toBe('edit');
    expect(roleAccess({ kind: 'custom', access: 'read' })).toBe('read');
  });
});

describe('crew board', () => {
  it('refuses a task with no acceptance criteria, an unknown role or a repeated id', () => {
    const run = newRun();
    const result = addTasks(run, [
      { id: 'a', title: 'No criteria', role: 'builder', acceptance: [] },
      { id: 'b', title: 'Nobody', role: 'ghost', acceptance: ['x'] },
      { id: 'c', title: 'Fine', role: 'builder', acceptance: ['x'] },
      { id: 'c', title: 'Again', role: 'builder', acceptance: ['x'] },
    ], T0);
    expect(result.run.tasks.map((task) => task.id)).toEqual(['c']);
    expect(result.refused).toHaveLength(3);
  });

  it('waits for dependencies, and does not wait on a task that is no longer on the board', () => {
    let run = withTasks(newRun());
    expect(readyTasks(run).map((task) => task.id)).toEqual(['schema']);
    run = { ...run, tasks: run.tasks.map((task) => (task.id === 'ingest' ? { ...task, dependsOn: ['removed'] } : task)) };
    expect(readyTasks(run).map((task) => task.id)).toEqual(['schema', 'ingest']);
  });

  it('starts no more tasks than the parallel limit allows, sent-back work first', () => {
    let run = newRun();
    run = addTasks(run, ['a', 'b', 'c'].map((id) => ({ id, title: id, role: 'builder', acceptance: ['x'] })), T0).run;
    expect(pickTasks(run)).toHaveLength(2);
    run = { ...run, tasks: run.tasks.map((task) => (task.id === 'c' ? { ...task, status: 'sentBack' as const } : task)) };
    expect(pickTasks(run)[0]?.id).toBe('c');
    run = { ...run, tasks: run.tasks.map((task) => (task.id === 'a' ? { ...task, status: 'building' as const } : task)) };
    expect(pickTasks(run)).toHaveLength(1);
  });

  it('keeps a worker\'s suggestion off the board until it is accepted', () => {
    let run = newRun();
    run = proposeTask(run, 'builder', { id: 'rl', title: 'Add a rate limiter', role: 'builder', acceptance: ['429 after the limit'] }, T0);
    expect(readyTasks(run)).toEqual([]);
    expect(unfinishedReason(run)).toMatch(/waiting to be accepted/);
    expect(acceptProposal(run, 'rl', false, 'lead', T1).tasks).toHaveLength(0);
    const accepted = acceptProposal(run, 'rl', true, 'lead', T1);
    expect(readyTasks(accepted).map((task) => task.id)).toEqual(['rl']);
  });
});

describe('crew review loop', () => {
  function inReview(): CrewRun {
    let run = withTasks(newRun());
    run = startTask(run, 'schema', 'builder', T0);
    return submitTask(run, 'schema', { files: ['db/001.sql', 'db/001.sql'], costUsd: 0.4 }, T1);
  }

  it('moves a task from building to review to accepted, and unlocks the one waiting on it', () => {
    let run = inReview();
    expect(run.tasks[0]).toMatchObject({ status: 'review', round: 1, files: ['db/001.sql'], costUsd: 0.4 });
    expect(run.spentUsd).toBeCloseTo(0.4);
    run = reviewTask(run, 'schema', { verdict: 'accept', feedback: '', reviewer: 'lead' }, T1);
    expect(run.tasks[0]?.status).toBe('accepted');
    expect(readyTasks(run).map((task) => task.id)).toEqual(['ingest']);
  });

  it('sends work back to be built again with the Lead\'s feedback in its brief', () => {
    let run = inReview();
    run = reviewTask(run, 'schema', { verdict: 'sendBack', feedback: 'Missing the down migration (AC-1).', reviewer: 'lead' }, T1);
    expect(run.tasks[0]?.status).toBe('sentBack');
    expect(pickTasks(run)[0]?.id).toBe('schema');
    expect(taskBrief(run, 'schema')).toContain('Missing the down migration');
    run = startTask(run, 'schema', 'builder', T1);
    expect(run.tasks[0]?.round).toBe(2);
  });

  it('will not accept a task that has nothing to check it against', () => {
    let run = inReview();
    run = { ...run, tasks: run.tasks.map((task) => ({ ...task, acceptance: [] })) };
    expect(() => reviewTask(run, 'schema', { verdict: 'accept', feedback: '', reviewer: 'lead' }, T1)).toThrow(/no acceptance criteria/);
  });

  it('stops and asks when the same problem comes back twice', () => {
    let run = inReview();
    run = reviewTask(run, 'schema', { verdict: 'sendBack', feedback: 'No rate limit.', reviewer: 'lead' }, T1);
    run = startTask(run, 'schema', 'builder', T1);
    run = submitTask(run, 'schema', { files: [] }, T1);
    run = reviewTask(run, 'schema', { verdict: 'sendBack', feedback: 'no rate limit', reviewer: 'lead' }, T1);
    expect(run.tasks[0]?.status).toBe('needsYou');
    expect(run.ask?.reason).toBe('sameFailure');
    expect(settle(run, T1).status).toBe('needsYou');
  });

  it('stops and asks once a task has been sent back more often than the limit', () => {
    let run = newRun();
    run = crewRunSchema.parse({ ...run, config: { ...run.config, savings: { ...run.config.savings, stopOnRepeatedFailure: false }, limits: { ...run.config.limits, maxSendBacks: 2 } } });
    run = withTasks(run);
    for (let round = 1; round <= 3; round += 1) {
      run = startTask(run, 'schema', 'builder', T0);
      run = submitTask(run, 'schema', { files: [] }, T0);
      run = reviewTask(run, 'schema', { verdict: 'sendBack', feedback: `Problem ${round}`, reviewer: 'lead' }, T0);
    }
    expect(run.ask?.reason).toBe('sendBacks');
    expect(run.tasks[0]?.status).toBe('needsYou');
  });

  it('lets the user continue with guidance, which restarts the send-back count', () => {
    let run = inReview();
    run = reviewTask(run, 'schema', { verdict: 'needsYou', feedback: 'Two ways to do this; which?', reviewer: 'lead' }, T1);
    run = answerAsk(run, 'continue', 'Use a middleware.', T1);
    expect(run.ask).toBeNull();
    expect(run.status).toBe('running');
    expect(run.tasks[0]?.status).toBe('sentBack');
    expect(taskBrief(run, 'schema')).toContain('Use a middleware.');
  });

  it('lets the user skip a stuck task so the project can still finish', () => {
    let run = inReview();
    run = reviewTask(run, 'schema', { verdict: 'needsYou', feedback: 'Stuck.', reviewer: 'lead' }, T1);
    run = answerAsk(run, 'skip', '', T1);
    expect(run.tasks[0]?.status).toBe('skipped');
    expect(readyTasks(run).map((task) => task.id)).toEqual(['ingest']);
  });

  it('is finished only when every board task is accepted or skipped, and the check has passed if there is one', () => {
    let run = withTasks(newRun());
    expect(isFinished(run)).toBe(false);
    run = { ...run, tasks: run.tasks.map((task) => ({ ...task, status: 'accepted' as const })) };
    expect(isFinished(run)).toBe(true);
    expect(settle(run, T1).status).toBe('completed');
    const checked = crewRunSchema.parse({ ...run, config: { ...run.config, checkCommand: 'npm test' } });
    expect(settle(checked, T1).status).toBe('running');
    expect(settle(checked, T1, { passed: true }).status).toBe('completed');
  });

  it('does not call an empty board finished', () => {
    expect(isFinished(newRun())).toBe(false);
  });
});

describe('crew limits', () => {
  it('asks when the spend limit is reached and moves the limit out when the user continues', () => {
    let run = crewRunSchema.parse({ ...newRun(), spentUsd: 10.5 });
    run = crewRunSchema.parse({ ...run, config: { ...run.config, limits: { ...run.config.limits, maxUsd: 10 } } });
    const asked = enforceLimits(run, new Date(T1));
    expect(asked.status).toBe('needsYou');
    expect(asked.ask?.reason).toBe('spend');
    const resumed = answerAsk(asked, 'continue', '', T1);
    expect(resumed.config.limits.maxUsd).toBeGreaterThan(10.5);
    expect(enforceLimits(resumed, new Date(T1)).status).toBe('running');
  });

  it('asks when the time limit is reached, and finishes quietly when the user chose that', () => {
    const base = newRun();
    const run = crewRunSchema.parse({ ...base, config: { ...base.config, limits: { ...base.config.limits, maxMinutes: 3 } } });
    expect(enforceLimits(run, new Date(T1)).ask?.reason).toBe('time');
    const quiet = crewRunSchema.parse({ ...run, config: { ...run.config, limits: { ...run.config.limits, onLimit: 'finish' } } });
    expect(enforceLimits(quiet, new Date(T1)).status).toBe('stopped');
  });

  it('has no spend or time limit unless one is set', () => {
    expect(enforceLimits({ ...newRun(), spentUsd: 9_999 }, new Date('2030-01-01'))).toMatchObject({ status: 'running' });
  });

  it('holds a role\'s sub-agents to what is left of the team cap', () => {
    const config = createDefaultCrewConfig();
    const capped = crewConfigSchema.parse({ ...config, limits: { ...config.limits, maxSubAgents: 3 } });
    expect(subAgentsFor(capped, 'planner', 0)).toBe(2);
    expect(subAgentsFor(capped, 'planner', 2)).toBe(1);
    expect(subAgentsFor(capped, 'planner', 5)).toBe(0);
    expect(subAgentsFor(capped, 'security', 0)).toBe(0);
    expect(subAgentsFor(capped, 'nobody', 0)).toBe(0);
  });
});

describe('crew briefs, reports and verdicts', () => {
  it('writes a worker\'s brief from the board and gives read-only roles no permission to edit', () => {
    const run = withTasks(newRun());
    const brief = taskBrief(run, 'schema', 'Payments go through M-Pesa STK push.');
    expect(brief).toContain('Build Zuri Log');
    expect(brief).toContain('1. Migrations run cleanly');
    expect(brief).toContain('M-Pesa STK push');
    expect(brief).toContain('Board: 0 accepted');
    expect(brief).toContain('You may change files');
    const reader = { ...run, tasks: run.tasks.map((task) => ({ ...task, role: 'security' })) };
    expect(taskBrief(reader, 'schema')).toContain('Do not change any files');
  });

  it('writes the final report from the board\'s records', () => {
    let run = withTasks(newRun());
    run = startTask(run, 'schema', 'builder', T0);
    run = submitTask(run, 'schema', { files: ['a.sql', 'b.sql'], costUsd: 1.234 }, T0);
    run = reviewTask(run, 'schema', { verdict: 'sendBack', feedback: 'Add rollback.', reviewer: 'lead' }, T0);
    run = startTask(run, 'schema', 'builder', T0);
    run = submitTask(run, 'schema', { files: ['a.sql'] }, T0);
    run = reviewTask(run, 'schema', { verdict: 'accept', feedback: '', reviewer: 'lead' }, T0);
    const report = buildReport(run, new Date(T1));
    expect(report.totals).toMatchObject({ tasks: 2, accepted: 1, sentBackOnce: 1, files: 1, costUsd: 1.23, minutes: 5 });
    expect(report.headline).toBe('1 of 2 tasks accepted; 1 not finished.');
    expect(report.openRisks[0]).toContain('Ingestion endpoint');
  });

  it('reads a verdict only from a complete JSON object, and wants a reason with any send-back', () => {
    expect(parseReview('Looks fine. {"verdict":"accept"}')).toEqual({ verdict: 'accept', feedback: '' });
    expect(parseReview('```json\n{"verdict":"sendBack","feedback":"No rate limit (AC-4)."}\n```')).toEqual({ verdict: 'sendBack', feedback: 'No rate limit (AC-4).' });
    expect(parseReview('{"verdict":"sendBack"}')).toBeNull();
    expect(parseReview('{"verdict":"ship it"}')).toBeNull();
    expect(parseReview('I think this is good.')).toBeNull();
  });

  it('compares feedback ignoring case and punctuation, and never treats nothing as the same as nothing', () => {
    expect(sameFeedback('No rate-limit!', 'no rate limit')).toBe(true);
    expect(sameFeedback('', '')).toBe(false);
  });
});
