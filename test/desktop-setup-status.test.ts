import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';
import type { ServiceState } from '../packages/contracts/src';
import { buildSetupStatus } from '../apps/desktop/src/main/setup-status';

function service(kind: ServiceState['kind'], status: ServiceState['status'], detail = ''): ServiceState {
  return {
    kind,
    status,
    detail,
    endpoint: null,
    version: null,
    updatedAt: new Date().toISOString(),
  };
}

function ports(overrides: Partial<Parameters<typeof buildSetupStatus>[0]> = {}): Parameters<typeof buildSetupStatus>[0] {
  const settings = createDefaultSettings();
  settings.activeProjectId = 'project-1';
  return {
    settings: () => Promise.resolve(settings),
    projects: () => Promise.resolve([{ id: 'project-1' }]),
    services: () => Promise.resolve([service('cognitive1', 'stopped'), service('universalProxy', 'stopped')]),
    agentCapabilities: () => Promise.resolve([{ available: false, displayName: 'Codex' }]),
    directApiAvailable: () => Promise.resolve(false),
    directApiDetail: () => Promise.resolve('Configure a direct API provider.'),
    ...overrides,
  };
}

describe('desktop first-run setup status', () => {
  it('blocks work when no agent or API route is available, while optional services stay optional', async () => {
    const status = await buildSetupStatus(ports());

    expect(status.complete).toBe(false);
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project', status: 'ready' }),
      expect.objectContaining({ id: 'cli', status: 'blocked', action: 'open_settings' }),
      expect.objectContaining({ id: 'provider', status: 'blocked', action: 'open_settings' }),
      expect.objectContaining({ id: 'cognitive1', status: 'optional', action: 'start_cognitive1' }),
      expect.objectContaining({ id: 'proxy', status: 'optional', action: 'start_proxy' }),
    ]));
  });

  it('marks ready routes and reports completion without making a provider call', async () => {
    const settings = createDefaultSettings();
    settings.activeProjectId = 'project-1';
    settings.setupCompletedAt = new Date().toISOString();
    const status = await buildSetupStatus(ports({
      settings: () => Promise.resolve(settings),
      agentCapabilities: () => Promise.resolve([
        { available: true, displayName: 'Codex' },
        { available: false, displayName: 'Claude', unavailableReason: 'Not signed in' },
      ]),
      directApiAvailable: () => Promise.resolve(true),
      directApiDetail: () => Promise.resolve('Ready'),
      services: () => Promise.resolve([service('cognitive1', 'ready'), service('universalProxy', 'ready')]),
    }));

    expect(status.complete).toBe(true);
    expect(status.checks.every((check) => check.status === 'ready' && check.action === undefined)).toBe(true);
    expect(status.checks.find((check) => check.id === 'cli')?.detail).toContain('1 signed-in CLI agent');
  });
});
