// Generates src/renderer/src/themes.generated.css.
//
// The base (dark) stylesheet hard-codes many colours, and every rule that does is re-mapped below for each theme.
//
// This used to stop at the `:root[data-theme="light"]` block, on the reasoning that everything from there on belonged
// to that theme. It did not: the block sat two thirds of the way down the file, so every component styled after it —
// the composer's later rules, reviews, the Equalizer, and the panels added since — kept the base palette in Purple
// and Navy. The light palette now lives in themes.css with the others, and this reads the whole stylesheet: the
// light-mode overrides start with `:root[data-theme-family="light"]` and are already skipped by the `:root` check
// below, so what gets re-mapped is the dark base, wherever in the file it sits.
// re-maps every colour literal in those rules to the theme's hue family and writes override rules,
// so the themes stay in step with the base stylesheet. Re-run it after changing colours in styles.css:
//
//   node apps/desktop/scripts/generate-themes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rendererSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src');
const inputs = ['styles.css', 'ops.css'];
const output = path.join(rendererSource, 'themes.generated.css');

// hue in degrees; satScale multiplies saturation of the base navy neutrals; lift raises dark lightness.
const themes = {
  // Editor: no tint at all. A saturation scale of zero turns every blue-grey neutral into a plain grey, and the base
  // accent becomes the one blue.
  code: {
    neutral: { hue: 0, satScale: 0, lift: 0.012 },
    accent: { hue: 207, sat: 1, light: 0.6 },
    lavender: { hue: 280, sat: 0.5 },
    amber: null,
  },
  purple: {
    neutral: { hue: 243, satScale: 0.62, lift: 0.028 },
    accent: { hue: 49, sat: 1, light: 0.49 },
    lavender: { hue: 274, sat: 1 },
    amber: { hue: 33 },
  },
  navy: {
    neutral: { hue: 222, satScale: 1.12, lift: 0.03 },
    accent: { hue: 208, sat: 1, light: 0.71 },
    lavender: { hue: 240, sat: 0.9 },
    amber: null,
  },
};

function hexToRgba(value) {
  let hex = value.slice(1);
  if (hex.length === 3) hex = [...hex].map((character) => character + character).join('');
  const int = Number.parseInt(hex.slice(0, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: alpha };
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const grey = Math.round(l * 255);
    return { r: grey, g: grey, b: grey };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return { r: Math.round(channel(hue + 1 / 3) * 255), g: Math.round(channel(hue) * 255), b: Math.round(channel(hue - 1 / 3) * 255) };
}

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function mapColor(theme, rgba) {
  const hsl = rgbToHsl(rgba);
  let { h, s, l } = hsl;
  if (s < 0.08) return rgba; // white, black and greys stay as they are
  const isAccent = h >= 135 && h <= 185 && s >= 0.3;
  const isLavender = h >= 245 && h <= 280 && s >= 0.45;
  const isAmber = h >= 20 && h <= 55 && s >= 0.4;
  const isRed = h >= 340 || h <= 15;
  if (isAccent && l < 0.2) {
    // Very dark green-tinted colours are text and backgrounds on top of the accent; keep them dark neutrals.
    h = theme.neutral.hue;
    s = clamp(s * 0.5);
  } else if (isAccent) {
    // The base accent (mint) sits at about 64% lightness; anchor it to the theme accent colour.
    h = theme.accent.hue;
    s = theme.accent.sat;
    l = clamp(theme.accent.light + (l - 0.64) * 0.6);
  } else if (isLavender) {
    h = theme.lavender.hue;
    s = clamp(s * theme.lavender.sat);
  } else if (isAmber) {
    if (theme.amber) h = theme.amber.hue;
  } else if (isRed) {
    // reds are semantic (errors) and stay red
  } else {
    // blue-grey neutrals: backgrounds, borders and text
    h = theme.neutral.hue + (h - 214) * 0.15;
    s = clamp(s * theme.neutral.satScale);
    if (l < 0.3) l = clamp(l * 1.22 + theme.neutral.lift * (1 - l / 0.3) * 0.6 + 0.004);
  }
  return { ...hslToRgb({ h, s, l }), a: rgba.a };
}

function format({ r, g, b, a }) {
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function remapValue(theme, value) {
  return value
    .replace(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (match) => format(mapColor(theme, hexToRgba(match))))
    .replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g, (_match, r, g, b, a) =>
      format(mapColor(theme, { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) })));
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Minimal CSS reader: rules and one level of @media/@supports. Other at-rules are skipped. */
function parseBlocks(css, start = 0, insideBlock = false) {
  const nodes = [];
  let index = start;
  let buffer = '';
  while (index < css.length) {
    const character = css[index];
    if (character === '}') return { nodes, end: index + 1 };
    if (character === '{') {
      const prelude = buffer.trim();
      buffer = '';
      if (/^@(media|supports)/.test(prelude)) {
        const inner = parseBlocks(css, index + 1, true);
        nodes.push({ kind: 'at', prelude, children: inner.nodes });
        index = inner.end;
        continue;
      }
      let depth = 1;
      let cursor = index + 1;
      while (cursor < css.length && depth > 0) {
        if (css[cursor] === '{') depth += 1;
        if (css[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const body = css.slice(index + 1, cursor - 1);
      if (!prelude.startsWith('@')) nodes.push({ kind: 'rule', selectors: prelude.split(',').map((item) => item.trim()), body });
      index = cursor;
      continue;
    }
    buffer += character;
    index += 1;
  }
  return { nodes, end: index };
}

function declarations(body) {
  const result = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ';' && depth === 0) {
      result.push(current);
      current = '';
    } else current += character;
  }
  if (current.trim()) result.push(current);
  return result
    .map((declaration) => {
      const split = declaration.indexOf(':');
      return split < 0 ? null : { property: declaration.slice(0, split).trim(), value: declaration.slice(split + 1).trim() };
    })
    .filter(Boolean);
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

function emit(theme, name, nodes, indent = '') {
  const lines = [];
  const prefix = `html[data-theme="${name}"]:root`;
  for (const node of nodes) {
    if (node.kind === 'at') {
      const inner = emit(theme, name, node.children, `${indent}  `);
      if (inner.length > 0) lines.push(`${indent}${node.prelude} {`, ...inner, `${indent}}`);
      continue;
    }
    if (node.selectors.some((selector) => selector.startsWith(':root') || selector.startsWith('html'))) continue;
    const changed = declarations(node.body).filter((declaration) => COLOR_LITERAL.test(declaration.value));
    if (changed.length === 0) continue;
    lines.push(`${indent}${node.selectors.map((selector) => `${prefix} ${selector}`).join(', ')} {`);
    for (const declaration of changed) lines.push(`${indent}  ${declaration.property}: ${remapValue(theme, declaration.value)};`);
    lines.push(`${indent}}`);
  }
  return lines;
}

/**
 * The stylesheet this produces, as text.
 *
 * Exported so it can be checked without being written: `desktop-themes-generated.test.ts` compares this against the
 * committed file, which is the only way a stale one is ever noticed. It went stale before — colour rules added to
 * styles.css long after the last run simply had no Purple or Navy equivalent — and nothing failed, because nothing
 * was looking.
 */
export function themeCss() {
  const sources = inputs.map((file) => stripComments(readFileSync(path.join(rendererSource, file), 'utf8')));
  const parsed = sources.map((text) => parseBlocks(text).nodes);
  let css = '/* Generated by scripts/generate-themes.mjs. Do not edit by hand. */\n';
  for (const [name, theme] of Object.entries(themes)) {
    css += `\n/* ${name} theme */\n`;
    for (const nodes of parsed) css += `${emit(theme, name, nodes).join('\n')}\n`;
  }
  return css;
}

// Written only when run as a script, so importing this from a test has no side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const css = themeCss();
  writeFileSync(output, css, 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), output)} (${css.split('\n').length} lines)`);
}
