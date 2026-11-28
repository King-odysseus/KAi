import { z } from 'zod';

export const leadAccessSchema = z.enum(['read-only', 'ask', 'plan']);
export type LeadAccess = z.infer<typeof leadAccessSchema>;
export const leadEditSuggestionSchema = z.object({
  path: z.string().min(1).max(500),
  before: z.string().max(20_000),
  after: z.string().max(20_000),
  reason: z.string().min(1).max(2000),
}).strict();
export const leadEditProposalSchema = leadEditSuggestionSchema.extend({
  id: z.string(), turnId: z.string(),
  expectedHash: z.string().nullable(),
  original: z.string().max(100_000), replacement: z.string().max(100_000),
  eol: z.enum(['lf', 'crlf']), bom: z.boolean(),
  state: z.enum(['pending', 'applied', 'rejected', 'conflict']),
  automatic: z.boolean(), note: z.string().optional(),
  conflictContent: z.string().max(100_000).optional(),
}).strict();
export type LeadEditProposal = z.infer<typeof leadEditProposalSchema>;
export const leadEditInputSchema = z.object({ conversationId: z.string(), turnId: z.string() }).strict();
export const leadEditDecisionSchema = z.object({ conversationId: z.string(), proposalId: z.string(), action: z.enum(['approve', 'reject', 'automatic', 'refresh']) }).strict();

export function parseLeadEditSuggestion(text: string): z.infer<typeof leadEditSuggestionSchema> | null {
  const matches = [...text.matchAll(/^LEAD EDIT:\s*\n([\s\S]*?)^END LEAD EDIT\s*$/gm)];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Offer one small Lead edit at a time.');
  try { return leadEditSuggestionSchema.parse(JSON.parse(matches[0]![1]!)); }
  catch { throw new Error('The Lead edit proposal is unreadable. Ask for one complete proposal again.'); }
}

export function leadAccessInstructions(access: LeadAccess): string {
  if (access === 'read-only') return 'Lead access is Read-only. Do not propose an executable LEAD EDIT block; prepare a Builder task for changes.';
  return `Lead access: ${access === 'plan' ? 'Plan edits allowed' : 'Ask before edits'}. You still have read tools only. KAI can apply one small correction through a separate, hash-checked edit proposal. Do not say that all editing is impossible. Read the actual file first. For a small agreed correction, return exactly one block:\nLEAD EDIT:\n{"path":"project-relative path","before":"exact unique existing text, with complete relevant lines","after":"replacement text","reason":"why this correction is needed"}\nEND LEAD EDIT\nKAI shows the exact diff and asks before applying. In Plan edits allowed, only marking an existing authoritative plan step complete from a matching recorded Passed task may apply automatically. Scope/goal/decision changes, undoing a done step, verification baselines, code and configuration always require explicit approval. status.md is written by code from facts; do not propose edits to it. Never infer not-installed from an unreachable endpoint. Keep larger implementation in a Builder task. If offering LEAD EDIT, end with BUILDER TASK: followed by None; do not also dispatch the same change to Builder. Do not embed commands or uninspected file contents in a proposal.`;
}
