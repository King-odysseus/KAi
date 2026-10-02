import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SPLIT_SENTINEL,
  autoStartInputSchema,
  type AgentRunRequest,
  type AgentRunResult,
  type AutoStatus,
  type ConversationRecord,
} from '@kai/contracts';
import { DesktopAutoSession, parseAutoSplitDirective, type AutoSessionPorts, type AutoWindowPort } from '../apps/desktop/src/main/auto-session';

const CONVERSATION = 'conv-1';

/** In memory, because the real store reads the disk and a fake-timer test never lets that I/O come back. */
function memoryWindows(): AutoWindowPort & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    resumeAt: async (agentId, now = Date.now()) => {
      const at = entries.get(agentId);
      if (!at || Date.parse(at) <= now) { entries.delete(agentId); return null; }
      return at;
    },
    set: async (agentId, iso) => { entries.set(agentId, iso); },
    clear: async (agentId) => { entries.delete(agentId); },
  };
}

function conversation(id: string, title = 'A task'): ConversationRecord {
  return { id, projectId: 'p1', title, turns: [] } as unknown as ConversationRecord;
}

interface Harness {
  session: DesktopAutoSession;
  prompts: string[];
  executions: Array<'cli' | 'api' | undefined>;
  announced: AutoStatus[];
  opened: string[];
  openedTabs: string[];
  saved: ConversationRecord[];
  windows: AutoWindowPort & { entries: Map<string, string> };
  ports: AutoSessionPorts;
}

function harness(options: {
  agent?: (call: number, request: AgentRunRequest) => Partial<AgentRunResult> | Error;
  check?: (call: number) => boolean;
  capabilityAvailable?: boolean;
  changedFiles?: () => string[];
  suggestCheck?: string | null;
} = {}): Harness {
  const prompts: string[] = [];
  const executions: Array<'cli' | 'api' | undefined> = [];
  const announced: AutoStatus[] = [];
  const opened: string[] = [];
  const openedTabs: string[] = [];
  const saved: ConversationRecord[] = [];
  const conversations = new Map<string, ConversationRecord>([[CONVERSATION, conversation(CONVERSATION)]]);
  let agentCalls = 0;
  let checkCalls = 0;

  const ports: AutoSessionPorts = {
    getConversation: async (id) => conversations.get(id) ?? null,
    saveConversation: async (record) => { conversations.set(record.id, record); saved.push(record); return record; },
    createConversation: async (_projectId, title) => {
      const record = conversation(`conv-${conversations.size + 1}`, title);
      conversations.set(record.id, record);
      return record;
    },
    runAgent: async (request) => {
      agentCalls += 1;
      prompts.push(request.prompt);
      executions.push(request.execution);
      const outcome = options.agent?.(agentCalls, request) ?? {};
      if (outcome instanceof Error) throw outcome;
      return { conversation: {} as never, status: 'completed', output: 'ok', ...outcome };
    },
    cancelAgent: () => true,
    runCheck: async () => {
      checkCalls += 1;
      const passed = options.check?.(checkCalls) ?? true;
      return { passed, exitCode: passed ? 0 : 1, output: passed ? '' : 'FAIL: expected 1 to be 2' };
    },
    changedFilesFor: async () => options.changedFiles?.() ?? [],
    // `??` would swallow an explicit null, which is exactly the "nothing was detected" case under test.
    suggestCheck: async () => (options.suggestCheck === undefined ? 'npm test' : options.suggestCheck),
    capability: async () => ({ available: options.capabilityAvailable ?? true, name: 'DeepSeek', model: 'deepseek-chat' }),
    setPacer: () => undefined,
    openConversation: (_owner, record) => { opened.push(record.id); },
    openNewTab: (_owner, record) => { openedTabs.push(record.id); },
    announce: (_owner, status) => { announced.push(structuredClone(status)); },
    now: () => Date.now(),
  };
  const windows = memoryWindows();
  return { session: new DesktopAutoSession(ports, windows), prompts, executions, announced, opened, openedTabs, saved, windows, ports };
}

const start = (h: Harness, overrides: Record<string, unknown> = {}) =>
  h.session.start(autoStartInputSchema.parse({
    projectId: 'p1',
    conversationId: CONVERSATION,
    prompt: 'Make the failing test pass.',
    agent: 'claude',
    route: 'direct',
    autonomy: 'full',
    ...overrides,
  }), 1);

/**
 * Waits for a run to come to rest. Unlike the board Autopilot, a parked run is at rest while still being "running":
 * `waiting-for-you` is where Auto stops and waits, so it counts as settled here.
 */
async function settled(h: Harness, conversationId = CONVERSATION): Promise<AutoStatus> {
  for (let guard = 0; guard <= 500; guard += 1) {
    // Let pending work run before reading: a run just resumed has not yet left `waiting-for-you`.
    await vi.advanceTimersByTimeAsync(guard === 0 ? 0 : 60_000);
    const status = h.session.status(conversationId);
    if (!h.session.isRunning(conversationId) || status?.phase === 'waiting-for-you') return status!;
  }
  throw new Error('Auto never settled; it is still running.');
}

describe('auto mode split directive', () => {
  it('reads the exact marker and its JSON, and ignores prose that only sounds like a split', () => {
    const withMarker = `I did the first half.\n${AUTO_SPLIT_SENTINEL} {"title":"The rest","briefing":"Finish the parser and its tests."}`;
    expect(parseAutoSplitDirective(withMarker)).toEqual({ title: 'The rest', briefing: 'Finish the parser and its tests.' });
    expect(parseAutoSplitDirective('This is too big for one session, so I will stop here.')).toBeNull();
    expect(parseAutoSplitDirective(`${AUTO_SPLIT_SENTINEL} not json`)).toBeNull();
    expect(parseAutoSplitDirective(`${AUTO_SPLIT_SENTINEL} {"title":"x"}`)).toBeNull();
  });
});

describe('desktop auto session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('carries the task across turns and finishes when the check passes', async () => {
    const h = harness({ check: (call) => call >= 3 });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.turnCount).toBe(3);
    expect(final.checkStatus).toBe('passing');
    // Every turn after the first carries the failure forward rather than restating the task.
    expect(h.prompts[1]).toContain('The task is not finished');
    expect(h.prompts[1]).toContain('npm test');
  });

  it('finishes on the first turn when the check already passes', async () => {
    const h = harness();
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.turnCount).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  it('refuses to start without a check command, since it is the only honest sign of done', async () => {
    const h = harness({ suggestCheck: null });
    await expect(start(h, { checkCommand: '' })).rejects.toThrow(/check command/i);
  });

  it('hands off to the API provider when the CLI window is spent, and returns to the CLI when it reopens', async () => {
    const h = harness({
      agent: (call) => {
        if (call === 1) return { status: 'failed', output: '', error: '5-hour limit reached' };
        // Time passes while the API does the work; by the next turn the CLI window has reopened.
        if (call === 2) vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
        return {};
      },
      check: (call) => call >= 3,
    });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.executions).toEqual(['cli', 'api', 'cli', 'cli']);
    // The fallback is named while it is carrying the work, and cleared once the CLI has it back.
    expect(h.announced.some((status) => status.activeProvider === 'api' && status.fallbackProvider?.name === 'DeepSeek')).toBe(true);
    expect(final.activeProvider).toBe('cli');
    expect(final.fallbackProvider).toBeNull();
    expect(h.announced.some((status) => status.log.some((entry) => entry.kind === 'provider'))).toBe(true);
  });

  it('parks the run when the CLI window is spent and there is no API provider to hand off to', async () => {
    const h = harness({
      agent: () => ({ status: 'failed', output: '', error: '5-hour limit reached' }),
      capabilityAvailable: false,
    });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('waiting-for-you');
    expect(final.waitReason).toBe('no-fallback');
    expect(h.executions).toEqual(['cli']);
  });

  it('rests a burst limit and retries the same provider instead of switching', async () => {
    const h = harness({
      agent: (call) => (call === 1 ? { status: 'failed', output: '', error: 'Provider request failed (429): Too Many Requests' } : {}),
    });
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    const resting = h.session.status(CONVERSATION)!;
    expect(resting.phase).toBe('cooling');
    expect(resting.resumeAt).not.toBeNull();
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(h.executions.every((execution) => execution === 'cli')).toBe(true);
  });

  it('stops and asks when the same check failure comes back with no files changed', async () => {
    const h = harness({ check: () => false, changedFiles: () => [] });
    await start(h, { maxRepeatedFailures: 3 });
    const final = await settled(h);
    expect(final.phase).toBe('waiting-for-you');
    expect(final.waitReason).toBe('repeated-failure');
    expect(final.turnCount).toBe(3);
  });

  it('keeps going when the check fails but the working tree is still changing', async () => {
    let files = 0;
    const h = harness({ check: (call) => call >= 3, changedFiles: () => { files += 1; return [`src/f${files}.ts`]; } });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.turnCount).toBe(3);
  });

  it('parks on a turn cap rather than ending the run, and carries on when resumed', async () => {
    const h = harness({ check: () => false, changedFiles: () => [] });
    await start(h, { maxTurns: 1, maxRepeatedFailures: 5 });
    const parked = await settled(h);
    expect(parked.phase).toBe('waiting-for-you');
    expect(parked.waitReason).toBe('turn-cap');
    expect(parked.turnCount).toBe(1);

    h.session.resume(CONVERSATION);
    const final = await settled(h);
    expect(final.turnCount).toBeGreaterThan(1);
  });

  it('says it is waiting for the person when a turn reaches an approval prompt', async () => {
    const h = harness();
    h.ports.runAgent = async (request) => {
      h.session.onApprovalRequest(request.conversationId, 'Write src/app.ts');
      return { conversation: {} as never, status: 'completed', output: 'ok' };
    };
    await start(h);
    await settled(h);
    expect(h.announced.some((status) => status.phase === 'waiting-for-you' && status.waitReason === 'approval')).toBe(true);
  });

  it('opens a tab for the remainder when the model says the task is too big', async () => {
    const h = harness({
      // Only the original conversation asks for a split; the tab it opens is a normal run.
      agent: (_call, request) => request.conversationId === CONVERSATION
        ? { output: `I have done the first half.\n${AUTO_SPLIT_SENTINEL} {"title":"Finish the parser","briefing":"The lexer is done; write the parser and its tests."}` }
        : {},
      check: () => false,
    });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.splitCount).toBe(1);
    expect(h.openedTabs).toHaveLength(1);
    const seeded = h.saved.find((record) => record.id === h.openedTabs[0]);
    expect(seeded?.title).toBe('Finish the parser');
    expect(seeded?.turns[0]?.text).toContain('The lexer is done; write the parser and its tests.');
    expect(final.log.some((entry) => entry.kind === 'split')).toBe(true);
    await h.session.dispose();
  });

  it('does not split on prose alone, however much it sounds like a hand-off', async () => {
    const h = harness({
      agent: () => ({ output: 'This is too big for one session, so I will carry on next time.' }),
      check: (call) => call >= 2,
    });
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('finished');
    expect(final.splitCount).toBe(0);
    expect(h.openedTabs).toHaveLength(0);
  });

  it('stops when asked, and cancels the turn in flight', async () => {
    const h = harness();
    const cancelled: string[] = [];
    // A turn that never finishes on its own, the way a real long run behaves: only cancelling ends it.
    let failTurn: ((error: Error) => void) | null = null;
    h.ports.runAgent = () => new Promise((_resolve, reject) => { failTurn = reject; });
    h.ports.cancelAgent = (id) => { cancelled.push(id); failTurn?.(new Error('The run was cancelled.')); return true; };
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    const stopped = await h.session.stop(CONVERSATION);
    expect(stopped?.phase).toBe('stopped');
    expect(cancelled).toContain(CONVERSATION);
  });

  it('reuses a spent window recorded by an earlier run instead of spending a request to find out', async () => {
    const h = harness({ capabilityAvailable: false });
    // A window still shut, left behind by a run that ended before the app was closed and reopened.
    await h.windows.set('claude', new Date(Date.now() + 2 * 3_600_000).toISOString());
    await start(h);
    const final = await settled(h);
    expect(final.phase).toBe('waiting-for-you');
    expect(final.waitReason).toBe('no-fallback');
    // Not one turn was spent rediscovering what the store already knew.
    expect(h.executions).toEqual([]);
  });

  it('records every published status with the fields the panel reads', async () => {
    const h = harness();
    await start(h);
    const final = await settled(h);
    expect(h.announced.length).toBeGreaterThan(0);
    expect(final).toMatchObject({ conversationId: CONVERSATION, projectId: 'p1', maxTurns: 40, activeProvider: 'cli' });
    expect(final.startedAt).not.toBeNull();
  });
});
