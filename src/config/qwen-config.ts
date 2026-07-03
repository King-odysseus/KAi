import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface QwenProxyConfig {
  configPath?: string;
  port: number;
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

    if (existingRaw.trim().length === 0) {
      return { configPath, changed: false, providerCount: 0 };
    }

    const proxyUrl = 'http://localhost:' + config.port;
    const settings = JSON.parse(existingRaw) as Record<string, unknown>;

    const modelProviders = settings.modelProviders as Record<string, Array<Record<string, unknown>>> | undefined;
    if (!modelProviders) {
      return { configPath, changed: false, providerCount: 0 };
    }

    const originals: Array<{ provider: string; id: string; baseUrl: string }> = [];
    let changed = false;

    for (const [providerKey, providers] of Object.entries(modelProviders)) {
      for (const p of providers) {
        if (typeof p.baseUrl === 'string' && !p.baseUrl.includes('localhost')) {
          originals.push({ provider: providerKey, id: p.id as string, baseUrl: p.baseUrl });
          p.baseUrl = proxyUrl;
          changed = true;
        }
      }
    }

    if (!changed) {
      return { configPath, changed: false, providerCount: 0 };
    }

    const next = JSON.stringify(settings, null, 2) + '\n';
    const backupPath = await this.backupExisting(configPath, existingRaw);
    await fs.writeFile(configPath, next, 'utf8');
    return { configPath, backupPath, changed: true, providerCount: originals.length };
  }

  async restoreConfig(configPath?: string): Promise<QwenProxyConfigResult> {
    const targetPath = configPath ?? defaultQwenConfigPath();
    const existingRaw = await this.readOptional(targetPath);
    if (existingRaw.trim().length === 0) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(existingRaw) as Record<string, unknown>;
    } catch {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    // We cannot reliably restore originals without stored metadata,
    // so restoreConfig is best-effort. The caller is responsible for
    // tracking originals if full round-trip is required.
    const modelProviders = settings.modelProviders as Record<string, Array<Record<string, unknown>>> | undefined;
    if (!modelProviders) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    let restored = 0;
    for (const providers of Object.values(modelProviders)) {
      for (const p of providers) {
        if (typeof p.baseUrl === 'string' && p.baseUrl.includes('localhost')) {
          // Best-effort: restore to common Qwen defaults
          p.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
          restored++;
        }
      }
    }

    if (restored === 0) {
      return { configPath: targetPath, changed: false, providerCount: 0 };
    }

    const next = JSON.stringify(settings, null, 2) + '\n';
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
