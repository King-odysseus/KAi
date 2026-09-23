import { z } from 'zod';

export const projectFileEntrySchema = z.object({ path: z.string().min(1), size: z.number().int().nonnegative() }).strict();

export const projectFileTreeSchema = z
  .object({ files: z.array(projectFileEntrySchema), truncated: z.boolean() })
  .strict();

export const eolSchema = z.enum(['lf', 'crlf']);

export const openedFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    eol: eolSchema,
    bom: z.boolean(),
    hash: z.string().min(1),
    mtimeMs: z.number(),
    size: z.number().int().nonnegative(),
  })
  .strict();

export const fileReadInputSchema = z.object({ projectId: z.string().min(1), path: z.string().min(1) }).strict();

export const fileWriteInputSchema = z
  .object({
    projectId: z.string().min(1),
    path: z.string().min(1),
    content: z.string().max(2_000_000),
    // null creates a new file; otherwise the hash the editor loaded, used to detect edits made elsewhere.
    expectedHash: z.string().min(1).nullable(),
    eol: eolSchema,
    bom: z.boolean(),
  })
  .strict();

export const writtenFileSchema = z
  .object({ hash: z.string().min(1), mtimeMs: z.number(), size: z.number().int().nonnegative() })
  .strict();

export const fileChangedInputSchema = z
  .object({ projectId: z.string().min(1), path: z.string().min(1), expectedHash: z.string().min(1) })
  .strict();

export const rejectHunksInputSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    filePath: z.string().min(1),
    hunkIds: z.array(z.number().int().nonnegative()).min(1).max(500),
  })
  .strict();

export type ProjectFileEntry = z.infer<typeof projectFileEntrySchema>;
export type ProjectFileTree = z.infer<typeof projectFileTreeSchema>;
export type OpenedFile = z.infer<typeof openedFileSchema>;
export type FileWriteInput = z.infer<typeof fileWriteInputSchema>;
export type WrittenFile = z.infer<typeof writtenFileSchema>;
