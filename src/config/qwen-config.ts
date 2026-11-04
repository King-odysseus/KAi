import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface QwenProxyConfig {
  configPath?: string;
  port: number;
  authToken?: string;
}

export interface QwenProxyConfigResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
  providerCount: number;
}

export class QwenConfigWriter {
  constructor(private readonly backupRootName = '.kai-backups') {}

  async ensureProxyConfig(config: QwenProxyConfig): Promise<QwenProxyConfigResult> {
    const configPath = config.configPath ?? defaultQwenConfigPath();
    const existingRaw = await this.readOptional(configPath);
    const settings = parseSettings(existingRaw);
    if (!settings) {
      return { configPath, changed: false, providerCount: 0 };
    }

    const proxyUrl = proxyBaseUrl(config.port);
    const modelProviders = asProviderMap(settings.modelProviders);
    const model = asRecord(settings.model);
    const authSnapshots = readAuthSnapshots(settings);
    const authOriginals = authSnapshots ?? { providers: [] as ProviderAuthHeaderSnapshot[], model: null as AuthHeaderSnapshot | null };

    // Snapshot the user's real upstreams before the first rewrite so a later
    // restore can put them back. A base URL already pointing at a local proxy
    // is not a real upstream — recording it would "restore" to a dead port.
    let originals = readOriginals(settings);
    if (!originals) {
      const snapshot: RecordedOriginals = {
        providers: collectOriginals(modelProviders),
        modelBaseUrl: model ? nonProxyBaseUrl(model) : undefined,
      };
      if (snapshot.providers.length > 0 || snapshot.modelBaseUrl !== undefined) {
        originals = snapshot;
      }
    }

    let changed = false;
    for (const [providerKey, providers] of Object.entries(modelProviders)) {
      for (const provider of providers) {
        if (typeof provider.baseUrl !== 'string') continue;
        if (provider.baseUrl !== proxyUrl && !isLocalProxy(provider.baseUrl)) {
          provider.baseUrl = proxyUrl;
          changed = true;
        }
        if (config.authToken) {
          if (!authSnapshots) authOriginals.providers.push({ provider: providerKey, id: idOf(provider), ...readCustomHeaders(provider) });
          changed = setProxyAuthorization(provider, config.authToken) || changed;
        }
      }
    }
    if (model && typeof model.baseUrl === 'string') {
      if (model.baseUrl !== proxyUrl && !isLocalProxy(model.baseUrl)) {
        model.baseUrl = proxyUrl;
        changed = true;
      }
      if (config.authToken) {
        if (!authSnapshots) authOriginals.model = readCustomHeaders(model);
        changed = setProxyAuthorization(model, config.authToken) || changed;
      }
    }

    if (!changed) {
      return { configPath, changed: false, providerCount: 0 };
    }
    if (originals) settings[ORIGINALS_KEY] = originals;
    if (config.authToken && (authOriginals.providers.length > 0 || authOriginals.model)) settings[AUTH_ORIGINALS_KEY] = authOriginals;

    const next = JSON.stringify(settings, null, 2) + '\n';
    const backupPath = await this.backupExisting(configPath, existingRaw);
    await fs.writeFile(configPath, next, 'utf8');
    return { configPath, backupPath, changed: true, providerCount: countProxied(modelProviders, proxyUrl) };
  }

  async restoreConfig(configPath?: string): Promise<QwenProxyConfigResult> {
    const targetPath = configPath ?? defaultQwenConfigPath();
    const existingRaw = await this.readOptional(targetPath);
    const settings = parseSettings(existingRaw);
    if (!settings) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    const originals = readOriginals(settings);
    const authOriginals = readAuthSnapshots(settings);
    // Without a snapshot there is nothing trustworthy to restore to. Guessing a
    // default upstream would clobber whatever a third-party tool (or the user)
    // had configured, so leave the file alone instead.
    if (!originals && !authOriginals) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    const modelProviders = asProviderMap(settings.modelProviders);
    let restored = 0;
    for (const original of originals?.providers ?? []) {
      for (const provider of modelProviders[original.provider] ?? []) {
        if (idOf(provider) !== original.id || provider.baseUrl === original.baseUrl) continue;
        provider.baseUrl = original.baseUrl;
        restored++;
      }
    }
    if (originals?.modelBaseUrl !== undefined) {
      const model = asRecord(settings.model);
      if (model && model.baseUrl !== originals.modelBaseUrl) {
        model.baseUrl = originals.modelBaseUrl;
        restored++;
      }
    }

    if (authOriginals) {
      for (const original of authOriginals.providers) {
        for (const provider of modelProviders[original.provider] ?? []) {
          if (idOf(provider) !== original.id) continue;
          restoreCustomHeaders(provider, original);
          restored++;
        }
      }
      const model = asRecord(settings.model);
      if (model && authOriginals.model) {
        restoreCustomHeaders(model, authOriginals.model);
        restored++;
      }
    }

    const next = JSON.stringify(withoutAuthOriginals(withoutOriginals(settings)), null, 2) + '\n';
    if (next === existingRaw) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    const backupPath = await this.backupExisting(targetPath, existingRaw);
    await fs.writeFile(targetPath, next, 'utf8');
    return { configPath: targetPath, backupPath, changed: true, providerCount: restored };
  }

  private async readOptional(targetPath: string): Promise<string> {
    try {
      return await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  private async backupExisting(targetPath: string, existing: string): Promise<string | undefined> {
    if (existing.length === 0) return undefined;
    const backupDir = path.join(path.dirname(targetPath), this.backupRootName);
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, path.basename(targetPath) + '.' + stamp + '.bak');
    await fs.writeFile(backupPath, existing, 'utf8');
    return backupPath;
  }
}

export function defaultQwenConfigPath(): string {
  return path.join(os.homedir(), '.qwen', 'settings.json');
}

/** Key under which KAI remembers the user's real upstreams for a clean restore. */
const ORIGINALS_KEY = '_kaiProxyOriginals';
const AUTH_ORIGINALS_KEY = '_kaiProxyOriginalAuthHeaders';

interface RecordedOriginals {
  providers: Array<{ provider: string; id: string; baseUrl: string }>;
  modelBaseUrl?: string;
}

interface AuthHeaderSnapshot {
  hadGenerationConfig: boolean;
  customHeaders: Record<string, unknown> | null;
}

interface ProviderAuthHeaderSnapshot extends AuthHeaderSnapshot {
  provider: string;
  id: string;
}

interface RecordedAuthHeaders {
  providers: ProviderAuthHeaderSnapshot[];
  model: AuthHeaderSnapshot | null;
}

/**
 * Qwen posts to `<baseUrl>/chat/completions`, so the `/v1` segment is part of
 * the base URL — without it every request lands on the proxy's 404 handler.
 */
function proxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/a/qwen/v1`;
}

/** Drop the snapshot key without a dynamic `delete` on a computed property. */
function withoutOriginals(settings: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== ORIGINALS_KEY) copy[key] = value;
  }
  return copy;
}

function withoutAuthOriginals(settings: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) if (key !== AUTH_ORIGINALS_KEY) copy[key] = value;
  return copy;
}

function readCustomHeaders(entry: Record<string, unknown>): AuthHeaderSnapshot {
  const generationConfig = asRecord(entry.generationConfig);
  const headers = generationConfig && asRecord(generationConfig.customHeaders);
  return {
    hadGenerationConfig: Boolean(generationConfig),
    customHeaders: headers ? { ...headers } : null,
  };
}

function setProxyAuthorization(entry: Record<string, unknown>, token: string): boolean {
  const generationConfig = asRecord(entry.generationConfig) ?? {};
  const customHeaders = asRecord(generationConfig.customHeaders) ?? {};
  const authorization = `Bearer ${token}`;
  if (customHeaders.Authorization === authorization) return false;
  entry.generationConfig = { ...generationConfig, customHeaders: { ...customHeaders, Authorization: authorization } };
  return true;
}

function restoreCustomHeaders(entry: Record<string, unknown>, snapshot: AuthHeaderSnapshot): void {
  const generationConfig = asRecord(entry.generationConfig);
  if (!generationConfig) return;
  const restored = { ...generationConfig };
  if (snapshot.customHeaders) restored.customHeaders = snapshot.customHeaders;
  else delete restored.customHeaders;
  if (!snapshot.hadGenerationConfig && Object.keys(restored).length === 0) delete entry.generationConfig;
  else entry.generationConfig = restored;
}

function readAuthSnapshots(settings: Record<string, unknown>): RecordedAuthHeaders | null {
  const raw = asRecord(settings[AUTH_ORIGINALS_KEY]);
  if (!raw) return null;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.flatMap((item): ProviderAuthHeaderSnapshot[] => {
      const value = asRecord(item);
      if (!value || typeof value.provider !== 'string' || typeof value.id !== 'string') return [];
      return [{ provider: value.provider, id: value.id, hadGenerationConfig: value.hadGenerationConfig === true, customHeaders: asRecord(value.customHeaders) ? { ...asRecord(value.customHeaders)! } : null }];
    })
    : [];
  const modelRaw = asRecord(raw.model);
  const model = modelRaw
    ? { hadGenerationConfig: modelRaw.hadGenerationConfig === true, customHeaders: asRecord(modelRaw.customHeaders) ? { ...asRecord(modelRaw.customHeaders)! } : null }
    : null;
  return { providers, model };
}

/** A base URL that already points at a local proxy, i.e. not a real upstream. */
function isLocalProxy(url: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url);
}

function parseSettings(raw: string): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Normalise `modelProviders` into { providerKey: [entries] } with object entries only. */
function asProviderMap(value: unknown): Record<string, Array<Record<string, unknown>>> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, providers] of Object.entries(record)) {
    if (!Array.isArray(providers)) continue;
    out[key] = providers
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  }
  return out;
}

function idOf(provider: Record<string, unknown>): string {
  const id = provider.id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
}

function nonProxyBaseUrl(model: Record<string, unknown>): string | undefined {
  const url = model.baseUrl;
  return typeof url === 'string' && !isLocalProxy(url) ? url : undefined;
}

function collectOriginals(
  modelProviders: Record<string, Array<Record<string, unknown>>>,
): Array<{ provider: string; id: string; baseUrl: string }> {
  const originals: Array<{ provider: string; id: string; baseUrl: string }> = [];
  for (const [providerKey, providers] of Object.entries(modelProviders)) {
    for (const provider of providers) {
      const baseUrl = provider.baseUrl;
      if (typeof baseUrl === 'string' && !isLocalProxy(baseUrl)) {
        originals.push({ provider: providerKey, id: idOf(provider), baseUrl });
      }
    }
  }
  return originals;
}

function countProxied(
  modelProviders: Record<string, Array<Record<string, unknown>>>,
  proxyUrl: string,
): number {
  let count = 0;
  for (const providers of Object.values(modelProviders)) {
    for (const provider of providers) {
      if (provider.baseUrl === proxyUrl) count++;
    }
  }
  return count;
}

function readOriginals(settings: Record<string, unknown>): RecordedOriginals | null {
  const raw = asRecord(settings[ORIGINALS_KEY]);
  if (!raw) return null;

  const providers: Array<{ provider: string; id: string; baseUrl: string }> = [];
  if (Array.isArray(raw.providers)) {
    for (const entry of raw.providers) {
      const record = asRecord(entry);
      if (!record || typeof record.provider !== 'string' || typeof record.baseUrl !== 'string') continue;
      providers.push({ provider: record.provider, id: idOf(record), baseUrl: record.baseUrl });
    }
  }
  const modelBaseUrl = typeof raw.modelBaseUrl === 'string' ? raw.modelBaseUrl : undefined;
  return { providers, modelBaseUrl };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
