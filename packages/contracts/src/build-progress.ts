import { z } from 'zod';
import type { StudioBoard } from './studio';

/**
 * How far through a project's build the board is, and a guess at what is left.
 *
 * The position is exact — it is a count of cards by status. The guess is not, and is not presented as if it were: it
 * comes from how fast cards actually finished, and it is withheld until enough have finished to mean anything. A card
 * carries no size, effort or duration, so one large card among many small ones will mislead however it is measured.
 *
 * The board is the source of truth rather than the running agent, because the board is what both drivers move: a card
 * finished is a card finished, whoever finished it.
 */

export const BUILD_DRIVERS = ['idle', 'autopilot', 'auto', 'board'] as const;
export type BuildDriver = (typeof BUILD_DRIVERS)[number];
export const buildDriverSchema = z.enum(BUILD_DRIVERS);

/** Below this many finished cards the pace means nothing, so no guess is offered. */
export const BUILD_PACE_MIN_CARDS = 2;
/** Below this much elapsed time the pace is noise rather than a rate. */
export const BUILD_PACE_MIN_MS = 60_000;
/** A card running this many times the observed pace is called out as taking longer than the ones before it. */
export const BUILD_STALL_FACTOR = 3;

export const paceEstimateSchema = z
  .object({
    /** Cards the pace is measured from, counting only cards the build finished. */
    observedCards: z.number().int().min(0),
    /** The wall-clock span those cards were finished over. */
    observedMs: z.number().int().min(0),
    msPerCard: z.number().min(0),
    /** Cards still to build: the total less those done, blocked, or waiting on a person. */
    cardsRemaining: z.number().int().min(0),
    /** When the remaining cards would be finished at the observed pace. */
    etaAt: z.string().min(1),
    /** `run` measures the live run; `board` measures the gaps between finished cards, which outlives any one run. */
    source: z.enum(['run', 'board']),
    confidence: z.enum(['low', 'medium', 'high']),
    /** The card in flight has already outrun the pace the earlier ones set. */
    stalled: z.boolean(),
  })
  .strict();
export type PaceEstimate = z.infer<typeof paceEstimateSchema>;

export const buildProgressSchema = z
  .object({
    cardsTotal: z.number().int().min(0),
    cardsDone: z.number().int().min(0),
    cardsBlocked: z.number().int().min(0),
    /** Cards waiting on a person rather than on the build. */
    cardsReview: z.number().int().min(0),
    cardsInFlight: z.number().int().min(0),
    /** Ready or backlog: buildable, not yet started. */
    cardsWaiting: z.number().int().min(0),
    /** Done over buildable. Blocked cards leave the denominator, so a board with blockers can still reach 100. */
    percent: z.number().min(0).max(100),
    driver: buildDriverSchema,
    currentCardId: z.string().nullable(),
    currentCardTitle: z.string().nullable(),
    currentCardAttempt: z.number().int().min(0).nullable(),
    /** Who is working the current card, when that is known. */
    actor: z.string().max(120).nullable(),
    startedAt: z.string().nullable(),
    elapsedMs: z.number().int().min(0).nullable(),
    /** Null whenever there is not enough to go on. */
    pace: paceEstimateSchema.nullable(),
    /** Why there is no guess, or what qualifies the one there is. Shown as written. */
    paceNote: z.string().max(400).nullable(),
  })
  .strict();
export type BuildProgress = z.infer<typeof buildProgressSchema>;

/** The slice of a running driver's status this needs. Both Autopilot and Auto satisfy it. */
export interface BuildRunStatus {
  phase: string;
  cardId?: string | null;
  cardTitle?: string | null;
  attempt?: number | null;
  startedAt?: string | null;
  /** Auto reports the provider it is on; Autopilot has no equivalent. */
  activeProvider?: string | null;
}

export interface BuildProgressInput {
  board: StudioBoard;
  nowMs: number;
  autopilot?: BuildRunStatus | null;
  auto?: BuildRunStatus | null;
}

const AUTOPILOT_ACTIVE = new Set(['working', 'checking', 'cooling']);
const AUTO_ACTIVE = new Set(['starting', 'working', 'checking', 'switching-provider', 'cooling', 'splitting']);

function timeOf(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : undefined;
}

/** The middle gap, so a single slow card does not set the pace for the whole board. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * When the build itself finished each card. A card a person moved is left out: the pace being measured is the build's,
 * and a hand-moved card says nothing about it. `movedAt` is null on cards closed before the field existed, and those
 * are skipped rather than guessed at.
 */
function buildCompletions(board: StudioBoard): number[] {
  return board.cards
    .filter((card) => card.status === 'done' && card.movedBy !== 'user' && card.movedAt)
    .map((card) => timeOf(card.movedAt)!)
    .sort((left, right) => left - right);
}

/** Words the guess, or says why there is none. Every caveat reaches the reader instead of being swallowed. */
function describePace(
  estimate: PaceEstimate | null,
  caveats: readonly string[],
  remaining: number,
): string | null {
  const parts: string[] = [];
  if (estimate) {
    const minutes = Math.max(1, Math.round((estimate.observedMs / estimate.observedCards) / 60_000));
    parts.push(`About ${minutes} min per card, from ${estimate.observedCards} card${estimate.observedCards === 1 ? '' : 's'} the build finished.`);
    if (estimate.confidence === 'low') parts.push('Few cards so far, so treat it loosely.');
    if (estimate.stalled) parts.push('The card in flight is taking longer than the ones before it.');
    if (estimate.source === 'run') parts.push('Counts the time Autopilot spent resting.');
  } else if (remaining > 0) {
    parts.push(`A pace appears once ${BUILD_PACE_MIN_CARDS} cards are done.`);
  }
  parts.push(...caveats);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function deriveBuildProgress(input: BuildProgressInput): BuildProgress {
  const { board, nowMs } = input;
  const of = (status: string): number => board.cards.filter((card) => card.status === status).length;

  const cardsTotal = board.cards.length;
  const cardsDone = of('done');
  const cardsBlocked = of('blocked');
  const cardsReview = of('review');
  const cardsInFlight = of('inProgress');
  const cardsWaiting = of('ready') + of('backlog');

  const buildable = Math.max(0, cardsTotal - cardsBlocked);
  const percent = buildable > 0 ? Math.round((cardsDone / buildable) * 100) : 0;

  const autopilot = input.autopilot && AUTOPILOT_ACTIVE.has(input.autopilot.phase) ? input.autopilot : null;
  const auto = input.auto && AUTO_ACTIVE.has(input.auto.phase) ? input.auto : null;
  const inFlight = board.cards.find((card) => card.status === 'inProgress') ?? null;

  const driver: BuildDriver = autopilot ? 'autopilot' : auto ? 'auto' : inFlight ? 'board' : 'idle';
  const active = autopilot ?? auto;

  // Autopilot names the card it is on. Auto works one task, not a card, so the board's own in-flight card is the most
  // that can honestly be shown — and the note says as much rather than implying Auto picked it.
  const current = autopilot?.cardId ? { id: autopilot.cardId, title: autopilot.cardTitle ?? null } : inFlight ? { id: inFlight.id, title: inFlight.title } : null;
  const attempt = autopilot?.cardId ? (autopilot.attempt ?? null) : null;
  const actor = driver === 'autopilot'
    ? 'Autopilot'
    : driver === 'auto'
      ? (auto?.activeProvider ?? 'Auto')
      : (inFlight?.claimedBy ?? null);

  const startedAt = active?.startedAt ?? null;
  const startedMs = timeOf(startedAt);
  const elapsedMs = startedMs !== undefined ? Math.max(0, nowMs - startedMs) : null;

  const remaining = Math.max(0, cardsTotal - cardsDone - cardsBlocked - cardsReview);

  // The pace, when there is one to stand on.
  const completions = buildCompletions(board);
  const sinceStart = startedMs !== undefined ? completions.filter((at) => at >= startedMs) : [];
  const useRun = driver === 'autopilot' && startedMs !== undefined && sinceStart.length >= BUILD_PACE_MIN_CARDS;
  const sample = useRun ? sinceStart : completions;

  let pace: PaceEstimate | null = null;
  if (remaining > 0 && sample.length >= BUILD_PACE_MIN_CARDS) {
    const observedMs = useRun
      ? nowMs - startedMs!
      : sample[sample.length - 1]! - sample[0]!;
    const msPerCard = useRun
      ? observedMs / sample.length
      : median(sample.slice(1).map((at, index) => at - sample[index]!));
    if (observedMs >= BUILD_PACE_MIN_MS && msPerCard > 0) {
      // Only worth calling a card stalled if something is actually in flight to be late.
      const inFlightSince = inFlight ? timeOf(inFlight.movedAt) : undefined;
      const stalled = inFlightSince !== undefined && nowMs - inFlightSince > BUILD_STALL_FACTOR * msPerCard;
      const confidence = stalled || sample.length < 3 ? 'low' : sample.length >= 5 && observedMs >= 600_000 ? 'high' : 'medium';
      pace = {
        observedCards: sample.length,
        observedMs: Math.round(observedMs),
        msPerCard,
        cardsRemaining: remaining,
        etaAt: new Date(nowMs + remaining * msPerCard).toISOString(),
        source: useRun ? 'run' : 'board',
        confidence,
        stalled,
      };
    }
  }

  const caveats: string[] = [];
  if (cardsBlocked > 0) caveats.push(`${cardsBlocked} blocked card${cardsBlocked === 1 ? ' is' : 's are'} not counted.`);
  if (cardsReview > 0) caveats.push(`${cardsReview} card${cardsReview === 1 ? ' is' : 's are'} in review, waiting on a person.`);
  if (driver === 'auto') caveats.push('Auto is working one task, not the board; the counts are the project\'s.');

  return {
    cardsTotal,
    cardsDone,
    cardsBlocked,
    cardsReview,
    cardsInFlight,
    cardsWaiting,
    percent,
    driver,
    currentCardId: current?.id ?? null,
    currentCardTitle: current?.title ?? null,
    currentCardAttempt: attempt,
    actor,
    startedAt,
    elapsedMs,
    pace,
    paceNote: describePace(pace, caveats, remaining),
  };
}
