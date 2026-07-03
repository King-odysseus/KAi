import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface ClaudeProxyConfig {
  configPath?: string;
  port: number;
}

export interface ClaudeProxyConfigResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
}

/** Proxy env vars injected into ~/.claude/settings.json so Claude Code
 *  routes through the proxy. The proxy supplies the real upstream key. */
const PROXY_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: '',
  ANTHROPIC_AUTH_TOKEN: 'sk-ant-proxy-placeholder-000000000000000000000000000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '3000000',
};

export class ClaudeConfigWriter {
  constructor(private readonly backupRootName = '.kai-backups') {}

  async ensureProxyConfig(config: ClaudeProxyConfig): Promise<ClaudeProxyConfigResult> {
    const configPath = config.configPath ?? defaultClaudeConfigPath();
    const existingRaw = await this.readOptional(configPath);

    const env: Record<string, string> = {
      ...PROXY_ENV,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + config.port,
    };

    const next = this.upsertEnv(existingRaw, env);
    if (existingRaw === next) {
      return { configPath, changed: false };
    }

    const backupPath = await this.backupExisting(configPath, existingRaw);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, next, 'utf8');
    return { configPath, backupPath, changed: true };
  }

  async restoreConfig(configPath?: string): Promise<ClaudeProxyConfigResult> {
    const targetPath = configPath ?? defaultClaudeConfigPath();
    const existingRaw = await this.readOptional(targetPath);
    const next = this.removeManagedBlock(existingRaw);
    if (existingRaw === next) {
      return { configPath: targetPath, changed: false };
    }
    const backupPath = await this.backupExisting(targetPath, existingRaw);
    await fs.writeFile(targetPath, next, 'utf8');
    return { configPath: targetPath, backupPath, changed: true };
  }

  upsertEnv(raw: string, env: Record<string, string>): string {
    const settings = raw.trim().length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
    const existingEnv = (settings.env as Record<string, string> | undefined) ?? {};
    const merged = { ...existingEnv, ...env };
    settings.env = merged;
    return JSON.stringify(settings, null, 2) + '\n';
  }

  removeManagedBlock(raw: string): string {
    if (raw.trim().length === 0) return raw;
    try {
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (settings.env) {
        const env = settings.env as Record<string, string>;
        for (const key of Object.keys(PROXY_ENV)) {
          delete env[key];
        }
        if (Object.keys(env).length === 0) {
          delete settings.env;
        }
      }
      if (Object.keys(settings).length === 0) {
        return '';
      }
      return JSON.stringify(settings, null, 2) + '\n';
    } catch {
      return raw;
    }
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

export function defaultClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
