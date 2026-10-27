import { PLAYWRIGHT_MCP_SERVER_ID } from '@kai/contracts';

/**
 * Captures what open-pencil is showing right now, for the Design tab's per-page preview.
 *
 * open-pencil's own MCP surface (`design-source.ts`'s `DESIGN_TOOLS`) has no screenshot or export tool — reading the
 * design only ever returns structured data: tokens, components, the page list, the node tree. A visual preview has
 * to come from somewhere else, so this drives the same shared Playwright browser every other screenshot in KAI goes
 * through (`ui-check.ts`'s visual check), pointed at the editor's own page instead of a project's dev server.
 */

export interface DesignScreenshotRuntime {
  mcp: { callServerTool(serverId: string, toolName: string, input: Record<string, unknown>): Promise<unknown[] | null> };
}

/** The image block's base64 payload, however the MCP server wrapped it. Mirrors `ui-check.ts`'s own `imageData`. */
function imageData(blocks: unknown[] | null): string | null {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'image' && typeof record.data === 'string') return record.data;
  }
  return null;
}

/**
 * Wires a screenshot function to the shared Playwright MCP: one PNG of whatever `endpoint` shows, in a tab of its
 * own so nothing else sharing the browser is navigated or resized out from under whoever is looking at it — the
 * same reasoning `ui-check.ts`'s `inOwnTab` documents.
 *
 * This assumes open-pencil serves its own editor UI at the same address its MCP server answers on (`endpoint()` in
 * `design-source.ts`'s `DesignPorts` — a single local app serving both). If a real open-pencil install splits those,
 * the endpoint to navigate to needs to come from a separate setting instead.
 */
export function playwrightDesignScreenshot(runtime: DesignScreenshotRuntime): (endpoint: string) => Promise<string> {
  return async (endpoint: string): Promise<string> => {
    const call = async (tool: string, input: Record<string, unknown>): Promise<unknown[] | null> => {
      const blocks = await runtime.mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, tool, input);
      if (blocks === null) throw new Error('The Playwright MCP server is not running. Start it under Settings, MCP servers, then try again.');
      return blocks;
    };
    await call('browser_tabs', { action: 'new' });
    try {
      await call('browser_navigate', { url: endpoint });
      const blocks = await call('browser_take_screenshot', { type: 'png', filename: 'design-page.png' });
      const data = imageData(blocks);
      if (!data) throw new Error('The Playwright MCP returned no image of the open-pencil page.');
      return data;
    } finally {
      await call('browser_tabs', { action: 'close' }).catch(() => undefined);
    }
  };
}
