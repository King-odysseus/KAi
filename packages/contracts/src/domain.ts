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

export const cognitive1ServiceSettingsSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().url(),
    dataPath: z.string().nullable(),
  })
  .strict();

export const proxyServiceSettingsSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
    targetBaseUrl: z.string().url(),
    defaultModel: z.string().min(1),
    credentialId: z.string().min(1),
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

const mcpServerBaseSchema = {
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  enabled: z.boolean(),
};

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
    directApi: directApiSettingsSchema,
    mcpServers: z.array(mcpServerSettingsSchema),
    cognitive1: cognitive1ServiceSettingsSchema,
    proxy: proxyServiceSettingsSchema,
  })
  .strict();

export const projectPreferencesV1Schema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: z.string().min(1),
    agent: agentIdSchema.optional(),
    route: routeModeSchema.optional(),
    autonomy: autonomyModeSchema.optional(),
    customPermissions: z.record(permissionKeySchema, z.boolean()).optional(),
    alwaysAllowRules: z.array(z.string()).optional(),
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
    turns: z.array(conversationTurnSchema),
    events: z.array(persistedEventV1Schema),
  })
  .strict();

export type ProjectRecord = z.infer<typeof projectRecordV1Schema>;
export type AppSettings = z.infer<typeof appSettingsV1Schema>;
export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>;
export type McpStdioServerSettings = z.infer<typeof mcpStdioServerSettingsSchema>;
export type McpHttpServerSettings = z.infer<typeof mcpHttpServerSettingsSchema>;
export type ProjectPreferences = z.infer<typeof projectPreferencesV1Schema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
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
    directApi: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'provider.openai',
    },
    mcpServers: [],
    cognitive1: {
      enabled: false,
      endpoint: 'http://127.0.0.1:9876',
      dataPath: null,
    },
    proxy: {
      enabled: false,
      port: 8082,
      targetBaseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash',
      credentialId: 'provider.deepseek',
    },
  });
}
