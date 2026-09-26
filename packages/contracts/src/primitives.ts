import { z } from 'zod';

export const schemaVersionSchema = z.literal(1);
export const agentIdSchema = z.enum(['claude', 'codex', 'qwen', 'gemini', 'kimi']);
export const executionModeSchema = z.enum(['cli', 'api']);
export const themeModeSchema = z.enum(['dark', 'navy', 'purple', 'light']);

/** Themes in the order the title-bar button cycles through them. */
export const THEME_MODES: ReadonlyArray<{ id: z.infer<typeof themeModeSchema>; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'navy', label: 'Navy' },
  { id: 'purple', label: 'Purple' },
  { id: 'light', label: 'Light' },
];
export const providerIdSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'openai-compatible',
]);
export const autonomyModeSchema = z.enum(['plan', 'ask', 'autoEdit', 'full', 'custom']);
export const routeModeSchema = z.enum(['direct', 'proxy']);
export const permissionKeySchema = z.enum([
  'workspaceEdit',
  'shellCommand',
  'dependencyInstall',
  'configWrite',
  'network',
  'gitCommit',
  'gitPush',
  'destructiveFilesystem',
]);

export const timestampSchema = z.string().min(1);

export const windowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(720),
    height: z.number().int().min(480),
    maximized: z.boolean(),
  })
  .strict();

export const serviceKindSchema = z.enum(['cognitive1', 'universalProxy']);
export const serviceStatusSchema = z.enum([
  'not_configured',
  'stopped',
  'starting',
  'stopping',
  'ready',
  'degraded',
  'failed',
]);

export const serviceStateSchema = z
  .object({
    kind: serviceKindSchema,
    status: serviceStatusSchema,
    detail: z.string(),
    endpoint: z.string().url().nullable(),
    version: z.string().nullable(),
    authentication: z.literal('loopback-token').optional(),
    tokenStored: z.boolean().optional(),
    // Automatic restarts after a crash, and whether KAI has stopped trying.
    restarts: z.number().int().nonnegative().optional(),
    restartsExhausted: z.boolean().optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const logSeveritySchema = z.enum(['debug', 'info', 'warn', 'error']);
export const logCategorySchema = z.enum([
  'agent_crash',
  'agent_unavailable',
  'config_failure',
  'c1_unreachable',
  'proxy_error',
  'diff_apply_failed',
  'handoff_failed',
  'orchestrator_error',
  'renderer_error',
  'ipc_error',
  'persistence_error',
  'credential_error',
  'service_error',
  'internal',
]);

export const logEntrySchema = z
  .object({
    timestamp: timestampSchema,
    severity: logSeveritySchema,
    category: logCategorySchema,
    message: z.string(),
    detail: z.string().optional(),
    stack: z.string().optional(),
  })
  .strict();

export type AgentId = z.infer<typeof agentIdSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type ThemeMode = z.infer<typeof themeModeSchema>;
export type ProviderId = z.infer<typeof providerIdSchema>;
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;
export type RouteMode = z.infer<typeof routeModeSchema>;
export type PermissionKey = z.infer<typeof permissionKeySchema>;
export type WindowBounds = z.infer<typeof windowBoundsSchema>;
export type ServiceKind = z.infer<typeof serviceKindSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceState = z.infer<typeof serviceStateSchema>;
export type LogSeverity = z.infer<typeof logSeveritySchema>;
export type LogCategory = z.infer<typeof logCategorySchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
