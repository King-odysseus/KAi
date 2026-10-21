import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autopilotStartInputSchema, type AgentRunRequest, type AgentRunResult, type ArtifactKind, type AutopilotRunRecord, type AutopilotStatus, type BoardCard, type BoardStatus, type DevCheckResult, type StudioBoard } from '@kai/contracts';
import { DesktopAutopilot, isEasyCard, pickBatch, sameFailure, type AutopilotJournal, type AutopilotPorts } from '../apps/desktop/src/main/autopilot';

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
  /** What the run has left on disk. Empty whenever no card is in its hands. */
  kept: Map<string, AutopilotRunRecord>;
  /** Every dev proof the run asked for, in order, with the routes it was given. */
  devChecks: Array<{ routes: readonly string[] }>;
  /** The folder each agent run was given, in order; undefined is the project itself. */
  cwds: Array<string | undefined>;
  /** The most agent runs that were in separate copies at the same moment. */
  atOnce(): number;
}

function harness(options: {
  cards: BoardCard[];
  agent?: (call: number, request: AgentRunRequest) => Partial<AgentRunResult> | Error;
  check?: (call: number) => boolean;
  /** The artifact kinds the project has actually written. Empty stands for a project with no design yet. */
  artifacts?: Partial<Record<ArtifactKind, string>>;
  /** The dev proof's answer. Defaults to "it came up", so the ordinary tests are not about this. */
  devCheck?: (routes: readonly string[]) => DevCheckResult;
  /** Gives the run separate copies of the project, as a git project would. `clash` names the cards whose merge fails. */
  parallel?: { clash?: string[]; unavailable?: boolean };
}): Harness {
  let conversationCount = 0;
  const cwds: Array<string | undefined> = [];
  let active = 0;
  let mostAtOnce = 0;
  const board: StudioBoard = { schemaVersion: 1, cards: options.cards };
  const prompts: string[] = [];
  const devChecks: Array<{ routes: readonly string[] }> = [];
  let agentCalls = 0;
  let checkCalls = 0;
  const promote = (): void => {
    for (const item of board.cards) {
      if (item.status === 'backlog' && item.dependsOn.every((id) => board.cards.find((other) => other.id === id)?.status === 'done')) item.status = 'ready';
    }
  };
  promote();
  const find = (id: string): BoardCard => board.cards.find((item) => item.id === id)!;
  // The run's journal, in memory. The real one is a directory of small files; these tests only care that a record is
  // there for exactly as long as a card is in the run's hands.
  const kept = new Map<string, AutopilotRunRecord>();
  const journal: AutopilotJournal = {
    begin: async (record) => { kept.set(record.studioProjectId, { ...record, schemaVersion: 1 }); },
    touch: async (studioProjectId, lastMessage) => {
      const current = kept.get(studioProjectId);
      if (current) kept.set(studioProjectId, { ...current, lastMessage });
    },
    end: async (studioProjectId) => { kept.delete(studioProjectId); },
    read: async (studioProjectId) => kept.get(studioProjectId) ?? null,
    list: async () => [...kept.values()],
  };
  const ports: AutopilotPorts = {
    settings: async () => ({ defaultAgent: 'claude', defaultRoute: 'direct', defaultAutonomy: 'edit' }) as never,
    board: async () => structuredClone(board),
    artifactsFor: async () => options.artifacts ?? {},
    claimCard: async (_p, id, agent) => { const item = find(id); item.status = 'inProgress'; item.claimedBy = agent; return item; },
    recordCardRun: async (_p, id, run) => { find(id).runs.push(run); return find(id); },
    setCheck: async (_p, id, check) => { find(id).check = check; return find(id); },
    moveCard: async (_p, id, status, note, by = 'agent') => { const item = find(id); item.status = status; item.notes = note; item.movedBy = by; item.claimedBy = null; promote(); return item; },
    checkUi: async () => ({ passed: true, summary: '' }),
    createConversation: async () => ({ id: `conversation-${(conversationCount += 1)}` }) as never,
    runAgent: async (request, _owner, runOptions) => {
      agentCalls += 1;
      prompts.push(request.prompt);
      cwds.push(runOptions?.cwd);
      const outcome = options.agent?.(agentCalls, request) ?? {};
      // Only the copies count as "at once": a card in the project is the serial path, whatever else is running.
      if (runOptions?.cwd) {
        active += 1;
        mostAtOnce = Math.max(mostAtOnce, active);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        active -= 1;
      }
      if (outcome instanceof Error) throw outcome;
      return { conversation: {} as never, status: 'completed', output: 'ok', ...outcome };
    },
    cancelAgent: () => true,
    ...(options.parallel ? {
      worktrees: {
        prepare: async () => (options.parallel?.unavailable ? null : {
          checkout: async (id: string) => `/copies/${id}`,
          commit: async (id: string) => `commit-${id}`,
          filesChanged: async () => [],
          integrate: async (commits: ReadonlyArray<{ stepId: string }>) => ({
            conflicts: commits.filter((item) => options.parallel?.clash?.includes(item.stepId)).map((item) => ({ stepId: item.stepId, files: ['src/shared.ts'] })),
            applied: [], skipped: [], integrationCommit: 'merged',
          }),
          dispose: async () => undefined,
        }),
      },
    } : {}),
    runCheck: async () => {
      checkCalls += 1;
      const passed = options.check?.(checkCalls) ?? true;
      return { passed, exitCode: passed ? 0 : 1, output: passed ? '' : 'FAIL: expected 1 to be 2', runId: passed ? `run-${checkCalls}` : null };
    },
    suggestCheck: async () => 'npm test',
    checkDev: async (_projectId, routes) => {
      devChecks.push({ routes });
      return options.devCheck?.(routes) ?? {
        passed: true,
        summary: `The app runs on dev at http://localhost:5173${routes.length > 0 ? ` (${routes.length} page${routes.length === 1 ? '' : 's'} loaded)` : ''}.`,
        url: 'http://localhost:5173',
        routes: routes.map((route) => ({ route, ok: true, problem: '' })),
      };
    },
    changedFilesFor: async () => ['src/a.ts'],
    setPacer: () => undefined,
    announce: () => undefined,
    preflight: async () => undefined,
    openConversation: () => undefined,
    journal,
    now: () => Date.now(),
  };
  return { autopilot: new DesktopAutopilot(ports), board, prompts, ports, kept, devChecks, cwds, atOnce: () => mostAtOnce };
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

  it('parks a card the second time it fails in exactly the same way, instead of spending the third attempt', async () => {
    const h = harness({ cards: [card('a')], check: () => false });
    await start(h, { attemptsPerCard: 3 });
    await settled(h);
    expect(h.board.cards[0]?.status).toBe('blocked');
    expect(h.prompts).toHaveLength(2);
    expect(h.board.cards[0]?.notes).toContain('the same failure each time');
  });

  it('puts a card in review rather than done when there is no check to run', async () => {
    const h = harness({ cards: [card('a')] });
    h.ports.suggestCheck = async () => null;
    await start(h);
    await settled(h);
    expect(h.board.cards[0]?.status).toBe('review');
  });

  it('closes the scaffold card it parked for want of a check once the project can be checked, and carries on behind it', async () => {
    const h = harness({ cards: [card('scaffold'), card('b', ['scaffold'])] });
    // The project has nothing to check until the scaffold card has written its manifest.
    let asked = 0;
    h.ports.suggestCheck = async () => { asked += 1; return h.board.cards[0]?.status === 'review' ? 'npm test' : null; };
    await start(h);
    const final = await settled(h);
    expect(asked).toBeGreaterThan(1);
    expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
    expect(h.board.cards[0]?.check?.runId).toBeTruthy();
    expect(final.phase).toBe('finished');
  });

  it('leaves a card in review when its check still fails, and does not loop on it', async () => {
    const h = harness({ cards: [card('scaffold'), card('b', ['scaffold'])], check: () => false });
    h.ports.suggestCheck = async () => (h.board.cards[0]?.status === 'review' ? 'npm test' : null);
    await start(h);
    const final = await settled(h);
    expect(h.board.cards.map((item) => item.status)).toEqual(['review', 'backlog']);
    expect(final.phase).toBe('finished');
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

  it('parks repeated blockers but keeps working independent cards and reports a next step', async () => {
    const h = harness({ cards: [card('a'), card('b'), card('c')], agent: () => new Error('Open a project before sending a message.') });
    await start(h, { attemptsPerCard: 1 });
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.board.cards.map((item) => item.status)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(h.prompts).toHaveLength(3);
    expect(final.log.some((entry) => entry.text.includes('Suggested') || entry.text.includes('Open a project'))).toBe(true);
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

  it('leaves a record naming the card for exactly as long as it holds one', async () => {
    let release: () => void = () => undefined;
    const thinking = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ cards: [card('a')] });
    h.ports.runAgent = async () => { await thinking; return { conversation: {} as never, status: 'completed', output: 'ok' }; };
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);

    // The card is claimed and the agent is mid-turn: this is the state a close would otherwise leave unexplained.
    const held = await h.ports.journal!.read('p1');
    expect(held?.cardId).toBe('a');
    expect(held?.cardTitle).toBe('Card a');

    release();
    await settled(h);
    expect(await h.ports.journal!.read('p1')).toBeNull();
  });

  it('reports a card still held by a run that is no longer going, and puts it back on request', async () => {
    const h = harness({ cards: [card('a')] });
    // What a close leaves behind: the record on disk, and the board still holding the card under Autopilot's name.
    await h.ports.journal!.begin({
      studioProjectId: 'p1', cardId: 'a', cardTitle: 'Card a', startedAt: NOW, updatedAt: NOW,
      lastMessage: 'Working on "Card a".', start: autopilotStartInputSchema.parse({ projectId: 'p1', execution: 'api' }),
    });
    h.board.cards[0]!.status = 'inProgress';
    h.board.cards[0]!.claimedBy = 'Autopilot';

    const listed = await h.autopilot.interrupted();
    expect(listed.map((record) => record.cardTitle)).toEqual(['Card a']);

    expect(await h.autopilot.releaseInterrupted('p1')).toBe(true);
    expect(h.board.cards[0]?.status).toBe('ready');
    expect(h.board.cards[0]?.claimedBy).toBeNull();
    // And the report goes with it: there is nothing left for the next launch to explain.
    expect(await h.autopilot.interrupted()).toEqual([]);
  });

  it('carries on with a recorded run from the card it was holding, not from the top of the board', async () => {
    const h = harness({ cards: [card('a'), card('b')] });
    await h.ports.journal!.begin({
      studioProjectId: 'p1', cardId: 'a', cardTitle: 'Card a', startedAt: NOW, updatedAt: NOW,
      lastMessage: 'Working on "Card a".',
      // The settings the run was given travel with it, limits included: carrying on is not a fresh run.
      start: autopilotStartInputSchema.parse({ projectId: 'p1', execution: 'api', maxCards: 1, checkCommand: 'npm run verify' }),
    });
    h.board.cards[0]!.status = 'inProgress';
    h.board.cards[0]!.claimedBy = 'Autopilot';

    await h.autopilot.resumeInterrupted('p1', 1);
    const final = await settled(h);

    expect(h.board.cards[0]?.status).toBe('done');
    expect(h.autopilot.status('p1')?.phase).toBe('finished');
    // The recorded limit came with it, so the resumed run stopped at one card rather than working the whole board.
    expect(h.board.cards[1]?.status).toBe('ready');
    expect(final.cardsWorked).toBe(1);
  });

  it('puts back every card a machine parked, and leaves a person’s block alone', async () => {
    const h = harness({ cards: [card('a'), card('b')], check: () => false });
    await start(h, { attemptsPerCard: 1 });
    await settled(h);
    // A person's block. `movedBy` is the fact that tells the two apart; the note is what they happened to type.
    h.board.cards[1]!.movedBy = 'user';
    h.board.cards[1]!.notes = 'Blocked by a person';
    expect(await h.autopilot.requeueBlocked('p1')).toBe(1);
    expect(h.board.cards.map((item) => item.status)).toEqual(['ready', 'blocked']);
  });

  it('puts back a card another writer parked, not only Autopilot’s own wording', async () => {
    // The board's single-card run and an agent working through the kai-project tools both write their own note, and
    // neither starts with "Autopilot gave up". Matching on the text left these cards blocking everything behind them.
    const h = harness({ cards: [card('a', [], 'blocked')] });
    h.board.cards[0]!.movedBy = 'agent';
    h.board.cards[0]!.notes = 'The run failed: the agent exited with code 1';
    expect(await h.autopilot.requeueBlocked('p1')).toBe(1);
    expect(h.board.cards[0]!.status).toBe('ready');
    expect(h.board.cards[0]!.notes).toContain('Put back in the queue');
  });

  it('parks a screen card with no route instead of spending three agent turns on it', async () => {
    // The board will not close a component or page card without a passing screen check, and the check needs a route.
    // Such a card cannot pass however many times it is run, so running it is a paid turn for a guaranteed block.
    const h = harness({ cards: [card('a', [], 'ready')] });
    h.board.cards[0]!.kind = 'page';
    h.board.cards[0]!.route = '';
    await start(h);
    await settled(h);
    expect(h.prompts).toEqual([]);
    expect(h.board.cards[0]!.status).toBe('blocked');
    expect(h.board.cards[0]!.notes).toContain('No route');
  });

  it('still works a screen card that has a route', async () => {
    const h = harness({ cards: [card('a', [], 'ready')] });
    h.board.cards[0]!.kind = 'page';
    h.board.cards[0]!.route = '/pricing';
    await start(h);
    await settled(h);
    expect(h.prompts).toHaveLength(1);
    // `checkUi` is stubbed to pass, and the card is closed through the board's own rule as usual.
    expect(h.board.cards[0]!.status).toBe('done');
  });

  it('proves the app runs on dev once the board is finished, and names where it is', async () => {
    const h = harness({ cards: [card('a'), card('b')] });
    h.board.cards[0]!.kind = 'page';
    h.board.cards[0]!.route = '/pricing';
    await start(h);
    const final = await settled(h);

    expect(h.devChecks).toHaveLength(1);
    // The home page and every screen card's route, without repeats.
    expect(h.devChecks[0]!.routes).toEqual(['/', '/pricing']);
    expect(final.devCheck?.passed).toBe(true);
    expect(final.devCheck?.url).toBe('http://localhost:5173');
    expect(final.message).toContain('http://localhost:5173');
  });

  it('reports a dev check that failed without calling the finished run a failure', async () => {
    const h = harness({
      cards: [card('a')],
      devCheck: (routes) => ({
        passed: false,
        summary: `The app does not run cleanly on dev: ${routes[0]} — The page loaded but rendered nothing.`,
        url: 'http://localhost:5173',
        routes: routes.map((route) => ({ route, ok: false, problem: 'The page loaded but rendered nothing.' })),
      }),
    });
    await start(h);
    const final = await settled(h);

    // The cards really are done: a project that will not open is what the result turned out to be, not a fault in
    // the loop, so the run is still `finished` and the reason is on the status for the screen to name.
    expect(final.phase).toBe('finished');
    expect(h.board.cards[0]!.status).toBe('done');
    expect(final.devCheck?.passed).toBe(false);
    expect(final.message).toContain('does not run cleanly on dev');
    expect(final.log.some((entry) => entry.kind === 'warn' && entry.text.includes('does not run cleanly'))).toBe(true);
  });

  it('does not claim the app runs when the board never got finished', async () => {
    const h = harness({ cards: [card('a')], check: () => false });
    await start(h, { attemptsPerCard: 1 });
    const final = await settled(h);
    expect(final.devCheck).toBeNull();
    expect(h.devChecks).toEqual([]);
  });

  it('builds a card whose design artifact was never written instead of parking it', async () => {
    // The whole reason a missing design used to stop the board: the brief said to ask for the artifact rather than
    // invent it, the agent obeyed, and the card was parked. It now says to build to a provisional look instead.
    const h = harness({ cards: [card('a', [], 'ready')], artifacts: {} });
    h.board.cards[0]!.kind = 'page';
    h.board.cards[0]!.route = '/pricing';
    h.board.cards[0]!.needsArtifacts = ['tokens'];
    await start(h);
    const final = await settled(h);

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('NOT WRITTEN YET, AND THIS DOES NOT STOP YOU');
    expect(h.prompts[0]).toContain('provisional');
    expect(h.prompts[0]).not.toContain('ask for it rather than inventing it');
    expect(h.board.cards[0]!.status).toBe('done');
    // The run says so out loud, once, rather than leaving it to be worked out from a board of blocked cards.
    expect(final.log.some((entry) => entry.text.includes('provisional look'))).toBe(true);
  });

  it('says it is working on this machine only, before it touches a card', async () => {
    const h = harness({ cards: [card('a')] });
    await start(h);
    const final = await settled(h);
    const opening = final.log.slice(0, 2).map((entry) => entry.text).join(' ');
    expect(opening).toContain('never commits and never deploys');
  });

  describe('cards at once', () => {
    it('works independent cards side by side, each in its own copy, then closes them all', async () => {
      const h = harness({ cards: [card('a'), card('b'), card('c')], parallel: {} });
      await start(h, { parallelCards: 3 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.atOnce()).toBe(3);
      expect(h.cwds.slice(0, 3).sort()).toEqual(['/copies/a', '/copies/b', '/copies/c']);
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
      // Each card's agent ran once: the first attempt carried into the check rather than being run again.
      expect(h.prompts).toHaveLength(3);
      expect(final.lanes).toEqual([]);
      expect(h.kept.size).toBe(0);
    });

    it('never runs a card beside the card it waits on', async () => {
      const h = harness({ cards: [card('a'), card('b', ['a']), card('c', ['b'])], parallel: {} });
      await start(h, { parallelCards: 3 });
      await settled(h);
      expect(h.atOnce()).toBe(0);
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
    });

    it('claims the cards one at a time, and tries again when the board says it changed underneath the claim', async () => {
      const h = harness({ cards: [card('a'), card('b'), card('c')], parallel: {} });
      const original = h.ports.claimCard;
      let inFlight = 0;
      let most = 0;
      let refusedOnce = false;
      h.ports.claimCard = async (projectId, id, agent) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (id === 'b' && !refusedOnce) {
          refusedOnce = true;
          throw new Error('The Studio board changed while this update was pending (expected revision 4, found 5). Reload the board and try again.');
        }
        return original(projectId, id, agent);
      };
      await start(h, { parallelCards: 3 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(most).toBe(1);
      expect(refusedOnce).toBe(true);
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
      expect(h.atOnce()).toBe(3);
    });

    it('leaves a card in the queue when it cannot be claimed, and still works the others', async () => {
      const h = harness({ cards: [card('a'), card('b'), card('c')], parallel: {} });
      const original = h.ports.claimCard;
      let refusals = 0;
      h.ports.claimCard = async (projectId, id, agent) => {
        if (id === 'b' && refusals < 6) {
          refusals += 1;
          throw new Error('The Studio board changed while this update was pending (expected revision 4, found 5).');
        }
        return original(projectId, id, agent);
      };
      await start(h, { parallelCards: 3 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
      expect(final.log.some((entry) => entry.text.includes('could not be claimed'))).toBe(true);
    });

    it('does not lose the work of the cards that finished when one card\'s lane falls over', async () => {
      const h = harness({ cards: [card('a'), card('b'), card('c')], parallel: {} });
      const original = h.ports.createConversation;
      let failed = false;
      h.ports.createConversation = async (projectId, title, item) => {
        if (item.id === 'b' && !failed) {
          failed = true;
          throw new Error('The conversation could not be saved.');
        }
        return original(projectId, title, item);
      };
      await start(h, { parallelCards: 3 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done', 'done']);
      expect(final.log.some((entry) => entry.text.includes('stopped while working in its copy'))).toBe(true);
      // a and c were merged and checked; b ran again on its own afterwards.
      expect(h.cwds.filter((cwd) => cwd !== undefined)).toHaveLength(2);
      expect(h.cwds.filter((cwd) => cwd === undefined)).toHaveLength(1);
    });

    it('accepts up to eight cards at once and no more', () => {
      expect(autopilotStartInputSchema.parse({ projectId: 'p1', parallelCards: 8 }).parallelCards).toBe(8);
      expect(() => autopilotStartInputSchema.parse({ projectId: 'p1', parallelCards: 9 })).toThrow();
    });

    it('runs one card at a time when the setting is 1, even with copies available', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: {} });
      await start(h, { parallelCards: 1 });
      await settled(h);
      expect(h.cwds.every((cwd) => cwd === undefined)).toBe(true);
    });

    it('falls back to one card at a time, and says why, when the project cannot be copied', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: { unavailable: true } });
      await start(h, { parallelCards: 2 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.cwds.every((cwd) => cwd === undefined)).toBe(true);
      expect(final.log.some((entry) => entry.text.includes('one at a time'))).toBe(true);
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
    });

    it('runs a card again on its own when its changes clash with another card\'s', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: { clash: ['b'] } });
      await start(h, { parallelCards: 2 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
      // a and b in copies, then b again in the project.
      expect(h.cwds.filter((cwd) => cwd === undefined)).toHaveLength(1);
      expect(h.prompts).toHaveLength(3);
      expect(final.log.some((entry) => entry.text.includes('changed the same files'))).toBe(true);
    });

    it('retries a card whose check fails after the merge, with the failure in the prompt', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: {}, check: (call) => call !== 1 });
      await start(h, { parallelCards: 2 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
      expect(h.prompts.some((prompt) => prompt.includes('FAIL: expected 1 to be 2'))).toBe(true);
    });

    it('rests once for a limit that hits both cards, instead of once each', async () => {
      const h = harness({
        cards: [card('a'), card('b')],
        parallel: {},
        agent: (call) => (call <= 2 ? { status: 'failed', output: '', error: 'Provider request failed (429): Too Many Requests The provider asked to wait 90s.' } : {}),
      });
      await start(h, { parallelCards: 2 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(final.restsTotal).toBe(1);
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
    });

    it('stops every copy when Stop is pressed', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: {} });
      const cancelled: string[] = [];
      h.ports.cancelAgent = (id) => { cancelled.push(id); return true; };
      await start(h, { parallelCards: 2 });
      await vi.advanceTimersByTimeAsync(100);
      const stopping = h.autopilot.stop('p1');
      // The fake agent finishes on its own clock; a real one is cancelled by `cancelAgent`.
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      expect(cancelled).toHaveLength(2);
      expect(h.autopilot.status('p1')?.phase).toBe('stopped');
    });
  });

  describe('side-by-side extras', () => {
    it('keeps two cards that name the same file out of one wave', () => {
      const a = { ...card('a'), prompt: 'Edit src/router.tsx to add /a' };
      const b = { ...card('b'), prompt: 'Edit src/router.tsx to add /b' };
      const c = { ...card('c'), prompt: 'Write src/c.ts' };
      expect(pickBatch([a, b, c], 3).map((item) => item.id)).toEqual(['a', 'c']);
    });

    it('treats a shared file named in only a card\'s brief as a clash, and a card\'s earlier files too', () => {
      const a = { ...card('a'), story: 'Update package.json scripts' };
      const b = { ...card('b'), acceptance: ['package.json has the dependency'] };
      const c = { ...card('c'), runs: [{ agent: 'api', model: null, at: NOW, files: ['src/x.ts'] }] };
      const d = { ...card('d'), prompt: 'Rework src/x.ts' };
      expect(pickBatch([a, b], 2)).toHaveLength(1);
      expect(pickBatch([c, d], 2)).toHaveLength(1);
    });

    it('calls a component with no route, and setup nothing waits on, easy', () => {
      const cards = [{ ...card('s'), kind: 'chore' as const }, { ...card('t'), kind: 'chore' as const }, { ...card('u', ['t']) }, { ...card('v'), kind: 'component' as const }, { ...card('w'), kind: 'component' as const, route: '/w' }];
      expect(cards.filter((item) => isEasyCard(item, cards)).map((item) => item.id)).toEqual(['s', 'v']);
    });

    it('uses the cheaper model for an easy first attempt and the main model for a retry', async () => {
      const models: Array<string | undefined> = [];
      const h = harness({
        cards: [{ ...card('a'), kind: 'component' as const }],
        check: (call) => call > 1,
        agent: (_call, request) => { models.push(request.model); return {}; },
      });
      await start(h, { model: 'big', easyModel: 'small' });
      await settled(h);
      expect(models).toEqual(['small', 'big']);
    });

    it('checks a card in its own copy and hands a failure back before merging', async () => {
      const h = harness({ cards: [card('a'), card('b')], parallel: {}, check: (call) => call > 2 });
      await start(h, { parallelCards: 2 });
      const final = await settled(h);
      expect(final.phase).toBe('finished');
      expect(h.board.cards.map((item) => item.status)).toEqual(['done', 'done']);
      // Both copies failed their first early check and were rerun there, before any merge.
      expect(h.cwds.filter((cwd) => cwd !== undefined)).toHaveLength(4);
      expect(h.prompts.filter((prompt) => prompt.includes('FAIL: expected 1 to be 2'))).toHaveLength(2);
    });

    it('reports where the time went and, once a card is done, how long is left', async () => {
      const h = harness({ cards: [card('a'), card('b', ['a']), card('c', ['b'])], parallel: {} });
      await start(h, { parallelCards: 1 });
      const final = await settled(h);
      expect(final.timing.agentMs + final.timing.checkMs).toBeGreaterThanOrEqual(0);
      expect(final.etaMinutes).toBeNull();
      expect(final.timing.restMs).toBe(0);
    });

    it('puts back every card an interrupted run held, not only the one its record names', async () => {
      const h = harness({ cards: [card('a'), card('b')] });
      for (const item of h.board.cards) { item.status = 'inProgress'; item.claimedBy = 'Autopilot'; }
      h.kept.set('p1', { schemaVersion: 1, studioProjectId: 'p1', cardId: 'a', cardTitle: 'Card a', startedAt: NOW, updatedAt: NOW, lastMessage: '', start: autopilotStartInputSchema.parse({ projectId: 'p1' }) });
      expect(await h.autopilot.releaseInterrupted('p1')).toBe(true);
      expect(h.board.cards.map((item) => item.status)).not.toContain('inProgress');
    });
  });

  describe('failure signature', () => {
    it('treats the same failure with different times, paths and numbers as the same', () => {
      expect(sameFailure('Check failed (exit 1) in 12.4s at C:\\a\\b.ts:10:5', 'Check failed (exit 1) in 9.8s at C:\\a\\b.ts:42:7')).toBe(true);
    });

    it('keeps genuinely different failures apart', () => {
      expect(sameFailure('Type error: x is not a string', 'Cannot find module "react"')).toBe(false);
      expect(sameFailure('', 'anything')).toBe(false);
    });
  });
});
