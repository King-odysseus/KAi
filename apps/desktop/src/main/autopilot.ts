import { isUiCard, readyCards } from '@kai/contracts';
import type {
  AgentRunRequest,
  AgentRunResult,
  AppSettings,
  ArtifactKind,
  AutopilotLogEntry,
  AutopilotStartInput,
  AutopilotStatus,
  BoardCard,
  BoardStatus,
  CardCheck,
  CardRun,
  ConversationRecord,
  StudioBoard,
} from '@kai/contracts';
import { boardCardPrompt } from './board-brief';
import { cooldownMs, detectRateLimit, RequestPacer, sleepAbortable } from './rate-limit';

/** Who the board shows as holding a card Autopilot is working, so a restart can pick the same card back up. */
export const AUTOPILOT_AGENT = 'Autopilot';
/**
 * Resting time allowed between two finished cards. A five-hour usage window plus a late reset fits; a provider that is
 * still refusing after this long has run out of something a rest cannot fix, such as credit.
 */
const MAX_REST_WITHOUT_PROGRESS_MS = 9 * 3_600_000;
const LOG_LIMIT = 60;
const TAIL_CHARS = 2_500;

export interface AutopilotCheckResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  /** The verification run the result was filed under; the board's `done` rule re-reads it. */
  runId: string | null;
}

export interface AutopilotPorts {
  settings(): Promise<AppSettings>;
  board(projectId: string): Promise<StudioBoard>;
  artifactsFor(projectId: string): Promise<Partial<Record<ArtifactKind, string>>>;
  claimCard(projectId: string, cardId: string, agent: string): Promise<BoardCard>;
  recordCardRun(projectId: string, cardId: string, run: CardRun): Promise<BoardCard>;
  setCheck(projectId: string, cardId: string, check: CardCheck): Promise<BoardCard>;
  /** Moves a card for a reason a person can read. `done` goes through the board's own rule and may throw. */
  moveCard(projectId: string, cardId: string, status: BoardStatus, note: string, by: 'agent' | 'check'): Promise<BoardCard>;
  /** The visual check for a component or page card; it files its own result on the card. */
  checkUi(projectId: string, card: BoardCard): Promise<{ passed: boolean; summary: string }>;
  createConversation(projectId: string, title: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  runCheck(projectId: string, command: string, signal: AbortSignal): Promise<AutopilotCheckResult>;
  suggestCheck(projectId: string): Promise<string | null>;
  changedFilesFor(projectId: string): Promise<string[]>;
  /** Turns request pacing on for the Direct API runtime while a job runs, and off again after. */
  setPacer(pacer: RequestPacer | undefined): void;
  announce(ownerWindowId: number, status: AutopilotStatus): void;
  /**
   * Makes sure the plan can run agents, throwing a message a person can act on if it cannot. It runs before a single
   * card is touched, so a setup problem never turns into a board full of blocked cards.
   */
  preflight(projectId: string): Promise<void>;
  /** Takes the window to the conversation the agent is working in, so the person can watch. */
  openConversation(ownerWindowId: number, conversation: ConversationRecord): void;
  now(): number;
}

interface ActiveRun {
  controller: AbortController;
  ownerWindowId: number;
  conversationId: string | null;
  done: Promise<void>;
  /** The window has been taken to the composer once; it is not dragged back on every card. */
  opened: boolean;
  /** Cards this run parked as blocked, and why, so a setup failure can put them back. */
  blocked: Array<{ id: string; reason: string }>;
  /** Cards this run actually closed. Any at all means the setup works and a block is about that card. */
  completed: number;
}

/** Nothing works: several cards parked and not one finished, so the run stops and puts them back rather than the board. */
class SystemicFailure extends Error {}

/**
 * How many cards one run may park before giving up, provided it has not closed a single one in the meantime.
 *
 * It used to give up after two cards failed with the same message, which sounded like a setup problem but is also
 * exactly what a missing resource looks like: a design tool that is not open, a service that is down, a credential
 * nobody has added yet. Those block the cards that need them and nothing else, and stopping the whole run for them
 * means the work that needs nothing stops too — while the person goes off to open the tool. Park them, say so, and
 * carry on with the rest.
 */
const BLOCKED_BEFORE_GIVING_UP = 3;

/**
 * Works a Project Studio board to the end without anyone watching. It is deliberately a thin loop over what already
 * exists: the board decides what is ready and what counts as done, the agent runtime does the work, and the only new
 * judgement here is when to rest. A card is only closed through the board's own rule, so Autopilot can fail a card
 * but cannot talk its way past the check.
 */
export class DesktopAutopilot {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly statuses = new Map<string, AutopilotStatus>();

  constructor(private readonly ports: AutopilotPorts) {}

  status(projectId: string): AutopilotStatus | null {
    return this.statuses.get(projectId) ?? null;
  }

  isRunning(projectId: string): boolean {
    return this.runs.has(projectId);
  }

  async start(input: AutopilotStartInput, ownerWindowId: number): Promise<AutopilotStatus> {
    if (this.runs.has(input.projectId)) throw new Error('Autopilot is already running on this project.');
    const board = await this.ports.board(input.projectId);
    if (board.cards.length === 0) throw new Error('The board has no cards yet. Plan the board in the Studio first.');
    await this.ports.preflight(input.projectId);
    const settings = await this.ports.settings();
    const label = AUTOPILOT_AGENT;
    const active: ActiveRun = { controller: new AbortController(), ownerWindowId, conversationId: null, done: Promise.resolve(), opened: false, blocked: [], completed: 0 };
    this.runs.set(input.projectId, active);
    const state = this.fresh(input.projectId, board);
    this.statuses.set(input.projectId, state);
    this.record(input.projectId, ownerWindowId, 'info', 'Autopilot started.');
    active.done = this.drive(input, settings, label, active).finally(() => {
      this.runs.delete(input.projectId);
      this.ports.setPacer(undefined);
    });
    return this.statuses.get(input.projectId)!;
  }

  async stop(projectId: string): Promise<AutopilotStatus | null> {
    const active = this.runs.get(projectId);
    if (!active) return this.status(projectId);
    active.controller.abort(new Error('Autopilot was stopped.'));
    if (active.conversationId) this.ports.cancelAgent(active.conversationId);
    await active.done;
    return this.status(projectId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((projectId) => this.stop(projectId)));
  }

  private async drive(input: AutopilotStartInput, settings: AppSettings, label: string, active: ActiveRun): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const startedAt = this.ports.now();
    const deadline = input.maxHours > 0 ? startedAt + input.maxHours * 3_600_000 : Infinity;
    // Pacing is only worth the bookkeeping for Direct API runs; a CLI agent paces itself.
    if (input.execution === 'api') this.ports.setPacer(new RequestPacer({ maxConcurrent: 2, minGapMs: input.minGapSeconds * 1_000 }));
    const command = input.checkCommand.trim() || (await this.ports.suggestCheck(projectId).catch(() => null)) || '';
    if (!command) this.record(projectId, owner, 'warn', 'No check command is set and none was detected, so cards cannot be closed. They will stop in review.');
    try {
      for (;;) {
        const state = this.state(projectId);
        if (active.controller.signal.aborted) return this.settle(projectId, owner, 'stopped', 'Autopilot was stopped.');
        const limit = this.limitReached(input, state, deadline);
        if (limit) return this.settle(projectId, owner, 'finished', limit);

        const board = await this.ports.board(projectId);
        this.counts(projectId, board);
        const card = board.cards.find((item) => item.status === 'inProgress' && item.claimedBy === label) ?? readyCards(board)[0];
        if (!card) return this.settle(projectId, owner, 'finished', this.boardSummary(board));

        state.cardsWorked += 1;
        await this.workCard(input, settings, label, card, command, active);
      }
    } catch (error) {
      if (active.controller.signal.aborted) return this.settle(projectId, owner, 'stopped', 'Autopilot was stopped.');
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SystemicFailure) {
        const restored = await this.putBack(projectId, active.blocked.map((item) => item.id), 'Autopilot stopped on a setup problem, so this card was put back untouched.');
        this.record(projectId, owner, 'warn', `${message}${restored > 0 ? ` ${restored} card${restored === 1 ? ' was' : 's were'} put back in the queue.` : ''}`);
        return this.settle(projectId, owner, 'failed', `${message}${restored > 0 ? ` The ${restored} card${restored === 1 ? '' : 's'} it had parked ${restored === 1 ? 'was' : 'were'} put back.` : ''}`);
      }
      this.record(projectId, owner, 'warn', message);
      return this.settle(projectId, owner, 'failed', message);
    }
  }

  /** One card, from claim to done or blocked. Rests happen inside; they never use up one of the card's attempts. */
  private async workCard(input: AutopilotStartInput, settings: AppSettings, label: string, card: BoardCard, command: string, active: ActiveRun): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const signal = active.controller.signal;
    const state = this.state(projectId);
    state.cardId = card.id;
    state.cardTitle = card.title;
    await this.ports.claimCard(projectId, card.id, label);
    this.record(projectId, owner, 'card', `Working on "${card.title}".`);

    let failure = '';
    for (let attempt = 1; attempt <= input.attemptsPerCard; attempt += 1) {
      state.attempt = attempt;
      this.phase(projectId, owner, 'working', `Working on "${card.title}"${attempt > 1 ? ` (attempt ${attempt} of ${input.attemptsPerCard})` : ''}.`);
      const artifacts = await this.ports.artifactsFor(projectId).catch(() => ({}));
      const base = boardCardPrompt(card, artifacts);
      const conversation = await this.ports.createConversation(projectId, `Autopilot: ${card.title}`.slice(0, 120));
      active.conversationId = conversation.id;
      state.conversationId = conversation.id;
      this.ports.announce(owner, state);
      if (!active.opened) {
        active.opened = true;
        this.ports.openConversation(owner, conversation);
      }

      const run = await this.runResting(input, settings, conversation.id, base, failure, active);
      active.conversationId = null;
      state.conversationId = null;
      await this.ports.recordCardRun(projectId, card.id, {
        agent: input.execution === 'api' ? 'api' : (input.agent ?? settings.defaultAgent),
        model: input.model ?? null,
        at: new Date(this.ports.now()).toISOString(),
        files: await this.ports.changedFilesFor(projectId).catch(() => []),
      });
      if (run.failed) {
        failure = `The last attempt ended with an error: ${run.error}`;
        this.record(projectId, owner, 'warn', `"${card.title}" failed: ${run.error.slice(0, 200)}`);
        continue;
      }
      if (!command) {
        await this.ports.moveCard(projectId, card.id, 'review', 'Autopilot finished the work but has no check command, so a person has to close it.', 'agent');
        this.record(projectId, owner, 'warn', `"${card.title}" is in review: there is no check command.`);
        state.restStreak = 0;
        return;
      }

      this.phase(projectId, owner, 'checking', `Checking "${card.title}".`);
      const check = await this.ports.runCheck(projectId, command, signal);
      if (!check.passed || !check.runId) {
        failure = `The check \`${command}\` failed${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}. Fix the cause, do not weaken the check. Output:\n${check.output.slice(-TAIL_CHARS)}`;
        this.record(projectId, owner, 'check', `Check failed for "${card.title}".`);
        continue;
      }
      await this.ports.setCheck(projectId, card.id, {
        runId: check.runId,
        at: new Date(this.ports.now()).toISOString(),
        visual: isUiCard(card) ? null : 'skipped',
        screenshots: [],
      });
      if (isUiCard(card)) {
        const visual = card.route
          ? await this.ports.checkUi(projectId, card).catch((error: unknown) => ({ passed: false, summary: error instanceof Error ? error.message : String(error) }))
          : { passed: false, summary: 'The card has no route, so there is no screen to check.' };
        if (!visual.passed) {
          failure = `The build passes but the screen check did not: ${visual.summary}`;
          this.record(projectId, owner, 'check', `Screen check failed for "${card.title}".`);
          // The visual check hands a failed card back to `ready`; take it again for the next attempt.
          await this.ports.claimCard(projectId, card.id, label).catch(() => undefined);
          continue;
        }
        await this.ports.claimCard(projectId, card.id, label).catch(() => undefined);
      }
      try {
        await this.ports.moveCard(projectId, card.id, 'done', 'Autopilot: the check passed.', 'check');
      } catch (error) {
        failure = `The board would not close the card: ${error instanceof Error ? error.message : String(error)}`;
        this.record(projectId, owner, 'warn', failure.slice(0, 300));
        continue;
      }
      state.cardsDone += 1;
      state.restStreak = 0;
      this.record(projectId, owner, 'card', `"${card.title}" is done.`);
      this.counts(projectId, await this.ports.board(projectId));
      return;
    }

    await this.ports.moveCard(projectId, card.id, 'blocked', `Autopilot gave up after ${input.attemptsPerCard} attempts. ${failure}`.slice(0, 3_900), 'agent');
    active.blocked.push({ id: card.id, reason: failure });
    state.cardsBlocked += 1;
    const lastTwo = active.blocked.slice(-2);
    if (lastTwo.length === 2 && lastTwo[0]!.reason === lastTwo[1]!.reason && lastTwo[0]!.reason.startsWith('The last attempt ended with an error:')) {
      throw new SystemicFailure(`Autopilot stopped: two cards in a row ended with exactly the same agent error, which points at the setup rather than the cards. ${failure.slice(0, 300)}`);
    }
    this.record(projectId, owner, 'warn', `"${card.title}" is blocked after ${input.attemptsPerCard} attempts; moving on.`);
  }

  /**
   * Runs the agent, and when the provider says it has had enough, rests and runs the same attempt again. The work an
   * interrupted run already did is on disk, so the rerun is told to look before it starts over.
   */
  private async runResting(
    input: AutopilotStartInput,
    settings: AppSettings,
    conversationId: string,
    base: string,
    failure: string,
    active: ActiveRun,
  ): Promise<{ failed: boolean; error: string }> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    let interrupted = false;
    let restedMs = 0;
    for (;;) {
      const prompt = [
        base,
        failure ? `\n\nThe previous attempt did not pass.\n${failure}` : '',
        interrupted ? '\n\nA previous run on this card was cut off by a rate limit. Some of the work may already be in the project: look at it first and continue from there instead of starting over.' : '',
      ].join('');
      let result: AgentRunResult | null = null;
      let thrown: unknown = null;
      try {
        result = await this.ports.runAgent({
          conversationId,
          prompt,
          agent: input.agent ?? settings.defaultAgent,
          execution: input.execution,
          route: settings.defaultRoute,
          autonomy: settings.defaultAutonomy,
          freshSession: !interrupted,
          ...(input.model ? { model: input.model } : {}),
        }, owner);
      } catch (error) {
        if (active.controller.signal.aborted) throw error;
        thrown = error;
      }
      if (result?.costUsd) this.state(projectId).costUsd += result.costUsd;

      const failed = thrown !== null || result?.status === 'failed' || Boolean(result?.error);
      if (!failed) return { failed: false, error: '' };
      if (active.controller.signal.aborted) throw new Error('Autopilot was stopped.');

      const message = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : (result?.error ?? result?.output.slice(-600) ?? 'The agent failed.');
      const limited = detectRateLimit(thrown ?? message);
      if (!limited) return { failed: true, error: message };

      interrupted = true;
      const state = this.state(projectId);
      state.restStreak += 1;
      state.restsTotal += 1;
      const wait = cooldownMs(state.restStreak, limited.retryAfterMs, limited.window);
      restedMs += wait;
      if (restedMs > MAX_REST_WITHOUT_PROGRESS_MS) {
        throw new Error(`The provider is still refusing after ${formatDuration(MAX_REST_WITHOUT_PROGRESS_MS)} of rest. It may be out of quota or credit. Check the account, then start Autopilot again; the board keeps its place.`);
      }
      await this.rest(projectId, owner, state, wait, message, active.controller.signal);
    }
  }

  /**
   * Puts the cards an earlier run parked as blocked back in the queue: ready when everything they wait on is done,
   * backlog otherwise. Only cards Autopilot itself gave up on are touched; a card a person blocked stays blocked.
   */
  async requeueBlocked(projectId: string): Promise<number> {
    if (this.runs.has(projectId)) throw new Error('Autopilot is running. Stop it before putting cards back.');
    const board = await this.ports.board(projectId);
    const mine = board.cards.filter((card) => card.status === 'blocked' && card.notes.startsWith('Autopilot gave up'));
    return this.putBack(projectId, mine.map((card) => card.id), 'Put back in the queue after Autopilot gave up on it.');
  }

  private async putBack(projectId: string, ids: readonly string[], note: string): Promise<number> {
    let restored = 0;
    for (const id of ids) {
      try {
        await this.ports.moveCard(projectId, id, 'ready', note, 'agent');
        restored += 1;
      } catch {
        // A card that still waits on others cannot be ready; the backlog is where it belongs until they are done.
        try {
          await this.ports.moveCard(projectId, id, 'backlog', note, 'agent');
          restored += 1;
        } catch {
          // Left where it is: the person can move it by hand.
        }
      }
    }
    return restored;
  }

  private async rest(projectId: string, owner: number, state: AutopilotStatus, ms: number, reason: string, signal: AbortSignal): Promise<void> {
    const resumeAt = new Date(this.ports.now() + ms);
    state.resumeAt = resumeAt.toISOString();
    state.restReason = reason.slice(0, 400);
    const clock = resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.phase(projectId, owner, 'cooling', `The provider's limit is reached. Resting until ${clock}, then carrying on with "${state.cardTitle ?? 'the card'}".`);
    this.record(projectId, owner, 'rest', `Rate limited. Resting ${formatDuration(ms)} (rest ${state.restStreak} in a row).`);
    try {
      await sleepAbortable(ms, signal);
    } finally {
      state.resumeAt = null;
      state.restReason = null;
    }
    this.phase(projectId, owner, 'working', `Back at it: "${state.cardTitle ?? 'the card'}".`);
  }

  private limitReached(input: AutopilotStartInput, state: AutopilotStatus, deadline: number): string | null {
    if (state.cardsWorked >= input.maxCards) return `Stopped after ${input.maxCards} cards, the limit set for this run.`;
    if (input.maxCostUsd > 0 && state.costUsd >= input.maxCostUsd) return `Stopped: the run's estimated spend reached $${state.costUsd.toFixed(2)}, past the $${input.maxCostUsd.toFixed(2)} limit.`;
    if (this.ports.now() >= deadline) return `Stopped after ${input.maxHours} hours, the time limit set for this run.`;
    return null;
  }

  private boardSummary(board: StudioBoard): string {
    const count = (status: BoardStatus): number => board.cards.filter((card) => card.status === status).length;
    const done = count('done');
    const parts = [`${done} of ${board.cards.length} cards are done`];
    if (count('review')) parts.push(`${count('review')} wait in review`);
    if (count('blocked')) parts.push(`${count('blocked')} are blocked`);
    const waiting = count('backlog') + count('ready');
    if (waiting) parts.push(`${waiting} are waiting on cards that are not done`);
    return `${parts.join(', ')}.`;
  }

  private fresh(projectId: string, board: StudioBoard): AutopilotStatus {
    const status: AutopilotStatus = {
      projectId,
      phase: 'working',
      message: 'Starting.',
      cardId: null,
      cardTitle: null,
      conversationId: null,
      attempt: 0,
      resumeAt: null,
      restReason: null,
      restStreak: 0,
      restsTotal: 0,
      cardsDone: 0,
      cardsBlocked: 0,
      cardsTotal: board.cards.length,
      cardsWorked: 0,
      costUsd: 0,
      startedAt: new Date(this.ports.now()).toISOString(),
      updatedAt: new Date(this.ports.now()).toISOString(),
      log: [],
    };
    this.counts(projectId, board, status);
    return status;
  }

  /** The board's own totals, so the bar reflects cards a person finished while Autopilot ran too. */
  private counts(projectId: string, board: StudioBoard, into: AutopilotStatus = this.state(projectId)): void {
    into.cardsTotal = board.cards.length;
    into.cardsDone = board.cards.filter((card) => card.status === 'done').length;
    into.cardsBlocked = board.cards.filter((card) => card.status === 'blocked').length;
  }

  private state(projectId: string): AutopilotStatus {
    const state = this.statuses.get(projectId);
    if (!state) throw new Error('Autopilot has no state for this project.');
    return state;
  }

  private phase(projectId: string, owner: number, phase: AutopilotStatus['phase'], message: string): void {
    const state = this.state(projectId);
    state.phase = phase;
    state.message = message;
    this.publish(projectId, owner);
  }

  private settle(projectId: string, owner: number, phase: 'finished' | 'stopped' | 'failed', message: string): void {
    const state = this.state(projectId);
    state.cardId = null;
    state.cardTitle = null;
    state.resumeAt = null;
    state.restReason = null;
    this.record(projectId, owner, phase === 'failed' ? 'warn' : 'info', message);
    this.phase(projectId, owner, phase, message);
  }

  private record(projectId: string, owner: number, kind: AutopilotLogEntry['kind'], text: string): void {
    const state = this.state(projectId);
    state.log = [...state.log, { at: new Date(this.ports.now()).toISOString(), kind, text: text.slice(0, 500) }].slice(-LOG_LIMIT);
    this.publish(projectId, owner);
  }

  private publish(projectId: string, owner: number): void {
    const state = this.state(projectId);
    state.updatedAt = new Date(this.ports.now()).toISOString();
    this.ports.announce(owner, state);
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1_000))} seconds`;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`;
}
