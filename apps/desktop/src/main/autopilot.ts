import { randomUUID } from 'node:crypto';
import { explainBlocked, isUiCard, machineBlocked, needsScreenCheck, readyCards } from '@kai/contracts';
import type {
  AgentRunRequest,
  AgentRunResult,
  AppSettings,
  ArtifactKind,
  AutopilotLogEntry,
  AutopilotRunRecord,
  AutopilotAuditEntry,
  AutopilotStartInput,
  AutopilotStatus,
  BoardCard,
  BoardStatus,
  CardCheck,
  CardRun,
  ConversationRecord,
  DevCheckResult,
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

/**
 * Where a run is remembered while it holds a card, so the next launch can say what happened to it.
 *
 * Deliberately not the status: that lives in memory and dies with the process. A record exists exactly while a card
 * is in the run's hands, and it is not cleared when the app is closing — which is the case the person actually hits.
 */
export interface AutopilotJournal {
  begin(record: Omit<AutopilotRunRecord, 'schemaVersion'>): Promise<void>;
  touch(studioProjectId: string, lastMessage: string): Promise<void>;
  end(studioProjectId: string): Promise<void>;
  read(studioProjectId: string): Promise<AutopilotRunRecord | null>;
  /** Everything still on disk, newest first — which at startup is every run that was interrupted. */
  list(): Promise<AutopilotRunRecord[]>;
  audit?(entry: Omit<AutopilotAuditEntry, 'schemaVersion'>): Promise<void>;
  listAudit?(projectId: string, limit?: number): Promise<AutopilotAuditEntry[]>;
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
  /** Opens the conversation one card is worked in. `card` is passed so it can be marked as Autopilot's own. */
  createConversation(projectId: string, title: string, card: Pick<BoardCard, 'id' | 'title'>): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  runCheck(projectId: string, command: string, signal: AbortSignal): Promise<AutopilotCheckResult>;
  suggestCheck(projectId: string): Promise<string | null>;
  /**
   * Starts the project on its dev server and loads the given routes, once the board is finished.
   *
   * Every other check answers "does the code hold up". This answers the one the person asks when they come back — is
   * there an app on dev I can open — and it is the only claim in this loop about the project actually running. It
   * never touches anything but the local server: there is no commit and no deploy anywhere in Autopilot.
   */
  checkDev(projectId: string, routes: readonly string[], signal: AbortSignal): Promise<DevCheckResult>;
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
  /** Remembers a run for the whole time it holds a card. Optional, so a test needs no disk. */
  journal?: AutopilotJournal;
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

/**
 * Repeated failures do not stop the run. A missing resource can affect several cards, but independent work should
 * continue while the person is away. The blocked cards remain visible with a suggested next step and can be retried
 * after the user resolves the shared problem.
 */

/**
 * The note a card carries when the agent finished its work but there was nothing to check it with. It is also how a
 * later pass finds those cards: once the project can be checked, they are closed on that check.
 */
const NO_CHECK_NOTE = 'Autopilot finished the work but has no check command, so a person has to close it.';

/** A page with nowhere to point can never pass its screen check, and the board never closes it. */
export function unclosableUiCard(card: Pick<BoardCard, 'kind' | 'route'>): boolean {
  return card.kind === 'page' && card.route.trim() === '';
}

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
    // Said before any work, because it is the thing people assume wrongly: nothing here reaches a server anyone else
    // can see. The run only ever touches this machine, and the only environment it can leave the project in is dev.
    this.record(input.projectId, ownerWindowId, 'info', 'Working on this machine only: Autopilot never commits and never deploys.');
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

  /** The runs KAI was closed in the middle of, newest first. Nothing is running for any of them. */
  async interrupted(): Promise<AutopilotRunRecord[]> {
    return (await this.ports.journal?.list().catch(() => [])) ?? [];
  }

  async audit(projectId: string): Promise<AutopilotAuditEntry[]> {
    return (await this.ports.journal?.listAudit?.(projectId, 100).catch(() => [])) ?? [];
  }

  /**
   * Carries on with a run that was interrupted.
   *
   * This is the ordinary start, from the settings the run was given: the board still holds its card under the
   * Autopilot's name, and the loop prefers a card it is already holding over a fresh one — so the place is kept
   * without any of it being re-derivable here.
   */
  async resumeInterrupted(studioProjectId: string, ownerWindowId: number): Promise<AutopilotStatus> {
    const record = await this.ports.journal?.read(studioProjectId);
    if (!record) throw new Error('That interrupted run is no longer on disk.');
    return this.start(record.start, ownerWindowId);
  }

  /**
   * Puts the card an interrupted run was holding back in the queue, for someone who would rather start it clean.
   * Nothing is running, so the board's own move rule is the only thing that can refuse.
   */
  async releaseInterrupted(studioProjectId: string): Promise<boolean> {
    const record = await this.ports.journal?.read(studioProjectId);
    if (!record) return false;
    const board = await this.ports.board(studioProjectId);
    const card = board.cards.find((item) => item.id === record.cardId);
    // The record is cleared in the same breath as the card leaving the run's hands, but a close can land between the
    // two. A card the run actually finished is done, and moving it back would be undoing real work to tidy up a file.
    if (!card || card.status !== 'inProgress') {
      await this.forget(studioProjectId);
      return false;
    }
    const restored = await this.putBack(studioProjectId, [record.cardId], 'Put back in the queue after an Autopilot run stopped holding it.');
    await this.forget(studioProjectId);
    return restored > 0;
  }

  private async drive(input: AutopilotStartInput, settings: AppSettings, label: string, active: ActiveRun): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const startedAt = this.ports.now();
    const deadline = input.maxHours > 0 ? startedAt + input.maxHours * 3_600_000 : Infinity;
    // Pacing is only worth the bookkeeping for Direct API runs; a CLI agent paces itself.
    if (input.execution === 'api') this.ports.setPacer(new RequestPacer({ maxConcurrent: 2, minGapMs: input.minGapSeconds * 1_000 }));
    let command = input.checkCommand.trim() || (await this.ports.suggestCheck(projectId).catch(() => null)) || '';
    if (!command) this.record(projectId, owner, 'warn', 'No check command is set and none was detected, so cards cannot be closed. They will stop in review.');
    await this.noteProvisionalDesign(projectId, owner);
    try {
      for (;;) {
        const state = this.state(projectId);
        if (active.controller.signal.aborted) return this.settle(projectId, owner, 'stopped', 'Autopilot was stopped.');
        const limit = this.limitReached(input, state, deadline);
        if (limit) return this.settle(projectId, owner, 'finished', limit);

        const board = await this.ports.board(projectId);
        this.counts(projectId, board);
        // The scaffold card is what creates the project's manifest, so a project that had nothing to check when the
        // run began can have something by now. Looked for again, because without a check the scaffold card waits in
        // review for a person and every card behind it waits on that.
        if (!command) command = input.checkCommand.trim() || (await this.ports.suggestCheck(projectId).catch(() => null)) || '';
        if (command && (await this.settleReviewed(input, label, board, command, active))) continue;
        const card = board.cards.find((item) => item.status === 'inProgress' && item.claimedBy === label) ?? readyCards(board)[0];
        if (!card) {
          await this.proveDev(projectId, owner, board, active);
          const summary = this.boardSummary(board);
          const dev = this.state(projectId).devCheck;
          return this.settle(projectId, owner, 'finished', dev ? `${summary} ${dev.summary}` : summary);
        }

        state.cardsWorked += 1;
        await this.workCard(input, settings, label, card, command, active);
      }
    } catch (error) {
      if (active.controller.signal.aborted) return this.settle(projectId, owner, 'stopped', 'Autopilot was stopped.');
      const message = error instanceof Error ? error.message : String(error);
      this.record(projectId, owner, 'warn', message);
      return this.settle(projectId, owner, 'failed', message);
    }
  }

  /**
   * Says out loud that the design is behind, once, before any card is touched.
   *
   * This is the case that used to go wrong silently. A UI card needs `tokens`, the tokens had never been written, and
   * the brief told the agent to ask for them rather than invent them — so the agent stopped, the check never passed,
   * and the card was parked. The brief no longer says that, and this is the other half: the run says a provisional
   * look is being used, so nobody has to work it out from a board full of blocked cards.
   */
  private async noteProvisionalDesign(projectId: string, owner: number): Promise<void> {
    const [board, written] = await Promise.all([
      this.ports.board(projectId).catch(() => null),
      this.ports.artifactsFor(projectId).catch(() => ({} as Partial<Record<ArtifactKind, string>>)),
    ]);
    if (!board) return;
    const have = new Set(Object.keys(written));
    const needed = board.cards.flatMap((card) => card.needsArtifacts).filter((kind) => kind === 'tokens' || kind === 'style-guide');
    const missing = [...new Set(needed.filter((kind) => !have.has(kind)))];
    if (missing.length === 0) return;
    this.record(
      projectId,
      owner,
      'info',
      `The ${missing.join(' and the ')} ${missing.length === 1 ? 'is' : 'are'} not written yet, so the screens are built to a provisional look taken from the brief. Nothing stops for this. Share reference images or draw the screens in open-pencil, then pull the design to restyle them.`,
    );
  }

  /**
   * The dev proof, taken once the board is finished: start the app and load its pages.
   *
   * Only when every card is done, because a half-built project is not expected to run and failing it would read as a
   * fault in the loop rather than an honest description of a job half done. The result is kept on the status rather
   * than left in the log so the screen can name the URL, and the server is deliberately left up: someone coming back
   * to a finished run should find an app they can open, not a report that one existed.
   */
  private async proveDev(projectId: string, owner: number, board: StudioBoard, active: ActiveRun): Promise<void> {
    if (board.cards.length === 0 || !board.cards.every((card) => card.status === 'done')) return;
    const routes = [...new Set(['/', ...board.cards.filter(isUiCard).map((card) => card.route.trim()).filter(Boolean)])];
    this.phase(projectId, owner, 'checking', 'Every card is done. Starting the app on dev to check it runs.');
    const result = await this.ports.checkDev(projectId, routes, active.controller.signal).catch((error: unknown): DevCheckResult => ({
      passed: false,
      summary: `The dev check could not run: ${error instanceof Error ? error.message : String(error)}`,
      url: null,
      routes: [],
    }));
    // A run stopped mid-proof has no answer to give, and recording an aborted check as a failure would blame the
    // project for the person's own Stop.
    if (active.controller.signal.aborted) return;
    this.state(projectId).devCheck = result;
    this.record(projectId, owner, result.passed ? 'check' : 'warn', result.summary);
  }

  /** One card, from claim to done or blocked. Rests happen inside; they never use up one of the card's attempts. */
  private async workCard(input: AutopilotStartInput, settings: AppSettings, label: string, card: BoardCard, command: string, active: ActiveRun): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const signal = active.controller.signal;
    const state = this.state(projectId);
    // A screen card with no route cannot pass its screen check however many times it is run, and the board will not
    // close a screen card without one. Parking it says so once, in the card's own words, instead of spending three
    // paid agent turns proving it again — which is what happened on 2026-10-04, when four such cards were worked
    // three times each and then gated thirty-seven others behind them.
    if (unclosableUiCard(card)) {
      await this.ports.moveCard(projectId, card.id, 'blocked', 'No route: this card is a screen, and the board will not close a screen card without a passing screen check, which needs a route to open. Set the route on the card, then put it back in the queue.', 'agent');
      this.record(projectId, owner, 'warn', `"${card.title}" is blocked: it is a screen card with no route, so its check can never pass.`);
      return;
    }
    state.cardId = card.id;
    state.cardTitle = card.title;
    await this.ports.claimCard(projectId, card.id, label);
    // Written before the log line, not after: the line's own `touch` would have nothing to attach itself to, and the
    // report of an interrupted run would name the previous card's work for as long as this one took to say anything.
    // From here until the card leaves the board, a close leaves a card in this run's hands — and this is what says so.
    await this.keep((journal) => journal.begin({
      studioProjectId: projectId,
      cardId: card.id,
      cardTitle: card.title,
      startedAt: new Date(this.ports.now()).toISOString(),
      updatedAt: new Date(this.ports.now()).toISOString(),
      lastMessage: `Working on "${card.title}".`,
      start: input,
    }));
    this.record(projectId, owner, 'card', `Working on "${card.title}".`);

    let failure = '';
    // How many attempts were actually made, which is fewer than the limit when the card is given up on early.
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= input.attemptsPerCard; attempt += 1) {
      attemptsMade = attempt;
      state.attempt = attempt;
      this.phase(projectId, owner, 'working', `Working on "${card.title}"${attempt > 1 ? ` (attempt ${attempt} of ${input.attemptsPerCard})` : ''}.`);
      const artifacts = await this.ports.artifactsFor(projectId).catch(() => ({}));
      const base = `${boardCardPrompt(card, artifacts)}\n\nAUTOPILOT BLOCKER POLICY:\n${input.blockerPolicy === 'continue-and-use-decisions'
        ? 'If this card is blocked, read the approved project decisions above and apply one only when its conditions genuinely match. Report which decision you applied and continue independent cards.'
        : 'If this card is blocked, report the exact blocker and a practical next step. Do not wait for the user; independent cards must continue.'}`;
      const conversation = await this.ports.createConversation(projectId, `Autopilot: ${card.title}`.slice(0, 120), card);
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
        await this.ports.moveCard(projectId, card.id, 'review', NO_CHECK_NOTE, 'agent');
        await this.forget(projectId);
        this.record(projectId, owner, 'warn', `"${card.title}" is in review: there is no check command.`);
        state.restStreak = 0;
        return;
      }

      const verdict = await this.checkAndClose(projectId, owner, label, card, command, signal);
      if (!verdict.closed) {
        // The same refusal twice, word for word, means the attempt changed nothing the check looks at. A third turn
        // costs another ten minutes to hear it again — on 2026-10-19 one such refusal took three turns on each of
        // twenty-eight cards — so the card is parked with the reason now.
        const repeated = verdict.failure === failure;
        failure = verdict.failure;
        if (repeated) break;
        continue;
      }
      state.cardsDone += 1;
      state.restStreak = 0;
      await this.forget(projectId);
      this.record(projectId, owner, 'card', `"${card.title}" is done.`);
      this.counts(projectId, await this.ports.board(projectId));
      return;
    }

    await this.ports.moveCard(projectId, card.id, 'blocked', `Autopilot gave up after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}${attemptsMade < input.attemptsPerCard ? ', the same failure each time' : ''}. ${failure}`.slice(0, 3_900), 'agent');
    await this.forget(projectId);
    active.blocked.push({ id: card.id, reason: failure });
    state.cardsBlocked += 1;
    const explanation = explainBlocked(failure);
    this.record(projectId, owner, 'warn', `"${card.title}" is blocked after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}${attemptsMade < input.attemptsPerCard ? ' with the same failure each time' : ''}; moving on. ${explanation.ask}`);
  }

  /**
   * Runs the check for one card and, when it passes, closes the card: the build check, then the screen check for a
   * card that has a screen. The board has the last word, as ever: a card it will not close comes back with its reason.
   */
  private async checkAndClose(projectId: string, owner: number, label: string, card: BoardCard, command: string, signal: AbortSignal): Promise<{ closed: boolean; failure: string }> {
    this.phase(projectId, owner, 'checking', `Checking "${card.title}".`);
    const check = await this.ports.runCheck(projectId, command, signal);
    if (!check.passed || !check.runId) {
      this.record(projectId, owner, 'check', `Check failed for "${card.title}".`);
      return { closed: false, failure: `The check \`${command}\` failed${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}. Fix the cause, do not weaken the check. Output:\n${check.output.slice(-TAIL_CHARS)}` };
    }
    await this.ports.setCheck(projectId, card.id, {
      runId: check.runId,
      at: new Date(this.ports.now()).toISOString(),
      visual: needsScreenCheck(card) ? null : 'skipped',
      screenshots: [],
      acceptanceEvidence: card.acceptance.map((criterion) => ({
        criterion,
        status: 'passed' as const,
        evidence: `Verification run ${check.runId} passed: ${command}`,
      })),
    });
    if (needsScreenCheck(card)) {
      const visual = card.route
        ? await this.ports.checkUi(projectId, card).catch((error: unknown) => ({ passed: false, summary: error instanceof Error ? error.message : String(error) }))
        : { passed: false, summary: 'The card has no route, so there is no screen to check.' };
      // The visual check hands a failed card back to `ready`; take it again for whatever comes next.
      await this.ports.claimCard(projectId, card.id, label).catch(() => undefined);
      if (!visual.passed) {
        this.record(projectId, owner, 'check', `Screen check failed for "${card.title}".`);
        return { closed: false, failure: `The build passes but the screen check did not: ${visual.summary}` };
      }
    }
    try {
      await this.ports.moveCard(projectId, card.id, 'done', 'Autopilot: the check passed.', 'check');
    } catch (error) {
      const failure = `The board would not close the card: ${error instanceof Error ? error.message : String(error)}`;
      this.record(projectId, owner, 'warn', failure.slice(0, 300));
      return { closed: false, failure };
    }
    return { closed: true, failure: '' };
  }

  /**
   * Closes the cards Autopilot parked in review for want of a check, now that there is one. Those are the cards a run
   * could do the work for but not prove — the scaffold card above all, which every other card waits behind. A card
   * whose check still fails stays in review with the reason in the log; it is not worked again here.
   */
  private async settleReviewed(input: AutopilotStartInput, label: string, board: StudioBoard, command: string, active: ActiveRun): Promise<boolean> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const waiting = board.cards.filter((card) => card.status === 'review' && !card.check && card.notes.includes(NO_CHECK_NOTE));
    let closed = false;
    for (const card of waiting) {
      if (active.controller.signal.aborted) break;
      const verdict = await this.checkAndClose(projectId, owner, label, card, command, active.controller.signal);
      if (verdict.closed) {
        const state = this.state(projectId);
        state.cardsDone += 1;
        this.record(projectId, owner, 'card', `"${card.title}" is done: it was waiting in review for a check, and the check now passes.`);
        closed = true;
      } else {
        this.record(projectId, owner, 'warn', `"${card.title}" is still in review: ${verdict.failure.slice(0, 200)}`);
      }
    }
    return closed;
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
   * Puts the cards a machine parked as blocked back in the queue: ready when everything they wait on is done,
   * backlog otherwise. Every machine that parks a card is covered; a card a person blocked stays blocked.
   */
  async requeueBlocked(projectId: string): Promise<number> {
    if (this.runs.has(projectId)) throw new Error('Autopilot is running. Stop it before putting cards back.');
    const board = await this.ports.board(projectId);
    const mine = board.cards.filter(machineBlocked);
    return this.putBack(projectId, mine.map((card) => card.id), 'Put back in the queue after an agent stopped on it.');
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
      devCheck: null,
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
    const at = new Date(this.ports.now()).toISOString();
    const bounded = text.slice(0, 500);
    state.log = [...state.log, { at, kind, text: bounded }].slice(-LOG_LIMIT);
    // Best effort and not awaited: this is the line an interrupted run is reported with, so an older one costs
    // nothing but a slightly stale sentence, and waiting on a disk write here would stall the run itself.
    void this.keep((journal) => journal.touch(projectId, text));
    void this.keep(async (journal) => {
      await journal.audit?.({ id: `audit_${randomUUID()}`, projectId, at, kind, text: bounded, cardId: state.cardId });
    });
    this.publish(projectId, owner);
  }

  /**
   * Writes to the run's journal, best effort. A board that cannot reach its own disk should still be workable, and
   * every caller here is recording something for after the app is gone rather than deciding anything now.
   */
  private async keep(action: (journal: AutopilotJournal) => Promise<void>): Promise<void> {
    const journal = this.ports.journal;
    if (!journal) return;
    await action(journal).catch(() => undefined);
  }

  /** The card is no longer in this run's hands, so there is nothing left for the next launch to explain. */
  private async forget(projectId: string): Promise<void> {
    await this.keep((journal) => journal.end(projectId));
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
