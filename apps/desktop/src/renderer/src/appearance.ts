/**
 * How big things are, and how tightly they sit. Both are the person's own taste on this machine, so they live in the
 * browser's storage rather than in the synced settings, and they are applied the moment they change.
 */
export type Density = 'compact' | 'default' | 'comfortable';

export interface Appearance {
  /** Whole-window scale in percent. 100 is the size the app was drawn at. */
  textScale: number;
  density: Density;
}

export const TEXT_SCALE_MIN = 80;
export const TEXT_SCALE_MAX = 150;
export const TEXT_SCALE_STEP = 5;
export const DEFAULT_APPEARANCE: Appearance = { textScale: 100, density: 'compact' };

const KEY = 'kai.appearance.v1';

export function clampScale(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_APPEARANCE.textScale;
  const stepped = Math.round(percent / TEXT_SCALE_STEP) * TEXT_SCALE_STEP;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, stepped));
}

export function loadAppearance(): Appearance {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>;
    return {
      textScale: clampScale(typeof parsed.textScale === 'number' ? parsed.textScale : DEFAULT_APPEARANCE.textScale),
      density: parsed.density === 'default' || parsed.density === 'comfortable' || parsed.density === 'compact' ? parsed.density : DEFAULT_APPEARANCE.density,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // The choice still applies for this session.
  }
}

/** Puts an appearance on screen: the density as an attribute the stylesheet reads, the scale through the window. */
export function applyAppearance(appearance: Appearance): void {
  document.documentElement.dataset.density = appearance.density;
  try {
    window.kaiDesktop?.setZoomFactor?.(appearance.textScale / 100);
  } catch {
    // A page without the bridge (a browser preview) simply stays at its own size.
  }
}
