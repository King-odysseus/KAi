/**
 * The console's colour theme. The four themes are the desktop's, under the same names, so a phone in
 * another room is looking at the colours the desktop would use. The choice is the phone's own and lives
 * in local storage beside the pairing token: changing it here must not change the desktop's.
 */
export const THEMES = ['dark', 'navy', 'purple', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark',
  navy: 'Navy',
  purple: 'Purple',
  light: 'Light',
};

const STORAGE_KEY = 'kai-remote-theme';
const DEFAULT: Theme = 'purple';

const listeners = new Set<() => void>();
let current: Theme = read();

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

function read(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT;
  } catch {
    // Storage can be refused; the console still works, it just will not remember across reloads.
    return DEFAULT;
  }
}

/** Puts the theme on the document, and moves the phone's status bar colour with it. */
function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const deep = getComputedStyle(document.documentElement).getPropertyValue('--bg-deep').trim();
    if (deep) meta.setAttribute('content', deep);
  }
}

/** Called once before the app renders, so a stored theme is on the page before the first paint. */
export function startTheme(): void {
  apply(current);
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  apply(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // No storage: the theme still holds for this session.
  }
  for (const listener of listeners) listener();
}

export function cycleTheme(): void {
  setTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
