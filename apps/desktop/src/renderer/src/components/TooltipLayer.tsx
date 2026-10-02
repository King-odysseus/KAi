import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Upgrades the app's native tooltips to styled ones, everywhere at once.
 *
 * KAI has 256 `title="…"` attributes. Those are drawn by the operating system, not the page, so no stylesheet can
 * reach them — the only way to style a tooltip is to stop using the attribute and render a real element instead.
 *
 * Editing 256 call sites would be a large, risky change for a visual one, and would have to be redone whenever
 * somebody adds a `title`. So rather than replacing them, this watches for the attribute instead: on hover or focus it
 * takes the text off the element (which is what suppresses the native tooltip), shows a styled panel with the same
 * words, and puts the attribute back when the pointer leaves. Existing markup is untouched, new `title` attributes are
 * picked up for free, and nothing has to be migrated.
 *
 * Elements can opt out with `data-no-tip`, which the code editor needs: Monaco draws its own hints and would otherwise
 * lose the titles on its own controls.
 */

/** Where the panel sits relative to its target, chosen by how much room is above and below. */
export type TipSide = 'top' | 'bottom';

export interface TipPlacement {
  side: TipSide;
  /** Viewport coordinates for the panel's top-left, before the panel's own size is known. */
  left: number;
  top: number;
}

const GAP = 8;
/** Room a panel needs above or below before flipping to the other side. */
const NEEDED = 44;
const EDGE = 8;

/**
 * Places the panel against a target rectangle, kept inside the window.
 *
 * Split out from the component because it is the part worth testing: the flip and the clamping are where a tooltip
 * ends up off-screen or upside down, and neither is visible without a browser.
 */
export function placeTooltip(target: { left: number; right: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }): TipPlacement {
  const centre = target.left + target.width / 2;
  // Below when there is no room above, so a control near the top of the window does not open into the title bar.
  const side: TipSide = target.top < NEEDED ? 'bottom' : 'top';
  const top = side === 'top' ? target.top - GAP : target.bottom + GAP;
  // Clamped so a control at the window edge does not push its panel off-screen; the panel is transformed back by half
  // its own width in CSS, so the edge allowance covers that.
  const left = Math.min(Math.max(centre, EDGE + 120), Math.max(EDGE + 120, viewport.width - EDGE - 120));
  return { side, left, top };
}

interface Shown {
  text: string;
  side: TipSide;
  left: number;
  top: number;
  width: number;
}

/** Titles that say nothing worth a panel: empty, or a single word the control already shows. */
function worthShowing(text: string): boolean {
  return text.trim().length > 0;
}

function isExcluded(element: Element): boolean {
  return Boolean(element.closest('[data-no-tip], .monaco-editor, .app-tooltip'));
}

export function TooltipLayer(): ReactNode {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    // The element whose title is currently held, so it can be put back exactly where it came from.
    let held: { element: Element; title: string } | null = null;

    const restore = (): void => {
      if (held) {
        held.element.setAttribute('title', held.title);
        held = null;
      }
      setShown(null);
    };

    const show = (element: Element): void => {
      if (held?.element === element) return;
      const title = element.getAttribute('title');
      if (title === null) return;
      restore();
      if (!worthShowing(title) || isExcluded(element)) return;

      // Taking the attribute off is what stops the operating system drawing its own tooltip on top of this one.
      held = { element, title };
      element.removeAttribute('title');

      const rect = element.getBoundingClientRect();
      const { side, left, top } = placeTooltip(rect, { width: window.innerWidth, height: window.innerHeight });
      setShown({ text: title, side, left, top, width: rect.width });
    };

    const fromEvent = (event: Event): Element | null => {
      const path = event.composedPath();
      for (const node of path) {
        if (node instanceof Element) return node;
      }
      return event.target instanceof Element ? event.target : null;
    };

    const onOver = (event: Event): void => {
      const element = fromEvent(event);
      if (element) show(element);
    };

    // Leaving anything restores it: the pointer may be moving to a child, but the next pointerover re-shows it, and a
    // flicker is cheaper than a tooltip that stays on screen after the pointer has gone.
    const onOut = (next: EventTarget | null): void => {
      if (!held) return;
      // Moving onto a child of the same control is not leaving it.
      if (next instanceof Node && held.element.contains(next)) return;
      restore();
    };

    const onPointerOver = (event: PointerEvent): void => onOver(event);
    const onPointerOut = (event: PointerEvent): void => onOut(event.relatedTarget);
    const onFocusIn = (event: FocusEvent): void => {
      const element = fromEvent(event);
      if (element) show(element);
    };
    const onFocusOut = (event: FocusEvent): void => onOut(event.relatedTarget);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') restore();
    };
    // A scroll or a resize moves the target out from under the panel, so it is dismissed rather than left floating.
    const onMove = (): void => restore();

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);

    return () => {
      restore();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, []);

  if (!shown) return null;

  // Rendered into the body so no ancestor transform or overflow on the way up can clip or shift it.
  return createPortal(
    <div
      className="app-tooltip"
      data-side={shown.side}
      role="tooltip"
      style={{ left: shown.left, top: shown.top, maxWidth: Math.min(320, Math.max(180, shown.width * 4)) }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
