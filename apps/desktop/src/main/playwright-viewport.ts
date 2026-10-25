import { PLAYWRIGHT_MCP_SERVER_ID, type PlaywrightViewportStatus } from '@kai/contracts';
import { unwrapReply } from './design-source';

interface PlaywrightToolPort {
  callServerTool(serverId: string, tool: string, input: Record<string, unknown>): Promise<unknown[] | null>;
}

const viewportProbe = String.raw`() => ({
  viewportWidth: window.innerWidth,
  windowWidth: window.outerWidth,
  screenWidth: screen.availWidth
})`;

/** Uses a temporary blank tab so the check leaves the person's current page and viewport untouched. */
export async function inspectPlaywrightViewport(mcp: PlaywrightToolPort): Promise<PlaywrightViewportStatus> {
  let opened = false;
  try {
    const created = await mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, 'browser_tabs', { action: 'new' });
    if (created === null) throw new Error('The shared Playwright server is not connected.');
    opened = true;
    const reply = await mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, 'browser_evaluate', { function: viewportProbe });
    if (reply === null) throw new Error('The shared Playwright server is not connected.');
    const size = findViewport(unwrapReply(reply));
    if (!size || size.viewportWidth <= 0 || size.windowWidth <= 0 || size.screenWidth <= 0) {
      throw new Error('Playwright did not return usable browser dimensions.');
    }
    // A small browser window is a valid choice. Warn only when the native window is near screen width while its
    // page remains much narrower, which is the specific stuck-viewport signature that leaves blank space at right.
    const needsReset = size.screenWidth >= 1_000
      && size.windowWidth >= size.screenWidth * 0.72
      && size.viewportWidth < size.windowWidth * 0.72;
    return {
      status: needsReset ? 'needs-reset' : 'ok',
      ...size,
      ...(needsReset ? { message: `The page viewport is ${size.viewportWidth}px wide inside a ${size.windowWidth}px browser window.` } : {}),
    };
  } catch (error) {
    return {
      status: 'unavailable', viewportWidth: null, windowWidth: null, screenWidth: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (opened) await mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, 'browser_tabs', { action: 'close' }).catch(() => undefined);
  }
}

function findViewport(value: unknown, visited = new Set<unknown>()): { viewportWidth: number; windowWidth: number; screenWidth: number } | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try { return findViewport(JSON.parse(text), visited); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return null;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findViewport(item, visited);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const viewportWidth = numberFrom(record.viewportWidth);
  const windowWidth = numberFrom(record.windowWidth);
  const screenWidth = numberFrom(record.screenWidth);
  if (viewportWidth !== null && windowWidth !== null && screenWidth !== null) return { viewportWidth, windowWidth, screenWidth };
  for (const item of Object.values(record)) {
    const found = findViewport(item, visited);
    if (found) return found;
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return null;
}
