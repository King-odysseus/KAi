/**
 * Reads the flows and pages artifacts for the screens that draw them. The flows document asks the model for one
 * "## Journey" heading per journey and a numbered step per line, so a diagram can be drawn without a second model
 * call. A document that does not follow the format yields no journeys, and the viewer falls back to the text.
 */

export type FlowStepKind = 'step' | 'decision' | 'screen' | 'api';

export interface FlowStep {
  text: string;
  kind: FlowStepKind;
}

export interface FlowJourney {
  title: string;
  steps: FlowStep[];
}

const HEADING = /^#{2,4}\s+(.+?)\s*#*\s*$/;
const ITEM = /^\s*(?:\d+[.)]|[-*+])\s+(.+?)\s*$/;
const API = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\bendpoint\b|\bwebhook\b/i;
const DECISION = /^(?:if|when|check|decide|does|is|are|has|can)\b|\?\s*$/i;
const SCREEN = /\(\s*\/[^)]*\)|\b(?:page|screen|dashboard|form|modal|view)\b/i;

function plain(value: string): string {
  return value.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

export function stepKind(text: string): FlowStepKind {
  if (API.test(text)) return 'api';
  if (DECISION.test(text)) return 'decision';
  if (SCREEN.test(text)) return 'screen';
  return 'step';
}

/** Journeys from a flows document. Steps outside any heading form one journey called "Flow". */
export function parseFlows(markdown: string): FlowJourney[] {
  const journeys: FlowJourney[] = [];
  let current: FlowJourney | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { title: plain(heading[1]!).slice(0, 80), steps: [] };
      journeys.push(current);
      continue;
    }
    const item = ITEM.exec(line);
    if (!item) continue;
    // Only top-level items are steps: an indented sub-bullet is detail on the step above it.
    if (/^\s{3,}/.test(line)) continue;
    if (!current) {
      current = { title: 'Flow', steps: [] };
      journeys.push(current);
    }
    const text = plain(item[1]!).slice(0, 140);
    if (text) current.steps.push({ text, kind: stepKind(text) });
  }
  return journeys.filter((journey) => journey.steps.length > 0).slice(0, 12);
}

export interface PageEntry {
  name: string;
  route: string;
  /** What the pages document says about this screen: its purpose, components and states. */
  details: string;
}

/** The screens named in the pages artifact, with the first route each section mentions. */
export function parsePages(markdown: string): PageEntry[] {
  const pages: PageEntry[] = [];
  let current: { name: string; text: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const body = current.text.join('\n').trim();
    const route = /(?:^|[\s`(])(\/[A-Za-z0-9\-_/:{}.]*)/.exec(body)?.[1] ?? '';
    pages.push({ name: current.name, route, details: body });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { name: plain(heading[1]!).slice(0, 80), text: [] };
    } else current?.text.push(line);
  }
  flush();
  return pages.filter((page) => page.name);
}

/** One row of the drawing checklist: a screen from the pages list, from open-pencil, or from both. */
export interface ScreenRow {
  name: string;
  route: string;
  details: string;
  inPages: boolean;
  drawn: boolean;
}

/**
 * Every screen the project has: those the pages artifact lists, plus any page that exists only in open-pencil. A
 * screen counts as drawn when open-pencil has a page of the same name.
 */
export function screenRows(pages: readonly PageEntry[], drawnNames: readonly string[]): ScreenRow[] {
  const key = (name: string): string => name.trim().toLowerCase();
  const drawn = new Set(drawnNames.map(key));
  const rows: ScreenRow[] = pages.map((page) => ({ ...page, inPages: true, drawn: drawn.has(key(page.name)) }));
  const listed = new Set(pages.map((page) => key(page.name)));
  for (const name of drawnNames) {
    if (listed.has(key(name))) continue;
    listed.add(key(name));
    rows.push({ name, route: '', details: '', inPages: false, drawn: true });
  }
  return rows;
}

/** Rows whose name, route or description contains the search text. */
export function filterScreens(rows: readonly ScreenRow[], query: string): ScreenRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => `${row.name} ${row.route} ${row.details}`.toLowerCase().includes(needle));
}

export interface DesignContext {
  projectName: string;
  goal: string;
  hasTokens: boolean;
  hasStyleGuide: boolean;
  references: readonly string[];
}

/** Said at the end of every prompt, so one stalled tool call cannot snowball into a half-drawn project. */
const CAREFULLY = [
  'Work in small steps and do only what this prompt asks.',
  'If an open-pencil tool call fails, stop and tell me which one and why. Do not retry it in a loop and do not start other work.',
  'Leave the document in a good state after each group of changes, so nothing is lost if the editor stops.',
];

function readFirst(context: DesignContext): string[] {
  return [
    'Read these first (they are in the project, under .kai/spec):',
    context.hasStyleGuide ? '- design/style-guide.md for the look and feel' : '',
    context.hasTokens ? '- design/tokens.json for the colours, type, spacing and radius' : '',
    '- pages.md for every screen, and flows.md for how people move between them',
    context.references.length > 0 ? `- design/references/ (${context.references.join(', ')}) for the visual style to match, and design/style-reference.md if it exists` : '',
  ].filter(Boolean);
}

/** Step 1: the variables and shared components only. No screens, so the first prompt stays small. */
export function buildFoundationPrompt(context: DesignContext): string {
  return [
    `Use the open-pencil tools to set up the design foundation for "${context.projectName}". Do not draw any screens yet.`,
    '',
    `The project: ${context.goal}`,
    '',
    ...readFirst(context),
    '',
    'Then, in open-pencil:',
    context.hasTokens
      ? '1. Create the design variables from tokens.json (light and dark values where it gives both): colours, spacing and radius.'
      : '1. Create colour, spacing and radius variables from the style guide.',
    '2. Create the text styles for the type scale.',
    '3. Build the shared components that more than one screen will use: buttons, text inputs, selects, cards, the navigation, a modal shell, and empty, loading and error blocks. Use only the variables and text styles, never raw values.',
    '4. Name every component plainly so the screens can use them.',
    '',
    ...CAREFULLY,
    'When you are done, list the variables and components you created. The screens come next, one prompt each.',
  ].join('\n');
}

/** Step 2..n: one screen. It names exactly what to draw and forbids touching anything else. */
export function buildPagePrompt(page: ScreenRow | PageEntry, context: DesignContext): string {
  const details = page.details.trim().slice(0, 1_800);
  return [
    `Use the open-pencil tools to draw one screen for "${context.projectName}": ${page.name}${page.route ? ` (${page.route})` : ''}.`,
    '',
    `The project: ${context.goal}`,
    '',
    ...readFirst(context),
    '',
    details ? `What pages.md says about this screen:\n${details}\n` : '',
    'Then, in open-pencil:',
    '1. Create one page named exactly as above and mark it as a screen, so Studio can match it to its card.',
    '2. Build it from the variables, text styles and components that already exist. Do not type raw colours, sizes or radii, and do not make new shared components unless nothing fits; if you must, name them clearly.',
    '3. Draw the states it lists (empty, loading, error and so on) next to the main view, and a phone-width version when pages.md or the flows call for one.',
    '4. Do not change any other page or any shared component.',
    '',
    ...CAREFULLY,
    'When you are done, say what you drew on this screen.',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}
