import { z } from 'zod';
import { cardKindSchema } from './studio';

/**
 * Bringing an existing repository into KAI. A scan reads the folder (no model, nothing written) and reports what the
 * project is made of, what is missing, and a first backlog the person can pick from. Only the picked cards are written
 * to the Studio board, so a scan on its own changes nothing.
 */

export const importSeveritySchema = z.enum(['high', 'medium', 'low']);
export type ImportSeverity = z.infer<typeof importSeveritySchema>;

export const importProposedCardSchema = z
  .object({
    title: z.string().min(1).max(200),
    kind: cardKindSchema,
    acceptance: z.array(z.string().min(1).max(400)).min(1).max(6),
    story: z.string().max(1_000),
  })
  .strict();
export type ImportProposedCard = z.infer<typeof importProposedCardSchema>;

export const importFindingSchema = z
  .object({
    /** Stable across scans of the same problem, so a card added once is not offered again. */
    id: z.string().min(1).max(80),
    severity: importSeveritySchema,
    title: z.string().min(1).max(160),
    detail: z.string().max(600),
    /** Paths the finding is about, when it is about particular files. */
    files: z.array(z.string()).max(8),
    card: importProposedCardSchema,
  })
  .strict();
export type ImportFinding = z.infer<typeof importFindingSchema>;

export const importReportSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string(),
    scannedAt: z.string(),
    fileCount: z.number().int().nonnegative(),
    /** True when the scan stopped at its file limit, so the counts are a lower bound. */
    truncated: z.boolean(),
    stack: z.array(z.string()),
    languages: z.array(z.object({ name: z.string(), files: z.number().int().nonnegative() }).strict()),
    testFileCount: z.number().int().nonnegative(),
    /** `npm run …` commands the package defines for checking the project. */
    scripts: z.array(z.string()),
    /** A command the crew and the board can use to prove work, or null when the project has none. */
    suggestedCheck: z.string().nullable(),
    gitAvailable: z.boolean(),
    findings: z.array(importFindingSchema),
    /** Finding ids whose cards are already on the board. */
    onBoard: z.array(z.string()),
  })
  .strict();
export type ImportReport = z.infer<typeof importReportSchema>;

export const importScanInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export const importAddCardsInputSchema = z
  .object({ projectId: z.string().min(1), findingIds: z.array(z.string().min(1).max(80)).min(1).max(40) })
  .strict();
export type ImportAddCardsInput = z.infer<typeof importAddCardsInputSchema>;
