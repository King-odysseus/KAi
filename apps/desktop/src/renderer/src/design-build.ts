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
export function drawnPageNames(pull: Pick<StudioDesignPull, 'design'>): string[] {
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

/**
 * The screens a redraw asks for: every screen the pages list names, or just one of them — taken from the request
 * rather than from the pull, because the whole point of a redraw is a screen that is already drawn and so would
 * never appear in `remainingScreens`. A page that exists only in open-pencil is left out, the same as anywhere else,
 * so a redraw can never touch work nobody planned.
 */
export function screensToRedraw(pagesText: string | null, pull: Pick<StudioDesignPull, 'design'>, only?: string): ScreenRow[] {
  const inPages = rowsFromPull(pagesText, pull).filter((row) => row.inPages);
  if (only === undefined) return inPages;
  const wanted = screenTitleKey(only);
  return inPages.filter((row) => screenTitleKey(row.name) === wanted);
}

/** Whether the page for one screen exists now. Compared the same way the checklist compares it, so the tick and the
 * verification can never disagree. */
export function screenLanded(name: string, pull: Pick<StudioDesignPull, 'design'>): boolean {
  const wanted = screenTitleKey(name);
  return drawnPageNames(pull).some((drawn) => screenTitleKey(drawn) === wanted);
}

/**
 * The open-pencil page a checklist row stands for, by id, or null when the screen exists only in `pages.md`.
 *
 * The row itself carries no page id — it is matched to a page by the loose name key everywhere else — so the id is
 * resolved here, from the last pull, at the moment a person acts on a row. A page that exists only in the editor
 * (a row with `inPages: false`) resolves too, which is what lets a stray page be renamed or deleted.
 */
export function screenPageId(design: StudioDesign | null, name: string): string | null {
  const key = screenTitleKey(name);
  return design?.components.find((component) => component.screen && screenTitleKey(component.name) === key)?.id ?? null;
}
