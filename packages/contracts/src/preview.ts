import { z } from 'zod';
import { timestampSchema } from './primitives';

export const previewStatusSchema = z.enum(['stopped', 'starting', 'running', 'failed']);
export type PreviewStatus = z.infer<typeof previewStatusSchema>;

export const previewInfoSchema = z
  .object({
    available: z.boolean(),
    command: z.string().max(2_000),
    preloadPath: z.string().min(1),
    suggestedUrl: z.string().url().nullable(),
  })
  .strict();
export type PreviewInfo = z.infer<typeof previewInfoSchema>;

export const previewStateSchema = z
  .object({
    projectId: z.string().min(1),
    status: previewStatusSchema,
    command: z.string().max(2_000),
    url: z.string().url().nullable(),
    outputTail: z.string().max(20_000),
    startedAt: timestampSchema.nullable(),
    exitCode: z.number().int().nullable(),
    message: z.string().max(2_000).nullable(),
  })
  .strict();
export type PreviewState = z.infer<typeof previewStateSchema>;

export const previewProjectInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type PreviewProjectInput = z.infer<typeof previewProjectInputSchema>;

export const previewStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    command: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type PreviewStartInput = z.infer<typeof previewStartInputSchema>;
