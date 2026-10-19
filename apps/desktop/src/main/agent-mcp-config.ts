import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  KAI_TERMINAL_CREDENTIAL_ID,
  KAI_TERMINAL_MCP_SERVER_ID,
  OPENPENCIL_CREDENTIAL_ID,
  OPENPENCIL_ENDPOINT,
  OPENPENCIL_MCP_SERVER_ID,
  PLAYWRIGHT_MCP_FEATURE_ID,
  PLAYWRIGHT_MCP_SERVER_ID,
  type AppSettings,
  type McpServerSettings,
} from '@kai/contracts';

const PLAYWRIGHT_CLI_SERVER_NAME = 'playwright';
const PLAYWRIGHT_CLI_COMMAND = 'npx';
const PLAYWRIGHT_ARGS = ['-y', '@playwright/mcp@latest'];
export const COGNITIVE1_CLI_SERVER_NAME = 'cognitive1';
export const KAI_PROJECT_CLI_SERVER_NAME = 'kai-project';
export const KAI_TERMINAL_CLI_SERVER_NAME = KAI_TERMINAL_MCP_SERVER_ID;

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
  /** False writes the entry without first copying the file it is in. Default true. */
  backups?: boolean;
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

export interface Cognitive1McpInstallOptions extends AgentMcpInstallOptions {
  endpoint: string;
  token: string;
}

export interface KaiProjectMcpInstallOptions extends AgentMcpInstallOptions {
  /** The bundled `kai-project` server script the agent launches. */
  serverPath: string;
  /** The one project the server is scoped to. */
  projectRoot: string;
  /** What runs the script: `node` in development, the Electron binary (`ELECTRON_RUN_AS_NODE`) once packaged. */
  command: string;
  /** Extra arguments before the script path, for instance `-e` or nothing at all. */
  leadingArgs?: string[];
  /** Environment the script needs, such as `ELECTRON_RUN_AS_NODE`. */
  env?: Record<string, string>;
}

export interface Cognitive1McpAccess {
  endpoint: string;
  token: string;
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

/**
 * open-pencil as a server KAI itself can call. Its endpoint and Bearer token are settings rather than a token
 * written into a config file: the runtime reads the vault when it connects, so the value never reaches disk.
 */
export function withOpenPencilMcpSetting(
  settings: AppSettings,
  options: { endpoint?: string; credentialId?: string; enabled?: boolean; noAuth?: boolean } = {},
): { settings: AppSettings; changed: boolean } {
  const desired: McpServerSettings = {
    id: OPENPENCIL_MCP_SERVER_ID,
    name: 'open-pencil (design)',
    enabled: options.enabled ?? true,
    transport: 'http',
    url: options.endpoint ?? OPENPENCIL_ENDPOINT,
    // The vault holds the whole header value ("Bearer <token>"), which is what the runtime sends as-is. Left
    // empty when the editor is running with auth off (no token to hold), so no Authorization header is sent.
    headerCredentialIds: options.noAuth ? {} : { Authorization: options.credentialId ?? OPENPENCIL_CREDENTIAL_ID },
  };
  const index = settings.mcpServers.findIndex((server) => server.id === OPENPENCIL_MCP_SERVER_ID);
  if (index < 0) return { settings: { ...settings, mcpServers: [...settings.mcpServers, desired] }, changed: true };
  // An entry the user edited by hand is left alone; only one that drifted from what we install is rewritten.
  const existing = settings.mcpServers[index];
  if (sameJson(existing, desired)) return { settings, changed: false };
  const mcpServers = [...settings.mcpServers];
  mcpServers[index] = desired;
  return { settings: { ...settings, mcpServers }, changed: true };
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
  return installMcpForAgents(PLAYWRIGHT_CLI_SERVER_NAME, () => ({
    claude: { command: PLAYWRIGHT_CLI_COMMAND, args: [...PLAYWRIGHT_ARGS] },
    qwen: { command: PLAYWRIGHT_CLI_COMMAND, args: [...PLAYWRIGHT_ARGS] },
    gemini: { command: PLAYWRIGHT_CLI_COMMAND, args: [...PLAYWRIGHT_ARGS] },
  }), [
    '[mcp_servers.playwright]',
    `command = "${PLAYWRIGHT_CLI_COMMAND}"`,
    'args = ["-y", "@playwright/mcp@latest"]',
  ], options);
}

/**
 * Points every CLI at the one shared Playwright browser KAI runs, in place of the server each would start for itself.
 * The entry keeps the name `playwright`, so the tools an agent sees and the prompts that mention them do not change;
 * only where they connect to does. No token: the server answers on the loopback only, and the shared browser it
 * drives is the one on screen. Rewritten without a backup — the entry is KAI's own, and the file it sits in is one a
 * running agent also writes, so a copy of it on every launch would be a pile of stale ones.
 */
export async function installPlaywrightSharedMcpForAgents(
  options: { endpoint: string } & AgentMcpInstallOptions,
): Promise<AgentMcpInstallResult[]> {
  const { endpoint } = options;
  return installMcpForAgents(PLAYWRIGHT_CLI_SERVER_NAME, () => ({
    claude: { type: 'http', url: endpoint },
    qwen: { httpUrl: endpoint },
    gemini: { httpUrl: endpoint },
  }), [
    `[mcp_servers.${PLAYWRIGHT_CLI_SERVER_NAME}]`,
    `url = "${escapeTomlString(endpoint)}"`,
  ], { ...options, backups: false });
}

/**
 * KAI's own Playwright entry: the shared server when there is one, the per-process server it used to start when
 * there is not. Going back matters as much as going forward: an entry left pointing at a server that failed to start
 * would leave every screen check with a browser it cannot reach.
 */
export function withPlaywrightMcpEndpoint(
  settings: AppSettings,
  endpoint: string | null,
  platform: NodeJS.Platform = process.platform,
): { settings: AppSettings; changed: boolean } {
  const index = settings.mcpServers.findIndex((server) => server.id === PLAYWRIGHT_MCP_SERVER_ID);
  const existing = index >= 0 ? settings.mcpServers[index] : undefined;
  const base = playwrightDesktopServer(platform);
  // A person who turned the server off, or renamed it, keeps that choice whichever way it is pointed.
  const kept = existing ? { name: existing.name, enabled: existing.enabled } : { name: base.name, enabled: base.enabled };
  const desired: McpServerSettings = endpoint
    ? { id: PLAYWRIGHT_MCP_SERVER_ID, ...kept, transport: 'http', url: endpoint, headerCredentialIds: {} }
    : existing && existing.transport === 'stdio'
      ? existing
      : { ...base, ...kept };
  if (existing && sameJson(existing, desired)) return { settings, changed: false };
  const mcpServers = [...settings.mcpServers];
  if (index >= 0) mcpServers[index] = desired;
  else mcpServers.push(desired);
  return { settings: { ...settings, mcpServers }, changed: true };
}

/** Keep the managed Cognitive1 HTTP MCP endpoint available to every supported CLI. */
export async function installCognitive1McpForAgents(
  options: Cognitive1McpInstallOptions,
): Promise<AgentMcpInstallResult[]> {
  const endpoint = cognitive1McpEndpoint(options.endpoint);
  const authorization = `Bearer ${options.token}`;
  return installMcpForAgents(COGNITIVE1_CLI_SERVER_NAME, () => ({
    claude: { type: 'http', url: endpoint, headers: { Authorization: authorization } },
    qwen: { httpUrl: endpoint, headers: { Authorization: authorization } },
    gemini: { httpUrl: endpoint, headers: { Authorization: authorization } },
  }), [
    '[mcp_servers.cognitive1]',
    `url = "${escapeTomlString(endpoint)}"`,
    `http_headers = { Authorization = "${escapeTomlString(authorization)}" }`,
  ], options);
}

/**
 * Keep KAI's own board MCP server available to the CLI agents. The server is a script this app ships, scoped to one
 * project with `--project`, and every tool it exposes goes through the studio's stores — so an outside agent works
 * the same board under the same rules and cannot mark a card done that has not passed its checks.
 */
export async function installKaiProjectMcpForAgents(
  options: KaiProjectMcpInstallOptions,
): Promise<AgentMcpInstallResult[]> {
  const serverName = KAI_PROJECT_CLI_SERVER_NAME;
  const args = [...(options.leadingArgs ?? []), options.serverPath, '--project', options.projectRoot];
  const env = options.env ?? {};
  const jsonEntry = { command: options.command, args: [...args], ...(Object.keys(env).length > 0 ? { env } : {}) };
  return installMcpForAgents(serverName, () => ({
    claude: { ...jsonEntry },
    qwen: { ...jsonEntry },
    gemini: { ...jsonEntry },
  }), [
    `[mcp_servers.${serverName}]`,
    `command = "${escapeTomlString(options.command)}"`,
    `args = [${args.map((argument) => `"${escapeTomlString(argument)}"`).join(', ')}]`,
    ...(Object.keys(env).length > 0
      ? [`env = { ${Object.entries(env).map(([key, value]) => `${key} = "${escapeTomlString(value)}"`).join(', ')} }`]
      : []),
  ], options);
}

/**
 * KAI's terminal as a server KAI itself can call: the endpoint is the one the desktop app hosts this launch, and the
 * token sits in the vault, never in settings.
 */
export function withKaiTerminalMcpSetting(
  settings: AppSettings,
  options: { endpoint: string; credentialId?: string },
): { settings: AppSettings; changed: boolean } {
  const desired: McpServerSettings = {
    id: KAI_TERMINAL_MCP_SERVER_ID,
    name: 'KAI terminal',
    enabled: true,
    transport: 'http',
    url: options.endpoint,
    headerCredentialIds: { Authorization: options.credentialId ?? KAI_TERMINAL_CREDENTIAL_ID },
  };
  const index = settings.mcpServers.findIndex((server) => server.id === KAI_TERMINAL_MCP_SERVER_ID);
  if (index < 0) return { settings: { ...settings, mcpServers: [...settings.mcpServers, desired] }, changed: true };
  if (sameJson(settings.mcpServers[index], desired)) return { settings, changed: false };
  const mcpServers = [...settings.mcpServers];
  mcpServers[index] = desired;
  return { settings: { ...settings, mcpServers }, changed: true };
}

/**
 * Offers KAI's terminal to the CLI agents. They would otherwise use whatever shell they bring, or open a window of
 * their own; with this they can run commands in a session the terminal dock shows. The endpoint and token change on
 * every launch, so the entry is rewritten on every launch.
 */
export async function installKaiTerminalMcpForAgents(
  options: { endpoint: string; authorization: string } & AgentMcpInstallOptions,
): Promise<AgentMcpInstallResult[]> {
  const { endpoint, authorization } = options;
  return installMcpForAgents(KAI_TERMINAL_CLI_SERVER_NAME, () => ({
    claude: { type: 'http', url: endpoint, headers: { Authorization: authorization } },
    qwen: { httpUrl: endpoint, headers: { Authorization: authorization } },
    gemini: { httpUrl: endpoint, headers: { Authorization: authorization } },
  }), [
    `[mcp_servers.${KAI_TERMINAL_CLI_SERVER_NAME}]`,
    `url = "${escapeTomlString(endpoint)}"`,
    `http_headers = { Authorization = "${escapeTomlString(authorization)}" }`,
  ], options);
}

export async function syncCognitive1Mcp(
  access: () => Promise<Cognitive1McpAccess>,
  options: AgentMcpInstallOptions = {},
): Promise<AgentMcpInstallResult[]> {
  return installCognitive1McpForAgents({ ...await access(), ...options });
}

async function installMcpForAgents(
  serverName: string,
  jsonEntry: () => Record<Exclude<CliAgentId, 'codex'>, unknown>,
  codexEntry: string[],
  options: AgentMcpInstallOptions,
): Promise<AgentMcpInstallResult[]> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const backupRootName = options.backups === false ? null : options.backupRootName ?? '.kai-backups';
  const jsonEntries = jsonEntry();
  return Promise.all([
    reconcileJsonMcp('claude', path.join(homeDirectory, '.claude.json'), serverName, jsonEntries.claude, backupRootName),
    reconcileCodexMcp(path.join(homeDirectory, '.codex', 'config.toml'), serverName, codexEntry, backupRootName),
    reconcileJsonMcp('qwen', path.join(homeDirectory, '.qwen', 'settings.json'), serverName, jsonEntries.qwen, backupRootName),
    reconcileJsonMcp('gemini', path.join(homeDirectory, '.gemini', 'settings.json'), serverName, jsonEntries.gemini, backupRootName),
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

async function reconcileJsonMcp(
  agent: Exclude<CliAgentId, 'codex'>,
  configPath: string,
  serverName: string,
  desired: unknown,
  backupRootName: string | null,
): Promise<AgentMcpInstallResult> {
  try {
    const existing = await readOptional(configPath);
    const parsed = existing.trim() ? JSON.parse(existing) as unknown : {};
    if (!isRecord(parsed)) throw new Error('The agent configuration root must be a JSON object.');
    const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
    if (!isRecord(servers)) throw new Error('The mcpServers field must be a JSON object.');
    if (sameJson(servers[serverName], desired)) {
      return { agent, configPath, changed: false };
    }
    const next = {
      ...parsed,
      mcpServers: {
        ...servers,
        [serverName]: desired,
      },
    };
    const backupPath = await backupExisting(configPath, existing, backupRootName);
    await writeText(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return { agent, configPath, changed: true, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return { agent, configPath, changed: false, error: messageOf(error) };
  }
}

async function reconcileCodexMcp(
  configPath: string,
  serverName: string,
  entryLines: string[],
  backupRootName: string | null,
): Promise<AgentMcpInstallResult> {
  try {
    const existing = await readOptional(configPath);
    const block = [
      `# >>> KAI ${serverName} MCP`,
      ...entryLines,
      `# <<< KAI ${serverName} MCP`,
    ].join('\n');
    const managedPattern = new RegExp(
      `^# >>> KAI ${escapeRegExp(serverName)} MCP\\r?\\n[\\s\\S]*?^# <<< KAI ${escapeRegExp(serverName)} MCP\\r?$`,
      'm',
    );
    const managed = managedPattern.exec(existing)?.[0];
    if (managed?.replace(/\r\n/g, '\n') === block) {
      return { agent: 'codex', configPath, changed: false };
    }
    const withoutManaged = managed ? existing.replace(managedPattern, '').trimEnd() : existing.trimEnd();
    const withoutBare = removeCodexMcpTable(withoutManaged, serverName).trimEnd();
    const next = `${withoutBare}${withoutBare ? '\n\n' : ''}${block}\n`;
    const backupPath = await backupExisting(configPath, existing, backupRootName);
    await writeText(configPath, next);
    return { agent: 'codex', configPath, changed: true, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return { agent: 'codex', configPath, changed: false, error: messageOf(error) };
  }
}

function removeCodexMcpTable(toml: string, serverName: string): string {
  const lines = toml.split(/\r?\n/);
  const kept: string[] = [];
  const prefix = `mcp_servers.${serverName}`;
  let skipping = false;
  for (const line of lines) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table) skipping = table[1].trim() === prefix || table[1].trim().startsWith(`${prefix}.`);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

function cognitive1McpEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('The Cognitive1 MCP endpoint must be an HTTP or HTTPS URL.');
  return /\/mcp$/i.test(trimmed) ? trimmed : `${trimmed}/mcp`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  backupRootName: string | null,
): Promise<string | undefined> {
  if (!existing || backupRootName === null) return undefined;
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
