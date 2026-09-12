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
   * Build the full config.toml.
   *
   * Layout:
   *   1. Top-level keys (model_provider, model, preferred_auth_method) so the
   *      VS Code Codex extension picks the proxy up without --profile.
   *   2. The original user config minus any previously-written KAI blocks.
   *   3. A [proxy.backup] table with the original model_provider / model so
   *      they can be restored on Stop.
   *   4. The KAI-managed [model_providers.<profile>] table. No [profiles.<name>]
   *      table: Codex 0.153+ rejects `--profile` while one is present, and the
   *      top-level keys above already select this provider.
   *
   * In TOML, top-level keys that appear AFTER any [table] header belong to that
   * table — so we MUST write them at the very top.
   */
  withProxyProfile(existing: string, config: CodexProxyConfig): string {
    // Save original model_provider / model so we can restore on Stop. Prefer
    // an existing proxy backup, then fall back to the user's top-level keys
    // after KAI-managed blocks have been removed.
    const existingBackup = readProxyBackup(existing);
    const stripped = stripProfileTables(existing, config.profile).trim();
    const { preamble, tables: userTables } = splitPreamble(stripped);
    const userTopLevel = readTopLevelRoutingKeys(preamble);
    const origProvider = existingBackup.provider ?? userTopLevel.provider;
    const origModel = existingBackup.model ?? userTopLevel.model;

    let backupBlock = '';
    if (origProvider && origProvider !== config.profile) {
      backupBlock += '[proxy.backup]\n';
      backupBlock += 'model_provider = "' + origProvider + '"\n';
    }
    if (origModel && origModel !== config.model) {
      if (!backupBlock) backupBlock += '[proxy.backup]\n';
      backupBlock += 'model = "' + origModel + '"\n';
    }

    const topLevel = codexTopLevelKeys(config.profile, config.model);
    const tables = codexProviderTables(config.profile, config.port);
    const cleanPreamble = stripTopLevelRoutingKeys(preamble).trim();

    const parts = [topLevel];
    if (cleanPreamble) parts.push(cleanPreamble);
    if (backupBlock) parts.push(backupBlock.trimEnd());
    if (userTables) parts.push(userTables);
    parts.push(tables);
    return parts.join('\n\n').trimEnd() + '\n';
  }

  /**
   * Remove the KAI-managed blocks and restore original model_provider / model
   * values from the [proxy.backup] table.
   */
  async restoreConfig(configPath?: string, profile?: string): Promise<{ configPath: string; changed: boolean }> {
    const targetPath = configPath ?? defaultCodexConfigPath();
    const profileName = profile ?? 'codeproxy';
    const existing = await this.readOptional(targetPath);

    // Detect managed configs by marker or bare table names (compatible with
    // configs written by claude-openai-proxy which uses no markers).
    const isManaged = existing.includes('# >>> KAI codex-' + profileName)
      || new RegExp('\\[(?:model_providers|profiles)\\.' + escapeRegex(profileName) + '\\]').test(existing);
    if (!isManaged) {
      return { configPath: targetPath, changed: false };
    }

    const backup = readProxyBackup(existing);
    let stripped = stripProfileTables(existing, profileName);

    // Remove top-level keys we wrote (use profileName variable, not hardcoded string)
    const topLevelRegex = new RegExp(
      '^model_provider\\s*=\\s*"' + escapeRegex(profileName) + '"\\s*\\n'
      + 'model\\s*=\\s*"[^"]*"\\s*\\n'
      + '(?:preferred_auth_method\\s*=\\s*"apikey"\\s*\\n)?',
      'gm'
    );
    stripped = stripped.replace(topLevelRegex, '');
    stripped = stripped.replace(/^preferred_auth_method\s*=\s*"apikey"\s*\n/gm, '');

    stripped = stripBackupBlock(stripped);

    if (backup.provider || backup.model) {
      stripped = (backup.provider ? 'model_provider = "' + backup.provider + '"\n' : '')
        + (backup.model ? 'model = "' + backup.model + '"\n' : '')
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
 * Top-level keys placed at the very top of config.toml.
 * These are picked up by the VS Code Codex extension without --profile.
 *
 * The placeholder model (e.g. "gpt-5.5") is a name Codex accepts client-side.
 * The proxy maps it to the real target model (e.g. deepseek-v4-pro) via
 * codexConfig.defaultModel.
 *
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

/** The provider table the top-level `model_provider` key selects. */
function codexProviderTables(profile: string, port: number): string {
  return [
    '# >>> KAI codex-' + profile,
    '[model_providers.' + profile + ']',
    'name = "KAI Proxy"',
    'base_url = "http://127.0.0.1:' + port + '/v1"',
    'wire_api = "responses"',
    '# <<< KAI codex-' + profile
  ].join('\n');
}

/** Split a TOML document into its top-level preamble and table body. */
function splitPreamble(toml: string): { preamble: string; tables: string } {
  const lines = toml.split(/\r?\n/);
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  if (firstTable === -1) return { preamble: toml, tables: '' };
  return {
    preamble: lines.slice(0, firstTable).join('\n'),
    tables: lines.slice(firstTable).join('\n'),
  };
}

/** Read the user's routing keys from a top-level preamble only. */
function readTopLevelRoutingKeys(preamble: string): { provider?: string; model?: string } {
  return {
    provider: preamble.match(/^\s*model_provider\s*=\s*"([^"]*)"/m)?.[1],
    model: preamble.match(/^\s*model\s*=\s*"([^"]*)"/m)?.[1],
  };
}

/** Remove routing keys that KAI owns so they cannot be duplicated. */
function stripTopLevelRoutingKeys(preamble: string): string {
  return preamble
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:model_provider|model|preferred_auth_method)\s*=/.test(line))
    .join('\n');
}

/** Read original routing values from KAI's inline backup table. */
function readProxyBackup(toml: string): { provider?: string; model?: string } {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*\[proxy\.backup\]\s*$/.test(line));
  if (start === -1) return {};
  const table: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    table.push(lines[i]);
  }
  const body = table.join('\n');
  return {
    provider: body.match(/^\s*model_provider\s*=\s*"([^"]*)"/m)?.[1],
    model: body.match(/^\s*model\s*=\s*"([^"]*)"/m)?.[1],
  };
}

/**
 * Remove KAI-managed blocks (top-level markers + tables with markers) and any
 * bare tables written without markers (compatible with claude-openai-proxy configs).
 * Also strips [proxy.backup] table.
 */
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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!skipping && line === block.start) {
        // Only treat this as a managed block if it is actually terminated.
        // Another tool can strip the closing marker and leave ours dangling;
        // skipping to a partner that never arrives would delete every line
        // from here to EOF. Drop the stray marker, keep the tail.
        const terminated = lines.slice(i + 1).some(l => l.trim() === block.end);
        if (!terminated) continue;
        skipping = true;
        continue;
      }
      if (skipping) {
        if (line === block.end) { skipping = false; }
        continue;
      }
      kept.push(lines[i]);
    }
    result = kept.join('\n');
  }

  // Also strip bare table sections written without markers
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

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
