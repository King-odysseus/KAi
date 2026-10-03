import { z } from 'zod';

export const executionRuleSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    section: z.string(),
    title: z.string().min(1),
    body: z.string(),
  })
  .strict();

export const executionRuleDocumentSchema = z
  .object({
    path: z.string().min(1),
    markdown: z.string().min(1),
    rules: z.array(executionRuleSchema),
    sessionWorkflow: z.string(),
  })
  .strict();

export const executionRuleSaveInputSchema = z
  .object({
    id: z.string().max(100),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict();

/**
 * What pushing the standing rules into a project folder did.
 *
 * The rules normally reach an agent inside the run's briefing. This is the belt-and-braces copy that sits on disk, so
 * a project still carries them when that path is not the one being used — a fresh clone, an agent KAI did not start,
 * or a run whose briefing failed. `unchanged` is the common result once a project has been written once, and it is
 * reported rather than hidden: "nothing to do" and "wrote it" are the two things a person pressing this wants told
 * apart.
 */
export const executionRuleInjectionSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    file: z.string(),
    status: z.enum(['written', 'unchanged', 'failed']),
    message: z.string(),
  })
  .strict();

export const executionRuleInjectionReportSchema = z
  .object({
    results: z.array(executionRuleInjectionSchema),
  })
  .strict();

export type ExecutionRuleInjection = z.infer<typeof executionRuleInjectionSchema>;
export type ExecutionRuleInjectionReport = z.infer<typeof executionRuleInjectionReportSchema>;
export type ExecutionRule = z.infer<typeof executionRuleSchema>;
export type ExecutionRuleDocument = z.infer<typeof executionRuleDocumentSchema>;
export type ExecutionRuleSaveInput = z.infer<typeof executionRuleSaveInputSchema>;
