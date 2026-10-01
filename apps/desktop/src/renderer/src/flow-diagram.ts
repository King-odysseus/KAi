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
}

/** The screens named in the pages artifact, with the first route each section mentions. */
export function parsePages(markdown: string): PageEntry[] {
  const pages: PageEntry[] = [];
  let current: { name: string; text: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const route = /(?:^|[\s`(])(\/[A-Za-z0-9\-_/:{}.]*)/.exec(current.text.join('\n'))?.[1] ?? '';
    pages.push({ name: current.name, route });
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

/** The prompt that tells a KAI agent to draw the project's screens in open-pencil from the Studio's artifacts. */
export function buildDesignPrompt(input: {
  projectName: string;
  goal: string;
  pages: readonly PageEntry[];
  hasTokens: boolean;
  hasStyleGuide: boolean;
  references: readonly string[];
}): string {
  const lines = [
    `Use the open-pencil tools to draw the screens for "${input.projectName}".`,
    '',
    `The project: ${input.goal}`,
    '',
    'Read these first (they are in the project, under .kai/spec):',
    input.hasStyleGuide ? '- design/style-guide.md for the look and feel' : '',
    input.hasTokens ? '- design/tokens.json for the colours, type, spacing and radius' : '',
    '- pages.md for every screen, and flows.md for how people move between them',
    input.references.length > 0 ? `- design/references/ (${input.references.join(', ')}) for the visual style to match, and design/style-reference.md if it exists` : '',
    '',
    'Then, in open-pencil:',
    input.hasTokens ? '1. Create the design variables from tokens.json (light and dark values where it gives both) and use them for every fill, text style, gap and corner radius. Do not type raw values on a screen.' : '1. Create colour, type, spacing and radius variables from the style guide and use them everywhere.',
    '2. Build the shared components first (buttons, inputs, cards, navigation), then one page per screen below, using the components.',
    '3. Mark each page as a screen and name it exactly as listed, so Studio can match it to its card.',
    '4. Show the empty, loading and error state of a screen next to it when pages.md asks for them.',
    '',
    input.pages.length > 0 ? 'Screens to draw:' : 'Screens to draw: take them from pages.md.',
    ...input.pages.map((page) => `- ${page.name}${page.route ? ` (${page.route})` : ''}`),
    '',
    'When you are done, say which screens you drew. I will pull the design back into the Studio.',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}
