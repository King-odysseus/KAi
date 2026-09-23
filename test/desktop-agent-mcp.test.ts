import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_MCP_FEATURE_ID,
  PLAYWRIGHT_MCP_SERVER_ID,
  createDefaultSettings,
} from '../packages/contracts/src';
import {
  preparePlaywrightMcpSettings,
  withPlaywrightMcpSetting,
} from '../apps/desktop/src/main/agent-mcp-config';

const directories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-playwright-mcp-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Playwright MCP installation', () => {
  it('ships the desktop MCP entry but leaves the CLI completion marker unset', () => {
    const settings = createDefaultSettings();
    expect(settings.mcpServers).toEqual([
      expect.objectContaining({
        id: PLAYWRIGHT_MCP_SERVER_ID,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      }),
    ]);
    expect(settings.installedFeatures).not.toContain(PLAYWRIGHT_MCP_FEATURE_ID);
  });

  it('normalizes the desktop launcher for Node on Windows', () => {
    const updated = withPlaywrightMcpSetting(createDefaultSettings(), 'win32');
    expect(updated.changed).toBe(true);
    expect(updated.settings.mcpServers[0]).toMatchObject({
      id: PLAYWRIGHT_MCP_SERVER_ID,
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx -y @playwright/mcp@latest'],
    });
  });

  it('installs for every CLI without discarding existing configuration', async () => {
    const home = await temporaryHome();
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'node', args: ['server.js'] } } }),
    );
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n');
    await fs.mkdir(path.join(home, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.qwen', 'settings.json'),
      JSON.stringify({ model: { name: 'qwen-proxy' }, mcpServers: {} }),
    );

    const prepared = await preparePlaywrightMcpSettings(createDefaultSettings(), {
      homeDirectory: home,
      platform: 'win32',
    });

    expect(prepared.agentsInstalled).toBe(true);
    expect(prepared.cliResults).toHaveLength(4);
    expect(prepared.cliResults.every((result) => !result.error && result.changed)).toBe(true);
    expect(prepared.settings.installedFeatures).toContain(PLAYWRIGHT_MCP_FEATURE_ID);

    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(claude.theme).toBe('dark');
    expect(claude.mcpServers).toMatchObject({
      existing: { command: 'node', args: ['server.js'] },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });

    const codex = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('model = "gpt-5.5"');
    expect(codex).toContain('[mcp_servers.playwright]');
    expect(codex).toContain('args = ["-y", "@playwright/mcp@latest"]');

    const qwen = JSON.parse(await fs.readFile(path.join(home, '.qwen', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(qwen.model).toEqual({ name: 'qwen-proxy' });
    expect(qwen.mcpServers).toMatchObject({ playwright: { command: 'npx' } });

    const gemini = JSON.parse(await fs.readFile(path.join(home, '.gemini', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(gemini.mcpServers).toMatchObject({ playwright: { command: 'npx' } });
  });

  it('is idempotent after every CLI has been configured', async () => {
    const home = await temporaryHome();
    const first = await preparePlaywrightMcpSettings(createDefaultSettings(), {
      homeDirectory: home,
      platform: 'win32',
    });
    const second = await preparePlaywrightMcpSettings(first.settings, {
      homeDirectory: home,
      platform: 'win32',
    });

    expect(second.changed).toBe(false);
    expect(second.cliResults).toEqual([]);
    expect(second.agentsInstalled).toBe(true);
    expect(second.settings.installedFeatures.filter((feature) => feature === PLAYWRIGHT_MCP_FEATURE_ID)).toHaveLength(1);
  });

  it('does not mark installation complete when one agent configuration fails', async () => {
    const home = await temporaryHome();
    await fs.mkdir(path.join(home, '.qwen', 'settings.json'), { recursive: true });

    const prepared = await preparePlaywrightMcpSettings(createDefaultSettings(), {
      homeDirectory: home,
      platform: 'win32',
    });

    expect(prepared.agentsInstalled).toBe(false);
    expect(prepared.cliResults.find((result) => result.agent === 'qwen')?.error).toBeTruthy();
    expect(prepared.settings.installedFeatures).not.toContain(PLAYWRIGHT_MCP_FEATURE_ID);
  });
});
