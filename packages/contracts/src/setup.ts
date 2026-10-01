import { z } from 'zod';

export const setupCheckIdSchema = z.enum([
  'project',
  'cli',
  'provider',
  'tutor',
  'github',
  'remote',
  'cognitive1',
  'proxy',
]);

export const setupCheckSchema = z
  .object({
    id: setupCheckIdSchema,
    label: z.string().min(1),
    status: z.enum(['ready', 'optional', 'blocked']),
    detail: z.string(),
    action: z.enum(['open_project', 'open_settings', 'open_tutor', 'open_github', 'open_remote', 'start_cognitive1', 'start_proxy']).optional(),
  })
  .strict();

export const setupStatusSchema = z
  .object({
    complete: z.boolean(),
    completedAt: z.string().datetime().nullable(),
    checks: z.array(setupCheckSchema),
  })
  .strict();

export type SetupCheck = z.infer<typeof setupCheckSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** A deliberately small, secret-free preview of a local agent configuration. */
export const agentConfigImportPreviewSchema = z.object({
  agent: z.enum(['codex', 'claude']),
  path: z.string(),
  found: z.boolean(),
  model: z.string().nullable(),
  detail: z.string(),
}).strict();
export type AgentConfigImportPreview = z.infer<typeof agentConfigImportPreviewSchema>;
