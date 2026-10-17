import { describe, expect, it } from 'vitest';
import { connectorServer, listConnectorCatalog } from '../apps/desktop/src/main/connector-catalog';

describe('connector catalog', () => {
  it('lists a small curated set with risk labels', () => {
    const catalog = listConnectorCatalog();
    expect(catalog.map((entry) => entry.id)).toEqual(expect.arrayContaining(['github', 'memory', 'sequential-thinking']));
    expect(catalog.find((entry) => entry.id === 'github')?.risk).toBe('medium');
    // The internal command line is not part of the catalog the UI receives.
    expect(catalog[0]).not.toHaveProperty('command');
  });

  it('builds a disabled stdio entry with credential placeholders and no secrets', () => {
    expect(connectorServer('github')).toEqual({
      id: 'catalog-github',
      name: 'GitHub',
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      cwd: null,
      envCredentialIds: { GITHUB_PERSONAL_ACCESS_TOKEN: 'catalog.github.token' },
    });
    expect(connectorServer('memory')).toMatchObject({ enabled: false, envCredentialIds: {} });
  });

  it('refuses an unknown id', () => {
    expect(connectorServer('not-in-the-catalog')).toBeNull();
  });
});
