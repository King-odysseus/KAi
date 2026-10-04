import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { AppSettings, ProxyAgentId, ProxyAgentRoute, ProxyRoutingAction, ProxyRoutingResult } from '@kai/contracts';
import type { EngineInstallation } from '@kai/integrations';

interface EngineRoutingAdapter {
  readonly agentId: ProxyAgentId;
  configPath(): string;
  applyRoute(action: 'route' | 'direct'): Promise<void>;
  readRoute(): Promise<unknown>;
}

interface EngineRoutingTransaction {
  execute(adapter: EngineRoutingAdapter, action: ProxyRoutingAction): Promise<ProxyRoutingResult>;
}

interface EngineRoutingModule {
  createRoutingTransactionAdapters(
    deps: Record<string, unknown>,
    port?: number,
  ): EngineRoutingAdapter[];
  resolveConfiguredRoutes(deps?: Record<string, unknown>): Promise<unknown[]>;
}

interface EngineTransactionModule {
  RoutingTransaction: new (deps: {
    backupStore: unknown;
    verifier: unknown;
  }) => EngineRoutingTransaction;
}

interface EngineBackupStoreModule {
  ConfigBackupStore: new () => unknown;
}

interface EngineModules {
  routing: EngineRoutingModule;
  transaction: EngineTransactionModule;
  backupStore: unknown;
}

export interface DesktopProxyRoutingOptions {
  locateEngine(): Promise<EngineInstallation>;
  loopbackAccess(): Promise<{ endpoint: string; token: string }>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  /** Told about a revert that could not be done, so it reaches the log rather than being swallowed. */
  onProblem?(message: string): void;
}

export class DesktopProxyRouting {
  private modules: Promise<EngineModules> | null = null;

  constructor(private readonly options: DesktopProxyRoutingOptions) {}

  async routes(): Promise<ProxyAgentRoute[]> {
    const settings = await this.options.loadSettings();
    const { routing } = await this.loadModules();
    const routes = await routing.resolveConfiguredRoutes(adapterDeps(settings));
    return parseRoutes(routes);
  }

  async action(
    agent: ProxyAgentId,
    action: ProxyRoutingAction,
    routeUntil = 0,
  ): Promise<ProxyRoutingResult> {
    const settings = await this.options.loadSettings();
    const { routing, transaction, backupStore } = await this.loadModules();
    const adapters = routing.createRoutingTransactionAdapters(adapterDeps(settings), settings.proxy.port);
    const adapter = adapters.find((candidate) => candidate.agentId === agent);
    if (!adapter) throw new Error(`No Universal Agent Proxy route adapter is available for ${agent}.`);

    const verifier = createRouteVerifier(this.options.loopbackAccess);
    const runner = new transaction.RoutingTransaction({
      backupStore,
      verifier,
    });
    const result = await runner.execute(adapter, action);
    if (result.success && (action === 'route' || action === 'direct')) {
      const owned = syncRouteOwnership(settings, agent, action, routeUntil);
      await this.options.saveSettings(
        action === 'route' ? { ...owned, proxy: { ...owned.proxy, routedPort: settings.proxy.port } } : owned,
      );
    }
    return result;
  }

  /**
   * Moves every agent config KAI routed on its previous port over to `port`. Only URLs on the port KAI itself
   * routed are touched, so a different proxy that owns the old port keeps its own agents. Returns changed files.
   */
  async followPort(port: number): Promise<string[]> {
    const settings = await this.options.loadSettings();
    const previous = settings.proxy.routedPort;
    if (previous === port) return [];
    const changed: string[] = [];
    if (previous) {
      const { routing } = await this.loadModules();
      for (const adapter of routing.createRoutingTransactionAdapters(adapterDeps(settings), port)) {
        const file = adapter.configPath();
        let content: string;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch {
          continue;
        }
        const next = retargetProxyPort(content, adapter.agentId, previous, port);
        if (next === content) continue;
        const temporary = `${file}.kai-${process.pid}.tmp`;
        await fs.writeFile(temporary, next);
        await fs.rename(temporary, file);
        changed.push(file);
      }
    }
    await this.options.saveSettings({ ...settings, proxy: { ...settings.proxy, routedPort: port } });
    return changed;
  }

  /**
   * Puts every agent KAI itself routed back to its own provider.
   *
   * Nothing did this. A route written into `~/.codex/config.toml` or `~/.claude/settings.json` outlives the proxy it
   * points at, so a CLI started afterwards was left talking to `127.0.0.1:8083` with nothing listening — until the
   * person happened to open KAI again and press Direct. Called when the proxy stops and when KAI quits, and by the
   * timed-route check below.
   *
   * Only the agents KAI routed, and only while KAI's own record still says it routed them: an agent the user pointed
   * at their standalone proxy on 8082 was never KAI's to move back.
   */
  async revertOwnedRoutes(reason: string): Promise<string[]> {
    const settings = await this.options.loadSettings();
    const owned: ProxyAgentId[] = [];
    if (settings.proxy.routeClaudeCode) owned.push('claude');
    if (settings.proxy.routeCodex) owned.push('codex');
    const reverted: string[] = [];
    for (const agent of owned) {
      try {
        const result = await this.action(agent, 'direct');
        if (result.success) reverted.push(agent);
        // A refusal is not a throw, so an unchecked one would leave the CLI stranded with nothing said about it —
        // which is the whole failure being fixed here, arrived at from the other side.
        else this.options.onProblem?.(`Could not put ${agent} back to its own provider (${reason}): ${result.error || 'the proxy refused the change.'}`);
      } catch (error) {
        // A revert that cannot run must not stop the others, or a quit. It is reported, not thrown: the alternative
        // is a shutdown that hangs on a config file.
        this.options.onProblem?.(`Could not put ${agent} back to its own provider (${reason}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return reverted;
  }

  /**
   * Undoes a route a session that ended badly left behind.
   *
   * A crash skips the quit path, so the next launch is the first chance to notice. Anything still pointing at a port
   * KAI routed on, while KAI's own record says it should not be, is put back.
   */
  async repairRoutesAtStartup(): Promise<string[]> {
    const settings = await this.options.loadSettings();
    const reverted: string[] = [];
    for (const agent of ['claude', 'codex'] as const) {
      const wanted = agent === 'claude' ? settings.proxy.routeClaudeCode : settings.proxy.routeCodex;
      if (wanted) continue;
      try {
        const routes = await this.routes();
        const current = routes.find((route) => route.agentId === agent);
        // Only a config KAI itself moved is put back — `localEndpoint` on KAI's own port is the mark of that.
        if (current?.route !== 'proxy' || !current.localEndpoint?.includes(`:${settings.proxy.port}/`)) continue;
        const result = await this.action(agent, 'direct');
        if (result.success) reverted.push(agent);
        else this.options.onProblem?.(`Could not repair the ${agent} route at startup: ${result.error || 'the proxy refused the change.'}`);
      } catch (error) {
        this.options.onProblem?.(`Could not repair the ${agent} route at startup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return reverted;
  }

  /** Puts back any route whose window has closed. See `syncRouteOwnership` for what writes the deadline. */
  async revertExpiredRoutes(now = Date.now()): Promise<string[]> {
    const settings = await this.options.loadSettings();
    const until = settings.proxy.routeClaudeCodeUntil;
    if (!settings.proxy.routeClaudeCode || !until || until > now) return [];
    return this.revertOwnedRoutes('its time ran out');
  }

  private loadModules(): Promise<EngineModules> {
    if (!this.modules) {
      this.modules = this.options.locateEngine().then((installation) => {
        const localRequire = createRequire(__filename);
        const routing = localRequire(path.join(installation.root, 'out', 'routing', 'adapters', 'index.js')) as EngineRoutingModule;
        const transaction = localRequire(path.join(installation.root, 'out', 'routing', 'routing-transaction.js')) as EngineTransactionModule;
        const backups = localRequire(path.join(installation.root, 'out', 'routing', 'config-backup.js')) as EngineBackupStoreModule;
        return { routing, transaction, backupStore: new backups.ConfigBackupStore() };
      });
    }
    return this.modules;
  }
}

function createRouteVerifier(
  loopbackAccess: () => Promise<{ endpoint: string; token: string }>,
): unknown {
  return {
    async verifyDirectRoute(route: { route: string }) {
      return {
        timestamp: Date.now(),
        success: route.route !== 'proxy',
        latencyMs: 0,
        ...(route.route === 'proxy' ? { error: 'Agent still points at the proxy after Direct.' } : {}),
      };
    },
    async verifyRoute(route: { route: string; localEndpoint?: string }) {
      const started = Date.now();
      if (route.route !== 'proxy' || !route.localEndpoint) {
        return {
          timestamp: started,
          success: false,
          latencyMs: 0,
          error: 'Route has no proxy endpoint to verify.',
        };
      }
      try {
        const access = await loopbackAccess();
        const endpoint = new URL(route.localEndpoint);
        endpoint.pathname = endpoint.pathname.replace(/\/+$/, '').endsWith('/v1')
          ? `${endpoint.pathname.replace(/\/+$/, '')}/test`
          : `${endpoint.pathname.replace(/\/+$/, '')}/v1/test`;
        endpoint.search = '';
        endpoint.hash = '';
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${access.token}` },
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
        const success = response.status >= 200 && response.status < 400;
        return {
          timestamp: started,
          success,
          latencyMs: Math.max(0, Date.now() - started),
          statusCode: response.status,
          ...(success ? {} : { error: `Route probe returned HTTP ${response.status}.` }),
        };
      } catch (error) {
        return {
          timestamp: started,
          success: false,
          latencyMs: Math.max(0, Date.now() - started),
          error: error instanceof Error ? error.message : 'Route probe failed.',
        };
      }
    },
  };
}

/** Rewrites this agent's loopback proxy URLs from one port to another, leaving every other URL alone. */
export function retargetProxyPort(content: string, agent: ProxyAgentId, from: number, to: number): string {
  const pattern = new RegExp(`(https?://(?:127\\.0\\.0\\.1|localhost)):${from}(/a/${agent}(?![\\w-]))`, 'gi');
  return content.replace(pattern, `$1:${to}$2`);
}

export function proxyAgentBaseUrl(settings: AppSettings, agent: ProxyAgentId): string {
  const suffix = agent === 'claude' ? '' : '/v1';
  return `http://127.0.0.1:${settings.proxy.port}/a/${agent}${suffix}`;
}

function relayModelFor(configured: string | undefined): string {
  const chosen = configured?.trim();
  return !chosen || chosen === 'gpt-5.5' ? 'gpt-5.6-sol' : chosen;
}

function adapterDeps(settings: AppSettings): Record<string, unknown> {
  const endpoint = (agent: ProxyAgentId) => proxyAgentBaseUrl(settings, agent);
  return {
    claude: { proxyEndpoint: endpoint('claude') },
    codex: {
      proxyEndpoint: endpoint('codex'),
      // A saved retired relay id (gpt-5.5) moves onto the current one, so Codex is never configured with a name
      // OpenAI has retired.
      relayModel: relayModelFor(settings.proxy.codexConfig.configModel),
    },
    kimi: { proxyEndpoint: endpoint('kimi') },
    qwen: { proxyEndpoint: endpoint('qwen') },
  };
}

function syncRouteOwnership(
  settings: AppSettings,
  agent: ProxyAgentId,
  action: 'route' | 'direct',
  routeUntil = 0,
): AppSettings {
  const proxy = { ...settings.proxy };
  if (agent === 'claude') {
    proxy.routeClaudeCode = action === 'route';
    proxy.routeClaudeCodeUntil = action === 'route' ? routeUntil : 0;
    if (action === 'direct') proxy.autoFallbackEnabled = false;
  } else if (agent === 'codex') {
    proxy.routeCodex = action === 'route';
  }
  return { ...settings, proxy };
}

function parseRoutes(routes: unknown[]): ProxyAgentRoute[] {
  return routes.map((candidate) => {
    const route = candidate as Partial<ProxyAgentRoute>;
    if (
      !route.agentId
      || !['claude', 'codex', 'kimi', 'qwen'].includes(route.agentId)
      || !route.route
      || !['direct', 'proxy', 'misconfigured'].includes(route.route)
    ) {
      throw new Error('Universal Agent Proxy returned an invalid route record.');
    }
    return {
      agentId: route.agentId,
      clientKind: route.clientKind ?? 'both',
      installed: route.installed === true,
      running: route.running ?? null,
      route: route.route,
      ...(route.localEndpoint ? { localEndpoint: route.localEndpoint } : {}),
      ...(route.upstreamProvider ? { upstreamProvider: route.upstreamProvider } : {}),
      ...(route.upstreamModel ? { upstreamModel: route.upstreamModel } : {}),
      credentialSource: route.credentialSource ?? 'none',
      ...(route.credentialFingerprint ? { credentialFingerprint: route.credentialFingerprint } : {}),
      restartRequired: route.restartRequired === true,
      configSources: Array.isArray(route.configSources) ? route.configSources : [],
      ...(typeof route.configBackupDate === 'number' ? { configBackupDate: route.configBackupDate } : {}),
      warnings: Array.isArray(route.warnings) ? route.warnings : [],
      ...(route.lastVerified ? { lastVerified: route.lastVerified } : {}),
    };
  });
}
