/**
 * Makes the shared browser's real window follow the size the page is set to.
 *
 * `browser_resize` in `@playwright/mcp` only sets the page's viewport. The page is then fixed at that size and the
 * Chrome window around it stays where it was, so a maximized window showed a 1280px page in its left corner with a
 * blank strip beside it, and a phone check never looked like a phone. The server has no option for this, so KAI loads
 * a small module into it (`node --require`) that wraps two of its tools:
 *
 * - `browser_resize` still pins the viewport, then sizes the window to fit it.
 * - `browser_tabs` sizes the window to whichever tab is now in front. A tab nobody resized puts the window back the way
 *   it was, so closing a check tab returns the maximized window, and selecting a pinned tab brings back its size.
 *
 * Chrome will not make a window narrower than about 500px, so a 390px phone page sits in a window a little wider than
 * itself. That is a small margin, not the empty half-screen this replaces.
 *
 * Written out as a file at launch, because the server is a separate Node process and cannot read inside KAI's asar.
 * If a future server version moves its tools, the module finds nothing to wrap and does nothing: the browser keeps
 * working exactly as it did without it.
 */
export const PLAYWRIGHT_WINDOW_SYNC_SCRIPT = String.raw`'use strict';
const path = require('node:path');

(function install() {
  const entry = process.argv[1] || '';
  // npx itself runs under the same NODE_OPTIONS; only the Playwright MCP server is patched.
  if (!/[\\/]@playwright[\\/]mcp[\\/](cli|index)\.js$/.test(entry)) return;
  let core;
  try {
    core = require(require.resolve('playwright-core/lib/coreBundle', { paths: [path.dirname(entry)] }));
  } catch {
    return;
  }
  const tools = (core && core.tools && core.tools.browserTools) || [];
  const named = (name) => tools.find((tool) => tool && tool.schema && tool.schema.name === name);
  const resize = named('browser_resize');
  const tabs = named('browser_tabs');
  if (!resize || !tabs) return;

  // The window as it was before anything resized it, put back when no resized tab is in front.
  let restore = null;
  // The space the window's own frame takes, so the page inside it gets the width that was asked for.
  let frame = { width: 16, height: 88 };

  async function windowOf(page) {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    return { cdp, windowId };
  }

  async function measureFrame(page) {
    if (page.viewportSize() !== null) return;
    const size = await page.evaluate(() => ({ outer: window.outerWidth, inner: window.innerWidth, outerH: window.outerHeight, innerH: window.innerHeight }));
    // A maximized window on Windows has no side border; a normal one does.
    frame = { width: Math.max(16, size.outer - size.inner), height: Math.max(60, size.outerH - size.innerH) };
  }

  async function sync(page) {
    const { cdp, windowId } = await windowOf(page);
    try {
      const viewport = page.viewportSize();
      if (viewport === null) {
        if (!restore) return;
        const saved = restore;
        restore = null;
        if (saved.windowState && saved.windowState !== 'normal') {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: saved.windowState } });
        } else {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: saved.left, top: saved.top, width: saved.width, height: saved.height } });
        }
        return;
      }
      const current = (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;
      if (!restore) restore = current;
      if (current.windowState && current.windowState !== 'normal') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: Math.round(viewport.width + frame.width), height: Math.round(viewport.height + frame.height) },
      });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  const resizeHandle = resize.handle;
  resize.handle = async (context, params, response, signal) => {
    try {
      await measureFrame((await context.ensureTab()).page);
    } catch {
      // The default frame size is close enough.
    }
    const result = await resizeHandle(context, params, response, signal);
    try {
      await sync((await context.ensureTab()).page);
    } catch {
      // The page is resized either way; only the window is left as it was.
    }
    return result;
  };

  const tabsHandle = tabs.handle;
  tabs.handle = async (context, params, response, signal) => {
    const result = await tabsHandle(context, params, response, signal);
    try {
      const tab = context.currentTab();
      if (tab) await sync(tab.page);
    } catch {
      // The tab change stands; only the window is left as it was.
    }
    return result;
  };
})();
`;

/** Adds the window-sync module to the server's environment, keeping any NODE_OPTIONS the person already has. */
export function withWindowSync(scriptPath: string, existing: string | undefined): string {
  const require = `--require "${scriptPath.replace(/\\/g, '/')}"`;
  return existing?.trim() ? `${existing.trim()} ${require}` : require;
}
