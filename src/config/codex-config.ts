import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface CodexProxyConfig {
  configPath?: string;
  profile: string;
  port: number;
  model: string;
}

export interface CodexProxyConfigResult {
  configPath: string;
  backupPath?: string;
  changed: boolean;
  profile: string;
}

export class CodexConfigWriter {
  constructor(private readonly backupRootName = '.kai-backups') {}

  async ensureProxyProfile(config: CodexProxyConfig): Promise<CodexProxyConfigResult> {
    const configPath = config.configPath ?? defaultCodexConfigPath();
    const existing = await this.readOptional(configPath);
    const next = this.withProxyProfile(existing, config);

    if (existing === next) {
      return { configPath, changed: false, profile: config.profile };
    }

    const backupPath = await this.backupExisting(configPath, existing);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, next, 'utf8');

    return { configPath, backupPath, changed: true, profile: config.profile };
  }

  withProxyProfile(existing: string, config: CodexProxyConfig): string {
    const stripped = stripProfileTables(existing, config.profile).trim();
    const block = codexProviderTables(config.profile, config.port, config.model);
    return `${stripped ? `${stripped}\n\n` : ''}${block}\n`;
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
    if (existing.length === 0) {
      return undefined;
    }

    const backupDir = path.join(path.dirname(targetPath), this.backupRootName);
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${path.basename(targetPath)}.${stamp}.bak`);
    await fs.writeFile(backupPath, existing, 'utf8');
    return backupPath;
  }
}

export function defaultCodexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function codexProviderTables(profile: string, port: number, model: string): string {
  return [
    `# >>> KAI codex-${profile}`,
    `[model_providers.${profile}]`,
    'name = "KAI Proxy"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    '',
    `[profiles.${profile}]`,
    `model = "${model}"`,
    `model_provider = "${profile}"`,
    `# <<< KAI codex-${profile}`
  ].join('\n');
}

function stripProfileTables(toml: string, profile: string): string {
  const managedStart = `# >>> KAI codex-${profile}`;
  const managedEnd = `# <<< KAI codex-${profile}`;
  const lines = toml.split(/\r?\n/);
  const kept: string[] = [];
  let skippingManagedBlock = false;
  let skippingTable = false;

  for (const line of lines) {
    if (line.trim() === managedStart) {
      skippingManagedBlock = true;
      continue;
    }
    if (skippingManagedBlock) {
      if (line.trim() === managedEnd) {
        skippingManagedBlock = false;
      }
      continue;
    }

    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      const tableName = tableMatch[1];
      skippingTable = tableName === `model_providers.${profile}` || tableName === `profiles.${profile}`;
      if (skippingTable) {
        continue;
      }
    }

    if (!skippingTable) {
      kept.push(line);
    }
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
