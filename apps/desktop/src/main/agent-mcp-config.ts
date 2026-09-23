import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PLAYWRIGHT_MCP_FEATURE_ID,
  PLAYWRIGHT_MCP_SERVER_ID,
  type AppSettings,
  type McpServerSettings,
} from '@kai/contracts';

const PLAYWRIGHT_CLI_SERVER_NAME = 'playwright';
const PLAYWRIGHT_CLI_COMMAND = 'npx';
const PLAYWRIGHT_ARGS = ['-y', '@playwright/mcp@latest'];

export type CliAgentId = 'claude' | 'codex' | 'qwen' | 'gemini';

export interface AgentMcpInstallResult {
  agent: CliAgentId;
  configPath: string;
  changed: boolean;
  backupPath?: string;
  error?: string;
}

export interface AgentMcpInstallOptions {
  homeDirectory?: string;
  backupRootName?: string;
}

export interface PlaywrightMcpPreparationOptions extends AgentMcpInstallOptions {
  platform?: NodeJS.Platform;
}

export interface PlaywrightMcpPreparation {
  settings: AppSettings;
  changed: boolean;
  agentsInstalled: boolean;
  cliResults: AgentMcpInstallResult[];
}

export function withPlaywrightMcpSetting(
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform,
): { settings: AppSettings; changed: boolean } {
  const desired = playwrightDesktopServer(platform);
  const index = settings.mcpServers.findIndex((server) => server.id === PLAYWRIGHT_MCP_SERVER_ID);
  if (index < 0) {
    return {
      settings: { ...settings, mcpServers: [...settings.mcpServers, desired] },
      changed: true,
    };
  }

  const existing = settings.mcpServers[index];
  const normalized = normalizeDesktopStdioServer(existing, platform);
  if (normalized === existing) return { settings, changed: false };
  const mcpServers = [...settings.mcpServers];
  mcpServers[index] = normalized;
  return { settings: { ...settings, mcpServers }, changed: true };
}

export function withInstalledFeature(
  settings: AppSettings,
  featureId: string,
): { settings: AppSettings; changed: boolean } {
  if (settings.installedFeatures.includes(featureId)) return { settings, changed: false };
  return {
    settings: { ...settings, installedFeatures: [...settings.installedFeatures, featureId] },
    changed: true,
  };
}

export async function preparePlaywrightMcpSettings(
  settings: AppSettings,
  options: PlaywrightMcpPreparationOptions = {},
): Promise<PlaywrightMcpPreparation> {
  const desktop = withPlaywrightMcpSetting(settings, options.platform);
  const alreadyInstalled = desktop.settings.installedFeatures.includes(PLAYWRIGHT_MCP_FEATURE_ID);
  const cliResults = alreadyInstalled
    ? []
    : await installPlaywrightMcpForAgents(options);
  const agentsInstalled = alreadyInstalled || cliResults.every((result) => !result.error);
  let next = desktop.settings;
  let changed = desktop.changed;

  if (!alreadyInstalled && agentsInstalled) {
    const marked = withInstalledFeature(next, PLAYWRIGHT_MCP_FEATURE_ID);
    next = marked.settings;
    changed ||= marked.changed;
  }

  return { settings: next, changed, agentsInstalled, cliResults };
}

export async function installPlaywrightMcpForAgents(
  options: AgentMcpInstallOptions = {},
): Promise<AgentMcpInstallResult[]> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const backupRootName = options.backupRootName ?? '.kai-backups';
  return Promise.all([
    installJsonMcp('claude', path.join(homeDirectory, '.claude.json'), backupRootName),
    installCodexMcp(path.join(homeDirectory, '.codex', 'config.toml'), backupRootName),
    installJsonMcp('qwen', path.join(homeDirectory, '.qwen', 'settings.json'), backupRootName),
    installJsonMcp('gemini', path.join(homeDirectory, '.gemini', 'settings.json'), backupRootName),
  ]);
}

function playwrightDesktopServer(platform: NodeJS.Platform): McpServerSettings {
  if (platform === 'win32') {
    return {
      id: PLAYWRIGHT_MCP_SERVER_ID,
      name: 'Playwright Browser',
      enabled: true,
      transport: 'stdio',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx -y @playwright/mcp@latest'],
      cwd: null,
      envCredentialIds: {},
    };
  }
  return {
    id: PLAYWRIGHT_MCP_SERVER_ID,
    name: 'Playwright Browser',
    enabled: true,
    transport: 'stdio',
    command: PLAYWRIGHT_CLI_COMMAND,
    args: [...PLAYWRIGHT_ARGS],
    cwd: null,
    envCredentialIds: {},
  };
}

function normalizeDesktopStdioServer(
  server: McpServerSettings,
  platform: NodeJS.Platform,
): McpServerSettings {
  if (platform !== 'win32' || server.transport !== 'stdio' || server.command !== PLAYWRIGHT_CLI_COMMAND) {
    return server;
  }
  return {
    ...server,
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [PLAYWRIGHT_CLI_COMMAND, ...server.args].map(quoteCmdArgument).join(' ')],
  };
}

function quoteCmdArgument(argument: string): string {
  if (!argument) return '""';
  if (!/[\s"&|<>^()%!]/.test(argument)) return argument;
  return `"${argument.replace(/(["^&|<>()%!])/g, '^$1')}"`;
}

async function installJsonMcp(
  agent: Exclude<CliAgentId, 'codex'>,
  configPath: string,
  backupRootName: string,
): Promise<AgentMcpInstallResult> {
  try {
    const existing = await readOptional(configPath);
    const parsed = existing.trim() ? JSON.parse(existing) as unknown : {};
    if (!isRecord(parsed)) throw new Error('The agent configuration root must be a JSON object.');
    const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
    if (!isRecord(servers)) throw new Error('The mcpServers field must be a JSON object.');
    if (PLAYWRIGHT_CLI_SERVER_NAME in servers) {
      return { agent, configPath, changed: false };
    }
    const next = {
      ...parsed,
      mcpServers: {
        ...servers,
        [PLAYWRIGHT_CLI_SERVER_NAME]: {
          command: PLAYWRIGHT_CLI_COMMAND,
          args: [...PLAYWRIGHT_ARGS],
        },
      },
    };
    const backupPath = await backupExisting(configPath, existing, backupRootName);
    await writeText(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return { agent, configPath, changed: true, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return { agent, configPath, changed: false, error: messageOf(error) };
  }
}

async function installCodexMcp(
  configPath: string,
  backupRootName: string,
): Promise<AgentMcpInstallResult> {
  try {
    const existing = await readOptional(configPath);
    if (/^\s*\[mcp_servers\.playwright(?:\.[^\]]+)?\]\s*$/m.test(existing)) {
      return { agent: 'codex', configPath, changed: false };
    }
    const block = [
      '# >>> KAI playwright MCP',
      '[mcp_servers.playwright]',
      `command = "${PLAYWRIGHT_CLI_COMMAND}"`,
      'args = ["-y", "@playwright/mcp@latest"]',
      '# <<< KAI playwright MCP',
    ].join('\n');
    const separator = existing.trim() ? '\n\n' : '';
    const next = `${existing.trimEnd()}${separator}${block}\n`;
    const backupPath = await backupExisting(configPath, existing, backupRootName);
    await writeText(configPath, next);
    return { agent: 'codex', configPath, changed: true, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return { agent: 'codex', configPath, changed: false, error: messageOf(error) };
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return '';
    throw error;
  }
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function backupExisting(
  filePath: string,
  existing: string,
  backupRootName: string,
): Promise<string | undefined> {
  if (!existing) return undefined;
  const backupDirectory = path.join(path.dirname(filePath), backupRootName);
  await fs.mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `${path.basename(filePath)}.${stamp}.bak`);
  await fs.writeFile(backupPath, existing, 'utf8');
  return backupPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
