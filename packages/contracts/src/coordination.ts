import { z } from 'zod';

export const activeClaimSchema = z
  .object({
    agent: z.string(),
    project: z.string(),
    what: z.string(),
    files: z.array(z.string()),
    date: z.string(),
    time: z.string(),
  })
  .strict();

export const urgentNoteSchema = z
  .object({
    project: z.string(),
    what: z.string(),
    do: z.string(),
    doNot: z.string(),
    until: z.string(),
  })
  .strict();

export const coordinationOverviewSchema = z
  .object({
    // False when Cognitive1 is not running, so the panels can say so instead of showing "nothing".
    available: z.boolean(),
    claims: z.array(activeClaimSchema),
    urgent: z.array(urgentNoteSchema),
  })
  .strict();

export const conflictSchema = z
  .object({ agent: z.string(), project: z.string(), overlap: z.array(z.string()) })
  .strict();

export const preflightInputSchema = z
  .object({ projectId: z.string().min(1), files: z.array(z.string().min(1)).max(200) })
  .strict();

export const preflightResultSchema = z
  .object({ checked: z.boolean(), conflicts: z.array(conflictSchema) })
  .strict();

export type ActiveClaim = z.infer<typeof activeClaimSchema>;
export type UrgentNote = z.infer<typeof urgentNoteSchema>;
export type CoordinationOverview = z.infer<typeof coordinationOverviewSchema>;
export type PreflightResult = z.infer<typeof preflightResultSchema>;
