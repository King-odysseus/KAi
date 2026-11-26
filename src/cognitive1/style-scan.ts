import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A copy of KAI Desktop's `style-scan.ts`. The extension is packaged on its own and keeps its own memory, so it
 * carries its own scanner. Keep the two in step by hand when one changes.
 */

/**
 * Reads how a project looks, from its own code: what its buttons and cards do about corners, borders and shadows,
 * and whether it uses 1px hairline borders at all. Nothing here calls a model. It counts rules in the stylesheets and
 * utility classes in the markup, then reports only what a clear majority of the samples agree on, so a pattern is a
 * measured fact with a count behind it ("11 of 12 card rules have no border") and not a guess.
 */

export type StyleThing = 'buttons' | 'cards';

export interface Tally { [value: string]: number }

export interface FacetTallies {
  radius: Tally;
  border: Tally;
  shadow: Tally;
}

export interface StyleFacts {
  buttons: FacetTallies;
  cards: FacetTallies;
  /** How many button and card definitions were read, so a conclusion can say what it rests on. */
  samples: { buttons: number; cards: number };
  /** Scan bounds are included in evidence so a partial scan cannot look complete. */
  limits?: { filesRead: number; filesFound: number; byteLimited: number; fileLimited: boolean };
}

const emptyFacet = (): FacetTallies => ({ radius: {}, border: {}, shadow: {} });
export const emptyFacts = (): StyleFacts => ({ buttons: emptyFacet(), cards: emptyFacet(), samples: { buttons: 0, cards: 0 } });

function bump(tally: Tally, value: string): void {
  tally[value] = (tally[value] ?? 0) + 1;
}

const BUTTON_WORD = /(^|[^a-z])(btn|button)([^a-z]|$)/i;
const CARD_WORD = /(^|[^a-z])card([^a-z]|$)/i;

/** Which thing a selector or class name is about, or null. A button wins when a name is both ("card-button"). */
export function thingFor(name: string): StyleThing | null {
  if (/(?:^|[.#_-])(?:card[-_]?(?:title|body|header|footer)|btn[-_]?icon|button[-_]?group)(?:$|[.#:_-])/i.test(name)) return null;
  if (BUTTON_WORD.test(name)) return 'buttons';
  if (CARD_WORD.test(name)) return 'cards';
  return null;
}

function borderValue(width: number | null): string {
  if (width === null || width === 0) return 'none';
  return width <= 1 ? 'hairline' : `${width}px`;
}

/** A CSS length or keyword as the corner value people recognise: "8px", "full", "square". */
function radiusValue(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === '0' || value === '0px' || value === 'none') return 'square';
  if (/^(9999px|999px|50%|100px|9999rem)$/.test(value)) return 'pill';
  return value.replace(/\s+/g, ' ');
}

/** Adds what one CSS rule (a selector and its declarations) says about buttons or cards. */
export function readCssRule(facts: StyleFacts, selector: string, body: string, variables: ReadonlyMap<string, string> = new Map()): void {
  const thing = thingFor(selector);
  if (!thing) return;
  const decl = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const property = part.slice(0, at).trim().toLowerCase();
    let value = part.slice(at + 1).trim();
    value = value.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]*))?\)/g, (whole, key: string, fallback?: string) => variables.get(key) ?? fallback ?? whole);
    if (/var\(|\bcalc\(/i.test(value)) continue;
    decl.set(property, value);
  }
  // A rule that only changes a colour or a hover state says nothing about shape; it needs a shape property to count.
  const radius = decl.get('border-radius');
  const border = decl.get('border') ?? decl.get('border-width') ?? decl.get('outline');
  const shadow = decl.get('box-shadow');
  if (radius === undefined && border === undefined && shadow === undefined) return;
  const target = facts[thing];
  const countBefore = Object.values(target.radius).reduce((a, b) => a + b, 0)
    + Object.values(target.border).reduce((a, b) => a + b, 0)
    + Object.values(target.shadow).reduce((a, b) => a + b, 0);
  if (radius !== undefined && !/\bcalc\(|var\(/i.test(radius)) bump(target.radius, radiusValue(radius));
  if (border !== undefined) {
    const lower = border.toLowerCase();
    const width = /^(none|0(px)?)(\s|$)/.test(lower) ? 0 : Number(/(\d*\.?\d+)\s*px/.exec(lower)?.[1] ?? NaN);
    if (!Number.isNaN(width)) bump(target.border, borderValue(width));
  }
  if (shadow !== undefined && !/\bcalc\(|var\(/i.test(shadow)) bump(target.shadow, /^none$/i.test(shadow.trim()) ? 'none' : 'shadow');
  const countAfter = Object.values(target.radius).reduce((a, b) => a + b, 0)
    + Object.values(target.border).reduce((a, b) => a + b, 0)
    + Object.values(target.shadow).reduce((a, b) => a + b, 0);
  if (countAfter > countBefore) facts.samples[thing] += 1;
}

/** Reads every `selector { ... }` in a stylesheet. Good enough for plain CSS and SCSS without nesting tricks. */
export function readCss(facts: StyleFacts, css: string, styledClasses?: Set<string>): void {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const variables = new Map<string, string>();
  for (const block of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1]!.trim();
    if (!/(?:^|,)\s*(?::root|html|body)(?:\b|$)/i.test(selector)) continue;
    for (const variable of (block[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) variables.set(variable[1]!, variable[2]!.trim());
  }
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]?.trim() ?? '';
    if (!selector || selector.startsWith('@')) continue;
    const before = facts.samples.buttons + facts.samples.cards;
    readCssRule(facts, selector, match[2] ?? '', variables);
    if (styledClasses && before < facts.samples.buttons + facts.samples.cards) {
      for (const className of selector.matchAll(/\.([\w-]+)/g)) if (thingFor(className[1] ?? '')) styledClasses.add(className[1]!);
    }
  }
}

/** Adds what one list of utility classes (Tailwind and the like) says about a button or card. */
export function readClassList(facts: StyleFacts, thing: StyleThing, classes: readonly string[]): void {
  const target = facts[thing];
  let observed = false;
  const radius = classes.find((name) => /^rounded(?:-(?:none|full|[a-z0-9]+))?$/.test(name));
  if (radius !== undefined) {
    observed = true;
    bump(target.radius, radius === 'rounded-none' ? 'square' : radius === 'rounded-full' ? 'pill' : radius.replace(/^rounded-?/, '') || 'default');
  }
  const border = classes.find((name) => /^border(-[0-9]+)?$/.test(name) || name === 'border-none');
  if (border !== undefined) {
    observed = true;
    bump(target.border, border === 'border-0' || border === 'border-none' ? 'none' : border === 'border' || border === 'border-1' ? 'hairline' : `${border.replace('border-', '')}px`);
  }
  const shadow = classes.find((name) => /^shadow(-[a-z0-9]+)?$/.test(name));
  if (shadow !== undefined) {
    observed = true;
    bump(target.shadow, shadow === 'shadow-none' ? 'none' : 'shadow');
  }
  if (observed) facts.samples[thing] += 1;
}

/** Finds class lists in markup and decides which are a button or a card. */
export function readMarkup(facts: StyleFacts, source: string, styledClasses: ReadonlySet<string> = new Set()): void {
  for (const match of source.matchAll(/<button\b[^>]*?\bclass(?:Name)?=\{?["'`]([^"'`]+)["'`]/g)) {
    const classes = (match[1] ?? '').split(/\s+/).filter(Boolean);
    if (!classes.some((name) => styledClasses.has(name))) readClassList(facts, 'buttons', classes);
  }
  for (const match of source.matchAll(/\bclass(?:Name)?=\{?["'`]([^"'`]+)["'`]/g)) {
    const classes = (match[1] ?? '').split(/\s+/).filter(Boolean);
    if (classes.some((name) => styledClasses.has(name))) continue;
    // A bare <button> was counted above; here only a class list that names a button or a card itself is added.
    const thing = classes.map(thingFor).find((value): value is StyleThing => value !== null);
    if (!thing) continue;
    if (thing === 'buttons' && /<button\b[^>]*$/.test(source.slice(Math.max(0, (match.index ?? 0) - 120), match.index))) continue;
    readClassList(facts, thing, classes);
  }
}

export interface StyleConvention {
  key: string;
  thing: StyleThing | 'borders';
  /** A sentence an agent can act on, ending without a full stop so lines join cleanly. */
  text: string;
  /** What it rests on, for the person to judge: "11 of 12 card rules". */
  evidence: string;
}

const MIN_SAMPLES = 3;
const MAJORITY = 0.6;

function top(tally: Tally): { value: string; count: number; total: number } | null {
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const first = entries[0];
  return first && total > 0 ? { value: first[0], count: first[1], total } : null;
}

function describe(facet: FacetTallies): { parts: string[]; evidence: string[] } {
  const parts: string[] = [];
  const evidence: string[] = [];
  const radius = top(facet.radius);
  if (radius && radius.count >= MIN_SAMPLES && radius.count / radius.total >= MAJORITY) {
    parts.push(radius.value === 'square' ? 'square corners' : radius.value === 'pill' ? 'fully rounded corners' : `rounded corners (${radius.value})`);
    evidence.push(`${radius.count} of ${radius.total} with these corners`);
  }
  const border = top(facet.border);
  if (border && border.count >= MIN_SAMPLES && border.count / border.total >= MAJORITY) {
    parts.push(border.value === 'none' ? 'no border' : border.value === 'hairline' ? 'a 1px hairline border' : `a ${border.value} border`);
    evidence.push(`${border.count} of ${border.total} with this border`);
  }
  const shadow = top(facet.shadow);
  if (shadow && shadow.count >= MIN_SAMPLES && shadow.count / shadow.total >= MAJORITY) {
    parts.push(shadow.value === 'none' ? 'no shadow' : 'a soft shadow');
    evidence.push(`${shadow.count} of ${shadow.total} with this shadow`);
  }
  return { parts, evidence };
}

/** What one project's buttons and cards agree on, with the counts behind it. Empty when there are too few samples. */
export function styleConventionsOf(facts: StyleFacts): StyleConvention[] {
  const found: StyleConvention[] = [];
  for (const thing of ['buttons', 'cards'] as const) {
    if (facts.samples[thing] < MIN_SAMPLES) continue;
    const { parts, evidence } = describe(facts[thing]);
    if (parts.length === 0) continue;
    const limitNote = facts.limits?.fileLimited ? `; stopped at ${facts.limits.filesRead} files` : '';
    const byteNote = facts.limits?.byteLimited ? `; ${facts.limits.byteLimited} files exceeded the ${MAX_BYTES}-byte read cap` : '';
    found.push({ key: thing, thing, text: `${thing === 'buttons' ? 'Buttons' : 'Cards'} use ${parts.join(', ')}`, evidence: `${facts.samples[thing]} read; ${evidence.join('; ')}${limitNote}${byteNote}` });
  }
  // Hairlines are the one thing people name as a dislike, so say it plainly when the whole project avoids them.
  const borderReads = Object.values(facts.buttons.border).reduce((sum, count) => sum + count, 0)
    + Object.values(facts.cards.border).reduce((sum, count) => sum + count, 0);
  const hairlines = (facts.buttons.border['hairline'] ?? 0) + (facts.cards.border['hairline'] ?? 0);
  if (borderReads >= MIN_SAMPLES * 2 && hairlines === 0) {
    found.push({ key: 'no-hairlines', thing: 'borders', text: 'No 1px hairline borders on buttons or cards', evidence: `0 of ${borderReads} observed button and card borders use one` });
  }
  return found;
}

const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less']);
const MARKUP_EXT = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.html', '.astro']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'vendor', 'release', 'coverage', '.tmp', 'themes.generated.css']);
const MAX_FILES = 1_500;
const MAX_BYTES = 120_000;
const MAX_DEPTH = 6;

/** Reads a project folder's stylesheets and markup into facts. Never writes, and never reads past a size limit. */
export async function readStyleFacts(root: string): Promise<StyleFacts> {
  const facts = emptyFacts();
  const files: string[] = [];
  let fileLimited = false;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (STYLE_EXT.has(path.extname(entry.name)) || MARKUP_EXT.has(path.extname(entry.name))) {
        if (files.length >= MAX_FILES) { fileLimited = true; return; }
        files.push(full);
      }
    }
  }
  await walk(root, 0);
  let byteLimited = 0;
  const contents: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    let text: string;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES + 1, 0);
        if (bytesRead > MAX_BYTES) byteLimited += 1;
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
    } catch { continue; }
    contents.push({ file, text });
  }
  const styledClasses = new Set<string>();
  for (const item of contents) if (STYLE_EXT.has(path.extname(item.file))) readCss(facts, item.text, styledClasses);
  for (const item of contents) if (!STYLE_EXT.has(path.extname(item.file))) readMarkup(facts, item.text, styledClasses);
  facts.limits = { filesRead: files.length, filesFound: files.length + Number(fileLimited), byteLimited, fileLimited };
  return facts;
}
