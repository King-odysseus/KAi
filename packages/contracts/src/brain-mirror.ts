import { z } from 'zod';

/**
 * The second brain, seen from the outside. KAI writes to its own C1 daemon; when a mirror is configured the same
 * lesson is filed into another daemon too, so a person who already runs C1 elsewhere keeps one record. These types
 * cover the once-only copy of the entries a brain already holds.
 */

export const brainMirrorInputSchema = z
  .object({
    /** Reports what would be filed without filing it. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type BrainMirrorInput = z.infer<typeof brainMirrorInputSchema>;

export const brainMirrorOutcomeSchema = z
  .object({
    /** Entries read from this brain. */
    read: z.number().int().min(0),
    /** Entries the other brain accepted. */
    posted: z.number().int().min(0),
    /** Entries the other brain already had, so nothing was sent for them. */
    skipped: z.number().int().min(0),
    /** Entries that were sent and the other brain turned away: duplicates, or its own quality rules. */
    rejected: z.number().int().min(0),
    /** Entries that could not be delivered at all. */
    failed: z.number().int().min(0),
  })
  .strict();
export type BrainMirrorOutcome = z.infer<typeof brainMirrorOutcomeSchema>;
