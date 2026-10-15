import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * Where the panel sits relative to its target. Above and below is the default, but a small control inside a vertical
 * rail gets a panel to its side: the navigation rail is a narrow column at the window edge, so a tooltip above an icon
 * there sits on top of the rail it is describing instead of beside it.
 */
export type TipSide = 'top' | 'bottom' | 'left' | 'right';

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
/** How near the window edge a control must be, and how small, to be treated as a rail item and answered sideways. */
const RAIL_ZONE = 96;
const RAIL_WIDTH = 140;
/** Half a panel's width, used to keep a centred panel clear of the window edges. Matches the widest a panel can grow to below. */
const HALF_PANEL = 140;

/**
 * Places the panel against a target rectangle, kept inside the window.
 *
 * Split out from the component because it is the part worth testing: the flip and the clamping are where a tooltip
 * ends up off-screen or upside down, and neither is visible without a browser.
 */
export function placeTooltip(target: { left: number; right: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }): TipPlacement {
  const centreX = target.left + target.width / 2;
  const centreY = target.top + (target.bottom - target.top) / 2;

  if (target.left < RAIL_ZONE && target.width <= RAIL_WIDTH) {
    // A control in the left rail: answer to its right, clear of the rail itself.
    return { side: 'right', left: target.right + GAP, top: clampY(centreY, viewport.height) };
  }
  if (target.right > viewport.width - RAIL_ZONE && target.width <= RAIL_WIDTH) {
    return { side: 'left', left: target.left - GAP, top: clampY(centreY, viewport.height) };
  }

  // Below when there is no room above, so a control near the top of the window does not open into the title bar.
  const side: TipSide = target.top < NEEDED ? 'bottom' : 'top';
  const top = side === 'top' ? target.top - GAP : target.bottom + GAP;
  // Clamped so a control at the window edge does not push its panel off-screen; the panel is transformed back by half
  // its own width in CSS, so the edge allowance covers that.
  const left = Math.min(Math.max(centreX, EDGE + HALF_PANEL), Math.max(EDGE + HALF_PANEL, viewport.width - EDGE - HALF_PANEL));
  return { side, left, top };
}

/** Keeps a sideways panel within the window without moving it off its control more than it has to. */
function clampY(centreY: number, viewportHeight: number): number {
  return Math.min(Math.max(centreY, EDGE + 20), Math.max(EDGE + 20, viewportHeight - EDGE - 20));
}

interface Shown {
  text: string;
  side: TipSide;
  left: number;
  top: number;
}

/** Titles that say nothing worth a panel: empty, or a single word the control already shows. */
function worthShowing(text: string): boolean {
  return text.trim().length > 0;
}

/** A tooltip is a short hint, not a document. Past this many characters it is cut with an ellipsis rather than
 * left to wrap into a tower of text tall enough to cover whatever the pointer is on its way to next — a title
 * built from free-form content (a project's full brief, standing in for a short name) could otherwise run to
 * several hundred characters. */
const MAX_TIP_CHARS = 220;

export function forDisplay(text: string): string {
  return text.length > MAX_TIP_CHARS ? `${text.slice(0, MAX_TIP_CHARS).trimEnd()}…` : text;
}

function isExcluded(element: Element): boolean {
  return Boolean(element.closest('[data-no-tip], .monaco-editor, .app-tooltip'));
}

export function TooltipLayer(): ReactNode {
  const [shown, setShown] = useState<Shown | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** How far the measured panel had to move to stay in the window, applied to the placement. */
  const [nudge, setNudge] = useState<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    // Keep the text in a data attribute. Restoring `title` on pointerout lets the
    // browser's native tooltip race the styled one and leaves a stale OS tooltip
    // visible after the pointer has moved away.
    let held: { element: Element; title: string } | null = null;

    const restore = (): void => {
      if (held) {
        held = null;
      }
      setShown(null);
    };

    const show = (element: Element): void => {
      if (held?.element === element) return;
      const title = element.getAttribute('data-kai-tooltip') ?? element.getAttribute('title');
      if (title === null) return;
      restore();
      if (!worthShowing(title) || isExcluded(element)) return;

      // Taking the attribute off is what stops the operating system drawing its own tooltip on top of this one.
      held = { element, title };
      element.removeAttribute('title');
      element.setAttribute('data-kai-tooltip', title);

      const rect = element.getBoundingClientRect();
      const { side, left, top } = placeTooltip(rect, { width: window.innerWidth, height: window.innerHeight });
      setShown({ text: forDisplay(title), side, left, top });
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

  // `placeTooltip` decides the side from how much room there looks to be above the control, which it has to guess:
  // the panel has not been rendered yet, so its height is unknown and a long tooltip is taller than the guess. That is
  // how one near the top of the window ended up running past the edge with its first line cut off. Measure it once it
  // exists and move it the rest of the way in, which also settles the left and right edges.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (box.top < EDGE) dy = EDGE - box.top;
    else if (box.bottom > window.innerHeight - EDGE) dy = window.innerHeight - EDGE - box.bottom;
    if (box.left < EDGE) dx = EDGE - box.left;
    else if (box.right > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - box.right;
    // Applied to the placement rather than the element, so the arrow keeps pointing at the control. Setting the same
    // value again is a no-op, so this settles after one pass.
    setNudge(dx !== 0 || dy !== 0 ? { dx, dy } : null);
  }, [shown]);

  if (!shown) return null;

  // Rendered into the body so no ancestor transform or overflow on the way up can clip or shift it.
  return createPortal(
    <div
      ref={panelRef}
      className="app-tooltip"
      data-side={shown.side}
      role="tooltip"
      style={{
        left: shown.left + (nudge?.dx ?? 0),
        top: shown.top + (nudge?.dy ?? 0),
        // Sized off the tooltip's own text, not the hovered control's width: a small icon button with a long title
        // (the project card's archive/delete row is the case that prompted this) was being capped to a narrow panel
        // sized for the button rather than the words in it, wrapping into a tall sliver that could run off-screen.
        maxWidth: Math.min(280, Math.max(140, shown.text.length * 6)),
      }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
