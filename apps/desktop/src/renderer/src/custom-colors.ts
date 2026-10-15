/**
 * The colours a person has chosen for themselves, kept per theme.
 *
 * A theme is a full palette, and most of what a person wants to change is a handful of its colours: the background,
 * the panels, the text, the accent. So the editor offers those few, and everything else (the raised card, the hover
 * fill, the dimmer text) is derived from them with `color-mix`, which is what keeps a customised window looking like
 * one palette instead of a few changed boxes. Choices are stored per theme, so a dark theme's background is never
 * laid over a light one, and each can be reset on its own.
 */
export const COLOR_ROLES = [
  { id: 'background', label: 'Background', hint: 'The window behind everything', token: '--bg-deep' },
  { id: 'panel', label: 'Panels', hint: 'Sidebars, cards and the message box', token: '--bg-panel' },
  { id: 'text', label: 'Text', hint: 'Words and icons', token: '--text' },
  { id: 'accent', label: 'Accent', hint: 'Buttons, links and highlights', token: '--mint' },
  { id: 'border', label: 'Lines', hint: 'Dividers and outlines', token: '--border' },
  { id: 'warning', label: 'Waiting', hint: 'Something is paused or waiting', token: '--amber' },
  { id: 'danger', label: 'Needs you', hint: 'An error, or something that needs your decision', token: '--red' },
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number]['id'];
export type ColorOverrides = Partial<Record<ColorRole, string>>;

const STORAGE_KEY = 'kai.themeColors.v1';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Every property a role may set, so applying a new set first clears whatever the last one left behind. */
const MANAGED_PROPERTIES = [
  '--bg-deep', '--bg-shell', '--bg-inset', '--bg-panel', '--bg-raised', '--bg-input', '--bg-subtle', '--bg-hover',
  '--text', '--text-muted', '--text-dim', '--mint', '--mint-strong', '--mint-soft', '--border', '--border-soft',
  '--amber', '--red',
];

/** The properties one role sets, as the colour the person picked and the shades derived from it. */
export function propertiesFor(role: ColorRole, color: string): Record<string, string> {
  switch (role) {
    case 'background':
      return { '--bg-deep': color, '--bg-shell': color, '--bg-inset': `color-mix(in srgb, ${color} 82%, black)` };
    case 'panel':
      return {
        '--bg-panel': color,
        '--bg-raised': `color-mix(in srgb, ${color} 92%, var(--text))`,
        '--bg-input': `color-mix(in srgb, ${color} 94%, var(--text))`,
        '--bg-subtle': `color-mix(in srgb, ${color} 94%, var(--bg-deep))`,
        '--bg-hover': `color-mix(in srgb, ${color} 86%, var(--text))`,
      };
    case 'text':
      return {
        '--text': color,
        '--text-muted': `color-mix(in srgb, ${color} 62%, var(--bg-panel))`,
        '--text-dim': `color-mix(in srgb, ${color} 42%, var(--bg-panel))`,
      };
    case 'accent':
      return { '--mint': color, '--mint-strong': `color-mix(in srgb, ${color} 80%, black)`, '--mint-soft': `color-mix(in srgb, ${color} 16%, transparent)` };
    case 'border':
      return { '--border': color, '--border-soft': `color-mix(in srgb, ${color} 55%, var(--bg-panel))` };
    case 'warning':
      return { '--amber': color };
    case 'danger':
      return { '--red': color };
  }
}

function loadAll(): Record<string, ColorOverrides> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ColorOverrides> = {};
    for (const [theme, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const overrides: ColorOverrides = {};
      for (const role of COLOR_ROLES) {
        const color = (value as Record<string, unknown>)[role.id];
        if (typeof color === 'string' && HEX.test(color)) overrides[role.id] = color.toLowerCase();
      }
      result[theme] = overrides;
    }
    return result;
  } catch {
    return {};
  }
}

export function loadColorOverrides(theme: string): ColorOverrides {
  return loadAll()[theme] ?? {};
}

export function saveColorOverrides(theme: string, overrides: ColorOverrides): void {
  try {
    const all = loadAll();
    if (Object.keys(overrides).length === 0) delete all[theme];
    else all[theme] = overrides;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // The colours still apply for this session.
  }
}

/** Puts a theme's chosen colours on the page, replacing whatever the previous theme's choices left there. */
export function applyColorOverrides(overrides: ColorOverrides): void {
  const style = document.documentElement.style;
  for (const property of MANAGED_PROPERTIES) style.removeProperty(property);
  for (const role of COLOR_ROLES) {
    const color = overrides[role.id];
    if (!color) continue;
    for (const [property, value] of Object.entries(propertiesFor(role.id, color))) style.setProperty(property, value);
  }
}

/** What a token looks like on screen right now, as #rrggbb, so the picker starts on the colour the person sees. */
export function resolveTokenHex(token: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const match = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(rgb);
    if (!match) return '#000000';
    return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return '#000000';
  }
}
