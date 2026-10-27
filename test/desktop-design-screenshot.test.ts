import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER_ID } from '@kai/contracts';
import { playwrightDesignScreenshot } from '../apps/desktop/src/main/design-screenshot';

function runtimeWith(reply: (serverId: string, tool: string, input: Record<string, unknown>) => unknown[] | null) {
  const calls: Array<{ serverId: string; tool: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      mcp: {
        async callServerTool(serverId: string, toolName: string, input: Record<string, unknown>) {
          calls.push({ serverId, tool: toolName, input });
          return reply(serverId, toolName, input);
        },
      },
    },
  };
}

describe('capturing a screenshot of open-pencil', () => {
  it('opens its own tab, navigates to the endpoint, and closes the tab after', async () => {
    const { runtime, calls } = runtimeWith((serverId, tool) => {
      if (tool === 'browser_take_screenshot') return [{ type: 'image', data: 'AAAA' }];
      return [];
    });
    const base64 = await playwrightDesignScreenshot(runtime)('http://127.0.0.1:7600');

    expect(base64).toBe('AAAA');
    expect(calls.map((call) => call.tool)).toEqual(['browser_tabs', 'browser_navigate', 'browser_take_screenshot', 'browser_tabs']);
    expect(calls.every((call) => call.serverId === PLAYWRIGHT_MCP_SERVER_ID)).toBe(true);
    expect(calls[0]).toMatchObject({ input: { action: 'new' } });
    expect(calls[1]).toMatchObject({ input: { url: 'http://127.0.0.1:7600' } });
    expect(calls[3]).toMatchObject({ input: { action: 'close' } });
  });

  it('still closes its tab when the screenshot call fails', async () => {
    const { runtime, calls } = runtimeWith((serverId, tool) => {
      if (tool === 'browser_take_screenshot') throw new Error('boom');
      return [];
    });
    await expect(playwrightDesignScreenshot(runtime)('http://127.0.0.1:7600')).rejects.toThrow('boom');
    expect(calls.at(-1)).toMatchObject({ tool: 'browser_tabs', input: { action: 'close' } });
  });

  it('fails clearly when the Playwright MCP is not running', async () => {
    const { runtime } = runtimeWith(() => null);
    await expect(playwrightDesignScreenshot(runtime)('http://127.0.0.1:7600')).rejects.toThrow(/not running/);
  });

  it('fails clearly when the server answers with no image', async () => {
    const { runtime } = runtimeWith(() => []);
    await expect(playwrightDesignScreenshot(runtime)('http://127.0.0.1:7600')).rejects.toThrow(/no image/);
  });
});
