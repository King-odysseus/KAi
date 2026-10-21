import {
  ARTIFACT_SPEC_PATHS,
  PLAYWRIGHT_MCP_SERVER_ID,
  UI_CHECK_THEMES,
  UI_CHECK_VIEWPORTS,
  UI_REQUIRED_STATES,
  uiCheckDir,
  uiCheckResultSchema,
  type BoardCard,
  type PreviewState,
  type UiCheckOutcome,
  type UiCheckResult,
  type UiCheckTheme,
  type UiCheckViewport,
} from '@kai/contracts';
import { waitForPreviewUrl } from './preview-runtime';

/**
 * The visual check. A component or page card is not finished because the code compiled: it is finished when a
 * screenshot at phone and desktop width, in light and dark, still looks right, the tokens match the design, the
 * required states exist, and the whole thing can be reached with the keyboard.
 *
 * The browser work goes through the Playwright MCP that `agent-mcp-config.ts` already installs, so this adds no
 * service and no key. Everything here is behind ports, so the rules can be tested without a browser.
 */

/** What the live page reported back. One probe answers every check that is not a picture. */
export interface UiDomFacts {
  route: string;
  /** The states the DOM can currently show, from `data-state` attributes or their equivalent. */
  states: string[];
  /** The design tokens as the page actually computed them, keyed by token name. */
  tokens: Record<string, string>;
  phoneScrollWidth: number;
  phoneClientWidth: number;
  /** How many elements the keyboard reaches by tabbing through the screen. */
  tabbables: number;
  /** Where following the card's flow landed, for `page` and `flow` cards. */
  landedRoute: string;
  /** What the page did at the phone and the wide size. Absent when the layout was not measured. */
  layouts?: { phone?: UiLayoutFacts; wide?: UiLayoutFacts };
}

/**
 * One size's worth of layout facts, measured with the browser actually resized to that size. The phone's sideways
 * scroll used to be read after the last screenshot had left the browser at desktop width, so it never measured a
 * phone at all.
 */
export interface UiLayoutFacts {
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  clientWidth: number;
  /** Whether the page has a viewport meta of `width=device-width`, without which a phone shows a shrunken desktop page. */
  hasViewportMeta: boolean;
  /** The left and right edges of the text, images and controls on the page, or null when it has none. */
  contentLeft: number | null;
  contentRight: number | null;
  /**
   * The top bar of the page (a header, banner or navigation along the top): its edges, and whether a bar behind it
   * (an ancestor with a background or border that spans the window) makes it read as full width. Null without a top bar.
   */
  headerLeft: number | null;
  headerRight: number | null;
  headerBacked: boolean;
  /** Whether something on the page scrolls vertically. */
  scrollable: boolean;
  /** How many navigation landmarks with two or more links the page has, shown or not. */
  navCount: number;
  navVisibleAtTop: boolean;
  navVisibleAtBottom: boolean;
  /** Where a fixed or sticky bar along the bottom starts, when the page has one. */
  fixedNavTop: number | null;
  /** The lowest edge of the page's own content once it is scrolled as far as it goes. */
  contentBottomAtScrollEnd: number | null;
}

export interface UiCheckPorts {
  /** Starts the project through the preview runtime and resolves the base URL, or null when there is nothing to serve. */
  previewUrl(projectId: string, projectPath: string): Promise<string | null>;
  /** One screenshot through the Playwright MCP, returned as base64 to save. */
  capture(request: { url: string; viewport: UiCheckViewport; theme: UiCheckTheme; card: BoardCard }): Promise<string>;
  /** The DOM facts once, at the route. */
  probe(request: { url: string; card: BoardCard }): Promise<UiDomFacts>;
  /**
   * The layout at one size, with the browser resized to it first. Optional so a port written before it existed keeps
   * working; without it the layout checks are simply not made.
   */
  layout?(request: { url: string; viewport: UiCheckViewport }): Promise<UiLayoutFacts | null>;
  /** The design tokens, or null when the design layer has not produced them yet. */
  tokens(projectPath: string): Promise<Record<string, string> | null>;
  /** Writes one screenshot under the project and returns its project-relative path. */
  writeShot(projectPath: string, relativePath: string, base64: string): Promise<string>;
  now(): string;
}

/** The screenshot request for one card: every width, every theme, so no combination is judged by eye alone. */
export function uiCheckShots(card: BoardCard): Array<{ viewport: UiCheckViewport; theme: UiCheckTheme }> {
  return UI_CHECK_VIEWPORTS.flatMap((viewport) => UI_CHECK_THEMES.map((theme) => ({ viewport, theme })));
}

/** The filename one shot is saved under. Readable, and stable enough to diff between runs. */
export function uiShotName(viewport: { name: string }, theme: string): string {
  return `${viewport.name}-${theme}.png`;
}

/**
 * The rules, as a pure function so they can be argued about and tested on their own. A card passes when every
 * outcome passes; the first failure is the one the agent is handed back.
 */
export function evaluateUiChecks(card: BoardCard, facts: UiDomFacts, tokens: Record<string, string> | null, route: string): UiCheckOutcome[] {
  const outcomes: UiCheckOutcome[] = [];

  const missingStates = UI_REQUIRED_STATES.filter((state) => !facts.states.includes(state));
  outcomes.push({
    id: 'states',
    label: 'Shows empty, loading, error and disabled states',
    passed: missingStates.length === 0,
    detail: missingStates.length === 0 ? '' : `Missing: ${missingStates.join(', ')}.`,
  });

  const tokenNames = tokens ? Object.keys(tokens) : [];
  const mismatched = tokenNames.filter((name) => facts.tokens[name] !== tokens![name]);
  outcomes.push({
    id: 'tokens',
    label: 'Colours and spacing match the design tokens',
    passed: mismatched.length === 0,
    detail: mismatched.length === 0
      ? ''
      : mismatched.map((name) => `${name}: expected ${tokens![name]}, found ${facts.tokens[name] ?? 'nothing'}`).join('; '),
  });

  const sideways = facts.phoneScrollWidth > facts.phoneClientWidth + 1;
  outcomes.push({
    id: 'phone-no-scroll',
    label: 'No sideways scroll at phone width',
    passed: !sideways,
    detail: sideways ? `The page is ${facts.phoneScrollWidth}px wide in a ${facts.phoneClientWidth}px viewport.` : '',
  });

  outcomes.push({
    id: 'keyboard',
    label: 'Reachable with the keyboard',
    passed: facts.tabbables > 0,
    detail: facts.tabbables > 0 ? '' : 'Tabbing through the screen reached no focusable element.',
  });

  if (card.kind === 'page' || card.kind === 'flow') {
    const followed = facts.landedRoute === route;
    outcomes.push({
      id: 'flow',
      label: 'The route follows its flow',
      passed: followed,
      detail: followed ? '' : `Following the flow landed on ${facts.landedRoute || 'nowhere'}, not ${route}.`,
    });
  }

  outcomes.push(...evaluateLayoutChecks(facts.layouts));
  return outcomes;
}

/**
 * The layout rules, one pure function so each can be argued about on its own numbers. They only run for a size that
 * was measured, so a page that could not be measured is not failed for it.
 */
export function evaluateLayoutChecks(layouts: UiDomFacts['layouts']): UiCheckOutcome[] {
  const outcomes: UiCheckOutcome[] = [];
  const phone = layouts?.phone;
  const wide = layouts?.wide;

  if (phone) {
    outcomes.push({
      id: 'viewport-meta',
      label: 'Declares the viewport for phones',
      passed: phone.hasViewportMeta,
      detail: phone.hasViewportMeta ? '' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page, or a phone shows a shrunken desktop layout.',
    });

    // Only a page that has navigation can lose it. A sign-in screen with none is not failed for that.
    if (phone.navCount > 0) {
      outcomes.push({
        id: 'phone-nav',
        label: 'Navigation stays visible on a phone',
        passed: phone.navVisibleAtTop && phone.navVisibleAtBottom,
        detail: phone.navVisibleAtTop && phone.navVisibleAtBottom
          ? ''
          : !phone.navVisibleAtTop
            ? 'The navigation is hidden at phone width, behind a menu button or removed. Show a bottom tab bar of 3 to 5 items instead.'
            : 'The navigation scrolls out of sight. Make the bar position: fixed or sticky at the bottom, and let the content scroll behind it.',
      });
    }

    if (phone.fixedNavTop !== null && phone.contentBottomAtScrollEnd !== null) {
      const covered = phone.contentBottomAtScrollEnd > phone.fixedNavTop + 1;
      outcomes.push({
        id: 'phone-content-clear',
        label: 'The last item is not covered by the bottom bar',
        passed: !covered,
        detail: covered
          ? `At the end of the scroll the content reaches ${Math.round(phone.contentBottomAtScrollEnd)}px but the bar starts at ${Math.round(phone.fixedNavTop)}px. Give the scrolling area padding-bottom of at least the bar height plus env(safe-area-inset-bottom).`
          : '',
      });
    }
  }

  if (wide && wide.headerLeft !== null && wide.headerRight !== null) {
    const leftGap = wide.headerLeft;
    const rightGap = wide.innerWidth - wide.headerRight;
    const short = !wide.headerBacked && (leftGap > wide.innerWidth * 0.03 || rightGap > wide.innerWidth * 0.03);
    outcomes.push({
      id: 'wide-header-spans',
      label: `The top bar spans a ${wide.innerWidth}px screen`,
      passed: !short,
      detail: short
        ? `At ${wide.innerWidth}px wide the top bar runs from ${Math.round(wide.headerLeft)}px to ${Math.round(wide.headerRight)}px, leaving ${Math.round(leftGap)}px on the left and ${Math.round(rightGap)}px on the right bare. Make the header full width (width: 100%, no max-width on the bar itself) and put any max-width on the content inside it.`
        : '',
    });
  }

  if (wide && wide.contentLeft !== null && wide.contentRight !== null) {
    const rightGap = wide.innerWidth - wide.contentRight;
    const leftGap = wide.contentLeft;
    // A centred column has equal gaps and passes. A column against one edge leaves a strip on the other, and that
    // strip is what a large screen showed as unused space.
    const lopsided = rightGap > wide.innerWidth * 0.3 && rightGap > leftGap * 2 + 48;
    outcomes.push({
      id: 'wide-fills',
      label: `Uses the width of a ${wide.innerWidth}px screen`,
      passed: !lopsided,
      detail: lopsided
        ? `At ${wide.innerWidth}px wide the content ends at ${Math.round(wide.contentRight)}px, leaving ${Math.round(rightGap)}px empty on the right and ${Math.round(leftGap)}px on the left. Centre it in a max-width container, or let the layout grow into columns.`
        : '',
    });
  }

  return outcomes;
}

export class DesktopUiCheck {
  constructor(private readonly ports: UiCheckPorts) {}

  /**
   * Checks one card end to end: starts the project, captures every width and theme, probes the DOM, judges the
   * result, and saves the screenshots with the card. It never moves the card — `board.ts` owns that.
   */
  async run(projectId: string, projectPath: string, card: BoardCard, route: string): Promise<UiCheckResult> {
    const at = this.ports.now();
    const base = await this.ports.previewUrl(projectId, projectPath);
    if (!base) throw new Error(`No dev server URL was found for ${card.id}, so the screen could not be opened.`);
    const url = joinUrl(base, route);
    const folder = uiCheckDir(card.id, at);
    const screenshots: string[] = [];
    for (const shot of uiCheckShots(card)) {
      const base64 = await this.ports.capture({ url, viewport: shot.viewport, theme: shot.theme, card });
      screenshots.push(await this.ports.writeShot(projectPath, `${folder}/${uiShotName(shot.viewport, shot.theme)}`, base64));
    }
    const probed = await this.ports.probe({ url, card });
    const facts = await addLayouts(this.ports, probed, url);
    const tokens = await this.ports.tokens(projectPath);
    const outcomes = evaluateUiChecks(card, facts, tokens, route);
    return uiCheckResultSchema.parse({
      cardId: card.id,
      at,
      passed: outcomes.every((outcome) => outcome.passed),
      route,
      outcomes,
      screenshots,
    });
  }
}

/**
 * Adds the per-size layout facts to what the DOM probe read. The phone's sideways scroll is taken from the phone
 * measurement when there is one, since the probe itself runs at whatever size the last screenshot left behind.
 */
async function addLayouts(ports: UiCheckPorts, facts: UiDomFacts, url: string): Promise<UiDomFacts> {
  if (!ports.layout) return facts;
  const sizeNamed = (name: string): UiCheckViewport | undefined => UI_CHECK_VIEWPORTS.find((viewport) => viewport.name === name);
  const phoneSize = sizeNamed('phone');
  const wideSize = sizeNamed('wide');
  const phone = phoneSize ? await ports.layout({ url, viewport: phoneSize }) : null;
  const wide = wideSize ? await ports.layout({ url, viewport: wideSize }) : null;
  return {
    ...facts,
    ...(phone ? { phoneScrollWidth: phone.scrollWidth, phoneClientWidth: phone.clientWidth } : {}),
    layouts: { ...(phone ? { phone } : {}), ...(wide ? { wide } : {}) },
  };
}

/** Appends a card's route to the dev server's base URL without doubling or dropping the slash. */
export function joinUrl(base: string, route: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedRoute = route.startsWith('/') ? route : `/${route}`;
  return route ? `${trimmedBase}${trimmedRoute}` : trimmedBase;
}

/** The one line a failed card is handed back with, so the agent knows what to repair rather than that it failed. */
export function failureSummary(result: UiCheckResult): string {
  const failed = result.outcomes.filter((outcome) => !outcome.passed);
  if (failed.length === 0) return '';
  return failed.map((outcome) => `${outcome.label}${outcome.detail ? ` — ${outcome.detail}` : ''}`).join('\n');
}

// --- Wiring the ports to the real browser -----------------------------------------------------------------

/**
 * The DOM probe, as a string the Playwright MCP evaluates in the page. It reads only what the checks need, and it
 * never throws: a page that answers nothing is a failing check, not a crash.
 */
export const UI_PROBE_SCRIPT = `(() => {
  const stateNodes = [...document.querySelectorAll('[data-state]')].map((node) => node.getAttribute('data-state'));
  const declared = (window.__KAI_STATES__ && Array.isArray(window.__KAI_STATES__)) ? window.__KAI_STATES__ : [];
  const tokens = {};
  const styles = getComputedStyle(document.documentElement);
  for (const name of (window.__KAI_TOKENS__ || [])) tokens[name] = styles.getPropertyValue(name).trim();
  const tabbables = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])').length;
  return {
    route: location.pathname,
    states: [...new Set([...stateNodes, ...declared])].filter(Boolean),
    tokens,
    phoneScrollWidth: document.documentElement.scrollWidth,
    phoneClientWidth: document.documentElement.clientWidth,
    tabbables,
    landedRoute: location.pathname,
  };
})()`;

/**
 * The layout probe, run after the browser has been resized. It measures what the checks need: whether the page fits
 * its width, where its content starts and ends, and whether the navigation survives scrolling to the bottom. It
 * scrolls the page and puts it back, and it never throws: a page it cannot read is reported as unmeasured.
 */
export const UI_LAYOUT_SCRIPT = String.raw`(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    await frame();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const root = document.documentElement;
    const shown = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    };
    const inView = (rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < vw && rect.bottom > 0 && rect.top < vh;
    // The nearest fixed or sticky element at or above this one. Remembered per element, because every leaf asks.
    const pinMemo = new Map();
    const pinned = (el) => {
      if (!el || el === document.body || el === root) return null;
      if (pinMemo.has(el)) return pinMemo.get(el);
      const position = getComputedStyle(el).position;
      const found = position === 'fixed' || position === 'sticky' ? el : pinned(el.parentElement);
      pinMemo.set(el, found);
      return found;
    };
    const isChrome = (el) => Boolean(pinned(el)) || Boolean(el.closest('nav, [role="navigation"], [data-nav]'));
    const collect = () => {
      const found = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName) || !shown(parent)) continue;
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) found.push({ el: parent, rect });
      }
      for (const el of document.querySelectorAll('img, svg, canvas, video, input, select, textarea, button')) {
        if (shown(el)) found.push({ el, rect: el.getBoundingClientRect() });
      }
      return found;
    };
    const navs = [...document.querySelectorAll('nav, [role="navigation"], [data-nav]')]
      .filter((el) => el.querySelectorAll('a[href], button, [role="link"], [role="tab"], [role="menuitem"]').length >= 2);
    const navVisibleNow = () => navs.some((el) => shown(el) && inView(el.getBoundingClientRect()));

    // Where the page's own content sits, measured by the boxes that hold it rather than by the width of the text:
    // short lines in a centred column would otherwise read as content hugging the left. The navigation and anything
    // pinned are left out, since a bar that spans the screen says nothing about where the content is. A wrapper as
    // wide as the window is skipped for the same reason. Anything sticking out past the window is the sideways-scroll
    // check's business.
    let contentLeft = null;
    let contentRight = null;
    const include = (left, right) => {
      if (left < -2 || right > vw + 2) return;
      contentLeft = contentLeft === null ? left : Math.min(contentLeft, left);
      contentRight = contentRight === null ? right : Math.max(contentRight, right);
    };
    for (const { el, rect } of collect().slice(0, 2500)) {
      if (isChrome(el)) continue;
      include(rect.left, rect.right);
      for (let node = el.parentElement; node && node !== document.body && node !== root; node = node.parentElement) {
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.width >= vw * 0.98) continue;
        include(box.left, box.right);
      }
    }

    // The top bar: the widest header-like box that sits against the top of the window. It counts as full width when
    // it spans the window itself, or when something spanning the window sits behind it with a colour or a border.
    let headerLeft = null;
    let headerRight = null;
    let headerBacked = false;
    const bars = [...document.querySelectorAll('header, [role="banner"], nav, [data-nav], body > * > *')].filter((el) => {
      if (!shown(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.top <= 4 && rect.top >= -4 && rect.height >= 24 && rect.height <= 220 && rect.width >= vw * 0.3;
    });
    bars.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const bar = bars[0] || null;
    if (bar) {
      const rect = bar.getBoundingClientRect();
      headerLeft = rect.left;
      headerRight = rect.right;
      const paints = (el) => {
        const style = getComputedStyle(el);
        const bg = style.backgroundColor;
        const clear = bg === 'transparent' || /rgba\(.*,\s*0\)$/.test(bg);
        return !clear || style.backgroundImage !== 'none' || parseFloat(style.borderBottomWidth) > 0 || style.boxShadow !== 'none';
      };
      for (let node = bar; node && node !== root; node = node.parentElement) {
        const box = node.getBoundingClientRect();
        if (box.width >= vw * 0.97 && box.height <= 260 && paints(node)) { headerBacked = true; break; }
      }
    }

    const scrolling = [document.scrollingElement || root, ...[...document.querySelectorAll('body *')].slice(0, 3000)].filter((el) => {
      if (el !== root && el !== document.scrollingElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
      }
      return el.scrollHeight > el.clientHeight + 8 && el.clientHeight > vh * 0.4;
    });
    scrolling.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
    const scroller = scrolling[0] || null;

    const navVisibleAtTop = navVisibleNow();
    let navVisibleAtBottom = navVisibleAtTop;
    let fixedNavTop = null;
    let contentBottomAtScrollEnd = null;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await frame();
      navVisibleAtBottom = navVisibleNow();
      for (const el of navs) {
        if (!shown(el) || !pinned(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top > vh * 0.5 && inView(rect)) fixedNavTop = fixedNavTop === null ? rect.top : Math.min(fixedNavTop, rect.top);
      }
      for (const { el, rect } of collect()) {
        if (isChrome(el)) continue;
        if (rect.bottom <= 0 || rect.top >= vh) continue;
        contentBottomAtScrollEnd = contentBottomAtScrollEnd === null ? rect.bottom : Math.max(contentBottomAtScrollEnd, rect.bottom);
      }
      scroller.scrollTop = 0;
      window.scrollTo(0, 0);
    }

    const meta = document.querySelector('meta[name="viewport"]');
    return {
      measured: true,
      innerWidth: vw,
      innerHeight: vh,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      hasViewportMeta: Boolean(meta) && /width\s*=\s*device-width/i.test(meta.getAttribute('content') || ''),
      contentLeft,
      contentRight,
      headerLeft,
      headerRight,
      headerBacked,
      scrollable: Boolean(scroller),
      navCount: navs.length,
      navVisibleAtTop,
      navVisibleAtBottom,
      fixedNavTop,
      contentBottomAtScrollEnd,
    };
  } catch (error) {
    return { measured: false, error: String((error && error.message) || error) };
  }
})()`;

/** The pieces the real ports need, so this file does not import the main process and stays testable. */
export interface UiCheckRuntime {
  mcp: { callServerTool(serverId: string, toolName: string, input: Record<string, unknown>): Promise<unknown[] | null> };
  preview: {
    start(projectId: string, projectPath: string, command?: string): Promise<PreviewState>;
    status(projectId: string, projectPath: string): Promise<PreviewState>;
  };
  /** Reads a file inside the project, or null when it is not there. */
  readFile(projectPath: string, relativePath: string): Promise<string | null>;
  /** Writes bytes inside the project, creating folders as needed. */
  writeFile(projectPath: string, relativePath: string, base64: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** The text of an MCP tool result: every text block, joined. */
function textOf(blocks: unknown[] | null): string {
  return (blocks ?? []).flatMap((block) => {
    const record = block as Record<string, unknown> | null;
    return record && record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

/** The image block's base64 payload, however the MCP server wrapped it. */
function imageData(blocks: unknown[] | null): string | null {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'image' && typeof record.data === 'string') return record.data;
  }
  return null;
}

/** Wires `UiCheckPorts` to the preview runtime and the Playwright MCP KAI already installs for its agents. */
export function playwrightUiCheckPorts(runtime: UiCheckRuntime, now: () => string): UiCheckPorts {
  const mcpCall = async (tool: string, input: Record<string, unknown>): Promise<unknown[] | null> => {
    const blocks = await runtime.mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, tool, input);
    if (blocks === null) throw new Error('The Playwright MCP server is not running. Start it under Settings, MCP servers, then check the card again.');
    return blocks;
  };

  /**
   * Runs `work` in a tab of its own, and closes the tab afterwards.
   *
   * `browser_resize` fixes the page at the size it is given, and the page then ignores its window: maximising the
   * browser changes nothing in it. A check at 390px wide used to leave the tab someone was looking at pinned at a phone
   * width, in the corner of a large window. The pin is on the tab, so a tab opened for the check and closed after takes
   * the pin with it — and the colour-scheme override that goes with it — and the tab anyone else is using is never
   * touched. If a tab cannot be opened the check carries on in the current one, as it always did.
   */
  const inOwnTab = async <T>(work: () => Promise<T>): Promise<T> => {
    const opened = await mcpCall('browser_tabs', { action: 'new' }).then(() => true, () => false);
    try {
      return await work();
    } finally {
      if (opened) await mcpCall('browser_tabs', { action: 'close' }).catch(() => undefined);
    }
  };
  return {
    async previewUrl(projectId, projectPath) {
      return waitForPreviewUrl(runtime.preview, projectId, projectPath, { sleep: runtime.sleep });
    },

    async capture({ url, viewport, theme, card }) {
      return inOwnTab(async () => {
        await mcpCall('browser_navigate', { url });
        await mcpCall('browser_resize', { width: viewport.width, height: viewport.height });
        await mcpCall('browser_emulate_media', { colorScheme: theme });
        // The whole page, not the first screen of it. A long page used to be saved as its top 900px, so the agent and
        // the reviewer both saw a page that ended where the window did. The screenshot of one element cannot be
        // combined with a full page, so it is the second choice rather than the first.
        const filename = uiShotName(viewport, theme);
        const blocks = await mcpCall('browser_take_screenshot', { type: 'png', filename, fullPage: true })
          .catch(() => mcpCall('browser_take_screenshot', { type: 'png', filename }));
        const data = imageData(blocks);
        if (!data) throw new Error(`The Playwright MCP returned no image for ${card.id} at ${viewport.name}/${theme}.`);
        return data;
      });
    },

    async layout({ url, viewport }) {
      return inOwnTab(async () => {
        await mcpCall('browser_navigate', { url });
        await mcpCall('browser_resize', { width: viewport.width, height: viewport.height });
        const blocks = await mcpCall('browser_evaluate', { function: UI_LAYOUT_SCRIPT });
        return parseLayout(textOf(blocks));
      });
    },

    async probe({ url }) {
      await mcpCall('browser_navigate', { url });
      const blocks = await mcpCall('browser_evaluate', { function: UI_PROBE_SCRIPT });
      const text = (blocks ?? []).flatMap((block) => {
        const record = block as Record<string, unknown> | null;
        return record && record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
      }).join('');
      return parseProbe(text);
    },

    async tokens(projectPath) {
      const raw = await runtime.readFile(projectPath, ARTIFACT_SPEC_PATHS.tokens);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') flat[name] = value;
        }
        return flat;
      } catch {
        return null;
      }
    },

    async writeShot(projectPath, relativePath, base64) {
      await runtime.writeFile(projectPath, relativePath, base64);
      return relativePath;
    },

    now,
  };
}

/** Reads the layout probe's JSON back out of the MCP's text block, or null when the page could not be measured. */
export function parseLayout(text: string): UiLayoutFacts | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.measured !== true) return null;
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const edge = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    innerWidth: number(parsed.innerWidth),
    innerHeight: number(parsed.innerHeight),
    scrollWidth: number(parsed.scrollWidth),
    clientWidth: number(parsed.clientWidth),
    hasViewportMeta: parsed.hasViewportMeta === true,
    contentLeft: edge(parsed.contentLeft),
    contentRight: edge(parsed.contentRight),
    headerLeft: edge(parsed.headerLeft),
    headerRight: edge(parsed.headerRight),
    headerBacked: parsed.headerBacked === true,
    scrollable: parsed.scrollable === true,
    navCount: number(parsed.navCount),
    navVisibleAtTop: parsed.navVisibleAtTop === true,
    navVisibleAtBottom: parsed.navVisibleAtBottom === true,
    fixedNavTop: edge(parsed.fixedNavTop),
    contentBottomAtScrollEnd: edge(parsed.contentBottomAtScrollEnd),
  };
}

/** Reads the probe's JSON back out of the MCP's text block, tolerating the wrapper a server may add around it. */
export function parseProbe(text: string): UiDomFacts {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) as Partial<UiDomFacts> : {};
  return {
    route: typeof parsed.route === 'string' ? parsed.route : '',
    states: Array.isArray(parsed.states) ? parsed.states.filter((state): state is string => typeof state === 'string') : [],
    tokens: parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens) ? parsed.tokens as Record<string, string> : {},
    phoneScrollWidth: typeof parsed.phoneScrollWidth === 'number' ? parsed.phoneScrollWidth : 0,
    phoneClientWidth: typeof parsed.phoneClientWidth === 'number' ? parsed.phoneClientWidth : 0,
    tabbables: typeof parsed.tabbables === 'number' ? parsed.tabbables : 0,
    landedRoute: typeof parsed.landedRoute === 'string' ? parsed.landedRoute : '',
  };
}
