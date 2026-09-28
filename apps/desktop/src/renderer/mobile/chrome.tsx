import { useSyncExternalStore, type ReactNode } from 'react';
import { cycleTheme, getTheme, subscribeTheme, THEME_LABELS } from './theme';

/**
 * The theme switch. It sits in the top bar of every section rather than inside one section's settings,
 * because the theme is the console's, not a section's. Tapping cycles it, the way the desktop's
 * title-bar button does.
 */
function ThemeButton(): ReactNode {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  return (
    <button
      type="button"
      className="theme-btn"
      onClick={cycleTheme}
      title="Change theme"
      aria-label={`Theme: ${THEME_LABELS[theme]}. Tap to change.`}
    >
      <span className="swatch" />
      {THEME_LABELS[theme]}
    </button>
  );
}

/**
 * The bar at the top of a section: its name, whatever live indicator the section wants, and the theme
 * switch. Every screen reaches for this so the switch is in the same place on all of them.
 */
export function TopBar({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="appbar">
      <h1>{title}</h1>
      <div className="appbar-side">
        <span className="conn">{children}</span>
        <ThemeButton />
      </div>
    </div>
  );
}
