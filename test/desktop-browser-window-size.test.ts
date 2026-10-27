import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER_ID, boardCardSchema, type BoardCard } from '../packages/contracts/src';
import { playwrightUiCheckPorts, UI_LAYOUT_SCRIPT, type UiCheckRuntime } from '../apps/desktop/src/main/ui-check';
import { BROWSER_RULES } from '../apps/desktop/src/main/ui-rules';

const NOW = '2026-10-21T00:00:00.000Z';
const card = (): BoardCard => boardCardSchema.parse({
  id: 'home', title: 'Home', kind: 'page', story: '', acceptance: [], prompt: '', designRef: null, route: '/', dependsOn: [],
  needsArtifacts: [], status: 'ready', checks: [], check: null, runs: [], notes: '', stale: false, staleReason: null, claimedBy: null,
  movedBy: null, movedAt: null, createdAt: NOW, updatedAt: NOW,
});

interface Call { tool: string; input: Record<string, unknown> }
interface Tab { name: string; /** null while the tab follows its window; a size once something has pinned it with a resize. */ pinned: { width: number; height: number } | null; scheme: string | null }

/**
 * A Playwright MCP with tabs. A tab follows its window until `browser_resize` pins it, and stays pinned until it is
 * closed; `browser_tabs` opens a fresh, unpinned tab and makes it the current one, and closes the current one.
 */
function browser(options: { failScreenshot?: boolean; cannotOpenTabs?: boolean } = {}): { runtime: UiCheckRuntime; calls: Call[]; tabs: Tab[]; current: () => Tab | undefined } {
  const calls: Call[] = [];
  const tabs: Tab[] = [{ name: 'the one the person is looking at', pinned: null, scheme: null }];
  let index = 0;
  let opened = 0;
  const runtime: UiCheckRuntime = {
    mcp: {
      callServerTool: async (serverId, tool, input) => {
        expect(serverId).toBe(PLAYWRIGHT_MCP_SERVER_ID);
        calls.push({ tool, input });
        if (tool === 'browser_tabs') {
          if (input.action === 'new') {
            if (options.cannotOpenTabs) throw new Error('no new tabs');
            opened += 1;
            tabs.push({ name: `check tab ${opened}`, pinned: null, scheme: null });
            index = tabs.length - 1;
          } else if (input.action === 'close') {
            tabs.splice(index, 1);
            index = Math.max(0, tabs.length - 1);
          }
          return [{ type: 'text', text: 'ok' }];
        }
        const tab = tabs[index]!;
        if (tool === 'browser_resize') { tab.pinned = { width: Number(input.width), height: Number(input.height) }; return [{ type: 'text', text: 'ok' }]; }
        if (tool === 'browser_emulate_media') { tab.scheme = String(input.colorScheme); return [{ type: 'text', text: 'ok' }]; }
        if (tool === 'browser_evaluate' && input.function === UI_LAYOUT_SCRIPT) {
          const width = tab.pinned?.width ?? 1745;
          return [{ type: 'text', text: JSON.stringify({ measured: true, innerWidth: width, innerHeight: tab.pinned?.height ?? 1232, scrollWidth: width, clientWidth: width, hasViewportMeta: true, contentLeft: 0, contentRight: width, headerLeft: 0, headerRight: width, headerBacked: true, scrollable: false, navCount: 0, navVisibleAtTop: false, navVisibleAtBottom: false, fixedNavTop: 0, contentBottomAtScrollEnd: 0 }) }];
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
  return { runtime, calls, tabs, current: () => tabs[index] };
}

const phone = { name: 'phone', width: 390, height: 844 } as const;
const original = (tabs: Tab[]): Tab | undefined => tabs.find((tab) => tab.name === 'the one the person is looking at');

describe('keeping the shared browser\'s window usable after a check', () => {
  it('does its resizing in a tab of its own and leaves nothing pinned behind', async () => {
    const b = browser();
    await playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://127.0.0.1:5173', viewport: phone, theme: 'dark', card: card() });

    expect(b.tabs).toHaveLength(1);
    expect(original(b.tabs)).toEqual({ name: 'the one the person is looking at', pinned: null, scheme: null });
    expect(b.calls.map((call) => call.tool === 'browser_tabs' ? `tabs:${String(call.input.action)}` : call.tool)).toEqual([
      'tabs:new', 'browser_navigate', 'browser_resize', 'browser_emulate_media', 'browser_take_screenshot', 'tabs:close',
    ]);
  });

  it('never resizes the tab that was already open', async () => {
    const b = browser();
    const seen: string[] = [];
    const call = b.runtime.mcp.callServerTool;
    b.runtime.mcp.callServerTool = async (serverId, tool, input) => {
      if (tool === 'browser_resize') seen.push(b.current()!.name);
      return call(serverId, tool, input);
    };
    await playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() });
    expect(seen).toEqual(['check tab 1']);
  });

  it('closes its tab even when the screenshot fails', async () => {
    const b = browser({ failScreenshot: true });
    await expect(playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() })).rejects.toThrow('no screenshot');
    expect(b.tabs).toHaveLength(1);
    expect(original(b.tabs)?.pinned).toBeNull();
  });

  it('measures the layout in a tab of its own too, and still returns the measurement', async () => {
    const b = browser();
    const facts = await playwrightUiCheckPorts(b.runtime, () => NOW).layout!({ url: 'http://x', viewport: phone });
    expect(facts).toMatchObject({ innerWidth: 390 });
    expect(b.tabs).toHaveLength(1);
    expect(original(b.tabs)?.pinned).toBeNull();
  });

  it('runs the DOM probe in its own tab without navigating the visible tab', async () => {
    const b = browser();
    await playwrightUiCheckPorts(b.runtime, () => NOW).probe({ url: 'http://x', card: card() });
    expect(b.calls.map((call) => call.tool === 'browser_tabs' ? `tabs:${String(call.input.action)}` : call.tool)).toEqual([
      'tabs:new', 'browser_navigate', 'browser_evaluate', 'tabs:close',
    ]);
    expect(b.tabs).toHaveLength(1);
  });

  it('opens a fresh tab for each of several checks and closes every one', async () => {
    const b = browser();
    const ports = playwrightUiCheckPorts(b.runtime, () => NOW);
    for (const theme of ['light', 'dark'] as const) await ports.capture({ url: 'http://x', viewport: phone, theme, card: card() });
    expect(b.calls.filter((call) => call.tool === 'browser_tabs' && call.input.action === 'new')).toHaveLength(2);
    expect(b.tabs).toHaveLength(1);
  });

  it('refuses to resize the current tab when a new one cannot be opened', async () => {
    const b = browser({ cannotOpenTabs: true });
    await expect(playwrightUiCheckPorts(b.runtime, () => NOW).capture({ url: 'http://x', viewport: phone, theme: 'light', card: card() })).rejects.toThrow('no new tabs');
    expect(b.calls.map((call) => call.tool)).toEqual(['browser_tabs']);
    expect(b.tabs).toHaveLength(1);
  });

  it('tells agents to resize only in a tab of their own and to close it, which puts the window back', () => {
    const rule = BROWSER_RULES.find((line) => line.includes('browser_resize fixes that tab'));
    expect(rule).toBeDefined();
    expect(rule).toContain('sizes the Chrome window to match');
    expect(rule).toContain('Closing the resized tab puts the window back');
    expect(rule).toContain('Never call browser_resize on the preview tab');
  });
});
