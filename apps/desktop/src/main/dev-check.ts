import { PLAYWRIGHT_MCP_SERVER_ID, type DevCheckResult, type DevRouteResult, type PreviewState } from '@kai/contracts';
import { waitForPreviewUrl } from './preview-runtime';
import { joinUrl } from './ui-check';

/**
 * The dev proof: does the thing actually run?
 *
 * Every other check Autopilot runs answers "does the code hold up" — the test command, the typecheck, the screen
 * check on a card. None of them answers the question the person is really asking when they walk away and come back:
 * is there an app on dev that I can open. A project can pass all of them and still not start, and the run would have
 * reported itself finished.
 *
 * So this starts the project on its dev server and loads the pages, and says whether they rendered. It never touches
 * anything but the local server: there is no build step, no commit and no deploy anywhere in Autopilot, and this is
 * where that is true rather than merely intended.
 *
 * The rules are pure and the ports are small, the same as `ui-check.ts`, so the judging can be tested without a
 * browser or a server.
 */

/** The page's own account of itself, as the browser probe returns it. */
export interface DevProbe {
  /** The error overlay a dev server shows instead of the page, capped; empty when there is none. */
  errorOverlay: string;
  /** How much text the page actually put on screen. */
  textLength: number;
  /** How many children the app's mount point has; the fallback for a page that draws without words. */
  appChildren: number;
}

export interface DevCheckPorts {
  /** Starts the project on its dev server and resolves the URL it printed. */
  previewUrl(projectId: string, projectPath: string, signal?: AbortSignal): Promise<string>;
  /** Opens one URL and reports what the page says about itself. */
  probe(request: { url: string; route: string }): Promise<DevProbe>;
}

/**
 * Whether one loaded page counts as rendered.
 *
 * A dev server's error overlay is the loud failure and is checked first: it replaces the page with a wall of text, so
 * counting words alone would call a crashed app healthy. A page with no overlay still has to have drawn something.
 */
export function judgeDevProbe(probe: DevProbe): { ok: boolean; problem: string } {
  if (probe.errorOverlay.trim()) {
    return { ok: false, problem: `The dev server is showing an error instead of the page: ${probe.errorOverlay.trim().slice(0, 300)}` };
  }
  if (probe.textLength === 0 && probe.appChildren === 0) {
    return { ok: false, problem: 'The page loaded but rendered nothing.' };
  }
  return { ok: true, problem: '' };
}

/**
 * The one line the run reports, from the routes that were loaded.
 *
 * Deliberately not a count. "3 of 4 routes failed" is a number to decode; naming the first bad route and why is the
 * thing a person can act on, and the rest are on the result for whoever wants them.
 */
export function summarizeDevCheck(url: string | null, routes: readonly DevRouteResult[]): { passed: boolean; summary: string } {
  const failed = routes.filter((route) => !route.ok);
  if (failed.length === 0) {
    return {
      passed: true,
      summary: url ? `The app runs on dev at ${url}${routes.length > 0 ? ` (${routes.length} page${routes.length === 1 ? '' : 's'} loaded)` : ''}.` : 'The app started on dev.',
    };
  }
  const first = failed[0]!;
  const rest = failed.length > 1 ? ` ${failed.length - 1} other page${failed.length === 2 ? '' : 's'} failed too.` : '';
  return { passed: false, summary: `The app does not run cleanly on dev: ${first.route} — ${first.problem}${rest}` };
}

export class DesktopDevCheck {
  constructor(private readonly ports: DevCheckPorts) {}

  /**
   * Starts the project and loads each route. A server that will not start is a failed check with its own reason, not
   * an exception: the run finished its cards, and this is a fact about the result rather than a fault in the loop.
   */
  async run(projectId: string, projectPath: string, routes: readonly string[], signal?: AbortSignal): Promise<DevCheckResult> {
    let url: string;
    try {
      url = await this.ports.previewUrl(projectId, projectPath, signal);
    } catch (error) {
      return {
        passed: false,
        summary: `The app would not start on dev: ${error instanceof Error ? error.message : String(error)}`,
        url: null,
        routes: [],
      };
    }

    const results: DevRouteResult[] = [];
    for (const route of routes) {
      if (signal?.aborted) break;
      try {
        const probe = await this.ports.probe({ url: joinUrl(url, route), route });
        results.push({ route, ...judgeDevProbe(probe) });
      } catch (error) {
        results.push({ route, ok: false, problem: error instanceof Error ? error.message : String(error) });
      }
    }

    const { passed, summary } = summarizeDevCheck(url, results);
    return { passed, summary, url, routes: results };
  }
}

// --- Wiring the ports to the real browser ---------------------------------------------------------------------

/** What the browser is asked about a page. It reads only what the judgement needs, and it never throws. */
export const DEV_PROBE_SCRIPT = `(() => {
  const overlay = document.querySelector('vite-error-overlay, nextjs-portal, [data-nextjs-dialog], #webpack-dev-server-client-overlay');
  const overlayText = overlay ? (overlay.shadowRoot ? overlay.shadowRoot.textContent : overlay.textContent) || 'A dev-server error overlay is showing.' : '';
  const body = document.body;
  const app = document.querySelector('#root, #app, #__next, main, [role=main]');
  return {
    errorOverlay: String(overlayText).replace(/\\s+/g, ' ').trim().slice(0, 300),
    textLength: body ? (body.innerText || '').trim().length : 0,
    appChildren: app ? app.children.length : 0,
  };
})()`;

/** The pieces the real ports need, so this file does not import the main process and stays testable. */
export interface DevCheckRuntime {
  mcp: { callServerTool(serverId: string, toolName: string, input: Record<string, unknown>): Promise<unknown[] | null> };
  preview: {
    start(projectId: string, projectPath: string, command?: string): Promise<PreviewState>;
    status(projectId: string, projectPath: string): Promise<PreviewState>;
  };
  sleep(ms: number): Promise<void>;
}

/** Reads the probe's JSON back out of the MCP's text block, tolerating the wrapper a server may add around it. */
export function parseDevProbe(text: string): DevProbe {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) as Partial<DevProbe> : {};
  return {
    errorOverlay: typeof parsed.errorOverlay === 'string' ? parsed.errorOverlay : '',
    textLength: typeof parsed.textLength === 'number' ? parsed.textLength : 0,
    appChildren: typeof parsed.appChildren === 'number' ? parsed.appChildren : 0,
  };
}

function textOf(blocks: unknown[] | null): string {
  return (blocks ?? []).flatMap((block) => {
    const record = block as Record<string, unknown> | null;
    return record && record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

/**
 * Wires `DevCheckPorts` to the preview runtime and the Playwright MCP KAI already installs for its agents.
 *
 * No `now` port, unlike the screen check: that one stamps and saves a folder of screenshots, and this one only
 * answers a question. Nothing here writes anything.
 */
export function playwrightDevCheckPorts(runtime: DevCheckRuntime): DevCheckPorts {
  return {
    previewUrl: (projectId, projectPath, signal) => waitForPreviewUrl(runtime.preview, projectId, projectPath, { sleep: runtime.sleep, signal }),

    async probe({ url }) {
      const blocks = await runtime.mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, 'browser_navigate', { url });
      if (blocks === null) throw new Error('The Playwright MCP server is not running. Start it under Settings, MCP servers, then run Autopilot again.');
      const evaluated = await runtime.mcp.callServerTool(PLAYWRIGHT_MCP_SERVER_ID, 'browser_evaluate', { function: DEV_PROBE_SCRIPT });
      if (evaluated === null) throw new Error('The Playwright MCP server is not running. Start it under Settings, MCP servers, then run Autopilot again.');
      return parseDevProbe(textOf(evaluated));
    },
  };
}
