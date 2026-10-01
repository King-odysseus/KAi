import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autopilotStartInputSchema, type AgentRunRequest, type AgentRunResult, type AutopilotStatus, type BoardCard, type BoardStatus, type StudioBoard } from '@kai/contracts';
import { DesktopAutopilot, type AutopilotPorts } from '../apps/desktop/src/main/autopilot';

const NOW = '2026-10-01T00:00:00.000Z';

function card(id: string, dependsOn: string[] = [], status: BoardStatus = 'backlog'): BoardCard {
  return {
    id, title: `Card ${id}`, kind: 'backend', story: '', acceptance: [], prompt: '', designRef: null, route: '', dependsOn,
    needsArtifacts: [], status, checks: [], check: null, runs: [], notes: '', stale: false, staleReason: null, claimedBy: null,
    movedBy: null, movedAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

interface Harness {
  autopilot: DesktopAutopilot;
  board: StudioBoard;
  prompts: string[];
  ports: AutopilotPorts;
}

function harness(options: {
  cards: BoardCard[];
  agent?: (call: number, request: AgentRunRequest) => Partial<AgentRunResult> | Error;
  check?: (call: number) => boolean;
}): Harness {
  const board: StudioBoard = { schemaVersion: 1, cards: options.cards };
  const prompts: string[] = [];
  let agentCalls = 0;
  let checkCalls = 0;
  const promote = (): void => {
    for (const item of board.cards) {
      if (item.status === 'backlog' && item.dependsOn.every((id) => board.cards.find((other) => other.id === id)?.status === 'done')) item.status = 'ready';
    }
  };
  promote();
  const find = (id: string): BoardCard => board.cards.find((item) => item.id === id)!;
  const ports: AutopilotPorts = {
    settings: async () => ({ defaultAgent: 'claude', defaultRoute: 'direct', defaultAutonomy: 'edit' }) as never,
    board: async () => structuredClone(board),
    artifactsFor: async () => ({}),
    claimCard: async (_p, id, agent) => { const item = find(id); item.status = 'inProgress'; item.claimedBy = agent; return item; },
    recordCardRun: async (_p, id, run) => { find(id).runs.push(run); return find(id); },
    setCheck: async (_p, id, check) => { find(id).check = check; return find(id); },
    moveCard: async (_p, id, status, note) => { const item = find(id); item.status = status; item.notes = note; item.claimedBy = null; promote(); return item; },
    checkUi: async () => ({ passed: true, summary: '' }),
    createConversation: async () => ({ id: `conversation-${prompts.length}` }) as never,
    runAgent: async (request) => {
      agentCalls += 1;
      prompts.push(request.prompt);
      const outcome = options.agent?.(agentCalls, request) ?? {};
      if (outcome instanceof Error) throw outcome;
      return { conversation: {} as never, status: 'completed', output: 'ok', ...outcome };
    },
    cancelAgent: () => true,
    runCheck: async () => {
      checkCalls += 1;
      const passed = options.check?.(checkCalls) ?? true;
      return { passed, exitCode: passed ? 0 : 1, output: passed ? '' : 'FAIL: expected 1 to be 2', runId: passed ? `run-${checkCalls}` : null };
    },
    suggestCheck: async () => 'npm test',
    changedFilesFor: async () => ['src/a.ts'],
    setPacer: () => undefined,
    announce: () => undefined,
    preflight: async () => undefined,
    openConversation: () => undefined,
    now: () => Date.now(),
  };
  return { autopilot: new DesktopAutopilot(ports), board, prompts, ports };
}

const start = (h: Harness, overrides: Record<string, unknown> = {}) =>
  h.autopilot.start(autopilotStartInputSchema.parse({ projectId: 'p1', execution: 'api', ...overrides }), 1);

async function settled(h: Harness): Promise<AutopilotStatus> {
  while (h.autopilot.isRunning('p1')) await vi.advanceTimersByTimeAsync(60_000);
  return h.autopilot.status('p1')!;
}

describe('desktop autopilot', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('works every card in dependency order and closes each on a passing check', async () => {
    const h = harness({ cards: [card('a'), card('b', ['a']), card('c', ['b'])] });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
    expect(final.cardsDone).toBe(3);
    expect(h.board.cards[0]?.check?.runId).toBe('run-1');
  });

  it('rests when the provider rate-limits, then carries on with the same card without spending an attempt', async () => {
    const h = harness({
      cards: [card('a')],
      agent: (call) => (call === 1 ? { status: 'failed', output: '', error: 'Provider request failed (429): Too Many Requests The provider asked to wait 90s.' } : {}),
    });
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    const resting = h.autopilot.status('p1')!;
    expect(resting.phase).toBe('cooling');
    expect(resting.resumeAt).not.toBeNull();
    // The one-minute first rest is shorter than the 90 seconds the provider asked for, so the provider's wait wins.
    expect(new Date(resting.resumeAt!).getTime() - Date.now()).toBeGreaterThan(90_000);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.restsTotal).toBe(1);
    expect(h.board.cards[0]?.status).toBe('done');
    expect(h.prompts[1]).toContain('cut off by a rate limit');
    expect(h.prompts).toHaveLength(2);
  });

  it('sits out a five-hour usage window and then finishes the board', async () => {
    const h = harness({
      cards: [card('a'), card('b')],
      agent: (call) => (call === 1 ? { status: 'failed', output: '', error: '5-hour limit reached' } : {}),
    });
    await start(h, { maxHours: 0 });
    const before = Date.now();
    // Polls every half hour with no reset time to aim at; the provider reopens after five hours.
    let polls = 0;
    const original = h.ports.runAgent;
    h.ports.runAgent = async (request, owner) => {
      if (Date.now() - before < 5 * 3_600_000) { polls += 1; return { conversation: {} as never, status: 'failed', output: '', error: '5-hour limit reached' }; }
      return original(request, owner);
    };
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.cardsDone).toBe(2);
    expect(polls).toBeGreaterThanOrEqual(8);
  });

  it('gives up once resting has gone on for most of a day without a card finishing', async () => {
    const h = harness({ cards: [card('a')], agent: () => ({ status: 'failed', output: '', error: '5-hour limit reached' }) });
    await start(h, { maxHours: 0 });
    const final = await settled(h);
    expect(final.phase).toBe('failed');
    expect(final.message).toContain('out of quota or credit');
  });

  it('retries a failed check with the failure in the prompt, then closes the card', async () => {
    const h = harness({ cards: [card('a')], check: (call) => call > 1 });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.board.cards[0]?.status).toBe('done');
    expect(h.prompts[1]).toContain('FAIL: expected 1 to be 2');
  });

  it('blocks a card that never passes and moves on, leaving what depends on it alone', async () => {
    const h = harness({ cards: [card('a'), card('b', ['a']), card('c')], check: () => false });
    await start(h, { attemptsPerCard: 2 });
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.board.cards.map((item) => item.status)).toEqual(['blocked', 'backlog', 'blocked']);
    expect(final.message).toContain('2 are blocked');
    expect(h.prompts).toHaveLength(4);
  });

  it('puts a card in review rather than done when there is no check to run', async () => {
    const h = harness({ cards: [card('a')] });
    h.ports.suggestCheck = async () => null;
    await start(h);
    await settled(h);
    expect(h.board.cards[0]?.status).toBe('review');
  });

  it('stops at the card limit', async () => {
    const h = harness({ cards: [card('a'), card('b'), card('c')] });
    await start(h, { maxCards: 2 });
    const final = await settled(h);
    expect(final.cardsDone).toBe(2);
    expect(final.message).toContain('limit');
  });

  it('stops when the spend limit is passed', async () => {
    const h = harness({ cards: [card('a'), card('b')], agent: () => ({ costUsd: 3 }) });
    await start(h, { maxCostUsd: 2 });
    const final = await settled(h);
    expect(final.cardsDone).toBe(1);
    expect(final.message).toContain('spend');
  });

  it('can be stopped in the middle of a rest', async () => {
    const h = harness({ cards: [card('a')], agent: () => ({ status: 'failed', output: '', error: 'HTTP 429 rate limit' }) });
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.autopilot.status('p1')?.phase).toBe('cooling');
    const stopped = await h.autopilot.stop('p1');
    expect(stopped?.phase).toBe('stopped');
    expect(h.autopilot.isRunning('p1')).toBe(false);
  });

  it('refuses to start without cards, and refuses a second run on the same project', async () => {
    await expect(start(harness({ cards: [] }))).rejects.toThrow('no cards');
    const h = harness({ cards: [card('a')], agent: () => ({ status: 'failed', output: '', error: 'rate limit' }) });
    await start(h);
    await expect(start(h)).rejects.toThrow('already running');
    await h.autopilot.stop('p1');
  });

  it('picks a half-finished card back up after a restart', async () => {
    const h = harness({ cards: [card('a'), card('b')] });
    h.board.cards[0]!.status = 'inProgress';
    h.board.cards[0]!.claimedBy = 'Autopilot';
    await start(h, { maxCards: 1 });
    await settled(h);
    expect(h.board.cards[0]?.status).toBe('done');
    expect(h.board.cards[1]?.status).toBe('ready');
  });

  it('stops and puts the cards back when every run fails the same way, instead of parking the whole board', async () => {
    const h = harness({ cards: [card('a'), card('b'), card('c')], agent: () => new Error('Open a project before sending a message.') });
    await start(h, { attemptsPerCard: 1 });
    const final = await settled(h);
    expect(final.phase).toBe('failed');
    expect(final.message).toContain('put back');
    expect(h.board.cards.map((item) => item.status)).toEqual(['ready', 'ready', 'ready']);
    expect(h.prompts).toHaveLength(2);
  });

  it('refuses to start, touching no card, when the preflight finds a setup problem', async () => {
    const h = harness({ cards: [card('a')] });
    h.ports.preflight = async () => { throw new Error('This plan cannot run agents.'); };
    await expect(start(h)).rejects.toThrow('cannot run agents');
    expect(h.board.cards[0]?.status).toBe('ready');
  });

  it('takes the window to the composer conversation once, on the first card', async () => {
    const h = harness({ cards: [card('a'), card('b')] });
    const opened: string[] = [];
    h.ports.openConversation = (_w, conversation) => { opened.push(conversation.id); };
    await start(h);
    await settled(h);
    expect(opened).toHaveLength(1);
  });

  it('puts back only the cards Autopilot gave up on', async () => {
    const h = harness({ cards: [card('a'), card('b')], check: () => false });
    await start(h, { attemptsPerCard: 1 });
    await settled(h);
    h.board.cards[1]!.notes = 'Blocked by a person';
    expect(await h.autopilot.requeueBlocked('p1')).toBe(1);
    expect(h.board.cards.map((item) => item.status)).toEqual(['ready', 'blocked']);
  });
});
