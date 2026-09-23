import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AppSettings, ServiceKind, ServiceState, SettingsUpdate } from '@kai/contracts';
import {
  AuthenticatedLoopbackGateway,
  EngineLocator,
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
}

export interface ServiceLoopbackAccess {
  kind: ServiceKind;
  endpoint: string;
  token: string;
}

export class DesktopServiceController {
  private readonly manager = new ServiceManager();
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
    const settings = suppliedSettings ?? (await this.options.settings.load());
    const current = this.manager.getState(kind).status;
    if (current === 'ready' || current === 'starting') return this.status();

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
      this.installationErrors.set(kind, messageOf(error));
      throw error;
    }
    if (persistEnabled) await this.persistEnabled(kind, true);
    return this.status();
  }

  async stop(kind: ServiceKind): Promise<ServiceState[]> {
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

    return {
      ...state,
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
        COGNITIVE1_OVERWATCH_ENABLED: 'false',
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
    const apiKey = this.options.credentials.isAvailable()
      ? ((await this.options.credentials.get(settings.proxy.credentialId)) ?? '')
      : '';
    const port = await findAvailableLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const historyPath = path.join(this.options.paths.root, 'engines', 'proxy', 'history.jsonl');
    await fs.mkdir(path.dirname(historyPath), { recursive: true });

    const config = {
      port,
      targetBaseUrl: settings.proxy.targetBaseUrl,
      apiKey,
      apiKeys: apiKey ? { [settings.proxy.targetBaseUrl]: apiKey } : {},
      defaultModel: settings.proxy.defaultModel,
      modelMap: {},
      customHeaders: {},
      fallbackProviders: [],
      providers: {},
      modelRoutes: [],
      modelRouting: false,
      agentRoutes: {},
      dualApiEnabled: false,
      kimiConfig: disabledAgentConfig(),
      qwenConfig: disabledAgentConfig(),
      codexConfig: disabledAgentConfig(),
      rateLimit: { maxRequestsPerSecond: 0 },
      concurrency: { maxConcurrentRequests: 0 },
      logging: { enabled: false, directory: '', maxFileSizeMB: 10 },
      tls: { enabled: false, certPath: '', keyPath: '' },
      upstreamTimeoutMs: 3_600_000,
      stallTimeoutMs: 120_000,
    };
    const runtime = {
      historyConfig: {
        maxEntries: 500,
        includePromptSnippet: false,
        promptSnippetChars: 0,
        filePath: historyPath,
        persistedMaxEntries: 10_000,
      },
      upstreamTimeout: config.upstreamTimeoutMs,
      tls: config.tls,
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
    const settings = await this.options.settings.load();
    if (kind === 'cognitive1') settings.cognitive1.enabled = enabled;
    else settings.proxy.enabled = enabled;
    await this.options.settings.save(settings);
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
    mcpServers: update.mcpServers ?? settings.mcpServers,
    cognitive1: { ...settings.cognitive1, ...update.cognitive1 },
    proxy: { ...settings.proxy, ...update.proxy },
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

function disabledAgentConfig() {
  return {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
  };
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
