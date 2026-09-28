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
}

export interface UiCheckPorts {
  /** Starts the project through the preview runtime and resolves the base URL, or null when there is nothing to serve. */
  previewUrl(projectId: string, projectPath: string): Promise<string | null>;
  /** One screenshot through the Playwright MCP, returned as base64 to save. */
  capture(request: { url: string; viewport: UiCheckViewport; theme: UiCheckTheme; card: BoardCard }): Promise<string>;
  /** The DOM facts once, at the route. */
  probe(request: { url: string; card: BoardCard }): Promise<UiDomFacts>;
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
    const facts = await this.ports.probe({ url, card });
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

/** How long the dev server is given to print its URL before the card is failed as unopenable. */
const PREVIEW_TIMEOUT_MS = 60_000;
const PREVIEW_POLL_MS = 500;

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

  return {
    async previewUrl(projectId, projectPath) {
      await runtime.preview.start(projectId, projectPath);
      const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const state = await runtime.preview.status(projectId, projectPath);
        if (state.url) return state.url;
        if (state.status === 'failed') throw new Error(state.message ?? 'The dev server failed to start.');
        await runtime.sleep(PREVIEW_POLL_MS);
      }
      throw new Error('The dev server did not print a local URL in time.');
    },

    async capture({ url, viewport, theme, card }) {
      await mcpCall('browser_navigate', { url });
      await mcpCall('browser_resize', { width: viewport.width, height: 900 });
      await mcpCall('browser_emulate_media', { colorScheme: theme });
      const blocks = await mcpCall('browser_take_screenshot', {
        type: 'png',
        filename: uiShotName(viewport, theme),
        element: card.title,
      }).catch(() => mcpCall('browser_take_screenshot', { type: 'png', filename: uiShotName(viewport, theme) }));
      const data = imageData(blocks);
      if (!data) throw new Error(`The Playwright MCP returned no image for ${card.id} at ${viewport.name}/${theme}.`);
      return data;
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
