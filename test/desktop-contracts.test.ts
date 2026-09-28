import { describe, expect, it } from 'vitest';
import {
  appSettingsV1Schema,
  cognitive1McpTools,
  conversationRecordV1Schema,
  createDefaultSettings,
  directProviderPreset,
  migrateDeepSeekModel,
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
    expect(settings.theme).toBe('dark');
    expect(settings.directApi).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-6-astra' });
    expect(settings.learningTutor).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-6-astra' });
    expect(settings.editor).toEqual({ autoSave: true, autoSaveDelayMs: 1_000, formatOnSave: true });
    expect(settings.cognitive1.overwatch).toEqual({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      credentialId: 'cognitive1.overwatch',
      model: 'deepseek-v4-pro',
      autoRejectThreshold: 0.85,
    });
  });

  it('ships current provider model catalogs', () => {
    expect(directProviderPreset('openai')).toMatchObject({
      defaultModel: 'gpt-6-astra',
      models: expect.arrayContaining(['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    });
    expect(directProviderPreset('deepseek')).toMatchObject({
      defaultModel: 'deepseek-v4-pro',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    });
    expect(migrateDeepSeekModel('deepseek-flash')).toBe('deepseek-flash');
    expect(migrateDeepSeekModel('deepseek-v4.1-flash')).toBe('deepseek-flash');
    expect(migrateDeepSeekModel('DeepSeek-V4-Pro-0813')).toBe('deepseek-v4-pro');
    expect(directProviderPreset('openrouter')).toMatchObject({
      defaultModel: 'openai/gpt-6-astra',
      models: expect.arrayContaining([
        'openai/gpt-6-astra',
        'anthropic/claude-opus-5.5',
        'google/gemini-3.8-flash',
        'x-ai/grok-4.20',
        'deepseek/deepseek-v4.1-flash',
      ]),
    });
    expect(directProviderPreset('xai')).toMatchObject({
      defaultModel: 'grok-4.20',
      models: expect.arrayContaining(['grok-4.20', 'grok-4.20-reasoning', 'grok-4.7']),
    });
    expect(directProviderPreset('together').models).toEqual(expect.arrayContaining([
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'Qwen/Qwen3.8-2.4T-A95B',
    ]));
    expect(directProviderPreset('fireworks').models).toEqual(expect.arrayContaining([
      'accounts/fireworks/models/deepseek-v4p1-flash',
      'accounts/fireworks/models/kimi-k3',
    ]));
  });

  it('rejects malformed IPC before main handles it', () => {
    expect(() => parseIpcInput('projects:open', { id: '' })).toThrow();
    expect(() => parseIpcInput('conversations:get', { id: 42 })).toThrow();
    expect(() => parseIpcInput('agents:cancel', { conversationId: '' })).toThrow();
    expect(() => parseIpcInput('agents:sign-in', { agent: 'unknown' })).toThrow();
    expect(parseIpcInput('projects:open', { id: 'project-1' })).toEqual({ id: 'project-1' });
    expect(parseIpcInput('agents:cancel', { conversationId: 'conv-1' })).toEqual({ conversationId: 'conv-1' });
    expect(parseIpcInput('agents:sign-in', { agent: 'codex' })).toEqual({ agent: 'codex' });
    expect(parseIpcInput('agents:install', { agent: 'kimi' })).toEqual({ agent: 'kimi' });
    expect(() => parseIpcInput('agents:install', { agent: 'unknown' })).toThrow();
    expect(parseIpcInput('settings:update', { directApi: { provider: 'openrouter' } })).toMatchObject({
      directApi: { provider: 'openrouter' },
    });
    expect(parseIpcInput('settings:update', { directApi: { provider: 'deepseek' } })).toMatchObject({
      directApi: { provider: 'deepseek' },
    });
    expect(parseIpcInput('settings:update', { learningTutor: { provider: 'deepseek', model: 'deepseek-v4-pro' } })).toMatchObject({
      learningTutor: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    });
    expect(parseIpcInput('providers:list-models', {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialId: 'provider.openrouter',
    })).toMatchObject({ provider: 'openrouter' });
    expect(parseIpcInput('settings:update', { theme: 'light' })).toEqual({ theme: 'light' });
    expect(parseIpcInput('settings:update', { editor: { autoSave: false, autoSaveDelayMs: 1_500 } })).toEqual({
      editor: { autoSave: false, autoSaveDelayMs: 1_500 },
    });
    expect(() => parseIpcInput('settings:update', { editor: { autoSaveDelayMs: 50 } })).toThrow();
    expect(parseIpcInput('settings:update', {
      cognitive1: {
        overwatch: {
          enabled: true,
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          credentialId: 'cognitive1.overwatch',
          model: 'deepseek-v4-pro',
          autoRejectThreshold: 0.9,
        },
      },
    })).toMatchObject({
      cognitive1: {
        overwatch: {
          enabled: true,
          autoRejectThreshold: 0.9,
        },
      },
    });
    expect(parseIpcInput('settings:update', {
      cognitive1: {
        overwatch: {
          enabled: true,
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          credentialId: 'cognitive1.overwatch',
          model: 'gpt-6-astra',
          autoRejectThreshold: 0.9,
        },
      },
    })).toMatchObject({
      cognitive1: {
        overwatch: {
          provider: 'openai',
        },
      },
    });
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
    expect(parseIpcInput('conversations:compact', { conversationId: 'conv-1' })).toEqual({
      conversationId: 'conv-1',
    });
    expect(() => parseIpcInput('conversations:compact', { conversationId: '' })).toThrow();
  });

  it('persists durable conversation compaction metadata', () => {
    const now = new Date().toISOString();
    const conversation = conversationRecordV1Schema.parse({
      schemaVersion: 1,
      id: 'conv-compacted',
      projectId: 'project-1',
      title: 'Compact this thread',
      createdAt: now,
      updatedAt: now,
      archived: false,
      unread: false,
      activeAgent: 'codex',
      route: 'direct',
      autonomy: 'ask',
      execution: 'api',
      compaction: {
        summary: 'Objective: finish the desktop feature.',
        createdAt: now,
        throughTurnIndex: 3,
        originalTurns: 4,
        originalCharacters: 1_200,
      },
      turns: [],
      events: [],
    });
    expect(conversation.compaction).toMatchObject({
      throughTurnIndex: 3,
      originalTurns: 4,
    });
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
    expect(parseIpcInput('cognitive1:tool', { tool: 'brain_recall', arguments: { query: 'desktop' } })).toEqual({
      tool: 'brain_recall',
      arguments: { query: 'desktop' },
    });
    expect(parseIpcInput('cognitive1:tool', { tool: 'brain_status' })).toEqual({
      tool: 'brain_status',
      arguments: {},
    });
    expect(cognitive1McpTools).toEqual(expect.arrayContaining([
      'brain_recall',
      'session_start',
      'project_init',
      'context_pack',
      'compaction_check',
      'style_guide_extract',
    ]));
    expect(() => parseIpcInput('cognitive1:tool', { tool: 'arbitrary_tool' })).toThrow();
  });

  it('validates and normalizes proxy history requests', () => {
    expect(parseIpcInput('proxy:history', { search: ' smoke ', agent: 'claude', status: '5xx' })).toMatchObject({
      search: 'smoke',
      agent: 'claude',
      status: '5xx',
      page: 1,
      limit: 50,
    });
    expect(() => parseIpcInput('proxy:history', { limit: 0 })).toThrow();
    expect(() => parseIpcInput('proxy:history', { agent: 'unknown' })).toThrow();
    expect(() => parseIpcInput('proxy:history-detail', { id: '' })).toThrow();
  });

  it('accepts opt-in timed routing without changing other route actions', () => {
    expect(parseIpcInput('proxy:route-action', {
      agent: 'claude',
      action: 'route',
      routeUntil: 1_800_000_000_000,
    })).toEqual({
      agent: 'claude',
      action: 'route',
      routeUntil: 1_800_000_000_000,
    });
    expect(parseIpcInput('proxy:route-action', { agent: 'codex', action: 'direct' })).toEqual({
      agent: 'codex',
      action: 'direct',
    });
    expect(() => parseIpcInput('proxy:route-action', { agent: 'claude', action: 'route', routeUntil: -1 })).toThrow();
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
    expect(migrated.theme).toBe('dark');
    expect(migrated.directApi.provider).toBe('openai');
    expect(migrated.directApi.model).toBe('gpt-6-astra');
    expect(migrated.learningTutor).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-6-astra' });
    expect(migrated.windowBounds).toBeNull();
    expect('proxyApiKey' in migrated).toBe(false);
  });

  it('adds Overwatch defaults without discarding an existing C1 configuration', () => {
    const migrated = migrateSettings({
      cognitive1: {
        enabled: true,
        endpoint: 'http://127.0.0.1:9999',
        dataPath: 'C:\\KAI\\brain',
      },
    });

    expect(migrated.cognitive1).toMatchObject({
      enabled: true,
      endpoint: 'http://127.0.0.1:9999',
      dataPath: 'C:\\KAI\\brain',
      overwatch: {
        enabled: false,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      },
    });
  });

  it('migrates the existing Direct API connection into an independent Learning Tutor connection', () => {
    const migrated = migrateSettings({
      directApi: {
        enabled: false,
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        credentialId: 'provider.deepseek',
      },
    });

    expect(migrated.directApi.enabled).toBe(false);
    expect(migrated.learningTutor).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      credentialId: 'provider.deepseek',
    });

    const completeLegacy = { ...createDefaultSettings(), directApi: migrated.directApi } as Record<string, unknown>;
    delete completeLegacy.learningTutor;
    expect(appSettingsV1Schema.safeParse(completeLegacy).success).toBe(false);
    expect(migrateSettings(completeLegacy).learningTutor).toEqual(migrated.learningTutor);
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
