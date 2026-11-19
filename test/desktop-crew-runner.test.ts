import { describe, expect, it } from 'vitest';
import { buildReport, createDefaultCrewConfig, crewConfigSchema } from '@kai/contracts';
import type { AgentRunRequest, AgentRunResult, CrewConfig, CrewRun } from '@kai/contracts';
import { DesktopCrewRunner } from '../apps/desktop/src/main/crew-runner';
import type { CrewRunnerPorts } from '../apps/desktop/src/main/crew-runner';
import type { ParallelSession } from '../apps/desktop/src/main/parallel-session';
import { parsePlan, planPrompt, reviewPrompt } from '../apps/desktop/src/main/crew-prompts';
import { askTaskSpend, awayEligible, guideCrewRun, helperChoiceFor, parseReview, setAway } from '../apps/desktop/src/main/crew-engine';

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
  /** The Lead's away-mode answers: which of its own options is safe, or none. */
  away?: string[];
  /** The Lead's answers to "is the goal finished?", in order. The default says nothing is left. */
  coverage?: string[];
  /** The Lead's answer to a question from the Chat tab. */
  answer?: string;
  buildFails?: number;
  buildOutput?: string;
  /** What a failed build says went wrong. */
  buildError?: string;
  costPerCall?: number;
}

function fixture(script: Script = {}, patch: Partial<CrewConfig> = {}) {
  const requests: AgentRunRequest[] = [];
  const saved = new Map<string, CrewRun>();
  const notifications: CrewRun[] = [];
  let plans = 0, leads = 0, securities = 0, builds = 0, stucks = 0, coverages = 0, aways = 0;
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
      if (request.prompt.includes('The person is away from the computer')) return reply(pick(script.away, aways++, '{"choice":"none","reason":"Their call."}'));
      if (request.prompt.includes('Every task on the board is now accepted')) return reply(pick(script.coverage, coverages++, '{"complete":true}'));
      if (request.prompt.includes('is asking you a question')) return reply(script.answer ?? 'Phase 0 is finished.');
      builds += 1;
      if (builds <= (script.buildFails ?? 0)) return reply('', 'failed', script.buildError ?? 'The agent crashed.');
      return reply(script.buildOutput ?? 'Built it.');
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
  it('splits local builder work into atomic reviewed task cards and bounds each local turn', async () => {
    const f = fixture();
    const localConfig = crewConfigSchema.parse({
      ...f.config,
      roles: f.config.roles.map((role) => role.id === 'builder'
        ? { ...role, execution: 'api', api: { provider: 'ollama', model: 'qwen3-coder' } }
        : role),
    });
    const prompt = planPrompt('Build a booking flow', localConfig, '', { tasks: [] });
    expect(prompt).toContain('small local model; assign only focused microtasks');
    expect(prompt).toContain('dependency-ordered cards');
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: localConfig }, 1);
    const run = await runToIdle(f.runner, started.id);
    const builder = f.requests.find((request) => request.displayText === 'Build: Log schema');
    expect(builder?.toolRoundLimit).toBe(30);
    expect(builder?.prompt).toContain('This is a deliberately small Crew task for a local model');
    expect(run.tasks.map((task) => task.status)).toEqual(['accepted', 'accepted']);
  });

  it('sends an explicitly stuck local builder to the Lead immediately', async () => {
    const f = fixture({ buildOutput: 'I cannot continue.\n<<KAI_STUCK>>missing project file' });
    const localConfig = crewConfigSchema.parse({
      ...f.config,
      roles: f.config.roles.map((role) => role.id === 'builder'
        ? { ...role, execution: 'api', api: { provider: 'ollama', model: 'qwen3-coder' } }
        : role),
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: localConfig }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(f.requests.some((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toBe(true);
    expect(run.status).toBe('needsYou');
    expect(run.tasks[0]?.status).toBe('needsYou');
  });

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

  it('puts the Lead\'s ways forward on the question, so the person picks one instead of writing the fix', async () => {
    const f = fixture({
      lead: ['{"verdict":"sendBack","feedback":"No rate limit."}'],
      stuck: ['{"decision":"ask","reason":"Two valid designs.","options":["Use middleware for the limit.","Use a per-route decorator.","  "]}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.ask?.options).toEqual(['Use middleware for the limit.', 'Use a per-route decorator.']);
    expect(run.ask?.message).toContain('Two valid designs.');
    // Picking one is an ordinary answer: it becomes the task's next instruction.
    const answered = await f.runner.answer(started.id, 'continue', run.ask!.options![0]!, 1);
    expect(answered.tasks.find((task) => task.id === run.ask!.taskId)?.reviews.at(-1)?.feedback).toBe('Use middleware for the limit.');
  });

  it('tells every agent a lesson the Lead drew from a stuck task', async () => {
    const f = fixture({
      lead: ['{"verdict":"sendBack","feedback":"No rate limit."}', '{"verdict":"sendBack","feedback":"no rate limit"}', '{"verdict":"accept"}'],
      stuck: ['{"decision":"retry","guidance":"Put the limit in middleware.","lesson":"The repo lint rejects default exports; use named exports."}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.goal).toContain('The repo lint rejects default exports');
  });

  it('holds the crew for the person\'s yes or no on what the plan says needs approval, and never assumes it', async () => {
    const withApproval = JSON.stringify({
      tasks: [{ id: 'shell', title: 'Build the shell', role: 'builder', description: 'Phase 1', acceptance: ['The shell opens'], dependsOn: [] }],
      approvals: [{ what: 'zod', why: 'A small library that checks the messages inside the app are well-formed.' }],
    });
    const f = fixture({ plan: [withApproval] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const held = await runToIdle(f.runner, started.id);
    expect(held.status).toBe('needsYou');
    expect(held.ask?.reason).toBe('approval');
    expect(held.approvals).toMatchObject([{ what: 'zod', status: 'pending' }]);
    expect(held.tasks.every((task) => task.status === 'backlog')).toBe(true);

    await f.runner.decide(started.id, held.approvals[0]!.id, true, 1);
    const done = await runToIdle(f.runner, started.id);
    expect(done.status).toBe('completed');
    expect(done.approvals[0]?.status).toBe('approved');
    expect(done.goal).toContain('The person approved: zod.');
    expect(done.chat.at(-1)).toMatchObject({ from: 'you', kind: 'note', text: 'Approved: zod' });
  });

  it('tells every agent when an approval is declined, and does not ask for it twice', async () => {
    const withApproval = JSON.stringify({
      tasks: [{ id: 'shell', title: 'Build the shell', role: 'builder', description: 'Phase 1', acceptance: ['The shell opens'], dependsOn: [] }],
      approvals: [{ what: 'zod', why: 'Checks messages.' }],
    });
    const again = JSON.stringify({
      tasks: [{ id: 'gate', title: 'Add gating', role: 'builder', description: 'Phase 2', acceptance: ['Gating works'], dependsOn: [] }],
      approvals: [{ what: 'ZOD', why: 'Checks messages.' }],
    });
    const f = fixture({ plan: [withApproval, again] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const held = await runToIdle(f.runner, started.id);
    await f.runner.decide(started.id, held.approvals[0]!.id, false, 1);
    const done = await runToIdle(f.runner, started.id);
    expect(done.goal).toContain('The person did not approve: zod. Do not add it; find another way.');
    // A later phase that lists the same thing is not put to them again; they already said no.
    await f.runner.message(started.id, 'work', 'Start the next phase.', 1);
    const next = await runToIdle(f.runner, started.id);
    expect(next.status).toBe('completed');
    expect(next.approvals).toHaveLength(1);
  });

  it('finds what is left in the plan on request, without changing the board', async () => {
    const f = fixture({ coverage: ['{"complete":true}', '{"complete":false,"remaining":["Phase 1: Shell","Phase 2: Providers"]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const before = await runToIdle(f.runner, started.id);
    expect(before.remaining).toEqual([]);
    const found = await f.runner.findPhases(started.id, 1);
    expect(found.remaining).toEqual(['Phase 1: Shell', 'Phase 2: Providers']);
    expect(found.tasks).toEqual(before.tasks);
    expect(found.status).toBe('completed');
    expect(found.chat.at(-1)?.text).toContain('Still to do in the plan: Phase 1: Shell; Phase 2: Providers.');
  });

  it('writes the Lead\'s answers for someone who is not very technical when asked to, and not otherwise', async () => {
    const f = fixture({ answer: 'Done.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.message(started.id, 'ask', 'What is done?', 1);
    expect(f.requests.at(-1)?.prompt).toContain('not very technical');
    expect(f.requests.at(-1)?.prompt).toContain('Never say that you noted, recorded, approved or changed anything');
    await f.runner.setExplainSimply(started.id, false);
    await f.runner.message(started.id, 'ask', 'And now?', 1);
    expect(f.requests.at(-1)?.prompt).not.toContain('not very technical');
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

  it('stops an answer in progress, cancels only that answer\'s conversation, and keeps the question', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const finished = await runToIdle(f.runner, started.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.ports.runAgent;
    f.ports.runAgent = async (request, owner, options) => {
      if (request.prompt.includes('is asking you a question')) {
        await gate;
        return { conversation: {} as never, status: 'completed', output: 'A late answer.', costUsd: 0 };
      }
      return original(request, owner, options);
    };
    const cancelled: string[] = [];
    f.ports.cancelAgent = (id) => { cancelled.push(id); release(); return true; };

    const pending = f.runner.message(started.id, 'ask', 'What is done?', 1);
    // The question is on the thread before the answer is waited for; wait until it is, then stop.
    for (let tries = 0; tries < 100 && ((await f.runner.get(started.id))?.chat.length ?? 0) < 1; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.runner.stopAsk(started.id);
    const after = await pending;

    expect(cancelled).toEqual([finished.conversationId]);
    expect(after.chat.map((entry) => entry.kind)).toEqual(['ask', 'note']);
    expect(after.chat.at(-1)?.text).toContain('Stopped');
    expect(after.chat.some((entry) => entry.text.includes('A late answer.'))).toBe(false);
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
  });

  it('turns a steer on a finished crew into what it plans next', async () => {
    const more = JSON.stringify({ tasks: [{ id: 'dark', title: 'Dark mode', role: 'builder', description: 'Add it', acceptance: ['Dark mode works'], dependsOn: [] }] });
    const g = fixture({ plan: [PLAN, more] });
    const done = await g.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: g.config }, 1);
    await runToIdle(g.runner, done.id);
    await g.runner.message(done.id, 'steer', 'Add a dark mode.', 1);
    const run = await runToIdle(g.runner, done.id);
    expect(run.tasks.map((task) => task.id)).toEqual(['schema', 'ingest', 'dark']);
    expect(run.chat[0]).toMatchObject({ from: 'you', kind: 'steer', text: 'Add a dark mode.' });
  });

  it('gets past a commit hook that rejects a word by telling every agent, without spending retries or asking the person', async () => {
    const hook = 'git commit failed: \u001b[0;31m[BLOCKED]\u001b[0m Self-tagging detected: \'copilot\' Commit blocked.';
    const f = fixture({ buildFails: 1, buildError: hook });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.knownBlockers).toEqual(['selftag:copilot']);
    expect(run.goal).toContain('Write commit messages that describe what changed without that word');
    expect(run.feed.some((entry) => entry.text.includes('rejects the word "copilot"') && entry.text.includes('starts again'))).toBe(true);
    // The retry's brief carries the instruction, so the second attempt knew what to avoid.
    const builds = f.requests.filter((request) => request.prompt.includes('Your task: Log schema'));
    expect(builds.length).toBeGreaterThanOrEqual(2);
    expect(builds.at(-1)?.prompt).toContain('Write commit messages that describe what changed without that word');
    expect(run.tasks.find((task) => task.id === 'schema')?.round).toBe(2);
  });

  it('still stops and asks when the same hook keeps blocking after the instruction was given', async () => {
    const hook = 'git commit failed: [BLOCKED] Self-tagging detected: \'copilot\' Commit blocked.';
    const f = fixture({ buildFails: 99, buildError: hook });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.message).not.toContain('\u001b');
    expect(run.goal.match(/Write commit messages that describe what changed/g)).toHaveLength(1);
  });

  it('asks the Lead on the second failure with the same cause, and the redirect does not spend a retry', async () => {
    const f = fixture({ buildFails: 2, buildError: 'The test runner cannot find the module.', stuck: ['{"decision":"retry","guidance":"Install the missing module first.","lesson":"The test runner needs the module installed before any test."}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(f.requests.filter((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toHaveLength(1);
    expect(run.feed.some((entry) => entry.text.includes('failed the same way twice, so the Lead redirected it'))).toBe(true);
    expect(run.goal).toContain('The test runner needs the module installed');
  });

  it('does not bother the Lead about a first failure', async () => {
    const once = fixture({ buildFails: 1, buildError: 'A one-off crash.' });
    const a = await once.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: once.config }, 1);
    await runToIdle(once.runner, a.id);
    expect(once.requests.some((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toBe(false);
  });

  it('puts options on the question at once when the Lead has them for a repeated failure', async () => {
    const f = fixture({ buildFails: 99, buildError: 'The API key is rejected.', stuck: ['{"decision":"ask","reason":"Needs a key.","options":["Use the sandbox key.","Mock the API."]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.options).toEqual(['Use the sandbox key.', 'Mock the API.']);
    // Failed twice, asked once: the Lead is not asked again for the same stop.
    expect(f.requests.filter((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toHaveLength(1);
  });

  it('lets the Lead take its own safe option while the person is away, and says so', async () => {
    const f = fixture({
      buildFails: 99, buildError: 'The API key is rejected.',
      stuck: ['{"decision":"ask","reason":"Needs a key.","options":["Use the sandbox key.","Mock the API."]}'],
      away: ['{"choice":2,"reason":"Mocking is reversible."}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const stuck = await runToIdle(f.runner, started.id);
    expect(stuck.status).toBe('needsYou');
    await f.runner.setAway(started.id, true, 0, 1);
    await f.runner.whenIdle(started.id);
    const run = (await f.runner.get(started.id))!;
    expect(run.away.picked[0]).toBe(stuck.ask!.taskId);
    expect(run.feed.some((entry) => entry.text.includes('Chose automatically while you were away: Mock the API.'))).toBe(true);
    expect(run.chat.some((entry) => entry.text.includes('Chose automatically while you were away'))).toBe(true);
    expect(run.tasks.find((task) => task.id === stuck.ask!.taskId)?.reviews.some((review) => review.feedback === 'Mock the API.')).toBe(true);
  });

  it('leaves the question for the person when the Lead says none of its options is safe', async () => {
    const f = fixture({
      buildFails: 99, buildError: 'The API key is rejected.',
      stuck: ['{"decision":"ask","reason":"Needs a key.","options":["Buy a paid plan.","Mock the API."]}'],
      away: ['{"choice":"none","reason":"Both change what the person pays for or relies on."}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.setAway(started.id, true, 0, 1);
    const run = (await f.runner.get(started.id))!;
    expect(run.status).toBe('needsYou');
    expect(run.away.picked).toEqual([]);
    expect(run.feed.some((entry) => entry.text.includes('none of its options is safe to take without you'))).toBe(true);
  });

  it('keeps a question with no options waiting when the Lead finds no safe way forward', async () => {
    const f = fixture({ buildFails: 99, buildError: 'The API key is rejected.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.setAway(started.id, true, 0, 1);
    const run = (await f.runner.get(started.id))!;
    expect(run.status).toBe('needsYou');
    expect(f.requests.some((request) => request.prompt.includes('No options were offered'))).toBe(true);
    expect(run.feed.some((entry) => entry.text.includes('no safe way forward to take without you. Why: Their call.'))).toBe(true);
  });

  it('lets the Lead write its own way forward while the person is away, and lists it in the report', async () => {
    const f = fixture({
      buildFails: 99, buildError: 'The API key is rejected.',
      away: ['{"choice":"own","instruction":"Mock the API and record it in the report.","reason":"Reversible.","check":"Whether a mock is acceptable for the demo."}'],
    });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const stuck = await runToIdle(f.runner, started.id);
    await f.runner.setAway(started.id, true, 0, 1);
    await f.runner.whenIdle(started.id);
    const run = (await f.runner.get(started.id))!;
    expect(run.away.decisions[0]).toMatchObject({ taskId: stuck.ask!.taskId, choice: 'Mock the API and record it in the report.', check: 'Whether a mock is acceptable for the demo.' });
    expect(buildReport(run).awayDecisions[0]).toContain('Check: Whether a mock is acceptable for the demo.');
    expect(run.tasks.find((task) => task.id === stuck.ask!.taskId)?.reviews.some((review) => review.feedback === 'Mock the API and record it in the report.')).toBe(true);
  });

  it('tries the planned task titles against the commit rules before the first build', async () => {
    const f = fixture();
    f.ports.preflight = async (_project, text) => (/ingestion/i.test(text) ? { key: 'selftag:ingestion', note: 'A commit hook rejects the word "ingestion".' } : null);
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.knownBlockers).toContain('selftag:ingestion');
    expect(run.goal).toContain('A commit hook rejects the word "ingestion".');
    expect(run.feed.some((entry) => entry.text.includes('Tried the planned tasks against the project'))).toBe(true);
  });

  it('stops a crew whose builder is mid-run, and never starts another agent afterwards', async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = f.ports.runAgent;
    let startedAfterStop = 0;
    let stopped = false;
    f.ports.runAgent = async (request, ...rest) => {
      if (stopped) startedAfterStop += 1;
      if (request.prompt.startsWith('Project goal:')) await gate;
      return inner(request, ...rest);
    };
    f.ports.cancelAgent = () => { release(); return true; };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopped = true;
    const run = await f.runner.stop(started.id);
    expect(run.status).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startedAfterStop).toBe(0);
  });

  it('asks once when an agent has run out of usage, instead of retrying and wasting the retries', async () => {
    const f = fixture({ buildFails: 99, buildError: 'You have reached your usage limit. Try again later.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.message).toContain('has run out of usage');
    expect(run.ask?.message).toContain('Crew tab');
    expect(run.tasks.find((task) => task.id === 'schema')?.round).toBe(1);
    // The Lead is not asked to decide: a spent subscription is not something to retry or skip around.
    expect(f.requests.some((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toBe(false);
  });

  it('lets the team be changed on a crew that is not working, and refuses it on one that is', async () => {
    const f = fixture({ buildFails: 99, buildError: 'You have reached your usage limit.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const stuck = await runToIdle(f.runner, started.id);
    expect(stuck.status).toBe('needsYou');
    const changed = { ...stuck.config, roles: stuck.config.roles.map((role) => (role.id === 'builder' ? { ...role, agent: 'claude' as const } : role)) };
    const saved = await f.runner.updateConfig(started.id, changed);
    expect(saved.config.roles.find((role) => role.id === 'builder')?.agent).toBe('claude');
    expect(saved.chat.at(-1)?.text).toContain('The team was changed');
    expect((await f.runner.get(started.id))?.config.roles.find((role) => role.id === 'builder')?.agent).toBe('claude');

    const withoutBuilder = { ...stuck.config, roles: stuck.config.roles.filter((role) => role.id !== 'builder') };
    await expect(f.runner.updateConfig(started.id, withoutBuilder)).rejects.toThrow(/still needs the builder role/);

    const slow = fixture();
    const live = await slow.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: slow.config }, 1);
    await expect(slow.runner.updateConfig(live.id, slow.config)).rejects.toThrow(/Pause the crew first/);
    await runToIdle(slow.runner, live.id);
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

  it('turns a bare "continue" into the next unfinished part of the plan, found by the crew, not guessed from one word', async () => {
    const next = JSON.stringify({ tasks: [{ id: 'shell', title: 'Build the shell', role: 'builder', description: 'Phase 1', acceptance: ['The shell opens'], dependsOn: [] }] });
    const f = fixture({ plan: [PLAN, next], coverage: ['{"complete":true}', '{"complete":false,"remaining":["Phase 1: Shell","Phase 2: Providers"]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const finished = await runToIdle(f.runner, started.id);
    expect(finished.remaining).toEqual([]);

    await f.runner.message(started.id, 'work', 'continue', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.map((task) => task.id)).toEqual(['schema', 'ingest', 'shell']);
    const plan = f.requests.find((request) => request.prompt.includes('Plan only this'));
    expect(plan?.prompt).toContain('Continue the plan with: Phase 1: Shell.');
    expect(plan?.prompt).toContain('Still to do after it: Phase 2: Providers.');
    // The thread keeps the person's own word, once.
    expect(run.chat.filter((entry) => entry.from === 'you').map((entry) => entry.text)).toEqual(['continue']);
  });

  it('says there is nothing left, and plans nothing, when "continue" is said and the plan is finished', async () => {
    const f = fixture({ coverage: ['{"complete":true}', '{"complete":true}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const before = await runToIdle(f.runner, started.id);
    const after = await f.runner.message(started.id, 'work', 'Keep going', 1);
    expect(after.status).toBe('completed');
    expect(after.tasks).toEqual(before.tasks);
    expect(after.chat.at(-1)?.text).toContain('nothing left undone');
    expect(f.requests.some((request) => request.prompt.includes('Plan only this'))).toBe(false);
  });

  it('treats an empty plan with a reason as the Lead finding nothing to build, not as a failure', async () => {
    const empty = JSON.stringify({ tasks: [], note: 'Every part of the plan is already built.' });
    const f = fixture({ plan: [PLAN, empty] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.message(started.id, 'work', 'Add more features.', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.feed.at(-1)?.text).toContain('found nothing new to build: Every part of the plan is already built.');
  });

  it('shows what the Lead said when its reply was not a plan, so it can be understood', async () => {
    const f = fixture({ plan: [PLAN, 'I think Phase 1 is the next part, but it needs a decision first.'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    await f.runner.message(started.id, 'work', 'Do the next bit.', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.feed.at(-1)?.text).toContain('I think Phase 1 is the next part');
    expect(run.feed.at(-1)?.text).toContain('phase buttons');
  });

  it('files tasks under their phases, files a follow-up\'s tasks under the phase it asked for, and lets the person accept a finished one', async () => {
    const phased = JSON.stringify({ tasks: [
      { id: 'spike', title: 'Spike', role: 'builder', description: 'Prove it', acceptance: ['Works'], dependsOn: [], phase: 'Phase 0: Spike' },
    ] });
    const next = JSON.stringify({ tasks: [{ id: 'shell', title: 'Shell', role: 'builder', description: 'Build it', acceptance: ['Opens'], dependsOn: [] }] });
    const f = fixture({ plan: [phased, next], coverage: ['{"complete":false,"remaining":["Phase 1: Shell"]}', '{"complete":true}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.tasks[0]?.phase).toBe('Phase 0: Spike');
    expect(run.remaining).toEqual(['Phase 1: Shell']);

    const accepted = await f.runner.acceptPhase(started.id, 'Phase 0: Spike');
    expect(accepted.acceptedPhases).toEqual(['phase 0']);

    await f.runner.message(started.id, 'work', 'Continue the plan with: Phase 1: Shell.', 1);
    const after = await runToIdle(f.runner, started.id);
    expect(after.tasks.find((task) => task.id === 'shell')?.phase).toBe('Phase 1: Shell');
  });

  it('keeps the project as it was before each task, and can put it back after showing what would change', async () => {
    const f = fixture();
    const restored: string[] = [];
    f.ports.checkpoint = async () => ({ ref: `ref-${restored.length}-${Math.random().toString(36).slice(2, 6)}`, untracked: [], createdAt: new Date(Date.now() + restored.length).toISOString() });
    f.ports.diffSince = async () => [{ path: 'src/a.ts', added: 3, removed: 1 }];
    f.ports.restore = async (_projectId, checkpoint) => { restored.push(checkpoint.ref); return { restored: ['src/a.ts'], deleted: ['src/new.ts'] }; };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    const first = run.tasks[0]!;
    expect(first.checkpoint).not.toBeNull();

    const preview = await f.runner.previewRevert(started.id, first.id);
    expect(preview.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
    expect(preview.tasks.length).toBeGreaterThanOrEqual(1);

    const back = await f.runner.revertTask(started.id, first.id);
    expect(restored).toEqual([first.checkpoint!.ref]);
    expect(back.status).toBe('paused');
    expect(back.tasks.find((task) => task.id === first.id)).toMatchObject({ status: 'backlog', round: 0, checkpoint: null });
    expect(back.chat.at(-1)?.text).toContain('1 file put back, 1 removed');
  });

  it('refuses to undo while the crew is working, and a task that has no saved starting point', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await expect(f.runner.revertTask(started.id, 'schema')).rejects.toThrow(/Pause the crew first/);
    const done = await runToIdle(f.runner, started.id);
    await expect(f.runner.previewRevert(started.id, done.tasks[0]!.id)).rejects.toThrow(/no saved starting point/);
  });

  it('starts a new crew knowing what earlier crews learned, and keeps what a new blocker teaches for the next one', async () => {
    const saved: Array<{ projectId: string; key: string }> = [];
    const hook = 'git commit failed: [BLOCKED] Self-tagging detected: \'copilot\' Commit blocked.';
    const f = fixture({ buildFails: 1, buildError: hook });
    f.ports.blockers = {
      load: async () => [{ key: 'hook:old', note: 'Run the formatter before every commit.' }],
      save: async (projectId, item) => { saved.push({ projectId, key: item.key }); },
    };
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.goal).toContain('Run the formatter before every commit.');
    expect(run.knownBlockers).toEqual(['hook:old', 'selftag:copilot']);
    expect(saved).toEqual([{ projectId: 'p1', key: 'selftag:copilot' }]);
  });

  it('gives a task a stronger setting from its third attempt', async () => {
    const base = createDefaultCrewConfig('claude', 'codex');
    const f = fixture({ buildFails: 2 }, { savings: { ...base.savings, lightModelForRoutine: false } });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await runToIdle(f.runner, started.id);
    const attempts = f.requests.filter((request) => request.prompt.includes('Your task: Log schema'));
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts[0]?.effort).toBeUndefined();
    expect(attempts[1]?.effort).toBeUndefined();
    expect(attempts[2]?.effort).toBe('heavy');
  });

  it('carries on with the tasks already on the board when told to continue, without asking the Lead to plan them again', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const finished = await runToIdle(f.runner, started.id);
    // A crew that was stopped part way keeps what it had not built.
    f.saved.set(started.id, { ...finished, status: 'stopped', tasks: finished.tasks.map((task) => (task.id === 'ingest' ? { ...task, status: 'backlog' as const, round: 0, reviews: [] } : task)) });
    const requestsBefore = f.requests.length;

    await f.runner.message(started.id, 'work', 'continue', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.find((task) => task.id === 'ingest')?.status).toBe('accepted');
    expect(f.requests.slice(requestsBefore).some((request) => request.prompt.includes('Plan only this'))).toBe(false);
    expect(run.chat.at(-1)?.text).toContain('Carrying on with the 1 unfinished task');
  });

  it('carries on with planned tasks, instead of finishing with them undone, when a follow-up has nothing new to plan', async () => {
    const f = fixture({ plan: [PLAN, 'The existing board already covers that.'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const finished = await runToIdle(f.runner, started.id);
    f.saved.set(started.id, { ...finished, status: 'stopped', tasks: finished.tasks.map((task) => (task.id === 'ingest' ? { ...task, status: 'backlog' as const, round: 0, reviews: [] } : task)) });

    await f.runner.message(started.id, 'work', 'Start Phase 1.', 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.tasks.find((task) => task.id === 'ingest')?.status).toBe('accepted');
    expect(run.feed.some((entry) => entry.text.includes('already planned') && entry.text.includes('waiting on the board'))).toBe(true);
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
    expect(run.feed.some((entry) => entry.text.includes('not with tasks') && entry.text.includes('not a plan'))).toBe(true);
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

describe('crew runner, second round', () => {
  const phasedPlan = JSON.stringify({ tasks: [
    { id: 'spike', title: 'Spike', role: 'builder', description: 'Prove it', acceptance: ['Works'], dependsOn: [], phase: 'Phase 0: Spike' },
  ] });

  it('keeps a reviewer note without sending the task back', async () => {
    const f = fixture({ security: ['{"verdict":"accept","notes":["Electron is past end of support."]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.notes[0]?.text).toContain('Electron');
    expect((await f.runner.clearNotes(started.id)).notes).toEqual([]);
  });

  it('stops after a phase the person chose even when keeping going', async () => {
    const f = fixture({ plan: [phasedPlan], coverage: ['{"complete":false,"remaining":["Phase 1: Shell"]}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config, keepGoing: true }, 1);
    await f.runner.setPauseAfter(started.id, 'Phase 0: Spike', true);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('paused');
    expect(run.feed.some((entry) => entry.text.includes('Stopped after Phase 0: Spike'))).toBe(true);
  });

  it('writes a report when a phase is accepted, and checks the commit rules before starting', async () => {
    const f = fixture({ plan: [phasedPlan], coverage: ['{"complete":false,"remaining":["Phase 1: Shell"]}'] });
    const written: Array<{ path: string; content: string }> = [];
    f.ports.writeReport = async (_project, relativePath, content) => { written.push({ path: relativePath, content }); return relativePath; };
    f.ports.preflight = async () => ({ key: 'hook:commit-msg', note: 'The commit hook rejects the word copilot.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    expect(started.goal).toContain('rejects the word copilot');
    await runToIdle(f.runner, started.id);
    await f.runner.acceptPhase(started.id, 'Phase 0: Spike');
    expect(written[0]?.path).toBe('.kai/crew/reports/phase-0-spike.md');
    expect(written[0]?.content).toContain('# Phase 0: Spike');
  });

  it('warns when another crew on the project is not finished', async () => {
    const f = fixture();
    const first = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const second = await f.runner.start({ projectId: 'p1', goal: 'Another thing', config: f.config }, 1);
    expect(second.feed.some((entry) => entry.text.includes('Another crew on this project'))).toBe(true);
    await runToIdle(f.runner, first.id);
    await runToIdle(f.runner, second.id);
  });
  it('keeps building the other tasks while one waits on a question, and waits only when nothing else can go', async () => {
    const plan = JSON.stringify({ tasks: [
      { id: 'a', title: 'Header', role: 'builder', description: 'Header', acceptance: ['Renders'], dependsOn: [] },
      { id: 'b', title: 'Footer', role: 'builder', description: 'Footer', acceptance: ['Renders'], dependsOn: [] },
      { id: 'c', title: 'Header menu', role: 'builder', description: 'Menu', acceptance: ['Opens'], dependsOn: ['a'] },
    ] });
    const f = fixture({ plan: [plan], lead: ['{"verdict":"needsYou","feedback":"Which logo?"}', '{"verdict":"accept"}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build the site', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.taskId).toBe('a');
    expect(run.tasks.find((task) => task.id === 'b')?.status).toBe('accepted');
    expect(run.tasks.find((task) => task.id === 'c')?.status).toBe('backlog');
    expect(run.feed.some((entry) => entry.text.includes('waits for your answer. The crew carries on'))).toBe(true);
    await f.runner.answer(started.id, 'continue', 'Use the round logo.', 1);
    const done = await runToIdle(f.runner, started.id);
    expect(done.status).toBe('completed');
  });

  it('keeps a second question in a queue instead of over the first, and brings it up once the first is answered', async () => {
    const plan = JSON.stringify({ tasks: [
      { id: 'a', title: 'Header', role: 'builder', description: 'Header', acceptance: ['Renders'], dependsOn: [] },
      { id: 'b', title: 'Footer', role: 'builder', description: 'Footer', acceptance: ['Renders'], dependsOn: [] },
    ] });
    const f = fixture({ plan: [plan], lead: ['{"verdict":"needsYou","feedback":"Which logo?"}', '{"verdict":"needsYou","feedback":"Which links?"}', '{"verdict":"accept"}'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build the site', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    const first = run.ask!.taskId;
    expect(run.queuedAsks.map((ask) => ask.taskId)).toHaveLength(1);
    const queued = run.queuedAsks[0]!.taskId;
    expect(queued).not.toBe(first);
    await f.runner.answer(started.id, 'continue', 'Do it this way.', 1);
    const next = await runToIdle(f.runner, started.id);
    expect(next.ask?.taskId).toBe(queued);
    expect(next.queuedAsks).toHaveLength(0);
  });

  it('retries a build whose connection was cut without counting it as a failure or asking the Lead', async () => {
    const f = fixture({ buildFails: 2, buildError: 'terminated' });
    f.runner.dropRetryMs = 0;
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.feed.some((entry) => entry.text.includes('The connection to the agent was cut'))).toBe(true);
    expect(f.requests.some((request) => request.prompt.includes('A task has failed or been sent back too many times'))).toBe(false);
  });

  it('stops a task that has cost far more than a usual one, and asks later the next time', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const base = await runToIdle(f.runner, started.id);
    const accepted = (id: string, cost: number) => ({ ...base.tasks[0]!, id, title: id, status: 'accepted' as const, costUsd: cost });
    const pricey = { ...base.tasks[0]!, id: 'big', title: 'Big task', status: 'sentBack' as const, costUsd: 5, round: 4 };
    const run: CrewRun = { ...base, status: 'running', tasks: [accepted('x', 1), accepted('y', 1), accepted('z', 1), pricey] };
    const asked = askTaskSpend(run, 'big', '2026-11-01T10:00:00.000Z')!;
    expect(asked.ask).toMatchObject({ reason: 'taskSpend', taskId: 'big' });
    expect(asked.ask!.message).toContain('$5.00');
    expect(asked.tasks.find((task) => task.id === 'big')?.status).toBe('needsYou');
    // Once asked, the ceiling doubles: the same cost does not stop it again.
    expect(askTaskSpend({ ...asked, ask: null, tasks: asked.tasks.map((task) => task.id === 'big' ? { ...task, status: 'sentBack' as const } : task) }, 'big', '2026-11-01T10:00:00.000Z')).toBeNull();
    expect(awayEligible({ ...asked, away: { ...asked.away, enabled: true } })).toBeNull();
  });

  it('posts a summary of the stretch away when away mode is turned off', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    const on = setAway(run, true, 0, '2026-11-01T09:00:00.000Z');
    expect(on.away.since).toBe('2026-11-01T09:00:00.000Z');
    const off = setAway(on, false, 0, '2026-11-01T11:00:00.000Z');
    const last = off.chat.at(-1)!.text;
    expect(last).toContain('While you were away: 2 tasks accepted');
    expect(last).toContain('Nothing is waiting on you.');
    expect(off.away.since).toBeNull();
  });

  it('tells the planner and the reviewers not to stop on criteria only the person can meet, or on wording late in a task', async () => {
    const f = fixture();
    expect(planPrompt('Build it', f.config, '', { tasks: [] })).toContain('Never write a criterion only the person can meet');
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    const task = { ...run.tasks[0]!, round: 4 };
    const prompt = reviewPrompt(run, task, 'done');
    expect(prompt).toContain('This task is on round 4');
    expect(prompt).toContain('cannot be met by the crew');
    expect(prompt).toContain('playwright');
  });
  it('reads a verdict whose feedback quotes code with braces', () => {
    expect(parseReview('Done.\n{"verdict":"sendBack","feedback":"Use `${base}/x` and return {} on error.","notes":["See {a:1}."]}')).toEqual({ verdict: 'sendBack', feedback: 'Use `${base}/x` and return {} on error.', notes: ['See {a:1}.'] });
  });

  it('never treats an unreadable security reply as a security block', async () => {
    const f = fixture({ security: ['I looked at it and it seems fine overall.'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('needsYou');
    expect(run.ask?.reason).toBe('noProgress');
    expect(run.ask?.message).toContain('could not give a readable verdict');
  });

  it('goes on without an unreadable check while away, and lists it for the person', async () => {
    const f = fixture({ security: ['I looked at it and it seems fine overall.'] });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    await f.runner.setAway(started.id, true, 0, 1);
    const run = await runToIdle(f.runner, started.id);
    expect(run.status).toBe('completed');
    expect(run.away.decisions.some((item) => item.choice.includes("Went on without"))).toBe(true);
  });

  it('never stops a task for cost when the person turned the check off, and 0 means no limit while away', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const base = await runToIdle(f.runner, started.id);
    const accepted = (id: string) => ({ ...base.tasks[0]!, id, title: id, status: 'accepted' as const, costUsd: 1 });
    const run: CrewRun = { ...base, status: 'running', tasks: [accepted('x'), accepted('y'), accepted('z'), { ...base.tasks[0]!, id: 'big', title: 'Big', status: 'sentBack' as const, costUsd: 50 }] };
    expect(askTaskSpend({ ...run, away: { ...run.away, policy: { ...run.away.policy, costCheck: false } } }, 'big', '2026-11-01T10:00:00.000Z')).toBeNull();
    const noLimit = askTaskSpend({ ...run, away: { ...run.away, enabled: true, policy: { ...run.away.policy, costlyMaxUsd: 0 } } }, 'big', '2026-11-01T10:00:00.000Z')!;
    expect(noLimit.ask).toBeNull();
    expect(noLimit.away.decisions.at(-1)?.choice).toContain('you set no limit per task');
  });

  it('reads spend records saved before the cost was kept as a step each, not as $0', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const base = await runToIdle(f.runner, started.id);
    const accepted = (id: string) => ({ ...base.tasks[0]!, id, title: id, status: 'accepted' as const, costUsd: 1.67 });
    const run: CrewRun = { ...base, status: 'running', spendAsked: ['big', 'big', 'big'], tasks: [accepted('x'), accepted('y'), accepted('z'), { ...base.tasks[0]!, id: 'big', title: 'Big', status: 'sentBack' as const, costUsd: 18.6 }] };
    expect(askTaskSpend(run, 'big', '2026-11-01T10:00:00.000Z')).toBeNull();
  });

  it('moves the spend ceiling past what the task already cost once the person says carry on', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const base = await runToIdle(f.runner, started.id);
    const accepted = (id: string) => ({ ...base.tasks[0]!, id, title: id, status: 'accepted' as const, costUsd: 1.67 });
    const run: CrewRun = { ...base, status: 'running', tasks: [accepted('x'), accepted('y'), accepted('z'), { ...base.tasks[0]!, id: 'big', title: 'Big', status: 'sentBack' as const, costUsd: 15.97 }] };
    const asked = askTaskSpend(run, 'big', '2026-11-01T10:00:00.000Z')!;
    const answered = { ...asked, ask: null, status: 'running' as const, tasks: asked.tasks.map((task) => (task.id === 'big' ? { ...task, status: 'sentBack' as const } : task)) };
    expect(askTaskSpend(answered, 'big', '2026-11-01T10:00:00.000Z')).toBeNull();
  });

  it('lets a costly task carry on by itself while away, under the person\'s limit, and records it', async () => {
    const f = fixture();
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const base = await runToIdle(f.runner, started.id);
    const accepted = (id: string) => ({ ...base.tasks[0]!, id, title: id, status: 'accepted' as const, costUsd: 1 });
    const run: CrewRun = { ...base, status: 'running', away: { ...base.away, enabled: true }, tasks: [accepted('x'), accepted('y'), accepted('z'), { ...base.tasks[0]!, id: 'big', title: 'Big', status: 'sentBack' as const, costUsd: 5 }] };
    const carried = askTaskSpend(run, 'big', '2026-11-01T10:00:00.000Z')!;
    expect(carried.ask).toBeNull();
    expect(carried.away.decisions.at(-1)?.choice).toContain('under your $10.00 limit');
    const strict = askTaskSpend({ ...run, away: { ...run.away, policy: { ...run.away.policy, costly: false } } }, 'big', '2026-11-01T10:00:00.000Z')!;
    expect(strict.ask?.reason).toBe('taskSpend');
  });

  it('follows the person\'s away rules: what the Lead may decide, what it must leave, and their own words', async () => {
    const f = fixture({ buildFails: 99, buildError: 'The API key is rejected.' });
    const started = await f.runner.start({ projectId: 'p1', goal: 'Build Zuri Log', config: f.config }, 1);
    const stuck = await runToIdle(f.runner, started.id);
    const policy = { ...stuck.away.policy, other: 'Never change the database schema.' };
    const changed = await f.runner.setAway(started.id, true, 0, 1, policy);
    expect(changed.away.policy.other).toBe('Never change the database schema.');
    const prompt = f.requests.map((request) => request.prompt).find((text) => text.includes('The person is away from the computer'))!;
    expect(prompt).toContain('adding a dependency or package');
    expect(prompt).toContain('Never change the database schema.');
    const none = { ...stuck, away: { ...stuck.away, enabled: true, policy: { ...stuck.away.policy, retry: false, skip: false, reversible: false } } };
    expect(awayEligible(none)).toBeNull();
    // Changing only the rules posts nothing in the chat.
    const before = changed.chat.length;
    const again = await f.runner.setAway(started.id, true, 0, 1, { ...policy, paid: true });
    expect(again.chat.length).toBe(before);
  });
});
