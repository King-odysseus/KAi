import type { GuideStepState } from '@kai/contracts';

/**
 * The half of a guide that does not care what its steps are called.
 *
 * The Studio guide and the Code guide decide different things — one reads a plan, the other reads a repository — but
 * they remember it the same way, and they have to get the same two things right: a milestone is recorded the *first*
 * time a step is passed and never again, and an explanation is kept only while the situation it was written for still
 * holds. Those are the parts worth having once. A second copy of them is a second place for them to be subtly wrong,
 * and the existing guide tests pin them precisely because they are easy to get wrong.
 *
 * The parsers stay with the caller. Each guide validates against its own schema, so the step ids and the narrative
 * shape are checked by the guide that owns them rather than by a lowest common denominator here.
 */

/** What every guide's step has to have to be remembered: an id, a title, and where it got to. */
export interface GuideStepLike {
  id: string;
  title: string;
  state: GuideStepState;
}

export interface GuideMilestoneLike {
  at: string;
  stepId: string;
  title: string;
}

export interface GuideNarrativeLike {
  headline: string;
  explanation: string;
}

export interface GuideLike {
  history: GuideMilestoneLike[];
  narrative: GuideNarrativeLike | null;
  narrativeFor: string;
  narrativeAt: string | null;
}

/**
 * Folds the steps into what the guide remembers, and says whether anything needs writing.
 *
 * Milestones are appended the first time a step is seen as done, so the history reads as "when this was first
 * finished" rather than "the last time anything moved" — which is what makes it readable a week later.
 */
export function recordProgress<TGuide extends GuideLike, TStep extends GuideStepLike>(
  guide: TGuide,
  steps: readonly TStep[],
  at: string,
  parse: (guide: TGuide) => TGuide,
): { guide: TGuide; changed: boolean } {
  const seen = new Set(guide.history.map((entry) => entry.stepId));
  const added = steps
    .filter((step) => step.state === 'done' && !seen.has(step.id))
    .map((step) => ({ at, stepId: step.id, title: step.title }));
  if (added.length === 0) return { guide, changed: false };
  return { guide: parse({ ...guide, history: [...guide.history, ...added].slice(-200) }), changed: true };
}

/** Files an explanation against the situation it was written for, so the next look can tell whether it still fits. */
export function keepNarrative<TGuide extends GuideLike>(
  guide: TGuide,
  narrative: GuideNarrativeLike,
  key: string,
  at: string,
  parse: (guide: TGuide) => TGuide,
): TGuide {
  return parse({ ...guide, narrative, narrativeFor: key, narrativeAt: at });
}

/**
 * Assembles the view the screen renders, offering the stored explanation only while it still fits the situation.
 *
 * `key` is the situation the caller decided the explanation belongs to. Passing it in rather than computing it here
 * is what lets each guide key on its own facts — the Code guide knows nothing about storyboards, and this file
 * should not have to.
 */
export function guideView<TGuide extends GuideLike, TStep extends GuideStepLike>(
  guide: TGuide,
  steps: readonly TStep[],
  key: string,
): {
  steps: TStep[];
  history: TGuide['history'];
  currentStepId: TStep['id'];
  narrative: TGuide['narrative'];
  narrativeAt: string | null;
} {
  // A project that has finished every step has no `current` one, so the last step is where it stands — this is what
  // makes a completed project read as "Everything is built" rather than as a screen with nothing on it.
  const current = steps.find((step) => step.state === 'current' || step.state === 'blocked') ?? steps[steps.length - 1]!;
  const fits = guide.narrative !== null && guide.narrativeFor === key;
  return {
    steps: [...steps],
    // The two casts are TypeScript's inability to see through an indexed access on a generic, not a looseness in the
    // shape: `TGuide['history']` is known to be an array of milestones and `TGuide['narrative']` a narrative or null,
    // both by the constraint on TGuide.
    history: [...guide.history] as TGuide['history'],
    currentStepId: current.id,
    narrative: (fits ? guide.narrative : null) as TGuide['narrative'],
    narrativeAt: fits ? guide.narrativeAt : null,
  };
}
