import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER_ID, createDefaultSettings, type AppSettings } from '../packages/contracts/src';
import type { AgentMcpInstallResult } from '../apps/desktop/src/main/agent-mcp-config';
import type { PlaywrightHost } from '../apps/desktop/src/main/playwright-host';
import { startSharedBrowser, type SharedBrowserDeps } from '../apps/desktop/src/main/shared-browser';

const ENDPOINT = 'http://127.0.0.1:8931/mcp';

function results(error?: string): AgentMcpInstallResult[] {
  return (['claude', 'codex', 'qwen', 'gemini'] as const).map((agent) => ({
    agent,
    configPath: `C:/home/${agent}`,
    changed: true,
    ...(error && agent === 'qwen' ? { error } : {}),
  }));
}

interface Fake {
  deps: SharedBrowserDeps;
  settings: { current: AppSettings };
  calls: string[];
  logs: Array<{ level: 'info' | 'warn'; message: string; detail?: string }>;
  stopped: { fire(code: number | null): void };
}

function fake(over: Partial<SharedBrowserDeps> = {}): Fake {
  const settings = { current: createDefaultSettings() };
  const calls: string[] = [];
  const logs: Fake['logs'] = [];
  let onStopped: (code: number | null) => void = () => undefined;
  const host: PlaywrightHost = { endpoint: ENDPOINT, port: 8931, adopted: false, close: async () => undefined };
  const deps: SharedBrowserDeps = {
    start: async (callback) => { calls.push('start'); onStopped = callback; return host; },
    updateSettings: async (mutator) => { calls.push('settings'); settings.current = mutator(settings.current); return settings.current; },
    reconnect: () => { calls.push('reconnect'); },
    installShared: async (endpoint) => { calls.push(`shared ${endpoint}`); return results(); },
    installOwn: async () => { calls.push('own'); return results(); },
    info: (message, detail) => { logs.push({ level: 'info', message, ...(detail ? { detail } : {}) }); },
    warn: (message, detail) => { logs.push({ level: 'warn', message, ...(detail ? { detail } : {}) }); },
    ...over,
  };
  return { deps, settings, calls, logs, stopped: { fire: (code) => onStopped(code) } };
}

const entry = (settings: AppSettings) => settings.mcpServers.find((server) => server.id === PLAYWRIGHT_MCP_SERVER_ID);

describe('starting the shared browser', () => {
  it('points KAI and every CLI at it once it is answering, in that order, and says so', async () => {
    const { deps, settings, calls, logs } = fake();
    const host = await startSharedBrowser(deps);
    expect(host?.endpoint).toBe(ENDPOINT);
    expect(calls).toEqual(['start', 'settings', 'reconnect', `shared ${ENDPOINT}`]);
    expect(entry(settings.current)).toMatchObject({ transport: 'http', url: ENDPOINT });
    expect(logs).toEqual([{ level: 'info', message: 'The shared browser server is running', detail: ENDPOINT }]);
  });

  it('says when it is using a server that was already running', async () => {
    const adopted: PlaywrightHost = { endpoint: ENDPOINT, port: 8931, adopted: true, close: async () => undefined };
    const { deps, logs } = fake({ start: async () => adopted });
    await startSharedBrowser(deps);
    expect(logs[0]?.message).toBe('Using the shared browser server that is already running');
  });

  it('puts every agent back on a browser of its own when the server cannot start, and does not throw', async () => {
    const { deps, settings, calls, logs } = fake({ start: async () => { throw new Error('npx was not found'); } });
    // The settings had been pointed at a server by an earlier launch.
    settings.current = { ...settings.current, mcpServers: [{ id: PLAYWRIGHT_MCP_SERVER_ID, name: 'Playwright Browser', enabled: true, transport: 'http', url: ENDPOINT, headerCredentialIds: {} }] };

    const host = await startSharedBrowser(deps);
    expect(host).toBeNull();
    expect(calls).toEqual(['settings', 'reconnect', 'own']);
    expect(entry(settings.current)?.transport).toBe('stdio');
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'The shared browser server could not start, so each agent keeps its own', detail: 'npx was not found' });
  });

  it('reports a CLI whose configuration could not be written, and carries on with the rest', async () => {
    const { deps, logs } = fake({ installShared: async () => results('EPERM: operation not permitted') });
    const host = await startSharedBrowser(deps);
    expect(host).not.toBeNull();
    expect(logs.some((log) => log.level === 'warn' && log.message.includes('qwen') && log.detail?.includes('EPERM'))).toBe(true);
  });

  it('survives restoring the old entries failing as well', async () => {
    const { deps, logs } = fake({
      start: async () => { throw new Error('port in use'); },
      installOwn: async () => { throw new Error('disk full'); },
    });
    await expect(startSharedBrowser(deps)).resolves.toBeNull();
    expect(logs.map((log) => log.message)).toContain('The per-agent browser entries could not be restored');
  });

  it('tells the caller when the server stops later, so it stops claiming to hold one', async () => {
    const { deps, stopped, logs } = fake();
    let lost = 0;
    await startSharedBrowser(deps, () => { lost += 1; });
    stopped.fire(137);
    expect(lost).toBe(1);
    expect(logs.at(-1)).toMatchObject({ level: 'warn', message: 'The shared browser server stopped' });
    expect(logs.at(-1)?.detail).toContain('exit 137');
  });

  it('leaves a browser the person switched off switched off', async () => {
    const { deps, settings } = fake();
    settings.current = { ...settings.current, mcpServers: settings.current.mcpServers.map((server) => (server.id === PLAYWRIGHT_MCP_SERVER_ID ? { ...server, enabled: false } : server)) };
    await startSharedBrowser(deps);
    expect(entry(settings.current)?.enabled).toBe(false);
  });
});
