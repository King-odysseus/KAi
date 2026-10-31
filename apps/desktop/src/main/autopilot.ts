import { randomUUID } from 'node:crypto';
import { explainBlocked, isSystemSurface, isUiCard, machineBlocked, needsScreenCheck, readyCards } from '@kai/contracts';
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
import type { ParallelSession } from './parallel-session';
import { stylesheetVerdict } from './stylesheet-guard';

/** Who the board shows as holding a card Autopilot is working, so a restart can pick the same card back up. */
export const AUTOPILOT_AGENT = 'Autopilot';
/**
 * Resting time allowed between two finished cards. A five-hour usage window plus a late reset fits; a provider that is
 * still refusing after this long has run out of something a rest cannot fix, such as credit.
 */
const MAX_REST_WITHOUT_PROGRESS_MS = 9 * 3_600_000;
const LOG_LIMIT = 60;
/** A card's own request, and up to three read-only helper calls the model makes at once beside it. */
const API_REQUESTS_PER_CARD = 4;
/** Different cards in a row failing the same way before the project's own check is looked at. */
const BASELINE_SAMPLE = 3;
/** How many times an agent is given the project's own broken check to fix before the run stops. */
const BASELINE_REPAIR_ATTEMPTS = 2;
/** Times a run starts itself again after an unexpected problem before it gives up and says so. */
const MAX_AUTO_RESTARTS = 2;
const RESTART_PAUSE_MS = 20_000;
/** Cards in a row that hit a problem of their own, with none finishing between, before the run stops. */
const MAX_PROBLEM_STREAK = 5;
/** Copies of the project that cannot be made in a row before the run stops trying and works one card at a time. */
const MAX_COPY_FAILURES = 3;
/** A card's recorded list of changed files longer than this is the whole project's uncommitted files, not the card's. */
const TRUSTED_FILE_LIST = 15;

/**
 * A problem that has to end the run, as against one that only costs a card or a restart: the project's own check is
 * broken and could not be fixed, or the provider is out of quota. Anything else is handled where it happens.
 */
export class AutopilotStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutopilotStop';
  }
}
/** Times a card is run again on top of what is in the project when its changes met something else's. */
const MAX_CLASH_RERUNS = 2;
/** How much later each further card of a wave starts than the one before it. */
const LANE_STAGGER_MS = 400;
/** Tries at claiming a card when the board keeps reporting that it changed underneath the claim. */
const CLAIM_ATTEMPTS = 6;
const TAIL_CHARS = 2_500;

/** What a card's agent is told about helpers. A card is the unit of work; a helper is a way to finish one faster. */
const HELPERS_CLI = 'HELPERS:\nIf this card has separate parts that do not touch the same files (for example a page, its tests and its styles), hand them to sub-agents with the Task tool so they run at once, then check their work together before you finish. Do not use helpers for a small card, and never for two parts that edit the same file.';
const HELPERS_API = 'HELPERS:\nYou can start helpers with the `task` tool and call it several times in one turn so they run at once. A helper reads and searches by default. Set write to true for a helper that writes code: give it separate files that no other helper touches (for example a page, its tests and its styles), and say which files it owns. Do not use helpers for a small card.';

/** Files that nearly every card touches a little, so two cards naming one of them are likely to clash in a merge. */
const SHARED_FILES = /\b(package\.json|package-lock\.json|app\.tsx?|main\.tsx?|router|routes?\.tsx?|layout\.tsx?|globals?\.css|index\.css|tailwind\.config|tsconfig\.json|vite\.config)\b/gi;
const FILE_NAMES = /[\w./@-]+\.(?:tsx?|jsx?|css|scss|json|md|html|py|rs|go|vue|svelte)\b/gi;

/** The files a card is likely to write: the ones its brief names, and the ones its earlier runs changed. */
export function touchedPaths(card: BoardCard): Set<string> {
  const text = [card.prompt, card.story, ...card.acceptance].join(' ');
  const named = [...(text.match(FILE_NAMES) ?? []), ...(text.match(SHARED_FILES) ?? [])];
  // Recorded as every uncommitted file in the project, so on a project with work in progress every card claimed to
  // touch every file and no two could run side by side. A list that long is not this card's.
  const recorded = card.runs.at(-1)?.files ?? [];
  const before = recorded.length <= TRUSTED_FILE_LIST ? recorded : [];
  return new Set([...named, ...before].map((file) => file.toLowerCase().replace(/^\.?\//, '')));
}

/**
 * The cards to work side by side, taken in queue order. A card joins only if it is not likely to touch a file one
 * already chosen does: two cards that clash cost a rerun, which is slower than working them one after the other.
 * A screen card with no route is left out; the serial path parks it without spending a lane on it.
 */
export function pickBatch(queue: readonly BoardCard[], lanes: number): BoardCard[] {
  const chosen: BoardCard[] = [];
  const taken = new Set<string>();
  for (const card of queue) {
    if (chosen.length >= lanes) break;
    if (unclosableUiCard(card)) continue;
    const paths = touchedPaths(card);
    if ([...paths].some((file) => taken.has(file))) continue;
    chosen.push(card);
    for (const file of paths) taken.add(file);
  }
  return chosen;
}

/**
 * The next card to start beside the ones already going. A screen with no route comes first, because starting it only
 * parks it; otherwise the first card that is not likely to touch a file one of the running cards does.
 */
export function pickNextCard(queue: readonly BoardCard[], running: readonly BoardCard[]): BoardCard | undefined {
  const unclosable = queue.find((card) => unclosableUiCard(card));
  if (unclosable) return unclosable;
  const taken = new Set<string>();
  for (const card of running) for (const file of touchedPaths(card)) taken.add(file);
  return queue.find((card) => ![...touchedPaths(card)].some((file) => taken.has(file)));
}

/**
 * Why fewer agents are working than the run was given, in one short sentence, or an empty string when every place is
 * in use or nothing explains it. Without it a run asked for eight agents and showing two looks broken; it is usually
 * waiting on cards that others depend on, or holding back cards that would edit the same files as the ones running.
 */
export function idlePlacesNote(input: { lanes: number; running: number; clashing: readonly BoardCard[]; waitingOnOthers: number }): string {
  const free = input.lanes - input.running;
  if (free <= 0) return '';
  const places = `${free} place${free === 1 ? ' is' : 's are'} free`;
  if (input.clashing.length > 0) {
    const names = input.clashing.slice(0, 2).map((card) => `"${card.title}"`).join(', ');
    return `${places}: ${names}${input.clashing.length > 2 ? ' and others' : ''} would edit the same files as the cards running, so ${input.clashing.length === 1 ? 'it waits' : 'they wait'}.`;
  }
  if (input.waitingOnOthers > 0) return `${places}: ${input.waitingOnOthers} card${input.waitingOnOthers === 1 ? ' waits' : 's wait'} for cards that are not done yet.`;
  return '';
}

/** Cards a cheaper model can take on a first try: a component that lives inside a page, or setup nothing waits on. */
export function isEasyCard(card: BoardCard, board: readonly BoardCard[]): boolean {
  if (card.kind === 'component') return card.route.trim() === '';
  if (card.kind === 'chore') return !board.some((other) => other.dependsOn.includes(card.id));
  return false;
}

/**
 * Whether two check failures are the same complaint. Word for word is too strict: a build prints durations, run ids,
 * line numbers and absolute paths that differ every time, so a card failing identically still looked like progress.
 */
export function sameFailure(a: string, b: string): boolean {
  if (!a || !b) return false;
  const shape = (text: string): string => text
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '#')
    .replace(/[a-z]:[\\/][^\s:'"]+|\/[\w.-]+(?:\/[\w.@-]+)+/g, '<path>')
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g, '<time>')
    .replace(/:\d+(?::\d+)?/g, ':<n>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return shape(a) === shape(b);
}

/**
 * Whether a card that has just failed has cost far more than a card usually does in this run, which means more
 * attempts are likely to be money spent on a card that is stuck. Judged against the cards this run has closed, not a
 * fixed number, so a run of cheap cards stops a runaway one early and a run of dear ones is left alone. With fewer
 * than three closed cards to compare with there is nothing to judge by, so nothing is stopped.
 */
export function isCostOutlier(spentUsd: number, closedCardCosts: readonly number[]): boolean {
  if (closedCardCosts.length < OUTLIER_MIN_SAMPLES) return false;
  const sorted = [...closedCardCosts].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return spentUsd > Math.max(typical * OUTLIER_TIMES, OUTLIER_FLOOR_USD);
}

const OUTLIER_MIN_SAMPLES = 3;
const OUTLIER_TIMES = 4;
/** Below this a card is cheap whatever the others cost, so it is never worth stopping for. */
const OUTLIER_FLOOR_USD = 0.25;

/**
 * What a failed check is about, in a line or two: the lines that say FAIL or Error, not the last lines of output. The
 * last lines of a test run are usually the summary and a clean-up note, which named nothing the reader could fix.
 */
export function baselineReason(output: string): string {
  const failing = failingLines(output);
  const chosen = failing.length > 0 ? failing.slice(0, 3) : output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
  return chosen.join(' | ').slice(0, 400);
}

/** The lines of a check's output that name something which failed, leaving out the "N assertions failed" summary. */
function failingLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:FAIL|not ok|✖|×)\b|\bAssertionError\b|^Error\b/i.test(line) && !/^FAIL\s+\S+:\s*\d+ assertion/i.test(line));
}

/** Failures that come from the machine at that moment, not from the code: a folder Windows still holds, a port in use. */
const ENVIRONMENT_FAILURE = /\b(?:EPERM|EBUSY|EACCES|EADDRINUSE|ECONNRESET|ETIMEDOUT|ENOTEMPTY|EMFILE)\b|address already in use|port \d+ is (?:already )?in use|could not remove/i;

/**
 * Whether a failed check failed on the machine and not on an assertion. Such a check is run once more before a card
 * is blamed: a leftover browser holding a temp folder made a check fail, and the card that happened to be checked
 * then was sent back to be redone for nothing it had done.
 */
export function isEnvironmentalFailure(output: string): boolean {
  return ENVIRONMENT_FAILURE.test(output) && failingLines(output).length === 0;
}

export function baselineStopMessage(command: string, reason: string): string {
  return `The project's own check (${command}) fails with none of the cards' changes in it, so no card can pass${reason ? `: ${reason}` : ''}. An agent tried to fix it and could not. Fix the check or the code it tests, then start Autopilot again; the board keeps its place.`;
}

/** A file that has clashed this many times in one run is one every card changes, and gets its added lines combined. */
const HOT_FILE_CLASHES = 2;
/** Text files whose added lines can be kept from both sides. JSON and anything else is left to be run again. */
const UNION_EXTENSIONS = /\.(?:[cm]?[jt]sx?|css|scss|html|md)$/i;

/** The files that have clashed often enough in this run to be called shared. */
export function hotFiles(clashes: ReadonlyMap<string, number>): string[] {
  return [...clashes].filter(([, count]) => count >= HOT_FILE_CLASHES).map(([file]) => file).sort();
}

/** Of those, the ones where keeping both sides' added lines is a reasonable way to combine two cards' work. */
export function unionableFiles(files: readonly string[]): string[] {
  return files.filter((file) => UNION_EXTENSIONS.test(file));
}

/** One line on what a run cost and where, so the cards that burn credits can be seen. Null when nothing was spent. */
export function spendSummary(spend: ReadonlyMap<string, number>, titles: ReadonlyMap<string, string>): string | null {
  const total = [...spend.values()].reduce((sum, cost) => sum + cost, 0);
  if (total < 0.005) return null;
  const costliest = [...spend].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, cost]) => `"${titles.get(id) ?? id}" $${cost.toFixed(2)}`);
  return `Spent about $${total.toFixed(2)} across ${spend.size} card${spend.size === 1 ? '' : 's'}. The costliest: ${costliest.join(', ')}.`;
}

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
  /** `options.cwd` runs the agent in a separate copy of the project, which is how cards run side by side. */
  runAgent(request: AgentRunRequest, ownerWindowId: number, options?: { cwd?: string }): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  /**
   * Separate copies of the project for cards that run at once. Null from `prepare` when the project is not a git
   * repository with a commit, and the run carries on one card at a time. Optional, so a test needs no git.
   */
  worktrees?: { prepare(projectId: string, key: string): Promise<ParallelSession | null> };
  /**
   * `options.cwd` runs the check in a copy of the project instead. Such a check is only an early filter: it is not
   * filed as verification, and a card is still closed on the check that runs in the project itself.
   */
  runCheck(projectId: string, command: string, signal: AbortSignal, options?: { cwd?: string }): Promise<AutopilotCheckResult>;
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
  /**
   * Every stylesheet in the project, as relative paths. The one-stylesheet rule is checked against two of these
   * listings taken around a card's work. Optional, so a test needs no disk and a runner without it skips the check.
   */
  listStylesheets?(projectId: string): Promise<string[]>;
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
  /** A line for the app's own log at the steps where a side-by-side wave can go wrong, so an abrupt end shows where. */
  trace?(message: string): void;
  now(): number;
}

interface ActiveRun {
  controller: AbortController;
  ownerWindowId: number;
  /** Every conversation an agent is working in right now; more than one while cards run side by side. */
  conversations: Set<string>;
  /** When the shared rest ends. Every card waits for it, so a limit one card hit is rested once, not once per card. */
  restUntil: number;
  /** Cards this run holds on the board and has not finished with, which is what keeps the journal record alive. */
  held: number;
  /** Set once copies of the project can never be made (not a git project), or keep failing, so the run works one card at a time. */
  serialOnly: boolean;
  /** Copies that could not be made in a row. One failure is a locked folder; several in a row is the project. */
  copyFailures: number;
  /** Waves run so far, only to give each wave's copies their own folder. */
  waves: number;
  /** Cards already done when the run began, so the pace is measured on this run's own work. */
  doneAtStart: number;
  done: Promise<void>;
  /** The window has been taken to the composer once; it is not dragged back on every card. */
  opened: boolean;
  /** Cards this run parked as blocked, and why, so a setup failure can put them back. */
  blocked: Array<{ id: string; reason: string }>;
  /** Cards this run actually closed. Any at all means the setup works and a block is about that card. */
  completed: number;
  /** What each card has cost this run so far, across its attempts. */
  spend: Map<string, number>;
  /** Card titles by id, for the cost summary. */
  titles: Map<string, string>;
  /** How many times each file has clashed when a card was merged this run. */
  clashFiles: Map<string, number>;
  /** What the cards this run closed cost, which is what a card that keeps failing is measured against. */
  closedSpends: number[];
  /** Times the run started itself again after an unexpected problem. */
  restarts: number;
  /** Cards in a row that hit a problem of their own with none finishing between. */
  problemStreak: number;
  /** The project's own check has been run before the first card, so a restart does not do it again. */
  preflighted: boolean;
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

/** What the screen check writes on a card it passed, which is how a later run finds the ones left in review. */
const SCREEN_PASSED_NOTE = 'waiting for a person to approve the screenshots';

/** A page with nowhere to point can never pass its screen check, and the board never closes it. */
export function unclosableUiCard(card: Pick<BoardCard, 'kind' | 'route'> & Partial<Pick<BoardCard, 'title'>>): boolean {
  // A system surface has no route and no screen check, so a missing route does not make it unclosable.
  return card.kind === 'page' && card.route.trim() === '' && !isSystemSurface(card);
}

/**
 * How a card's agent is told to work in its copy of the project.
 *
 * Read from an overnight run that spent 3.8 billion input tokens on 21 finished cards: agents ran commands in the
 * project's own folder instead of their copy, paged through 250 KB test scripts a few lines at a time (every read is a
 * round trip that sends the whole conversation again), ran the full test suites after every change, and left probe
 * files behind, one of which started Electron and opened an error dialog nobody was there to close.
 */
export function copyRules(folder: string, sharedFiles: readonly string[] = []): string {
  return [
    'WORKING IN YOUR OWN COPY OF THE PROJECT:',
    `- Your copy is ${folder}. Run every command there with run_command. Do not cd outside it and do not touch the project's own folder: other agents are working beside you, and your changes reach the project only when KAI merges your copy.`,
    '- To find something in a large file, search for it, then read that part once in a generous range. Do not page through a file a few lines at a time: each read sends the whole conversation again, and it is the most expensive thing you can do.',
    '- Run the project\'s check once, when you believe the card is done, and fix what it reports. Do not run the smoke or self-test scripts after every change; KAI runs the check again before the card is closed.',
    '- Put new tests, styles and modules in new files named after this card where the project allows it, and connect them with as small an edit as possible to any file most cards also change. Small edits to shared files combine cleanly with the other cards\' work; large ones clash and are redone.',
    '- Throwaway files (probes, notes, logs) go in the system temp folder, not the project, and are deleted when you finish. Never start Electron on a probe script: an error in it opens a dialog that waits for a person who is not there.',
    '- Do not start servers or anything in the background (a trailing &, nohup, start, a dev or preview server). Your copy is deleted when the card is done, and a process left running in it keeps the folder and its port locked; the run_command tool refuses such commands. The project\'s check starts and stops what it needs.',
    ...(sharedFiles.length > 0 ? [`- These files have clashed between cards in this run: ${sharedFiles.slice(0, 8).join(', ')}. Every card changes them. Change them only by adding a few lines, at the end or where nothing else is, and never reformat, reorder or rename what is already there. KAI keeps added lines from both cards, but only when the rest of the file is left alone.`] : []),
    '- Close any browser tab you opened before you finish.',
  ].join('\n');
}

/** The last few cards to fail their check, for telling a broken project from a few broken cards. */
interface FailureWatch {
  recent: Array<{ cardId: string; failure: string }>;
}

/** How a failed check is put to the agent, and compared between cards. */
function checkFailureText(command: string, check: { exitCode: number | null; output: string }): string {
  return `The check \`${command}\` failed${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}. Fix the cause, do not weaken the check. Output:\n${check.output.slice(-TAIL_CHARS)}`;
}

/** An attempt at a card, made in a copy of the project and waiting to be merged. The copy is still open. */
interface CopyAttempt {
  session: ParallelSession;
  conversationId: string;
  result: { failed: boolean; error: string };
  commit?: string;
}

/**
 * One card at a time through a section of the run, in the order they asked.
 *
 * Cards work side by side in copies of the project, but merging a copy into the project and checking the result need
 * the real project and one dev server, and the board takes one write at a time. Those steps go through here.
 */
class Gate {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly signal: AbortSignal) {}

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      // After a Stop nothing more is written to the board or the project.
      if (this.signal.aborted) throw new Error('Autopilot was stopped.');
      return section();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * The places for agents to work in. An agent holds one only while it runs, and gives it back the moment it is done,
 * before its card waits for the gate. A place is for an agent, not for a card: otherwise a batch of cards that all
 * finish together would queue for the gate holding every place, and the agents would stop until the checks caught up.
 */
class Slots {
  private free: number;
  private readonly waiting: Array<{ grant: () => void; cancel: () => void }> = [];

  constructor(count: number, private readonly signal: AbortSignal) {
    this.free = count;
  }

  acquire(): Promise<() => void> {
    if (this.signal.aborted) return Promise.reject(new Error('Autopilot was stopped.'));
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.free += 1;
    };
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          this.signal.removeEventListener('abort', entry.cancel);
          resolve(release);
        },
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error('Autopilot was stopped.'));
        },
      };
      this.waiting.push(entry);
      this.signal.addEventListener('abort', entry.cancel, { once: true });
    });
  }
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
  /**
   * The stylesheets each card found when it started, so the ones it added can be told apart from the ones the project
   * already had. Held per card because cards run side by side, and by the time a card is checked another card's work
   * may already be in the project.
   */
  private readonly stylesheetsBefore = new Map<string, string[]>();

  constructor(private readonly ports: AutopilotPorts) {}

  /**
   * The board's writes, each tried again when the board says it changed while the write was pending.
   *
   * The board takes one write at a time and refuses one that read an older version. With cards worked side by side,
   * one card's claim lands while another's check is being filed, so a refusal is no fault of the write and giving up
   * on it would lose a card's result. The ports are looked up when a write is made, so a test can replace one.
   */
  private readonly board = {
    claimCard: (...args: Parameters<AutopilotPorts['claimCard']>) => this.retryBoard(() => this.ports.claimCard(...args)),
    recordCardRun: (...args: Parameters<AutopilotPorts['recordCardRun']>) => this.retryBoard(() => this.ports.recordCardRun(...args)),
    setCheck: (...args: Parameters<AutopilotPorts['setCheck']>) => this.retryBoard(() => this.ports.setCheck(...args)),
    moveCard: (...args: Parameters<AutopilotPorts['moveCard']>) => this.retryBoard(() => this.ports.moveCard(...args)),
  };

  private async retryBoard<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await write();
      } catch (error) {
        const conflict = error instanceof Error && /changed while this update was pending/i.test(error.message);
        if (!conflict || attempt >= CLAIM_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

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
    const active: ActiveRun = { controller: new AbortController(), ownerWindowId, conversations: new Set(), restUntil: 0, held: 0, serialOnly: false, copyFailures: 0, waves: 0, doneAtStart: board.cards.filter((item) => item.status === 'done').length, done: Promise.resolve(), opened: false, blocked: [], completed: 0, spend: new Map(), titles: new Map(), clashFiles: new Map(), closedSpends: [], restarts: 0, problemStreak: 0, preflighted: false };
    // Baselines belong to the cards of this run; a card retried in a later run is measured against the project then.
    this.stylesheetsBefore.clear();
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
    for (const conversationId of active.conversations) this.ports.cancelAgent(conversationId);
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
    // Every card the run held, not only the one the record names: with cards side by side the record keeps the first,
    // and the others would otherwise stay claimed by an Autopilot that no longer exists.
    const held = board.cards.filter((item) => item.status === 'inProgress' && (item.id === record.cardId || item.claimedBy === AUTOPILOT_AGENT)).map((item) => item.id);
    // The record is cleared in the same breath as the card leaving the run's hands, but a close can land between the
    // two. A card the run actually finished is done, and moving it back would be undoing real work to tidy up a file.
    if (held.length === 0) {
      await this.forget(studioProjectId);
      return false;
    }
    const restored = await this.putBack(studioProjectId, held, 'Put back in the queue after an Autopilot run stopped holding it.');
    await this.forget(studioProjectId);
    return restored > 0;
  }

  private async drive(input: AutopilotStartInput, settings: AppSettings, label: string, active: ActiveRun): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const startedAt = this.ports.now();
    const deadline = input.maxHours > 0 ? startedAt + input.maxHours * 3_600_000 : Infinity;
    // Pacing is only worth the bookkeeping for Direct API runs; a CLI agent paces itself.
    // No fixed number is guessed here. A provider's own limit is far above what a few cards need (DeepSeek documents
    // hundreds of concurrent requests per account), and when one does push back with a 429 the pacer widens its gap and
    // the run rests. So the room is what the run itself can ask for: each card's own request plus the read-only helpers
    // it may start beside it.
    if (input.execution === 'api') this.ports.setPacer(new RequestPacer({ maxConcurrent: Math.max(1, input.parallelCards) * API_REQUESTS_PER_CARD, minGapMs: input.minGapSeconds * 1_000 }));
    let command = input.checkCommand.trim() || (await this.ports.suggestCheck(projectId).catch(() => null)) || '';
    if (!command) this.record(projectId, owner, 'warn', 'No check command is set and none was detected, so cards cannot be closed. They will stop in review.');
    await this.noteProvisionalDesign(projectId, owner);
    try {
      await this.preflightCheck(input, settings, command, active);
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
        if (!command) command = input.checkCommand.trim() || (await this.ports.suggestCheck(projectId).catch(() => null)) || '';
        if (await this.settleScreenPassed(projectId, owner, label, board, command, active)) continue;
        if (command && (await this.settleReviewed(input, label, board, command, active))) continue;
        // Cards this run already holds come first, so a restart picks up every one of them, not only the first.
        const queue = [...board.cards.filter((item) => item.status === 'inProgress' && item.claimedBy === label), ...readyCards(board)];
        const card = queue[0];
        if (!card) {
          await this.proveDev(projectId, owner, board, active);
          const summary = this.boardSummary(board);
          const dev = this.state(projectId).devCheck;
          return this.settle(projectId, owner, 'finished', dev ? `${summary} ${dev.summary}` : summary);
        }

        // Independent cards: everything in the queue is ready or already held, so none of them waits on another. With
        // two or more that do not look likely to clash, they are worked side by side and the places are refilled as
        // cards finish; one card, or no copies to work in, is the serial path below.
        const lanes = this.ports.worktrees && !active.serialOnly ? input.parallelCards : 1;
        if (lanes > 1 && command && pickBatch(queue, 2).length > 1 && (await this.runPool(input, settings, label, command, active, deadline, lanes))) continue;

        state.cardsWorked += 1;
        try {
          await this.workCard(input, settings, label, card, command, active);
        } catch (error) {
          if (error instanceof AutopilotStop || active.controller.signal.aborted) throw error;
          await this.parkAfterProblem(input, active, card, error);
        }
      }
    } catch (error) {
      const reason: unknown = active.controller.signal.reason;
      const endedForAReason = reason instanceof Error && reason.message !== 'Autopilot was stopped.';
      if (active.controller.signal.aborted && !endedForAReason) return this.settle(projectId, owner, 'stopped', 'Autopilot was stopped.');
      const message = endedForAReason ? reason.message : error instanceof Error ? error.message : String(error);
      // An unexpected problem (not a stop the run asked for, and not the person pressing Stop) is waited out and the run
      // begins again from the board, which still holds every card where it was: the loop takes the ones it was holding first.
      if (!(error instanceof AutopilotStop) && !active.controller.signal.aborted && active.restarts < MAX_AUTO_RESTARTS) {
        active.restarts += 1;
        this.record(projectId, owner, 'warn', `Autopilot hit a problem (${message.slice(0, 200)}) and is starting itself again (${active.restarts} of ${MAX_AUTO_RESTARTS}).`);
        await sleepAbortable(RESTART_PAUSE_MS, active.controller.signal).catch(() => undefined);
        return this.drive(input, settings, label, active);
      }
      this.record(projectId, owner, 'warn', message);
      return this.settle(projectId, owner, 'failed', message);
    }
  }

  /**
   * Runs the project's own check once before the first card, on a project that already has finished work in it, and has
   * an agent fix it if it fails. That check passed when those cards were closed, so a failure now is the project
   * having been changed since; finding it before the run costs one fix, and finding it in the middle of a wave cost the
   * attempts of every card that was checked against it.
   */
  private async preflightCheck(input: AutopilotStartInput, settings: AppSettings, command: string, active: ActiveRun): Promise<void> {
    if (!command || active.preflighted || active.doneAtStart === 0) return;
    active.preflighted = true;
    const { projectId } = input;
    this.phase(projectId, active.ownerWindowId, 'checking', "Checking that the project's own check passes before any card is worked.");
    const check = await this.timed(projectId, 'checkMs', () => this.steadyCheck(projectId, command, active.controller.signal));
    if (check.passed) return;
    const card = (await this.ports.board(projectId)).cards[0];
    if (!card) return;
    const reason = baselineReason(check.output);
    if (await this.repairBaseline(input, settings, card, command, active, reason)) return;
    throw new AutopilotStop(baselineStopMessage(command, reason));
  }

  /** The project's check, run once more when it failed on the machine and not on an assertion. */
  private async steadyCheck(...args: Parameters<AutopilotPorts['runCheck']>): ReturnType<AutopilotPorts['runCheck']> {
    const first = await this.ports.runCheck(...args);
    if (first.passed || !isEnvironmentalFailure(first.output)) return first;
    this.ports.trace?.('The check failed on something in the machine, not in the code; running it once more.');
    return this.ports.runCheck(...args);
  }

  /**
   * A card hit a problem of its own: a board write that failed, an agent that threw. It is parked with the reason and
   * the run carries on, because ending a run of dozens of cards over one of them is what made Autopilot feel fragile.
   * Cards that keep hitting problems with none finishing means the cause is shared, and then the run stops.
   */
  private async parkAfterProblem(input: AutopilotStartInput, active: ActiveRun, card: BoardCard, error: unknown): Promise<void> {
    const { projectId } = input;
    const message = error instanceof Error ? error.message : String(error);
    active.problemStreak += 1;
    this.record(projectId, active.ownerWindowId, 'warn', `"${card.title}" hit a problem and was parked: ${message.slice(0, 200)}`);
    if (active.problemStreak >= MAX_PROBLEM_STREAK) {
      throw new AutopilotStop(`${MAX_PROBLEM_STREAK} cards in a row hit problems of their own (the last: ${message.slice(0, 200)}). Something shared is wrong. Fix it, then start Autopilot again; the board keeps its place.`);
    }
    await this.blockCard(input, active, card, 1, `The run hit a problem on this card: ${message}`).catch(() => undefined);
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
  private async workCard(
    input: AutopilotStartInput,
    settings: AppSettings,
    label: string,
    card: BoardCard,
    command: string,
    active: ActiveRun,
    /**
     * Set when a wave already holds the card. `first` is an attempt already run, in a separate copy of the project;
     * `startAttempt` and `failure` carry a card on from the attempt a wave got to, with the failure it was handed.
     */
    carried?: { first?: { conversationId: string; result: { failed: boolean; error: string } }; startAttempt?: number; failure?: string },
  ): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const state = this.state(projectId);
    // A screen card with no route cannot pass its screen check however many times it is run, and the board will not
    // close a screen card without one. Parking it says so once, in the card's own words, instead of spending three
    // paid agent turns proving it again — which is what happened on 2026-10-04, when four such cards were worked
    // three times each and then gated thirty-seven others behind them.
    if (unclosableUiCard(card)) {
      await this.board.moveCard(projectId, card.id, 'blocked', 'No route: this card is a screen, and the board will not close a screen card without a passing screen check, which needs a route to open. Set the route on the card, then put it back in the queue.', 'agent');
      this.record(projectId, owner, 'warn', `"${card.title}" is blocked: it is a screen card with no route, so its check can never pass.`);
      return;
    }
    if (!carried) await this.holdCard(input, label, card, active);
    // Taken before the agent's first turn, so the stylesheets it adds are the only difference later.
    await this.noteStylesheets(projectId, card);

    let failure = carried?.failure ?? '';
    // How many attempts were actually made, which is fewer than the limit when the card is given up on early.
    let attemptsMade = 0;
    let costly = false;
    for (let attempt = carried?.startAttempt ?? 1; attempt <= input.attemptsPerCard; attempt += 1) {
      attemptsMade = attempt;
      state.attempt = attempt;
      const prior = attempt === 1 ? carried?.first : undefined;
      if (!prior) {
        // With other cards in hand the line names them all: it said one card's name while eight were being worked.
        const others = state.lanes.filter((lane) => lane.cardId !== card.id);
        this.phase(projectId, owner, 'working', others.length > 0
          ? `Working on ${others.length + 1} cards side by side: ${[card.title, ...others.map((lane) => lane.cardTitle)].map((title) => `"${title}"`).join(', ')}.`.slice(0, 560)
          : `Working on "${card.title}"${attempt > 1 ? ` (attempt ${attempt} of ${input.attemptsPerCard})` : ''}.`);
      }
      let run: { failed: boolean; error: string };
      let runConversationId: string | undefined = prior?.conversationId;
      if (prior) {
        // The first attempt already ran, in a copy of the project, alongside the other cards of its wave.
        run = prior.result;
      } else {
        const base = await this.cardPrompt(input, card);
        const conversation = await this.ports.createConversation(projectId, `Autopilot: ${card.title}`.slice(0, 120), card);
        runConversationId = conversation.id;
        this.trackLane(active, card, conversation.id);
        if (!active.opened) {
          active.opened = true;
          this.ports.openConversation(owner, conversation);
        }
        const model = attempt === 1 ? await this.firstTryModel(input, card) : undefined;
        try {
          run = await this.timed(projectId, 'agentMs', () => this.runResting(input, settings, conversation.id, base, failure, active, { cardId: card.id, cardTitle: card.title, ...(model ? { model } : {}) }));
        } finally {
          this.untrackLane(active, card.id, conversation.id);
        }
      }
      const settled = await this.settleAttempt(input, settings, label, card, command, active, run, failure, undefined, runConversationId);
      if (settled.outcome !== 'retry') return;
      failure = settled.failure;
      // The same refusal twice, word for word, means the attempt changed nothing the check looks at. A third turn
      // costs another ten minutes to hear it again — on 2026-10-19 one such refusal took three turns on each of
      // twenty-eight cards — so the card is parked with the reason now.
      if (settled.repeated) break;
      if (settled.costly) { costly = true; break; }
    }

    await this.blockCard(input, active, card, attemptsMade, failure, costly ? active.spend.get(card.id) : undefined);
  }

  /**
   * What happens to a card once one attempt at it has run: the attempt is recorded, then the card is checked and
   * closed, or sent back with the reason. A card worked on its own and the cards of a wave both go through this.
   */
  private async settleAttempt(
    input: AutopilotStartInput,
    settings: AppSettings,
    label: string,
    card: BoardCard,
    command: string,
    active: ActiveRun,
    run: { failed: boolean; error: string },
    previousFailure: string,
    /** What the card changed, when that is known (the files its own copy changed). Otherwise the project's changes are read. */
    changedFiles?: string[],
    conversationId?: string,
  ): Promise<{ outcome: 'done' | 'review' | 'retry'; failure: string; repeated: boolean; costly: boolean }> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const state = this.state(projectId);
    await this.board.recordCardRun(projectId, card.id, {
      agent: input.execution === 'api' ? 'api' : (input.agent ?? settings.defaultAgent),
      model: input.model ?? null,
      at: new Date(this.ports.now()).toISOString(),
      ...(conversationId ? { conversationId } : {}),
      files: changedFiles ?? (await this.ports.changedFilesFor(projectId).catch(() => [])),
    });
    const costly = (): boolean => isCostOutlier(active.spend.get(card.id) ?? 0, active.closedSpends);
    if (run.failed) {
      this.record(projectId, owner, 'warn', `"${card.title}" failed: ${run.error.slice(0, 200)}`);
      return { outcome: 'retry', failure: `The last attempt ended with an error: ${run.error}`, repeated: false, costly: costly() };
    }
    if (!command) {
      await this.board.moveCard(projectId, card.id, 'review', NO_CHECK_NOTE, 'agent');
      await this.endCard(projectId, active);
      this.record(projectId, owner, 'warn', `"${card.title}" is in review: there is no check command.`);
      state.restStreak = 0;
      return { outcome: 'review', failure: '', repeated: false, costly: false };
    }
    const verdict = await this.checkAndClose(projectId, owner, label, card, command, active.controller.signal);
    if (!verdict.closed) return { outcome: 'retry', failure: verdict.failure, repeated: sameFailure(verdict.failure, previousFailure), costly: costly() };
    const closedFor = active.spend.get(card.id);
    if (closedFor) active.closedSpends.push(closedFor);
    active.problemStreak = 0;
    state.cardsDone += 1;
    state.restStreak = 0;
    await this.endCard(projectId, active);
    const cost = active.spend.get(card.id);
    this.record(projectId, owner, 'card', `"${card.title}" is done.${cost ? ` It cost about $${cost.toFixed(2)}.` : ''}`);
    this.counts(projectId, await this.ports.board(projectId));
    this.stylesheetsBefore.delete(card.id);
    return { outcome: 'done', failure: '', repeated: false, costly: false };
  }

  /** Parks a card that could not be got through, with the reason on it, and moves on. */
  /** `costlyUsd` is set when the card was given up on for what it had cost, not for the failure repeating. */
  private async blockCard(input: AutopilotStartInput, active: ActiveRun, card: BoardCard, attemptsMade: number, failure: string, costlyUsd?: number): Promise<void> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const state = this.state(projectId);
    const why = costlyUsd !== undefined
      ? `, after it had cost about $${costlyUsd.toFixed(2)}, far more than the cards that did pass`
      : attemptsMade < input.attemptsPerCard ? ', the same failure each time' : '';
    await this.board.moveCard(projectId, card.id, 'blocked', `Autopilot gave up after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}${why}. ${failure}`.slice(0, 3_900), 'agent');
    this.stylesheetsBefore.delete(card.id);
    await this.endCard(projectId, active);
    active.blocked.push({ id: card.id, reason: failure });
    state.cardsBlocked += 1;
    const explanation = explainBlocked(failure);
    this.record(projectId, owner, 'warn', `"${card.title}" is blocked after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}${why}${active.spend.get(card.id) ? ` (it cost about $${active.spend.get(card.id)!.toFixed(2)})` : ''}; moving on. ${explanation.ask}`);
  }

  /** The cheaper model for an easy card's first attempt, when the run names one. Undefined means the run's own model. */
  private async firstTryModel(input: AutopilotStartInput, card: BoardCard): Promise<string | undefined> {
    if (!input.easyModel) return undefined;
    const board = await this.ports.board(input.projectId).catch(() => null);
    return board && isEasyCard(card, board.cards) ? input.easyModel : undefined;
  }

  /** The prompt a card's agent starts from: the card, the blocker policy, and how it may use helpers. */
  private async cardPrompt(input: AutopilotStartInput, card: BoardCard): Promise<string> {
    const artifacts = await this.ports.artifactsFor(input.projectId).catch(() => ({}));
    return `${boardCardPrompt(card, artifacts)}\n\nAUTOPILOT BLOCKER POLICY:\n${input.blockerPolicy === 'continue-and-use-decisions'
      ? 'If this card is blocked, read the approved project decisions above and apply one only when its conditions genuinely match. Report which decision you applied and continue independent cards.'
      : 'If this card is blocked, report the exact blocker and a practical next step. Do not wait for the user; independent cards must continue.'}\n\n${input.execution === 'api' ? HELPERS_API : HELPERS_CLI}`;
  }

  /**
   * Takes a card into this run's hands: claimed on the board, remembered in the journal, announced in the log.
   *
   * The journal holds one record per project, so only the first card held starts it; `held` is what keeps it on disk
   * until the last card is let go, instead of the first card to finish wiping the record of the others.
   */
  private async holdCard(input: AutopilotStartInput, label: string, card: BoardCard, active: ActiveRun, alongside = 0): Promise<void> {
    const { projectId } = input;
    const state = this.state(projectId);
    if (!state.cardId) {
      state.cardId = card.id;
      state.cardTitle = card.title;
    }
    await this.board.claimCard(projectId, card.id, label);
    active.held += 1;
    // Written before the log line, not after: the line's own `touch` would have nothing to attach itself to, and the
    // report of an interrupted run would name the previous card's work for as long as this one took to say anything.
    // From here until the card leaves the board, a close leaves a card in this run's hands — and this is what says so.
    if (active.held === 1) {
      await this.keep((journal) => journal.begin({
        studioProjectId: projectId,
        cardId: card.id,
        cardTitle: card.title,
        startedAt: new Date(this.ports.now()).toISOString(),
        updatedAt: new Date(this.ports.now()).toISOString(),
        lastMessage: `Working on "${card.title}".`,
        start: input,
      }));
    }
    this.record(projectId, active.ownerWindowId, 'card', `Working on "${card.title}"${alongside > 0 ? `, alongside ${alongside} other card${alongside === 1 ? '' : 's'}` : ''}.`);
  }

  /** The card is out of this run's hands. The journal record goes only when the last held card does. */
  private async endCard(projectId: string, active: ActiveRun): Promise<void> {
    active.held = Math.max(0, active.held - 1);
    if (active.held === 0) await this.forget(projectId);
  }

  /** Shows a card's conversation as one of the places an agent is working, and as the one to stop on Stop. */
  private trackLane(active: ActiveRun, card: Pick<BoardCard, 'id' | 'title'>, conversationId: string): void {
    const state = this.state(this.projectOf(active));
    active.conversations.add(conversationId);
    state.lanes = [...state.lanes.filter((lane) => lane.cardId !== card.id), { cardId: card.id, cardTitle: card.title, conversationId }];
    state.cardId = state.lanes[0]?.cardId ?? card.id;
    state.cardTitle = state.lanes[0]?.cardTitle ?? card.title;
    state.conversationId = state.lanes[0]?.conversationId ?? conversationId;
    this.ports.announce(active.ownerWindowId, state);
  }

  private untrackLane(active: ActiveRun, cardId: string, conversationId: string): void {
    const state = this.state(this.projectOf(active));
    active.conversations.delete(conversationId);
    state.lanes = state.lanes.filter((lane) => lane.cardId !== cardId);
    state.conversationId = state.lanes[0]?.conversationId ?? null;
    this.ports.announce(active.ownerWindowId, state);
  }

  private projectOf(active: ActiveRun): string {
    for (const [projectId, run] of this.runs) if (run === active) return projectId;
    throw new Error('Autopilot has no project for this run.');
  }

  /** Separate copies of the project for an attempt, or null (and said why) when there cannot be any. */
  private async copiesFor(input: AutopilotStartInput, active: ActiveRun): Promise<ParallelSession | null> {
    active.waves += 1;
    try {
      const session = (await this.ports.worktrees?.prepare(input.projectId, `autopilot-${input.projectId}-${active.waves}`)) ?? null;
      if (session) active.copyFailures = 0;
      return session;
    } catch (error) {
      active.copyFailures += 1;
      this.record(input.projectId, active.ownerWindowId, 'warn', `Cards will run one at a time: separate copies of the project could not be made (${error instanceof Error ? error.message : String(error)}).`);
      return null;
    }
  }

  /**
   * One attempt at a card, in a copy of the project of its own, while the other cards make theirs. Null when there is
   * no copy to work in or the attempt could not be started, so the card carries on alone in the project instead. On
   * success the copy is still open: the caller merges it, then closes it.
   */
  private async attemptInCopy(
    input: AutopilotStartInput,
    settings: AppSettings,
    card: BoardCard,
    attempt: number,
    failure: string,
    command: string,
    active: ActiveRun,
    /** The commit this card's previous attempt made, put back into the new copy so the attempt builds on it. */
    carry?: string,
  ): Promise<CopyAttempt | null> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const signal = active.controller.signal;
    this.ports.trace?.(`Autopilot lane "${card.title}": making its copy.`);
    const session = await this.copiesFor(input, active);
    if (!session) return null;
    let conversationId: string | null = null;
    try {
      const folder = await session.checkout(card.id);
      // The previous attempt's changes, where they still apply on top of what the project holds now. A retry used to
      // start from nothing once the failed attempt was taken back out, and paid for the same work twice.
      const carried = carry && session.carry ? await session.carry(card.id, carry).catch(() => false) : false;
      const told = carried ? `${failure}\n\nYour previous attempt's changes are already in this copy of the project. Build on them and fix what failed; do not start over.` : failure;
      const conversation = await this.ports.createConversation(projectId, `Autopilot: ${card.title}`.slice(0, 120), card);
      conversationId = conversation.id;
      this.trackLane(active, card, conversation.id);
      if (!active.opened) {
        active.opened = true;
        this.ports.openConversation(owner, conversation);
      }
      this.ports.trace?.(`Autopilot lane "${card.title}": copy and conversation ready, starting the agent.`);
      const prompt = `${await this.cardPrompt(input, card)}\n\n${copyRules(folder, hotFiles(active.clashFiles))}`;
      const model = attempt === 1 ? await this.firstTryModel(input, card) : undefined;
      let result = await this.timed(projectId, 'agentMs', () => this.runResting(input, settings, conversation.id, prompt, told, active, { cwd: folder, cardId: card.id, cardTitle: card.title, ...(model ? { model } : {}) }));
      // The build check, run in the card's own copy while the other cards are still working. A failure here is handed
      // straight back to the agent, which is cheaper than finding out after the merge and the wait for the project's one
      // check. It is a filter only: the card is still closed on the check that runs in the project.
      for (let tried = 1; command && !result.failed && tried < Math.min(2, input.attemptsPerCard); tried += 1) {
        const early = await this.timed(projectId, 'checkMs', () => this.steadyCheck(projectId, command, signal, { cwd: folder })).catch(() => null);
        if (!early || early.passed) break;
        this.record(projectId, owner, 'check', `Check failed for "${card.title}" in its copy; trying again before merging.`);
        const earlyFailure = `The check \`${command}\` failed${early.exitCode === null ? '' : ` (exit ${early.exitCode})`}. Fix the cause, do not weaken the check. Output:\n${early.output.slice(-TAIL_CHARS)}`;
        result = await this.timed(projectId, 'agentMs', () => this.runResting(input, settings, conversation.id, prompt, earlyFailure, active, { cwd: folder, cardId: card.id, cardTitle: card.title }));
      }
      const commit = result.failed ? undefined : await session.commit(card.id, `Autopilot: ${card.title}`.slice(0, 120));
      return { session, conversationId: conversation.id, result, ...(commit ? { commit } : {}) };
    } catch (error) {
      await session.dispose().catch(() => undefined);
      // A Stop ends the run. Anything else that stopped this card must not stop the others: it carries on alone.
      if (signal.aborted) throw error;
      this.record(projectId, owner, 'warn', `"${card.title}" stopped while working in its copy: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      return null;
    } finally {
      if (conversationId) this.untrackLane(active, card.id, conversationId);
    }
  }

  /**
   * Merges one card's copy into the project. The files it could not apply, because another card or another editor
   * changed them since the copy was made, or an empty list when the merge itself failed; null when all of it went in.
   */
  private async mergeOne(input: AutopilotStartInput, session: ParallelSession, card: BoardCard, commit: string, active: ActiveRun): Promise<{ clash: string[] | null; undo?: () => Promise<void> }> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    this.phase(projectId, owner, 'checking', `Merging the work on "${card.title}" into the project.`);
    try {
      // Files that keep clashing have their added lines kept from both cards instead of the card being run again.
      const union = unionableFiles(hotFiles(active.clashFiles));
      const merged = await this.timed(projectId, 'mergeMs', () => session.integrate([{ stepId: card.id, commit }], union.length > 0 ? { unionFiles: union } : undefined));
      if (merged.merged?.length) this.ports.trace?.(`Autopilot lane "${card.title}": combined its changes with the project's in ${merged.merged.join(', ')}.`);
      const clash = merged.conflicts.length === 0 && merged.skipped.length === 0
        ? null
        : [...new Set([...merged.conflicts.flatMap((conflict) => conflict.files), ...merged.skipped])];
      for (const file of clash ?? []) active.clashFiles.set(file, (active.clashFiles.get(file) ?? 0) + 1);
      return { clash, ...(merged.undo ? { undo: merged.undo } : {}) };
    } catch (error) {
      this.record(projectId, owner, 'warn', `The work on "${card.title}" could not be merged (${error instanceof Error ? error.message : String(error)}).`);
      return { clash: [] };
    }
  }

  /**
   * One card, from claim to done or blocked, worked in copies of the project while the other cards are worked beside
   * it. Each attempt runs in a copy of its own; merging it and checking the result go through `gate`, one card at a
   * time, because they need the real project and one dev server. A card whose changes met another card's runs again on
   * top of what is in the project now, without spending an attempt (twice at most). Resolves to whether the card was
   * claimed at all.
   */
  private async workCardInCopy(
    input: AutopilotStartInput,
    settings: AppSettings,
    label: string,
    card: BoardCard,
    command: string,
    active: ActiveRun,
    gate: Gate,
    slots: Slots,
    watch: FailureWatch,
    alongside: number,
    startDelayMs: number,
  ): Promise<boolean> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const signal = active.controller.signal;
    // Started a little apart rather than in the same instant. Eight copies, eight conversations and eight agent runs
    // beginning together is eight times the work of one at the moment the app is busiest, and KAI ended abruptly twice
    // when that was asked of it. It also spaces the claims out.
    if (startDelayMs > 0) await sleepAbortable(startDelayMs, signal).catch(() => undefined);
    // Claimed once an agent place is free, not before: a card held while it waits for a place is a card nobody else
    // can have. Outside the gate, so a claim never waits on another card's check; the board tries a refused write
    // again, so a claim landing beside another write is no problem.
    let claimed = false;
    let failure = '';
    let attemptsMade = 0;
    let costly = false;
    let reruns = 0;
    let carry: string | undefined;
    for (let attempt = 1; attempt <= input.attemptsPerCard; attempt += 1) {
      attemptsMade = attempt;
      this.state(projectId).attempt = attempt;
      const release = await slots.acquire();
      let made: CopyAttempt | null;
      try {
        if (!claimed) {
          try {
            await this.holdCard(input, label, card, active, alongside);
            claimed = true;
          } catch (error) {
            if (signal.aborted) throw error;
            this.record(projectId, owner, 'warn', `"${card.title}" could not be claimed (${error instanceof Error ? error.message : String(error)}); it stays in the queue.`);
            return false;
          }
        }
        // Taken once, before any attempt: a copy starts from the project, and a failed attempt is taken back out of it,
        // so the listing from before the first turn stays the right one to compare against.
        await this.noteStylesheets(projectId, card);
        made = await this.attemptInCopy(input, settings, card, attempt, failure, command, active, carry);
      } finally {
        release();
      }
      if (!made) {
        // No copy to work in: this card carries on alone in the project, with the attempts it has left.
        await gate.run(() => this.workCard(input, settings, label, card, command, active, { startAttempt: attempt, failure }));
        return true;
      }
      let step: { clash: string[] } | { settled: Awaited<ReturnType<DesktopAutopilot['settleAttempt']>> };
      try {
        step = await gate.run(async () => {
          try {
            let undo: (() => Promise<void>) | undefined;
            if (made.commit) {
              const merge = await this.mergeOne(input, made.session, card, made.commit, active);
              undo = merge.undo;
              if (merge.clash && reruns < MAX_CLASH_RERUNS) {
                // What did go in comes back out, so the next go starts from a project without half of this card in it.
                await undo?.().catch(() => undefined);
                return { clash: merge.clash };
              }
            }
            const own = made.commit ? await made.session.filesChanged(made.commit).catch(() => undefined) : undefined;
            const settled = await this.settleAttempt(input, settings, label, card, command, active, made.result, failure, own, made.conversationId);
            if (settled.outcome === 'retry' && undo) {
              // A card that failed its check does not stay in the project. Left in, its broken changes failed every other
              // card's check as well, and the cards behind it went round again for a fault that was not theirs.
              await undo().catch(() => undefined);
              this.record(projectId, owner, 'info', `"${card.title}" did not pass, so its changes were taken back out of the project and it tries again from them in its own copy.`);
              await this.guardBaseline(input, settings, card, settled.failure, command, active, watch);
            } else if (settled.outcome === 'done') {
              watch.recent.length = 0;
            }
            return { settled };
          } finally {
            await made.session.dispose().catch(() => undefined);
          }
        });
      } catch (error) {
        await made.session.dispose().catch(() => undefined);
        throw error;
      }
      if ('clash' in step) {
        reruns += 1;
        const named = step.clash.slice(0, 4).join(', ');
        this.record(projectId, owner, 'info', `"${card.title}" changed files that something else changed while it worked${named ? ` (${named})` : ''}, so it runs again on top of what is in the project now.`);
        failure = `Something else changed some of the same lines while you worked${named ? ` (${named})` : ''}, and its work is in the project now. Look at those files first and make your change on top of theirs instead of replacing it.`;
        carry = made.commit;
        attempt -= 1;
        attemptsMade = attempt;
        continue;
      }
      const settled = step.settled;
      if (settled.outcome !== 'retry') return true;
      failure = settled.failure;
      carry = made.commit;
      // The same refusal twice, word for word, means the attempt changed nothing the check looks at: parked now.
      if (settled.repeated) break;
      if (settled.costly) { costly = true; break; }
    }
    await gate.run(() => this.blockCard(input, active, card, attemptsMade, failure, costly ? active.spend.get(card.id) : undefined));
    return true;
  }

  /**
   * Ends the run when the project's own check is what keeps failing.
   *
   * When several different cards in a row fail their check in the same way, the likeliest cause is not any of them
   * but the project: a test that was already broken, a missing dependency. Every further card would fail the same
   * way and be paid for. So the check is run on the project as it is, with none of those cards in it, and if it fails
   * there too the run stops and says so, instead of working the rest of the board into the same wall.
   */
  private async guardBaseline(input: AutopilotStartInput, settings: AppSettings, card: BoardCard, failure: string, command: string, active: ActiveRun, watch: FailureWatch): Promise<void> {
    const { projectId } = input;
    watch.recent.push({ cardId: card.id, failure });
    if (watch.recent.length > BASELINE_SAMPLE) watch.recent.shift();
    const recent = watch.recent;
    if (recent.length < BASELINE_SAMPLE || new Set(recent.map((entry) => entry.cardId)).size < BASELINE_SAMPLE) return;
    if (!recent.every((entry) => sameFailure(entry.failure, recent[0]!.failure))) return;
    this.phase(projectId, active.ownerWindowId, 'checking', 'Several cards failed their check the same way; checking the project on its own.');
    const check = await this.timed(projectId, 'checkMs', () => this.steadyCheck(projectId, command, active.controller.signal));
    watch.recent.length = 0;
    if (check.passed) return;
    // Stopping here threw away a run of dozens of cards over one broken assertion. An agent is given the failure first;
    // the run stops only when it cannot be fixed.
    const reason = baselineReason(check.output);
    if (await this.repairBaseline(input, settings, card, command, active, reason)) return;
    throw new AutopilotStop(baselineStopMessage(command, reason));
  }

  /**
   * Has an agent fix the project's own check, in the project itself, and says whether it passes afterwards. Called with
   * the merge gate held, so nothing else is merged on top of the repair while it is made.
   */
  private async repairBaseline(input: AutopilotStartInput, settings: AppSettings, card: BoardCard, command: string, active: ActiveRun, failure: string): Promise<boolean> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const signal = active.controller.signal;
    this.record(projectId, owner, 'warn', `The project's own check fails with none of this run's changes in it, so an agent is fixing it before the cards go on: ${failure.slice(0, 200)}`);
    const base = `Fix the project's own check. \`${command}\` fails on the project as it stands, before any card's work, so no card can pass until it is fixed. Find the cause in the code and fix it. Do not weaken, skip or delete the check. Run it once at the end to confirm.`;
    let last = failure;
    for (let attempt = 1; attempt <= BASELINE_REPAIR_ATTEMPTS; attempt += 1) {
      this.phase(projectId, owner, 'working', `Fixing the project's own check before the other cards go on${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);
      const conversation = await this.ports.createConversation(projectId, "Autopilot: fix the project's own check", card);
      // Shown as a place an agent is working, and the window taken to it, so the person can watch the repair instead of
      // seeing a status line and waiting.
      this.trackLane(active, card, conversation.id);
      if (!active.opened) {
        active.opened = true;
        this.ports.openConversation(owner, conversation);
      }
      try {
        await this.timed(projectId, 'agentMs', () => this.runResting(input, settings, conversation.id, base, last, active, {}));
      } finally {
        this.untrackLane(active, card.id, conversation.id);
      }
      if (signal.aborted) throw new Error('Autopilot was stopped.');
      const check = await this.timed(projectId, 'checkMs', () => this.steadyCheck(projectId, command, signal));
      if (check.passed) {
        this.record(projectId, owner, 'info', "The project's own check passes again; the cards carry on.");
        return true;
      }
      last = baselineReason(check.output);
    }
    return false;
  }

  /**
   * Works the board with several agents at once, and keeps that many going until there is nothing left to start.
   *
   * Each card has a worker of its own: its agent runs in a copy of the project while the other workers' agents run in
   * theirs. The moment a card is closed, parked or sent for a person, its place goes to the next ready card that does
   * not look likely to clash with the ones still going, so the number working stays at the number asked for instead of
   * dropping as a batch winds down. Only merging a copy into the project and checking the result are taken one card at a
   * time, through a gate, because they need the real project and one dev server.
   *
   * Returns whether it worked any card. False means there was nothing it could do side by side, and the caller works
   * the board one card at a time.
   */
  private async runPool(input: AutopilotStartInput, settings: AppSettings, label: string, command: string, active: ActiveRun, deadline: number, lanes: number): Promise<boolean> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    const state = this.state(projectId);
    const signal = active.controller.signal;

    // Whether there can be copies at all, asked once before any card is claimed.
    const probe = await this.copiesFor(input, active);
    if (!probe) {
      // Giving up for the whole run over one failed attempt is what dropped a run of twelve cards to one at a time, because
      // a folder was locked for a moment. A copy that could not be made is tried again; only a project that cannot have
      // copies at all (no error, just no git history), or one that keeps failing, works one card at a time.
      if (active.copyFailures === 0 || active.copyFailures >= MAX_COPY_FAILURES) {
        active.serialOnly = true;
        this.record(projectId, owner, 'info', active.copyFailures === 0 ? 'Cards run one at a time: working side by side needs a git project with at least one commit.' : 'Cards run one at a time: copies of the project could not be made several times in a row.');
      }
      return false;
    }
    await probe.dispose().catch(() => undefined);

    const gate = new Gate(signal);
    const slots = new Slots(lanes, signal);
    const watch: FailureWatch = { recent: [] };
    // More cards can be in hand than agents are working: a card that has finished its agent waits for the gate while
    // the next ones take its place. Not unboundedly, so the checks falling behind cannot pile up finished copies.
    const inFlight = lanes + Math.max(2, Math.ceil(lanes / 2));
    const running = new Map<string, { card: BoardCard; done: Promise<void> }>();
    const unclaimable = new Set<string>();
    const failures: unknown[] = [];
    let worked = 0;

    // Why places are free, kept for the status line; refreshed each time the queue is looked at.
    let idleNote = '';
    const announce = (): void => {
      const cards = [...running.values()].map((entry) => entry.card);
      if (cards.length === 0) return;
      const names = cards.length === 1 ? `Working on "${cards[0]?.title}".` : `Working on ${cards.length} cards side by side (up to ${lanes} agents at once): ${cards.map((card) => `"${card.title}"`).join(', ')}.`;
      this.phase(projectId, owner, 'working', (idleNote ? `${idleNote} ${names}` : names).slice(0, 560));
    };

    for (;;) {
      if (signal.aborted) break;
      if (!this.limitReached(input, state, deadline)) {
        const board = await this.ports.board(projectId);
        this.counts(projectId, board);
        // Cards this run already holds come first, so a restart picks up every one of them.
        const queue = [...board.cards.filter((card) => card.status === 'inProgress' && card.claimedBy === label), ...readyCards(board)]
          .filter((card) => !running.has(card.id) && !unclaimable.has(card.id));
        let startedNow = 0;
        while (running.size < inFlight && !this.limitReached(input, state, deadline)) {
          const next = pickNextCard(queue, [...running.values()].map((entry) => entry.card));
          if (!next) break;
          queue.splice(queue.indexOf(next), 1);
          if (unclosableUiCard(next)) {
            // Only parked: it takes no place of its own.
            await gate.run(() => this.workCard(input, settings, label, next, command, active));
            continue;
          }
          state.cardsWorked += 1;
          const alongside = running.size;
          const delay = startedNow * LANE_STAGGER_MS;
          startedNow += 1;
          const done = this.workCardInCopy(input, settings, label, next, command, active, gate, slots, watch, alongside, delay).then(
            (claimed) => {
              if (claimed) worked += 1;
              else unclaimable.add(next.id);
            },
            (error: unknown) => {
              if (error instanceof AutopilotStop || signal.aborted) { failures.push(error); return undefined; }
              return gate.run(() => this.parkAfterProblem(input, active, next, error)).catch((stop: unknown) => { failures.push(stop); });
            },
          ).finally(() => { running.delete(next.id); });
          running.set(next.id, { card: next, done });
        }
        const before = idleNote;
        idleNote = idlePlacesNote({
          lanes,
          running: running.size,
          clashing: queue,
          waitingOnOthers: board.cards.filter((card) => card.status === 'backlog').length,
        });
        if (startedNow > 0 || idleNote !== before) announce();
      }
      if (running.size === 0) break;
      await Promise.race([...running.values()].map((entry) => entry.done));
      if (failures.length > 0) break;
      announce();
    }
    // A run that cannot go on (the project's own check broken, a provider that never came back) stops the other
    // cards too, rather than letting them spend on work that cannot be closed.
    if (failures.length > 0 && !signal.aborted) {
      const reason = failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
      active.controller.abort(reason);
      for (const conversationId of active.conversations) this.ports.cancelAgent(conversationId);
    }
    // Whatever is still going finishes, or stops, before this returns.
    await Promise.all([...running.values()].map((entry) => entry.done));
    if (failures.length > 0) throw failures[0];
    return worked > 0;
  }

  /** The stylesheets the project holds now, remembered as the baseline for one card. Never overwrites an earlier one. */
  private async noteStylesheets(projectId: string, card: BoardCard): Promise<void> {
    if (!this.ports.listStylesheets || this.stylesheetsBefore.has(card.id)) return;
    const before = await this.ports.listStylesheets(projectId).catch(() => null);
    if (before) this.stylesheetsBefore.set(card.id, before);
  }

  /**
   * What the one-stylesheet rule has to say about this card, in the words the agent is given back, or nothing.
   *
   * Read from the project rather than from the card's own copy: what matters is what the merge left behind. A card
   * with no baseline is not judged — that is a card picked up from review after a restart, whose "before" is gone.
   */
  private async stylesheetFailure(projectId: string, card: BoardCard): Promise<string> {
    const before = this.stylesheetsBefore.get(card.id);
    if (!before || !this.ports.listStylesheets) return '';
    const after = await this.ports.listStylesheets(projectId).catch(() => null);
    if (!after) return '';
    return stylesheetVerdict(before, after).message;
  }

  /**
   * Runs the check for one card and, when it passes, closes the card: the build check, then the screen check for a
   * card that has a screen. The board has the last word, as ever: a card it will not close comes back with its reason.
   */
  private async checkAndClose(projectId: string, owner: number, label: string, card: BoardCard, command: string, signal: AbortSignal): Promise<{ closed: boolean; failure: string }> {
    // Before the project's own check, which is the expensive part: a card that grew the stylesheet count is sent back
    // with the reason now, and the next attempt starts from a copy that still holds its own work.
    const stylesheet = await this.stylesheetFailure(projectId, card);
    if (stylesheet) {
      this.record(projectId, owner, 'check', `"${card.title}" added a stylesheet the project does not keep.`);
      return { closed: false, failure: stylesheet };
    }
    this.phase(projectId, owner, 'checking', `Checking "${card.title}".`);
    const check = await this.timed(projectId, 'checkMs', () => this.steadyCheck(projectId, command, signal));
    if (!check.passed || !check.runId) {
      this.record(projectId, owner, 'check', `Check failed for "${card.title}".`);
      return { closed: false, failure: checkFailureText(command, check) };
    }
    await this.board.setCheck(projectId, card.id, {
      runId: check.runId,
      at: new Date(this.ports.now()).toISOString(),
      visual: needsScreenCheck(card) ? null : 'skipped',
      screenshots: [],
      acceptanceEvidence: card.acceptance.map((criterion) => ({
        criterion,
        status: 'passed' as const,
        evidence: `Verification run ${check.runId} passed: ${command}`,
        criterionId: card.acceptanceCriteria.find((item) => item.text === criterion)?.id,
      })),
    });
    if (needsScreenCheck(card)) {
      const visual = card.route
        ? await this.ports.checkUi(projectId, card).catch((error: unknown) => ({ passed: false, summary: error instanceof Error ? error.message : String(error) }))
        : { passed: false, summary: 'The card has no route, so there is no screen to check.' };
      // The visual check hands a failed card back to `ready`; take it again for whatever comes next.
      await this.board.claimCard(projectId, card.id, label).catch(() => undefined);
      if (!visual.passed) {
        this.record(projectId, owner, 'check', `Screen check failed for "${card.title}".`);
        return { closed: false, failure: `The build passes but the screen check did not: ${visual.summary}` };
      }
    }
    try {
      await this.board.moveCard(projectId, card.id, 'done', 'Autopilot: the check passed.', 'check');
    } catch (error) {
      const failure = `The board would not close the card: ${error instanceof Error ? error.message : String(error)}`;
      this.record(projectId, owner, 'warn', failure.slice(0, 300));
      return { closed: false, failure };
    }
    return { closed: true, failure: '' };
  }

  /**
   * Closes the cards whose build check and screen check both passed but which were left in review.
   *
   * The screen check parks a passing card there with "waiting for a person to approve the screenshots", and Autopilot
   * closes it in the same step. A run that ended between the two left the card behind, and every card that depends on
   * it waited on a person Autopilot is meant never to wait for. The board still has the last word: a card whose check
   * no longer matches the working tree is refused and stays where it is, with the reason in the log.
   */
  private async settleScreenPassed(projectId: string, owner: number, label: string, board: StudioBoard, command: string, active: ActiveRun): Promise<boolean> {
    const stranded = board.cards.filter((card) => card.status === 'review' && card.check?.visual === 'passed' && card.notes.includes(SCREEN_PASSED_NOTE));
    let changed = false;
    for (const card of stranded) {
      if (active.controller.signal.aborted) break;
      let refusal = '';
      try {
        await this.board.moveCard(projectId, card.id, 'done', 'Autopilot: the build check and the screen check passed.', 'check');
        this.state(projectId).cardsDone += 1;
        this.record(projectId, owner, 'card', `"${card.title}" is done: both checks had passed and it was waiting in review.`);
        changed = true;
        continue;
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      // The board would not take the old check, usually because the run it points at has left the verification
      // history. The checks are run again now rather than trusted; a card that still fails them is sent back to be
      // worked, since one left in review blocks every card behind it and nothing else would ever look at it.
      if (command) {
        const verdict = await this.checkAndClose(projectId, owner, label, card, command, active.controller.signal);
        if (verdict.closed) {
          this.state(projectId).cardsDone += 1;
          this.record(projectId, owner, 'card', `"${card.title}" is done: its checks were run again and passed.`);
          changed = true;
          continue;
        }
        refusal = verdict.failure;
      }
      await this.board.moveCard(projectId, card.id, 'ready', `Autopilot sent this back to be worked again: ${refusal.slice(0, 400)}`, 'check')
        .then(() => {
          this.record(projectId, owner, 'warn', `"${card.title}" goes back to ready: ${refusal.slice(0, 200)}`);
          changed = true;
        })
        .catch(() => this.record(projectId, owner, 'warn', `"${card.title}" stays in review: ${refusal.slice(0, 200)}`));
    }
    return changed;
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
    options: { cwd?: string; model?: string; cardId?: string; cardTitle?: string } = {},
  ): Promise<{ failed: boolean; error: string }> {
    const { projectId } = input;
    const owner = active.ownerWindowId;
    let interrupted = false;
    let restedMs = 0;
    for (;;) {
      // Stop can land between this card's conversation being created and tracked (trackLane runs after the
      // `createConversation` await settles), so `stop()`'s cancelAgent loop can miss it entirely. Checked here,
      // right before every agent call — including retries — so an abort that arrived during that gap, or during
      // the rest below, is never missed and the agent is never started (or restarted) after Stop was pressed.
      if (active.controller.signal.aborted) throw new Error('Autopilot was stopped.');
      // A rest another card started is everyone's: the limit is the provider's, not the card's.
      const shared = active.restUntil - this.ports.now();
      if (shared > 0) await sleepAbortable(shared, active.controller.signal);
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
          ...((options.model ?? input.model) ? { model: options.model ?? input.model } : {}),
        }, owner, options.cwd ? { cwd: options.cwd } : undefined);
      } catch (error) {
        if (active.controller.signal.aborted) throw error;
        thrown = error;
      }
      if (result?.costUsd) {
        this.state(projectId).costUsd += result.costUsd;
        if (options.cardId) {
          active.spend.set(options.cardId, (active.spend.get(options.cardId) ?? 0) + result.costUsd);
          if (options.cardTitle) active.titles.set(options.cardId, options.cardTitle);
        }
      }

      const failed = thrown !== null || result?.status === 'failed' || Boolean(result?.error);
      if (!failed) return { failed: false, error: '' };
      if (active.controller.signal.aborted) throw new Error('Autopilot was stopped.');

      const message = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : (result?.error ?? result?.output.slice(-600) ?? 'The agent failed.');
      const limited = detectRateLimit(thrown ?? message);
      if (!limited) return { failed: true, error: message };

      interrupted = true;
      const state = this.state(projectId);
      const now = this.ports.now();
      if (active.restUntil > now) {
        // Another card hit the same limit a moment ago and is already resting. Joining it keeps the streak, and so
        // the length of the next rest, from growing once per card instead of once per limit.
        restedMs += active.restUntil - now;
        await sleepAbortable(active.restUntil - now, active.controller.signal);
        continue;
      }
      state.restStreak += 1;
      state.restsTotal += 1;
      const wait = cooldownMs(state.restStreak, limited.retryAfterMs, limited.window);
      restedMs += wait;
      if (restedMs > MAX_REST_WITHOUT_PROGRESS_MS) {
        throw new AutopilotStop(`The provider is still refusing after ${formatDuration(MAX_REST_WITHOUT_PROGRESS_MS)} of rest. It may be out of quota or credit. Check the account, then start Autopilot again; the board keeps its place.`);
      }
      active.restUntil = now + wait;
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
        await this.board.moveCard(projectId, id, 'ready', note, 'agent');
        restored += 1;
      } catch {
        // A card that still waits on others cannot be ready; the backlog is where it belongs until they are done.
        try {
          await this.board.moveCard(projectId, id, 'backlog', note, 'agent');
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
    const began = this.ports.now();
    try {
      await sleepAbortable(ms, signal);
    } finally {
      state.timing.restMs += Math.max(0, this.ports.now() - began);
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
      lanes: [],
      timing: { agentMs: 0, checkMs: 0, mergeMs: 0, restMs: 0 },
      etaMinutes: null,
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
    into.etaMinutes = this.estimate(projectId, board, into);
  }

  /**
   * Minutes left at the pace this run has actually kept. Wall-clock time with rests taken out, over the cards this run
   * finished, so cards side by side count for what they bought. Null until a card is done, because one card's time
   * says nothing about the rest, and null once nothing is left to do.
   */
  private estimate(projectId: string, board: StudioBoard, state: AutopilotStatus): number | null {
    const active = this.runs.get(projectId);
    if (!active || !state.startedAt) return null;
    const finished = state.cardsDone - active.doneAtStart;
    const remaining = board.cards.filter((card) => card.status === 'backlog' || card.status === 'ready' || card.status === 'inProgress').length;
    if (finished < 1 || remaining < 1) return null;
    const working = this.ports.now() - new Date(state.startedAt).getTime() - state.timing.restMs;
    return Math.max(1, Math.round((working / finished) * remaining / 60_000));
  }

  /** Adds the time `work` took to one of the run's buckets, whether it finishes or throws. */
  private async timed<T>(projectId: string, bucket: keyof AutopilotStatus['timing'], work: () => Promise<T>): Promise<T> {
    const began = this.ports.now();
    try {
      return await work();
    } finally {
      const state = this.statuses.get(projectId);
      if (state) state.timing[bucket] += Math.max(0, this.ports.now() - began);
    }
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
    state.lanes = [];
    state.resumeAt = null;
    state.restReason = null;
    const active = this.runs.get(projectId);
    const summary = active ? spendSummary(active.spend, active.titles) : null;
    if (summary) this.record(projectId, owner, 'info', summary);
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
