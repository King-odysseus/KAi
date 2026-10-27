import { RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { COLOR_ROLES, applyColorOverrides, loadColorOverrides, resolveTokenHex, saveColorOverrides, type ColorOverrides, type ColorRole } from '../custom-colors';
import { UiButton } from './UiButton';

/**
 * Pick your own colours for the theme you are using. Changes show as you drag, are remembered for this theme only, and
 * each can be put back. Only a handful of colours are offered; the shades between them follow, so the window stays one
 * palette.
 */
export function ThemeColors({ theme, themeLabel }: { theme: string; themeLabel: string }): ReactNode {
  const [overrides, setOverrides] = useState<ColorOverrides>(() => loadColorOverrides(theme));
  // What each swatch shows when nothing is overridden: the colour the theme gives it, read off the page.
  const [shown, setShown] = useState<Record<string, string>>({});

  useEffect(() => {
    setOverrides(loadColorOverrides(theme));
  }, [theme]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const role of COLOR_ROLES) next[role.id] = overrides[role.id] ?? resolveTokenHex(role.token);
    setShown(next);
  }, [overrides, theme]);

  function change(next: ColorOverrides): void {
    setOverrides(next);
    saveColorOverrides(theme, next);
    applyColorOverrides(next);
  }

  function setRole(role: ColorRole, color: string): void {
    change({ ...overrides, [role]: color.toLowerCase() });
  }

  function resetRole(role: ColorRole): void {
    const { [role]: _removed, ...rest } = overrides;
    change(rest);
  }

  const customised = Object.keys(overrides).length;

  return (
    <div className="theme-colors">
      <p className="settings-note">
        Your own colours for <strong>{themeLabel}</strong>. They show as you pick them and are kept for this theme only. The lighter and
        darker shades in between follow, so the window still looks like one palette.
      </p>
      <div className="theme-color-grid">
        {COLOR_ROLES.map((role) => (
          <div key={role.id} className="theme-color-row">
            <input
              type="color"
              aria-label={`${role.label} colour`}
              value={shown[role.id] ?? '#000000'}
              onChange={(event) => setRole(role.id, event.target.value)}
            />
            <span className="theme-color-name"><strong>{role.label}</strong><small>{role.hint}</small></span>
            <code>{shown[role.id] ?? ''}</code>
            <UiButton
              type="button"
              className="icon-button compact"
              aria-label={`Reset ${role.label}`}
              title={overrides[role.id] ? 'Put back the theme colour' : 'Already the theme colour'}
              disabled={!overrides[role.id]}
              onClick={() => resetRole(role.id)}
            ><RotateCcw size={13} /></UiButton>
          </div>
        ))}
      </div>
      <div className="button-row">
        <UiButton type="button" className="secondary-button" disabled={customised === 0} onClick={() => change({})}>Reset all colours for this theme</UiButton>
      </div>
    </div>
  );
}
