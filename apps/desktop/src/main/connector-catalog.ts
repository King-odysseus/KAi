import type { ConnectorCatalogEntry, McpServerSettings } from '@kai/contracts';

interface CatalogDefinition extends ConnectorCatalogEntry {
  command: string;
  args: string[];
  /** Credential IDs keyed by the environment variable they fill. */
  credentialEnv: Record<string, string>;
}

/**
 * A small curated catalog. Everything here is a published MCP server, added disabled and with no secrets, so the
 * person can read the command line, fill a key and enable it in the MCP card.
 */
const CATALOG: readonly CatalogDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read repositories, issues and pull requests, and create branches and pull requests.',
    risk: 'medium',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    credentials: [{ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', credentialId: 'catalog.github.token', label: 'GitHub personal access token' }],
    credentialEnv: { GITHUB_PERSONAL_ACCESS_TOKEN: 'catalog.github.token' },
  },
  {
    id: 'memory',
    name: 'Memory (knowledge graph)',
    description: 'A local knowledge graph the agent can write facts to and read back in later runs.',
    risk: 'low',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    credentials: [],
    credentialEnv: {},
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    description: 'A structured scratchpad for breaking a hard problem into steps. No external service.',
    risk: 'low',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    credentials: [],
    credentialEnv: {},
  },
];

export function listConnectorCatalog(): ConnectorCatalogEntry[] {
  return CATALOG.map(({ command: _command, args: _args, credentialEnv: _credentialEnv, ...entry }) => entry);
}

/** Builds the disabled MCP entry for one catalog item, or null when the id is unknown. */
export function connectorServer(id: string): McpServerSettings | null {
  const entry = CATALOG.find((item) => item.id === id);
  if (!entry) return null;
  return {
    id: `catalog-${entry.id}`,
    name: entry.name,
    enabled: false,
    transport: 'stdio',
    command: entry.command,
    args: [...entry.args],
    cwd: null,
    envCredentialIds: { ...entry.credentialEnv },
  };
}
