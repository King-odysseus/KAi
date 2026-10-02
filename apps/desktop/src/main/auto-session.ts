import {
  AUTO_SPLIT_SENTINEL,
  autoSplitDirectiveSchema,
  type AgentRunRequest,
  type AgentRunResult,
  type AutoLogEntry,
  type AutoProviderRef,
  type AutoSplitDirective,
  type AutoStartInput,
  type AutoStatus,
  type AutoWaitReason,
  type ConversationRecord,
} from '@kai/contracts';
import { formatDuration } from './autopilot';
import { cooldownMs, detectRateLimit, RequestPacer, sleepAbortable } from './rate-limit';

/**
 * Auto mode: one task, one conversation, worked on its own until the check command passes.
 *
 * It is deliberately not the Studio's Autopilot. That one walks a board of cards and closes each through the board's
 * own rule; this one carries a single task across turns and calls it done only when the person's own check command
 * passes. The two share the rate-limit vocabulary and nothing else, which is why the board loop is left alone.
 *
 * The one judgement Auto adds is the provider: when the CLI's usage window is spent it moves to the API model and
 * keeps working, then returns to the CLI once the window reopens. Everything it cannot decide - an approval, a wall
 * it keeps hitting, a spent window with nowhere to go - it stops and asks about.
 */

const LOG_LIMIT = 60;
const TAIL_CHARS = 2_500;
/** How many times one task may hand its remainder to a fresh tab before Auto refuses to split again. */
const MAX_SPLIT_DEPTH = 3;
/** Resting time allowed after a burst limit before Auto gives up on the provider entirely. */
const MAX_REST_WITHOUT_PROGRESS_MS = 9 * 3_600_000;

export interface AutoCheckResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

/** What the Direct API provider can do right now, read once and cached for the run. */
export interface AutoProviderCapability {
  available: boolean;
  name: string;
  model: string | null;
}

/**
 * Remembers when a CLI agent's usage window reopens, keyed by the agent rather than the conversation: the window
 * belongs to the subscription. A port rather than a file so the loop does no I/O of its own, the way every other
 * port here works, and so a test can drive it without touching the disk.
 */
export interface AutoWindowPort {
  /** The reopen time for an agent, or null when it is unknown or already past. */
  resumeAt(agentId: string, now?: number): Promise<string | null>;
  set(agentId: string, iso: string): Promise<void>;
  clear(agentId: string): Promise<void>;
}

export interface AutoSessionPorts {
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  saveConversation(conversation: ConversationRecord): Promise<ConversationRecord>;
  /** Opens a blank conversation for the task, or for a split's remainder. */
  createConversation(projectId: string, title: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  runCheck(projectId: string, command: string, signal: AbortSignal): Promise<AutoCheckResult>;
  changedFilesFor(projectId: string): Promise<string[]>;
  suggestCheck(projectId: string): Promise<string | null>;
  capability(): Promise<AutoProviderCapability>;
  /** Turns request pacing on for the Direct API runtime while a job runs, and off again after. */
  setPacer(pacer: RequestPacer | undefined): void;
  /** Takes the window to the conversation the agent is working in, so the person can watch. */
  openConversation(ownerWindowId: number, conversation: ConversationRecord): void;
  /** Adds a tab for a split's remainder and takes the window to it. */
  openNewTab(ownerWindowId: number, conversation: ConversationRecord): void;
  announce(ownerWindowId: number, status: AutoStatus): void;
  now(): number;
}

interface ActiveAutoRun {
  controller: AbortController;
  ownerWindowId: number;
  done: Promise<void>;
  /** The window has been taken to the conversation once; it is not dragged back on every turn. */
  opened: boolean;
  /** Set by `pause`: the loop stops starting turns until `resume`. */
  paused: boolean;
  /** The reason the loop is parked on right now, so `resume` knows what to reset. */
  pauseReason: AutoWaitReason | null;
  wake: (() => void) | null;
  /** Caps the person has already chosen to carry on past, so they do not stop the run again. */
  acknowledged: Set<AutoWaitReason>;
  /** Identical failures in a row, and the working tree they happened on, so a wall is told apart from slow work. */
  repeatSignature: string | null;
  repeatFiles: string | null;
  repeatCount: number;
  restStreak: number;
  restedMs: number;
  capability: AutoProviderCapability | null;
}

/** A split's briefing, found only by the exact marker and the JSON after it - never by reading the prose around it. */
export function parseAutoSplitDirective(output: string): AutoSplitDirective | null {
  const index = output.lastIndexOf(AUTO_SPLIT_SENTINEL);
  if (index === -1) return null;
  const rest = output.slice(index + AUTO_SPLIT_SENTINEL.length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let position = start; position < rest.length; position += 1) {
    if (rest[position] === '{') depth += 1;
    else if (rest[position] === '}') {
      depth -= 1;
      if (depth === 0) { end = position; break; }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = autoSplitDirectiveSchema.safeParse(JSON.parse(rest.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Tells the model how to hand off work it cannot finish here, without letting it do so by accident in prose. */
function splitProtocol(): string {
  return `\n\nIf this task is bigger than one session can finish, hand the remainder over instead of stopping. End your reply with its own line:\n${AUTO_SPLIT_SENTINEL} {"title": "short name for the rest", "briefing": "exactly what is left, in enough detail that a fresh session carries on without you"}\nUse it only when you truly cannot finish the task here.`;
}

/** The next step of a task that is not finished. Small on purpose: the model needs the failure, not a restatement. */
function continuationPrompt(command: string, failure: string): string {
  return [
    `The task is not finished: the check \`${command}\` did not pass.`,
    'Carry on in this conversation. Do not restate the plan; make the change and run the check again.',
    failure ? `\nThe check reported:\n${failure.slice(-TAIL_CHARS)}` : '',
    splitProtocol(),
  ].join('');
}

/** Carries one composer task to its check, on its own, switching provider when the CLI's usage window runs out. */
export class DesktopAutoSession {
  private readonly runs = new Map<string, ActiveAutoRun>();
  private readonly statuses = new Map<string, AutoStatus>();

  constructor(
    private readonly ports: AutoSessionPorts,
    private readonly windows: AutoWindowPort,
  ) {}

  status(conversationId: string): AutoStatus | null {
    return this.statuses.get(conversationId) ?? null;
  }

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  async start(input: AutoStartInput, ownerWindowId: number, options: { opened?: boolean } = {}): Promise<AutoStatus> {
    const conversation = await this.resolveConversation(input);
    if (this.runs.has(conversation.id)) throw new Error('Auto is already running on this conversation.');
    const command = input.checkCommand.trim() || (await this.ports.suggestCheck(input.projectId).catch(() => null)) || '';
    if (!command) {
      throw new Error("Auto needs a check command: it is the only honest sign that the task is done. Set one, or let KAI detect the project's test command.");
    }
    const active: ActiveAutoRun = {
      controller: new AbortController(),
      ownerWindowId,
      done: Promise.resolve(),
      opened: options.opened ?? false,
      paused: false,
      pauseReason: null,
      wake: null,
      acknowledged: new Set(),
      repeatSignature: null,
      repeatFiles: null,
      repeatCount: 0,
      restStreak: 0,
      restedMs: 0,
      capability: null,
    };
    const state = this.fresh(conversation, input, command);
    this.runs.set(conversation.id, active);
    this.statuses.set(conversation.id, state);
    this.record(conversation.id, ownerWindowId, 'info', 'Auto started.');
    if (!active.opened) {
      active.opened = true;
      this.ports.openConversation(ownerWindowId, conversation);
    }
    this.ports.setPacer(new RequestPacer({ maxConcurrent: 2, minGapMs: input.minGapSeconds * 1_000 }));
    active.done = this.drive(input, conversation.id, command, active).finally(() => {
      this.runs.delete(conversation.id);
      this.ports.setPacer(undefined);
    });
    return this.statuses.get(conversation.id)!;
  }

  async stop(conversationId: string): Promise<AutoStatus | null> {
    const active = this.runs.get(conversationId);
    if (!active) return this.status(conversationId);
    active.controller.abort(new Error('Auto was stopped.'));
    active.wake?.();
    this.ports.cancelAgent(conversationId);
    await active.done.catch(() => undefined);
    return this.status(conversationId);
  }

  /** Stops the loop from starting another turn; the turn already in flight is left to finish. */
  pause(conversationId: string): AutoStatus | null {
    const active = this.runs.get(conversationId);
    if (!active) return this.status(conversationId);
    active.paused = true;
    return this.status(conversationId);
  }

  /** Picks a parked run back up. A cap the person has chosen to pass is not raised again this run. */
  resume(conversationId: string): AutoStatus | null {
    const active = this.runs.get(conversationId);
    if (!active) return this.status(conversationId);
    active.paused = false;
    if (active.pauseReason === 'repeated-failure') {
      // Give it a fresh set of attempts rather than silencing the rule for the rest of the run.
      active.repeatSignature = null;
      active.repeatFiles = null;
      active.repeatCount = 0;
    } else if (active.pauseReason && active.pauseReason !== 'no-fallback') {
      active.acknowledged.add(active.pauseReason);
    }
    active.wake?.();
    return this.status(conversationId);
  }

  /** A turn has reached an approval prompt; say so, and let the turn itself carry on once it is answered. */
  onApprovalRequest(conversationId: string, title: string): void {
    const active = this.runs.get(conversationId);
    const state = this.statuses.get(conversationId);
    if (!active || !state) return;
    state.waitReason = 'approval';
    state.waitDetail = `Waiting for you to approve: ${title}`.slice(0, 600);
    this.phase(conversationId, active.ownerWindowId, 'waiting-for-you', `Waiting for you: ${title}`);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((conversationId) => this.stop(conversationId)));
  }

  // ---------------------------------------------------------------------------------------------------------

  private async resolveConversation(input: AutoStartInput): Promise<ConversationRecord> {
    if (input.conversationId) {
      const existing = await this.ports.getConversation(input.conversationId);
      if (!existing) throw new Error('Conversation not found.');
      return existing;
    }
    return this.ports.createConversation(input.projectId, input.prompt.slice(0, 64));
  }

  private async drive(input: AutoStartInput, conversationId: string, command: string, active: ActiveAutoRun): Promise<void> {
    const owner = active.ownerWindowId;
    const startedAt = this.ports.now();
    const deadline = input.maxHours > 0 ? startedAt + input.maxHours * 3_600_000 : Infinity;
    let first = true;
    let prompt = input.prompt;
    try {
      for (;;) {
        if (active.controller.signal.aborted) return this.settle(conversationId, owner, 'stopped', 'Auto was stopped.');
        if (active.paused) await this.pauseForHuman(conversationId, active, null, 'Paused. Press Resume and Auto carries on from here.');

        const cap = this.capReached(input, conversationId, active, deadline);
        if (cap) {
          await this.pauseForHuman(conversationId, active, cap.reason, cap.detail);
          continue;
        }

        const chosen = await this.chooseExecution(input, conversationId, active);
        if (!chosen) {
          await this.pauseForHuman(conversationId, active, 'no-fallback',
            'The CLI usage window is spent and there is no API provider to carry on with. Add one in Settings, or press Resume to try again.');
          continue;
        }
        const state = this.state(conversationId);
        state.activeProvider = chosen.execution;
        state.fallbackProvider = chosen.execution === 'api' ? chosen.provider : null;
        // Said every turn, so a run that has just been resumed or has come back from a limit stops reading as idle.
        this.phase(conversationId, owner, 'working', state.turnCount > 0 ? `Working on the task, turn ${state.turnCount + 1}.` : 'Working on the task.');

        const turn = await this.runTurn(input, conversationId, active, chosen.execution, prompt, first);
        if (active.controller.signal.aborted) return this.settle(conversationId, owner, 'stopped', 'Auto was stopped.');
        if (turn.kind === 'switch') continue;
        if (turn.kind === 'parked') {
          await this.pauseForHuman(conversationId, active, turn.reason, turn.detail);
          continue;
        }

        first = false;
        state.turnCount += 1;
        if (state.waitReason === 'approval') { state.waitReason = null; state.waitDetail = null; }

        if (turn.kind === 'failed') {
          // Stopped, not broken. Auto stops with it, and says so, rather than counting it towards the failures that
          // would park the session on a person.
          if (turn.cancelled) return this.settle(conversationId, owner, 'stopped', 'The run was stopped, so Auto stopped too.');
          this.record(conversationId, owner, 'warn', `The turn ended with an error: ${turn.error.slice(0, 300)}`);
          if (await this.noteFailure(input, active, `turn:${turn.error.slice(-400)}`)) continue;
          await this.pauseForHuman(conversationId, active, 'repeated-failure',
            `The same error came back ${input.maxRepeatedFailures} turns in a row with no files changed, which points at the setup rather than the work: ${turn.error.slice(0, 300)}`);
          continue;
        }

        this.phase(conversationId, owner, 'checking', `Checking with \`${command}\`.`);
        const check = await this.ports.runCheck(input.projectId, command, active.controller.signal);
        state.checkStatus = check.passed ? 'passing' : 'failing';
        if (check.passed) {
          this.record(conversationId, owner, 'check', `The check passed after ${state.turnCount} turn${state.turnCount === 1 ? '' : 's'}.`);
          return this.settle(conversationId, owner, 'finished', `Done: \`${command}\` passed after ${state.turnCount} turn${state.turnCount === 1 ? '' : 's'}.`);
        }

        const split = parseAutoSplitDirective(turn.output);
        if (split) {
          await this.split(input, conversationId, active, split);
          return this.settle(conversationId, owner, 'finished', `Handed the rest to a new tab: "${split.title}".`);
        }

        const failure = `The check \`${command}\` failed${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}. Fix the cause, do not weaken the check. Output:\n${check.output.slice(-TAIL_CHARS)}`;
        this.record(conversationId, owner, 'check', `Check failed after ${state.turnCount} turn${state.turnCount === 1 ? '' : 's'}.`);
        if (!(await this.noteFailure(input, active, `check:${check.output.slice(-400)}`))) {
          await this.pauseForHuman(conversationId, active, 'repeated-failure',
            `The check failed the same way ${input.maxRepeatedFailures} times with no files changed in between, so running it again will not help: \`${command}\``);
          continue;
        }
        prompt = continuationPrompt(command, failure);
      }
    } catch (error) {
      if (active.controller.signal.aborted) return this.settle(conversationId, owner, 'stopped', 'Auto was stopped.');
      const message = error instanceof Error ? error.message : String(error);
      this.record(conversationId, owner, 'warn', message);
      return this.settle(conversationId, owner, 'failed', message);
    }
  }

  /**
   * Runs one turn, and on a burst limit rests and runs the same turn again. A spent CLI window is not rested on: it
   * is reported so the loop can move to the other provider, which is the whole point of the switch.
   */
  private async runTurn(
    input: AutoStartInput,
    conversationId: string,
    active: ActiveAutoRun,
    execution: 'cli' | 'api',
    prompt: string,
    first: boolean,
  ): Promise<
    | { kind: 'ok'; output: string }
    | { kind: 'failed'; error: string; cancelled?: boolean }
    | { kind: 'switch' }
    | { kind: 'parked'; reason: AutoWaitReason; detail: string }
  > {
    for (;;) {
      if (active.controller.signal.aborted) throw new Error('Auto was stopped.');
      let result: AgentRunResult | null = null;
      let thrown: unknown = null;
      try {
        result = await this.ports.runAgent(this.request(input, conversationId, prompt, execution, first), active.ownerWindowId);
      } catch (error) {
        if (active.controller.signal.aborted) throw error;
        thrown = error;
      }
      if (result?.costUsd) this.state(conversationId).costUsd += result.costUsd;

      // A run the person cancelled is not a failure. Counting it as one fed the repeat detector, and the repeat
      // detector parks the session on a human — so stopping a run made Auto stop and wait to be resumed, which is the
      // behaviour that had to be reset by hand every time.
      const cancelled = (result?.conversation?.events ?? []).some(
        (event) => (event as { type?: string; status?: string }).type === 'agent.lifecycle'
          && (event as { status?: string }).status === 'cancelled',
      );

      const failed = thrown !== null || result?.status === 'failed' || Boolean(result?.error);
      if (!failed) return { kind: 'ok', output: result?.output ?? '' };

      const message = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : (result?.error ?? result?.output.slice(-600) ?? 'The agent failed.');
      if (cancelled) return { kind: 'failed', error: message, cancelled };
      const limited = detectRateLimit(thrown ?? message);
      if (!limited) return { kind: 'failed', error: message };

      if (limited.window) {
        if (execution === 'cli') {
          const state = this.state(conversationId);
          const until = new Date(this.ports.now() + cooldownMs(active.restStreak + 1, limited.retryAfterMs, true)).toISOString();
          state.cliResumeAt = until;
          await this.windows.set(input.agent, until).catch(() => undefined);
          // The capability may have changed while the window was open; read it fresh at the switch.
          active.capability = null;
          this.record(conversationId, active.ownerWindowId, 'provider', `${input.agent}'s usage window is spent until ${clock(until)}.`);
          this.phase(conversationId, active.ownerWindowId, 'switching-provider', `${input.agent}'s usage window is spent until ${clock(until)}. Moving to the API provider.`);
          return { kind: 'switch' };
        }
        return {
          kind: 'parked',
          reason: 'no-fallback',
          detail: 'The API provider says its usage window is spent, and Auto has no other provider to run on. Wait for it to reopen, then press Resume.',
        };
      }

      // A burst limit: rest and try the same turn again, exactly as the board Autopilot does.
      active.restStreak += 1;
      const wait = cooldownMs(active.restStreak, limited.retryAfterMs, false);
      active.restedMs += wait;
      if (active.restedMs > MAX_REST_WITHOUT_PROGRESS_MS) {
        throw new Error(`The provider is still refusing after ${formatDuration(MAX_REST_WITHOUT_PROGRESS_MS)} of rest. It may be out of quota or credit. Check the account, then start Auto again.`);
      }
      await this.rest(conversationId, active, wait, message);
    }
  }

  private request(input: AutoStartInput, conversationId: string, prompt: string, execution: 'cli' | 'api', first: boolean): AgentRunRequest {
    return {
      conversationId,
      prompt,
      agent: input.agent,
      execution,
      route: input.route,
      autonomy: input.autonomy,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.model ? { model: input.model } : {}),
      // The heavy context belongs to the first turn; later turns are the same task being pushed at.
      ...(first && input.skills ? { skills: input.skills } : {}),
      ...(first && input.selectedPaths ? { selectedPaths: input.selectedPaths } : {}),
      ...(first && input.contextChips ? { contextChips: input.contextChips } : {}),
    };
  }

  /** Which provider the next turn runs on, or null when there is nothing left to run on. */
  private async chooseExecution(
    input: AutoStartInput,
    conversationId: string,
    active: ActiveAutoRun,
  ): Promise<{ execution: 'cli' | 'api'; provider: AutoProviderRef | null } | null> {
    // The API has no usage window; the runtime's own retries cover a burst, so it is always the one to run.
    if (input.execution === 'api') return { execution: 'api', provider: null };

    const state = this.state(conversationId);
    const now = this.ports.now();
    if (state.cliResumeAt && Date.parse(state.cliResumeAt) <= now) {
      state.cliResumeAt = null;
      await this.windows.clear(input.agent).catch(() => undefined);
    }
    if (!state.cliResumeAt) {
      // A window recorded by an earlier session is still shut; do not spend a request rediscovering it.
      const remembered = await this.windows.resumeAt(input.agent, now).catch(() => null);
      if (remembered) {
        state.cliResumeAt = remembered;
        this.record(conversationId, active.ownerWindowId, 'provider', `${input.agent}'s usage window is still spent until ${clock(remembered)}.`);
      }
    }
    if (!state.cliResumeAt) return { execution: 'cli', provider: null };
    if (!input.apiFallback) return null;
    const capability = await this.capability(active);
    if (!capability.available) return null;
    return { execution: 'api', provider: { name: capability.name, model: capability.model } };
  }

  private async capability(active: ActiveAutoRun): Promise<AutoProviderCapability> {
    if (!active.capability) {
      active.capability = await this.ports.capability().catch(() => ({ available: false, name: 'the API provider', model: null }));
    }
    return active.capability;
  }

  private capReached(
    input: AutoStartInput,
    conversationId: string,
    active: ActiveAutoRun,
    deadline: number,
  ): { reason: AutoWaitReason; detail: string } | null {
    const state = this.state(conversationId);
    if (state.turnCount >= input.maxTurns && !active.acknowledged.has('turn-cap')) {
      return { reason: 'turn-cap', detail: `Reached the ${input.maxTurns}-turn limit set for this run.` };
    }
    if (input.maxCostUsd > 0 && state.costUsd >= input.maxCostUsd && !active.acknowledged.has('cost-cap')) {
      return { reason: 'cost-cap', detail: `Spend reached about $${state.costUsd.toFixed(2)}, past the $${input.maxCostUsd.toFixed(2)} limit set for this run.` };
    }
    if (this.ports.now() >= deadline && !active.acknowledged.has('time-cap')) {
      return { reason: 'time-cap', detail: `Reached the ${input.maxHours}-hour limit set for this run.` };
    }
    return null;
  }

  /**
   * Notes a failure and says whether Auto should press on (true) or stop and ask (false). The test is a real one:
   * the same failure text and the same working tree means nothing moved, however the model describes it.
   */
  private async noteFailure(input: AutoStartInput, active: ActiveAutoRun, signature: string): Promise<boolean> {
    const files = await this.ports.changedFilesFor(input.projectId).catch(() => ['unknown']);
    const fingerprint = [...files].sort().join('\n');
    if (active.repeatSignature === signature && active.repeatFiles === fingerprint) {
      active.repeatCount += 1;
    } else {
      active.repeatSignature = signature;
      active.repeatFiles = fingerprint;
      active.repeatCount = 1;
    }
    return active.repeatCount < input.maxRepeatedFailures;
  }

  /** Hands the rest of an oversized task to a fresh tab, which picks it up with its own Auto session. */
  private async split(input: AutoStartInput, conversationId: string, active: ActiveAutoRun, directive: AutoSplitDirective): Promise<void> {
    const owner = active.ownerWindowId;
    if (input.splitDepth >= MAX_SPLIT_DEPTH) {
      this.record(conversationId, owner, 'warn', `Auto would hand this on again, but the task has already been split ${MAX_SPLIT_DEPTH} times.`);
      return;
    }
    this.phase(conversationId, owner, 'splitting', `Handing the rest to a new tab: "${directive.title}".`);
    const source = await this.ports.getConversation(conversationId).catch(() => null);
    const fresh = await this.ports.createConversation(input.projectId, directive.title);
    const now = new Date(this.ports.now()).toISOString();
    const seeded: ConversationRecord = {
      ...fresh,
      title: directive.title.slice(0, 120),
      activeAgent: input.agent,
      execution: input.execution,
      route: input.route,
      autonomy: input.autonomy,
      turns: [
        {
          id: `turn_${crypto.randomUUID()}`,
          role: 'user',
          text: `I am continuing "${source?.title ?? 'an earlier task'}" in a new tab. Here is what is left:\n\n${directive.briefing}`,
          createdAt: now,
        },
        { id: `turn_${crypto.randomUUID()}`, role: 'assistant', text: 'I have the briefing and will carry on from here.', createdAt: now },
      ],
    };
    const saved = await this.ports.saveConversation(seeded);
    this.ports.openNewTab(owner, saved);
    this.state(conversationId).splitCount += 1;
    this.record(conversationId, owner, 'split', `"${directive.title}" has its own tab now; this one stops here and the new one carries on.`);
    // Not awaited: this run is finished, and the new tab's session runs on its own.
    void this.start(
      { ...input, conversationId: saved.id, prompt: 'Carry on with the work described in the briefing above.', turnsUsed: 0, splitDepth: input.splitDepth + 1 },
      owner,
      { opened: true },
    ).catch(() => undefined);
  }

  private async rest(conversationId: string, active: ActiveAutoRun, ms: number, reason: string): Promise<void> {
    const state = this.state(conversationId);
    const resumeAt = new Date(this.ports.now() + ms);
    state.resumeAt = resumeAt.toISOString();
    state.restReason = reason.slice(0, 400);
    this.phase(conversationId, active.ownerWindowId, 'cooling', `The provider's limit is reached. Resting until ${clock(state.resumeAt)}, then carrying on.`);
    this.record(conversationId, active.ownerWindowId, 'rest', `Rate limited. Resting ${formatDuration(ms)} (rest ${active.restStreak} in a row).`);
    try {
      await sleepAbortable(ms, active.controller.signal);
    } finally {
      state.resumeAt = null;
      state.restReason = null;
    }
  }

  /** Parks the loop on something only a person can settle, and waits until they press Resume. */
  private async pauseForHuman(conversationId: string, active: ActiveAutoRun, reason: AutoWaitReason | null, detail: string): Promise<void> {
    if (active.controller.signal.aborted) return;
    const state = this.state(conversationId);
    active.pauseReason = reason;
    state.waitReason = reason;
    state.waitDetail = detail.slice(0, 600);
    this.phase(conversationId, active.ownerWindowId, 'waiting-for-you', detail);
    // A pause a person asked for, or one waiting on their answer, is not a problem to flag at them.
    const kind = reason === null || reason === 'approval' ? 'info' : 'warn';
    this.record(conversationId, active.ownerWindowId, kind, detail.slice(0, 500));
    await new Promise<void>((resolve) => { active.wake = resolve; });
    active.wake = null;
    active.pauseReason = null;
    state.waitReason = null;
    state.waitDetail = null;
  }

  private fresh(conversation: ConversationRecord, input: AutoStartInput, command: string): AutoStatus {
    const now = new Date(this.ports.now()).toISOString();
    return {
      conversationId: conversation.id,
      projectId: input.projectId,
      phase: 'starting',
      message: 'Starting.',
      turnCount: input.turnsUsed,
      maxTurns: input.maxTurns,
      checkCommand: command,
      checkStatus: 'unknown',
      activeProvider: input.execution,
      fallbackProvider: null,
      cliResumeAt: null,
      resumeAt: null,
      restReason: null,
      waitReason: null,
      waitDetail: null,
      splitCount: 0,
      costUsd: 0,
      startedAt: now,
      updatedAt: now,
      log: [],
    };
  }

  private state(conversationId: string): AutoStatus {
    const state = this.statuses.get(conversationId);
    if (!state) throw new Error('Auto has no state for this conversation.');
    return state;
  }

  private phase(conversationId: string, owner: number, phase: AutoStatus['phase'], message: string): void {
    const state = this.state(conversationId);
    state.phase = phase;
    state.message = message.slice(0, 600);
    this.publish(conversationId, owner);
  }

  private settle(conversationId: string, owner: number, phase: 'finished' | 'stopped' | 'failed', message: string): void {
    const state = this.state(conversationId);
    state.resumeAt = null;
    state.restReason = null;
    state.waitReason = null;
    state.waitDetail = null;
    this.record(conversationId, owner, phase === 'failed' ? 'warn' : 'info', message);
    this.phase(conversationId, owner, phase, message);
  }

  private record(conversationId: string, owner: number, kind: AutoLogEntry['kind'], text: string): void {
    const state = this.state(conversationId);
    state.log = [...state.log, { at: new Date(this.ports.now()).toISOString(), kind, text: text.slice(0, 500) }].slice(-LOG_LIMIT);
    this.publish(conversationId, owner);
  }

  private publish(conversationId: string, owner: number): void {
    const state = this.state(conversationId);
    state.updatedAt = new Date(this.ports.now()).toISOString();
    this.ports.announce(owner, state);
  }
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
