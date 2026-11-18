import type { AutonomyMode } from '@kai/contracts';
import type { ExternalToolPort, ProjectToolExecution, ProjectToolPolicy } from './project-tools';

/**
 * Every outside (MCP) tool's full schema is re-sent on every round of a run. With several servers connected that is
 * thousands of tokens of tools the task never touches. Past a threshold the model is instead offered `tool_search`
 * plus a list of names; searching loads the matching schemas into the same run, from the next round on.
 */
export const DEFER_MIN_TOOLS = 12;
export const DEFER_MIN_CHARS = 12_000;
const MAX_NAMES_LISTED = 80;
const MAX_LOADED_PER_SEARCH = 8;

export const TOOL_SEARCH_NAME = 'tool_search';

interface Described {
  name: string;
  description: string;
  definition: unknown;
}

function describe(definition: unknown): Described | undefined {
  if (!definition || typeof definition !== 'object') return undefined;
  const record = definition as { name?: unknown; description?: unknown };
  if (typeof record.name !== 'string' || !record.name) return undefined;
  return { name: record.name, description: typeof record.description === 'string' ? record.description : '', definition };
}

/** True when the outside tools are big enough that listing them all costs more than searching for them. */
export function shouldDefer(definitions: readonly unknown[]): boolean {
  if (definitions.length >= DEFER_MIN_TOOLS) return true;
  let chars = 0;
  for (const definition of definitions) {
    try { chars += JSON.stringify(definition).length; } catch { /* an unserialisable schema counts as nothing */ }
  }
  return chars >= DEFER_MIN_CHARS;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
}

/** Tools ranked by how well the query matches their name (heavily) and description. `select:a,b` loads exact names. */
export function rankTools(tools: readonly Described[], query: string, limit = MAX_LOADED_PER_SEARCH): Described[] {
  const trimmed = query.trim();
  if (/^select:/i.test(trimmed)) {
    const wanted = new Set(trimmed.slice(7).split(',').map((name) => name.trim()).filter(Boolean));
    return tools.filter((tool) => wanted.has(tool.name)).slice(0, limit);
  }
  const terms = words(trimmed);
  if (terms.length === 0) return [];
  const scored = tools.map((tool) => {
    const nameWords = new Set(words(tool.name));
    const descWords = new Set(words(tool.description));
    let score = 0;
    for (const term of terms) {
      if (nameWords.has(term)) score += 4;
      else if (tool.name.toLowerCase().includes(term)) score += 2;
      if (descWords.has(term)) score += 1;
    }
    return { tool, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.tool);
}

function toolSearchDefinition(tools: readonly Described[]): unknown {
  const listed = tools.slice(0, MAX_NAMES_LISTED).map((tool) => tool.name);
  const more = tools.length > listed.length ? ` (and ${tools.length - listed.length} more)` : '';
  return {
    type: 'function',
    name: TOOL_SEARCH_NAME,
    description: `Outside tools are not all loaded up front. Call this with a few keywords (or "select:name1,name2" for exact names) to load the matching tools; they can be called from your next step. Available outside tools: ${listed.join(', ')}${more}.`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing what you need to do, or "select:" followed by comma-separated tool names.' } },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

/**
 * One run's view of the outside tools. Call `definitions()` once at the start of the run and keep sending the array
 * it returns: loading a tool adds to that same array, so later rounds offer it without another lookup.
 */
export function deferExternalTools(port: ExternalToolPort | undefined, force = false): ExternalToolPort | undefined {
  if (!port) return port;
  let live: unknown[] | undefined;
  let catalog: Described[] = [];
  const loaded = new Set<string>();

  return {
    async definitions() {
      const all = await port.definitions();
      // `force` is for a small model, which pays for every schema it is sent: it sees one search tool and loads the rest by name.
      if (!force && !shouldDefer(all)) return all;
      catalog = all.map(describe).filter((entry): entry is Described => Boolean(entry));
      live = [toolSearchDefinition(catalog)];
      loaded.clear();
      return live;
    },
    policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy | undefined {
      // Searching only reads a list of names; it is allowed wherever the model is allowed to see tools at all.
      if (name === TOOL_SEARCH_NAME && live) return { decision: 'allow' };
      return port.policy(name, autonomy);
    },
    async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ProjectToolExecution | undefined> {
      if (name !== TOOL_SEARCH_NAME || !live) return port.execute(name, input, signal);
      const query = typeof (input as { query?: unknown } | undefined)?.query === 'string' ? (input as { query: string }).query : '';
      const matches = rankTools(catalog, query);
      if (matches.length === 0) {
        return { ok: true, output: { loaded: [], note: `No outside tool matched "${query}". Try other keywords, or "select:" with an exact name from the list in this tool's description.` } };
      }
      const fresh = matches.filter((tool) => !loaded.has(tool.name));
      for (const tool of fresh) {
        loaded.add(tool.name);
        live.push(tool.definition);
      }
      return {
        ok: true,
        output: {
          loaded: matches.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 200) })),
          note: fresh.length > 0 ? 'These tools are now available. Call them directly in your next step.' : 'These tools were already loaded. Call them directly.',
        },
      };
    },
  };
}

/**
 * One line for the run's context snapshot saying which outside tools were loaded on demand, read back from the
 * `tool_search` calls the run made. Undefined when the run never searched, so nothing is added for ordinary runs.
 */
export function deferredToolSummary(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): string | undefined {
  const loaded = new Set<string>();
  let searches = 0;
  for (const event of events) {
    if (event.type !== 'tool.call' || event.name !== TOOL_SEARCH_NAME || event.status !== 'completed') continue;
    searches += 1;
    const list = (event.output as { loaded?: unknown } | undefined)?.loaded;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const name = (item as { name?: unknown } | null)?.name;
      if (typeof name === 'string') loaded.add(name);
    }
  }
  if (searches === 0) return undefined;
  const names = [...loaded];
  const shown = names.slice(0, 8).join(', ');
  return `Outside tools loaded on demand (${searches} ${searches === 1 ? 'search' : 'searches'}): ${names.length === 0 ? 'none matched' : `${shown}${names.length > 8 ? ` and ${names.length - 8} more` : ''}`}`;
}
