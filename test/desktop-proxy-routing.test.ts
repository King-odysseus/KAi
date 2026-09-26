import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AppSettings } from '../packages/contracts/src';
import { DesktopProxyRouting, retargetProxyPort } from '../apps/desktop/src/main/proxy-routing';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('desktop proxy routing', () => {
  it('moves only this agent\'s loopback URLs on the old port', () => {
    const content = [
      '"baseUrl": "http://127.0.0.1:8082/a/qwen/v1"',
      '"baseUrl": "http://localhost:8082/a/qwen"',
      '"baseUrl": "http://127.0.0.1:8082/a/codex/v1"',
      '"baseUrl": "http://127.0.0.1:8090/a/qwen/v1"',
      '"baseUrl": "http://127.0.0.1:8082/a/qwenish/v1"',
      '"baseUrl": "https://api.deepseek.com:8082/a/qwen/v1"',
    ].join('\n');
    expect(retargetProxyPort(content, 'qwen', 8082, 8083).split('\n')).toEqual([
      '"baseUrl": "http://127.0.0.1:8083/a/qwen/v1"',
      '"baseUrl": "http://localhost:8083/a/qwen"',
      '"baseUrl": "http://127.0.0.1:8082/a/codex/v1"',
      '"baseUrl": "http://127.0.0.1:8090/a/qwen/v1"',
      '"baseUrl": "http://127.0.0.1:8082/a/qwenish/v1"',
      '"baseUrl": "https://api.deepseek.com:8082/a/qwen/v1"',
    ]);
  });

  it('carries every routed agent config to the new port and remembers it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-proxy-routing-'));
    temporaryDirectories.push(root);
    const qwen = path.join(root, 'qwen.json');
    const codex = path.join(root, 'codex.toml');
    await fs.writeFile(qwen, JSON.stringify({
      modelProviders: { openai: [{ id: 'qwen-proxy', baseUrl: 'http://127.0.0.1:8082/a/qwen/v1' }] },
      model: { name: 'qwen-proxy', baseUrl: 'http://127.0.0.1:8082/a/qwen/v1' },
    }));
    await fs.writeFile(codex, 'base_url = "http://127.0.0.1:8082/a/codex/v1"\n');
    const engine = await fakeEngine(root, { qwen, codex, kimi: path.join(root, 'missing.toml') });

    let settings = withProxy({ port: 8083, routedPort: 8082 });
    const routing = routingFor(engine, () => settings, (next) => { settings = next; });

    expect(await routing.followPort(8083)).toEqual([qwen, codex]);
    expect(await fs.readFile(qwen, 'utf8')).not.toContain(':8082');
    expect(await fs.readFile(codex, 'utf8')).toBe('base_url = "http://127.0.0.1:8083/a/codex/v1"\n');
    expect(settings.proxy.routedPort).toBe(8083);
    expect(await routing.followPort(8083)).toEqual([]);
  });

  it('only records the port the first time, because it cannot know what an older port belonged to', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-proxy-routing-'));
    temporaryDirectories.push(root);
    const qwen = path.join(root, 'qwen.json');
    await fs.writeFile(qwen, '{"model":{"baseUrl":"http://127.0.0.1:8082/a/qwen/v1"}}');
    const engine = await fakeEngine(root, { qwen });
    let settings = withProxy({ port: 8083 });
    const routing = routingFor(engine, () => settings, (next) => { settings = next; });

    expect(await routing.followPort(8083)).toEqual([]);
    expect(await fs.readFile(qwen, 'utf8')).toContain(':8082');
    expect(settings.proxy.routedPort).toBe(8083);
  });
});

function routingFor(engine: string, load: () => AppSettings, save: (next: AppSettings) => void): DesktopProxyRouting {
  return new DesktopProxyRouting({
    locateEngine: () => Promise.resolve({ root: engine } as never),
    loopbackAccess: () => Promise.resolve({ endpoint: 'http://127.0.0.1:8083', token: 't' }),
    loadSettings: () => Promise.resolve(load()),
    saveSettings: (next) => {
      save(next);
      return Promise.resolve();
    },
  });
}

function withProxy(proxy: Partial<AppSettings['proxy']>): AppSettings {
  const settings = createDefaultSettings();
  return { ...settings, proxy: { ...settings.proxy, ...proxy } };
}

/** Stages a stand-in for the bundled engine's routing modules, with one config file per agent. */
async function fakeEngine(root: string, files: Record<string, string>): Promise<string> {
  const engine = path.join(root, 'engine');
  const routingDirectory = path.join(engine, 'out', 'routing');
  await fs.mkdir(path.join(routingDirectory, 'adapters'), { recursive: true });
  await fs.writeFile(
    path.join(routingDirectory, 'adapters', 'index.js'),
    `const files = ${JSON.stringify(files)};
exports.createRoutingTransactionAdapters = () => Object.entries(files).map(([agentId, file]) => ({
  agentId, configPath: () => file, applyRoute: async () => {}, readRoute: async () => ({}),
}));
exports.resolveConfiguredRoutes = async () => [];
`,
  );
  await fs.writeFile(path.join(routingDirectory, 'routing-transaction.js'), 'exports.RoutingTransaction = class {};\n');
  await fs.writeFile(path.join(routingDirectory, 'config-backup.js'), 'exports.ConfigBackupStore = class {};\n');
  return engine;
}
