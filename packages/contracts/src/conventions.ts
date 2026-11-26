import { z } from 'zod';
import { timestampSchema } from './primitives';

/**
 * Conventions: how this developer builds things, learned from their own projects and served to every agent run.
 * A habit is something two or more projects share; a style fact comes from a project the developer marked as the way
 * they want things to look; a rule is something they wrote themselves. All three are shown to agents the same way.
 */

export const conventionSourceSchema = z.enum(['habit', 'style', 'rule']);
export type ConventionSource = z.infer<typeof conventionSourceSchema>;

export const conventionItemSchema = z
  .object({
    key: z.string().min(1).max(160),
    source: conventionSourceSchema,
    // What an agent is told, as one line.
    text: z.string().min(1).max(400),
    // What it rests on, for the person to judge: "5 of 8 projects", "11 of 12 card rules".
    evidence: z.string().max(300),
    projects: z.array(z.string().max(200)).max(200),
    // True once the person has turned it off; it is shown but never served.
    muted: z.boolean(),
    // Found since the person last looked.
    isNew: z.boolean(),
  })
  .strict();
export type ConventionItem = z.infer<typeof conventionItemSchema>;

export const conventionProjectSchema = z
  .object({ name: z.string().min(1).max(200), path: z.string().min(1).max(1_000), reference: z.boolean() })
  .strict();

export const conventionRuleSchema = z.object({ id: z.string().min(1).max(60), text: z.string().trim().min(1).max(300) }).strict();
export type ConventionRule = z.infer<typeof conventionRuleSchema>;

export const designProfileSummarySchema = z.object({
  projectId: z.string().min(1).max(200),
  projectName: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(1_000),
  status: z.enum(['missing', 'draft', 'approved', 'user-owned']),
  componentCount: z.number().int().min(0).max(4),
  score: z.number().min(0),
  updatedAt: timestampSchema.nullable(),
  agentsPasteLine: z.string().max(300).nullable(),
}).strict();
export type DesignProfileSummary = z.infer<typeof designProfileSummarySchema>;

export const designProfilesGetInputSchema = z.object({ refresh: z.boolean().optional().default(false) }).strict();
export const designProfileApproveInputSchema = z.object({ projectPath: z.string().min(1).max(1_000) }).strict();

export const conventionsStateSchema = z
  .object({
    // Null until the first scan has finished.
    scannedAt: timestampSchema.nullable(),
    scanning: z.boolean(),
    total: z.number().int().min(0),
    items: z.array(conventionItemSchema).max(300),
    rules: z.array(conventionRuleSchema).max(60),
    projects: z.array(conventionProjectSchema).max(300),
    // Whether C1 holds them: how many served conventions are filed there.
    filedInC1: z.number().int().min(0),
  })
  .strict();
export type ConventionsState = z.infer<typeof conventionsStateSchema>;

export const conventionsGetInputSchema = z.object({ refresh: z.boolean().default(false) }).strict();
export const conventionsReferenceInputSchema = z.object({ path: z.string().min(1).max(1_000), reference: z.boolean() }).strict();
export const conventionsRuleAddInputSchema = z.object({ text: z.string().trim().min(1).max(300) }).strict();
export const conventionsRuleRemoveInputSchema = z.object({ id: z.string().min(1).max(60) }).strict();
export const conventionsMuteInputSchema = z.object({ key: z.string().min(1).max(160), muted: z.boolean() }).strict();
