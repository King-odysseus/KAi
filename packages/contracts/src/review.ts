import { z } from 'zod';

export const reviewModeSchema = z.enum(['novice', 'intermediate', 'expert']);
export type ReviewMode = z.infer<typeof reviewModeSchema>;

/** The most files one AI review reads. A bigger change is reviewed in parts. */
export const MAX_REVIEW_FILES = 40;

export const reviewChangesInputSchema = z
  .object({
    projectId: z.string().min(1),
    paths: z.array(z.string().min(1).max(1_024)).min(1).max(MAX_REVIEW_FILES),
    /** What the changes were meant to do. Blank reviews them for correctness, safety and consistency. */
    request: z.string().max(4_000).optional(),
    mode: reviewModeSchema,
  })
  .strict();
export type ReviewChangesInput = z.infer<typeof reviewChangesInputSchema>;

export const reviewFindingSchema = z
  .object({
    file: z.string().min(1),
    /** A line in the changed file, when the reviewer could point to one. */
    line: z.number().int().positive().optional(),
    severity: z.enum(['high', 'medium', 'low']),
    note: z.string().min(1),
  })
  .strict();
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const changeReviewResultSchema = z
  .object({
    /** True when nothing in the changes needs the user's attention. */
    ok: z.boolean(),
    summary: z.string(),
    findings: z.array(reviewFindingSchema),
    reviewedFiles: z.array(z.string()),
    /** Files that were not read, and why (binary, no text change, or too much for one review). */
    skippedFiles: z.array(z.object({ file: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type ChangeReviewResult = z.infer<typeof changeReviewResultSchema>;
