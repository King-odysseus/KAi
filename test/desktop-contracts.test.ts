import { describe, expect, it } from 'vitest';
import {
  appSettingsV1Schema,
  conversationRecordV1Schema,
  createDefaultSettings,
  migrateConversation,
  migrateSettings,
  parseIpcInput,
  safeParsePersistedEvent,
} from '../packages/contracts/src';

describe('desktop contracts', () => {
  it('creates a valid default settings record', () => {
    const settings = createDefaultSettings();
    expect(appSettingsV1Schema.parse(settings)).toEqual(settings);
    expect(settings.defaultAgent).toBe('codex');
    expect(settings.defaultAutonomy).toBe('ask');
    expect(settings.directApi).toMatchObject({ enabled: true, provider: 'openai', model: '' });
  });

  it('rejects malformed IPC before main handles it', () => {
    expect(() => parseIpcInput('projects:open', { id: '' })).toThrow();
    expect(() => parseIpcInput('conversations:get', { id: 42 })).toThrow();
    expect(() => parseIpcInput('agents:cancel', { conversationId: '' })).toThrow();
    expect(() => parseIpcInput('agents:sign-in', { agent: 'unknown' })).toThrow();
    expect(parseIpcInput('projects:open', { id: 'project-1' })).toEqual({ id: 'project-1' });
    expect(parseIpcInput('agents:cancel', { conversationId: 'conv-1' })).toEqual({ conversationId: 'conv-1' });
    expect(parseIpcInput('agents:sign-in', { agent: 'codex' })).toEqual({ agent: 'codex' });
    expect(parseIpcInput('context:preview', { projectId: 'project-1' })).toEqual({ projectId: 'project-1' });
    expect(() => parseIpcInput('context:preview', { projectId: '' })).toThrow();
    expect(parseIpcInput('agents:run', {
      conversationId: 'conv-1',
      prompt: 'Inspect',
      agent: 'codex',
      execution: 'api',
      route: 'direct',
      autonomy: 'ask',
    })).toMatchObject({ execution: 'api' });
  });

  it('validates and normalizes brain IPC requests', () => {
    expect(parseIpcInput('brain:search', { query: ' isolated ', type: 'patterns' })).toMatchObject({
      query: 'isolated',
      tag: '',
      type: 'patterns',
      project: '',
      global: false,
      mode: 'lexical',
      maxResults: 25,
    });
    expect(() => parseIpcInput('brain:search', { maxResults: 0 })).toThrow();
    expect(() => parseIpcInput('brain:update-field', { title: 'entry', field: 'bad:field', value: 'x' })).toThrow();
  });

  it('validates and normalizes proxy history requests', () => {
    expect(parseIpcInput('proxy:history', { search: ' smoke ', status: '5xx' })).toMatchObject({
      search: 'smoke',
      status: '5xx',
      page: 1,
      limit: 50,
    });
    expect(() => parseIpcInput('proxy:history', { limit: 0 })).toThrow();
    expect(() => parseIpcInput('proxy:history-detail', { id: '' })).toThrow();
  });

  it('rejects malformed persisted events', () => {
    expect(safeParsePersistedEvent({ type: 'text.delta', text: 'missing envelope' }).success).toBe(false);
    expect(
      safeParsePersistedEvent({
        schemaVersion: 1,
        id: 'evt-1',
        taskId: 'task-1',
        timestamp: new Date().toISOString(),
        type: 'text.delta',
        text: 'hello',
        channel: 'assistant',
      }).success,
    ).toBe(true);
  });

  it('migrates legacy settings without carrying unknown secret fields forward', () => {
    const migrated = migrateSettings({
      defaultAgent: 'claude',
      defaultRoute: 'proxy',
      defaultAutonomy: 'review',
      windowBounds: { width: 100, height: 100 },
      proxyApiKey: 'should-not-survive',
    });

    expect(migrated.defaultAgent).toBe('claude');
    expect(migrated.defaultRoute).toBe('proxy');
    expect(migrated.defaultAutonomy).toBe('ask');
    expect(migrated.directApi.provider).toBe('openai');
    expect(migrated.directApi.model).toBe('');
    expect(migrated.windowBounds).toBeNull();
    expect('proxyApiKey' in migrated).toBe(false);
  });

  it('normalizes legacy stdio MCP settings and accepts remote HTTP MCP settings', () => {
    const migrated = migrateSettings({
      mcpServers: [{
        id: 'legacy',
        name: 'Legacy local MCP',
        enabled: true,
        command: 'npx',
        args: ['legacy-server'],
        cwd: null,
        envCredentialIds: {},
      }],
    });
    expect(migrated.mcpServers[0]).toMatchObject({ id: 'legacy', transport: 'stdio', command: 'npx' });

    const parsed = appSettingsV1Schema.parse({
      ...createDefaultSettings(),
      mcpServers: [{
        id: 'remote',
        name: 'Remote MCP',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headerCredentialIds: { Authorization: 'mcp.remote' },
      }],
    });
    expect(parsed.mcpServers[0]).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp' });
  });

  it('migrates a legacy conversation into the versioned record and drops unsafe content', () => {
    const migrated = migrateConversation({
      id: 'conv-legacy',
      title: 'Old conversation',
      activeAgent: 'qwen',
      events: ['legacy arbitrary payload'],
    });

    expect(conversationRecordV1Schema.parse(migrated)).toEqual(migrated);
    expect(migrated.events).toEqual([]);
    expect(migrated.activeAgent).toBe('qwen');
  });
});
