import { PLAYWRIGHT_MCP_SERVER_ID, STUDIO_DESIGN_PATH, type PreviewState } from '@kai/contracts';
import { nodesFromReply, pagesFromReply, unwrapReply, type DesignPorts } from './design-source';
import { PAGE_FACTS_SCRIPT, parsePageFacts, type CapturedPage, type EqualizerPorts } from './equalizer';
import { waitForPreviewUrl } from './preview-runtime';

/**
 * Wires the Equalizer to the real things: the Playwright MCP KAI already installs for its agents (which opens the
 * pages), the preview runtime (which starts the dev server) and open-pencil (which exports a drawn screen as a
 * picture). All of it is behind one small runtime interface so the wiring itself can be tested with fakes.
 */

export interface EqualizerRuntime {
  mcp: { callServerTool(serverId: string, toolName: string, input: Record<string, unknown>): Promise<unknown[] | null> };
  preview: {
    start(projectId: string, projectPath: string, command?: string): Promise<PreviewState>;
    status(projectId: string, projectPath: string): Promise<PreviewState>;
  };
  /** open-pencil as a server KAI can call, or null when it is not set up. */
  openPencil(): Promise<DesignPorts | null>;
  readSpec(root: string, relativePath: string): Promise<string | null>;
  writeSpec(root: string, relativePath: string, content: string | Buffer): Promise<void>;
  resolveRoot(projectId: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/** A moment for fonts and late content after the page loads, so the picture is of the finished page. */
const SETTLE_MS = 900;
const BROWSER_HEIGHT = 900;

/** The first picture in an MCP reply, as base64, wherever the server put it. */
export function findImage(reply: unknown): string | null {
  const blocks = Array.isArray(reply) ? reply : [reply];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'image' && typeof record.data === 'string' && record.data) return record.data;
  }
  // Some servers answer with JSON that carries the picture as a field.
  const payload = unwrapReply(reply);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of ['data', 'image', 'base64', 'png']) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 100) return value.replace(/^data:image\/\w+;base64,/, '');
    }
  }
  return null;
}

/** The first top-level frame of a page tree reply, with its size and id. */
export function firstFrame(reply: unknown): { id: string; width: number } | null {
  const payload = unwrapReply(reply);
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).tree ?? payload : null;
  const queue: unknown[] = Array.isArray(root) ? [...root] : root ? [root] : [];
  let fallback: { id: string; width: number } | null = null;
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    const width = typeof record.w === 'number' ? record.w : typeof record.width === 'number' ? record.width : 0;
    const type = typeof record.type === 'string' ? record.type.toUpperCase() : '';
    if (id && (type === 'FRAME' || type === 'COMPONENT') && width > 0) return { id, width };
    if (id && !fallback && width > 0 && type !== 'CANVAS' && type !== 'PAGE') fallback = { id, width };
    if (Array.isArray(record.children)) queue.push(...record.children);
  }
  return fallback;
}

/** The argument shapes tried for `export_image`, since the editor owns the exact name of the node argument. */
function exportArguments(id: string): Array<Record<string, unknown>> {
  return [
    { node_id: id, format: 'png', scale: 1 },
    { id, format: 'png', scale: 1 },
    { nodeId: id, format: 'png' },
    { node: id, format: 'png' },
    { root_id: id, format: 'png' },
  ];
}

function textOf(reply: unknown): string {
  return (Array.isArray(reply) ? reply : [reply]).flatMap((block) => {
    const record = block as Record<string, unknown> | null;
    return record && record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

export function createEqualizerPorts(
  runtime: EqualizerRuntime,
  now: () => string,
  progress: (projectId: string, event: { done: number; total: number; current: string }) => void,
): (projectId: string) => EqualizerPorts {
  const browser = async (tool: string, input: Record<string, unknown>): Promise<unknown[]> => {
    const blocks = await runtime.mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, tool, input);
    if (blocks === null) throw new Error('The Playwright MCP server is not running. Start it under Settings, MCP servers, then run the Equalizer again.');
    return blocks;
  };

  return (projectId) => ({
    projectRoot: () => runtime.resolveRoot(projectId),
    readSpec: (root, relativePath) => runtime.readSpec(root, relativePath),
    writeSpec: (root, relativePath, content) => runtime.writeSpec(root, relativePath, content),

    async devUrl(id, root) {
      return waitForPreviewUrl(runtime.preview, id, root, { sleep: runtime.sleep });
    },

    async openPage(url, width): Promise<CapturedPage> {
      await browser('browser_navigate', { url });
      await browser('browser_resize', { width, height: BROWSER_HEIGHT });
      await runtime.sleep(SETTLE_MS);
      const shot = await browser('browser_take_screenshot', { type: 'png', fullPage: true }).catch(() => browser('browser_take_screenshot', { type: 'png' }));
      const data = findImage(shot);
      if (!data) throw new Error(`The browser returned no picture of ${url}.`);
      let facts = null;
      try {
        facts = parsePageFacts(textOf(await browser('browser_evaluate', { function: PAGE_FACTS_SCRIPT })));
      } catch {
        // The picture still compares; only the measured differences are lost.
      }
      return { png: Buffer.from(data, 'base64'), facts };
    },

    async drawnScreens(root) {
      const raw = await runtime.readSpec(root, STUDIO_DESIGN_PATH);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as { components?: Array<{ name?: unknown; screen?: unknown }> };
        return (parsed.components ?? []).flatMap((component) => (component.screen === true && typeof component.name === 'string' ? [component.name] : []));
      } catch {
        return [];
      }
    },

    async designConnected() {
      return (await runtime.openPencil()) !== null;
    },

    async exportDesignScreen(name) {
      const pencil = await runtime.openPencil();
      if (!pencil) return null;
      const pages = pagesFromReply(await pencil.call('list_pages', {}));
      const page = pages.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!page) return null;
      await pencil.call('switch_page', { page: page.id });
      const frame = firstFrame(await pencil.call('get_page_tree', { depth: 1 }));
      const target = frame?.id ?? nodesFromReply(await pencil.call('get_page_tree', { depth: 1 }))[0]?.id;
      if (!target) throw new Error(`${name} is drawn in open-pencil but has no frame to export.`);
      let lastError = '';
      for (const input of exportArguments(target)) {
        try {
          const data = findImage(await pencil.call('export_image', input));
          if (data) return { png: Buffer.from(data, 'base64'), width: frame?.width ?? 0 };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(`open-pencil would not export ${name} as a picture${lastError ? ` (${lastError.slice(0, 160)})` : ''}. Compare it with a website instead, or export the screen from the editor.`);
    },

    progress: (event) => progress(projectId, event),
    now,
  });
}

/** Folds a failed list of tool results into one readable line, for the status text the panel shows. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'The Equalizer could not run.';
}
