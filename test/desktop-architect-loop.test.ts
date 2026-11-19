import { describe, expect, it, vi } from 'vitest';
import {
  ARCHITECT_BRIEF_SENTINEL,
  ARCHITECT_REPORT_SENTINEL,
  ARCHITECT_STUCK_SENTINEL,
  ARCHITECT_VERDICT_SENTINEL,
  architectRunInputSchema,
  architectSplitActive,
  autoStartInputSchema,
  isPlanningGradeModel,
  isSafeCheckCommand,
  isPlanningGradeTarget,
  roleTargetKey,
  roleTargetSchema,
  isLocalProvider,
  directProviderPreset,
  type AgentRunRequest,
  type AgentRunResult,
  type ArchitectSplit,
  type ArchitectStatus,
  type AutoStatus,
  type ConversationRecord,
  type RoleTarget,
} from '@kai/contracts';
import {
  ArchitectCoach,
  ArchitectLoop,
  extractJsonAfter,
  parseBrief,
  parseVerdict,
  repeatsItself,
  implementerAutonomy,
  limitKey,
  failedOnLimit,
  parseReport,
  changedPaths,
  crossCheckReport,
  sameStuckReason,
  stuckReason,
  namedStuckCause,
  REVISIONS_BEFORE_STEP_IN,
  ROUNDS_BEFORE_ASKING,
  LOCAL_BUILDER_ROUNDS,
  isSmallBuilder,
  planPrompt,
  stepPrompt,
  type ArchitectLoopPorts,
  type ComposerRecord,
} from '../apps/desktop/src/main/architect-loop';
import { DesktopAutoSession, withImplementer, type AutoSessionPorts, type AutoWindowPort } from '../apps/desktop/src/main/auto-session';
import { resolveApiConnection } from '../apps/desktop/src/main/api-connection';
import { RepeatWatch, onRepeatDetected, withRepeatNotice } from '../apps/desktop/src/main/repeat-watch';

const BRIEF = { goal: 'Add the parser', files: ['src/parser.ts'], avoid: ['src/legacy.ts'], doneChecks: ['parser.test.ts passes'] };
const brief = (goal = BRIEF.goal): string => `Here is the plan.\n${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, goal })}`;
const verdict = (kind: 'approve' | 'revise' | 'replan', extra: Record<string, unknown> = {}): string =>
  `Reviewed.\n${ARCHITECT_VERDICT_SENTINEL} ${JSON.stringify({ verdict: kind, summary: `${kind} it`, corrections: kind === 'revise' ? ['Fix the off-by-one in parse()'] : [], ...extra })}`;

const CLAUDE: RoleTarget = { execution: 'cli', agent: 'claude', model: 'opus' };
const CODEX: RoleTarget = { execution: 'cli', agent: 'codex' };
const KIMI_API: RoleTarget = { execution: 'api', api: { provider: 'moonshot', credentialId: 'provider.kimi-work', model: 'kimi-k3' } };
const LOCAL: RoleTarget = { execution: 'api', api: { provider: 'ollama', model: 'qwen2.5-coder' } };

function split(overrides: Partial<ArchitectSplit> = {}): ArchitectSplit {
  return { enabled: true, architect: CLAUDE, implementer: CODEX, fallback: null, ...overrides };
}

interface Script {
  /** What the Architect says to the Nth review (1-based). The last entry repeats. */
  verdicts?: string[];
  /** What the Implementer prints on the Nth build turn. The last entry repeats. */
  built?: string[];
  /** Targets that cannot run, by key. */
  down?: RoleTarget[];
  planOutput?: string;
  /** What running the brief's check command gives, per call (last repeats). Without it the port is absent. */
  checks?: Array<{ passed: boolean; exitCode?: number | null; output?: string }>;
  /** What each role's runs cost, in USD. */
  architectCost?: number;
  implementerCost?: number;
  /** The working tree never changes, whatever the Implementer does. */
  unchanged?: boolean;
  /** The review material never changes, but the content fingerprint does (an edit the diff text cannot show). */
  fingerprintChanges?: boolean;
  /** The first build turn fails once. */
  failFirstBuild?: boolean;
  /** The first build turn does not end until it is cancelled. */
  hangFirstBuild?: boolean;
  /** The project's own test command, offered when the brief names none. */
  suggested?: string;
  /** Agents whose subscription has hit its usage limit: every run on them fails with that message. */
  limitAgents?: string[];
}

function scripted(script: Script = {}) {
  const requests: AgentRunRequest[] = [];
  const architectPrompts: string[] = [];
  const buildPrompts: string[] = [];
  const announced: ArchitectStatus[] = [];
  let reviews = 0;
  let builds = 0;
  let release: (() => void) | null = null;
  const checkCalls: string[] = [];
  const restored: Array<{ conversationId: string; composer: ComposerRecord }> = [];
  const down = new Set((script.down ?? []).map(roleTargetKey));
  const pick = <T,>(list: T[] | undefined, n: number, fallback: T): T => (list && list.length ? list[Math.min(n, list.length) - 1]! : fallback);

  const ports: ArchitectLoopPorts = {
    runAgent: async (request): Promise<AgentRunResult> => {
      requests.push(request);
      if (script.limitAgents?.includes(request.agent as string) && request.execution !== 'api') {
        return { conversation: {} as never, status: 'failed', error: 'You have hit your usage limit. It resets at 3pm.', output: '', costUsd: 0 };
      }
      if (request.freshSession) {
        architectPrompts.push(request.prompt);
        if (request.prompt.includes('reviewing the Implementer')) {
          reviews += 1;
          return { conversation: {} as never, status: 'completed', output: pick(script.verdicts, reviews, verdict('approve')), costUsd: script.architectCost ?? 0 };
        }
        if (request.prompt.includes('the Implementer is stuck')) return { conversation: {} as never, status: 'completed', output: brief('A better plan'), costUsd: script.architectCost ?? 0 };
        return { conversation: {} as never, status: 'completed', output: script.planOutput ?? brief(), costUsd: script.architectCost ?? 0 };
      }
      builds += 1;
      buildPrompts.push(request.prompt);
      if (script.failFirstBuild && builds === 1) return { conversation: {} as never, status: 'failed', error: 'connection dropped', output: '', costUsd: 0 };
      if (script.hangFirstBuild && builds === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        return { conversation: {} as never, status: 'completed', cancelled: true, output: 'half done', costUsd: 0 };
      }
      return { conversation: {} as never, status: 'completed', output: pick(script.built, builds, 'Built it.'), costUsd: script.implementerCost ?? 0 };
    },
    ...(script.checks ? {
      runCheck: async (_projectId: string, command: string) => {
        checkCalls.push(command);
        const next = pick(script.checks, checkCalls.length, { passed: true });
        return { passed: next.passed, exitCode: next.exitCode ?? (next.passed ? 0 : 1), output: next.output ?? '' };
      },
    } : {}),
    restoreComposer: async (conversationId: string, composer: ComposerRecord) => { restored.push({ conversationId, composer }); },
    ready: async (target) => (down.has(roleTargetKey(target)) ? { ready: false, reason: 'signed out' } : { ready: true }),
    reviewMaterial: async () => (script.unchanged ? '--- src/parser.ts\n+ export function parse() {}' : `--- src/parser.ts\n+ export function parse() {} // build ${builds}`),
    cancelAgent: () => { release?.(); return true; },
    ...(script.fingerprintChanges ? { fingerprint: async () => `fp-${builds}` } : {}),
    ...(script.suggested ? { suggestCheck: async () => script.suggested! } : {}),
    announce: (_owner, status) => { announced.push(structuredClone(status)); },
    now: () => Date.now(),
    agentNames: () => ({ claude: 'Claude', codex: 'Codex' }),
  };
  return { ports, requests, architectPrompts, buildPrompts, announced, checkCalls, restored, reviews: () => reviews, builds: () => builds };
}

const input = (s: ArchitectSplit, overrides: Record<string, unknown> = {}) =>
  architectRunInputSchema.parse({
    conversationId: 'conv-1', projectId: 'p1', prompt: 'Add a parser for the config file.', split: s,
    route: 'direct', autonomy: 'full', agent: 'claude', ...overrides,
  });

async function finish(loop: ArchitectLoop, id = 'conv-1'): Promise<ArchitectStatus> {
  await vi.waitFor(() => {
    const status = loop.status(id);
    if (loop.isRunning(id) && status?.phase !== 'waiting-for-you') throw new Error('still running');
  }, { timeout: 4_000 });
  return loop.status(id)!;
}

describe('the split\'s contract', () => {
  it('needs an agent for a CLI role and a connection for an API role', () => {
    expect(roleTargetSchema.safeParse({ execution: 'cli' }).success).toBe(false);
    expect(roleTargetSchema.safeParse({ execution: 'api' }).success).toBe(false);
    expect(roleTargetSchema.safeParse(CLAUDE).success).toBe(true);
    expect(roleTargetSchema.safeParse(KIMI_API).success).toBe(true);
  });

  it('is active only when it is on and both main roles are chosen', () => {
    expect(architectSplitActive(split())).toBe(true);
    expect(architectSplitActive(split({ enabled: false }))).toBe(false);
    expect(architectSplitActive(split({ implementer: null }))).toBe(false);
    expect(architectSplitActive(undefined)).toBe(false);
  });

  it('flags strong models for the Architect without ever blocking a choice', () => {
    for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'gemini-3.8-pro', 'deepseek-v4-pro', 'kimi-k3']) expect(isPlanningGradeModel(model)).toBe(true);
    for (const model of ['claude-haiku-5-5', 'gpt-6-luna', 'gemini-3.8-flash', 'deepseek-flash', 'llama-3.1-8b-instant']) expect(isPlanningGradeModel(model)).toBe(false);
    expect(isPlanningGradeTarget(CLAUDE)).toBe(true);
    expect(isPlanningGradeTarget(LOCAL)).toBe(false);
  });

  it('treats the local servers as local: no key, nothing billed', () => {
    for (const provider of ['lmstudio', 'ollama', 'llamacpp', 'vllm'] as const) {
      expect(isLocalProvider(provider)).toBe(true);
      expect(directProviderPreset(provider).defaultBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    }
    expect(isLocalProvider('anthropic')).toBe(false);
  });
});

describe('reading the Architect\'s answers', () => {
  it('finds the JSON after the exact marker, through nested braces and braces inside strings', () => {
    const text = `prose {not json}\n${ARCHITECT_BRIEF_SENTINEL} {"goal":"use } carefully","files":[],"avoid":[],"doneChecks":["a {b}"]}`;
    expect(parseBrief(text)?.goal).toBe('use } carefully');
    expect(parseBrief('a plan with no marker')).toBeNull();
    expect(extractJsonAfter(`${ARCHITECT_BRIEF_SENTINEL} nope`, ARCHITECT_BRIEF_SENTINEL)).toBeNull();
  });

  it('rejects a brief with no done-checks and a verdict that is not one of the three', () => {
    expect(parseBrief(`${ARCHITECT_BRIEF_SENTINEL} {"goal":"x","doneChecks":[]}`)).toBeNull();
    expect(parseVerdict(`${ARCHITECT_VERDICT_SENTINEL} {"verdict":"maybe","summary":"x"}`)).toBeNull();
    expect(parseVerdict(verdict('revise'))?.corrections).toEqual(['Fix the off-by-one in parse()']);
  });
});

describe('a connection for one role', () => {
  const settings = { enabled: false, provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1', credentialId: 'provider.anthropic' } as const;

  it('uses the saved key for a provider named alone, and the preset for any other provider', () => {
    expect(resolveApiConnection(settings, { provider: 'anthropic' })).toMatchObject({ enabled: true, credentialId: 'provider.anthropic', model: 'claude-sonnet-5-5' });
    expect(resolveApiConnection(settings, { provider: 'moonshot' })).toMatchObject({ enabled: true, provider: 'moonshot', credentialId: 'provider.moonshot', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' });
  });

  it('lets a role carry its own key and model, so two roles can use two accounts of one vendor', () => {
    expect(resolveApiConnection(settings, { provider: 'anthropic', credentialId: 'provider.anthropic-work', model: 'claude-opus-5-5' }))
      .toMatchObject({ credentialId: 'provider.anthropic-work', model: 'claude-opus-5-5' });
  });

  it('is on even when Settings has the direct API off: choosing a connection for a run is the instruction', () => {
    expect(resolveApiConnection(settings, { provider: 'ollama' }).enabled).toBe(true);
  });
});

describe('the Architect / Implementer loop', () => {
  it('plans, builds from the brief, reviews, and finishes on approval', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.round).toBe(1);
    expect(s.buildPrompts[0]).toContain('Add the parser');
    expect(s.buildPrompts[0]).toContain('parser.test.ts passes');
  });

  it('keeps the Architect read-only and the Implementer on the agent that was chosen', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split(), { autonomy: 'full', agent: 'qwen' }), 1);
    await finish(loop);
    const architectRuns = s.requests.filter((request) => request.freshSession);
    const builderRuns = s.requests.filter((request) => !request.freshSession);
    expect(architectRuns.length).toBeGreaterThanOrEqual(2);
    for (const request of architectRuns) {
      expect(request).toMatchObject({ agent: 'claude', model: 'opus', autonomy: 'plan', execution: 'cli' });
      // Marked as the Architect's, so nothing is filed about it, and carrying the person's request, not KAI's prompt.
      expect(request).toMatchObject({ splitRole: 'architect', taskText: 'Add a parser for the config file.' });
    }
    // The composer showed qwen, but the Implementer is codex: the chosen role wins, not the composer's agent.
    for (const request of builderRuns) {
      expect(request).toMatchObject({ agent: 'codex', execution: 'cli', autonomy: 'full', splitRole: 'implementer', taskText: 'Add a parser for the config file.' });
      // What is filed about the build is the request, not "You are the Implementer...".
      expect(request.taskText).not.toContain('You are the Implementer');
    }
  });

  it('runs the Implementer through the API it was given, direct, with its own key and model', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: KIMI_API }), { route: 'proxy' }), 1);
    await finish(loop);
    const builder = s.requests.find((request) => !request.freshSession)!;
    expect(builder).toMatchObject({ execution: 'api', route: 'direct', apiConnection: { provider: 'moonshot', credentialId: 'provider.kimi-work', model: 'kimi-k3' } });
    // Never the Architect's connection and never the Settings one: this request names its own.
    expect(builder.model).toBeUndefined();
  });

  it('can use a local model for either role', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ architect: CLAUDE, implementer: LOCAL })), 1);
    await finish(loop);
    expect(s.requests.find((request) => !request.freshSession)).toMatchObject({ execution: 'api', apiConnection: { provider: 'ollama', model: 'qwen2.5-coder' } });
  });

  it('sends work back with the Architect\'s own corrections, then finishes when it is right', async () => {
    const s = scripted({ verdicts: [verdict('revise'), verdict('approve')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.round).toBe(2);
    expect(s.buildPrompts[1]).toContain('Fix the off-by-one in parse()');
    expect(s.buildPrompts[1]).toContain('parser.test.ts passes');
  });

  it('does not wave through a review it could not read', async () => {
    const s = scripted({ verdicts: ['Looks fine to me, ship it.', verdict('approve')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.round).toBe(2);
    expect(final.log.some((entry) => /could not be read/.test(entry.text))).toBe(true);
  });

  it('steps in with a new brief when the Implementer asks for help', async () => {
    const s = scripted({ built: [`I cannot find the config loader.\n${ARCHITECT_STUCK_SENTINEL} no loader exists`, 'Built it.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.architectPrompts.some((prompt) => prompt.includes('the Implementer is stuck'))).toBe(true);
    // The Implementer continues from the Architect's new brief.
    expect(s.buildPrompts[1]).toContain('A better plan');
  });

  it(`steps in after ${REVISIONS_BEFORE_STEP_IN} reviews in a row that send the work back`, async () => {
    const s = scripted({ verdicts: [verdict('revise'), verdict('revise'), verdict('revise'), verdict('approve')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.architectPrompts.filter((prompt) => prompt.includes('failed review 3 times in a row')).length).toBe(1);
    expect(s.buildPrompts[3]).toContain('A better plan');
  });

  it('takes a replacement brief straight from a replan verdict', async () => {
    const newBrief = { goal: 'Start over with a streaming parser', files: [], avoid: [], doneChecks: ['streams'] };
    const s = scripted({ verdicts: [verdict('replan', { brief: newBrief }), verdict('approve')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await finish(loop);
    expect(s.buildPrompts[1]).toContain('Start over with a streaming parser');
  });

  it('asks Continue or Finish instead of cutting a run off, and finishes when told to', async () => {
    const s = scripted({ verdicts: [verdict('revise')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const waiting = await finish(loop);
    expect(waiting.phase).toBe('waiting-for-you');
    expect(waiting.round).toBeGreaterThanOrEqual(ROUNDS_BEFORE_ASKING);
    loop.answer('conv-1', false);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.message).toMatch(/without the Architect's approval/);
  });

  it('carries on past the question when told to continue', async () => {
    const s = scripted({ verdicts: [verdict('revise')] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const first = await finish(loop);
    const roundAtQuestion = first.round;
    loop.answer('conv-1', true);
    await vi.waitFor(() => expect(loop.status('conv-1')!.round).toBeGreaterThan(roundAtQuestion), { timeout: 4_000 });
    await loop.stop('conv-1');
  });

  it('uses the fallback when the Architect is unavailable, and says so', async () => {
    const s = scripted({ down: [CLAUDE] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ fallback: KIMI_API })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.fallbackUsed).toBe(true);
    expect(final.log.some((entry) => /unavailable.*standing in/.test(entry.text) && /signed out/.test(entry.text))).toBe(true);
    const architectRuns = s.requests.filter((request) => request.freshSession);
    for (const request of architectRuns) expect(request).toMatchObject({ execution: 'api', autonomy: 'plan', apiConnection: { provider: 'moonshot' } });
  });

  it('falls back to the Implementer when no fallback was chosen', async () => {
    const s = scripted({ down: [CLAUDE] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.fallbackUsed).toBe(true);
    expect(s.requests.filter((request) => request.freshSession).every((request) => request.agent === 'codex')).toBe(true);
  });

  it('moves on to the next available model when the Architect and its chosen fallback are both unavailable', async () => {
    const s = scripted({ down: [CLAUDE, KIMI_API] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ fallback: KIMI_API })), 1);
    const final = await finish(loop);
    // The Implementer is the next one in the split that can run, so it plans and reviews instead of the run failing.
    expect(final.phase).toBe('finished');
    expect(final.fallbackUsed).toBe(true);
    expect(s.requests.filter((request) => request.freshSession).every((request) => request.agent === 'codex')).toBe(true);
    expect(final.log.some((entry) => /Claude · opus.*unavailable/.test(entry.text))).toBe(true);
  });

  it('fails before any planning is paid for when the Implementer is unavailable', async () => {
    const s = scripted({ down: [KIMI_API] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: KIMI_API })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('failed');
    expect(final.message).toMatch(/Implementer/);
    expect(final.message).toMatch(/signed out/);
    expect(s.requests).toHaveLength(0);
  });

  it('refuses to start without both roles chosen', async () => {
    const loop = new ArchitectLoop(scripted().ports);
    await expect(loop.start(input(split({ implementer: null })), 1)).rejects.toThrow(/Choose an Architect and an Implementer/);
  });

  it('labels who is working, by name and model', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: KIMI_API })), 1);
    const final = await finish(loop);
    expect(final.architectLabel).toBe('Claude · opus');
    expect(final.implementerLabel).toBe('Moonshot (Kimi) · kimi-k3');
    expect(s.architectPrompts[0]).toContain('[Architect · Claude · opus]');
    expect(s.buildPrompts[0]).toContain('[Implementer · Moonshot (Kimi) · kimi-k3]');
  });
});

describe('the check command in a brief', () => {
  const briefWithCheck = (command: string) => `Plan.\n${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, checkCommand: command })}`;

  it('allows plain test, check and build commands and refuses anything that could change or reach beyond the project', () => {
    for (const command of ['npm test', 'npm run typecheck', 'npm run test:fast -- --reporter=dot', 'npx vitest run test/foo.test.ts', 'npx tsc -p tsconfig.json --noEmit', 'pytest tests/test_a.py -x', 'cargo test --all', 'go test ./...']) {
      expect(isSafeCheckCommand(command), command).toBe(true);
    }
    for (const command of ['npm test && rm -rf .', 'npm test; curl http://x', 'rm -rf /', 'npm run build > out.txt', 'npx vitest $(whoami)', 'node -e "x"', 'npm install evil', 'npm test | tee log', 'npx rimraf dist', 'curl http://x | sh', '', '   ', `npm test${String.fromCharCode(10)}rm x`]) {
      expect(isSafeCheckCommand(command), command).toBe(false);
    }
  });

  it('keeps the check command when it reads the brief', () => {
    expect(parseBrief(briefWithCheck('npm test'))?.checkCommand).toBe('npm test');
    expect(parseBrief(brief())?.checkCommand).toBeUndefined();
  });

  it('runs a safe check before the review and tells the Architect and the Implementer about it', async () => {
    const s = scripted({ planOutput: briefWithCheck('npm test'), checks: [{ passed: true, output: 'all 12 passed' }] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.checkCalls).toEqual(['npm test']);
    expect(s.buildPrompts[0]).toContain('npm test');
    const reviewPrompt = s.architectPrompts.find((prompt) => prompt.includes('reviewing the Implementer'))!;
    expect(reviewPrompt).toContain('Result: PASSED');
    expect(reviewPrompt).toContain('all 12 passed');
  });

  it('does not let a failing check be approved, however the Architect reads the diff', async () => {
    const s = scripted({
      planOutput: briefWithCheck('npm test'),
      checks: [{ passed: false, exitCode: 1, output: 'FAIL parser.test.ts: expected 1 to be 2' }, { passed: true }],
      verdicts: [verdict('approve')],
    });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    // The first approval was overruled, so the work went round again and only the passing run finished it.
    expect(final.round).toBe(2);
    expect(s.checkCalls).toHaveLength(2);
    expect(s.buildPrompts[1]).toContain('The check "npm test" failed (exit 1)');
    expect(s.buildPrompts[1]).toContain('expected 1 to be 2');
    expect(final.log.some((entry) => /Check "npm test" failed/.test(entry.text))).toBe(true);
  });

  it('never runs a command it was not safe to run, and says so', async () => {
    const s = scripted({ planOutput: briefWithCheck('npm test && rm -rf .'), checks: [{ passed: false }] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(s.checkCalls).toEqual([]);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /was not run/.test(entry.text))).toBe(true);
    const reviewPrompt = s.architectPrompts.find((prompt) => prompt.includes('reviewing the Implementer'))!;
    expect(reviewPrompt).toContain('was not run');
    // And the Implementer is not promised a check that will never happen.
    expect(s.buildPrompts[0]).not.toContain('rm -rf');
  });

  it('skips the check when this build cannot run one, without failing the run', async () => {
    const s = scripted({ planOutput: briefWithCheck('npm test') });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /cannot run checks/.test(entry.text))).toBe(true);
  });
});

describe('cost and the composer\'s record', () => {
  it('counts what each role cost and says so when the run ends', async () => {
    const s = scripted({ verdicts: [verdict('revise'), verdict('approve')], architectCost: 0.5, implementerCost: 0.125 });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    // Plan + two reviews for the Architect; two builds for the Implementer.
    expect(final.architectCostUsd).toBeCloseTo(1.5);
    expect(final.implementerCostUsd).toBeCloseTo(0.25);
    expect(final.message).toContain('Architect $1.50, Implementer $0.25');
    expect(final.message).toContain('(what was reported)');
  });

  it('says "not reported" for a CLI that gives no cost, instead of a $0.00 that reads as free', async () => {
    const s = scripted({ architectCost: 0.26 });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    // The Architect planned and then reviewed, so two runs at $0.26.
    expect(final.message).toContain('Architect $0.52, Implementer not reported');
    // An API role that really cost nothing (a model on this computer) is $0.00, not "not reported".
    const local = scripted({ architectCost: 0.26 });
    const loop2 = new ArchitectLoop(local.ports);
    await loop2.start(input(split({ implementer: LOCAL }), { conversationId: 'conv-2' }), 1);
    const done = await finish(loop2, 'conv-2');
    expect(done.message).toContain('Implementer $0.00');
  });

  it('says nothing about cost when nothing was spent', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.message).not.toContain('Cost about');
  });

  it('puts the composer\'s own agent, mode, route and access back when the run ends, not the last role\'s', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split(), { agent: 'gemini', execution: 'cli', route: 'proxy', autonomy: 'autoEdit' }), 1);
    await finish(loop);
    await vi.waitFor(() => expect(s.restored).toHaveLength(1));
    expect(s.restored[0]).toEqual({ conversationId: 'conv-1', composer: { agent: 'gemini', execution: 'cli', route: 'proxy', autonomy: 'autoEdit' } });
  });

  it('restores the composer after a failed run too', async () => {
    const s = scripted({ down: [CODEX] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split(), { agent: 'qwen' }), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('failed');
    await vi.waitFor(() => expect(s.restored).toHaveLength(1));
    expect(s.restored[0]!.composer.agent).toBe('qwen');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

function memoryWindows(): AutoWindowPort {
  const entries = new Map<string, string>();
  return {
    resumeAt: async (agentId) => entries.get(agentId) ?? null,
    set: async (agentId, iso) => { entries.set(agentId, iso); },
    clear: async (agentId) => { entries.delete(agentId); },
  };
}

function autoHarness(script: Script = {}, extra: Partial<AutoSessionPorts> = {}) {
  const s = scripted(script);
  const conversations = new Map<string, ConversationRecord>([['conv-1', { id: 'conv-1', projectId: 'p1', title: 't', turns: [] } as unknown as ConversationRecord]]);
  const announced: AutoStatus[] = [];
  const restored: Array<{ conversationId: string; composer: Record<string, unknown> }> = [];
  const ports: AutoSessionPorts = {
    getConversation: async (id) => conversations.get(id) ?? null,
    saveConversation: async (record) => { conversations.set(record.id, record); return record; },
    createConversation: async (_p, title) => ({ id: 'conv-2', projectId: 'p1', title, turns: [] } as unknown as ConversationRecord),
    runAgent: s.ports.runAgent,
    cancelAgent: () => true,
    runCheck: async () => ({ passed: true, exitCode: 0, output: '' }),
    readPlan: async () => null,
    reviewPlan: async () => null,
    checkCoverage: async () => null,
    changedFilesFor: async () => [],
    suggestCheck: async () => null,
    capability: async () => ({ available: true, name: 'DeepSeek', model: 'deepseek-v4-pro' }),
    setPacer: () => undefined,
    openConversation: () => undefined,
    openNewTab: () => undefined,
    announce: (_o, status) => { announced.push(structuredClone(status)); },
    restoreComposer: async (conversationId, composer) => { restored.push({ conversationId, composer }); },
    now: () => Date.now(),
    ...extra,
  };
  const coach = new ArchitectCoach(s.ports);
  return { s, announced, restored, session: new DesktopAutoSession(ports, memoryWindows(), coach), plain: new DesktopAutoSession(ports, memoryWindows()) };
}

const autoInput = (overrides: Record<string, unknown> = {}) =>
  autoStartInputSchema.parse({
    projectId: 'p1', conversationId: 'conv-1', prompt: 'Add a parser for the config file.',
    agent: 'gemini', route: 'direct', autonomy: 'full', ...overrides,
  });

async function autoSettled(session: DesktopAutoSession): Promise<AutoStatus> {
  await vi.waitFor(() => {
    const status = session.status('conv-1');
    if (session.isRunning('conv-1') && status?.phase !== 'waiting-for-you') throw new Error('still running');
  }, { timeout: 4_000 });
  return session.status('conv-1')!;
}

describe('Auto mode with the split on', () => {
  it('uses the chosen Architect to plan and the chosen Implementer for every working turn, not the composer\'s agent', async () => {
    const h = autoHarness();
    await h.session.start(autoInput({ architect: split() }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    const [first, second] = h.s.requests;
    // Planning goes to the Architect first, read-only and fresh...
    expect(first).toMatchObject({ agent: 'claude', model: 'opus', autonomy: 'plan', freshSession: true });
    // ...and the composer's gemini never works: the Implementer does.
    expect(second).toMatchObject({ agent: 'codex', execution: 'cli', autonomy: 'full' });
    expect(h.s.requests.some((request) => request.agent === 'gemini')).toBe(false);
    expect(h.s.buildPrompts[0]).toContain('parser.test.ts passes');
  });

  it('names the person\'s task on every turn, so the brief and the reminders are not what gets remembered', async () => {
    const h = autoHarness({ verdicts: [verdict('revise'), verdict('approve')] });
    await h.session.start(autoInput({ architect: split() }), 1);
    await autoSettled(h.session);
    const builds = h.s.requests.filter((request) => !request.freshSession);
    expect(builds).toHaveLength(2);
    for (const request of builds) expect(request).toMatchObject({ taskText: 'Add a parser for the config file.', splitRole: 'implementer' });
    // The second build's own prompt is the Architect's correction, which is exactly what must not be filed as the task.
    expect(builds[1]!.prompt).toContain('Fix the off-by-one in parse()');
    expect(builds[1]!.taskText).not.toContain('Fix the off-by-one');
    for (const request of h.s.requests.filter((r) => r.freshSession)) expect(request.splitRole).toBe('architect');
  });

  it('keeps naming the task on a plain Auto run too, where the reminder is KAI\'s wording', async () => {
    const h = autoHarness();
    await h.plain.start(autoInput({ checkCommand: 'npm test' }), 1);
    await autoSettled(h.plain);
    for (const request of h.s.requests) {
      expect(request.taskText).toBe('Add a parser for the config file.');
      expect(request.splitRole).toBeUndefined();
    }
  });

  it('runs the working turns through the Implementer\'s API when that is what was chosen', async () => {
    const h = autoHarness();
    await h.session.start(autoInput({ architect: split({ implementer: KIMI_API }) }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    const builds = h.s.requests.filter((request) => !request.freshSession);
    expect(builds.length).toBeGreaterThan(0);
    for (const request of builds) {
      expect(request).toMatchObject({ execution: 'api', route: 'direct', apiConnection: { provider: 'moonshot', credentialId: 'provider.kimi-work', model: 'kimi-k3' } });
    }
    expect(final.activeProvider).toBe('api');
  });

  it('does not let the task finish until the Architect approves, and sends it back with the fixes', async () => {
    const h = autoHarness({ verdicts: [verdict('revise'), verdict('approve')] });
    await h.session.start(autoInput({ architect: split() }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(final.turnCount).toBe(2);
    expect(h.s.buildPrompts[1]).toContain('Fix the off-by-one in parse()');
  });

  it('has the Architect step in when the Implementer says it is stuck', async () => {
    const h = autoHarness({ built: [`${ARCHITECT_STUCK_SENTINEL} no idea where the loader lives`, 'Built it.'] });
    await h.session.start(autoInput({ architect: split() }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(h.s.architectPrompts.some((prompt) => prompt.includes('the Implementer is stuck'))).toBe(true);
    expect(h.s.buildPrompts[1]).toContain('A better plan');
  });

  it('stands the fallback in for an unavailable Architect and says so in the log', async () => {
    const h = autoHarness({ down: [CLAUDE] });
    await h.session.start(autoInput({ architect: split({ fallback: KIMI_API }) }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /unavailable.*standing in/.test(entry.text))).toBe(true);
    expect(h.s.requests[0]).toMatchObject({ execution: 'api', autonomy: 'plan', apiConnection: { provider: 'moonshot' } });
  });

  it('fails with the agent\'s name when the Implementer is not ready, before anything is planned', async () => {
    const h = autoHarness({ down: [CODEX] });
    await h.session.start(autoInput({ architect: split() }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('failed');
    expect(final.message).toMatch(/Implementer \(Codex\)/);
    expect(h.s.requests).toHaveLength(0);
  });

  it('puts the composer\'s own choices back on the conversation when the run ends', async () => {
    const h = autoHarness();
    await h.session.start(autoInput({ architect: split(), agent: 'gemini', route: 'proxy', autonomy: 'autoEdit' }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    await vi.waitFor(() => expect(h.restored).toHaveLength(1));
    expect(h.restored[0]).toEqual({ conversationId: 'conv-1', composer: { agent: 'gemini', execution: 'cli', route: 'proxy', autonomy: 'autoEdit' } });
  });

  it('runs the brief\'s check before the Architect approves, and sends failing work back', async () => {
    const briefWithCheck = `Plan.${String.fromCharCode(10)}${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, checkCommand: 'npm test' })}`;
    const h = autoHarness({ planOutput: briefWithCheck, checks: [{ passed: false, exitCode: 1, output: 'FAIL: nope' }, { passed: true }], verdicts: [verdict('approve')] });
    await h.session.start(autoInput({ architect: split() }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(h.s.checkCalls.filter((command) => command === 'npm test')).toHaveLength(2);
    expect(h.s.buildPrompts[1]).toContain('The check "npm test" failed');
  });

  it('is exactly the old behaviour with the split off', async () => {
    const h = autoHarness();
    await h.session.start(autoInput({ architect: split({ enabled: false }) }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(h.s.requests).toHaveLength(1);
    expect(h.s.requests[0]).toMatchObject({ agent: 'gemini' });
    expect(h.s.requests[0]!.freshSession).toBeUndefined();
  });

  it('refuses a split it cannot honour instead of quietly running alone', async () => {
    const h = autoHarness();
    await expect(h.plain.start(autoInput({ architect: split() }), 1)).rejects.toThrow(/not available in this build/);
  });

  it('swaps in the Implementer\'s agent, model and execution and keeps the split riding along', () => {
    const swapped = withImplementer(autoInput({ architect: split({ implementer: { execution: 'cli', agent: 'codex', model: 'gpt-6.1-sol' } }), model: 'composer-model' }));
    expect(swapped).toMatchObject({ agent: 'codex', execution: 'cli', model: 'gpt-6.1-sol' });
    expect(swapped.architect?.architect).toEqual(CLAUDE);
    const api = withImplementer(autoInput({ architect: split({ implementer: LOCAL }) }));
    expect(api).toMatchObject({ execution: 'api', route: 'direct', model: 'qwen2.5-coder' });
    const untouched = autoInput({ architect: split({ enabled: false }) });
    expect(withImplementer(untouched)).toBe(untouched);
  });
});

describe('the diff in a review prompt', () => {
  it('is cut to a fair share of each file, keeps the list of every file, and says it was cut', async () => {
    const { trimReviewMaterial, REVIEW_MATERIAL_CHARS } = await import('../apps/desktop/src/main/architect-loop');
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const material = files.map((file) => `--- ${file}\n${'+ line of change\n'.repeat(2_000)}`).join('\n\n');
    expect(material.length).toBeGreaterThan(REVIEW_MATERIAL_CHARS * 5);
    const trimmed = trimReviewMaterial(material);
    expect(trimmed.length).toBeLessThanOrEqual(REVIEW_MATERIAL_CHARS + 600);
    // Every file is still named and still has some of its changes, so one big file cannot push the others out.
    expect(trimmed).toContain('3 files changed: a.ts, b.ts, c.ts');
    for (const file of files) expect(trimmed).toContain(`--- ${file}`);
    expect(trimmed).toContain('left out');
    // A small diff is left exactly as it is.
    expect(trimReviewMaterial('--- a.ts\n+ one line')).toBe('--- a.ts\n+ one line');
  });
});

describe('a run that cannot get anywhere', () => {
  it('builds in Auto-edit when the composer is on Plan, and keeps the Architect read-only', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split(), { autonomy: 'plan' }), 1);
    await finish(loop);
    const builds = s.requests.filter((request) => !request.freshSession);
    const architects = s.requests.filter((request) => request.freshSession);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.every((request) => request.autonomy === 'autoEdit')).toBe(true);
    expect(architects.every((request) => request.autonomy === 'plan')).toBe(true);
  });

  it('gives every Implementer edit access, however the composer is set, except Full which stays Full', async () => {
    expect(implementerAutonomy('plan')).toBe('autoEdit');
    expect(implementerAutonomy('ask')).toBe('autoEdit');
    expect(implementerAutonomy('custom')).toBe('autoEdit');
    expect(implementerAutonomy('autoEdit')).toBe('autoEdit');
    expect(implementerAutonomy('full')).toBe('full');
    for (const [name, implementer] of [['a CLI', CODEX], ['an API', KIMI_API]] as const) {
      const s = scripted();
      const loop = new ArchitectLoop(s.ports);
      await loop.start(input(split({ implementer }), { autonomy: 'ask' }), 1);
      await finish(loop);
      const builds = s.requests.filter((request) => !request.freshSession);
      expect(builds.length, name).toBeGreaterThan(0);
      expect(builds.every((request) => request.autonomy === 'autoEdit'), name).toBe(true);
    }
  });

  it('tells the Implementer it may edit', async () => {
    const s = scripted();
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await finish(loop);
    expect(s.buildPrompts[0]).toContain('You may edit files and run commands');
  });

  it('asks the person at once when the Implementer is stuck on the same thing twice', async () => {
    const stuck = `${ARCHITECT_STUCK_SENTINEL} I am in plan mode and cannot edit files`;
    const s = scripted({ built: [stuck, stuck] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('waiting-for-you');
    expect(s.builds()).toBe(2);
    expect(final.log.some((entry) => /not allowed to edit/.test(entry.text))).toBe(true);
  });

  it('reads the stuck reason and spots a reply that repeats itself', () => {
    expect(stuckReason(`text\n${ARCHITECT_STUCK_SENTINEL} no loader exists\nmore`)).toBe('no loader exists');
    expect(stuckReason('fine')).toBeNull();
    expect(sameStuckReason('I am in plan mode.', 'i am in plan mode')).toBe(true);
    expect(sameStuckReason('no loader', 'plan mode')).toBe(false);
    expect(namedStuckCause('Plan mode blocks me')).toMatch(/not allowed/);
    expect(namedStuckCause('no loader exists')).toBeNull();
    const paragraph = 'I understand that I am in plan mode and cannot make code changes or run commands.';
    expect(repeatsItself([paragraph, paragraph, paragraph].join('\n\n'))).toBe(true);
    expect(repeatsItself([paragraph, 'Something else entirely that is long enough to count as a paragraph here.', paragraph].join('\n\n'))).toBe(false);
  });
});

describe('checking before asking, and trusting the diff', () => {
  const withCheck = (check: string) => brief().replace('"doneChecks"', `"checkCommand":${JSON.stringify(check)},"doneChecks"`);

  it('treats a turn that changed nothing as stuck, without paying for a review', async () => {
    const s = scripted({ unchanged: true, built: ['I looked at it.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(s.reviews()).toBe(0);
    expect(final.log.some((entry) => /changed nothing in the project/.test(entry.text))).toBe(true);
    // The same blocker twice running reaches the person rather than looping.
    expect(final.phase).toBe('waiting-for-you');
  });

  it('sends a failing check straight back without an Architect review', async () => {
    const s = scripted({ planOutput: withCheck('npm test'), checks: [{ passed: false, output: 'expected 1 got 2' }, { passed: true }] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    // Round 1 failed the check and was never reviewed; round 2 passed it and the Architect approved.
    expect(s.reviews()).toBe(1);
    expect(s.builds()).toBe(2);
    expect(s.buildPrompts[1]).toContain('expected 1 got 2');
    expect(final.phase).toBe('finished');
  });

  it('puts the Implementer\'s report beside the diff, and overrules an approval of a claim nothing backs', async () => {
    const report = `Done.\n${ARCHITECT_REPORT_SENTINEL} ${JSON.stringify({ filesChanged: ['src/ghost.ts'], checksRun: [], unfinished: [] })}`;
    const s = scripted({ built: [report, 'Done.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(s.architectPrompts.some((prompt) => prompt.includes('src/ghost.ts') && prompt.includes('cross-check'))).toBe(true);
    // Approved on reading, but the claimed file was not in the project, so round 1 was sent back.
    expect(s.builds()).toBe(2);
    expect(final.log.some((entry) => /report names changes that are not in the project/.test(entry.text))).toBe(true);
  });

  it('reads a report and matches its files to the changed paths', () => {
    const report = parseReport(`x\n${ARCHITECT_REPORT_SENTINEL} {"filesChanged":["src/parser.ts"],"checksRun":["npm test passed"]}`);
    expect(report?.filesChanged).toEqual(['src/parser.ts']);
    expect(parseReport('no report')).toBeNull();
    expect(changedPaths('--- src/a.ts\n+x\n\n--- b.ts (new or unreadable as a diff)')).toEqual(['src/a.ts', 'b.ts']);
    expect(crossCheckReport(report, '--- src/parser.ts\n+x').missing).toEqual([]);
    expect(crossCheckReport(report, '--- other.ts\n+x').missing).toEqual(['src/parser.ts']);
    expect(crossCheckReport(null, '').lines[0]).toMatch(/no structured report/);
  });
});

describe('the repeat watch', () => {
  it('speaks once, when a paragraph comes back a third time, and never for varied text', () => {
    const paragraph = 'I understand that I am in plan mode and cannot make code changes or run commands.';
    const watch = new RepeatWatch();
    expect(watch.feed(`${paragraph}\n\n`)).toBe(false);
    expect(watch.feed(`${paragraph}\n\n`)).toBe(false);
    expect(watch.feed(`${paragraph}\n\n`)).toBe(true);
    expect(watch.feed(`${paragraph}\n\n`)).toBe(false);
    const varied = new RepeatWatch();
    for (let i = 0; i < 5; i += 1) expect(varied.feed(`Step ${i}: a different and reasonably long sentence about something else entirely.\n\n`)).toBe(false);
  });

  it('adds one notice after the repeating text and leaves every event alone', () => {
    const seen: Array<{ type: string }> = [];
    const wrapped = withRepeatNotice((event) => { seen.push(event); }, { agent: 'claude', conversationId: 'c1' })!;
    const delta = { schemaVersion: 1, id: 'e', taskId: 'c1', timestamp: 't', agent: 'claude', type: 'text.delta', channel: 'assistant', text: 'The very same long paragraph that keeps on coming back again and again.\n\n' } as never;
    for (let i = 0; i < 4; i += 1) wrapped(delta);
    expect(seen.filter((event) => event.type === 'text.delta')).toHaveLength(4);
    expect(seen.filter((event) => event.type === 'notice')).toHaveLength(1);
  });
});

describe('the last round of improvements', () => {
  it('sees an edit the diff text cannot show, through the content fingerprint', async () => {
    const s = scripted({ unchanged: true, fingerprintChanges: true });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.reviews()).toBe(1);
  });

  it('tries a failed Implementer turn once more, and says so', async () => {
    const s = scripted({ failFirstBuild: true });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.builds()).toBe(2);
    expect(final.log.some((entry) => /Trying that turn once more/.test(entry.text))).toBe(true);
  });

  it('hands a turn to the Architect on request instead of stopping the run', async () => {
    const s = scripted({ hangFirstBuild: true, built: ['x', 'Built it.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await vi.waitFor(() => { if (loop.status('conv-1')?.role !== 'implementer' || s.builds() < 1) throw new Error('not building yet'); }, { timeout: 4_000 });
    loop.handoff('conv-1');
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.architectPrompts.some((prompt) => prompt.includes('the Implementer is stuck'))).toBe(true);
    expect(final.log.some((entry) => /going in circles/.test(entry.text))).toBe(true);
  });

  it('runs the project own test command when the brief names none, for information only', async () => {
    const s = scripted({ suggested: 'npm test', checks: [{ passed: false, output: 'old failure' }] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(s.checkCalls).toEqual(['npm test']);
    // A failing project test is shown to the Architect, but it is not the brief's check: it neither skips the review nor blocks approval.
    expect(s.architectPrompts.some((prompt) => prompt.includes("KAI ran the project's own: npm test"))).toBe(true);
    expect(s.reviews()).toBe(1);
    expect(final.phase).toBe('finished');
  });
});

describe('a turn that keeps repeating itself', () => {
  it('is ended and handed to the Architect with a smaller first step, not left to run', async () => {
    const s = scripted({ hangFirstBuild: true, built: ['x', 'Built it.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await vi.waitFor(() => { if (loop.status('conv-1')?.role !== 'implementer' || s.builds() < 1) throw new Error('not building yet'); }, { timeout: 4_000 });
    // What the runtime does when the Implementer's text repeats a paragraph a third time.
    const paragraph = 'Let me read the rest of the file to understand the complete implementation of the thing.\n\n';
    const wrapped = withRepeatNotice(() => undefined, { agent: 'codex', conversationId: 'conv-1' })!;
    for (let i = 0; i < 3; i += 1) wrapped({ schemaVersion: 1, id: 'e', taskId: 'conv-1', timestamp: 't', agent: 'codex', type: 'text.delta', channel: 'assistant', text: paragraph } as never);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /kept repeating itself, so KAI ended it/.test(entry.text))).toBe(true);
    expect(s.architectPrompts.some((prompt) => prompt.includes('the Implementer is stuck') && prompt.includes('single file and the exact change'))).toBe(true);
  });

  it('stops listening once the turn is over', () => {
    let told = 0;
    const off = onRepeatDetected('conv-x', () => { told += 1; });
    off();
    const wrapped = withRepeatNotice(() => undefined, { agent: 'codex', conversationId: 'conv-x' })!;
    const paragraph = 'The very same long paragraph that keeps on coming back again and again and again.\n\n';
    for (let i = 0; i < 3; i += 1) wrapped({ schemaVersion: 1, id: 'e', taskId: 'conv-x', timestamp: 't', agent: 'codex', type: 'text.delta', channel: 'assistant', text: paragraph } as never);
    expect(told).toBe(0);
  });
});

describe('the Worker', () => {
  const WORKER: RoleTarget = { execution: 'api', api: { provider: 'lmstudio', model: 'qwen3-coder-30b' } };
  const briefWithRoutine = (steps: string[]): string => `Plan.\n${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, routine: steps })}`;
  const workerTurns = (s: ReturnType<typeof scripted>) => s.requests.filter((request) => !request.freshSession && request.prompt.includes('[Worker'));
  const implementerTurns = (s: ReturnType<typeof scripted>) => s.requests.filter((request) => !request.freshSession && request.prompt.includes('[Implementer'));

  it('does the routine steps after the Implementer, and the Implementer is told to leave them', async () => {
    const s = scripted({ planOutput: briefWithRoutine(['Rename parse to parseConfig in src/parser.ts', 'Add a doc comment to parseConfig']) });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ worker: WORKER }), { autonomy: 'ask' }), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(implementerTurns(s)).toHaveLength(1);
    expect(workerTurns(s)).toHaveLength(1);
    expect(implementerTurns(s)[0]!.prompt).toContain('Do not do them yourself');
    expect(implementerTurns(s)[0]!.prompt).toContain('Rename parse to parseConfig');
    expect(workerTurns(s)[0]!.prompt).toContain('1. Rename parse to parseConfig in src/parser.ts');
    // The Worker is its own target: here an API model on this computer, in Auto-edit like any builder.
    expect(workerTurns(s)[0]!.execution).toBe('api');
    expect(workerTurns(s)[0]!.autonomy).toBe('autoEdit');
    // The Architect was told a Worker exists, so it could write routine steps.
    expect(s.architectPrompts[0]).toContain('"routine"');
  });

  it('sends mechanical corrections to the Worker and the rest to the Implementer', async () => {
    const s = scripted({
      planOutput: briefWithRoutine(['Add a doc comment']),
      verdicts: [verdict('revise', { routine: true }), verdict('revise'), verdict('approve')],
    });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ worker: WORKER })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    // Round 1: Implementer then Worker. Round 2 (mechanical): Worker only. Round 3 (judgement): Implementer only.
    expect(s.requests.filter((request) => !request.freshSession).map((request) => (request.prompt.includes('[Worker') ? 'W' : 'I')).join('')).toBe('IWWI');
    expect(workerTurns(s)[1]!.prompt).toContain('mechanical');
  });

  it('is left out, and the Implementer does everything, when there is no Worker', async () => {
    const s = scripted({ planOutput: briefWithRoutine(['Rename it']) });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await finish(loop);
    expect(workerTurns(s)).toHaveLength(0);
    expect(implementerTurns(s)[0]!.prompt).not.toContain('Do not do them yourself');
    expect(s.architectPrompts[0]).not.toContain('"routine"');
  });

  it('is dropped with a note when it cannot run, so the plan does not ask for it', async () => {
    const s = scripted({ down: [WORKER], planOutput: briefWithRoutine(['Rename it']) });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ worker: WORKER })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(workerTurns(s)).toHaveLength(0);
    expect(final.log.some((entry) => /Worker .* is unavailable/.test(entry.text))).toBe(true);
    expect(s.architectPrompts[0]).not.toContain('"routine"');
  });
});

describe('a usage limit', () => {
  const WORKER: RoleTarget = { execution: 'api', api: { provider: 'lmstudio', model: 'qwen3-coder-30b' } };

  it('moves the Architect to the next available model and carries on', async () => {
    // Claude is the Architect and its subscription window is spent; Codex is the Implementer and is fine.
    const s = scripted({ limitAgents: ['claude'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /reached its usage limit/.test(entry.text))).toBe(true);
    // After the first refusal Claude is never asked again: planning, review and any step-in all ran on Codex.
    const architectRuns = s.requests.filter((request) => request.freshSession);
    expect(architectRuns.filter((request) => request.agent === 'claude')).toHaveLength(1);
    expect(architectRuns.filter((request) => request.agent === 'codex').length).toBeGreaterThanOrEqual(2);
  });

  it('moves the Implementer to the Worker when its account is spent, instead of failing', async () => {
    // Claude builds and its window is spent mid-run; the local Worker is the next available builder.
    const s = scripted({ limitAgents: ['claude'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ architect: CODEX, implementer: CLAUDE, worker: WORKER })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(final.log.some((entry) => /has reached its usage limit, so .* carries on from here/.test(entry.text))).toBe(true);
    const builds = s.requests.filter((request) => !request.freshSession);
    expect(builds[0]!.agent).toBe('claude');
    expect(builds.slice(1).every((request) => request.execution === 'api')).toBe(true);
  });

  it('shares one limit across every model on the same account', () => {
    expect(limitKey({ execution: 'cli', agent: 'claude', model: 'opus' })).toBe(limitKey({ execution: 'cli', agent: 'claude', model: 'sonnet' }));
    expect(limitKey({ execution: 'cli', agent: 'claude' })).not.toBe(limitKey({ execution: 'cli', agent: 'codex' }));
    expect(failedOnLimit({ error: 'You have hit your usage limit. It resets at 3pm.' })).toBe(true);
    expect(failedOnLimit({ error: 'connection dropped' })).toBe(false);
  });
});


describe('a local builder works in short steps', () => {
  const STEPS = ['In src/parser.ts, add an empty parse() export.', 'In src/parser.ts, make parse() split lines on "=".', 'In src/parser.test.ts, add a test for two lines.'];
  const stepped = `Plan.
${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, steps: STEPS })}`;

  it('knows a local builder from a hosted or CLI one', () => {
    expect(isSmallBuilder(LOCAL)).toBe(true);
    expect(isSmallBuilder(KIMI_API)).toBe(false);
    expect(isSmallBuilder(CODEX)).toBe(false);
    expect(isSmallBuilder(null)).toBe(false);
  });

  it('asks the Architect for steps only when the builder is local', () => {
    expect(planPrompt('task', 'Claude', undefined, true)).toContain('"steps"');
    expect(planPrompt('task', 'Claude', undefined, false)).not.toContain('"steps"');
  });

  it('marks the step being done and the ones around it', () => {
    const prompt = stepPrompt({ ...BRIEF, steps: STEPS }, 'Add a parser', 'Ollama', 1);
    expect(prompt).toContain('step 2 of 3');
    expect(prompt).toContain('[done] 1.');
    expect(prompt).toContain('[NOW] 2.');
    expect(prompt).toContain('[later] 3.');
    expect(prompt).toContain('Do step 2 now: In src/parser.ts, make parse() split lines on "=".');
  });

  it('runs and reviews each local builder step before starting the next', async () => {
    const s = scripted({ planOutput: stepped });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: LOCAL })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('finished');
    expect(s.architectPrompts[0]).toContain('"steps"');
    expect(s.buildPrompts).toHaveLength(3);
    s.buildPrompts.forEach((prompt, index) => expect(prompt).toContain(`step ${index + 1} of 3`));
    const builds = s.requests.filter((request) => !request.freshSession);
    for (const request of builds) expect(request.toolRoundLimit).toBe(LOCAL_BUILDER_ROUNDS);
    const reviews = s.architectPrompts.filter((prompt) => prompt.includes('reviewing the Implementer'));
    expect(reviews).toHaveLength(3);
    expect(s.buildPrompts.filter((prompt) => /step \d of 3/.test(prompt))).toHaveLength(3);
  });

  it('waits for approval before dispatching each block in hands-on mode', async () => {
    const s = scripted({ planOutput: stepped });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: LOCAL, participation: 'handsOn' })), 1);
    for (let index = 0; index < 3; index += 1) {
      const waiting = await finish(loop);
      expect(waiting.phase).toBe('waiting-for-you');
      expect(waiting.message).toContain(`Block ${index + 1} of 3`);
      expect(s.buildPrompts).toHaveLength(index);
      loop.answer('conv-1', true);
      if (index < 2) {
        await vi.waitFor(() => {
          const status = loop.status('conv-1');
          if (status?.phase !== 'waiting-for-you' || !status.message.includes(`Block ${index + 2} of 3`)) throw new Error('next block has not reached approval');
        }, { timeout: 4_000 });
      }
    }
    await vi.waitFor(() => { if (loop.isRunning('conv-1')) throw new Error('run has not finished'); }, { timeout: 4_000 });
    expect(loop.status('conv-1')?.phase).toBe('finished');
    expect(s.buildPrompts).toHaveLength(3);
  });

  it('stops at a step that is stuck and hands the work to the Architect', async () => {
    const s = scripted({ planOutput: stepped, built: ['Did step one.', `Cannot find the file.
${ARCHITECT_STUCK_SENTINEL} src/parser.ts is missing.`, 'Did it.'] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ implementer: LOCAL })), 1);
    await finish(loop);
    // Step 3 of the first plan never ran: the stuck step ended the round and the Architect stepped in.
    expect(s.buildPrompts.slice(0, 2).map((prompt) => /step (\d) of 3/.exec(prompt)?.[1])).toEqual(['1', '2']);
    expect(s.architectPrompts.some((prompt) => prompt.includes('the Implementer is stuck'))).toBe(true);
  });

  it('writes the step file, points each step at it, ticks finished steps and shows the notes to the Architect', async () => {
    const s = scripted({ planOutput: stepped });
    const written: string[] = [];
    const ticked: number[] = [];
    const loop = new ArchitectLoop({
      ...s.ports,
      writeSteps: async (_projectId, conversationId, forBrief) => { written.push(forBrief.goal); return `.kai/steps/${conversationId}.md`; },
      tickStep: async (_projectId, _conversationId, index) => { ticked.push(index); },
      stepNotes: async () => '- parse() lives in src/core/parse.ts',
    });
    await loop.start(input(split({ implementer: LOCAL })), 1);
    await finish(loop);
    expect(written).toEqual(['Add the parser']);
    expect(ticked).toEqual([0, 1, 2]);
    for (const prompt of s.buildPrompts) expect(prompt).toMatch(/\.kai\/steps\/.+\.md/);
    expect(s.architectPrompts.find((prompt) => prompt.includes('reviewing the Implementer'))).toContain('parse() lives in src/core/parse.ts');
  });

  it('leaves a CLI builder on one unbudgeted turn, as before', async () => {
    const s = scripted({ planOutput: stepped });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split()), 1);
    await finish(loop);
    expect(s.architectPrompts[0]).not.toContain('"steps"');
    expect(s.buildPrompts).toHaveLength(1);
    expect(s.requests.filter((request) => !request.freshSession)[0]!.toolRoundLimit).toBeUndefined();
  });
});

describe('Auto with a local builder works in short steps too', () => {
  const STEPS = ['In src/parser.ts, add an empty parse() export.', 'In src/parser.ts, make parse() split lines on "=".', 'In src/parser.test.ts, add a test for two lines.'];
  const stepped = `Plan.
${ARCHITECT_BRIEF_SENTINEL} ${JSON.stringify({ ...BRIEF, steps: STEPS })}`;

  it('waits for the person before each hands-on block, including the first one', async () => {
    const h = autoHarness({ planOutput: stepped });
    await h.session.start(autoInput({ architect: split({ implementer: LOCAL, participation: 'handsOn' }) }), 1);
    let waiting = await autoSettled(h.session);
    expect(waiting.phase).toBe('waiting-for-you');
    expect(waiting.message).toContain('block 1 of 3');
    expect(h.s.buildPrompts).toHaveLength(0);
    h.session.resume('conv-1');
    await vi.waitFor(() => { if (!h.session.status('conv-1')?.message.includes('block 2 of 3')) throw new Error('block 2 is not awaiting approval'); }, { timeout: 4_000 });
    waiting = await autoSettled(h.session);
    expect(waiting.phase).toBe('waiting-for-you');
    expect(waiting.message).toContain('block 2 of 3');
    expect(h.s.buildPrompts).toHaveLength(1);
    h.session.resume('conv-1');
    await vi.waitFor(() => { if (!h.session.status('conv-1')?.message.includes('block 3 of 3')) throw new Error('block 3 is not awaiting approval'); }, { timeout: 4_000 });
    waiting = await autoSettled(h.session);
    expect(waiting.phase).toBe('waiting-for-you');
    expect(waiting.message).toContain('block 3 of 3');
    expect(h.s.buildPrompts).toHaveLength(2);
    h.session.resume('conv-1');
    await vi.waitFor(() => { if (h.session.isRunning('conv-1')) throw new Error('run has not finished'); }, { timeout: 4_000 });
    expect(h.session.status('conv-1')?.phase).toBe('finished');
    expect(h.s.buildPrompts).toHaveLength(3);
  });

  it('asks for steps, reviews each block, ticks approved steps and finishes with a whole-work review', async () => {
    const written: string[] = [];
    const ticked: number[] = [];
    const h = autoHarness({ planOutput: stepped }, {
      writeSteps: async (_p, conversationId, brief) => { written.push(brief.goal); return `.kai/steps/${conversationId}.md`; },
      tickStep: async (_p, _c, index) => { ticked.push(index); },
      stepNotes: async () => '- parse() lives in src/core/parse.ts',
    });
    await h.session.start(autoInput({ architect: split({ implementer: LOCAL }) }), 1);
    const final = await autoSettled(h.session);
    expect(final.phase).toBe('finished');
    expect(h.s.architectPrompts[0]).toContain('"steps"');
    expect(h.s.architectPrompts[0]).toContain('Do not call update_plan');
    expect(written).toEqual(['Add the parser']);
    expect(h.s.buildPrompts).toHaveLength(3);
    h.s.buildPrompts.forEach((prompt, index) => expect(prompt).toContain(`step ${index + 1} of 3`));
    expect(ticked).toEqual([0, 1, 2]);
    for (const request of h.s.requests.filter((r) => !r.freshSession)) expect(request.toolRoundLimit).toBe(LOCAL_BUILDER_ROUNDS);
    const reviews = h.s.architectPrompts.filter((prompt) => prompt.includes('reviewing the Implementer'));
    expect(reviews).toHaveLength(4);
    expect(reviews.every((prompt) => prompt.includes('parse() lives in src/core/parse.ts'))).toBe(true);
  });

  it('keeps a CLI builder on whole-brief turns with no budget', async () => {
    const h = autoHarness({ planOutput: stepped });
    await h.session.start(autoInput({ architect: split() }), 1);
    await autoSettled(h.session);
    expect(h.s.architectPrompts[0]).not.toContain('"steps"');
    expect(h.s.buildPrompts[0]).not.toContain('step 1 of');
    expect(h.s.requests.filter((r) => !r.freshSession)[0]!.toolRoundLimit).toBeUndefined();
  });
});
