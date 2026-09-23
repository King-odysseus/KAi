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

export type ExecutionRule = z.infer<typeof executionRuleSchema>;
export type ExecutionRuleDocument = z.infer<typeof executionRuleDocumentSchema>;
export type ExecutionRuleSaveInput = z.infer<typeof executionRuleSaveInputSchema>;
