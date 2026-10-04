import * as crypto from 'node:crypto';

/**
 * The design layer. open-pencil is the source of truth for tokens and for which screens exist; KAI reads it and
 * writes what it reads into `.kai/spec`. Nothing here invents a token or a component: every value comes back from
 * the editor, and a tool call that fails is reported rather than papered over.
 *
 * The whole module is port-driven, so every rule below is testable without a running editor — the same shape
 * `ui-check.ts` uses for the visual check.
 */

/** The node tree open-pencil reports, narrowed to what KAI uses: identity, kind, name, and whether it is a master. */
export interface DesignNode {
  id: string;
  name: string;
  type: string;
  /** The page this node belongs to, when the reply says. */
  page?: string;
  /** A component's master (`COMPONENT`) or a use of one (`INSTANCE`). */
  component: boolean;
  children: DesignNode[];
}

export interface DesignComponent {
  id: string;
  name: string;
  page: string;
  /** A page the editor marked as a screen is a page card; a component is a component card. */
  screen: boolean;
}

export interface DesignPage {
  id: string;
  name: string;
}

export interface DesignRead {
  /** The token document: `{ <mode name>: { "--collection-variable": "<css value>" } }`, parsed from the editor's JSON. */
  tokens: Record<string, unknown>;
  /** How many tokens the editor reported, so the pull can say what it read rather than only that it read. */
  tokenCount: number;
  components: DesignComponent[];
  /** One hash per node id, so a redesign can be detected without a diff tool. */
  hashes: Record<string, string>;
  /** One hash over the whole tree, for "has the design changed at all". */
  treeHash: string;
}

export interface DesignPorts {
  /** One MCP tool call against the open-pencil server. Throws with the tool's own error when it fails. */
  call(tool: string, input: Record<string, unknown>): Promise<unknown>;
  /** The endpoint KAI is talking to, recorded with each pull so it is clear which editor the design came from. */
  endpoint(): string;
}

/**
 * The tools KAI reads the design with. Named in one place, because the editor owns their exact spelling.
 *
 * There is no `get_style_guide`: open-pencil 0.14.0 exposes no such tool, so the style guide stays a
 * model-authored artifact derived from the tokens rather than something the editor hands over.
 */
export const DESIGN_TOOLS = {
  tokens: 'design_to_tokens',
  components: 'get_components',
  pages: 'list_pages',
  tree: 'get_page_tree',
  switchPage: 'switch_page',
} as const;

/**
 * Reads everything the studio needs in one pass. Tokens, components and the page list are independent reads, so
 * they go out together; the node trees are read page by page afterwards, because `get_page_tree` only answers for
 * whatever page is currently selected.
 */
export async function readDesign(ports: DesignPorts): Promise<DesignRead> {
  const [tokensReply, componentsReply, pagesReply] = await Promise.all([
    ports.call(DESIGN_TOOLS.tokens, { format: 'json' }),
    ports.call(DESIGN_TOOLS.components, {}),
    ports.call(DESIGN_TOOLS.pages, {}),
  ]);
  const pages = pagesFromReply(pagesReply);
  const tree = await readPageTrees(ports, pages, pageNameOf(pagesReply));
  const tokens = tokensFromReply(tokensReply);
  return {
    tokens,
    tokenCount: tokenCountOf(tokens, tokensReply),
    components: componentsFrom(componentsReply, pagesReply),
    hashes: nodeHashes(tree),
    treeHash: hashOf(JSON.stringify(tree)),
  };
}

/** The count the editor reported beside the tokens, or the number of entries in the map when it reported none. */
export function tokenCountOf(tokens: Record<string, unknown>, reply: unknown): number {
  const value = unwrapReply(reply);
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const reported = record?.tokenCount;
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  let count = 0;
  for (const mode of Object.values(tokens)) {
    if (mode && typeof mode === 'object' && !Array.isArray(mode)) count += Object.keys(mode).length;
  }
  return count;
}

/**
 * The whole document's nodes. `get_page_tree` reads the *current* page, so a different page is selected before it is
 * read and the editor's original page is put back afterwards. A pull that skipped this would hash one page and call
 * it the design.
 */
async function readPageTrees(ports: DesignPorts, pages: readonly DesignPage[], current: string | null): Promise<DesignNode[]> {
  // With no page list the editor still answers for whatever page is open, so one unnamed read is made.
  const selected: DesignPage[] = pages.length > 0 ? [...pages] : [{ id: '', name: current ?? '' }];
  let active = current;
  const nodes: DesignNode[] = [];
  for (const page of selected) {
    if (page.id && page.name !== active) {
      await ports.call(DESIGN_TOOLS.switchPage, { page: page.id });
      active = page.name;
    }
    for (const node of nodesFromReply(await ports.call(DESIGN_TOOLS.tree, {}))) {
      nodes.push(page.name ? { ...node, page: page.name } : node);
    }
  }
  if (current && active !== current) {
    const back = pages.find((page) => page.name === current);
    if (back) await ports.call(DESIGN_TOOLS.switchPage, { page: back.id });
  }
  return nodes;
}

function pageNameOf(reply: unknown): string | null {
  const value = unwrapReply(reply);
  const current = value && typeof value === 'object' ? (value as Record<string, unknown>).current : undefined;
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

/** The token document. A reply that is not JSON is refused rather than written as an empty file. */
export function tokensFromReply(reply: unknown): Record<string, unknown> {
  const value = unwrapReply(reply);
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) throw new Error('open-pencil did not return a token document. Check that a document is open in the editor.');
  const failure = errorIn(record);
  if (failure) throw new Error(`open-pencil could not export tokens: ${failure}`);
  // `design_to_tokens` answers `{ output, tokenCount, modeCount }`; with `format: 'json'` the output is a string.
  const output = record.output;
  if (typeof output === 'string') {
    const parsed = parseMaybeJson(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    // A document with no variables defined yet answers a CSS comment ("/* No matching variables found */")
    // instead of JSON, even with format: 'json'. That is an empty design, not a broken reply, so it is read as
    // zero tokens rather than refused — the editor already said so itself by reporting a token count of 0.
    if (record.tokenCount === 0) return {};
    throw new Error('open-pencil returned tokens that were not a JSON document.');
  }
  // Tolerated so a future version that returns the map directly still works.
  const nested = record.tokens;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return record;
}

/** An MCP tool call reports failure in the payload rather than by throwing, so the message has to be fished out. */
function errorIn(record: Record<string, unknown>): string | null {
  const error = record.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

/** Every MCP reply arrives wrapped in a content list; the useful value is the JSON or the text inside it. */
export function unwrapReply(reply: unknown): unknown {
  const block = Array.isArray(reply) ? reply.find((item) => item && typeof item === 'object') : reply;
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : null;
  if (!record) return reply;
  if (record.json !== undefined) return record.json;
  if (typeof record.text === 'string') return parseMaybeJson(record.text);
  return record;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return text;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return text;
  }
}

/** The document's pages, as `list_pages` reports them: `{ current, pages: [{ id, name }] }`. */
export function pagesFromReply(reply: unknown): DesignPage[] {
  const found: DesignPage[] = [];
  for (const item of listOf(unwrapReply(reply))) {
    const id = idOf(item);
    if (!id) continue;
    found.push({ id, name: nameOf(item, id) });
  }
  return found;
}

/** The components the board gets a card from: one per component, plus one per page the editor marked as a screen. */
export function componentsFrom(componentsReply: unknown, pagesReply: unknown): DesignComponent[] {
  const found: DesignComponent[] = [];
  for (const item of listOf(unwrapReply(componentsReply))) {
    const id = idOf(item);
    if (!id) continue;
    found.push({ id, name: nameOf(item, id), page: String(valueOf(item, 'page') ?? valueOf(item, 'pageName') ?? ''), screen: false });
  }
  for (const page of pagesFromReply(pagesReply)) {
    found.push({ id: page.id, name: page.name, page: page.name, screen: true });
  }
  return found;
}

/**
 * A node tree from the shapes the editor answers with. `get_page_tree` returns `{ tree }`, one root node per page;
 * a bare node, a node list and the old `{ nodes }` spelling are all tolerated so a version change is not fatal.
 */
export function nodesFromReply(reply: unknown): DesignNode[] {
  const value = unwrapReply(reply);
  if (Array.isArray(value)) return value.flatMap((item) => isNode(item) ? [nodeOf(item)] : []);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['tree', 'root', 'nodes', 'children', 'pages']) {
      const found = record[key];
      if (Array.isArray(found)) return found.flatMap((item) => isNode(item) ? [nodeOf(item)] : []);
      if (isNode(found)) return [nodeOf(found)];
    }
    if (isNode(record)) return [nodeOf(record)];
  }
  return [];
}

/** One hash per node id, so a card whose node changed can be told from one whose node did not. */
export function nodeHashes(nodes: readonly DesignNode[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (node: DesignNode): void => {
    // The node's own name and kind, not its children's: a child changing should not restale its parent's card.
    hashes[node.id] = hashOf(`${node.type}:${node.name}`);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return hashes;
}

/** Which of a card's design nodes changed since the hashes the card was built with. */
export function changedNodes(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((id) => before[id] !== after[id]);
}

export function hashOf(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isNode(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && Boolean(idOf(value));
}

function nodeOf(value: unknown): DesignNode {
  const record = value as Record<string, unknown>;
  const type = String(record.type ?? record.kind ?? 'node');
  const children = Array.isArray(record.children) ? record.children.flatMap((child) => isNode(child) ? [nodeOf(child)] : []) : [];
  return {
    id: idOf(value) as string,
    name: nameOf(value, idOf(value) as string),
    type,
    ...(typeof record.page === 'string' ? { page: record.page } : {}),
    component: type.toUpperCase() === 'COMPONENT' || record.isComponent === true,
    children,
  };
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['components', 'pages', 'items', 'results', 'nodes']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function idOf(value: unknown): string | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  for (const key of ['id', 'nodeId', 'node_id', 'key']) {
    const found = record?.[key];
    if (typeof found === 'string' && found.trim()) return found;
    if (typeof found === 'number') return String(found);
  }
  return null;
}

function nameOf(value: unknown, fallback: string): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const name = record?.name ?? record?.title ?? record?.label;
  return typeof name === 'string' && name.trim() ? name.trim() : fallback;
}

function valueOf(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** Turns an editor failure into something the user can act on, without pretending the design was read. */
export function designErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The server's token is fixed when open-pencil starts; a 401 means KAI's copy does not match it, not that another
  // client holds it. Multiple clients share one token (see docs/open-pencil-spike.md).
  if (/401|unauthor/i.test(message)) {
    return 'open-pencil refused the connection: the token KAI holds does not match the one the editor was started with. Check it in Settings.';
  }
  if (/open-pencil is not connected/i.test(message)) {
    return message;
  }
  if (/ECONNREFUSED|fetch failed|connect/i.test(message)) {
    return 'open-pencil is not running. Start it, then pull the design again.';
  }
  // `OPENPENCIL_MCP_ROOT` is the server's own setting, fixed when open-pencil was launched, so a read outside that
  // directory fails in the editor and KAI can only relay it.
  if (/outside|not allowed|allowed director|ENOENT/i.test(message)) {
    return `open-pencil refused the read: the file is outside the folder the editor was started with (OPENPENCIL_MCP_ROOT). ${message}`;
  }
  return message;
}
