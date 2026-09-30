import { z } from 'zod';
import { persistedEventV1Schema } from './events';
import {
  agentIdSchema,
  autonomyModeSchema,
  executionModeSchema,
  permissionKeySchema,
  providerIdSchema,
  routeModeSchema,
  schemaVersionSchema,
  themeModeSchema,
  timestampSchema,
  windowBoundsSchema,
} from './primitives';
import { projectAutomationSchema } from './automation';
import { notificationSettingsSchema } from './notifications';
import { autoModelSettingsSchema, createDefaultAutoModel } from './model-tiers';
import { createDefaultPromptGuide, promptGuideSettingsSchema } from './prompt-guide';
import { createDefaultRemoteAccess, remoteAccessSettingsSchema } from './remote';
import { agentTeamSchema, createDefaultAgentTeam } from './team';
import { updateSettingsSchema } from './updates';
import { usageBudgetSchema } from './usage';
import {
  checkpointRecordSchema,
  turnFileChangeSchema,
  workbenchGoalSchema,
  workflowSchema,
} from './workbench';

export const projectRecordV1Schema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    createdAt: timestampSchema,
    lastOpenedAt: timestampSchema,
  })
  .strict();

export const cognitive1OverwatchSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['deepseek', 'claude', 'openai']).default('deepseek'),
    baseUrl: z.string().url().default('https://api.deepseek.com'),
    credentialId: z.string().min(1).default('cognitive1.overwatch'),
    model: z.string().min(1).default('deepseek-v4-pro'),
    autoRejectThreshold: z.number().min(0).max(1).default(0.85),
  })
  .strict();

export const cognitive1ServiceSettingsSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().url(),
    dataPath: z.string().nullable(),
    overwatch: cognitive1OverwatchSettingsSchema.default({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      credentialId: 'cognitive1.overwatch',
      model: 'deepseek-v4-pro',
      autoRejectThreshold: 0.85,
    }),
  })
  .strict();

export const proxyProviderEntrySchema = z
  .object({
    baseUrl: z.string().url(),
    credentialId: z.string().min(1).optional(),
    format: z.enum(['auto', 'anthropic', 'openai']).default('auto'),
    defaultModel: z.string().optional(),
    modelMap: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const proxyFallbackProviderSchema = z
  .object({
    baseUrl: z.string().url(),
    credentialId: z.string().min(1).optional(),
    defaultModel: z.string().optional(),
    modelMap: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const proxyModelRouteSchema = z
  .object({
    match: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

export const proxyAgentBackendSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url(),
    credentialId: z.string().min(1).optional(),
    defaultModel: z.string().min(1),
    configModel: z.string().min(1).optional(),
  })
  .strict();

export const proxyCostBudgetSchema = z
  .object({
    daily: z.number().nonnegative().default(0),
    weekly: z.number().nonnegative().default(0),
    monthly: z.number().nonnegative().default(0),
    currency: z.string().min(1).default('USD'),
    mode: z.enum(['warn', 'block']).default('warn'),
  })
  .strict();

export const proxyHistorySettingsSchema = z
  .object({
    maxEntries: z.number().int().min(100).max(2000).default(500),
    includePromptSnippet: z.boolean().default(true),
    promptSnippetChars: z.number().int().min(100).max(2000).default(500),
    maxReplayEntries: z.number().int().min(0).max(200).default(50),
  })
  .strict();

export const proxyRetrySettingsSchema = z
  .object({
    maxRetries: z.number().int().min(0).max(10).default(3),
    baseDelayMs: z.number().int().min(100).max(30_000).default(1_000),
    maxDelayMs: z.number().int().min(1_000).max(120_000).default(30_000),
  })
  .strict();

export const proxyErrorThresholdSchema = z
  .object({
    count: z.number().int().min(1).max(100).default(5),
    windowMinutes: z.number().int().min(1).max(1_440).default(5),
  })
  .strict();

export const proxyRateLimitSettingsSchema = z
  .object({
    maxRequestsPerSecond: z.number().min(0).default(0),
  })
  .strict();

export const proxyLoggingSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    directory: z.string().default(''),
    maxFileSizeMB: z.number().min(1).max(1_000).default(10),
  })
  .strict();

export const proxyTlsSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    certPath: z.string().default(''),
    keyPath: z.string().default(''),
  })
  .strict();

export const proxyServiceSettingsSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    /** The port KAI last pointed agent config files at, so a port change can carry those routes along. */
    routedPort: z.number().int().min(1024).max(65535).optional(),
    targetBaseUrl: z.string().url(),
    defaultModel: z.string().min(1),
    credentialId: z.string().min(1),
    routeClaudeCode: z.boolean().default(false),
    routeClaudeCodeUntil: z.number().int().nonnegative().default(0),
    routeCodex: z.boolean().default(false),
    autoFallbackEnabled: z.boolean().default(false),
    autoFallbackHours: z.number().min(1).max(24).default(5),
    modelMap: z.record(z.string(), z.string()).default({}),
    customHeaders: z.record(z.string(), z.string()).default({}),
    providers: z.record(z.string(), proxyProviderEntrySchema).default({}),
    modelRouting: z.boolean().default(true),
    modelRoutes: z.array(proxyModelRouteSchema).default([]),
    agentRoutes: z.record(z.string(), z.string()).default({}),
    dualApiEnabled: z.boolean().default(false),
    fallbackProviders: z.array(proxyFallbackProviderSchema).default([]),
    kimiConfig: proxyAgentBackendSettingsSchema.default({
      enabled: false,
      baseUrl: 'https://api.kimi.com/coding/v1',
      defaultModel: 'kimi-for-coding',
    }),
    qwenConfig: proxyAgentBackendSettingsSchema.default({
      enabled: false,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-coder-plus',
      configModel: 'qwen-proxy',
    }),
    codexConfig: proxyAgentBackendSettingsSchema.default({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6-astra',
      configModel: 'gpt-5.5',
    }),
    costBudget: proxyCostBudgetSchema.default({ daily: 0, weekly: 0, monthly: 0, currency: 'USD', mode: 'warn' }),
    historyConfig: proxyHistorySettingsSchema.default({
      maxEntries: 500,
      includePromptSnippet: true,
      promptSnippetChars: 500,
      maxReplayEntries: 50,
    }),
    retryConfig: proxyRetrySettingsSchema.default({ maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 }),
    errorNotifyThreshold: proxyErrorThresholdSchema.default({ count: 5, windowMinutes: 5 }),
    upstreamTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(3_600_000),
    stallTimeoutMs: z.number().int().min(0).max(3_600_000).default(120_000),
    rateLimit: proxyRateLimitSettingsSchema.default({ maxRequestsPerSecond: 0 }),
    maxConcurrentRequests: z.number().int().min(0).default(0),
    logging: proxyLoggingSettingsSchema.default({ enabled: false, directory: '', maxFileSizeMB: 10 }),
    tls: proxyTlsSettingsSchema.default({ enabled: false, certPath: '', keyPath: '' }),
  })
  .strict();

export const directApiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: providerIdSchema,
    model: z.string(),
    baseUrl: z.string().url(),
    credentialId: z.string().min(1),
  })
  .strict();

export const learningTutorSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: providerIdSchema.default('openai'),
    model: z.string().default('gpt-6-astra'),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    credentialId: z.string().min(1).default('provider.openai'),
  })
  .strict();

/** Local-only, redacted records of agent work. Content is captured only when the user enables this setting. */
export const experienceCaptureSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  includeContent: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(3650).default(365),
}).strict();

export const editorSettingsSchema = z
  .object({
    autoSave: z.boolean().default(true),
    autoSaveDelayMs: z.number().int().min(300).max(10_000).default(1_000),
    // Formats a file when the learner saves it (Ctrl+S or the Save button); autosave never reformats mid-typing.
    formatOnSave: z.boolean().default(true),
  })
  .strict();

const mcpServerBaseSchema = {
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  enabled: z.boolean(),
};

export const PLAYWRIGHT_MCP_SERVER_ID = 'playwright-browser';
export const PLAYWRIGHT_MCP_FEATURE_ID = 'mcp.playwright-browser.v1';

/**
 * open-pencil, the local design editor. It runs on this machine and speaks MCP over HTTP with a Bearer token, so
 * KAI reaches it through the same runtime as any other server and the token stays in the credential vault.
 *
 * The token must equal the `OPENPENCIL_MCP_AUTH_TOKEN` the editor was started with; it is not minted per session,
 * and multiple clients share it. The editor publishes it in its own discovery file (`%LOCALAPPDATA%/OpenPencil/mcp.json`
 * on Windows) — read it from there to fill the vault, and never copy it into a config file, a fixture, or the repo.
 * A 401 therefore means KAI's token is missing or wrong, not that another client holds it.
 */
export const OPENPENCIL_MCP_SERVER_ID = 'open-pencil';
export const OPENPENCIL_MCP_FEATURE_ID = 'mcp.open-pencil.v1';
export const OPENPENCIL_ENDPOINT = 'http://127.0.0.1:7600/mcp';
/** Where the Bearer token lives in the vault. Never written to a config file. */
export const OPENPENCIL_CREDENTIAL_ID = 'design.openpencil';

export const mcpStdioServerSettingsSchema = z
  .object({
    ...mcpServerBaseSchema,
    transport: z.literal('stdio').default('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).max(100),
    cwd: z.string().min(1).nullable(),
    envCredentialIds: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export const mcpHttpServerSettingsSchema = z
  .object({
    ...mcpServerBaseSchema,
    transport: z.literal('http'),
    url: z.string().url(),
    headerCredentialIds: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export const mcpServerSettingsSchema = z.union([mcpStdioServerSettingsSchema, mcpHttpServerSettingsSchema]);

// A model name is passed to a CLI as an argument, so it may not start with a dash or contain spaces or shell characters.
export const cliModelNameSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.5 or claude-sonnet-5.');

export const DEFAULT_DESKTOP_SHORTCUTS: Readonly<Record<string, string>> = {
  'workbench': 'Ctrl+1',
  'code': 'Ctrl+2',
  'new-window': 'Ctrl+Shift+N',
  'terminal': 'Ctrl+`',
  'command-palette': 'Ctrl+K',
  'threads': 'Ctrl+Shift+B',
  'context-panel': 'Ctrl+B',
  'shortcuts': 'Ctrl+/',
};

export const appSettingsV1Schema = z
  .object({
    schemaVersion: schemaVersionSchema,
    defaultAgent: agentIdSchema,
    defaultRoute: routeModeSchema,
    defaultAutonomy: autonomyModeSchema,
    theme: themeModeSchema,
    activeProjectId: z.string().nullable(),
    projectOrder: z.array(z.string()),
    windowBounds: windowBoundsSchema.nullable(),
    logRetentionEntries: z.number().int().min(100).max(100_000),
    diagnosticsEnabled: z.boolean(),
    installedFeatures: z.array(z.string().min(1).max(100)).max(200).default([]),
    directApi: directApiSettingsSchema,
    learningTutor: learningTutorSettingsSchema,
    experienceCapture: experienceCaptureSettingsSchema.default({}),
    // Turns a rough idea into a clear goal and one prompt per teammate, on its own provider connection.
    promptGuide: promptGuideSettingsSchema.default(createDefaultPromptGuide),
    editor: editorSettingsSchema.default({}),
    mcpServers: z.array(mcpServerSettingsSchema),
    cognitive1: cognitive1ServiceSettingsSchema,
    proxy: proxyServiceSettingsSchema,
    usageBudget: usageBudgetSchema.default({}),
    notifications: notificationSettingsSchema.default({}),
    updates: updateSettingsSchema.default({}),
    shortcuts: z.record(z.string().min(1).max(100), z.string().min(1).max(80)).default({ ...DEFAULT_DESKTOP_SHORTCUTS }),
    setupCompletedAt: z.string().datetime().nullable().default(null),
    // Model each CLI agent is asked to use. A missing entry means the CLI uses its own configured default.
    agentModels: z.record(agentIdSchema, cliModelNameSchema).default({}),
    // Pick a CLI model by how heavy each request is. A model chosen for a run or a team role still wins.
    autoModel: autoModelSettingsSchema.default(createDefaultAutoModel),
    // Who plans and who does each part when a job is handed to the agent team.
    agentTeam: agentTeamSchema.default(createDefaultAgentTeam),
    // The phone-sized remote console. Off by default; enabling it opens a loopback-only port.
    remote: remoteAccessSettingsSchema.default(createDefaultRemoteAccess),
  })
  .strict();

export const projectPreferencesV1Schema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: z.string().min(1),
    agent: agentIdSchema.optional(),
    // A team just for this project; without it the project uses the team from Settings.
    agentTeam: agentTeamSchema.optional(),
    route: routeModeSchema.optional(),
    autonomy: autonomyModeSchema.optional(),
    customPermissions: z.record(permissionKeySchema, z.boolean()).optional(),
    alwaysAllowRules: z.array(z.string()).optional(),
    // Checks, hooks and review that run around this project's agent runs. Set up by the user, never by the repository.
    automation: projectAutomationSchema.optional(),
  })
  .strict();

export const conversationTurnSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    createdAt: timestampSchema,
    checkpoint: checkpointRecordSchema.nullable().optional(),
    fileChanges: z.array(turnFileChangeSchema).optional(),
    attachments: z.array(z.object({
      name: z.string().min(1).max(500),
      dataUrl: z.string().min(1).max(30_000_000),
    }).strict()).optional(),
  })
  .strict();

export const conversationCompactionSchema = z
  .object({
    summary: z.string().min(1).max(100_000),
    createdAt: timestampSchema,
    throughTurnIndex: z.number().int().nonnegative(),
    originalTurns: z.number().int().nonnegative(),
    originalCharacters: z.number().int().nonnegative(),
  })
  .strict();

export const conversationRecordV1Schema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: z.string().min(1),
    projectId: z.string().nullable(),
    title: z.string(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archived: z.boolean(),
    unread: z.boolean(),
    activeAgent: agentIdSchema.nullable(),
    route: routeModeSchema.nullable(),
    autonomy: autonomyModeSchema.nullable(),
    execution: executionModeSchema.optional(),
    agentSessionId: z.string().min(1).optional(),
    goal: workbenchGoalSchema.nullable().optional(),
    workflow: workflowSchema.nullable().optional(),
    compaction: conversationCompactionSchema.optional(),
    turns: z.array(conversationTurnSchema),
    events: z.array(persistedEventV1Schema),
  })
  .strict();

export type ProjectRecord = z.infer<typeof projectRecordV1Schema>;
export type AppSettings = z.infer<typeof appSettingsV1Schema>;
export type LearningTutorSettings = z.infer<typeof learningTutorSettingsSchema>;
export type ExperienceCaptureSettings = z.infer<typeof experienceCaptureSettingsSchema>;
export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>;
export type McpStdioServerSettings = z.infer<typeof mcpStdioServerSettingsSchema>;
export type McpHttpServerSettings = z.infer<typeof mcpHttpServerSettingsSchema>;
export type ProjectPreferences = z.infer<typeof projectPreferencesV1Schema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationCompaction = z.infer<typeof conversationCompactionSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordV1Schema>;

export function createDefaultSettings(): AppSettings {
  return appSettingsV1Schema.parse({
    schemaVersion: 1,
    defaultAgent: 'codex',
    defaultRoute: 'direct',
    defaultAutonomy: 'ask',
    theme: 'dark',
    activeProjectId: null,
    projectOrder: [],
    windowBounds: null,
    logRetentionEntries: 2000,
    diagnosticsEnabled: true,
    installedFeatures: [],
    directApi: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'provider.openai',
    },
    learningTutor: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'provider.openai',
    },
    experienceCapture: {},
    editor: {
      autoSave: true,
      autoSaveDelayMs: 1_000,
      formatOnSave: true,
    },
    mcpServers: [{
      id: PLAYWRIGHT_MCP_SERVER_ID,
      name: 'Playwright Browser',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      cwd: null,
      envCredentialIds: {},
    }],
    cognitive1: {
      enabled: false,
      // 9876 belongs to the standalone Cognitive1 daemon, so KAI's own managed copy uses the next port.
      endpoint: 'http://127.0.0.1:9877',
      dataPath: null,
      overwatch: {
        enabled: false,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        credentialId: 'cognitive1.overwatch',
        model: 'deepseek-v4-pro',
        autoRejectThreshold: 0.85,
      },
    },
    proxy: {
      enabled: false,
      port: 8082,
      targetBaseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-pro',
      credentialId: 'provider.deepseek',
    },
    shortcuts: { ...DEFAULT_DESKTOP_SHORTCUTS },
    setupCompletedAt: null,
  });
}
