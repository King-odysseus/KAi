import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentTeam,
  createDefaultSettings,
  parseIpcInput,
  teamStartInputSchema,
  type AgentCapability,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentTeam,
  type ConversationRecord,
  type TeamPart,
  type WorkflowStartInput,
} from '../packages/contracts/src';
import { assignTeam, resolveOrchestrator, type AssignmentEnvironment } from '../apps/desktop/src/main/team-assign';
import {
  applyGuardrails,
  buildOrchestratorPrompt,
  buildStepPrompt,
  checkStructure,
  handoffSection,
  parseTeamPlan,
  parseVerdict,
} from '../apps/desktop/src/main/team-plan';
import { DesktopTeamPlanner, type TeamPlannerPorts } from '../apps/desktop/src/main/team-planner';

const ALL = ['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const;

function capability(id: (typeof ALL)[number], state: AgentCapability['state'] = 'ready'): AssignmentEnvironment['capabilities'][number] {
  const names = { claude: 'Claude', codex: 'Codex', qwen: 'Qwen Code', gemini: 'Gemini CLI', kimi: 'Kimi Code' };
  return {
    id,
    displayName: names[id],
    available: state === 'ready',
    state,
    supportsRoutes: id === 'gemini' ? ['direct'] : ['direct', 'proxy'],
    ...(state === 'ready' ? {} : { unavailableReason: `${names[id]} is ${state}.` }),
  };
}

function environment(overrides: Partial<Record<(typeof ALL)[number], AgentCapability['state']>> = {}, extra: Partial<AssignmentEnvironment> = {}): AssignmentEnvironment {
  return {
    capabilities: ALL.map((id) => capability(id, overrides[id] ?? 'ready')),
    api: { available: true, displayName: 'KAI API' },
    proxyReady: true,
    ...extra,
  };
}

function part(id: string, role: TeamPart['role'], extra: Partial<TeamPart> = {}): TeamPart {
  return { id, title: `${id} title`, role, prompt: `Do ${id}`, dependsOn: [], paths: [], ...extra };
}

const FULL_PARTS: TeamPart[] = [
  part('ui', 'frontend'),
  part('api', 'backend'),
  part('tests', 'tests', { dependsOn: ['ui', 'api'] }),
  part('docs', 'docs'),
  part('security', 'securityReviewer', { dependsOn: ['ui', 'api'] }),
  part('review', 'codeReviewer', { dependsOn: ['ui', 'api'] }),
];

function team(overrides: Partial<AgentTeam> & { roles?: Partial<AgentTeam['roles']> } = {}): AgentTeam {
  const base = createDefaultAgentTeam();
  return { preset: overrides.preset ?? base.preset, roles: { ...base.roles, ...(overrides.roles ?? {}) } };
}

function agentFor(result: ReturnType<typeof assignTeam>, id: string): string {
  return result.assignments.find((assignment) => assignment.partId === id)!.assignee;
}

describe('team assignment', () => {
  it('picks each specialist on the Balanced preset and keeps reviewers independent of the authors', () => {
    const result = assignTeam(FULL_PARTS, team(), environment());

    expect(agentFor(result, 'ui')).toBe('claude');
    expect(agentFor(result, 'api')).toBe('codex');
    expect(agentFor(result, 'tests')).toBe('qwen');
    expect(agentFor(result, 'docs')).toBe('kimi');
    const authors = new Set(['ui', 'api', 'tests', 'docs'].map((id) => agentFor(result, id)));
    expect(authors.has(agentFor(result, 'security'))).toBe(false);
    expect(authors.has(agentFor(result, 'review'))).toBe(false);
    expect(result.assignments.every((assignment) => assignment.billing === 'subscription' && assignment.route === 'direct')).toBe(true);
  });

  it('follows the preset: Quality spends premium agents everywhere, Budget spares them', () => {
    expect(agentFor(assignTeam([part('t', 'tests')], team({ preset: 'quality' }), environment()), 't')).toBe('claude');
    expect(agentFor(assignTeam([part('t', 'tests')], team({ preset: 'budget' }), environment()), 't')).toBe('qwen');
    expect(agentFor(assignTeam([part('d', 'docs')], team({ preset: 'budget' }), environment()), 'd')).toBe('kimi');
  });

  it('honours a role pinned to an agent and applies its model and route', () => {
    const pinned = team({ roles: { frontend: { assignee: 'gemini', route: 'direct', model: 'gemini-3.8-pro', instructions: '' } } });
    const result = assignTeam([part('ui', 'frontend')], pinned, environment());

    expect(result.assignments[0]).toMatchObject({ assignee: 'gemini', route: 'direct', model: 'gemini-3.8-pro' });
    expect(result.assignments[0]!.reason).toContain('You chose Gemini CLI');
  });

  it('falls back to another agent, and says so, when a pinned agent is not ready', () => {
    const pinned = team({ roles: { frontend: { assignee: 'gemini', route: 'direct', instructions: '' } } });
    const result = assignTeam([part('ui', 'frontend')], pinned, environment({ gemini: 'not_installed' }));

    expect(result.assignments[0]!.assignee).not.toBe('gemini');
    expect(result.warnings.join(' ')).toContain('Gemini CLI is not ready');
  });

  it('runs a signed-out agent through the proxy and marks the part as proxy-billed', () => {
    const only = environment({ claude: 'signed_out', codex: 'not_installed', qwen: 'not_installed', gemini: 'not_installed', kimi: 'not_installed' }, { api: { available: false, displayName: 'KAI API' } });
    const result = assignTeam([part('ui', 'frontend')], team(), only);

    expect(result.assignments[0]).toMatchObject({ assignee: 'claude', route: 'proxy', billing: 'proxy' });
    expect(result.warnings.join(' ')).toContain('signed out');
  });

  it('never routes through the proxy on its own when the CLI is ready', () => {
    const result = assignTeam(FULL_PARTS, team({ preset: 'budget' }), environment());
    expect(result.assignments.some((assignment) => assignment.route === 'proxy')).toBe(false);
  });

  it('lets a reviewer be an author only when nobody else is ready, and warns', () => {
    const two = environment({ qwen: 'not_installed', gemini: 'not_installed', kimi: 'not_installed' }, { api: { available: false, displayName: 'KAI API' } });
    const result = assignTeam([part('ui', 'frontend'), part('api', 'backend'), part('review', 'codeReviewer')], team(), two);

    expect(['claude', 'codex']).toContain(agentFor(result, 'review'));
    expect(result.warnings.join(' ')).toContain('also wrote some of the code');
  });

  it('steers Auto away from Kimi Code on Windows, but still honours a pin and warns about it', () => {
    const windows = environment({}, { platform: 'win32' });
    expect(agentFor(assignTeam([part('d', 'docs')], team({ preset: 'budget' }), windows), 'd')).not.toBe('kimi');
    expect(agentFor(assignTeam([part('d', 'docs')], team({ preset: 'budget' }), environment({}, { platform: 'linux' })), 'd')).toBe('kimi');

    const pinned = team({ roles: { docs: { assignee: 'kimi', route: 'direct', instructions: '' } } });
    const result = assignTeam([part('d', 'docs')], pinned, windows);
    expect(agentFor(result, 'd')).toBe('kimi');
    expect(result.warnings.join(' ')).toContain('Windows limits to about 30,000 characters');
  });

  it('refuses to plan when no agent at all is ready', () => {
    const none = environment({ claude: 'not_installed', codex: 'not_installed', qwen: 'not_installed', gemini: 'not_installed', kimi: 'not_installed' }, { api: { available: false, displayName: 'KAI API' } });
    expect(() => assignTeam([part('ui', 'frontend')], team(), none)).toThrow(/No agent is ready for Frontend specialist/);
  });

  it('fills a role missing from older saved settings instead of failing', () => {
    const partial = { preset: 'balanced', roles: {} } as unknown as AgentTeam;
    expect(() => assignTeam([part('ui', 'frontend')], partial, environment())).not.toThrow();
  });
});

describe('orchestrator choice', () => {
  it("plans with KAI's own API mode by default", () => {
    expect(resolveOrchestrator(team(), environment())).toMatchObject({ assignee: 'api', route: 'direct' });
  });

  it('falls back to the strongest ready CLI when API mode is not set up', () => {
    const noApi = environment({}, { api: { available: false, displayName: 'KAI API', unavailableReason: 'No key.' } });
    expect(resolveOrchestrator(team(), noApi)).toMatchObject({ assignee: 'claude' });
  });

  it('uses a CLI the user chose, and explains when it cannot', () => {
    const chosen = team({ roles: { orchestrator: { assignee: 'codex', route: 'direct', instructions: '' } } });
    expect(resolveOrchestrator(chosen, environment())).toMatchObject({ assignee: 'codex', reason: 'You chose Codex to plan.' });

    const broken = resolveOrchestrator(chosen, environment({ codex: 'signed_out' }));
    expect(broken?.warnings.join(' ')).toContain('Codex cannot plan right now');
    expect(broken?.assignee).toBe('api');
  });

  it('returns nothing when nothing can plan', () => {
    const none = environment({ claude: 'not_installed', codex: 'not_installed', qwen: 'not_installed', gemini: 'not_installed', kimi: 'not_installed' }, { api: { available: false, displayName: 'KAI API' } });
    expect(resolveOrchestrator(team(), none)).toBeNull();
  });
});

describe('plan parsing', () => {
  const valid = { summary: 'Login', parts: [{ id: 'ui', title: 'Form', role: 'frontend', prompt: 'Build it', dependsOn: [], paths: ['src/'] }] };

  it('reads plain, fenced and chatty replies', () => {
    for (const reply of [JSON.stringify(valid), `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, `Sure! Here is the plan:\n${JSON.stringify(valid)}\nLet me know.`]) {
      expect(parseTeamPlan(reply)).toMatchObject({ ok: true, plan: { parts: [{ id: 'ui', role: 'frontend' }] } });
    }
  });

  it.each([
    ['no JSON', 'I would start with the UI.', /did not contain a JSON object/],
    ['malformed JSON', '{"parts": [', /did not contain|malformed/],
    ['an unknown role', JSON.stringify({ parts: [{ ...valid.parts[0], role: 'wizard' }] }), /role/],
    ['the orchestrator as a worker', JSON.stringify({ parts: [{ ...valid.parts[0], role: 'orchestrator' }] }), /role/],
    ['no parts', JSON.stringify({ parts: [] }), /parts/],
    ['a missing dependency', JSON.stringify({ parts: [{ ...valid.parts[0], dependsOn: ['ghost'] }] }), /does not exist/],
    ['a self dependency', JSON.stringify({ parts: [{ ...valid.parts[0], dependsOn: ['ui'] }] }), /depends on itself/],
    ['duplicate ids', JSON.stringify({ parts: [valid.parts[0], valid.parts[0]] }), /used twice/],
    ['an unusable id', JSON.stringify({ parts: [{ ...valid.parts[0], id: 'has space' }] }), /may only use/],
    ['a dependency loop', JSON.stringify({ parts: [{ ...valid.parts[0], id: 'a', dependsOn: ['b'] }, { ...valid.parts[0], id: 'b', dependsOn: ['a'] }] }), /loop/],
    ['too many parts', JSON.stringify({ parts: Array.from({ length: 11 }, (_, index) => ({ ...valid.parts[0], id: `p${index}` })) }), /limit is 10/],
  ])('rejects %s', (_name, reply, message) => {
    const parsed = parseTeamPlan(reply);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(message);
  });

  it('accepts a plan whose dependencies point backwards or forwards without a loop', () => {
    expect(checkStructure([part('b', 'tests', { dependsOn: ['a'] }), part('a', 'backend')])).toBeNull();
  });

  it('gives the orchestrator every worker role and the exact reply shape', () => {
    const prompt = buildOrchestratorPrompt('Add login');
    for (const role of ['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs']) expect(prompt).toContain(`"${role}"`);
    expect(prompt).toContain('Goal: Add login');
    expect(prompt).toContain('Do not create, edit or delete anything');
  });
});

describe('guardrails', () => {
  it('adds a security review when the job touches sensitive areas, and always a code review', () => {
    const guarded = applyGuardrails('Add a login page with password reset', [part('ui', 'frontend'), part('api', 'backend')]);

    expect(guarded.parts.map((item) => item.role)).toEqual(['frontend', 'backend', 'securityReviewer', 'codeReviewer']);
    expect(guarded.parts[2]!.dependsOn).toEqual(['ui', 'api']);
    expect(guarded.warnings.join(' ')).toMatch(/security review because this job touches: .*login/);
  });

  it('adds only a code review for an ordinary change', () => {
    const guarded = applyGuardrails('Make the header blue', [part('ui', 'frontend', { prompt: 'Change the header colour' })]);
    expect(guarded.parts.map((item) => item.role)).toEqual(['frontend', 'codeReviewer']);
  });

  it('does not duplicate reviews the orchestrator already planned', () => {
    const guarded = applyGuardrails('Add login', [part('ui', 'frontend'), part('sec', 'securityReviewer'), part('cr', 'codeReviewer')]);
    expect(guarded.parts).toHaveLength(3);
    expect(guarded.warnings).toEqual([]);
  });

  it('keeps added ids unique', () => {
    const guarded = applyGuardrails('Make it blue', [part('code-review', 'frontend')]);
    expect(new Set(guarded.parts.map((item) => item.id)).size).toBe(guarded.parts.length);
  });

  it('adds no reviews to a plan that changes nothing', () => {
    const readOnly = applyGuardrails('Audit the login flow', [part('audit', 'securityReviewer')]);
    expect(readOnly.parts.map((item) => item.role)).toEqual(['securityReviewer']);
    expect(readOnly.warnings).toEqual([]);
  });

  it('reviews documentation work too, because a docs writer edits files', () => {
    expect(applyGuardrails('Update the readme', [part('docs', 'docs')]).parts.map((item) => item.role)).toEqual(['docs', 'codeReviewer']);
  });
});

describe('step prompts and hand-offs', () => {
  it('tells a reviewer it is read-only and a security reviewer how to give its verdict', () => {
    const prompt = buildStepPrompt('Add login', part('sec', 'securityReviewer', { paths: ['src/auth'] }), { assignee: 'auto', route: 'auto', instructions: 'Check the OWASP Top 10.' });

    expect(prompt).toContain('Security reviewer');
    expect(prompt).toContain('do not create, edit or delete any files');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('Stay within: src/auth.');
    expect(prompt).toContain('Extra guidance for this role: Check the OWASP Top 10.');
  });

  it('asks an editing role to list what it changed', () => {
    expect(buildStepPrompt('Goal', part('ui', 'frontend'), undefined)).toContain('list the files you changed');
  });

  it('reads verdicts, and treats a missing one as a block', () => {
    expect(parseVerdict('Looks fine.\nVERDICT: PASS')).toEqual({ result: 'pass', reason: '' });
    expect(parseVerdict('Found a key.\n**VERDICT: BLOCK** - the API key is committed')).toEqual({ result: 'block', reason: 'the API key is committed' });
    expect(parseVerdict('verdict - pass, nothing serious').result).toBe('pass');
    expect(parseVerdict('All good, ship it.')).toMatchObject({ result: 'block', reason: expect.stringContaining('clear PASS or BLOCK') });
    // The last verdict line wins, so a quoted example earlier in the reply cannot decide it.
    expect(parseVerdict('Format: VERDICT: PASS\n...\nVERDICT: BLOCK - injection').result).toBe('block');
  });

  it('shows a later part what earlier parts produced, shortened', () => {
    const text = handoffSection([
      { label: 'Backend: API', agent: 'codex', output: 'Added /login.' },
      { label: 'Empty', agent: 'qwen', output: '   ' },
      { label: 'Long', agent: 'claude', output: 'x'.repeat(50) },
    ], 20);
    expect(text).toContain('### Backend: API (codex)\nAdded /login.');
    expect(text).not.toContain('Empty');
    expect(text).toContain('[shortened]');
    expect(handoffSection([])).toBe('');
  });
});

describe('team contracts', () => {
  it('starts every install with KAI planning and every other role on Auto', () => {
    const settings = createDefaultSettings();
    expect(settings.agentTeam.preset).toBe('balanced');
    expect(settings.agentTeam.roles.orchestrator).toMatchObject({ assignee: 'api' });
    expect(Object.entries(settings.agentTeam.roles).filter(([role]) => role !== 'orchestrator').every(([, config]) => config.assignee === 'auto')).toBe(true);
  });

  it('validates the IPC inputs', () => {
    expect(parseIpcInput('team:plan', { projectId: 'p', goal: '  Add login  ' })).toEqual({ projectId: 'p', goal: 'Add login' });
    expect(() => parseIpcInput('team:plan', { projectId: 'p', goal: '' })).toThrow();
    expect(() => parseIpcInput('settings:update', { agentTeam: { preset: 'wild', roles: {} } })).toThrow();
    expect(() => teamStartInputSchema.parse({ projectId: 'p', goal: 'g', parts: [], assignments: [], autonomy: 'ask' })).toThrow();
  });

  it('rejects a model name that could reach a command line as a flag', () => {
    const bad = { preset: 'balanced', roles: { frontend: { assignee: 'claude', route: 'direct', model: '--dangerous', instructions: '' } } };
    expect(() => parseIpcInput('settings:update', { agentTeam: bad })).toThrow();
  });
});

describe('team planner service', () => {
  function planner(replies: string[], extra: Partial<TeamPlannerPorts> = {}) {
    const requests: AgentRunRequest[] = [];
    const started: WorkflowStartInput[] = [];
    const settings = createDefaultSettings();
    const ports: TeamPlannerPorts = {
      settings: async () => settings,
      agentCapabilities: async () => ALL.map((id) => ({ ...capability(id), command: id, signInCommand: id, installUrl: 'https://example.com', supportsAutonomy: ['plan'] }) as AgentCapability),
      directApi: async () => ({ available: true, displayName: 'KAI API' }),
      proxyReady: async () => true,
      createConversation: async (projectId, title) => ({ id: 'plan-conversation', projectId, title } as ConversationRecord),
      runAgent: async (request) => {
        requests.push(request);
        return { conversation: {} as ConversationRecord, status: 'completed', output: replies[requests.length - 1] ?? '' } satisfies AgentRunResult;
      },
      startWorkflow: async (input) => {
        started.push(input);
        return { conversationId: 'c', projectId: input.projectId, workflow: {} as never };
      },
      ...extra,
    };
    return { planner: new DesktopTeamPlanner(ports), requests, started };
  }

  const reply = JSON.stringify({
    summary: 'Add login',
    parts: [
      { id: 'ui', title: 'Login form', role: 'frontend', prompt: 'Build the form', dependsOn: [], paths: ['src/ui'] },
      { id: 'api', title: 'Auth endpoint', role: 'backend', prompt: 'Add /login', dependsOn: [], paths: ['src/api'] },
    ],
  });

  it('plans read-only through the chosen orchestrator, then guards and assigns', async () => {
    const { planner: service, requests } = planner([reply]);
    const draft = await service.plan({ projectId: 'p1', goal: 'Add a login page' }, 7);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ execution: 'api', autonomy: 'plan', freshSession: true, route: 'direct' });
    expect(draft.orchestrator.assignee).toBe('api');
    expect(draft.parts.map((item) => item.role)).toEqual(['frontend', 'backend', 'securityReviewer', 'codeReviewer']);
    expect(draft.assignments).toHaveLength(4);
    expect(draft.warnings.join(' ')).toContain('security review');
    // Planning starts nothing.
  });

  it('asks the orchestrator once more when its first reply is unusable', async () => {
    const { planner: service, requests } = planner(['I think we should start with the UI.', reply]);
    const draft = await service.plan({ projectId: 'p1', goal: 'Make the header blue' }, 7);

    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain('could not be used');
    expect(draft.parts.length).toBeGreaterThan(0);
  });

  it('reports a plan that stays unusable instead of running anything', async () => {
    const { planner: service, requests, started } = planner(['no', 'still no']);
    await expect(service.plan({ projectId: 'p1', goal: 'Do it' }, 7)).rejects.toThrow(/did not return a usable plan/);
    expect(requests).toHaveLength(2);
    expect(started).toHaveLength(0);
  });

  it('reports an orchestrator that fails to run', async () => {
    const { planner: service } = planner([], {
      runAgent: async () => ({ conversation: {} as ConversationRecord, status: 'failed', output: '', error: 'Not logged in' }),
    });
    await expect(service.plan({ projectId: 'p1', goal: 'Do it' }, 7)).rejects.toThrow(/could not run: Not logged in/);
  });

  it('starts the approved plan with per-step agents, routes, read-only reviewers and a security gate', async () => {
    const { planner: service, started } = planner([reply]);
    const draft = await service.plan({ projectId: 'p1', goal: 'Add a login page' }, 7);
    await service.start({ projectId: 'p1', goal: draft.goal, parts: draft.parts, assignments: draft.assignments, autonomy: 'autoEdit' }, 7);

    expect(started).toHaveLength(1);
    const steps = started[0]!.steps;
    expect(steps.map((step) => step.id)).toEqual(draft.parts.map((item) => item.id));
    const byId = Object.fromEntries(steps.map((step) => [step.id, step]));
    expect(byId.ui).toMatchObject({ role: 'frontend', autonomy: 'autoEdit', execution: 'cli', route: 'direct', label: 'Frontend specialist: Login form' });
    expect(byId['security-review']).toMatchObject({ role: 'securityReviewer', autonomy: 'plan', gate: 'security', dependsOn: ['ui', 'api'] });
    expect(byId['code-review']).toMatchObject({ autonomy: 'plan' });
    expect(byId['code-review']!.gate).toBeUndefined();
    expect(started[0]!.loop.enabled).toBe(false);
  });

  it('sends KAI API parts to the API runner and keeps a labelling agent', async () => {
    const { planner: service, started } = planner([reply]);
    const draft = await service.plan({ projectId: 'p1', goal: 'Make the header blue' }, 7);
    const forced = draft.assignments.map((assignment) => ({ ...assignment, assignee: 'api' as const, billing: 'api' as const }));
    await service.start({ projectId: 'p1', goal: draft.goal, parts: draft.parts, assignments: forced, autonomy: 'ask' }, 7);

    expect(started[0]!.steps.every((step) => step.execution === 'api' && step.agent === 'codex')).toBe(true);
  });

  it('refuses to start a plan that is broken or whose agent stopped being ready', async () => {
    const { planner: service } = planner([reply], {
      agentCapabilities: async () => ALL.map((id) => ({ ...capability(id, 'not_installed'), command: id, signInCommand: id, installUrl: 'https://example.com', supportsAutonomy: ['plan'] }) as AgentCapability),
      directApi: async () => ({ available: false, displayName: 'KAI API' }),
    });
    const parts = [part('ui', 'frontend')];
    const assignment = { partId: 'ui', assignee: 'claude' as const, route: 'direct' as const, reason: 'x', billing: 'subscription' as const };

    await expect(service.start({ projectId: 'p', goal: 'g', parts, assignments: [assignment], autonomy: 'ask' }, 1)).rejects.toThrow(/cannot run/);
    await expect(service.start({ projectId: 'p', goal: 'g', parts, assignments: [], autonomy: 'ask' }, 1)).rejects.toThrow(/no agent assigned/);
    await expect(service.start({ projectId: 'p', goal: 'g', parts: [part('a', 'backend', { dependsOn: ['b'] }), part('b', 'backend', { dependsOn: ['a'] })], assignments: [], autonomy: 'ask' }, 1)).rejects.toThrow(/cannot run/);
  });
});
