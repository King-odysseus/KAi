import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  EQUALIZER_DIR,
  equalizerReportSchema,
  parsePages,
  sortDifferences,
  type EqualizerDifference,
  type EqualizerReference,
  type EqualizerReport,
  type EqualizerRunInput,
  type EqualizerScreen,
  type EqualizerScreenResult,
  type EqualizerSeverity,
  type PageEntry,
} from '@kai/contracts';
import { joinUrl } from './ui-check';

/**
 * The Equalizer. It measures how far a built screen is from its design and writes that down; it never changes the
 * project. Everything here is pure or behind ports, so the comparing can be tested without a browser or an editor.
 *
 * Two kinds of evidence are compared. Facts are what each page says about itself (a heading's size and colour, a
 * card's corner radius, where a button sits), which says *what* differs. Pixels say *how much*, and catch what no
 * fact covers. A website reference gives facts on both sides; an open-pencil screen gives a picture to compare.
 */

// --- What a page says about itself ----------------------------------------------------------------------------

export interface FactElement {
  tag: string;
  role: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  background: string;
  fontSize: string;
  fontWeight: string;
  fontFamily: string;
  radius: string;
  padding: string;
  gap: string;
}

export interface PageFacts {
  url: string;
  width: number;
  height: number;
  scrollHeight: number;
  elements: FactElement[];
}

/** The probe, as a function the browser runs. It reads only what the comparison needs and never throws. */
export const PAGE_FACTS_SCRIPT = String.raw`() => {
  const round = (value) => Math.round(value);
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 2 && box.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const selector = 'h1,h2,h3,h4,button,a[href],input,select,textarea,label,nav,header,footer,main,aside,img,[role=button],[role=tab],th,td,li,p';
  const elements = [];
  try {
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('alt') || '').replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 60);
      elements.push({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        text,
        x: round(box.left + window.scrollX),
        y: round(box.top + window.scrollY),
        w: round(box.width),
        h: round(box.height),
        color: style.color,
        background: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily.split(',')[0].trim().replace(/["']/g, ''),
        radius: style.borderTopLeftRadius,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' '),
        gap: style.rowGap === 'normal' ? '0px' : style.rowGap,
      });
      if (elements.length >= 300) break;
    }
  } catch (error) {
    // A page that cannot be read yields what it could, which the comparison reports as differences.
  }
  return { url: location.href, width: window.innerWidth, height: window.innerHeight, scrollHeight: document.documentElement.scrollHeight, elements };
}`;

/** Reads the probe's JSON out of an MCP text block, tolerating whatever wrapper the server put around it. */
export function parsePageFacts(text: string): PageFacts | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<PageFacts>;
    if (!Array.isArray(parsed.elements)) return null;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      scrollHeight: Number(parsed.scrollHeight) || 0,
      elements: parsed.elements.filter((element): element is FactElement => Boolean(element) && typeof element === 'object' && typeof (element as FactElement).tag === 'string'),
    };
  } catch {
    return null;
  }
}

// --- Comparing facts ------------------------------------------------------------------------------------------

/** A CSS colour as red, green, blue and alpha, or null when it is not one KAI can read. */
export function parseColour(value: string): { r: number; g: number; b: number; a: number } | null {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)(?:[ ,/]+(\d*\.?\d+%?))?\s*\)$/i.exec(value.trim());
  if (!match) return null;
  const alphaRaw = match[4];
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

export function colourDistance(left: string, right: string): number | null {
  const a = parseColour(left);
  const b = parseColour(right);
  if (!a || !b) return null;
  // A fully transparent colour paints nothing, so two of them are the same whatever their channels say.
  if (a.a === 0 && b.a === 0) return 0;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) + Math.abs(a.a - b.a) * 255;
}

export function toHex(value: string): string {
  const colour = parseColour(value);
  if (!colour) return value;
  const channel = (item: number): string => Math.round(item).toString(16).padStart(2, '0');
  const hex = `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`.toUpperCase();
  return colour.a < 1 ? `${hex} at ${Math.round(colour.a * 100)}%` : hex;
}

function pixels(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

const TEXTUAL = new Set(['h1', 'h2', 'h3', 'h4', 'button', 'a', 'label', 'th', 'th', 'p', 'li']);
const PROMINENT = new Set(['h1', 'h2', 'h3', 'button', 'a']);

function describe(element: FactElement): string {
  const name = element.tag === 'a' ? 'Link' : element.tag === 'button' ? 'Button' : /^h\d$/.test(element.tag) ? 'Heading' : element.tag === 'input' ? 'Input' : element.tag === 'label' ? 'Label' : 'Element';
  return element.text ? `${name} "${element.text.slice(0, 40)}"` : `${name} <${element.tag}>`;
}

function keyOf(element: FactElement): string {
  return `${element.tag}|${element.role}|${element.text.toLowerCase()}`;
}

const SEVERITY_RANK: Record<EqualizerSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Everything that differs between a reference page and the live one. Elements are matched by tag and visible text,
 * so a button is compared with the same button, wherever it moved to. Each element contributes at most one
 * difference per kind, and the result is capped so one badly broken page cannot bury the report.
 */
export function compareFacts(reference: PageFacts, live: PageFacts): EqualizerDifference[] {
  const differences: EqualizerDifference[] = [];
  const add = (difference: Omit<EqualizerDifference, 'expected' | 'actual'> & { expected?: string; actual?: string }): void => {
    differences.push({ expected: '', actual: '', ...difference });
  };

  const liveByKey = new Map<string, FactElement[]>();
  for (const element of live.elements) liveByKey.set(keyOf(element), [...(liveByKey.get(keyOf(element)) ?? []), element]);
  const referenceKeys = new Set(reference.elements.map(keyOf));

  reference.elements.forEach((expected, index) => {
    if (!expected.text && !PROMINENT.has(expected.tag)) return;
    const candidates = liveByKey.get(keyOf(expected));
    const found = candidates?.shift();
    const label = describe(expected);
    if (!found) {
      if (expected.text.length >= 3 && TEXTUAL.has(expected.tag)) {
        add({ id: `missing-${index}`, severity: PROMINENT.has(expected.tag) ? 'high' : 'medium', kind: 'content', message: `${label} is in the reference but not on the live page.`, expected: expected.text });
      }
      return;
    }

    const textColour = colourDistance(expected.color, found.color);
    if (textColour !== null && textColour > 24) {
      add({ id: `colour-${index}`, severity: textColour > 90 ? 'high' : 'medium', kind: 'colour', message: `${label}: text colour is ${toHex(expected.color)} in the reference, ${toHex(found.color)} live.`, expected: toHex(expected.color), actual: toHex(found.color) });
    }
    const backgroundDistance = colourDistance(expected.background, found.background);
    if (backgroundDistance !== null && backgroundDistance > 24) {
      add({ id: `background-${index}`, severity: backgroundDistance > 90 ? 'high' : 'medium', kind: 'colour', message: `${label}: background is ${toHex(expected.background)} in the reference, ${toHex(found.background)} live.`, expected: toHex(expected.background), actual: toHex(found.background) });
    }

    const expectedSize = pixels(expected.fontSize);
    const foundSize = pixels(found.fontSize);
    if (expectedSize !== null && foundSize !== null && Math.abs(expectedSize - foundSize) > 1) {
      add({ id: `font-size-${index}`, severity: Math.abs(expectedSize - foundSize) > 3 ? 'high' : 'medium', kind: 'typography', message: `${label}: font size is ${expected.fontSize} in the reference, ${found.fontSize} live.`, expected: expected.fontSize, actual: found.fontSize });
    }
    if (Math.abs(Number(expected.fontWeight) - Number(found.fontWeight)) >= 200) {
      add({ id: `font-weight-${index}`, severity: 'medium', kind: 'typography', message: `${label}: font weight is ${expected.fontWeight} in the reference, ${found.fontWeight} live.`, expected: expected.fontWeight, actual: found.fontWeight });
    }
    if (expected.text && expected.fontFamily && found.fontFamily && expected.fontFamily.toLowerCase() !== found.fontFamily.toLowerCase()) {
      add({ id: `font-family-${index}`, severity: 'medium', kind: 'typography', message: `${label}: typeface is ${expected.fontFamily} in the reference, ${found.fontFamily} live.`, expected: expected.fontFamily, actual: found.fontFamily });
    }

    const expectedRadius = pixels(expected.radius);
    const foundRadius = pixels(found.radius);
    if (expectedRadius !== null && foundRadius !== null && Math.abs(expectedRadius - foundRadius) > 2) {
      add({ id: `radius-${index}`, severity: Math.abs(expectedRadius - foundRadius) > 8 ? 'high' : 'medium', kind: 'radius', message: `${label}: corner radius is ${expected.radius} in the reference, ${found.radius} live.`, expected: expected.radius, actual: found.radius });
    }
    if (expected.padding !== found.padding && expected.padding && found.padding) {
      const left = expected.padding.split(' ').map((item) => pixels(item) ?? 0);
      const right = found.padding.split(' ').map((item) => pixels(item) ?? 0);
      const worst = Math.max(...left.map((item, side) => Math.abs(item - (right[side] ?? 0))));
      if (worst > 4) add({ id: `padding-${index}`, severity: worst > 12 ? 'high' : 'medium', kind: 'spacing', message: `${label}: padding is ${expected.padding} in the reference, ${found.padding} live.`, expected: expected.padding, actual: found.padding });
    }

    const widthGap = Math.abs(expected.w - found.w);
    const heightGap = Math.abs(expected.h - found.h);
    if (widthGap > Math.max(8, expected.w * 0.1) || heightGap > Math.max(8, expected.h * 0.15)) {
      const relative = Math.max(widthGap / Math.max(1, expected.w), heightGap / Math.max(1, expected.h));
      add({ id: `size-${index}`, severity: relative > 0.3 ? 'high' : 'medium', kind: 'size', message: `${label}: ${expected.w}×${expected.h}px in the reference, ${found.w}×${found.h}px live.`, expected: `${expected.w}×${expected.h}`, actual: `${found.w}×${found.h}` });
    }
    const moved = Math.max(Math.abs(expected.x - found.x), Math.abs(expected.y - found.y));
    if (moved > 16) {
      add({ id: `position-${index}`, severity: moved > 80 ? 'medium' : 'low', kind: 'position', message: `${label}: sits at ${expected.x},${expected.y} in the reference, ${found.x},${found.y} live.`, expected: `${expected.x},${expected.y}`, actual: `${found.x},${found.y}` });
    }
  });

  for (const [key, leftovers] of liveByKey) {
    if (referenceKeys.has(key)) continue;
    const element = leftovers[0];
    if (element && PROMINENT.has(element.tag) && element.text.length >= 3) {
      add({ id: `extra-${key}`.slice(0, 160), severity: 'low', kind: 'content', message: `${describe(element)} is on the live page but not in the reference.`, actual: element.text });
    }
  }

  if (reference.scrollHeight > 0 && live.scrollHeight > 0 && Math.abs(reference.scrollHeight - live.scrollHeight) > reference.scrollHeight * 0.1) {
    add({ id: 'page-height', severity: 'medium', kind: 'size', message: `The page is ${reference.scrollHeight}px tall in the reference and ${live.scrollHeight}px live.`, expected: `${reference.scrollHeight}px`, actual: `${live.scrollHeight}px` });
  }

  return differences.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]).slice(0, 80);
}

// --- Comparing pictures ---------------------------------------------------------------------------------------

export interface ImageDifference {
  /** Share of compared pixels that differ, 0 to 1. */
  ratio: number;
  width: number;
  height: number;
  /** The two pictures were not the same size, so only the part they share was compared. */
  sizeMismatch: { reference: { width: number; height: number }; live: { width: number; height: number } } | null;
  /** A PNG with the differing pixels painted in. */
  difference: Buffer;
}

/** Compares two PNGs. Where the sizes differ it compares the overlapping corner and says so. */
export function diffImages(referencePng: Buffer, livePng: Buffer): ImageDifference {
  const reference = PNG.sync.read(referencePng);
  const live = PNG.sync.read(livePng);
  const width = Math.min(reference.width, live.width);
  const height = Math.min(reference.height, live.height);
  const crop = (source: PNG): Buffer => {
    if (source.width === width && source.height === height) return source.data;
    const out = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row += 1) source.data.copy(out, row * width * 4, row * source.width * 4, row * source.width * 4 + width * 4);
    return out;
  };
  const output = new PNG({ width, height });
  const different = pixelmatch(crop(reference), crop(live), output.data, width, height, { threshold: 0.15, includeAA: false });
  const mismatch = reference.width !== live.width || reference.height !== live.height;
  return {
    ratio: width * height === 0 ? 0 : different / (width * height),
    width,
    height,
    sizeMismatch: mismatch ? { reference: { width: reference.width, height: reference.height }, live: { width: live.width, height: live.height } } : null,
    difference: PNG.sync.write(output),
  };
}

/** How serious a share of differing pixels is. Under one percent is noise from fonts and anti-aliasing. */
export function pixelSeverity(ratio: number): EqualizerSeverity | null {
  if (ratio > 0.2) return 'high';
  if (ratio > 0.05) return 'medium';
  if (ratio > 0.01) return 'low';
  return null;
}

// --- Design only ----------------------------------------------------------------------------------------------

/**
 * The check with no live page: is the design itself complete? Every screen the pages list names should be drawn,
 * every drawn screen should be on the list, and each listed screen needs a route so it can be compared with the
 * built app later.
 */
export function checkDesignOnly(listed: readonly PageEntry[], drawn: readonly string[]): { screens: EqualizerScreenResult[]; notes: string[] } {
  const key = (name: string): string => name.trim().toLowerCase();
  const drawnKeys = new Set(drawn.map(key));
  const listedKeys = new Set(listed.map((page) => key(page.name)));
  const empty = { reference: null, live: null, difference: null };
  const screens: EqualizerScreenResult[] = [];
  for (const page of listed) {
    const differences: EqualizerDifference[] = [];
    const isDrawn = drawnKeys.has(key(page.name));
    if (!isDrawn) differences.push({ id: 'not-drawn', severity: 'high', kind: 'screen', message: `${page.name} is in the pages list but is not drawn in open-pencil yet.`, expected: 'a page named exactly this', actual: 'none' });
    if (!page.route) differences.push({ id: 'no-route', severity: 'low', kind: 'screen', message: `${page.name} has no route in the pages list, so it cannot be opened and compared with the built app later.`, expected: 'a route such as /dashboard', actual: 'none' });
    screens.push({ name: page.name, route: page.route, status: isDrawn ? (differences.length > 0 ? 'differs' : 'match') : 'not-drawn', pixelDifference: null, differences, images: empty, error: null });
  }
  for (const name of drawn) {
    if (listedKeys.has(key(name))) continue;
    listedKeys.add(key(name));
    screens.push({
      name,
      route: '',
      status: 'not-listed',
      pixelDifference: null,
      differences: [{ id: 'not-listed', severity: 'low', kind: 'screen', message: `${name} is drawn in open-pencil but is not in the pages list.`, expected: 'an entry in pages.md', actual: 'none' }],
      images: empty,
      error: null,
    });
  }
  const notes: string[] = [];
  if (listed.length === 0) notes.push('There is no pages list yet, so there is nothing to check the design against. Write the pages artifact first.');
  return { screens, notes };
}

// --- Report files ---------------------------------------------------------------------------------------------

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'screen';
}

const TARGET_WORDS = { dev: 'the dev server', production: 'the production site', design: 'the design only' } as const;
const REFERENCE_WORDS: Record<EqualizerReference, string> = { 'open-pencil': 'open-pencil', website: 'a website' };

/** The report as the markdown file an agent or a person can read without KAI. */
export function reportMarkdown(report: EqualizerReport): string {
  const total = report.screens.reduce((count, screen) => count + screen.differences.length, 0);
  const lines = [
    '# Equalizer report',
    '',
    `_${report.createdAt.slice(0, 16).replace('T', ' ')} · ${report.target === 'design' ? 'design only' : `${TARGET_WORDS[report.target]} compared with ${REFERENCE_WORDS[report.reference]}`}${report.round > 0 ? ` · round ${report.round} of ${report.rounds}` : ''}_`,
    '',
    `${report.screens.length} screens checked, ${report.screens.filter((screen) => screen.status === 'match').length} match, ${total} differences in all.`,
    '',
    ...report.notes.map((note) => `> ${note}`),
  ];
  for (const screen of report.screens) {
    lines.push('', `## ${screen.name}${screen.route ? ` (${screen.route})` : ''}`, '');
    if (screen.error) lines.push(`Could not be checked: ${screen.error}`);
    else if (screen.differences.length === 0) lines.push('Matches.');
    else {
      if (screen.pixelDifference !== null) lines.push(`${(screen.pixelDifference * 100).toFixed(1)}% of pixels differ.`, '');
      for (const difference of sortDifferences(screen.differences)) lines.push(`- **${difference.severity}** · ${difference.kind}: ${difference.message}`);
    }
    for (const [label, file] of Object.entries(screen.images)) if (file) lines.push('', `${label}: \`${file}\``);
  }
  return `${lines.join('\n')}\n`;
}

// --- The runner -----------------------------------------------------------------------------------------------

/** What the browser returned for one page: a picture, and what the page says about itself. */
export interface CapturedPage {
  png: Buffer;
  facts: PageFacts | null;
}

export interface EqualizerPorts {
  projectRoot(projectId: string): Promise<string>;
  /** Reads a file under `.kai/spec`, or null. */
  readSpec(root: string, relativePath: string): Promise<string | null>;
  /** Writes under `.kai/spec`, creating folders. */
  writeSpec(root: string, relativePath: string, content: string | Buffer): Promise<void>;
  /** Starts the project's dev server and resolves its base URL. */
  devUrl(projectId: string, root: string): Promise<string>;
  /** Opens a page in the browser at a width and captures it. */
  openPage(url: string, width: number): Promise<CapturedPage>;
  /** The screens drawn in open-pencil, from the last pull. */
  drawnScreens(root: string): Promise<string[]>;
  /** Whether open-pencil is set up and reachable. */
  designConnected(): Promise<boolean>;
  /** One screen exported from open-pencil as a picture, or null when no page of that name is drawn. */
  exportDesignScreen(name: string): Promise<{ png: Buffer; width: number } | null>;
  progress?(event: { done: number; total: number; current: string }): void;
  now(): string;
}

const DEFAULT_WIDTH = 1280;

/** What the rest of the app calls. One project at a time, so the real wiring builds its ports per call. */
export interface EqualizerService {
  screens(projectId: string): Promise<{ screens: EqualizerScreen[]; drawn: string[]; hasPages: boolean }>;
  run(input: EqualizerRunInput): Promise<EqualizerReport>;
}

export class DesktopEqualizer {
  constructor(private readonly ports: EqualizerPorts) {}

  async screens(projectId: string): Promise<{ screens: EqualizerScreen[]; drawn: string[]; hasPages: boolean }> {
    const root = await this.ports.projectRoot(projectId);
    const pages = parsePages((await this.ports.readSpec(root, 'pages.md')) ?? '');
    const drawn = await this.ports.drawnScreens(root).catch(() => []);
    return { screens: pages.map((page) => ({ name: page.name, route: page.route })), drawn, hasPages: pages.length > 0 };
  }

  async run(input: EqualizerRunInput): Promise<EqualizerReport> {
    const root = await this.ports.projectRoot(input.projectId);
    const createdAt = this.ports.now();
    const id = createdAt.replace(/[^0-9]/g, '').slice(0, 14);
    const folder = `${EQUALIZER_DIR}/${id}`;
    let screens: EqualizerScreenResult[];
    let notes: string[] = [];

    if (input.target === 'design') {
      const pages = parsePages((await this.ports.readSpec(root, 'pages.md')) ?? '');
      const wanted = new Set(input.screens.map((screen) => screen.name.toLowerCase()));
      const checked = checkDesignOnly(pages.filter((page) => wanted.has(page.name.toLowerCase())), await this.ports.drawnScreens(root));
      screens = checked.screens;
      notes = checked.notes;
    } else {
      const base = input.target === 'dev' ? await this.ports.devUrl(input.projectId, root) : input.liveUrl;
      if (!base) throw new Error('Give the production link first: the Equalizer needs a page to open.');
      if (input.reference === 'website' && !input.referenceUrl) throw new Error('Give the website to match: the Equalizer needs a reference page.');
      if (input.reference === 'open-pencil' && !(await this.ports.designConnected())) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, or choose a website to match.');
      screens = [];
      for (const [index, screen] of input.screens.entries()) {
        this.ports.progress?.({ done: index, total: input.screens.length, current: screen.name });
        screens.push(await this.checkScreen(root, folder, screen, input, base));
      }
      this.ports.progress?.({ done: input.screens.length, total: input.screens.length, current: '' });
    }

    const draft: EqualizerReport = {
      id,
      createdAt,
      target: input.target,
      reference: input.reference,
      round: input.round,
      rounds: input.rounds,
      liveUrl: input.target === 'production' ? input.liveUrl ?? null : null,
      referenceUrl: input.reference === 'website' ? input.referenceUrl ?? null : null,
      screens,
      notes,
      reportPath: `.kai/spec/${folder}/report.md`,
    };
    const report = equalizerReportSchema.parse(draft);
    await this.ports.writeSpec(root, `${folder}/report.md`, reportMarkdown(report));
    await this.ports.writeSpec(root, `${folder}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  /** One screen. A failure is that screen's result, so one broken page never loses the rest of the run. */
  private async checkScreen(root: string, folder: string, screen: EqualizerScreen, input: EqualizerRunInput, base: string): Promise<EqualizerScreenResult> {
    const empty = { reference: null, live: null, difference: null };
    const failed = (error: unknown): EqualizerScreenResult => ({
      name: screen.name,
      route: screen.route,
      status: 'error',
      pixelDifference: null,
      differences: [],
      images: empty,
      error: error instanceof Error ? error.message.slice(0, 500) : 'The screen could not be checked.',
    });
    if (!screen.route && input.reference === 'website') return failed(new Error('This screen has no route, so there is no page to open.'));
    try {
      let reference: { png: Buffer; facts: PageFacts | null };
      let width = DEFAULT_WIDTH;
      if (input.reference === 'open-pencil') {
        const exported = await this.ports.exportDesignScreen(screen.name);
        if (!exported) return { ...failed(new Error(`${screen.name} is not drawn in open-pencil, so there is nothing to compare.`)), status: 'not-drawn' };
        reference = { png: exported.png, facts: null };
        width = exported.width > 0 ? exported.width : DEFAULT_WIDTH;
      } else {
        reference = await this.ports.openPage(joinUrl(input.referenceUrl!, screen.route), width);
      }
      const live = await this.ports.openPage(joinUrl(base, screen.route), width);

      const differences: EqualizerDifference[] = [];
      if (reference.facts && live.facts) differences.push(...compareFacts(reference.facts, live.facts));
      const picture = diffImages(reference.png, live.png);
      const severity = pixelSeverity(picture.ratio);
      if (picture.sizeMismatch) {
        const { reference: wanted, live: found } = picture.sizeMismatch;
        differences.push({ id: 'picture-size', severity: Math.abs(wanted.height - found.height) > wanted.height * 0.15 ? 'medium' : 'low', kind: 'size', message: `The screen is ${wanted.width}×${wanted.height}px in the reference and ${found.width}×${found.height}px live, so only the part they share was compared.`, expected: `${wanted.width}×${wanted.height}`, actual: `${found.width}×${found.height}` });
      }
      if (severity) differences.push({ id: 'pixels', severity, kind: 'pixels', message: `${(picture.ratio * 100).toFixed(1)}% of the pixels differ from the reference.`, expected: '0%', actual: `${(picture.ratio * 100).toFixed(1)}%` });

      const base64Folder = `${folder}/${slug(screen.name)}`;
      await this.ports.writeSpec(root, `${base64Folder}/reference.png`, reference.png);
      await this.ports.writeSpec(root, `${base64Folder}/live.png`, live.png);
      await this.ports.writeSpec(root, `${base64Folder}/difference.png`, picture.difference);
      const sorted = sortDifferences(differences).slice(0, 100);
      return {
        name: screen.name,
        route: screen.route,
        status: sorted.length > 0 ? 'differs' : 'match',
        pixelDifference: picture.ratio,
        differences: sorted,
        images: { reference: `.kai/spec/${base64Folder}/reference.png`, live: `.kai/spec/${base64Folder}/live.png`, difference: `.kai/spec/${base64Folder}/difference.png` },
        error: null,
      };
    } catch (error) {
      return failed(error);
    }
  }
}
