import { z } from 'zod';

export const contextItemKindSchema = z.enum(['instructions', 'file', 'skill', 'memory', 'map']);
export const contextSectionKindSchema = z.enum(['instructions', 'files', 'skills', 'memories', 'map']);

export const contextPreviewItemSchema = z
  .object({
    kind: contextItemKindSchema,
    label: z.string().min(1),
    source: z.string().optional(),
    characters: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const contextPreviewSectionSchema = z
  .object({
    kind: contextSectionKindSchema,
    label: z.string().min(1),
    items: z.array(contextPreviewItemSchema),
    characters: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    // Why the section looks the way it does, such as a recall that came back empty because the brain has no such project.
    note: z.string().optional(),
  })
  .strict();

export const contextPreviewSchema = z
  .object({
    totalCharacters: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    approximate: z.literal(true),
    sections: z.array(contextPreviewSectionSchema),
  })
  .strict();

export const contextPreviewInputSchema = z
  .object({
    projectId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
  })
  .strict();

export const contextChipSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().min(1).max(2_000) }).strict(),
  z
    .object({
      type: z.literal('selection'),
      path: z.string().min(1).max(2_000),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      content: z.string().max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal'),
      content: z.string().min(1).max(100_000),
    })
    .strict(),
  z.object({ type: z.literal('gitDiff'), stat: z.string().min(1).max(100_000) }).strict(),
  z
    .object({
      type: z.literal('memory'),
      query: z.string().min(1).max(2_000),
      summary: z.string().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      name: z.string().min(1).max(500),
      path: z.string().min(1).max(2_000),
      // Kept only for the lifetime of a submitted turn so the renderer can show
      // the same visual input in the conversation history.
      dataUrl: z.string().min(1).max(30_000_000).optional(),
    })
    .strict(),
]);

export const contextSearchInputSchema = z
  .object({
    projectId: z.string().min(1),
    query: z.string().max(500),
  })
  .strict();

export const gitDiffStatResultSchema = z
  .object({
    stat: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type ContextPreviewItem = z.infer<typeof contextPreviewItemSchema>;
export type ContextPreviewSection = z.infer<typeof contextPreviewSectionSchema>;
export type ContextPreview = z.infer<typeof contextPreviewSchema>;
export type ContextPreviewInput = z.infer<typeof contextPreviewInputSchema>;
export type ContextChip = z.infer<typeof contextChipSchema>;
export type ContextSearchInput = z.infer<typeof contextSearchInputSchema>;
export type GitDiffStatResult = z.infer<typeof gitDiffStatResultSchema>;
