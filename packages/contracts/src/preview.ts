import { z } from 'zod';
import { timestampSchema } from './primitives';

export const previewStatusSchema = z.enum(['stopped', 'starting', 'running', 'failed']);
export type PreviewStatus = z.infer<typeof previewStatusSchema>;

/** One way to start the project: the command to run, and a short name for it (a framework, or the script name). */
export const previewCandidateSchema = z
  .object({
    command: z.string().min(1).max(2_000),
    label: z.string().min(1).max(120),
  })
  .strict();
export type PreviewCandidate = z.infer<typeof previewCandidateSchema>;

export const previewInfoSchema = z
  .object({
    available: z.boolean(),
    command: z.string().max(2_000),
    /** Everything the project's files say starts it, best first. A project with a front end and a server has two. */
    candidates: z.array(previewCandidateSchema).max(12),
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
