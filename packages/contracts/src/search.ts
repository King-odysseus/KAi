import { z } from 'zod';

export const globalSearchInputSchema = z.object({ query: z.string().trim().min(2).max(200) }).strict();

export const globalSearchSourceSchema = z.enum(['conversation', 'entry', 'handoff', 'daily', 'knowledge']);

export const globalSearchHitSchema = z
  .object({
    source: globalSearchSourceSchema,
    label: z.string(),
    detail: z.string(),
    // Set for conversations, so the palette can open them.
    conversationId: z.string().optional(),
  })
  .strict();

export const globalSearchResultSchema = z
  .object({
    query: z.string(),
    // False when Cognitive1 is not running, so only conversations were searched.
    brainSearched: z.boolean(),
    hits: z.array(globalSearchHitSchema),
  })
  .strict();

export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
