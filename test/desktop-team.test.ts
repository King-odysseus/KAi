import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_ROLES,
  agentTeamSchema,
  createDefaultAgentTeam,
  createDefaultSettings,
  customRoleIdSchema,
  parseIpcInput,
  projectPreferencesV1Schema,
  resolveRole,
  roleConfigFor,
  stepAccess,
  teamStartInputSchema,
  type AgentCapability,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentTeam,
  type CustomRole,
  type ConversationRecord,
  type TeamPart,
  type WorkflowStartInput,
} from '../packages/contracts/src';
import { assignTeam, resolveOrchestrator, type AssignmentEnvironment } from '../apps/desktop/src/main/team-assign';
import {
  applyGuardrails,
  buildOrchestratorPrompt,
  buildStepPrompt,
  buildFixPrompt,
  checkStructure,
  failingPaths,
  handoffSection,
  parseTeamPlan,
  parseVerdict,
  routeFailure,
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

  it('follows each role\'s "added to a job" setting', () => {
    const work = [part('ui', 'frontend'), part('api', 'backend')];
    const withRoles = (roles: Partial<AgentTeam['roles']>) => team({ roles }).roles;
    const cfg = (autoAdd: 'always' | 'sensitive' | 'never') => ({ assignee: 'auto' as const, route: 'auto' as const, instructions: '', autoAdd });

    // Never: the code review the default always adds is left out, and the orchestrator can still plan one.
    expect(applyGuardrails('Make it blue', work, { roles: withRoles({ codeReviewer: cfg('never') }) }).parts.map((item) => item.role)).toEqual(['frontend', 'backend']);

    // Always: a test part and a security review are added even for an ordinary job, and reviewers see the tests too.
    const always = applyGuardrails('Make it blue', work, { roles: withRoles({ tests: cfg('always'), securityReviewer: cfg('always') }) });
    expect(always.parts.map((item) => item.role)).toEqual(['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer']);
    const reviewer = always.parts.find((item) => item.role === 'codeReviewer')!;
    expect(reviewer.dependsOn).toEqual(['ui', 'api', 'tests']);
    expect(always.parts.find((item) => item.role === 'tests')!.dependsOn).toEqual(['ui', 'api']);
    expect(always.warnings.join(' ')).toContain('Added a test part: your team settings add one to every job.');

    // Sensitive: docs are added only when the job touches something sensitive.
    const docs = { roles: withRoles({ docs: cfg('sensitive') }) };
    expect(applyGuardrails('Make it blue', work, docs).parts.some((item) => item.role === 'docs')).toBe(false);
    expect(applyGuardrails('Add a login page', work, docs).parts.some((item) => item.role === 'docs')).toBe(true);
  });

  it('never adds a part the orchestrator already planned, or one with nothing to work on', () => {
    const cfg = { assignee: 'auto' as const, route: 'auto' as const, instructions: '', autoAdd: 'always' as const };
    const planned = applyGuardrails('Add tests', [part('ui', 'frontend'), part('t', 'tests')], { roles: team({ roles: { tests: cfg } }).roles });
    expect(planned.parts.filter((item) => item.role === 'tests')).toHaveLength(1);
    // Only a read-only review is planned, so nothing was changed that could need tests or docs.
    const readOnly = applyGuardrails('Audit it', [part('audit', 'securityReviewer')], { roles: team({ roles: { tests: cfg, docs: cfg } }).roles });
    expect(readOnly.parts).toHaveLength(1);
  });

  it('reviews documentation work too, because a docs writer edits files', () => {
    expect(applyGuardrails('Update the readme', [part('docs', 'docs')]).parts.map((item) => item.role)).toEqual(['docs', 'codeReviewer']);
  });

  it('writes its own default prompt for every part it adds, so no agent runs on an empty instruction', () => {
    const cfg = { assignee: 'auto' as const, route: 'auto' as const, instructions: '', autoAdd: 'always' as const };
    const guarded = applyGuardrails('Add a login page', [part('ui', 'frontend')], { roles: team({ roles: { tests: cfg, docs: cfg } }).roles });
    const added = guarded.parts.filter((item) => item.id !== 'ui');

    expect(added.map((item) => item.role)).toEqual(['tests', 'docs', 'securityReviewer', 'codeReviewer']);
    for (const item of added) expect(item.prompt.trim().length).toBeGreaterThan(0);
    // A security review names what made the job sensitive; a code review says what to look for.
    expect(added.find((item) => item.role === 'securityReviewer')?.prompt).toContain('This job touches:');
    expect(added.find((item) => item.role === 'codeReviewer')?.prompt).toContain('correctness');
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

  it('gives every built-in role its default prompt, even when the part brings none of its own', () => {
    const roles: TeamPart['role'][] = ['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs'];
    for (const role of roles) {
      const info = resolveRole(undefined, role);
      const prompt = buildStepPrompt('Ship the login page', part(role, role, { prompt: '' }), undefined);

      expect(prompt).toContain(`You are the ${info.label} on a team of coding agents`);
      expect(prompt).toContain('Overall goal: Ship the login page');
      expect(prompt).toContain(`Your part - ${role} title:`);
      expect(prompt).toContain(info.access === 'read' ? 'do not create, edit or delete any files' : 'list the files you changed');
    }
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

const DATABASE: CustomRole = {
  id: 'custom-database',
  label: 'Database specialist',
  description: 'Schemas, queries and migrations.',
  access: 'edit',
  assignee: 'codex',
  route: 'direct',
  instructions: 'Never drop a column without a migration.',
};
const AUDITOR: CustomRole = { id: 'custom-a11y', label: 'Accessibility auditor', description: 'Checks keyboard and screen reader use.', access: 'read', assignee: 'auto', route: 'auto', instructions: '' };

function withCustom(...roles: CustomRole[]): AgentTeam {
  return { ...createDefaultAgentTeam(), custom: roles };
}

describe('custom roles', () => {
  it('are defined by the user, safe by construction, and limited in number', () => {
    expect(customRoleIdSchema.safeParse('custom-database').success).toBe(true);
    for (const bad of ['database', 'custom-', 'custom-Database', 'custom-a b', 'custom--x', `custom-${'x'.repeat(40)}`]) {
      expect(customRoleIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(createDefaultAgentTeam().custom).toEqual([]);
    const many = Array.from({ length: MAX_CUSTOM_ROLES + 1 }, (_, index) => ({ ...DATABASE, id: `custom-r${index}` }));
    expect(agentTeamSchema.safeParse({ ...createDefaultAgentTeam(), custom: many }).success).toBe(false);
    // Older settings without the list still load, with none.
    const { custom: _dropped, ...older } = createDefaultAgentTeam();
    expect(agentTeamSchema.parse(older).custom).toEqual([]);
  });

  it('resolve like built-in roles, and an unknown one is read-only', () => {
    const team = withCustom(DATABASE, AUDITOR);
    expect(resolveRole(team, 'custom-database')).toMatchObject({ label: 'Database specialist', access: 'edit', custom: true });
    expect(resolveRole(team, 'frontend')).toMatchObject({ label: 'Frontend specialist', access: 'edit', custom: false });
    // A role deleted after a plan was drafted must not be able to change files.
    expect(resolveRole(team, 'custom-gone')).toMatchObject({ access: 'read', custom: true });
    expect(resolveRole(undefined, 'toString')).toMatchObject({ access: 'read', custom: true });
    expect(roleConfigFor(team, 'custom-database')).toMatchObject({ assignee: 'codex', route: 'direct', instructions: 'Never drop a column without a migration.' });
    expect(roleConfigFor(team, 'custom-gone')).toMatchObject({ assignee: 'auto' });
    expect(stepAccess({ role: 'custom-x', access: 'edit' })).toBe('edit');
    expect(stepAccess({ role: 'backend' })).toBe('edit');
    expect(stepAccess({ role: 'codeReviewer' })).toBe('read');
    expect(stepAccess({ role: 'custom-x' })).toBeUndefined();
  });

  it('are offered to the orchestrator, and a plan may only use roles the team has', () => {
    const team = withCustom(DATABASE);
    const prompt = buildOrchestratorPrompt('Add orders', team);
    expect(prompt).toContain('"custom-database": Database specialist (edits files). Schemas, queries and migrations.');
    expect(buildOrchestratorPrompt('Add orders')).not.toContain('custom-');

    const reply = (role: string) => JSON.stringify({ parts: [{ id: 'db', title: 'Orders table', role, prompt: 'Create it', dependsOn: [], paths: ['db/'] }] });
    expect(parseTeamPlan(reply('custom-database'), team)).toMatchObject({ ok: true, plan: { parts: [{ role: 'custom-database' }] } });
    const rejected = parseTeamPlan(reply('custom-database'), createDefaultAgentTeam());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('not one of the team');
    expect(parseTeamPlan(reply('wizard'), team).ok).toBe(false);
  });

  it('are assigned with no built-in favourite, pinned when the user chose, and reviewed like built-ins', () => {
    const team = withCustom(DATABASE, AUDITOR);
    const parts = [part('db', 'custom-database'), part('ui', 'frontend'), part('audit', 'custom-a11y')];
    const result = assignTeam(parts, team, environment());

    expect(agentFor(result, 'db')).toBe('codex');
    expect(result.assignments.find((item) => item.partId === 'db')!.reason).toContain('You chose Codex for Database specialist.');
    // A read-only custom role is an independent reviewer: it avoids agents that wrote code.
    const authors = new Set([agentFor(result, 'db'), agentFor(result, 'ui')]);
    expect(authors.has(agentFor(result, 'audit'))).toBe(false);
    expect(result.assignments.find((item) => item.partId === 'audit')!.reason).toContain('did not write the code it reviews');

    // On Auto, no agent gets the built-in strengths: the result is the same on every preset ordering.
    const auto = assignTeam([part('db', 'custom-database')], withCustom({ ...DATABASE, assignee: 'auto' }), environment());
    expect(['claude', 'codex', 'gemini', 'qwen', 'kimi', 'api']).toContain(agentFor(auto, 'db'));
  });

  it('get prompts in their own words, with the read-only rule when they only read', () => {
    const team = withCustom(DATABASE, AUDITOR);
    const edit = buildStepPrompt('Add orders', part('db', 'custom-database'), roleConfigFor(team, 'custom-database'), resolveRole(team, 'custom-database'));
    expect(edit).toContain('You are the Database specialist');
    expect(edit).toContain('Never drop a column without a migration.');
    expect(edit).toContain('list the files you changed');

    const read = buildStepPrompt('Add orders', part('audit', 'custom-a11y'), roleConfigFor(team, 'custom-a11y'), resolveRole(team, 'custom-a11y'));
    expect(read).toContain('read-only role');
    expect(read).not.toContain('VERDICT');
  });

  it('can own a failed check when no built-in editing role is left to send it to', () => {
    expect(routeFailure('boom', [{ id: 'db', role: 'custom-database', paths: ['db/'] }])).toEqual({ ownerIds: ['db'], reason: 'fallback' });
    expect(routeFailure('bad sql in db/schema.sql', [{ id: 'db', role: 'custom-database', paths: ['db/'] }])).toEqual({ ownerIds: ['db'], reason: 'paths' });
  });
});

describe('a team for one project', () => {
  it('is saved in the project preferences and validated like the team in Settings', () => {
    const preferences = projectPreferencesV1Schema.parse({ schemaVersion: 1, projectId: 'p1', agentTeam: withCustom(DATABASE) });
    expect(preferences.agentTeam?.custom).toHaveLength(1);
    expect(projectPreferencesV1Schema.parse({ schemaVersion: 1, projectId: 'p1' }).agentTeam).toBeUndefined();
    expect(() => projectPreferencesV1Schema.parse({ schemaVersion: 1, projectId: 'p1', agentTeam: { preset: 'wild', roles: {} } })).toThrow();
  });
});

describe('sending a failed check to its owner', () => {
  const owners = [
    { id: 'ui', role: 'frontend' as const, paths: ['src/ui'] },
    { id: 'api', role: 'backend' as const, paths: ['src/api/', 'db/schema.sql'] },
    { id: 'tests', role: 'tests' as const, paths: ['tests'] },
  ];

  it('finds the files a check names, in any path style, and ignores things that only look like files', () => {
    const output = [
      'FAIL src/api/login.test.ts',
      '  at Object.<anonymous> (C:\\work\\app\\src\\ui\\App.tsx:12:5)',
      '  at ./src/api/login.ts:4',
      'Expected version 1.5 e.g. 2.0 but got null',
      'see db/schema.sql:3',
      'src/api/login.test.ts again',
    ].join('\n');

    const found = failingPaths(output);

    expect(found).toEqual(expect.arrayContaining(['src/api/login.test.ts', 'work/app/src/ui/App.tsx', 'src/api/login.ts', 'db/schema.sql']));
    expect(found).not.toContain('1.5');
    expect(found).not.toContain('2.0');
    expect(found.filter((path) => path === 'src/api/login.test.ts')).toHaveLength(1);
  });

  it('routes to every part that owns a named file, matching folders, files, absolute and Windows paths', () => {
    expect(routeFailure('error at src/api/login.ts:9', owners)).toEqual({ ownerIds: ['api'], reason: 'paths' });
    expect(routeFailure('error at C:\\proj\\src\\ui\\App.tsx', owners)).toEqual({ ownerIds: ['ui'], reason: 'paths' });
    expect(routeFailure('bad sql in db/schema.sql', owners)).toEqual({ ownerIds: ['api'], reason: 'paths' });
    expect(routeFailure('src/ui/A.tsx and src/api/b.ts and tests/c.test.ts', owners).ownerIds).toEqual(['ui', 'api', 'tests']);
    // A folder name inside another path is not a match: "src/apiary" is not "src/api".
    expect(routeFailure('error in src/apiary/x.ts', owners).reason).toBe('fallback');
  });

  it('falls back to backend, then frontend, tests and docs, and to nobody when nothing edits', () => {
    expect(routeFailure('Test suite failed to run', owners)).toEqual({ ownerIds: ['api'], reason: 'fallback' });
    expect(routeFailure('boom', owners.filter((owner) => owner.role !== 'backend'))).toEqual({ ownerIds: ['ui'], reason: 'fallback' });
    expect(routeFailure('boom', [{ id: 'd', role: 'docs' as const, paths: [] }])).toEqual({ ownerIds: ['d'], reason: 'fallback' });
    expect(routeFailure('boom', [])).toEqual({ ownerIds: [], reason: 'fallback' });
  });

  it('writes a fix instruction with the round, the check, what it printed and the original task', () => {
    const prompt = buildFixPrompt('Build the API', 'npm test', 2, 'x'.repeat(5_000) + 'THE END');

    expect(prompt).toContain('FIX ROUND 2');
    expect(prompt).toContain('"npm test"');
    expect(prompt).toContain('[earlier output left out]');
    expect(prompt).toContain('THE END');
    expect(prompt).not.toContain('x'.repeat(4_100));
    expect(prompt.endsWith('Build the API')).toBe(true);
    expect(buildFixPrompt('T', 'c', 1, '  ')).toContain('(no output)');
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

  it('plans from the Prompt Guide prompts without calling the orchestrator', async () => {
    const { planner: service, requests } = planner([]);
    const draft = await service.planFromParts({
      projectId: 'p1',
      goal: 'Add a login page',
      parts: [
        { id: 'ui', title: 'Login form', role: 'frontend', prompt: 'Build the form', dependsOn: [], paths: [] },
        { id: 'tests', title: 'Tests', role: 'tests', prompt: 'Test the form', dependsOn: ['ui'], paths: [] },
      ],
    });
    expect(requests).toHaveLength(0);
    expect(draft.source).toBe('prompt-guide');
    // The usual safeguards still apply: a code review is added and every part has an agent and a level.
    expect(draft.parts.map((item) => item.role)).toEqual(['frontend', 'tests', 'securityReviewer', 'codeReviewer']);
    expect(draft.assignments).toHaveLength(4);
    expect(draft.parts.every((item) => item.effort)).toBe(true);
  });

  it('refuses guide prompts that do not hold together', async () => {
    const { planner: service } = planner([]);
    await expect(service.planFromParts({
      projectId: 'p1',
      goal: 'Loop',
      parts: [{ id: 'a', title: 'A', role: 'backend', prompt: 'x', dependsOn: ['a'], paths: [] }],
    })).rejects.toThrow(/cannot become a plan/);
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

  it('hands the check and each part\'s owned paths to the workflow', async () => {
    const { planner: service, started } = planner([reply]);
    const draft = await service.plan({ projectId: 'p1', goal: 'Make the header blue' }, 7);
    await service.start({ projectId: 'p1', goal: draft.goal, parts: draft.parts, assignments: draft.assignments, autonomy: 'autoEdit', checkCommand: '  npm test  ', maxRounds: 3 }, 7);
    await service.start({ projectId: 'p1', goal: draft.goal, parts: draft.parts, assignments: draft.assignments, autonomy: 'autoEdit', checkCommand: '   ', maxRounds: 3 }, 7);

    expect(started[0]!.teamCheck).toEqual({ command: 'npm test', maxRounds: 3 });
    expect(started[0]!.steps.find((step) => step.id === 'ui')!.paths).toEqual(['src/ui']);
    expect(started[0]!.steps.find((step) => step.id === 'code-review')!.paths).toBeUndefined();
    // A blank check means no check at all.
    expect(started[1]!.teamCheck).toBeUndefined();
  });

  const customReply = JSON.stringify({
    summary: 'Orders',
    parts: [
      { id: 'db', title: 'Orders table', role: 'custom-database', prompt: 'Create the table', dependsOn: [], paths: ['db/'] },
      { id: 'audit', title: 'Keyboard use', role: 'custom-a11y', prompt: 'Check the form', dependsOn: ['db'], paths: [] },
    ],
  });

  it('plans and runs with the team saved for the project, including its custom roles', async () => {
    const team = withCustom(DATABASE, AUDITOR);
    const { planner: service, started } = planner([customReply], { projectTeam: async (projectId) => (projectId === 'p1' ? team : null) });
    const draft = await service.plan({ projectId: 'p1', goal: 'Make the orders page faster' }, 7);

    expect(draft.teamScope).toBe('project');
    expect(draft.parts.map((item) => item.role)).toContain('custom-database');
    await service.start({ projectId: 'p1', goal: draft.goal, parts: draft.parts, assignments: draft.assignments, autonomy: 'autoEdit' }, 7);

    const steps = Object.fromEntries(started[0]!.steps.map((step) => [step.id, step]));
    expect(steps.db).toMatchObject({ role: 'custom-database', access: 'edit', autonomy: 'autoEdit', label: 'Database specialist: Orders table', agent: 'codex', paths: ['db/'] });
    expect(steps.db!.prompt).toContain('Never drop a column without a migration.');
    // A custom role that only reads runs read-only, whatever the editing autonomy is.
    expect(steps.audit).toMatchObject({ role: 'custom-a11y', access: 'read', autonomy: 'plan' });
  });

  it('does not let a project\'s custom role leak into another project, or into the team from Settings', async () => {
    const team = withCustom(DATABASE, AUDITOR);
    const { planner: service } = planner([customReply, customReply], { projectTeam: async (projectId) => (projectId === 'p1' ? team : null) });
    await expect(service.plan({ projectId: 'other', goal: 'Anything' }, 7)).rejects.toThrow(/not one of the team/);
  });

  it('uses the team from Settings when a project has none', async () => {
    const { planner: service } = planner([reply], { projectTeam: async () => null });
    expect((await service.plan({ projectId: 'p1', goal: 'Make the header blue' }, 7)).teamScope).toBe('settings');
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
