import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER_ID, createDefaultSettings } from '../packages/contracts/src';
import {
  installCognitive1McpForAgents,
  installPlaywrightMcpForAgents,
  installPlaywrightSharedMcpForAgents,
  preparePlaywrightMcpSettings,
  withPlaywrightMcpEndpoint,
} from '../apps/desktop/src/main/agent-mcp-config';

const ENDPOINT = 'http://127.0.0.1:8931/mcp';
const directories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-shared-browser-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('pointing the agents at the shared Playwright browser', () => {
  it('replaces the server each CLI started for itself, in every CLI', async () => {
    const home = await temporaryHome();
    // The state before: every CLI starts its own Playwright, as KAI installed it.
    await preparePlaywrightMcpSettings(createDefaultSettings(), { homeDirectory: home, platform: 'win32' });

    const results = await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    expect(results).toHaveLength(4);
    expect(results.every((result) => !result.error && result.changed)).toBe(true);

    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(claude.mcpServers.playwright).toEqual({ type: 'http', url: ENDPOINT });
    const qwen = JSON.parse(await fs.readFile(path.join(home, '.qwen', 'settings.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(qwen.mcpServers.playwright).toEqual({ httpUrl: ENDPOINT });
    const gemini = JSON.parse(await fs.readFile(path.join(home, '.gemini', 'settings.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(gemini.mcpServers.playwright).toEqual({ httpUrl: ENDPOINT });
    const codex = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain(`url = "${ENDPOINT}"`);
    // The old launcher is gone, not left beside the new entry for an agent to pick instead.
    expect(codex).not.toContain('@playwright/mcp');
    expect(codex.match(/\[mcp_servers\.playwright\]/g)).toHaveLength(1);
  });

  it('keeps the name playwright, so the tools an agent sees do not change', async () => {
    const home = await temporaryHome();
    await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claude.mcpServers)).toEqual(['playwright']);
  });

  it('leaves everything else in the files alone, and does nothing when the entry is already current', async () => {
    const home = await temporaryHome();
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', projects: { a: 1 }, mcpServers: { existing: { command: 'node' } } }),
    );
    await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(claude).toMatchObject({ theme: 'dark', projects: { a: 1 }, mcpServers: { existing: { command: 'node' }, playwright: { type: 'http', url: ENDPOINT } } });

    const again = await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    expect(again.some((result) => result.changed)).toBe(false);
  });

  it('writes no backup copies: the entry is KAI\'s own, and the file is one a running agent also writes', async () => {
    const home = await temporaryHome();
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const results = await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    expect(results.every((result) => result.backupPath === undefined)).toBe(true);
    await expect(fs.stat(path.join(home, '.kai-backups'))).rejects.toThrow();
  });

  it('still backs up on the installs that always did', async () => {
    const home = await temporaryHome();
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const results = await installCognitive1McpForAgents({ homeDirectory: home, endpoint: 'http://127.0.0.1:1/mcp', token: 'x' });
    expect(results.find((result) => result.agent === 'claude')?.backupPath).toBeDefined();
  });

  it('goes back to a server of its own for each CLI when the shared one cannot start', async () => {
    const home = await temporaryHome();
    await installPlaywrightSharedMcpForAgents({ homeDirectory: home, endpoint: ENDPOINT });
    const restored = await installPlaywrightMcpForAgents({ homeDirectory: home, backups: false });
    expect(restored.every((result) => !result.error && result.changed)).toBe(true);
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(claude.mcpServers.playwright).toMatchObject({ command: 'npx' });
    expect(await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain(ENDPOINT);
  });
});

describe('KAI\'s own Playwright entry', () => {
  const entry = (settings: ReturnType<typeof createDefaultSettings>) => settings.mcpServers.find((server) => server.id === PLAYWRIGHT_MCP_SERVER_ID);

  it('points at the shared server when there is one', () => {
    const next = withPlaywrightMcpEndpoint(createDefaultSettings(), ENDPOINT, 'win32');
    expect(next.changed).toBe(true);
    expect(entry(next.settings)).toMatchObject({ id: PLAYWRIGHT_MCP_SERVER_ID, transport: 'http', url: ENDPOINT, headerCredentialIds: {} });
  });

  it('does nothing when it already points there', () => {
    const once = withPlaywrightMcpEndpoint(createDefaultSettings(), ENDPOINT, 'win32').settings;
    const twice = withPlaywrightMcpEndpoint(once, ENDPOINT, 'win32');
    expect(twice.changed).toBe(false);
    expect(twice.settings).toBe(once);
  });

  it('goes back to starting its own server when the shared one is gone, rather than staying pointed at nothing', () => {
    const pointed = withPlaywrightMcpEndpoint(createDefaultSettings(), ENDPOINT, 'win32').settings;
    const back = withPlaywrightMcpEndpoint(pointed, null, 'win32');
    expect(back.changed).toBe(true);
    expect(entry(back.settings)).toMatchObject({ transport: 'stdio', command: 'cmd.exe' });
    expect(JSON.stringify(entry(back.settings))).toContain('@playwright/mcp');
  });

  it('leaves a server that already starts its own alone when there is no shared one', () => {
    const settings = createDefaultSettings();
    const same = withPlaywrightMcpEndpoint(settings, null, 'win32');
    expect(same.changed).toBe(false);
    expect(same.settings).toBe(settings);
  });

  it('keeps a server the person turned off turned off, whichever way it points', () => {
    const settings = createDefaultSettings();
    const off = { ...settings, mcpServers: settings.mcpServers.map((server) => (server.id === PLAYWRIGHT_MCP_SERVER_ID ? { ...server, enabled: false } : server)) };
    const pointed = withPlaywrightMcpEndpoint(off, ENDPOINT, 'win32').settings;
    expect(entry(pointed)?.enabled).toBe(false);
    expect(entry(withPlaywrightMcpEndpoint(pointed, null, 'win32').settings)?.enabled).toBe(false);
  });

  it('adds the entry when there is none', () => {
    const settings = { ...createDefaultSettings(), mcpServers: [] };
    const next = withPlaywrightMcpEndpoint(settings, ENDPOINT, 'win32');
    expect(next.changed).toBe(true);
    expect(entry(next.settings)).toMatchObject({ transport: 'http', url: ENDPOINT, enabled: true });
  });

  it('is not undone by the launch-time preparation that normalises the launcher', async () => {
    const home = await temporaryHome();
    const pointed = withPlaywrightMcpEndpoint(createDefaultSettings(), ENDPOINT, 'win32').settings;
    const prepared = await preparePlaywrightMcpSettings(pointed, { homeDirectory: home, platform: 'win32' });
    expect(entry(prepared.settings)).toMatchObject({ transport: 'http', url: ENDPOINT });
  });
});
