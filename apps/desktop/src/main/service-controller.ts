import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AppSettings, ServiceKind, ServiceState, SettingsUpdate } from '@kai/contracts';
import {
  AuthenticatedLoopbackGateway,
  EngineLocator,
  RestartPolicy,
  ServiceManager,
  cognitive1Manifest,
  findAvailableLoopbackPort,
  universalProxyManifest,
  type EngineInstallation,
  type ServiceLaunchSpec,
} from '@kai/integrations';
import type { RedactedLogger, SettingsService } from '@kai/runtime';
import type { CredentialVault } from './credential-vault';
import type { DesktopPaths } from './paths';

/** The port the standalone Cognitive1 daemon uses. KAI's managed copy must not share it. */
export const STANDALONE_COGNITIVE1_PORT = 9876;

export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Older KAI versions defaulted the managed Cognitive1 endpoint to the standalone daemon's port. That exact
 * legacy value is always migrated, even when 9876 is currently free, so KAI cannot take the port first and
 * stop a standalone daemon from starting later. Any other user-selected endpoint is left untouched.
 */
export async function moveOffStandalonePort(
  endpoint: string,
  isFree: (port: number) => Promise<boolean> = isLoopbackPortFree,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (Number(url.port) !== STANDALONE_COGNITIVE1_PORT) return null;
  for (let port = STANDALONE_COGNITIVE1_PORT + 1; port < STANDALONE_COGNITIVE1_PORT + 50; port += 1) {
    if (await isFree(port)) {
      url.port = String(port);
      return url.toString().replace(/\/$/, '');
    }
  }
  return null;
}

/** A plain-language message for the most common start failure. */
export function explainStartFailure(kind: ServiceKind, endpoint: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/EADDRINUSE|address already in use/i.test(message)) return message;
  const port = (() => {
    try {
      return new URL(endpoint).port;
    } catch {
      return '';
    }
  })();
  const name = kind === 'cognitive1' ? 'Cognitive1' : 'the Universal Proxy';
  return `Port ${port || '(unknown)'} is already in use by another program, so ${name} could not start. Another copy may be running. Change the port in Settings or stop that program.`;
}

export interface ServiceControllerOptions {
  paths: DesktopPaths;
  settings: SettingsService;
  credentials: CredentialVault;
  logger: RedactedLogger;
  kaiRoot: string;
  resourcesPath: string;
  proxyLauncherPath: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  restartPolicy?: import('@kai/integrations').RestartPolicyOptions;
}

export interface ServiceLoopbackAccess {
  kind: ServiceKind;
  endpoint: string;
  token: string;
}

export class DesktopServiceController {
  private readonly manager = new ServiceManager(undefined, (kind, detail) => this.handleCrash(kind, detail));
  private readonly restartPolicies = new Map<ServiceKind, RestartPolicy>();
  private readonly exhausted = new Set<ServiceKind>();
  private readonly restartTimers = new Map<ServiceKind, NodeJS.Timeout>();
  private disposed = false;
  private readonly gateways = new Map<ServiceKind, AuthenticatedLoopbackGateway>();
  private readonly locator: EngineLocator;
  private readonly executablePath: string;
  private readonly installationErrors = new Map<ServiceKind, string>();
  private cognitive1ApiKey: string | null = null;

  constructor(private readonly options: ServiceControllerOptions) {
    this.locator = new EngineLocator({
      kaiRoot: options.kaiRoot,
      resourcesPath: options.resourcesPath,
      environment: options.environment,
    });
    this.executablePath = options.executablePath ?? process.execPath;
  }

  async startConfigured(): Promise<void> {
    const settings = await this.options.settings.load();
    await Promise.all(
      (['cognitive1', 'universalProxy'] as const).map(async (kind) => {
        if (!serviceEnabled(settings, kind)) return;
        try {
          await this.start(kind, settings, false);
        } catch {
          // The manager retains the failed state and diagnostic detail.
        }
      }),
    );
  }

  async status(): Promise<ServiceState[]> {
    const settings = await this.options.settings.load();
    return Promise.all((['cognitive1', 'universalProxy'] as const).map((kind) => this.statusFor(kind, settings)));
  }

  async start(kind: ServiceKind, suppliedSettings?: AppSettings, persistEnabled = true): Promise<ServiceState[]> {
    let settings = suppliedSettings ?? (await this.options.settings.load());
    const current = this.manager.getState(kind).status;
    if (current === 'ready' || current === 'starting') return this.status();

    if (kind === 'cognitive1') {
      const moved = await moveOffStandalonePort(settings.cognitive1.endpoint);
      if (moved) {
        settings = { ...settings, cognitive1: { ...settings.cognitive1, endpoint: moved } };
        await this.options.settings.update((current) => ({
          ...current,
          cognitive1: { ...current.cognitive1, endpoint: moved },
        }));
        this.options.logger.info('internal', `Cognitive1 endpoint moved to ${moved} because the standalone daemon uses port ${STANDALONE_COGNITIVE1_PORT}`);
      }
    }

    let gateway: AuthenticatedLoopbackGateway | null = null;
    try {
      const spec = await this.launchSpec(kind, settings);
      const token = await this.ensureLoopbackToken(kind);
      gateway = new AuthenticatedLoopbackGateway({
        listenEndpoint: endpointFor(kind, settings),
        upstreamEndpoint: spec.endpoint,
        token,
      });
      await gateway.start();
      this.gateways.set(kind, gateway);
      await this.manager.start(spec);
      this.installationErrors.delete(kind);
    } catch (error) {
      await gateway?.stop().catch(() => undefined);
      this.gateways.delete(kind);
      const explained = explainStartFailure(kind, endpointFor(kind, settings), error);
      this.installationErrors.set(kind, explained);
      throw explained === messageOf(error) ? error : new Error(explained);
    }
    if (persistEnabled) await this.persistEnabled(kind, true);
    return this.status();
  }

  private policyFor(kind: ServiceKind): RestartPolicy {
    let policy = this.restartPolicies.get(kind);
    if (!policy) {
      policy = new RestartPolicy(this.options.restartPolicy);
      this.restartPolicies.set(kind, policy);
    }
    return policy;
  }

  private handleCrash(kind: ServiceKind, detail: string): void {
    if (this.disposed) return;
    const decision = this.policyFor(kind).onCrash(Date.now());
    if (decision.action === 'give-up') {
      this.exhausted.add(kind);
      this.options.logger.error('service_error', `${kind} crashed ${decision.attempts} times; automatic restarts stopped`, detail);
      return;
    }
    this.options.logger.warn('service_error', `${kind} crashed; restart ${decision.attempt} in ${decision.delayMs}ms`, detail);
    const timer = setTimeout(() => {
      this.restartTimers.delete(kind);
      if (this.disposed) return;
      void this.closeGateway(kind)
        .then(() => this.options.settings.load())
        .then((settings) => (serviceEnabled(settings, kind) ? this.start(kind, settings, false) : undefined))
        .catch((error) => {
          this.options.logger.error('service_error', `Automatic restart of ${kind} failed`, messageOf(error));
          this.handleCrash(kind, messageOf(error));
        });
    }, decision.delayMs);
    timer.unref();
    this.restartTimers.set(kind, timer);
  }

  private clearRestartState(kind: ServiceKind): void {
    const timer = this.restartTimers.get(kind);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(kind);
    this.exhausted.delete(kind);
    this.restartPolicies.get(kind)?.reset();
  }

  async stop(kind: ServiceKind): Promise<ServiceState[]> {
    this.clearRestartState(kind);
    try {
      await this.manager.stop(kind);
    } finally {
      await this.closeGateway(kind);
    }
    await this.persistEnabled(kind, false);
    return this.status();
  }

  async restart(kind: ServiceKind, suppliedSettings?: AppSettings): Promise<ServiceState[]> {
    const settings = suppliedSettings ?? (await this.options.settings.load());
    this.clearRestartState(kind);
    await this.manager.stop(kind);
    await this.closeGateway(kind);
    return this.start(kind, settings, true);
  }

  async rotateToken(kind: ServiceKind): Promise<ServiceState[]> {
    const settings = await this.options.settings.load();
    await this.options.credentials.set(loopbackCredentialId(kind), newLoopbackToken());
    const current = this.manager.getState(kind).status;
    if (current === 'ready' || current === 'starting') return this.restart(kind, settings);
    return this.status();
  }

  async loopbackAccess(kind: ServiceKind): Promise<ServiceLoopbackAccess> {
    const settings = await this.options.settings.load();
    const token = await this.options.credentials.get(loopbackCredentialId(kind));
    if (!token) throw new Error('No loopback access token is stored for this service.');
    return { kind, endpoint: endpointFor(kind, settings), token };
  }

  async syncFromSettings(settings: AppSettings): Promise<void> {
    for (const kind of ['cognitive1', 'universalProxy'] as const) {
      if (serviceEnabled(settings, kind)) {
        const current = this.manager.getState(kind).status;
        if (current === 'ready' || current === 'starting') continue;
        try {
          await this.start(kind, settings, false);
        } catch {
          // Status is exposed through the returned service state.
        }
      } else if (this.manager.getState(kind).status !== 'not_configured') {
        await this.stop(kind);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const kind of [...this.restartTimers.keys()]) this.clearRestartState(kind);
    try {
      await Promise.race([
        this.manager.stopAll(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Managed services did not stop within 12000ms.')), 12_000).unref();
        }),
      ]);
    } finally {
      await Promise.all([...this.gateways.keys()].map((kind) => this.closeGateway(kind)));
      this.cognitive1ApiKey = null;
    }
  }

  getCognitive1Token(): string | null {
    return this.cognitive1ApiKey;
  }

  async engineInstallation(kind: ServiceKind): Promise<EngineInstallation> {
    return this.locate(kind);
  }

  private async statusFor(kind: ServiceKind, settings: AppSettings): Promise<ServiceState> {
    const current = this.manager.getState(kind);
    let state: ServiceState;
    if (current.status !== 'not_configured') {
      state = current;
    } else {
      const enabled = serviceEnabled(settings, kind);
      const installationError = this.installationErrors.get(kind);
      state = installationError
        ? {
            kind,
            status: 'failed',
            detail: installationError,
            endpoint: endpointFor(kind, settings),
            version: versionFor(kind),
            updatedAt: new Date().toISOString(),
          }
        : {
            kind,
            status: enabled ? 'stopped' : 'not_configured',
            detail: enabled ? 'Enabled; waiting for the managed service to start.' : 'Disabled in settings.',
            endpoint: endpointFor(kind, settings),
            version: versionFor(kind),
            updatedAt: new Date().toISOString(),
          };
    }

    const restarts = this.restartPolicies.get(kind)?.restartCount(Date.now()) ?? 0;
    const exhausted = this.exhausted.has(kind);
    return {
      ...state,
      ...(exhausted ? { detail: `${state.detail} Automatic restarts stopped after ${restarts} crashes; restart it manually.` } : {}),
      restarts,
      restartsExhausted: exhausted,
      endpoint: endpointFor(kind, settings),
      authentication: 'loopback-token',
      tokenStored: await this.options.credentials.has(loopbackCredentialId(kind)),
    };
  }

  private async launchSpec(kind: ServiceKind, settings: AppSettings): Promise<ServiceLaunchSpec> {
    if (kind === 'cognitive1') return this.cognitive1Spec(settings);
    return this.proxySpec(settings);
  }

  private async cognitive1Spec(settings: AppSettings): Promise<ServiceLaunchSpec> {
    const installation = await this.locate(cognitive1Manifest.kind);
    const dataPath = settings.cognitive1.dataPath ?? path.join(this.options.paths.root, 'engines', 'cognitive1');
    const projectsPath = path.join(dataPath, '.projects');
    await fs.mkdir(projectsPath, { recursive: true });
    const overwatchApiKey = settings.cognitive1.overwatch.enabled
      ? await this.credential(settings.cognitive1.overwatch.credentialId)
      : '';
    this.cognitive1ApiKey = crypto.randomBytes(32).toString('base64url');
    const endpoint = `http://127.0.0.1:${await findAvailableLoopbackPort()}`;
    return {
      kind: 'cognitive1',
      label: installation.label,
      version: installation.version,
      commit: installation.commit,
      endpoint,
      healthPath: '/health',
      executable: this.executablePath,
      args: [installation.entryPoint],
      cwd: installation.root,
      env: {
        ...this.options.environment,
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        COGNITIVE1_WIKI_PATH: dataPath,
        COGNITIVE1_HTTP_PORT: String(new URL(endpoint).port),
        COGNITIVE1_HTTP_HOST: '127.0.0.1',
        COGNITIVE1_API_KEY: this.cognitive1ApiKey,
        COGNITIVE1_PROJECTS_DIR: projectsPath,
        ...cognitive1OverwatchEnvironment(settings, overwatchApiKey),
        COGNITIVE1_AUTO_UPDATE: 'false',
        COGNITIVE1_AUTO_UPDATE_RESTART: 'false',
        COGNITIVE1_GIT_AUTO_LEARN: 'false',
        COGNITIVE1_LOG_LEVEL: 'info',
      },
      onLog: (stream, line) => this.logServiceLine('cognitive1', stream, line),
    };
  }

  private async proxySpec(settings: AppSettings): Promise<ServiceLaunchSpec> {
    const installation = await this.locate(universalProxyManifest.kind);
    const proxy = settings.proxy;
    const apiKey = await this.credential(proxy.credentialId);
    const port = await findAvailableLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const historyPath = path.join(this.options.paths.root, 'engines', 'proxy', 'history.jsonl');
    await fs.mkdir(path.dirname(historyPath), { recursive: true });

    const providers = Object.fromEntries(await Promise.all(
      Object.entries(proxy.providers).map(async ([name, provider]) => [
        name,
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.credentialId ? await this.credential(provider.credentialId) : undefined,
          format: provider.format,
          defaultModel: provider.defaultModel,
          modelMap: provider.modelMap,
        },
      ]),
    ));
    const fallbackProviders = await Promise.all(
      proxy.fallbackProviders.map(async (provider) => ({
        baseUrl: provider.baseUrl,
        apiKey: provider.credentialId ? await this.credential(provider.credentialId) : undefined,
        defaultModel: provider.defaultModel,
        modelMap: provider.modelMap,
      })),
    );
    const [kimiConfig, qwenConfig, codexConfig] = await Promise.all([
      this.agentBackendConfig(proxy.kimiConfig),
      this.agentBackendConfig(proxy.qwenConfig),
      this.agentBackendConfig(proxy.codexConfig),
    ]);

    const config = {
      port,
      targetBaseUrl: proxy.targetBaseUrl,
      apiKey,
      apiKeys: apiKey ? { [proxy.targetBaseUrl]: apiKey } : {},
      defaultModel: proxy.defaultModel,
      modelMap: proxy.modelMap,
      customHeaders: proxy.customHeaders,
      fallbackProviders,
      providers,
      modelRoutes: proxy.modelRoutes,
      modelRouting: proxy.modelRouting,
      agentRoutes: proxy.agentRoutes,
      dualApiEnabled: proxy.dualApiEnabled,
      kimiConfig,
      qwenConfig,
      codexConfig,
      rateLimit: proxy.rateLimit,
      concurrency: { maxConcurrentRequests: proxy.maxConcurrentRequests },
      logging: {
        ...proxy.logging,
        directory: proxy.logging.directory || path.join(this.options.paths.root, 'engines', 'proxy', 'logs'),
      },
      tls: proxy.tls,
      upstreamTimeoutMs: proxy.upstreamTimeoutMs,
      stallTimeoutMs: proxy.stallTimeoutMs,
    };
    const runtime = {
      errorThreshold: proxy.errorNotifyThreshold,
      retryConfig: proxy.retryConfig,
      historyConfig: {
        maxEntries: proxy.historyConfig.maxEntries,
        includePromptSnippet: proxy.historyConfig.includePromptSnippet,
        promptSnippetChars: proxy.historyConfig.promptSnippetChars,
        maxReplayEntries: proxy.historyConfig.maxReplayEntries,
        filePath: historyPath,
        persistedMaxEntries: 10_000,
      },
      budgetConfig: proxy.costBudget,
      rateLimitMaxRPS: proxy.rateLimit.maxRequestsPerSecond,
      maxConcurrent: proxy.maxConcurrentRequests,
      logging: {
        ...proxy.logging,
        directory: proxy.logging.directory || path.join(this.options.paths.root, 'engines', 'proxy', 'logs'),
      },
      upstreamTimeout: proxy.upstreamTimeoutMs,
      tls: proxy.tls,
    };

    return {
      kind: 'universalProxy',
      label: installation.label,
      version: installation.version,
      commit: installation.commit,
      endpoint,
      healthPath: '/health',
      executable: this.executablePath,
      args: [this.options.proxyLauncherPath],
      cwd: installation.root,
      env: {
        ...this.options.environment,
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        KAI_UAP_ENGINE_ROOT: installation.root,
      },
      stdin: `${JSON.stringify({ config, runtime })}\n`,
      onLog: (stream, line) => this.logServiceLine('universalProxy', stream, line),
    };
  }

  private async credential(id: string): Promise<string> {
    if (!this.options.credentials.isAvailable()) return '';
    return (await this.options.credentials.get(id)) ?? '';
  }

  private async agentBackendConfig(config: AppSettings['proxy']['kimiConfig']) {
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      apiKey: config.credentialId ? await this.credential(config.credentialId) : '',
      defaultModel: config.defaultModel,
      configModel: config.configModel,
    };
  }

  private async locate(kind: ServiceKind): Promise<EngineInstallation> {
    return this.locator.locate(kind === 'cognitive1' ? cognitive1Manifest : universalProxyManifest);
  }

  private async ensureLoopbackToken(kind: ServiceKind): Promise<string> {
    const id = loopbackCredentialId(kind);
    const existing = await this.options.credentials.get(id);
    if (existing) return existing;
    const token = newLoopbackToken();
    await this.options.credentials.set(id, token);
    return token;
  }

  private async closeGateway(kind: ServiceKind): Promise<void> {
    const gateway = this.gateways.get(kind);
    this.gateways.delete(kind);
    await gateway?.stop();
  }

  private async persistEnabled(kind: ServiceKind, enabled: boolean): Promise<void> {
    await this.options.settings.update((settings) => kind === 'cognitive1'
      ? { ...settings, cognitive1: { ...settings.cognitive1, enabled } }
      : { ...settings, proxy: { ...settings.proxy, enabled } });
  }

  private logServiceLine(kind: ServiceKind, stream: 'stdout' | 'stderr', line: string): void {
    const message = `[${kind}] ${line}`;
    if (stream === 'stderr') this.options.logger.warn('service_error', message);
    else this.options.logger.info('service_error', message);
  }
}

export function mergeSettingsUpdate(settings: AppSettings, update: SettingsUpdate): AppSettings {
  return {
    ...settings,
    ...update,
    directApi: { ...settings.directApi, ...update.directApi },
    learningTutor: { ...settings.learningTutor, ...update.learningTutor },
    editor: { ...settings.editor, ...update.editor },
    mcpServers: update.mcpServers ?? settings.mcpServers,
    cognitive1: { ...settings.cognitive1, ...update.cognitive1 },
    proxy: { ...settings.proxy, ...update.proxy },
    usageBudget: { ...settings.usageBudget, ...update.usageBudget },
    notifications: { ...settings.notifications, ...update.notifications },
    updates: { ...settings.updates, ...update.updates },
    // A model map replaces the old one, so clearing a field removes that agent's override.
    agentModels: update.agentModels ?? settings.agentModels,
  };
}

function serviceEnabled(settings: AppSettings, kind: ServiceKind): boolean {
  return kind === 'cognitive1' ? settings.cognitive1.enabled : settings.proxy.enabled;
}

function endpointFor(kind: ServiceKind, settings: AppSettings): string {
  return kind === 'cognitive1' ? settings.cognitive1.endpoint : `http://127.0.0.1:${settings.proxy.port}`;
}

function versionFor(kind: ServiceKind): string {
  return kind === 'cognitive1' ? cognitive1Manifest.expectedVersion : universalProxyManifest.expectedVersion;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loopbackCredentialId(kind: ServiceKind): string {
  return `service.${kind}.loopback`;
}

function newLoopbackToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function cognitive1OverwatchEnvironment(
  settings: AppSettings,
  apiKey: string,
): Record<string, string> {
  const overwatch = settings.cognitive1.overwatch;
  const environment: Record<string, string> = {
    COGNITIVE1_OVERWATCH_ENABLED: String(overwatch.enabled),
    COGNITIVE1_OVERWATCH_PROVIDER: overwatch.provider,
    COGNITIVE1_OVERWATCH_BASE_URL: overwatch.baseUrl,
    COGNITIVE1_OVERWATCH_MODEL: overwatch.model,
    COGNITIVE1_OVERWATCH_AUTO_REJECT_THRESHOLD: String(overwatch.autoRejectThreshold),
  };
  if (apiKey) environment.COGNITIVE1_OVERWATCH_API_KEY = apiKey;
  return environment;
}
