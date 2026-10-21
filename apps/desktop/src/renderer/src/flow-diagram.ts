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
    const text = plain(item[1]!).slice(0, 600);
    if (text) current.steps.push({ text, kind: stepKind(text) });
  }
  return journeys.filter((journey) => journey.steps.length > 0).slice(0, 12);
}

export { parsePages, screenTitleKey, type PageEntry } from '@kai/contracts';
import { screenTitleKey, type PageEntry } from '@kai/contracts';

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
 * screen counts as drawn when open-pencil has a page whose name identifies it.
 */
export function screenRows(pages: readonly PageEntry[], drawnNames: readonly string[]): ScreenRow[] {
  const drawn = new Set(drawnNames.map(screenTitleKey));
  // A plan heading can carry a subtitle (`Act-mode proposal — desktop automation step list`) that the drawn page left
  // off (`Act-mode proposal (/)`). `screenTitleKey` keeps the subtitle half, so the two never matched and the page
  // showed up as drawn-but-unplanned beside a screen still "to draw". The part before the dash is accepted as well,
  // but only when no other plan entry shares it: `Settings — providers` and `Settings — appearance` must stay apart.
  const stems = new Map<string, number>();
  for (const page of pages) {
    const stem = subtitleStemKey(page.name);
    if (stem) stems.set(stem, (stems.get(stem) ?? 0) + 1);
  }
  const claimedByStem = (page: PageEntry): boolean => {
    const stem = subtitleStemKey(page.name);
    return Boolean(stem) && stems.get(stem) === 1 && drawn.has(stem);
  };
  const rows: ScreenRow[] = pages.map((page) => ({ ...page, inPages: true, drawn: drawn.has(screenTitleKey(page.name)) || claimedByStem(page) }));
  const listed = new Set(pages.map((page) => screenTitleKey(page.name)));
  for (const page of pages) if (claimedByStem(page)) listed.add(subtitleStemKey(page.name));
  const seen = new Set<string>();
  for (const name of drawnNames) {
    const key = screenTitleKey(name);
    if (listed.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, route: '', details: '', inPages: false, drawn: true });
  }
  return rows;
}

/** The key of the text before a `—` that is a subtitle, not a route: `Act-mode proposal — steps` gives `act mode proposal`. */
function subtitleStemKey(name: string): string {
  const match = /^(.*?)\s*[—–]\s*\S/.exec(name.trim());
  const head = match?.[1]?.trim() ?? '';
  // A leading `/route —` is a route prefix, which `screenTitleKey` already drops.
  if (!head || head.startsWith('/')) return '';
  return screenTitleKey(head);
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
  /** Whether design/style-reference.md exists — a description of the reference images, or of a look given in words.
   * It steers the drawing whether or not the image files are still on disk, so it is read on its own, not only
   * alongside `references`. */
  hasStyleReference: boolean;
  references: readonly string[];
}

/** Said at the end of every prompt, so one stalled tool call cannot snowball into a half-drawn project. */
const CAREFULLY = [
  'Work in small steps and do only what this prompt asks.',
  'If an open-pencil tool call fails, stop and tell me which one and why. Do not retry it in a loop and do not start other work.',
  'Leave the document in a good state after each group of changes, so nothing is lost if the editor stops.',
];

function readFirst(context: DesignContext): string[] {
  const images = context.references.length > 0 ? `design/references/ (${context.references.join(', ')})` : '';
  const reference = images && context.hasStyleReference
    ? `- ${images} for the visual style to match, and design/style-reference.md`
    : images
      ? `- ${images} for the visual style to match`
      : context.hasStyleReference
        ? '- design/style-reference.md for the visual style to match'
        : '';
  return [
    'Read these first (they are in the project, under .kai/spec):',
    context.hasStyleGuide ? '- design/style-guide.md for the look and feel' : '',
    context.hasTokens ? '- design/tokens.json for the colours, type, spacing and radius' : '',
    '- pages.md for every screen, and flows.md for how people move between them',
    reference,
  ].filter(Boolean);
}

/**
 * Said only when the project has no look to follow at all — no reference description, no style guide, no tokens and
 * no images. Rather than draw from nothing, the agent takes the look from the document itself and says what it chose,
 * which is the whole of the "use your own judgment" case: an empty answer here is a screen drawn from the model's
 * defaults with nothing to hold it to.
 */
function noLookFallback(context: DesignContext): string {
  if (context.hasStyleReference || context.hasStyleGuide || context.hasTokens || context.references.length > 0) return '';
  return [
    'This project has no style reference, no style guide and no tokens yet.',
    'Take the look from the open-pencil document as it stands rather than inventing one: call list_variables, list_shared_styles and get_components — and get_selection if something is selected — and follow what is already there. Where nothing exists yet, use your own judgment, keep it plain and consistent, and say at the end which choices you made.',
  ].join(' ');
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
    noLookFallback(context),
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
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

/**
 * How one screen is asked for. `draw` is the first time; `redraw` refills a page that already exists, after the look
 * changed; `clean` clears whatever is broken or duplicated about the screen first, then draws it fresh.
 *
 * Studio matches screens to pages by name, so a turn that finds a page already there and decides there is nothing to
 * do reports it finished while Studio sees no page to match — which stops the whole build. Every mode therefore says
 * what to do with a page that already exists, and names the tools that make it true: `rename_node` to make a page's
 * name identify the screen, `delete_node` to clear a duplicate or a leftover that is in the way.
 */
export type DesignPromptMode = 'draw' | 'redraw' | 'clean';

/** Step 1 of a drawing prompt, by mode. What to do about the page a screen is drawn on. */
const SCREEN_PAGE_STEP: Record<DesignPromptMode, string> = {
  draw: '1. Create one page named exactly as above and mark it as a screen, so Studio can match it to its card. If a page for this screen already exists, keep that page — rename it with rename_node if its name does not identify the screen, since Studio matches by name — and make sure it is marked as a screen. Do not add a second page for it.',
  redraw: '1. The page for this screen already exists. Studio matches screens to pages by name — ignoring the route and any "— …" suffix — so keep exactly one page whose name identifies this screen and make sure it is marked as a screen. If another page or node also stands for this screen (a duplicate, or a leftover), delete the extras with delete_node. Replace the kept page\'s contents with this design.',
  clean: '1. This screen\'s pages may be broken or duplicated. Clean them up in open-pencil first: list the pages, find every page or node that stands for this screen (matching by name, ignoring the route and any "— …" suffix), and delete the ones that are not the single page you are about to draw — use delete_node for each. Delete nothing that belongs to another screen. Then create one page named exactly as above, mark it as a screen, and draw the screen below on it.',
};

/**
 * Step 2..n: one screen. It names exactly what to draw and forbids touching anything else.
 */
export function buildPagePrompt(page: ScreenRow | PageEntry, context: DesignContext, mode: DesignPromptMode = 'draw'): string {
  const details = page.details.trim().slice(0, 1_800);
  return [
    `Use the open-pencil tools to ${mode === 'draw' ? 'draw' : 'draw again'} one screen for "${context.projectName}": ${page.name}${page.route ? ` (${page.route})` : ''}.`,
    '',
    `The project: ${context.goal}`,
    '',
    ...readFirst(context),
    '',
    noLookFallback(context),
    details ? `What pages.md says about this screen:\n${details}\n` : '',
    'Then, in open-pencil:',
    SCREEN_PAGE_STEP[mode],
    '2. Build it from the variables, text styles and components that already exist. Do not type raw colours, sizes or radii, and do not make new shared components unless nothing fits; if you must, name them clearly.',
    '3. Draw the states it lists (empty, loading, error and so on) next to the main view, and a phone-width version when pages.md or the flows call for one.',
    '4. Do not change any other page or any shared component.',
    '',
    ...CAREFULLY,
    'When you are done, say what you drew on this screen.',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

// --- The graph ---------------------------------------------------------------------------------------------

export type FlowNodeKind = 'title' | FlowStepKind | 'outcome';

export interface FlowGraphNode {
  id: string;
  text: string;
  kind: FlowNodeKind;
}

export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** The step nodes in the order the document tells them, which is the order Previous and Next walk. */
  order: string[];
}

const OTHERWISE = /^(?:otherwise|else|if not)\b[,:]?\s*/i;
const IF_START = /^(?:if|when)\b/i;
const ARROW = /^\s*(?:→|->|—|–|:)\s*/;

/** A decision step split into the question it asks and what happens when the answer is yes, if the step says. */
export function splitDecision(text: string): { condition: string; outcome: string } {
  const mark = text.indexOf('?');
  if (mark >= 0) return { condition: text.slice(0, mark + 1).trim(), outcome: text.slice(mark + 1).replace(ARROW, '').trim() };
  const arrow = /\s(?:→|->)\s/.exec(text);
  if (arrow) return { condition: text.slice(0, arrow.index).trim(), outcome: text.slice(arrow.index + arrow[0].length).trim() };
  if (IF_START.test(text)) {
    const comma = text.indexOf(',');
    if (comma > 0) return { condition: text.slice(0, comma).trim(), outcome: text.slice(comma + 1).trim() };
  }
  return { condition: text.trim(), outcome: '' };
}

/**
 * The journey as a graph with real branches. A step that asks a question becomes a decision: what the step says
 * happens when the answer is yes becomes its own box off to the side, and "Otherwise ..." carries the main path on
 * from the decision. A decision with no stated outcome simply continues on its yes. Everything else chains on.
 */
export function buildFlowGraph(journey: FlowJourney): FlowGraph {
  const nodes: FlowGraphNode[] = [{ id: 'title', text: journey.title, kind: 'title' }];
  const edges: FlowGraphEdge[] = [];
  const order: string[] = [];
  let previous = 'title';
  let pendingLabel: string | undefined;
  /** A decision that has stated its yes outcome and is waiting for its "Otherwise". */
  let openDecision: string | null = null;

  const add = (node: FlowGraphNode): void => {
    nodes.push(node);
    order.push(node.id);
  };
  const connect = (source: string, target: string, label?: string): void => {
    edges.push({ id: `${source}->${target}`, source, target, ...(label ? { label } : {}) });
  };

  journey.steps.forEach((step, index) => {
    const id = `s${index}`;
    const otherwise = OTHERWISE.exec(step.text);
    if (otherwise && openDecision) {
      add({ id, text: step.text.slice(otherwise[0].length).trim() || step.text, kind: stepKind(step.text.slice(otherwise[0].length)) });
      connect(openDecision, id, 'otherwise');
      previous = id;
      pendingLabel = undefined;
      openDecision = null;
      return;
    }
    if (step.kind === 'decision') {
      const { condition, outcome } = splitDecision(step.text);
      add({ id, text: condition, kind: 'decision' });
      connect(previous, id, pendingLabel);
      pendingLabel = undefined;
      if (outcome) {
        const outcomeId = `${id}o`;
        add({ id: outcomeId, text: outcome, kind: 'outcome' });
        connect(id, outcomeId, 'yes');
        // The main path carries on from the decision, as "otherwise" if the next step says so, else on its no.
        openDecision = id;
        pendingLabel = 'no';
      } else {
        openDecision = null;
        pendingLabel = 'yes';
      }
      previous = id;
      return;
    }
    add({ id, text: step.text, kind: step.kind });
    connect(previous, id, pendingLabel);
    pendingLabel = undefined;
    openDecision = null;
    previous = id;
  });
  return { nodes, edges, order };
}
