import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_MODES, themeFamily, themeModeSchema } from '../packages/contracts/src';
import { themeCss } from '../apps/desktop/scripts/generate-themes.mjs';

/**
 * The two ways the theme system goes wrong without anything failing.
 *
 * One: `themes.generated.css` is derived from the colour literals in `styles.css`, and nothing regenerates it. It went
 * stale for a long stretch — every component styled after the `:root[data-theme="light"]` block, which is where the
 * generator used to stop, had no Purple or Navy equivalent — and it stayed stale because nothing was looking.
 *
 * Two: a theme is added to the list of themes and given no colours, so picking it does nothing. That is one line to
 * forget and a whole palette to notice.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = path.join(here, '..', 'apps', 'desktop', 'src', 'renderer', 'src');
const read = (file: string): string => readFileSync(path.join(rendererSource, file), 'utf8');

describe('generated theme stylesheet', () => {
  it('is what the generator produces today, so a colour added to styles.css cannot go unmapped', () => {
    expect(read('themes.generated.css')).toBe(themeCss());
  });

  it('re-maps the rules that sit after where it used to stop', () => {
    // The composer's later rules are the ones the old cut-off point skipped. If the generator ever stops early again,
    // this is the rule that says so.
    const generated = read('themes.generated.css');
    expect(generated).toContain('data-theme="purple"');
    expect(generated).toContain('data-theme="navy"');
    expect(generated.split('\n').length).toBeGreaterThan(2_000);
  });
});

describe('the list of themes', () => {
  it('offers four dark themes and four light ones', () => {
    expect(THEME_MODES.filter((theme) => theme.family === 'dark')).toHaveLength(4);
    expect(THEME_MODES.filter((theme) => theme.family === 'light')).toHaveLength(4);
  });

  it('gives every theme but the base one a palette, so choosing one is never a no-op', () => {
    // `dark` is the base palette every other theme overrides, and it lives in styles.css with the rest of the base
    // rules rather than in themes.css. Everything else has to bring its own colours.
    const themes = read('themes.css');
    for (const theme of THEME_MODES.filter((item) => item.id !== 'dark')) {
      expect(themes, `${theme.id} has no colour block in themes.css`).toContain(`:root[data-theme="${theme.id}"] {`);
    }
  });

  it('names every theme, and no two the same', () => {
    const labels = THEME_MODES.map((theme) => theme.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const theme of THEME_MODES) expect(theme.label.trim().length).toBeGreaterThan(0);
  });

  it('reads the family of a theme it knows, and stays dark for one it does not', () => {
    expect(themeFamily('sky')).toBe('light');
    expect(themeFamily('forest')).toBe('dark');
    expect(themeFamily('chartreuse')).toBe('dark');
    expect(themeFamily(null)).toBe('dark');
  });

  it('accepts every listed theme and rejects one that is not on the list', () => {
    for (const theme of THEME_MODES) expect(themeModeSchema.safeParse(theme.id).success, theme.id).toBe(true);
    expect(themeModeSchema.safeParse('chartreuse').success).toBe(false);
  });
});
