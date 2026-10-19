import type { AppSettings } from '@kai/contracts';
import type { AgentMcpInstallResult } from './agent-mcp-config';
import { withPlaywrightMcpEndpoint } from './agent-mcp-config';
import type { PlaywrightHost } from './playwright-host';

/**
 * Starts the shared Playwright browser and points KAI and the CLI agents at it.
 *
 * If it cannot start, everything goes back to a server of its own, so a failure here costs the sharing and never the
 * browser: an agent that was told to use a server nobody started would have no browser at all. Everything it touches
 * is passed in, so both outcomes can be tested without a browser or a home folder.
 */
export interface SharedBrowserDeps {
  /** Starts the server, or adopts one that is already running. */
  start(onStopped: (code: number | null) => void): Promise<PlaywrightHost>;
  updateSettings(mutator: (current: AppSettings) => AppSettings): Promise<unknown>;
  /** Makes KAI's own connection to the browser start again against whatever the settings now say. */
  reconnect(): void;
  /** Writes the shared endpoint into every CLI's configuration. */
  installShared(endpoint: string): Promise<AgentMcpInstallResult[]>;
  /** Writes the server each CLI starts for itself back into its configuration. */
  installOwn(): Promise<AgentMcpInstallResult[]>;
  info(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
}

/** Answers the host now in charge of the shared browser, or null when each agent is back to a browser of its own. */
export async function startSharedBrowser(deps: SharedBrowserDeps, onLost: () => void = () => undefined): Promise<PlaywrightHost | null> {
  const pointAt = async (endpoint: string | null): Promise<void> => {
    await deps.updateSettings((current) => withPlaywrightMcpEndpoint(current, endpoint).settings);
    deps.reconnect();
    const results = endpoint ? await deps.installShared(endpoint) : await deps.installOwn();
    for (const result of results) {
      if (result.error) deps.warn(`The Playwright browser entry could not be updated for ${result.agent}`, `${result.configPath}: ${result.error}`);
    }
  };

  try {
    const host = await deps.start((code) => {
      deps.warn('The shared browser server stopped', `exit ${code ?? 'unknown'}. Agents will not have a browser until KAI is restarted.`);
      onLost();
    });
    await pointAt(host.endpoint);
    deps.info(host.adopted ? 'Using the shared browser server that is already running' : 'The shared browser server is running', host.endpoint);
    return host;
  } catch (error) {
    deps.warn('The shared browser server could not start, so each agent keeps its own', error instanceof Error ? error.message : String(error));
    try {
      await pointAt(null);
    } catch (restoreError) {
      deps.warn('The per-agent browser entries could not be restored', restoreError instanceof Error ? restoreError.message : String(restoreError));
    }
    return null;
  }
}
