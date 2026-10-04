import { describe, expect, it } from 'vitest';
import { forDisplay, placeTooltip } from '../apps/desktop/src/renderer/src/components/TooltipLayer';

/**
 * Where a tooltip lands. The layer itself needs a browser, but the arithmetic that decides the side and the clamping is
 * pure, and it is where a panel ends up upside down or half off-screen — neither of which is visible without running
 * the app.
 */
const VIEWPORT = { width: 1200, height: 800 };

function target(left: number, top: number, width = 80, height = 30) {
  return { left, top, width, right: left + width, bottom: top + height };
}

describe('tooltip placement', () => {
  it('opens above a control that has room above it, centred on the control', () => {
    const placed = placeTooltip(target(500, 400), VIEWPORT);
    expect(placed.side).toBe('top');
    expect(placed.left).toBe(540); // the centre of the control
    expect(placed.top).toBe(400 - 8); // its top edge, less the gap
  });

  it('opens below a control near the top, so it does not go under the title bar', () => {
    expect(placeTooltip(target(500, 10), VIEWPORT).side).toBe('bottom');
    // A control at the very top has no room above at all.
    expect(placeTooltip(target(500, 0), VIEWPORT).top).toBe(30 + 8);
  });

  it('answers a small control in the left rail sideways, clear of the rail itself', () => {
    // The navigation rail is a narrow column at the window edge. A panel above an icon there covers the rail it is
    // describing, which is what made this wrong.
    const placed = placeTooltip(target(8, 400, 40, 40), VIEWPORT);
    expect(placed.side).toBe('right');
    expect(placed.left).toBe(48 + 8); // the control's right edge, plus the gap
    expect(placed.top).toBe(420); // its vertical centre, since the panel is anchored on that
  });

  it('answers a small control at the right edge sideways too, to its left', () => {
    const placed = placeTooltip(target(1152, 400, 40, 40), VIEWPORT);
    expect(placed.side).toBe('left');
    expect(placed.left).toBe(1152 - 8);
  });

  it('still answers above and below for wide controls near an edge', () => {
    // A sidebar row spans most of its column: it is at the edge but is not a rail item, so the usual placement holds.
    const placed = placeTooltip(target(0, 400, 260, 32), VIEWPORT);
    expect(placed.side).toBe('top');
  });

  it('keeps the panel inside the window at both edges', () => {
    const left = placeTooltip(target(0, 400), VIEWPORT);
    expect(left.left).toBeGreaterThan(0);
    const right = placeTooltip(target(1190, 400), VIEWPORT);
    // The panel is transformed back by half its own width, so the clamp has to leave room for that.
    expect(right.left).toBeLessThanOrEqual(VIEWPORT.width);
    expect(right.left).toBeGreaterThan(0);
  });

  it('still returns a usable position in a window too narrow for its own margins', () => {
    // A very narrow window must not push the panel to a negative coordinate.
    const placed = placeTooltip(target(10, 400), { width: 200, height: 400 });
    expect(Number.isFinite(placed.left)).toBe(true);
    expect(placed.left).toBeGreaterThan(0);
  });
});

describe('tooltip text length', () => {
  it('leaves a short title alone', () => {
    expect(forDisplay('Delete my-project')).toBe('Delete my-project');
  });

  it('cuts a title built from free-form content instead of letting it wrap into a wall of text', () => {
    // A project's full written brief can stand in for a title with no length limit of its own — the case that
    // turned a hover hint into a panel tall enough to cover the whole screen.
    const brief = 'SharpSite is a template-based website builder for Nigerian small businesses. '.repeat(10);
    const result = forDisplay(brief);
    expect(result.length).toBeLessThan(brief.length);
    expect(result.endsWith('…')).toBe(true);
  });
});
