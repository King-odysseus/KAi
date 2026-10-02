import { describe, expect, it } from 'vitest';
import { placeTooltip } from '../apps/desktop/src/renderer/src/components/TooltipLayer';

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
