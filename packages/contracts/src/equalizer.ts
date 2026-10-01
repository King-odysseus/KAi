import { z } from 'zod';

/**
 * The Equalizer compares a screen as it is built with the screen as it was designed, reports every difference, and
 * only then lets the user choose what to fix. The live page comes from the dev server KAI starts, or from a
 * production link; the reference is a screen drawn in open-pencil or a page on a website. A design-only run has no
 * live page at all: it checks that the design itself is complete.
 */

export const EQUALIZER_TARGETS = ['dev', 'production', 'design'] as const;
export const equalizerTargetSchema = z.enum(EQUALIZER_TARGETS);
export type EqualizerTarget = z.infer<typeof equalizerTargetSchema>;

export const EQUALIZER_REFERENCES = ['open-pencil', 'website'] as const;
export const equalizerReferenceSchema = z.enum(EQUALIZER_REFERENCES);
export type EqualizerReference = z.infer<typeof equalizerReferenceSchema>;

export const equalizerScreenSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // The path the screen is reached at, such as /dashboard. Needed to open it in a browser.
    route: z.string().trim().max(300).default(''),
  })
  .strict();
export type EqualizerScreen = z.infer<typeof equalizerScreenSchema>;

export const equalizerRunInputSchema = z
  .object({
    projectId: z.string().min(1),
    target: equalizerTargetSchema,
    reference: equalizerReferenceSchema,
    /** The production site, for the production target. */
    liveUrl: z.string().trim().url().max(500).optional(),
    /** The website to match, for the website reference. The same route is opened on both sides. */
    referenceUrl: z.string().trim().url().max(500).optional(),
    screens: z.array(equalizerScreenSchema).min(1).max(60),
    /** Which fixing round this check follows, so a re-check keeps count. */
    round: z.number().int().min(0).max(10).default(0),
    /** How many fixing rounds the user allowed. */
    rounds: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type EqualizerRunInput = z.infer<typeof equalizerRunInputSchema>;

export const equalizerSeveritySchema = z.enum(['high', 'medium', 'low']);
export type EqualizerSeverity = z.infer<typeof equalizerSeveritySchema>;

export const EQUALIZER_KINDS = ['colour', 'typography', 'size', 'spacing', 'radius', 'position', 'content', 'pixels', 'screen'] as const;

export const equalizerDifferenceSchema = z
  .object({
    id: z.string().min(1).max(160),
    severity: equalizerSeveritySchema,
    kind: z.enum(EQUALIZER_KINDS),
    message: z.string().min(1).max(500),
    expected: z.string().max(160).default(''),
    actual: z.string().max(160).default(''),
  })
  .strict();
export type EqualizerDifference = z.infer<typeof equalizerDifferenceSchema>;

export const equalizerScreenResultSchema = z
  .object({
    name: z.string().min(1).max(120),
    route: z.string().max(300),
    status: z.enum(['match', 'differs', 'error', 'not-drawn', 'not-listed']),
    /** Share of pixels that differ, 0 to 1, or null when no pictures were compared. */
    pixelDifference: z.number().min(0).max(1).nullable(),
    differences: z.array(equalizerDifferenceSchema).max(200),
    /** Project-relative paths of the pictures, null where there is none. */
    images: z.object({ reference: z.string().nullable(), live: z.string().nullable(), difference: z.string().nullable() }).strict(),
    error: z.string().max(600).nullable(),
  })
  .strict();
export type EqualizerScreenResult = z.infer<typeof equalizerScreenResultSchema>;

export const equalizerReportSchema = z
  .object({
    id: z.string().min(1).max(80),
    createdAt: z.string().min(1),
    target: equalizerTargetSchema,
    reference: equalizerReferenceSchema,
    round: z.number().int().min(0).max(10),
    rounds: z.number().int().min(1).max(10),
    liveUrl: z.string().nullable(),
    referenceUrl: z.string().nullable(),
    screens: z.array(equalizerScreenResultSchema).max(120),
    /** Things worth knowing that belong to no single screen. */
    notes: z.array(z.string().max(400)).max(20),
    /** The report file, project-relative. */
    reportPath: z.string().max(300),
  })
  .strict();
export type EqualizerReport = z.infer<typeof equalizerReportSchema>;

export const equalizerScreensInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type EqualizerScreensInput = z.infer<typeof equalizerScreensInputSchema>;

/** The screens a project can be checked on, from its pages list, and which of them are already drawn. */
export const equalizerScreensSchema = z
  .object({
    screens: z.array(equalizerScreenSchema),
    drawn: z.array(z.string()),
    hasPages: z.boolean(),
  })
  .strict();
export type EqualizerScreens = z.infer<typeof equalizerScreensSchema>;

export const equalizerImageInputSchema = z.object({ projectId: z.string().min(1), path: z.string().min(1).max(400) }).strict();
export type EqualizerImageInput = z.infer<typeof equalizerImageInputSchema>;

export const equalizerProgressSchema = z
  .object({ projectId: z.string(), done: z.number().int().min(0), total: z.number().int().min(0), current: z.string() })
  .strict();
export type EqualizerProgress = z.infer<typeof equalizerProgressSchema>;

/** Folder, under `.kai/spec`, where reports and their pictures are kept. */
export const EQUALIZER_DIR = 'equalizer';

const SEVERITY_ORDER: Record<EqualizerSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Differences most worth fixing first. */
export function sortDifferences(differences: readonly EqualizerDifference[]): EqualizerDifference[] {
  return [...differences].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

/** How many differences a report holds, in total. */
export function countDifferences(report: Pick<EqualizerReport, 'screens'>): number {
  return report.screens.reduce((total, screen) => total + screen.differences.length, 0);
}

/**
 * Picks the target from what the user wrote. A complaint about "dev", "local" or "my app" means the dev server;
 * "prod", "live" or "the site" means production; a design-only wording means the design. Null means it is unclear
 * and the panel asks.
 */
export function inferTarget(message: string): EqualizerTarget | null {
  const text = message.toLowerCase();
  if (/\b(prod|production|live site|the live|deployed)\b/.test(text)) return 'production';
  if (/\b(dev|local|localhost|my app|development)\b/.test(text)) return 'dev';
  if (/\b(just (did|drew|finished)|only the design|design only|check the design|designed)\b/.test(text)) return 'design';
  return null;
}
