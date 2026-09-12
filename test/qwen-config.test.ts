import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QwenConfigWriter } from '../src/config/qwen-config';

let tempDir: string;

interface QwenSettings {
  modelProviders: Record<string, Array<{ id?: string; name?: string; baseUrl?: string }>>;
  model?: { name?: string; baseUrl?: string };
  env?: Record<string, string>;
  security?: { auth?: { selectedType?: string } };
  _kaiProxyOriginals?: {
    providers: Array<{ provider: string; id: string; baseUrl: string }>;
    modelBaseUrl?: string;
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-qwen-config-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(tempDir, 'settings.json');
}

async function readSettings(configPath = settingsPath()): Promise<QwenSettings> {
  return JSON.parse(await fs.readFile(configPath, 'utf8')) as QwenSettings;
}

async function writeSettings(value: QwenSettings): Promise<string> {
  const target = settingsPath();
  await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return target;
}

function deepseekSettings(): QwenSettings {
  return {
    modelProviders: {
      openai: [{
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
      }],
    },
    model: { name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    env: { DEEPSEEK_API_KEY: 'keep-me' },
    security: { auth: { selectedType: 'openai' } },
  };
}

describe('QwenConfigWriter.ensureProxyConfig', () => {
  // Qwen appends /chat/completions to the base URL, so a base URL without the
  // /v1 segment sends every request to the proxy's 404 handler.
  it('points providers at the tagged UAP-compatible proxy URL', async () => {
    const configPath = await writeSettings(deepseekSettings());

    const result = await new QwenConfigWriter().ensureProxyConfig({ configPath, port: 8083 });
    const next = await readSettings(configPath);

    expect(result.changed).toBe(true);
    expect(result.providerCount).toBe(1);
    expect(next.modelProviders.openai[0].baseUrl).toBe('http://127.0.0.1:8083/a/qwen/v1');
    expect(next.model?.baseUrl).toBe('http://127.0.0.1:8083/a/qwen/v1');
    // Everything else in the user's file survives untouched.
    expect(next.env?.DEEPSEEK_API_KEY).toBe('keep-me');
    expect(next.security?.auth?.selectedType).toBe('openai');
  });

  it('records the real upstreams so a restore has something to restore', async () => {
    const configPath = await writeSettings(deepseekSettings());

    await new QwenConfigWriter().ensureProxyConfig({ configPath, port: 8083 });
    const next = await readSettings(configPath);

    expect(next._kaiProxyOriginals).toEqual({
      providers: [{ provider: 'openai', id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }],
      modelBaseUrl: 'https://api.deepseek.com/v1',
    });
  });

  it('is idempotent and keeps the first snapshot', async () => {
    const configPath = await writeSettings(deepseekSettings());
    const writer = new QwenConfigWriter();

    await writer.ensureProxyConfig({ configPath, port: 8083 });
    const first = await fs.readFile(configPath, 'utf8');
    const second = await writer.ensureProxyConfig({ configPath, port: 8083 });

    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(await fs.readFile(configPath, 'utf8')).toBe(first);
  });

  // The old guard tested `includes('localhost')`, so a 127.0.0.1 URL — what the
  // universal-agent-proxy writes — was treated as a real upstream and recorded
  // as an "original", meaning restore would point Qwen at a dead port.
  it('does not record a URL that already points at a local proxy', async () => {
    const configPath = await writeSettings({
      modelProviders: {
        openai: [{
          id: 'uap',
          baseUrl: 'http://127.0.0.1:8082/a/qwen/v1',
        }],
      },
    });

    const result = await new QwenConfigWriter().ensureProxyConfig({ configPath, port: 8083 });
    const next = await readSettings(configPath);

    expect(result.changed).toBe(true);
    expect(next.modelProviders.openai[0].baseUrl).toBe('http://127.0.0.1:8083/a/qwen/v1');
    expect(next._kaiProxyOriginals).toBeUndefined();
  });

  it('leaves a missing or unparseable settings file alone', async () => {
    const writer = new QwenConfigWriter();

    const missing = await writer.ensureProxyConfig({ configPath: settingsPath(), port: 8083 });
    expect(missing.changed).toBe(false);
    await expect(fs.readFile(settingsPath(), 'utf8')).rejects.toThrow();

    const broken = settingsPath();
    await fs.writeFile(broken, '{ not json', 'utf8');
    const result = await writer.ensureProxyConfig({ configPath: broken, port: 8083 });
    expect(result.changed).toBe(false);
    expect(await fs.readFile(broken, 'utf8')).toBe('{ not json');
  });
});

describe('QwenConfigWriter.restoreConfig', () => {
  it('puts the recorded upstreams back and drops the snapshot', async () => {
    const configPath = await writeSettings(deepseekSettings());
    const writer = new QwenConfigWriter();

    await writer.ensureProxyConfig({ configPath, port: 8083 });
    const result = await writer.restoreConfig(configPath);
    const next = await readSettings(configPath);

    expect(result.changed).toBe(true);
    expect(next.modelProviders.openai[0].baseUrl).toBe('https://api.deepseek.com/v1');
    expect(next.model?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(next._kaiProxyOriginals).toBeUndefined();
  });

  // The old restore hardcoded DashScope as the "original" upstream, so Stop
  // silently rewrote a DeepSeek setup to an endpoint the user had never chosen.
  it('never guesses an upstream when there is no snapshot', async () => {
    const configPath = await writeSettings(deepseekSettings());
    const before = await fs.readFile(configPath, 'utf8');

    const result = await new QwenConfigWriter().restoreConfig(configPath);

    expect(result.changed).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });

  it('round-trips back to the exact original settings object', async () => {
    const original = deepseekSettings();
    const configPath = await writeSettings(original);
    const writer = new QwenConfigWriter();

    await writer.ensureProxyConfig({ configPath, port: 8083 });
    await writer.restoreConfig(configPath);

    expect(await readSettings(configPath)).toEqual(original);
  });
});
