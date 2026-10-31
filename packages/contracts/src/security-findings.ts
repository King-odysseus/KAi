import { z } from 'zod';

/**
 * The Security Auditor's log: local-only findings from static review or a dynamic pass against the person's own
 * dev server. Never a target other than localhost/the local loopback — that boundary is enforced by the auditor's
 * own prompt, but the log schema also has no field that could carry a remote host, by design.
 */
export const securityFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

export const securityFindingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
    createdAt: z.string().min(1),
    severity: securityFindingSeveritySchema,
    /** e.g. "sql-injection", "insecure-deserialization", "secrets-in-code" — used to group concept cards on Learn. */
    vulnClass: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    /** Where it was found: a file path for static findings, or a local route/port for a dynamic one. */
    location: z.string().trim().min(1).max(500),
    /** How the auditor triggered or spotted it, in enough detail to reproduce locally. */
    evidence: z.string().min(1).max(4_000),
    /** Why it's exploitable and what the fix pattern is — this is what feeds the Learn concept card. */
    conceptCard: z.string().min(1).max(4_000),
    status: z.enum(['open', 'assigned', 'fixed', 'wont-fix']).default('open'),
    /** The cognitive1 task id this finding was filed as, once an agent has been assigned to fix it. */
    taskId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const securityFindingsLogSchema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z.array(securityFindingSchema).max(2_000),
    updatedAt: z.string().min(1),
  })
  .strict();

export const securityFindingSaveInputSchema = securityFindingSchema.omit({ createdAt: true }).partial({ id: true });
export const securityFindingStatusUpdateInputSchema = z
  .object({ id: z.string().min(1), status: z.enum(['open', 'assigned', 'fixed', 'wont-fix']), taskId: z.string().min(1).max(200).optional() })
  .strict();

export type SecurityFindingSeverity = z.infer<typeof securityFindingSeveritySchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;
export type SecurityFindingsLog = z.infer<typeof securityFindingsLogSchema>;
export type SecurityFindingSaveInput = z.infer<typeof securityFindingSaveInputSchema>;
export type SecurityFindingStatusUpdateInput = z.infer<typeof securityFindingStatusUpdateInputSchema>;
