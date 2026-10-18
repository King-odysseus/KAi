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

/** A project-relative path, used by the file actions that do not read or write content. */
export const filePathInputSchema = z.object({ projectId: z.string().min(1), path: z.string().min(1).max(2_000) }).strict();

export const fileRenameInputSchema = z
  .object({
    projectId: z.string().min(1),
    from: z.string().min(1).max(2_000),
    to: z.string().min(1).max(2_000),
  })
  .strict();

export const fileMutationResultSchema = z.object({ path: z.string().min(1) }).strict();

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

export const editorDocumentStateSchema = z
  .object({
    projectId: z.string().min(1),
    path: z.string().min(1).max(2_000),
    content: z.string().max(2_000_000),
    savedContent: z.string().max(2_000_000),
    expectedHash: z.string().min(1),
    eol: eolSchema,
    bom: z.boolean(),
    dirty: z.boolean(),
  })
  .strict();

export const editorDocumentRemoveSchema = z
  .object({ projectId: z.string().min(1), path: z.string().min(1).max(2_000) })
  .strict();

export const editorSavedDocumentSchema = z
  .object({
    projectId: z.string().min(1),
    path: z.string().min(1).max(2_000),
    hash: z.string().min(1),
    mtimeMs: z.number(),
    size: z.number().int().nonnegative(),
    savedContent: z.string().max(2_000_000),
  })
  .strict();

export const editorWindowSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    documents: z.array(editorDocumentStateSchema).max(100),
    openPaths: z.array(z.string().min(1).max(2_000)).max(100),
    activePath: z.string().min(1).max(2_000).nullable(),
  })
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
export type FilePathInput = z.infer<typeof filePathInputSchema>;
export type FileRenameInput = z.infer<typeof fileRenameInputSchema>;
export type FileMutationResult = z.infer<typeof fileMutationResultSchema>;
export type WrittenFile = z.infer<typeof writtenFileSchema>;
export type EditorDocumentState = z.infer<typeof editorDocumentStateSchema>;
export type EditorDocumentRemove = z.infer<typeof editorDocumentRemoveSchema>;
export type EditorSavedDocument = z.infer<typeof editorSavedDocumentSchema>;
export type EditorWindowSnapshot = z.infer<typeof editorWindowSnapshotSchema>;
