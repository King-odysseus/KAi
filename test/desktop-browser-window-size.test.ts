import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER_ID, boardCardSchema, type BoardCard } from '../packages/contracts/src';
import { parseWindowSize, playwrightUiCheckPorts, UI_LAYOUT_SCRIPT, WINDOW_SIZE_SCRIPT, type UiCheckRuntime } from '../apps/desktop/src/main/ui-check';
import { BROWSER_RULES } from '../apps/desktop/src/main/ui-rules';

const NOW = '2026-10-21T00:00:00.000Z';
const card = (): BoardCard => boardCardSchema.parse({
  id: 'home', title: 'Home', kind: 'page', story: '', acceptance: [], prompt: '', designRef: null, route: '/', dependsOn: [],
  needsArtifacts: [], status: 'ready', checks: [], check: null, runs: [], notes: '', stale: false, staleReason: null, claimedBy: null,
  movedBy: null, movedAt: null, createdAt: NOW, updatedAt: NOW,
});

interface Call { tool: string; input: Record<string, unknown> }

/** A Playwright MCP that follows a window of the given size and fixes the page at whatever a resize asks for. */
function browser(window: { width: number; height: number }, options: { failScreenshot?: boolean; unreadable?: boolean } = {}): { runtime: UiCheckRuntime; calls: Call[]; page: () => { width: number; height: number } } {
  const calls: Call[] = [];
  let page = { ...window };
  const runtime: UiCheckRuntime = {
    mcp: {
      callServerTool: async (serverId, tool, input) => {
        expect(serverId).toBe(PLAYWRIGHT_MCP_SERVER_ID);
        calls.push({ tool, input });
        if (tool === 'browser_resize') { page = { width: Number(input.width), height: Number(input.height) }; return [{ type: 'text', text: 'ok' }]; }
        if (tool === 'browser_evaluate' && input.function === WINDOW_SIZE_SCRIPT) {
          return [{ type: 'text', text: options.unreadable ? 'nothing useful' : `### Result\n[${page.width},${page.height}]\n` }];
        }
        if (tool === 'browser_evaluate' && input.function === UI_LAYOUT_SCRIPT) {
          return [{ type: 'text', text: JSON.stringify({ measured: true, innerWidth: page.width, innerHeight: page.height, scrollWidth: page.width, clientWidth: page.width, hasViewportMeta: true, contentLeft: 0, contentRight: page.width, headerLeft: 0, headerRight: page.width, headerBacked: true, scrollable: false, navCount: 0, navVisibleAtTop: false, navVisibleAtBottom: false, fixedNavTop: 0, contentBottomAtScrollEnd: 0 }) }];
        }
        if (tool === 'browser_take_screenshot') {
          if (options.failScreenshot) throw new Error('no screenshot');
          return [{ type: 'image', data: 'AAAA' }];
        }
        return [{ type: 'text', text: 'ok' }];
      },
    },
    preview: { start: async () => ({}) as never, status: async () => ({}) as never },
    readFile: async () => null,
    writeFile: async () => undefined,
    sleep: async () => undefined,
  };
  return { runtime, calls, page: () => page };
}

const phone = { name: 'phone', width: 390, height: 844 } as const;

describe('putting the browser window back after a check', () => {
  it('reads a size out of whatever the server wrapped around it, and refuses a guess', () => {
    expect(parseWindowSize('### Result\n[1745,1232]\n### Ran Playwright code')).toEqual({ width: 1745, height: 1232 });
    expect(parseWindowSize('[ 1920 , 1080 ]')).toEqual({ width: 1920, height: 1080 });
    expect(parseWindowSize('nothing here')).toBeNull();
    expect(parseWindowSize('[0,0]')).toBeNull();
    expect(parseWindowSize('[12,9]')).toBeNull();
  });

  it('leaves the page the size of its window after a screenshot at phone width', async () => {
    const b = browser({ width: 1745, height: 1232 });
    const ports = playwrightUiCheckPorts(b.runtime, () => NOW);

    await ports.capture({ url: 'http://127.0.0.1:5173', viewport: phone, theme: 'dark', card: card() });

    expect(b.calls.filter((call) => call.tool === 'browser_resize').map((call) => call.input)).toEqual([
      { width: 390, height: 844 },
      { width: 1745, height: 1232 },
    ]);
    expect(b.page()).toEqual({ width: 1745, height: 1232 });
  });

  it('reads the window before the first resize, not after it', async () => {
    const b = browser({ width: 1745, height: 1232 });
    await playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() });
    const order = b.calls.map((call) => call.tool);
    expect(order.indexOf('browser_evaluate')).toBeLessThan(order.indexOf('browser_resize'));
  });

  it('puts the window back even when the screenshot fails', async () => {
    const b = browser({ width: 1745, height: 1232 }, { failScreenshot: true });
    await expect(playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() })).rejects.toThrow('no screenshot');
    expect(b.page()).toEqual({ width: 1745, height: 1232 });
  });

  it('restores after the layout measurement too, and still returns the measurement', async () => {
    const b = browser({ width: 1745, height: 1232 });
    const facts = await playwrightUiCheckPorts(b.runtime, () => NOW).layout!({ url: 'http://x', viewport: phone });
    expect(facts).toMatchObject({ innerWidth: 390 });
    expect(b.page()).toEqual({ width: 1745, height: 1232 });
  });

  it('leaves the size alone, rather than guessing, when the window cannot be read', async () => {
    const b = browser({ width: 1745, height: 1232 }, { unreadable: true });
    await playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() });
    expect(b.calls.filter((call) => call.tool === 'browser_resize')).toHaveLength(1);
  });

  it('tells agents to note the window size before they resize and to put it back after', () => {
    const rule = BROWSER_RULES.find((line) => line.includes('window.innerWidth'));
    expect(rule).toBeDefined();
    expect(rule).toContain('browser_resize again');
  });
});
