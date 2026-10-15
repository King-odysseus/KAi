import { z } from 'zod';

export const schemaVersionSchema = z.literal(1);
export const agentIdSchema = z.enum(['claude', 'codex', 'qwen', 'gemini', 'kimi']);
export const executionModeSchema = z.enum(['cli', 'api']);
export const themeModeSchema = z.enum([
  'code', 'dark', 'navy', 'purple', 'forest',
  'light', 'sky', 'meadow', 'sand',
]);

/** Which half of the palette a theme draws from, for the things that are not CSS: Monaco, and the light overrides. */
export type ThemeFamily = 'dark' | 'light';

/**
 * Every theme, in the order the title-bar button cycles through them and the order the picker lists them: the dark
 * ones first, then the light ones.
 *
 * `family` is what the rest of the app reads instead of naming a theme. The light-mode rules in `styles.css` are
 * written once against `[data-theme-family="light"]` rather than repeated per theme, so a new light theme is a block
 * of colour tokens and nothing else — and the code editor picks its palette by family without a list that has to be
 * kept in step with this one.
 */
export const THEME_MODES: ReadonlyArray<{ id: z.infer<typeof themeModeSchema>; label: string; family: ThemeFamily }> = [
  { id: 'code', label: 'Editor — neutral', family: 'dark' },
  { id: 'dark', label: 'Dark', family: 'dark' },
  { id: 'navy', label: 'Navy — blue', family: 'dark' },
  { id: 'purple', label: 'Purple — violet', family: 'dark' },
  { id: 'forest', label: 'Forest — green', family: 'dark' },
  { id: 'light', label: 'Light — teal', family: 'light' },
  { id: 'sky', label: 'Sky — blue', family: 'light' },
  { id: 'meadow', label: 'Meadow — green', family: 'light' },
  { id: 'sand', label: 'Sand — warm', family: 'light' },
];

/** The family of a theme, defaulting to dark for a value this build does not know. */
export function themeFamily(theme: string | null | undefined): ThemeFamily {
  return THEME_MODES.find((item) => item.id === theme)?.family ?? 'dark';
}
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
  'lmstudio',
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
