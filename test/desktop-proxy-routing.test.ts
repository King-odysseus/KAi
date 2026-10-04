import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AppSettings } from '../packages/contracts/src';
import { DesktopProxyRouting } from '../apps/desktop/src/main/proxy-routing';

/**
 * Putting a routed CLI back.
 *
 * A route is written into the user's own config — `~/.claude/settings.json`, `~/.codex/config.toml` — and outlives
 * the proxy it points at. Nothing used to undo one, so a CLI started after KAI quit was left talking to 127.0.0.1 on
 * a port with nothing listening, until the person happened to open KAI and press Direct.
 *
 * These cases drive the real `DesktopProxyRouting` against real config files in a temporary home, with the engine's
 * own modules loaded from the sibling checkout it is built from.
 */

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('routes KAI owns', () => {
  it('puts back the agent it routed, and leaves an agent the user pointed elsewhere alone', async () => {
    const home = await temporaryHome();
    const codexConfig = path.join(home, '.codex', 'config.toml');
    await writeText(codexConfig, 'base_url = "http://127.0.0.1:8082/a/codex/v1"\n');

    const settings = createDefaultSettings();
    // Claude is KAI's own route — KAI's record says so. Codex is pointed at the standalone proxy on 8082, and KAI
    // never touched it.
    settings.proxy.routeClaudeCode = true;
    settings.proxy.routeCodex = false;
    const problems: string[] = [];
    const routing = engineRouting(settings, problems);

    const reverted = await routing.revertOwnedRoutes('test');

    // Exactly one agent was attempted. Whether the engine completed the revert is its business and needs a real
    // installation; that it was attempted for Claude, and only for Claude, is what KAI decides.
    expect(reverted.length + problems.length).toBe(1);
    expect([...reverted, ...problems].join(' ')).toContain('claude');
    expect([...reverted, ...problems].join(' ')).not.toContain('codex');
    // And the file KAI does not own is exactly as it was.
    expect(await fs.readFile(codexConfig, 'utf8')).toBe('base_url = "http://127.0.0.1:8082/a/codex/v1"\n');
  });

  it('does nothing at all when KAI routed nothing', async () => {
    await temporaryHome();
    const settings = createDefaultSettings();
    const problems: string[] = [];
    const routing = engineRouting(settings, problems);

    expect(await routing.revertOwnedRoutes('test')).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('leaves a route alone until its window has closed, then puts it back', async () => {
    await temporaryHome();
    const settings = createDefaultSettings();
    settings.proxy.routeClaudeCode = true;
    settings.proxy.routeClaudeCodeUntil = Date.now() + 60_000;
    const problems: string[] = [];
    const routing = engineRouting(settings, problems);

    // Still inside its window: no agent is asked to do anything.
    expect(await routing.revertExpiredRoutes()).toEqual([]);
    expect(problems).toEqual([]);

    settings.proxy.routeClaudeCodeUntil = Date.now() - 1;
    const later = await routing.revertExpiredRoutes();
    expect(later.length + problems.length).toBe(1);
  });

  it('does not revert an expired window for an agent KAI never routed', async () => {
    await temporaryHome();
    const settings = createDefaultSettings();
    settings.proxy.routeClaudeCode = false;
    settings.proxy.routeClaudeCodeUntil = Date.now() - 1;
    const problems: string[] = [];
    const routing = engineRouting(settings, problems);

    expect(await routing.revertExpiredRoutes()).toEqual([]);
    expect(problems).toEqual([]);
  });
});

/**
 * A router whose engine cannot be loaded, with a temporary home so nothing touches the user's own files.
 *
 * Pointing at a root that is not there is deliberate: every case here is about which agents KAI decides to put back,
 * which is KAI's own logic and does not need the proxy project checked out. An engine that cannot load reaches
 * `onProblem`, which is where a refusal would land too.
 */
function engineRouting(settings: AppSettings, problems: string[]): DesktopProxyRouting {
  return new DesktopProxyRouting({
    locateEngine: async () => ({ root: path.join(os.tmpdir(), 'kai-proxy-engine-that-is-not-there'), version: '0.0.0-test' }) as never,
    loopbackAccess: async () => ({ endpoint: `http://127.0.0.1:${settings.proxy.port}`, token: 'test-token' }),
    loadSettings: async () => structuredClone(settings),
    saveSettings: async (next) => { Object.assign(settings, next); },
    onProblem: (message) => problems.push(message),
  });
}

async function temporaryHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-proxy-route-'));
  temporaryDirectories.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

async function writeText(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, 'utf8');
}
