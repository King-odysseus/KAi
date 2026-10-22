import { z } from 'zod';
import { explainBlocked, machineBlocked } from './blocked';
import { guideActionSchema, type GuideAction } from './studio-guide';
import { lacksRoute } from './studio';

/**
 * The one thing that needs the person, in one line, with the one button that does it.
 *
 * Autopilot can stop for a handful of reasons and it can stop in the middle of the night. What it must never do is
 * stop *quietly*: a board full of parked cards and a strip that says "Autopilot is not running" leaves someone to
 * work out for themselves which of five things is theirs to do. This picks exactly one of them, in the order that
 * actually unsticks the project, and says it in words that name the action rather than the symptom.
 *
 * It is a pure function of what the project already holds, for the same reason `guideSteps` is: a judgement that
 * costs a model call and may be wrong is worse than a rule that is free and cannot be. `null` is the honest answer
 * when nothing is being asked of anyone — it is not "no attention", it is "nothing here needs you", and the screen
 * says nothing rather than showing a banner that means none.
 */

export const ATTENTION_TONES = ['waiting', 'needs-you', 'done'] as const;
export const attentionToneSchema = z.enum(ATTENTION_TONES);
/**
 * `needs-you` is the project stalled until a person acts; `waiting` is work carrying on that would go better with a
 * hand, or a rest that wants nobody at all; `done` is finished. The distinction is the point: colouring a nudge the
 * same red as a stall teaches people to ignore the red.
 */
export type AttentionTone = z.infer<typeof attentionToneSchema>;

export const studioAttentionSchema = z
  .object({
    tone: attentionToneSchema,
    /** One line naming the situation, addressed to the person. */
    headline: z.string().min(1).max(200),
    /** What is going on and what pressing the button will do. */
    detail: z.string().max(1_000),
    action: guideActionSchema.nullable(),
    actionLabel: z.string().max(60).nullable(),
    /** The cards this is about, so the screen can point at them. */
    cardIds: z.array(z.string().max(120)).max(50),
  })
  .strict();
export type StudioAttention = z.infer<typeof studioAttentionSchema>;

/** What the rules are told about one card. A subset of `BoardCard`, so a caller passes cards it already has. */
export interface AttentionCard {
  id: string;
  title: string;
  kind: string;
  status: string;
  notes: string;
  movedBy?: string | null;
  route: string;
  needsArtifacts: readonly string[];
  stale: boolean;
  staleReason?: string | null;
}

/** What the rules are told about the run, or null when none has gone for this project. */
export interface AttentionRun {
  phase: string;
  message: string;
  resumeAt: string | null;
  restReason: string | null;
  devCheck: { passed: boolean; summary: string; url: string | null } | null;
}

export interface StudioAttentionInput {
  cards: readonly AttentionCard[];
  /** The artifact kinds that have actually been written, so "needs tokens" can be told from "tokens are there". */
  writtenArtifacts: readonly string[];
  /** How many screens the design holds; zero means nothing has been drawn or pulled yet. */
  designPages: number;
  /** The steps the guide already decided, so this never contradicts the button underneath it. */
  steps: readonly { id: string; state: string; title: string; detail: string; action: GuideAction | null; actionLabel: string | null }[];
  run: AttentionRun | null;
  /** Injected so the "resting until 14:20" line can be asserted without depending on the wall clock. */
  now?: number;
}

/** A phase where the run is still going, so what it left behind is not yet the person's to pick up. */
const RUNNING = new Set(['working', 'checking', 'cooling']);

/** The design documents a card can be waiting on. `stack` and `stories` are a planning problem, not a design one. */
const DESIGN_ARTIFACTS = new Set(['tokens', 'style-guide']);

/** A parked card whose own reason names the design, so the fix is to draw or share one rather than to rerun it. */
const DESIGN_REASON = /\b(design|tokens?|style[-\s]?guide|open[-\s]?pencil|figma|wireframe|mockup|palette)\b/i;

const isScreen = (card: AttentionCard): boolean => card.kind === 'component' || card.kind === 'page';

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The one thing to say, or null when nothing here needs the person.
 *
 * The order is the whole judgement. A rest comes first because it needs nobody and reading "resting" as "stuck" is
 * the exact mistake this is here to prevent. A run that stopped and left cards behind comes next, because they gate
 * everything after them. A design that was never drawn sits above the ordinary parked cards on purpose: parking is
 * what a missing design *looks like* on the board, and telling someone to put the cards back without saying the
 * design is missing would send them round the same loop a second time.
 */
export function studioAttention(input: StudioAttentionInput): StudioAttention | null {
  const { cards, run } = input;
  const parked = cards.filter((card) => machineBlocked(card));
  const running = run !== null && RUNNING.has(run.phase);

  // 1. A run that is resting wants nothing from anyone. Said first so a rate-limit break never reads as a stall.
  if (run?.phase === 'cooling' && run.resumeAt) {
    const at = clock(run.resumeAt);
    return attention('waiting', at ? `Resting until ${at}` : 'Resting', [
      'The provider has had enough for now, so Autopilot is waiting it out and will carry on by itself.',
      run.restReason ? `Reason given: ${run.restReason}` : '',
      'Nothing is needed from you.',
    ].filter(Boolean).join(' '), null, null, []);
  }

  // 2. A run that stopped or failed with cards left parked: someone has to put them back before anything moves.
  if (run && (run.phase === 'failed' || run.phase === 'stopped') && parked.length > 0) {
    return parkedAttention(parked, [`Autopilot ${run.phase === 'failed' ? 'stopped on a problem' : 'was stopped'} and left these behind.`, run.message].filter(Boolean).join(' '));
  }

  // 3. A parked card whose reason is the design: rerunning it changes nothing, so name the real fix.
  const parkedOnDesign = parked.filter((card) => DESIGN_REASON.test(card.notes));
  if (parkedOnDesign.length > 0) {
    return designAttention(cards, 'needs-you', `The build is stopped over the design (${plural(parkedOnDesign.length, 'card')} parked over it).`);
  }

  // 4. Screen cards with nowhere to point can never pass a screen check, and hold every card behind them.
  // Only a page must say where it lives; a component with no route is seen through the page that holds it.
  const noRoute = cards.filter(lacksRoute);
  if (noRoute.length > 0) {
    return attention(
      'needs-you',
      `${plural(noRoute.length, 'screen has', 'screens have')} no route`,
      'A screen card cannot pass its screen check without a route to open, so it and everything behind it wait for good. Give each one the path it lives at, then put it back in the queue.',
      'open-board',
      'Set the routes on the board',
      noRoute.map((card) => card.id),
    );
  }

  // 5. Nothing drawn, or a design document a card reads that was never written. The work carries on regardless, so
  // this is amber rather than red: it is worth a hand, not a stall, and colouring a nudge like a stall is how a
  // person learns to stop reading either.
  if (hasUnreadyDesign(input)) {
    return designAttention(cards, 'waiting', input.designPages === 0 ? 'The design has not been drawn yet.' : 'A design document the cards read has not been written yet.');
  }

  // 6. Cards a machine parked while nothing is running: movable without any other decision.
  if (!running && parked.length > 0) {
    return parkedAttention(parked, `An agent parked ${parked.length === 1 ? 'it' : 'them'} and carried on with the rest of the board.`);
  }

  // 7. Whatever the guide already decided needs the reader, if it named a step as stuck.
  const stuck = input.steps.find((step) => step.state === 'blocked');
  if (stuck) return attention('needs-you', stuck.title, stuck.detail, stuck.action, stuck.actionLabel, []);

  // 8. The run's own dev proof, once it has one — the answer to "is there an app on dev".
  if (run?.devCheck && !run.devCheck.passed) {
    return attention('needs-you', 'The app does not run cleanly on dev', `${run.devCheck.summary} The cards are done; this is what the finished project turned out to do when it was opened. Nothing has been committed or deployed.`, null, null, []);
  }

  // 9. Every card done, and the app proved to run. This is the line someone who walked away is looking for. Not while
  // a run is still going: in the seconds it spends taking the dev proof the honest answer is the panel's own line,
  // not a finished banner over work that has not been checked yet.
  if (!running && cards.length > 0 && cards.every((card) => card.status === 'done')) {
    const url = run?.devCheck?.passed ? run.devCheck.url : null;
    return attention(
      'done',
      url ? 'Everything is built and running on dev' : 'Everything is built',
      url
        ? `Every card passed its check and the app is serving at ${url}. Nothing has been committed or deployed.`
        : 'Every card passed its check. Start Autopilot to confirm the app runs on dev before you rely on it.',
      null,
      null,
      [],
    );
  }

  return null;
}

/**
 * Whether the design is behind what the cards are built from.
 *
 * Missing is different from stale, and both matter here. A card whose `tokens` were never written is being built to
 * a provisional look right now; a card marked stale is one that was built to a design that has since moved. Either
 * way the answer is the same sentence, and neither is a reason to stop.
 */
function hasUnreadyDesign(input: StudioAttentionInput): boolean {
  if (input.cards.some((card) => card.stale)) return true;
  const written = new Set(input.writtenArtifacts);
  const needed = input.cards.flatMap((card) => card.needsArtifacts).filter((kind) => DESIGN_ARTIFACTS.has(kind));
  if (needed.some((kind) => !written.has(kind))) return true;
  // A UI card on a project with no design at all is the same situation seen from the other side.
  return input.designPages === 0 && input.cards.some(isScreen);
}

function parkedAttention(parked: readonly AttentionCard[], why: string): StudioAttention {
  const { ask } = explainBlocked(parked[0]!.notes);
  return attention(
    'needs-you',
    `${plural(parked.length, 'card')} ${parked.length === 1 ? 'needs' : 'need'} you`,
    [why, ask].filter(Boolean).join(' '),
    'requeue-blocked',
    'Put them back in the queue',
    parked.map((card) => card.id),
  );
}

function designAttention(cards: readonly AttentionCard[], tone: AttentionTone, headline: string): StudioAttention {
  return attention(
    tone,
    headline,
    'The cards are still being built — to a provisional look taken from the brief, so nothing is stuck on you. When you are ready, share reference images or draw the screens in open-pencil, then pull the design and the finished screens are restyled to match.',
    'open-design',
    'Open the design',
    cards.filter((card) => isScreen(card)).map((card) => card.id).slice(0, 50),
  );
}

function attention(
  tone: AttentionTone,
  headline: string,
  detail: string,
  action: GuideAction | null,
  actionLabel: string | null,
  cardIds: readonly string[],
): StudioAttention {
  return studioAttentionSchema.parse({ tone, headline, detail, action, actionLabel, cardIds: [...cardIds] });
}
