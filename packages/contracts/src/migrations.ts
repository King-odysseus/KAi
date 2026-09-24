import { z } from 'zod';
import {
  appSettingsV1Schema,
  conversationRecordV1Schema,
  createDefaultSettings,
  cognitive1ServiceSettingsSchema,
  directApiSettingsSchema,
  learningTutorSettingsSchema,
  mcpServerSettingsSchema,
  proxyServiceSettingsSchema,
  type AppSettings,
  type ConversationRecord,
} from './domain';

const legacySettingsSchema = z
  .object({
    defaultAgent: z.string().optional(),
    defaultRoute: z.string().optional(),
    defaultAutonomy: z.string().optional(),
    theme: z.string().optional(),
    activeProjectId: z.string().nullable().optional(),
    projectOrder: z.array(z.string()).optional(),
    windowBounds: z.unknown().optional(),
  })
  .passthrough();

function migrateAgent(value: unknown): AppSettings['defaultAgent'] {
  return value === 'claude' || value === 'qwen' || value === 'gemini' ? value : 'codex';
}

function migrateAutonomy(value: unknown): AppSettings['defaultAutonomy'] {
  if (value === 'review') return 'ask';
  if (value === 'auto') return 'autoEdit';
  if (value === 'plan' || value === 'ask' || value === 'autoEdit' || value === 'full' || value === 'custom') return value;
  return 'ask';
}

export function migrateSettings(input: unknown): AppSettings {
  const root = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const defaults = createDefaultSettings();
  const explicitLearningTutor = learningTutorSettingsSchema.safeParse(root.learningTutor);
  const parsedV1 = appSettingsV1Schema.safeParse(input);
  if (parsedV1.success) {
    if (explicitLearningTutor.success) return parsedV1.data;
    const directApi = directApiSettingsSchema.safeParse(root.directApi);
    return appSettingsV1Schema.parse({
      ...parsedV1.data,
      learningTutor: directApi.success
        ? { ...directApi.data, enabled: true }
        : defaults.learningTutor,
    });
  }

  const legacy = legacySettingsSchema.parse(input ?? {});
  const cognitive1 = cognitive1ServiceSettingsSchema.safeParse(legacy.cognitive1);
  const directApi = directApiSettingsSchema.safeParse(legacy.directApi);
  const learningTutor = learningTutorSettingsSchema.safeParse(legacy.learningTutor);
  const proxy = proxyServiceSettingsSchema.safeParse(legacy.proxy);
  const mcpServers = z.array(mcpServerSettingsSchema).safeParse(legacy.mcpServers);
  const legacyProxy = legacy.proxy && typeof legacy.proxy === 'object' ? legacy.proxy as Record<string, unknown> : {};
  return appSettingsV1Schema.parse({
    ...defaults,
    defaultAgent: migrateAgent(legacy.defaultAgent),
    defaultRoute: legacy.defaultRoute === 'proxy' ? 'proxy' : 'direct',
    defaultAutonomy: migrateAutonomy(legacy.defaultAutonomy),
    theme: legacy.theme === 'light' || legacy.theme === 'navy' || legacy.theme === 'purple' ? legacy.theme : 'dark',
    activeProjectId: legacy.activeProjectId ?? null,
    projectOrder: legacy.projectOrder ?? [],
    directApi: directApi.success ? directApi.data : defaults.directApi,
    learningTutor: learningTutor.success
      ? learningTutor.data
      : directApi.success
        ? { ...directApi.data, enabled: true }
        : defaults.learningTutor,
    mcpServers: mcpServers.success ? mcpServers.data : defaults.mcpServers,
    cognitive1: cognitive1.success ? cognitive1.data : defaults.cognitive1,
    proxy: proxy.success ? proxy.data : {
      ...defaults.proxy,
      enabled: typeof legacyProxy.enabled === 'boolean' ? legacyProxy.enabled : defaults.proxy.enabled,
      port: typeof legacyProxy.port === 'number' ? legacyProxy.port : defaults.proxy.port,
    },
  });
}

const legacyConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
    activeAgent: z.string().nullable().optional(),
    route: z.string().nullable().optional(),
    autonomy: z.string().nullable().optional(),
    turns: z.array(z.unknown()).optional(),
  })
  .passthrough();

export function migrateConversation(input: unknown): ConversationRecord {
  const parsedV1 = conversationRecordV1Schema.safeParse(input);
  if (parsedV1.success) return parsedV1.data;

  const legacy = legacyConversationSchema.parse(input);
  const now = new Date().toISOString();
  const agent = legacy.activeAgent;
  return conversationRecordV1Schema.parse({
    schemaVersion: 1,
    id: legacy.id,
    projectId: null,
    title: legacy.title ?? 'Recovered conversation',
    createdAt: legacy.createdAt ?? now,
    updatedAt: legacy.updatedAt ?? now,
    archived: legacy.archived ?? false,
    unread: legacy.unread ?? false,
    activeAgent: agent === 'claude' || agent === 'codex' || agent === 'qwen' || agent === 'gemini' ? agent : null,
    route: legacy.route === 'proxy' || legacy.route === 'direct' ? legacy.route : null,
    autonomy:
      legacy.autonomy === 'plan' ||
      legacy.autonomy === 'ask' ||
      legacy.autonomy === 'autoEdit' ||
      legacy.autonomy === 'full' ||
      legacy.autonomy === 'custom'
        ? legacy.autonomy
        : null,
    turns: [],
    events: [],
  });
}
