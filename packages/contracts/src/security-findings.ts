import { z } from 'zod';

/**
 * The Security Auditor's log: local-only findings from static review or a dynamic pass against the person's own
 * dev server. Never a target other than localhost/the local loopback — that boundary is enforced by the auditor's
 * own prompt, but the log schema also has no field that could carry a remote host, by design.
 */
export const securityFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const securityFindingStatusSchema = z.enum(['open', 'assigned', 'fixed', 'wont-fix']);

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
    status: securityFindingStatusSchema.default('open'),
    /** The cognitive1 task id this finding was filed as, once an agent has been assigned to fix it. */
    taskId: z.string().min(1).max(200).optional(),
    /**
     * A stable identity for the issue, derived from its class, location and title. Two scans that find the same
     * thing update one record instead of appending a duplicate, and a fix can be re-tested against it.
     */
    fingerprint: z.string().min(1).max(200).optional(),
    /** When a scan last saw this issue. `createdAt` stays the first sighting. */
    lastSeenAt: z.string().min(1).optional(),
    /** When a verify pass last re-tested this finding, whatever the result. */
    lastVerifiedAt: z.string().min(1).optional(),
  })
  .strict();

export const securityFindingsLogSchema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z.array(securityFindingSchema).max(2_000),
    updatedAt: z.string().min(1),
  })
  .strict();

/**
 * A finding as a caller supplies it. `status` is deliberately optional here rather than defaulted: the store needs
 * to tell "a scan found this again" apart from "a verify pass says it is fixed", and the base record's default
 * would turn both into `open` before the store ever sees them.
 */
export const securityFindingSaveInputSchema = securityFindingSchema
  .omit({ createdAt: true })
  .partial({ id: true })
  .extend({ status: securityFindingStatusSchema.optional() });
export const securityFindingStatusUpdateInputSchema = z
  .object({ id: z.string().min(1), status: securityFindingStatusSchema, taskId: z.string().min(1).max(200).optional() })
  .strict();

/**
 * The identity a finding keeps across scans: its class, a file or route with any line suffix removed, and a
 * whitespace-normalized title. A line moving down a file is the same issue, so the line number is not part of it.
 * Hashed rather than joined, because a location and a title together run past the field's length.
 */
export function securityFindingFingerprint(
  input: Pick<SecurityFinding, 'vulnClass' | 'location' | 'title'>,
): string {
  const key = [
    input.vulnClass.trim().toLowerCase(),
    input.location.trim().toLowerCase().replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, ''),
    input.title.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');
  return `${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x9e3779b9)}`;
}

/** 32-bit FNV-1a, in hex. Two seeds give a 64-bit-ish key without pulling `node:crypto` into shared code. */
function fnv1a(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type SecurityFindingSeverity = z.infer<typeof securityFindingSeveritySchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;
export type SecurityFindingsLog = z.infer<typeof securityFindingsLogSchema>;
export type SecurityFindingSaveInput = z.infer<typeof securityFindingSaveInputSchema>;
export type SecurityFindingStatusUpdateInput = z.infer<typeof securityFindingStatusUpdateInputSchema>;
