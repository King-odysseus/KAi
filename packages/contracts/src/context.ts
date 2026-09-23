import { z } from 'zod';

export const contextItemKindSchema = z.enum(['instructions', 'file', 'skill', 'memory']);
export const contextSectionKindSchema = z.enum(['instructions', 'files', 'skills', 'memories']);

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

export type ContextPreviewItem = z.infer<typeof contextPreviewItemSchema>;
export type ContextPreviewSection = z.infer<typeof contextPreviewSectionSchema>;
export type ContextPreview = z.infer<typeof contextPreviewSchema>;
export type ContextPreviewInput = z.infer<typeof contextPreviewInputSchema>;
