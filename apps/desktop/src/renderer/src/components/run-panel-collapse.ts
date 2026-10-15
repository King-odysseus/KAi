import { useCallback, useState } from 'react';

const PREFIX = 'kai.runPanel.collapsed.';

/**
 * Whether a run panel is minimised, remembered across mounts.
 *
 * A panel that takes the composer over has to be something the person can put away, and it should stay put away when
 * they switch tabs or come back to the view. The choice is per panel, so minimising Auto does not fold the Studio's
 * Autopilot away with it.
 */
export function useRunPanelCollapsed(key: string, collapsedByDefault = false): [boolean, () => void] {
  const storageKey = `${PREFIX}${key}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === null ? collapsedByDefault : saved === '1';
    } catch { return collapsedByDefault; }
  });
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      // A window with storage locked down keeps the choice in memory instead of failing the click.
      try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* memory only */ }
      return next;
    });
  }, [storageKey]);
  return [collapsed, toggle];
}
