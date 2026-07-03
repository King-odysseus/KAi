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

  /**
   * Build the full config.toml with:
   *   1. Top-level keys so the VS Code Codex extension picks the proxy up
   *      (model_provider, model, preferred_auth_method).
   *   2. The KAI-managed [model_providers.<profile>] and [profiles.<profile>] tables,
   *      used by codex --profile <profile> (CLI mode).
   *
   * In TOML, top-level keys that appear AFTER any [table] header belong to that
   * table — so we MUST write them at the very top. Tables are self-contained and
   * can safely go after.
   */
  withProxyProfile(existing: string, config: CodexProxyConfig): string {
    const stripped = stripProfileTables(existing, config.profile).trim();
    const topLevel = codexTopLevelKeys(config.profile, config.model);
    const tables = codexProviderTables(config.profile, config.port, config.model);
    return topLevel + '\n\n'
      + (stripped ? stripped + '\n\n' : '')
      + tables + '\n';
  }

  /**
   * Remove the KAI-managed blocks and restore any previously backed-up
   * original top-level model_provider / model values.
   */
  async restoreConfig(configPath?: string, profile?: string): Promise<{ configPath: string; changed: boolean }> {
    const targetPath = configPath ?? defaultCodexConfigPath();
    const profileName = profile ?? 'codeproxy';
    const existing = await this.readOptional(targetPath);
    if (!existing.includes('# >>> KAI codex-' + profileName)) {
      return { configPath: targetPath, changed: false };
    }

    let stripped = stripProfileTables(existing, profileName);
    // Remove top-level keys we wrote
    stripped = stripped
      .replace(/^model_provider\s*=\s*"codeproxy"\s*\nmodel\s*=\s*"[^"]*"\s*\n(?:preferred_auth_method\s*=\s*"apikey"\s*\n)?/gm, '')
      .replace(/^preferred_auth_method\s*=\s*"apikey"\s*\n/gm, '');

    // Restore original provider/model from backup block if present
    const backupProvider = existing.match(new RegExp(
      '\\[proxy\\.backup\\][^\\[]*model_provider\\s*=\\s*"([^"]*)"', 's'
    ))?.[1];
    const backupModel = existing.match(new RegExp(
      '\\[proxy\\.backup\\][^\\[]*model\\s*=\\s*"([^"]*)"', 's'
    ))?.[1];
    stripped = stripBackupBlock(stripped);

    if (backupProvider) {
      stripped = 'model_provider = "' + backupProvider + '"\n'
        + (backupModel ? 'model = "' + backupModel + '"\n' : '')
        + '\n' + stripped;
    }

    stripped = stripped.replace(/\n{3,}/g, '\n\n').trim();
    const next = stripped ? stripped + '\n' : '';
    if (existing === next) {
      return { configPath: targetPath, changed: false };
    }

    const backupPath = await this.backupExisting(targetPath, existing);
    await fs.writeFile(targetPath, next, 'utf8');
    return { configPath: targetPath, changed: true };
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
    const backupPath = path.join(backupDir, path.basename(targetPath) + '.' + stamp + '.bak');
    await fs.writeFile(backupPath, existing, 'utf8');
    return backupPath;
  }
}

export function defaultCodexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

// ---- TOML helpers ----

/**
 * Top-level keys placed at the very top of config.toml — picked up by the
 * VS Code Codex extension (no --profile needed).
 *   model_provider = "codeproxy"
 *   model = "gpt-5.5"
 *   preferred_auth_method = "apikey"
 *
 * The placeholder model (e.g. "gpt-5.5") is a name Codex accepts client-side.
 * The proxy maps it to the real target model (e.g. deepseek-v4-pro).
 * preferred_auth_method = "apikey" makes Codex use the provider key without
 * signing out of ChatGPT — removed on restore so the login path resumes.
 */
function codexTopLevelKeys(profile: string, model: string): string {
  const lines = [
    '# >>> KAI top-level',
    'model_provider = "' + profile + '"',
    'model = "' + model + '"',
    'preferred_auth_method = "apikey"',
    '# <<< KAI top-level',
  ];
  return lines.join('\n');
}

/** Provider + profile tables — used by codex --profile <profile> (CLI). */
function codexProviderTables(profile: string, port: number, model: string): string {
  return [
    '# >>> KAI codex-' + profile,
    '[model_providers.' + profile + ']',
    'name = "KAI Proxy"',
    'base_url = "http://127.0.0.1:' + port + '/v1"',
    'wire_api = "responses"',
    '',
    '[profiles.' + profile + ']',
    'model = "' + model + '"',
    'model_provider = "' + profile + '"',
    '# <<< KAI codex-' + profile
  ].join('\n');
}

/** Remove KAI-managed blocks (top-level + tables) and any backup block. */
function stripProfileTables(toml: string, profile: string): string {
  const managedBlocks = [
    { start: '# >>> KAI top-level', end: '# <<< KAI top-level' },
    { start: '# >>> KAI codex-' + profile, end: '# <<< KAI codex-' + profile },
  ];

  let result = toml;
  for (const block of managedBlocks) {
    const lines = result.split(/\r?\n/);
    const kept: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (line.trim() === block.start) { skipping = true; continue; }
      if (skipping) {
        if (line.trim() === block.end) { skipping = false; }
        continue;
      }
      kept.push(line);
    }
    result = kept.join('\n');
  }

  // Also strip bare table sections that may have been written without markers
  const lines = result.split(/\r?\n/);
  const kept: string[] = [];
  let skippingTable = false;
  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      const tableName = tableMatch[1];
      skippingTable = tableName === 'model_providers.' + profile
        || tableName === 'profiles.' + profile
        || tableName === 'proxy.backup';
    }
    if (!skippingTable) {
      kept.push(line);
    }
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Remove any [proxy.backup] table block. */
function stripBackupBlock(toml: string): string {
  return toml.replace(/^[ \t]*\[proxy\.backup\][^\[]*/gm, '');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
