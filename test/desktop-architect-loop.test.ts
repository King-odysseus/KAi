import { describe, expect, it, vi } from 'vitest';
import {
  ARCHITECT_BRIEF_SENTINEL,
  ARCHITECT_STUCK_SENTINEL,
  ARCHITECT_VERDICT_SENTINEL,
  architectRunInputSchema,
  architectSplitActive,
  autoStartInputSchema,
  isPlanningGradeModel,
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
  REVISIONS_BEFORE_STEP_IN,
  ROUNDS_BEFORE_ASKING,
  type ArchitectLoopPorts,
} from '../apps/desktop/src/main/architect-loop';
import { DesktopAutoSession, withImplementer, type AutoSessionPorts, type AutoWindowPort } from '../apps/desktop/src/main/auto-session';
import { resolveApiConnection } from '../apps/desktop/src/main/api-connection';

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
}

function scripted(script: Script = {}) {
  const requests: AgentRunRequest[] = [];
  const architectPrompts: string[] = [];
  const buildPrompts: string[] = [];
  const announced: ArchitectStatus[] = [];
  let reviews = 0;
  let builds = 0;
  const down = new Set((script.down ?? []).map(roleTargetKey));
  const pick = <T,>(list: T[] | undefined, n: number, fallback: T): T => (list && list.length ? list[Math.min(n, list.length) - 1]! : fallback);

  const ports: ArchitectLoopPorts = {
    runAgent: async (request): Promise<AgentRunResult> => {
      requests.push(request);
      if (request.freshSession) {
        architectPrompts.push(request.prompt);
        if (request.prompt.includes('reviewing the Implementer')) {
          reviews += 1;
          return { conversation: {} as never, status: 'completed', output: pick(script.verdicts, reviews, verdict('approve')) };
        }
        if (request.prompt.includes('the Implementer is stuck')) return { conversation: {} as never, status: 'completed', output: brief('A better plan') };
        return { conversation: {} as never, status: 'completed', output: script.planOutput ?? brief() };
      }
      builds += 1;
      buildPrompts.push(request.prompt);
      return { conversation: {} as never, status: 'completed', output: pick(script.built, builds, 'Built it.') };
    },
    ready: async (target) => (down.has(roleTargetKey(target)) ? { ready: false, reason: 'signed out' } : { ready: true }),
    reviewMaterial: async () => '--- src/parser.ts\n+ export function parse() {}',
    cancelAgent: () => true,
    announce: (_owner, status) => { announced.push(structuredClone(status)); },
    now: () => Date.now(),
    agentNames: () => ({ claude: 'Claude', codex: 'Codex' }),
  };
  return { ports, requests, architectPrompts, buildPrompts, announced, reviews: () => reviews, builds: () => builds };
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
    }
    // The composer showed qwen, but the Implementer is codex: the chosen role wins, not the composer's agent.
    for (const request of builderRuns) expect(request).toMatchObject({ agent: 'codex', execution: 'cli', autonomy: 'full' });
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

  it('fails up front, naming both, when neither the Architect nor its stand-in can run', async () => {
    const s = scripted({ down: [CLAUDE, KIMI_API] });
    const loop = new ArchitectLoop(s.ports);
    await loop.start(input(split({ fallback: KIMI_API })), 1);
    const final = await finish(loop);
    expect(final.phase).toBe('failed');
    expect(final.message).toContain('Claude · opus');
    expect(final.message).toContain('Moonshot (Kimi) · kimi-k3');
    expect(final.message).toMatch(/signed out/);
    // The Implementer was fine, so nothing was built: the plan is the first thing that could not happen.
    expect(s.requests).toHaveLength(0);
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

// ---------------------------------------------------------------------------------------------------------------------

function memoryWindows(): AutoWindowPort {
  const entries = new Map<string, string>();
  return {
    resumeAt: async (agentId) => entries.get(agentId) ?? null,
    set: async (agentId, iso) => { entries.set(agentId, iso); },
    clear: async (agentId) => { entries.delete(agentId); },
  };
}

function autoHarness(script: Script = {}) {
  const s = scripted(script);
  const conversations = new Map<string, ConversationRecord>([['conv-1', { id: 'conv-1', projectId: 'p1', title: 't', turns: [] } as unknown as ConversationRecord]]);
  const announced: AutoStatus[] = [];
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
    now: () => Date.now(),
  };
  const coach = new ArchitectCoach(s.ports);
  return { s, announced, session: new DesktopAutoSession(ports, memoryWindows(), coach), plain: new DesktopAutoSession(ports, memoryWindows()) };
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
