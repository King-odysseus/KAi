import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig, crewConfigSchema } from '@kai/contracts';
import type { AgentRunRequest, AgentRunResult, CrewConfig, CrewRun } from '@kai/contracts';
import { DesktopCrewRunner } from '../apps/desktop/src/main/crew-runner';
import type { CrewRunnerPorts } from '../apps/desktop/src/main/crew-runner';
import type { ParallelSession } from '../apps/desktop/src/main/parallel-session';
import { parsePlan } from '../apps/desktop/src/main/crew-prompts';
import { guideCrewRun, helperChoiceFor } from '../apps/desktop/src/main/crew-engine';

const PLAN = JSON.stringify({
  tasks: [
    { id: 'schema', title: 'Log schema', role: 'builder', description: 'Tables', acceptance: ['Migrations run'], dependsOn: [] },
    { id: 'ingest', title: 'Ingestion endpoint', role: 'builder', description: 'POST /logs', acceptance: ['Rate limit 100/min'], dependsOn: ['schema'] },
  ],
});

interface Script {
  plan?: string[];
  /** Lead verdicts in the order reviews happen. The last one repeats. */
  lead?: string[];
  security?: string[];
  /** The Lead's calls on a task that ran out of retries. The default hands the question to the user. */
  stuck?: string[];
  /** The Lead's answers to "is the goal finished?", in order. The default says nothing is left. */
  coverage?: string[];
  /** The Lead's answer to a question from the Chat tab. */
  answer?: string;
  buildFails?: number;
  costPerCall?: number;
}

function fixture(script: Script = {}, patch: Partial<CrewConfig> = {}) {
  const requests: AgentRunRequest[] = [];
  const saved = new Map<string, CrewRun>();
  const notifications: CrewRun[] = [];
  let plans = 0, leads = 0, securities = 0, builds = 0, stucks = 0, coverages = 0;
  const checks: string[] = [];
  const pick = (list: string[] | undefined, index: number, fallback: string): string => (list && list.length > 0 ? list[Math.min(index, list.length - 1)]! : fallback);

  const ports: CrewRunnerPorts = {
    createConversation: async () => ({ id: `conv_${requests.length}` }),
    runAgent: async (request) => {
      requests.push(request);
      const cost = script.costPerCall ?? 0;
      const reply = (output: string, status: 'completed' | 'failed' = 'completed', error?: string): AgentRunResult =>
        ({ conversation: {} as never, status, output, ...(error ? { error } : {}), costUsd: cost });
      if (request.prompt.includes('You are the Lead of a small crew')) return reply(pick(script.plan, plans++, PLAN));
      if (request.prompt.includes('You are the security reviewer')) return reply(pick(script.security, securities++, '{"verdict":"accept"}'));
      if (request.prompt.includes('You are the tester.')) return reply('{"verdict":"accept"}');
      if (request.prompt.includes('You are the auditor.')) return reply('{"verdict":"accept"}');
      if (request.prompt.includes('You are the Lead. Check this finished task')) return reply(pick(script.lead, leads++, '{"verdict":"accept"}'));
      if (request.prompt.includes('A task has failed or been sent back too many times')) return reply(pick(script.stuck, stucks++, '{"decision":"ask","reason":"Needs the user."}'));
      if (request.prompt.includes('Every task on the board is now accepted')) return reply(pick(script.coverage, coverages++, '{"complete":true}'));
      if (request.prompt.includes('is asking you a question')) return reply(script.answer ?? 'Phase 0 is finished.');
      builds += 1;
      if (builds <= (script.buildFails ?? 0)) return reply('', 'failed', 'The agent crashed.');
      return reply('Built it.');
    },
    cancelAgent: () => true,
    runCheck: async (_project, command) => { checks.push(command); return { passed: true, output: 'ok' }; },
    save: async (run) => { saved.set(run.id, run); },
    load: async (id) => saved.get(id) ?? null,
    list: async () => [...saved.values()],
    notifyChanged: (_owner, run) => { notifications.push(run); },
    now: () => new Date('2026-11-01T10:00:00.000Z'),
  };
  const base = createDefaultCrewConfig('claude', 'codex');
  const config = crewConfigSchema.parse({ ...base, approvePlan: false, ...patch });
  const runner = new DesktopCrewRunner(ports);
  return { runner, requests, saved, notifications, config, checks, ports };
}

async function runToIdle(runner: DesktopCrewRunner, runId: string): Promise<CrewRun> {
  await runner.whenIdle(runId);
  return (await runner.get(runId))!;
}

describe('crew runner', () => {
  it('captures the Studio brief when a crew starts and accepts later lead guidance', async () => {
    const f = fixture();
    f.ports.readBrief = async () => '# Brief at run start\n\nPayments: offline';
    const run = await f.runner.start({ projectId: 'project', goal: 'Build a booking app.', config: f.config }, 1);
    expect(run.briefSnapshot).toContain('Payments: offline');
    const updated = guideCrewRun(run, 'Brief changed since this run began:\n- Payments: offline\n+ Payments: card', '2026-11-01T10:01:00.000Z');
    expect(updated.goal).toContain('Payments: card');
    expect(updated.feed.at(-1)?.text).toContain('Told the Lead');
  });

  it('plans, builds each task, has the Lead accept it, and finishes when the board says so', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.map((task) => task.status)).toEqual(['accepted', 'accepted']);
    // Dependencies are honoured: the endpoint is not built before the schema.
    const builds = f.requests.filter((request) => request.prompt.startsWith('Project goal:'));
    expect(builds[0]?.prompt).toContain('Your task: Log schema');
    expect(builds[1]?.prompt).toContain('Your task: Ingestion endpoint');
    expect(f.notifications.length).toBeGreaterThan(3);
    expect(f.saved.get(run.id)?.status).toBe('completed');
  });

  it('builds independent tasks in isolated copies and integrates them before review', async () => {
    const f = fixture({ plan: [JSON.stringify({ tasks: [
      { id: 'ui', title: 'Settings page', role: 'builder', description: 'Build settings UI', acceptance: ['Page renders'], dependsOn: [] },
      { id: 'api', title: 'Settings API', role: 'builder', description: 'Build settings endpoint', acceptance: ['Endpoint responds'], dependsOn: [] },
    ] })] }, { checkCommand: 'npm test' });
    const checked: Array<string | undefined> = [];
    const taskCwds: Array<string | undefined> = [];
    const integrated: string[][] = [];
    let taskAgents = 0;
    let maximumConcurrentTaskAgents = 0;
    let releaseTaskAgents!: () => void;
    const bothTaskAgentsStarted = new Promise<void>((resolve) => { releaseTaskAgents = resolve; });
    f.ports.worktrees = {
      prepare: async () => ({
        checkout: async (id) => `C:/isolated/${id}`,
        commit: async (id) => `commit-${id}`,
        filesChanged: async (commit) => [`src/${commit}.ts`],
        integrate: async (commits) => { integrated.push(commits.map((item) => item.stepId)); return { conflicts: [], applied: commits.map((item) => item.stepId), integrationCommit: 'merged', skipped: [] }; },
        dispose: async () => undefined,
      } satisfies ParallelSession),
    };
    const runAgent = f.ports.runAgent;
    f.ports.runAgent = async (request, owner, options) => {
      if (request.prompt.startsWith('Project goal:')) {
        taskCwds.push(options?.cwd);
        taskAgents += 1;
        maximumConcurrentTaskAgents = Math.max(maximumConcurrentTaskAgents, taskAgents);
        if (taskAgents === 2) releaseTaskAgents();
        await bothTaskAgentsStarted;
        taskAgents -= 1;
      }
      return runAgent(request, owner, options);
    };
    const runCheck = f.ports.runCheck;
    f.ports.runCheck = async (project, command, signal, options) => {
      if (options?.cwd) checked.push(options.cwd);
      return runCheck(project, command, signal, options);
    };

    const started = await f.runner.start({ projectId: 'p1', goal: 'Build settings', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);

    expect(run.status).toBe('completed');
    expect(taskCwds).toEqual(['C:/isolated/ui', 'C:/isolated/api']);
    expect(checked).toEqual(['C:/isolated/ui', 'C:/isolated/api']);
    expect(integrated).toEqual([['ui', 'api']]);
    expect(run.tasks.map((task) => task.files)).toEqual([['src/commit-ui.ts'], ['src/commit-api.ts']]);
    expect(maximumConcurrentTaskAgents).toBe(2);
  });

  it('retries only a conflicting task alone after the other task is integrated', async () => {
    const f = fixture({ plan: [JSON.stringify({ tasks: [
      { id: 'ui', title: 'Settings page', role: 'builder', description: 'Build settings UI', acceptance: ['Page renders'], dependsOn: [] },
      { id: 'api', title: 'Settings API', role: 'builder', description: 'Build settings endpoint', acceptance: ['Endpoint responds'], dependsOn: [] },
    ] })] });
    let prepared = 0;
    const taskCallCwds: Array<string | undefined> = [];
    f.ports.worktrees = {
      prepare: async () => {
        prepared += 1;
        return {
          checkout: async (id) => `C:/isolated/${id}`,
          commit: async (id) => `commit-${id}`,
          filesChanged: async (commit) => [`src/${commit}.ts`],
          integrate: async (commits) => ({ conflicts: [{ stepId: 'api', files: ['src/api.ts'], commit: 'commit-api', diff: '' }], applied: ['ui'], integrationCommit: 'merged', skipped: [] }),
          dispose: async () => undefined,
        } satisfies ParallelSession;
      },
    };
    const runAgent = f.ports.runAgent;
    f.ports.runAgent = async (request, owner, options) => {
      if (request.prompt.includes('Your task:')) taskCallCwds.push(options?.cwd);
      return runAgent(request, owner, options);
    };

    const started = await f.runner.start({ projectId: 'p1', goal: 'Build settings', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);

    expect(run.status).toBe('completed');
    expect(prepared).toBe(1);
    expect(taskCallCwds).toContain('C:/isolated/ui');
    expect(taskCallCwds).toContain('C:/isolated/api');
    expect(taskCallCwds.at(-1)).toBeUndefined();
    expect(run.tasks.map((task) => task.status)).toEqual(['accepted', 'accepted']);
    expect(run.tasks.find((task) => task.id === 'api')?.round).toBe(2);
  });

  it('keeps independent tasks serial and explains the fallback when the project has no worktree support', async () => {
    const f = fixture({ plan: [JSON.stringify({ tasks: [
      { id: 'ui', title: 'Settings page', role: 'builder', description: 'Build settings UI', acceptance: ['Page renders'], dependsOn: [] },
      { id: 'api', title: 'Settings API', role: 'builder', description: 'Build settings endpoint', acceptance: ['Endpoint responds'], dependsOn: [] },
    ] })] });

    const started = await f.runner.start({ projectId: 'p1', goal: 'Build settings', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);

    expect(run.status).toBe('completed');
    expect(run.feed.some((item) => item.text.includes('running one at a time') && item.text.includes('Git project'))).toBe(true);
  });

  it('waits for approval of the plan when asked to, then runs on its own', async () => {
    const f = fixture({}, { approvePlan: true });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const waiting = await runToIdle(f.runner, started.id);
    expect(waiting.status).toBe('awaitingApproval');
    expect(waiting.tasks).toHaveLength(2);
    expect(f.requests.filter((request) => request.prompt.startsWith('Project goal:'))).toHaveLength(0);
    await f.runner.approve(started.id, 1);
    expect((await runToIdle(f.runner, started.id)).status).toBe('completed');
  });

  it('runs each role on the agent, execution mode and autonomy it was given, and read-only roles in Plan', async () => {
    const base = createDefaultCrewConfig('claude', 'codex');
    const roles = base.roles.map((role) => (role.id === 'builder' ? { ...role, execution: 'api' as const, model: 'gpt-5.6-sol' } : role));
    const f = fixture({}, { roles, autonomy: 'full' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    const build = f.requests.find((request) => request.prompt.startsWith('Project goal:'))!;
    expect(build).toMatchObject({ agent: 'codex', execution: 'api', autonomy: 'full', model: 'gpt-5.6-sol', freshSession: true });
    const lead = f.requests.find((request) => request.prompt.includes('You are the Lead. Check'))!;
    expect(lead).toMatchObject({ agent: 'claude', execution: 'cli', autonomy: 'plan' });
    const security = f.requests.find((request) => request.prompt.includes('security reviewer'))!;
    expect(security.autonomy).toBe('plan');
  });

  it('runs tester and auditor roles on finished work, read-only', async () => {
    const base = createDefaultCrewConfig('claude', 'codex');
    const role = (id: string, kind: 'tester' | 'auditor', label: string) => ({
      id, kind, label, agent: 'claude' as const, execution: 'cli' as const, route: 'direct' as const,
      access: 'read' as const, subAgents: { max: 0 }, instructions: '',
    });
    const f = fixture({}, { roles: [...base.roles, role('tester', 'tester', 'Tester'), role('auditor', 'auditor', 'Auditor')] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);

    expect(run.status).toBe('completed');
    const tester = f.requests.find((request) => request.prompt.includes('You are the tester.'))!;
    const auditor = f.requests.find((request) => request.prompt.includes('You are the auditor.'))!;
    expect(tester.autonomy).toBe('plan');
    expect(auditor.autonomy).toBe('plan');
    // Each accepted pass is remembered on the task, so a resumed run does not pay for it again.
    expect(run.tasks.every((task) => task.reviews.some((review) => review.reviewer === 'tester'))).toBe(true);
    expect(run.tasks.every((task) => task.reviews.some((review) => review.reviewer === 'auditor'))).toBe(true);
  });

  it('turns a role\'s sub-agent count into the composer\'s helper setting', async () => {
    expect([0, 1, 2, 3, 5, 9].map(helperChoiceFor)).toEqual(['off', '2', '3', '4', '6', '8']);
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    // The default planner may use 2 sub-agents (3 agents in all); security uses none.
    expect(f.requests.find((request) => request.prompt.includes('Lead of a small crew'))?.helpers).toBe('3');
    expect(f.requests.find((request) => request.prompt.includes('security reviewer'))?.helpers).toBe('off');
  });

  it('sends work back to the builder with the Lead\'s feedback, then accepts the fix', async () => {
    const f = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit (AC-1)."}', '{"verdict":"accept"}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    const first = run.tasks.find((task) => task.id === 'schema')!;
    expect(first.round).toBe(2);
    expect(first.reviews.map((review) => review.verdict)).toContain('sendBack');
    const rebuild = f.requests.filter((request) => request.prompt.startsWith('Project goal:'))[1]!;
    expect(rebuild.prompt).toContain('No rate limit (AC-1).');
  });

  it('stops and asks when the same problem comes back, instead of looping', async () => {
    const f = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit."}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.reason).toBe('sameFailure');
    expect(run.tasks.find((task) => task.id === 'ingest')?.status).toBe('backlog');
    // The user gives guidance and the crew carries on to the end.
    const f2 = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit."}', '{"verdict":"sendBack","feedback":"no rate limit"}', '{"verdict":"accept"}'] });
    const second = await f2.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f2.config }, 1);
    expect((await runToIdle(f2.runner, second.id)).status).toBe('needsYou');
    await f2.runner.answer(second.id, 'continue', 'Put it in middleware.', 1);
    const finished = await runToIdle(f2.runner, second.id);
    expect(finished.status).toBe('completed');
  });

  it('lets the Lead retry a task that came back for the same problem, without asking the user', async () => {
    const f = fixture({
      lead: ['{"verdict":"sendBack","feedback":"No rate limit."}', '{"verdict":"sendBack","feedback":"no rate limit"}', '{"verdict":"accept"}'],
      stuck: ['{"decision":"retry","guidance":"Put the limit in middleware."}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.feed.some((entry) => entry.who === 'lead' && entry.text.includes('a different way'))).toBe(true);
  });

  it('lets the Lead skip a task that keeps crashing, and finishes the rest', async () => {
    const f = fixture({ buildFails: 99, stuck: ['{"decision":"skip","reason":"Not needed for the goal."}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).not.toBe('needsYou');
    expect(run.tasks.every((task) => task.status === 'skipped')).toBe(true);
  });

  it('asks the user when the Lead says the question is theirs, or when its answer cannot be read', async () => {
    const asked = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit."}'], stuck: ['{"decision":"ask","reason":"Needs a key."}'] });
    const one = await asked.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: asked.config }, 1);
    expect((await runToIdle(asked.runner, one.id)).ask?.reason).toBe('sameFailure');
    const unreadable = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit."}'], stuck: ['I would try again.'] });
    const two = await unreadable.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: unreadable.config }, 1);
    expect((await runToIdle(unreadable.runner, two.id)).ask?.reason).toBe('sameFailure');
  });

  it('says what is left instead of claiming the project is done, when the plan has more phases', async () => {
    const f = fixture({ coverage: ['{"complete":false,"remaining":["Phase 1: Shell and gating","Phase 2: Provider layer"]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.remaining).toEqual(['Phase 1: Shell and gating', 'Phase 2: Provider layer']);
    const done = run.feed.find((entry) => entry.kind === 'done');
    expect(done?.text).toContain('Not finished yet');
    expect(done?.text).toContain('Phase 1: Shell and gating');
    expect(done?.text).not.toContain('The project is done');
  });

  it('moves on to the next phase by itself when told to keep going, and stops when nothing is left', async () => {
    const nextPlan = JSON.stringify({ tasks: [{ id: 'shell', title: 'Build the shell', role: 'builder', description: 'Phase 1', acceptance: ['The shell opens'], dependsOn: [] }] });
    const f = fixture({
      plan: [PLAN, nextPlan],
      coverage: ['{"complete":false,"remaining":["Phase 1: Shell"]}', '{"complete":true}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: { ...f.config } }, 1);
    await f.runner.setKeepGoing(started.id, true, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.map((task) => task.id)).toEqual(['schema', 'ingest', 'shell']);
    expect(run.remaining).toEqual([]);
    expect(run.feed.some((entry) => entry.text.includes('Moving on to: Phase 1: Shell'))).toBe(true);
    expect(f.requests.some((request) => request.prompt.includes('keep going through every phase'))).toBe(true);
  });

  it('answers a question from the Chat tab without changing the board', async () => {
    const f = fixture({ answer: 'Phase 0 is finished; Phase 1 has not started.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const before = await runToIdle(f.runner, started.id);
    const after = await f.runner.message(started.id, 'ask', 'What is done so far?', 1);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.status).toBe('completed');
    expect(after.chat.map((entry) => [entry.from, entry.kind])).toEqual([['you', 'ask'], ['lead', 'answer']]);
    expect(after.chat[1]?.text).toContain('Phase 1 has not started');
  });

  it('keeps a steer for a working crew, and refuses it on a finished one', async () => {
    const f = fixture({ lead: ['{"verdict":"sendBack","feedback":"No rate limit."}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const waiting = await runToIdle(f.runner, started.id);
    expect(waiting.status).toBe('needsYou');
    const steered = await f.runner.message(started.id, 'steer', 'Use middleware for the limit.', 1);
    expect(steered.goal).toContain('Use middleware for the limit.');
    expect(steered.chat.map((entry) => entry.kind)).toEqual(['steer', 'note']);
    await expect(f.runner.message(started.id, 'work', 'Build more.', 1)).rejects.toThrow(/finished or been stopped/);

    const g = fixture();
    const done = await g.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: g.config }, 1);
    await runToIdle(g.runner, done.id);
    await expect(g.runner.message(done.id, 'steer', 'Change course.', 1)).rejects.toThrow(/Add work/);
  });

  it('plans more work from the Chat tab onto a finished board', async () => {
    const more = JSON.stringify({ tasks: [{ id: 'install', title: 'Install it', role: 'builder', description: 'Install', acceptance: ['Installed'], dependsOn: [] }] });
    const f = fixture({ plan: [PLAN, more] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.message(started.id, 'work', 'Now install it.', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.map((task) => task.id)).toEqual(['schema', 'ingest', 'install']);
    expect(run.chat[0]).toMatchObject({ from: 'you', kind: 'work', text: 'Now install it.' });
  });

  it('plans a follow-up onto the same board after the crew has finished', async () => {
    const followPlan = JSON.stringify({ tasks: [{ id: 'schema', title: 'Install the app', role: 'builder', description: 'Build and install', acceptance: ['The app is installed'], dependsOn: [] }] });
    const f = fixture({ plan: [PLAN, followPlan] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const first = await runToIdle(f.runner, started.id);
    expect(first.status).toBe('completed');
    expect(first.tasks).toHaveLength(2);

    const next = await f.runner.followUp(started.id, 'Now build and install it.', 1);
    expect(next.followUp).toBe('Now build and install it.');
    const done = await runToIdle(f.runner, started.id);
    expect(done.status).toBe('completed');
    expect(done.followUp).toBeNull();
    expect(done.tasks.map((task) => task.id)).toEqual(['schema', 'ingest', 'schema-2']);
    expect(done.tasks.every((task) => task.status === 'accepted')).toBe(true);
    expect(f.requests.some((request) => request.prompt.includes('Plan only this') && request.prompt.includes('Now build and install it.'))).toBe(true);
  });

  it('puts a finished crew back as it was when the Lead cannot plan the follow-up', async () => {
    const f = fixture({ plan: [PLAN, 'not a plan'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.followUp(started.id, 'Do more.', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.followUp).toBeNull();
    expect(run.tasks).toHaveLength(2);
    expect(run.feed.some((entry) => entry.text.includes('could not plan that follow-up'))).toBe(true);
  });

  it('never accepts work when the Lead\'s reply cannot be read', async () => {
    const f = fixture({ lead: ['I think it is fine.'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.tasks.some((task) => task.status === 'accepted')).toBe(false);
    // One retry was made with the stricter request.
    expect(f.requests.some((request) => request.prompt.includes('could not be used'))).toBe(true);
  });

  it('stops for the user when the security reviewer blocks, before the Lead sees the task', async () => {
    const f = fixture({ security: ['{"verdict":"needsYou","feedback":"API key is hard-coded."}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask).toMatchObject({ reason: 'securityBlock' });
    expect(f.requests.some((request) => request.prompt.includes('You are the Lead. Check'))).toBe(false);
  });

  it('retries a build that crashed, then stops and asks if it keeps crashing', async () => {
    const once = fixture({ buildFails: 1 });
    const started = await once.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: once.config }, 1);
    expect((await runToIdle(once.runner, started.id)).status).toBe('completed');
    const always = fixture({ buildFails: 99 });
    const stuck = await always.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: always.config }, 1);
    const run = await runToIdle(always.runner, stuck.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.reason).toBe('noProgress');
  });

  it('asks instead of continuing once the spend limit is reached, and Finish keeps what is accepted', async () => {
    const base = createDefaultCrewConfig('claude', 'codex');
    const f = fixture({ costPerCall: 1 }, { limits: { ...base.limits, maxUsd: 4, onLimit: 'ask' } });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.reason).toBe('spend');
    expect(run.spentUsd).toBeGreaterThanOrEqual(4);
    const ended = await f.runner.answer(started.id, 'finish', '', 1);
    expect(ended.status).toBe('stopped');
    expect(ended.tasks.some((task) => task.status === 'accepted')).toBe(true);
  });

  it('runs the project check before finishing and adds a fix task when it fails', async () => {
    let calls = 0;
    const f = fixture({}, { checkCommand: 'npm test' });
    // Failing from the start means no task is blamed; the final check fails once too, then passes after the fix task.
    f.ports.runCheck = async (_project, command) => { f.checks.push(command); calls += 1; return { passed: calls > 2, output: 'FAIL src/a.test.ts' }; };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(f.checks).toEqual(['npm test', 'npm test', 'npm test']);
    expect(run.tasks.map((task) => task.id)).toContain('check-fix-1');
    expect(run.status).toBe('completed');
  });

  it('sends a task back with the check output when the project check fails after it', async () => {
    let calls = 0;
    const f = fixture({}, { checkCommand: 'npm test' });
    // Call 1 is the baseline, which passes; call 2 is the first task's check, which fails.
    f.ports.runCheck = async (_project, command) => { f.checks.push(command); calls += 1; return { passed: calls !== 2, output: 'FAIL src/a.test.ts' }; };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    const sentBack = run.tasks.flatMap((task) => task.reviews).find((review) => review.reviewer === 'check' && review.verdict === 'sendBack');
    expect(sentBack?.feedback).toContain('npm test');
    expect(sentBack?.feedback).toContain('FAIL src/a.test.ts');
    const accepted = run.tasks.flatMap((task) => task.reviews).filter((review) => review.reviewer === 'check' && review.verdict === 'accept');
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('does not blame a task for a check that already failed before the crew started', async () => {
    const f = fixture({}, { checkCommand: 'npm test' });
    f.ports.runCheck = async (_project, command) => { f.checks.push(command); return { passed: false, output: 'FAIL already' }; };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.tasks.flatMap((task) => task.reviews).some((review) => review.reviewer === 'check')).toBe(false);
    expect(run.feed.some((item) => item.text.includes('already fails'))).toBe(true);
  });

  it('pauses on request and picks up where it left off', async () => {
    const f = fixture({}, { approvePlan: true });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    const paused = await f.runner.pause(started.id);
    expect(['awaitingApproval', 'paused']).toContain(paused.status);
    await f.runner.approve(started.id, 1);
    expect((await runToIdle(f.runner, started.id)).status).toBe('completed');
  });

  it('shows an interrupted run as paused, never as running', async () => {
    const f = fixture();
    const run = { ...(await (async () => { const s = await f.runner.start({ projectId: 'p1', goal: 'g', config: f.config }, 1); await f.runner.whenIdle(s.id); return (await f.runner.get(s.id))!; })()), status: 'running' as const };
    f.saved.set(run.id, run);
    const fresh = new DesktopCrewRunner(f.ports);
    expect((await fresh.list())[0]?.status).toBe('paused');
  });
});

describe('crew designer and Open Pencil', () => {
  const DESIGN_PLAN = JSON.stringify({
    tasks: [
      { id: 'home-design', title: 'Draw the Home page', role: 'designer', acceptance: ['A page named Home is in Open Pencil'], designRef: 'Home' },
      { id: 'home-build', title: 'Build the Home page', role: 'builder', acceptance: ['The page matches the design'], dependsOn: ['home-design'], designRef: 'Home' },
    ],
  });

  function withDesigner() {
    const base = createDefaultCrewConfig('claude', 'codex');
    const designer = { id: 'designer', kind: 'designer' as const, label: 'Designer', agent: 'claude' as const, execution: 'api' as const, route: 'direct' as const, access: 'edit' as const, subAgents: { max: 0 }, instructions: '' };
    return fixture({ plan: [DESIGN_PLAN] }, { roles: [...base.roles, designer] });
  }

  it('tells the planner which pages Open Pencil holds, or that a designer should draw them first', async () => {
    const f = withDesigner();
    f.ports.design = { status: async () => ({ state: 'running' as const, pages: [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Settings' }] }), ensureRunning: async () => undefined, draw: async () => ({ status: 'completed' as const, output: 'Drew Home.' }) };
    await runToIdle(f.runner, (await f.runner.start({ projectId: 'p1', goal: 'Build the app', config: f.config }, 1)).id);
    const plan = f.requests.find((request) => request.prompt.includes('Lead of a small crew'))!;
    expect(plan.prompt).toContain('Open Pencil already holds these design pages');
    expect(plan.prompt).toContain('- Settings');
    expect(plan.prompt).toContain('role designer');

    const empty = withDesigner();
    empty.ports.design = { status: async () => ({ state: 'running' as const, pages: [] }), ensureRunning: async () => undefined, draw: async () => ({ status: 'completed' as const, output: 'ok' }) };
    await runToIdle(empty.runner, (await empty.runner.start({ projectId: 'p1', goal: 'Build the app', config: empty.config }, 1)).id);
    expect(empty.requests.find((request) => request.prompt.includes('Lead of a small crew'))!.prompt).toContain('There is no design in Open Pencil yet');
  });

  it('draws a designer\'s task in Open Pencil, not as an ordinary agent run, and builds the page after it', async () => {
    const f = withDesigner();
    const drawn: string[] = [];
    let opened = 0;
    f.ports.design = {
      status: async () => ({ state: 'running' as const, pages: drawn.length > 0 ? [{ id: 'p1', name: 'Home' }] : [] }),
      ensureRunning: async () => { opened += 1; },
      draw: async (_project, prompt) => { drawn.push(prompt); return { status: 'completed' as const, output: 'Drew Home with a hero and a list.', costUsd: 0.2 }; },
    };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build the app', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(opened).toBe(1);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toContain('Name the page exactly "Home"');
    // The designer never went through the ordinary agent path; the builder did, after the page existed.
    const builds = f.requests.filter((request) => request.prompt.startsWith('Project goal:'));
    expect(builds).toHaveLength(1);
    expect(builds[0]?.prompt).toContain('Your task: Build the Home page');
    expect(builds[0]?.prompt).toContain('This task builds the design page Home');
    expect(run.design?.pages).toEqual([{ id: 'p1', name: 'Home' }]);
    expect(run.spentUsd).toBeGreaterThanOrEqual(0.2);
    // The Lead is told whether the page is really there.
    expect(f.requests.some((request) => request.prompt.includes('You are the Lead. Check') && request.prompt.includes('It is in Open Pencil.'))).toBe(true);
  });

  it('retries and then asks when the design agent fails, instead of marking the page drawn', async () => {
    const f = withDesigner();
    f.ports.design = { status: async () => ({ state: 'unreachable' as const, pages: [] }), ensureRunning: async () => undefined, draw: async () => ({ status: 'failed' as const, output: '', error: 'No design provider is set up.' }) };
    const run = await runToIdle(f.runner, (await f.runner.start({ projectId: 'p1', goal: 'Build the app', config: f.config }, 1)).id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.message).toContain('No design provider is set up.');
    expect(run.tasks.find((task) => task.id === 'home-design')?.status).not.toBe('accepted');
  });

  it('leaves a designer task failing clearly when Open Pencil is not wired at all', async () => {
    const f = withDesigner();
    const run = await runToIdle(f.runner, (await f.runner.start({ projectId: 'p1', goal: 'Build the app', config: f.config }, 1)).id);
    // With no design port the designer is an ordinary editing role, so the crew still finishes.
    expect(run.status).toBe('completed');
  });
});

describe('crew plan parsing', () => {
  it('keeps usable tasks, makes ids unique, and points dependencies at the ids actually used', () => {
    const plan = parsePlan('Here you go: {"tasks":[{"id":"A","title":"One","role":"builder","acceptance":["x"]},{"id":"A","title":"Two","role":"builder","acceptance":["y"],"dependsOn":["A","ghost"]},{"title":"","role":"builder"}]}');
    expect(plan?.map((task) => task.id)).toEqual(['a', 'a-2']);
    // "A" meant the first task that used it; "ghost" is no task at all.
    expect(plan?.[1]?.dependsOn).toEqual(['a']);
  });

  it('reads nothing from prose or an empty list', () => {
    expect(parsePlan('I would start with the database.')).toBeNull();
    expect(parsePlan('{"tasks":[]}')).toBeNull();
    expect(parsePlan('{"tasks":[{"title":"x"}]}')).toBeNull();
  });
});
