import { parsePages, type StudioDesign, type StudioDesignPull } from '@kai/contracts';
import { screenRows, screenTitleKey, type ScreenRow } from './flow-diagram';

/**
 * What the design build loop decides between steps: did the last turn actually leave anything behind, and what is
 * still to draw.
 *
 * These live here, away from the component, because they are the part that was wrong. The loop used to tick the
 * Foundation box and count a screen as drawn on the agent's own say-so — a turn that reports `completed` has only
 * said it ended without a technical error, which is not the same thing at all. Under Plan access every write it
 * attempted was refused, so "completed" turns drew nothing, and the checklist filled up with ticks for work that had
 * not happened. Everything here reads the design back from the editor instead.
 *
 * A pull is what `studio:design-pull` answers with: the tokens, the components, and the pages open-pencil holds.
 */

/** The pages open-pencil holds, by the name each page carries. */
function drawnPageNames(pull: Pick<StudioDesignPull, 'design'>): string[] {
  return (pull.design as StudioDesign).components.filter((component) => component.screen).map((component) => component.name);
}

/**
 * Whether the foundation step left anything behind.
 *
 * The old check asked for `tokenCount === 0 && components.length === 0`, and never fired: every page is reported as a
 * component, so a blank document with its default "Page 1" already had one. A token, or a component that is a real
 * component rather than a page standing in for one, is what the foundation step is for.
 */
export function foundationLanded(pull: Pick<StudioDesignPull, 'tokenCount' | 'design'>): boolean {
  return pull.tokenCount > 0 || pull.design.components.some((component) => !component.screen);
}

/** Every screen row, recomputed from the design as it now stands — never from a copy taken when the build started. */
export function rowsFromPull(pagesText: string | null, pull: Pick<StudioDesignPull, 'design'>): ScreenRow[] {
  return screenRows(parsePages(pagesText ?? ''), drawnPageNames(pull));
}

/** The screens still to draw, read from this pull rather than from whatever the list looked like at the start. */
export function remainingScreens(pagesText: string | null, pull: Pick<StudioDesignPull, 'design'>): ScreenRow[] {
  return rowsFromPull(pagesText, pull).filter((row) => row.inPages && !row.drawn);
}

/** Whether the page for one screen exists now. Compared the same way the checklist compares it, so the tick and the
 * verification can never disagree. */
export function screenLanded(name: string, pull: Pick<StudioDesignPull, 'design'>): boolean {
  const wanted = screenTitleKey(name);
  return drawnPageNames(pull).some((drawn) => screenTitleKey(drawn) === wanted);
}
