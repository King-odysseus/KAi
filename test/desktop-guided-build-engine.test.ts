import { describe, expect, it } from 'vitest';
import {
  defaultLocalBuilder,
  briefFromLaunchPrompt,
  builderStuckReason,
  planFromBriefPrompt,
  describeRole,
  localBuilderStepPrompt,
  diffText,
  evidenceText,
  gateReview,
  guidedTitle,
  guidedTurnIndexes,
  isGuidedLabel,
  isReadOnlyStep,
  planLocation,
  readGuidedPlan,
  readGuidedReview,
  reviewPrompt,
} from '../apps/desktop/src/renderer/src/components/guided-build-engine';

describe('planLocation', () => {
  it('keeps one clean path as it is', () => {
    expect(planLocation('src/main/store.js')).toEqual({ where: 'src/main/store.js', related: [] });
    expect(planLocation('src/App.tsx:42')).toEqual({ where: 'src/App.tsx:42', related: [] });
  });

  it('splits two file names glued together, as in the Zuri plan', () => {
    expect(planLocation('README.mdpackage.json')).toEqual({ where: 'README.md', related: ['package.json'] });
  });

  it('opens the first file of a list and keeps the rest as related files', () => {
    expect(planLocation('src/a.ts, src/b.ts and test/a.test.ts')).toEqual({ where: 'src/a.ts', related: ['src/b.ts', 'test/a.test.ts'] });
  });

  it('does not cut a .jsx or .json name in the middle', () => {
    expect(planLocation('web/src/App.jsx')).toEqual({ where: 'web/src/App.jsx', related: [] });
    expect(planLocation('package.json')).toEqual({ where: 'package.json', related: [] });
  });

  it('turns "around line 42" into a line', () => {
    expect(planLocation('src/App.tsx, around line 42').where).toBe('src/App.tsx:42');
  });

  it('leaves text with no file in it alone', () => {
    expect(planLocation('the settings screen')).toEqual({ where: 'the settings screen', related: [] });
  });
});

describe('isReadOnlyStep', () => {
  it('flags a step that only reads', () => {
    expect(isReadOnlyStep({ title: 'Start with the product map', instructions: 'Read the README and note the apps.' })).toBe(true);
    expect(isReadOnlyStep({ title: 'Understand the Zuri app', instructions: 'Look through package.json.' })).toBe(true);
  });

  it('keeps a step that changes something, even with a reading word in the title', () => {
    expect(isReadOnlyStep({ title: 'Read the theme from the store', instructions: 'Add a getTheme function to store.js.' })).toBe(false);
    expect(isReadOnlyStep({ title: 'Add the toggle', instructions: 'Add a switch.' })).toBe(false);
  });

  it('keeps a step that carries code to type', () => {
    expect(isReadOnlyStep({ title: 'Review the handler', instructions: 'See below.', code: 'const x = 1;' })).toBe(false);
  });
});

describe('readGuidedPlan', () => {
  const plan = JSON.stringify({
    title: 'Dark mode',
    steps: [
      { id: 'a', title: 'Start with the product map', why: 'Know the app.', where: 'README.mdpackage.json', instructions: 'Read the README.', acceptanceCriteria: ['You can explain it'] },
      { id: 'b', title: 'Save a theme choice', why: 'It must persist.', where: 'src/main/store.js', instructions: 'Add a theme field.', acceptanceCriteria: ['npm test passes'] },
      { title: 'Add the toggle', where: ['web/src/Settings.jsx', 'web/src/theme.css'], instructions: 'Add a switch.', acceptanceCriteria: [] },
    ],
  });

  it('drops the reading step, activates the first real one and names what it dropped', () => {
    const read = readGuidedPlan(`Here is the plan.\n${plan}`)!;
    expect(read.title).toBe('Dark mode');
    expect(read.steps.map((step) => step.title)).toEqual(['Save a theme choice', 'Add the toggle']);
    expect(read.steps.map((step) => step.status)).toEqual(['active', 'pending']);
    expect(read.droppedReadOnly).toEqual(['Start with the product map']);
  });

  it('puts the extra files of a step in its instructions and keeps one file in where', () => {
    const toggle = readGuidedPlan(plan)!.steps[1]!;
    expect(toggle.where).toBe('web/src/Settings.jsx');
    expect(toggle.instructions).toContain('Related files: web/src/theme.css.');
  });

  it('gives a step with no id one', () => {
    expect(readGuidedPlan(plan)!.steps[1]!.id).toBe('step-3');
  });

  it('keeps a plan made only of reading steps rather than returning nothing', () => {
    const onlyReading = JSON.stringify({ title: 'Tour', steps: [{ title: 'Explore the code', where: 'README.md', instructions: 'Read it.', acceptanceCriteria: [] }] });
    const read = readGuidedPlan(onlyReading)!;
    expect(read.steps).toHaveLength(1);
    expect(read.droppedReadOnly).toEqual([]);
  });

  it('returns null for a reply that is not a plan', () => {
    expect(readGuidedPlan('Sure, what would you like to build?')).toBeNull();
  });
});

describe('readGuidedReview', () => {
  it('reads a review and refuses an unknown status', () => {
    expect(readGuidedReview('{"status":"ready","summary":"Meets every check."}')).toEqual({ status: 'ready', summary: 'Meets every check.' });
    expect(readGuidedReview('{"status":"great","summary":"x"}')).toBeNull();
    expect(readGuidedReview('Looks good to me.')).toBeNull();
  });
});

describe('chat labels and titles', () => {
  it('knows its own requests', () => {
    expect(isGuidedLabel('Coach: add a dark mode')).toBe(true);
    expect(isGuidedLabel('Builder: implement this step')).toBe(true);
    expect(isGuidedLabel('fix the login bug')).toBe(false);
  });

  it('keeps only guided exchanges, with their replies', () => {
    const turns = [
      { role: 'user', text: 'fix the login bug' },
      { role: 'assistant', text: 'Done.' },
      { role: 'user', text: 'Coach: make a plan' },
      { role: 'assistant', text: 'Plan.' },
      { role: 'user', text: 'Builder: implement this step' },
      { role: 'assistant', text: 'Built.' },
    ];
    expect([...guidedTurnIndexes(turns)]).toEqual([2, 3, 4, 5]);
  });

  it('names a conversation from what the person typed, not from the wrapped prompt', () => {
    expect(guidedTitle('Coach: Add a dark-mode toggle', 'Create a coding plan for this request: Add a dark-mode toggle ...')).toBe('Add a dark-mode toggle');
    expect(guidedTitle(undefined, '  Fix   the login  ')).toBe('Fix the login');
  });
});

describe('reviewPrompt', () => {
  it('says which files changed and carries any evidence KAI collected', () => {
    const step = { id: 's', title: 'Save a theme', why: 'It persists.', where: 'src/store.js', instructions: 'Add a field.', acceptanceCriteria: ['npm test passes'], status: 'active' as const };
    const text = reviewPrompt(step, ['src/store.js', 'src/store.js'], 'KAI ran npm test: 214 passed');
    expect(text).toContain('Recent changed files: src/store.js.');
    expect(text).toContain('KAI ran npm test: 214 passed');
  });
});

describe('defaultLocalBuilder', () => {
  const direct = (provider: string, model = '') => ({ enabled: true, provider, model, baseUrl: 'http://192.168.1.20:8080/v1', credentialId: 'provider.local' }) as never;

  it('uses the direct API server when it runs on this network', () => {
    expect(defaultLocalBuilder({ directApi: direct('lmstudio', 'gateway/coding'), savedLocalModels: {} })).toEqual({
      execution: 'api',
      api: { provider: 'lmstudio', baseUrl: 'http://192.168.1.20:8080/v1', credentialId: 'provider.local', model: 'gateway/coding' },
    });
  });

  it('falls back to the first local server with a remembered model', () => {
    expect(defaultLocalBuilder({ directApi: direct('openai'), savedLocalModels: { ollama: ['qwen3-coder'] } })).toEqual({
      execution: 'api',
      api: { provider: 'ollama', model: 'qwen3-coder' },
    });
  });

  it('returns null when nothing local is set up, so the Builder keeps the agent in use', () => {
    expect(defaultLocalBuilder({ directApi: direct('openai'), savedLocalModels: {} })).toBeNull();
  });
});

describe('describeRole', () => {
  it('names a CLI agent with its model', () => {
    expect(describeRole({ execution: 'cli', agent: 'claude', model: 'opus' }, { claude: 'Claude' })).toEqual({ label: 'Claude · opus', local: false });
  });

  it('says a local server runs on this computer', () => {
    const described = describeRole({ execution: 'api', api: { provider: 'ollama', model: 'qwen3-coder' } });
    expect(described.local).toBe(true);
    expect(described.label).toBe('qwen3-coder (on this computer)');
  });

  it('marks a paid API as not local', () => {
    expect(describeRole({ execution: 'api', api: { provider: 'openai', model: 'gpt-x' } }).local).toBe(false);
  });

  it('says so when no role is set', () => {
    expect(describeRole(null)).toEqual({ label: 'the agent in use', local: false });
  });
});

describe('evidence and the check gate', () => {
  const passed = { command: 'npm test', passed: true, exitCode: 0, testsPassed: 214, testsFailed: 0, outputTail: 'Tests 214 passed' };
  const failed = { ...passed, passed: false, exitCode: 1, testsPassed: 200, testsFailed: 14, outputTail: 'FAIL store.test.ts' };

  it('states a passing run with its counts', () => {
    const text = evidenceText(passed);
    expect(text).toContain('`npm test`');
    expect(text).toContain('PASSED');
    expect(text).toContain('214 passed, 0 failed');
  });

  it('states a failing run and its exit code', () => {
    expect(evidenceText(failed)).toContain('FAILED (exit 1)');
  });

  it('says when no check ran, so the Coach cannot imply one', () => {
    const text = evidenceText(null, 'no test command found');
    expect(text).toContain('did not run a project check');
    expect(text).toContain('no test command found');
  });

  it('turns ready into changes-needed when the check KAI ran failed', () => {
    const gated = gateReview({ status: 'ready', summary: 'Looks right.' }, failed);
    expect(gated.status).toBe('changes-needed');
    expect(gated.summary).toContain('failed');
    expect(gated.summary).toContain('Looks right.');
  });

  it('leaves a passing review, a non-ready review and a missing check alone', () => {
    expect(gateReview({ status: 'ready', summary: 'ok' }, passed).status).toBe('ready');
    expect(gateReview({ status: 'changes-needed', summary: 'no' }, failed).status).toBe('changes-needed');
    expect(gateReview({ status: 'ready', summary: 'ok' }, null).status).toBe('ready');
  });
});

describe('diffText', () => {
  it('shows each changed file with its diff', () => {
    const text = diffText([{ path: 'src/a.ts', diff: '+one' }, { path: 'src/b.ts', diff: '-two' }]);
    expect(text).toContain('2 files changed.');
    expect(text).toContain('--- src/a.ts\n+one');
    expect(text).toContain('--- src/b.ts\n-two');
  });

  it('names a file with no diff instead of dropping it', () => {
    expect(diffText([{ path: 'logo.png', diff: '' }])).toContain('--- logo.png (no text diff');
  });

  it('gives every file an equal share and says it cut', () => {
    const big = 'x'.repeat(5_000);
    const text = diffText([{ path: 'big.ts', diff: big }, { path: 'small.ts', diff: '+kept' }], 1_000);
    expect(text).toContain('--- small.ts\n+kept');
    expect(text).toContain('left out');
    expect(text.length).toBeLessThan(2_000);
  });

  it('says so when there are no files', () => {
    expect(diffText([])).toContain('No changed files');
  });
});

describe('local Builder', () => {
  const step = { id: 's', title: 'Save a theme', why: 'It persists.', where: 'src/store.js', instructions: 'Add a field.', acceptanceCriteria: ['npm test passes'], status: 'active' as const };

  it('tells a small model how to say it is stuck', () => {
    const text = localBuilderStepPrompt(step);
    expect(text).toContain('Implement only this Guided Build step.');
    expect(text).toContain('<<KAI_STUCK>>');
  });

  it('reads why the Builder gave up', () => {
    expect(builderStuckReason('I tried.\n<<KAI_STUCK>> The store file is generated, so I cannot edit it.\n')).toBe('The store file is generated, so I cannot edit it.');
  });

  it('returns null when the Builder did not ask for help', () => {
    expect(builderStuckReason('Done. Added the field.')).toBeNull();
  });

  it('gives a reason even when none was written', () => {
    expect(builderStuckReason('<<KAI_STUCK>>')).toBe('it did not say why');
  });
});

describe('Guided Build record', () => {
  it('opens a conversation saved before the dial and the lock existed, with the defaults', async () => {
    const { guidedBuildSchema } = await import('@kai/contracts');
    const old = { enabled: true, planTitle: 'Dark mode', steps: [], currentStep: 0 };
    const parsed = guidedBuildSchema.parse(old);
    expect(parsed.handsOn).toBe('guided');
    expect(parsed.builderLock).toBe('escalate');
    expect(parsed.planTitle).toBe('Dark mode');
  });

  it('keeps a chosen dial and lock', async () => {
    const { guidedBuildSchema } = await import('@kai/contracts');
    const parsed = guidedBuildSchema.parse({ handsOn: 'auto', builderLock: 'pinned' });
    expect(parsed.handsOn).toBe('auto');
    expect(parsed.builderLock).toBe('pinned');
  });

  it('refuses an unknown dial value', async () => {
    const { guidedBuildSchema } = await import('@kai/contracts');
    expect(() => guidedBuildSchema.parse({ handsOn: 'turbo' })).toThrow();
  });
});

describe('plans from a Studio brief', () => {
  it('strips the line Studio puts in front of the brief', () => {
    const launch = 'Use this Project Studio brief as the source of truth. Start by confirming the smallest implementation plan, then build it.\n\n# Kuza\n\nInvoices by link.';
    expect(briefFromLaunchPrompt(launch)).toBe('# Kuza\n\nInvoices by link.');
  });

  it('leaves a prompt that has no such line alone', () => {
    expect(briefFromLaunchPrompt('Build this project from the Project Studio plan.\n\nA thing')).toContain('A thing');
  });

  it('tells the Coach to honour decisions and to flag high-risk assumptions', () => {
    const text = planFromBriefPrompt('# Kuza', 'tutor', 'step-by-step', 'blocked');
    expect(text).toContain('# Kuza');
    expect(text).toContain('chosen by the person');
    expect(text).toContain('needsApproval');
    expect(text).toContain('high risk');
  });

  it('carries needsApproval onto a step and drops an empty one', () => {
    const plan = JSON.stringify({ title: 'T', steps: [
      { title: 'Mark an invoice paid by hand', where: 'web/src/InvoiceRow.jsx', instructions: 'Add a button.', acceptanceCriteria: [], needsApproval: 'Payments are not handled by Kuza.' },
      { title: 'Add the route', where: 'server/routes/invoices.js', instructions: 'Add a route.', acceptanceCriteria: [], needsApproval: '  ' },
    ] });
    const read = readGuidedPlan(plan)!;
    expect(read.steps[0]!.needsApproval).toBe('Payments are not handled by Kuza.');
    expect(read.steps[1]!.needsApproval).toBeUndefined();
  });
});

describe('learnPrompt', () => {
  const step = { title: 'Save a theme', where: 'src/store.js', instructions: 'Add a field.' };

  it('asks for exactly one question when quizzing, and never edits', async () => {
    const { learnPrompt } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    const text = learnPrompt('quiz', step, 'tutor', 'step-by-step');
    expect(text).toContain('exactly one short question');
    expect(text).toContain('Do not edit files.');
    expect(text).toContain('src/store.js');
  });

  it('walks through a step and explains simply', async () => {
    const { learnPrompt } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(learnPrompt('walk', step, 'tutor', 'line-by-line')).toContain('Walk me through this step');
    expect(learnPrompt('simpler', undefined, 'senior-dev', 'brief')).toContain('simpler words');
  });
});

describe('guidedUsage', () => {
  it('counts only what was actually sent', async () => {
    const { guidedUsage } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    const turns = [
      { role: 'user', text: 'Coach: create my plan' },
      { role: 'assistant', text: 'Plan.' },
      { role: 'user', text: 'Builder: implement this step' },
      { role: 'assistant', text: 'Built.' },
      { role: 'user', text: 'Coach: check my changes' },
      { role: 'user', text: 'Builder: implement this step (retry with Claude · opus)' },
      { role: 'user', text: 'Builder: implement this step (with Codex)' },
      { role: 'user', text: 'fix the login bug' },
    ];
    expect(guidedUsage(turns)).toEqual({ coachAsks: 2, builderRuns: 3, strongerRuns: 2 });
  });

  it('is zero for an empty conversation', async () => {
    const { guidedUsage } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(guidedUsage([])).toEqual({ coachAsks: 0, builderRuns: 0, strongerRuns: 0 });
  });
});

describe('describeModelCheck', () => {
  const live = (patch: Record<string, unknown> = {}) => ({ models: ['qwen3-coder', 'llama3'], source: 'live' as const, error: null, ...patch });

  it('reports a server that did not answer', async () => {
    const { describeModelCheck } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(describeModelCheck(live({ error: 'connect ECONNREFUSED' }), 'qwen3-coder')).toMatchObject({ tone: 'error', text: expect.stringContaining('ECONNREFUSED') });
    expect(describeModelCheck(live({ source: 'preset' }), 'qwen3-coder').tone).toBe('warning');
  });

  it('reports a model the server does not list', async () => {
    const { describeModelCheck } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(describeModelCheck(live(), 'missing-model')).toMatchObject({ tone: 'error', text: expect.stringContaining('does not list') });
  });

  it('warns about a small window and passes a large one', async () => {
    const { describeModelCheck } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(describeModelCheck(live({ contextLengths: { 'qwen3-coder': 8_192 } }), 'qwen3-coder').tone).toBe('warning');
    expect(describeModelCheck(live({ contextLengths: { 'qwen3-coder': 32_768 } }), 'qwen3-coder')).toMatchObject({ tone: 'success', text: expect.stringContaining('32,768') });
  });

  it('is honest when the server does not say how large the window is, or no model is chosen', async () => {
    const { describeModelCheck } = await import('../apps/desktop/src/renderer/src/components/guided-build-engine');
    expect(describeModelCheck(live(), 'qwen3-coder').text).toContain('did not say');
    expect(describeModelCheck(live(), '').tone).toBe('warning');
  });
});
