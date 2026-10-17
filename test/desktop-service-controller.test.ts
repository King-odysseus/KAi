import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AppSettings } from '../packages/contracts/src';
import { createDesktopPaths } from '../apps/desktop/src/main/paths';
import {
  cognitive1OverwatchEnvironment,
  DesktopServiceController,
  explainStartFailure,
  moveOffBusyPort,
  moveOffStandalonePort,
} from '../apps/desktop/src/main/service-controller';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('managed Cognitive1 port', () => {
  const taken = (...ports: number[]) => async (port: number) => !ports.includes(port);

  it('defaults to a port that does not clash with the standalone daemon', () => {
    expect(createDefaultSettings().cognitive1.endpoint).toBe('http://127.0.0.1:47831');
  });

  it('moves the legacy managed endpoint even while 9876 is free, so standalone C1 can start later', async () => {
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken())).toBe('http://127.0.0.1:47831');
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken(9876))).toBe('http://127.0.0.1:47831');
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken(47831, 47832))).toBe('http://127.0.0.1:47833');
    expect(await moveOffStandalonePort('http://127.0.0.1:9877', taken())).toBe('http://127.0.0.1:47831');
  });

  it('is idempotent and leaves a genuinely custom endpoint alone', async () => {
    expect(await moveOffStandalonePort('http://127.0.0.1:47831', taken())).toBeNull();
    expect(await moveOffStandalonePort('http://example.com:9877', taken())).toBeNull();
    expect(await moveOffStandalonePort('http://127.0.0.1:9900', taken(9876, 9900))).toBeNull();
    expect(await moveOffStandalonePort('not a url', taken(9876))).toBeNull();
  });

  it('gives up cleanly when no nearby port is free', async () => {
    const everything = async () => false;
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', everything)).toBeNull();
  });

  it('explains an address-in-use failure in plain words and passes other errors through', () => {
    const busy = new Error('listen EADDRINUSE: address already in use 127.0.0.1:9876');
    expect(explainStartFailure('cognitive1', 'http://127.0.0.1:9876', busy)).toBe(
      'Port 9876 is already in use by another program, so Cognitive1 could not start. Another copy may be running. Change the port in Settings or stop that program.',
    );
    expect(explainStartFailure('universalProxy', 'http://127.0.0.1:8082', busy)).toContain('the Universal Proxy could not start');
    expect(explainStartFailure('cognitive1', 'http://127.0.0.1:9877', new Error('boom'))).toBe('boom');
  });
});

describe('managed Universal Proxy port', () => {
  const taken = (...ports: number[]) => async (port: number) => !ports.includes(port);

  it('keeps the configured port when nothing else owns it', async () => {
    expect(await moveOffBusyPort(8082, taken())).toBeNull();
  });

  it('moves to the next free port when the standalone proxy already owns the configured one', async () => {
    expect(await moveOffBusyPort(8082, taken(8082))).toBe(8083);
    expect(await moveOffBusyPort(8082, taken(8082, 8083, 8084))).toBe(8085);
  });

  it('ignores values that cannot be a service port and gives up cleanly when nothing nearby is free', async () => {
    expect(await moveOffBusyPort(80, taken(80))).toBeNull();
    expect(await moveOffBusyPort(70_000, taken())).toBeNull();
    expect(await moveOffBusyPort(8082, async () => false)).toBeNull();
  });

  it('saves the new port before launching, so the proxy route uses it on the next start too', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-service-'));
    temporaryDirectories.push(root);
    const settings: AppSettings = { ...createDefaultSettings(), proxy: { ...createDefaultSettings().proxy, enabled: true, port: 8082 } };
    const updates: Array<Partial<AppSettings>> = [];
    const controller = new DesktopServiceController({
      paths: createDesktopPaths(root),
      settings: {
        load: async () => settings,
        update: async (mutate: (current: AppSettings) => AppSettings) => {
          Object.assign(settings, mutate(settings));
          updates.push({ proxy: settings.proxy });
          return settings;
        },
      },
      credentials: { isAvailable: () => false, get: async () => null, has: async () => false, set: async () => undefined },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => undefined },
      kaiRoot: root,
      resourcesPath: root,
      proxyLauncherPath: path.join(root, 'proxy-launcher.cjs'),
      isPortFree: async (port: number) => port !== 8082,
    } as unknown as ConstructorParameters<typeof DesktopServiceController>[0]);

    // The engine is not installed in this temporary root, so the launch itself fails after the port has moved.
    await controller.start('universalProxy').catch(() => undefined);

    expect(settings.proxy.port).toBe(8083);
    expect(updates).toHaveLength(1);
    await controller.dispose();
  });
});

describe('desktop C1 service controller', () => {
  it('maps desktop Overwatch settings to the C1 daemon environment', () => {
    const settings = createDefaultSettings();
    settings.cognitive1.overwatch = {
      enabled: true,
      provider: 'claude',
      baseUrl: 'https://api.anthropic.com',
      credentialId: 'cognitive1.overwatch.claude',
      model: 'claude-sonnet-4-5',
      autoRejectThreshold: 0.92,
    };

    expect(cognitive1OverwatchEnvironment(settings, 'vault-secret')).toEqual({
      COGNITIVE1_OVERWATCH_ENABLED: 'true',
      COGNITIVE1_OVERWATCH_PROVIDER: 'claude',
      COGNITIVE1_OVERWATCH_BASE_URL: 'https://api.anthropic.com',
      COGNITIVE1_OVERWATCH_MODEL: 'claude-sonnet-4-5',
      COGNITIVE1_OVERWATCH_AUTO_REJECT_THRESHOLD: '0.92',
      COGNITIVE1_OVERWATCH_API_KEY: 'vault-secret',
    });
  });

  it('does not inject an empty Overwatch credential into the daemon environment', () => {
    const settings = createDefaultSettings();
    const environment = cognitive1OverwatchEnvironment(settings, '');

    expect(environment.COGNITIVE1_OVERWATCH_ENABLED).toBe('false');
    expect(environment).not.toHaveProperty('COGNITIVE1_OVERWATCH_API_KEY');
  });

  it('maps OpenAI Overwatch settings to the C1 daemon environment', () => {
    const settings = createDefaultSettings();
    settings.cognitive1.overwatch = {
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'cognitive1.overwatch',
      model: 'gpt-6-astra',
      autoRejectThreshold: 0.9,
    };

    expect(cognitive1OverwatchEnvironment(settings, 'openai-secret')).toMatchObject({
      COGNITIVE1_OVERWATCH_ENABLED: 'true',
      COGNITIVE1_OVERWATCH_PROVIDER: 'openai',
      COGNITIVE1_OVERWATCH_BASE_URL: 'https://api.openai.com/v1',
      COGNITIVE1_OVERWATCH_MODEL: 'gpt-6-astra',
      COGNITIVE1_OVERWATCH_API_KEY: 'openai-secret',
    });
  });
});
