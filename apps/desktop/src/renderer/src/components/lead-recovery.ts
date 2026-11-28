import type { CheckpointReview, ConversationRecord, LeadCompletion } from '@kai/contracts';
import { handoffResult, leadResultReview, type LeadHandoff } from './lead-delivery';

export const LEAD_RECOVERY_PREFIX = 'Plan a way forward from this blocked task.';
export const LEAD_RECOVERY_RULES = `A blocker limits the affected task or phase; it never prevents discussing ways forward. Treat saved reports as historical claims unless confirmed by current files or recorded checks. Keep failed, missing and stale gates open, preserve completed work, and do not weaken tests, re-pin baselines, install software or approve scope merely to remove a blocker. An unreachable endpoint is not proof that software is not installed.
When blocked, use short sections: Confirmed facts; What is blocked; Ways forward; Recommended next step; What can continue independently. Compare correcting unintended changes with explicitly approving intentional changes when relevant. Explain why, how, risks and a simpler option. Name the exact evidence or diff needed for a decision; ask at most three focused questions. Do not repeat approval warnings without a concrete reviewable proposal.
Recommend the smallest useful action: collect missing current evidence through Builder, prepare a targeted repair, or select an existing independent step from the authoritative plan. Explain its dependencies; do not claim independence without evidence. If dependencies are unclear, ask to approve that task instead of starting it automatically. Do not make the whole project wait for one blocked branch. If every remaining task depends on the blocker, say so and offer a specific decision or diagnostic task. You may read files and search; if a fresh command or Git diff is needed, prepare a read-only Builder diagnostic task instead of reconstructing it as fact from old reports.
Finish with one complete bounded Builder task when there is an actionable next step, otherwise one specific decision and BUILDER TASK: followed by None. Recovery options and scope decisions require the user's choice before work starts. Read-only means no direct model writes, not no planning. All existing edit approvals, handoff permissions, spend limits and phase gates still apply.`;

export function isLeadRecoveryRequest(question: string): boolean {
  return question.startsWith(LEAD_RECOVERY_PREFIX) || /\b(?:blocked|stuck|blocker|unblock)\b|\bways? forward\b/i.test(question);
}
export function markLeadRecoveryReply(record: ConversationRecord): ConversationRecord {
  const last = record.turns.at(-1);
  return last?.role === 'assistant' ? { ...record, leadRecoveryTurnIds: [...new Set([...(record.leadRecoveryTurnIds ?? []), last.id])] } : record;
}
export function leadRecoveryPrompt(builder: ConversationRecord, handoff: LeadHandoff, checkpoint: CheckpointReview | null = null, facts: LeadCompletion | undefined = handoff.completion): string {
  const evidence = handoffResult(builder, handoff) ? leadResultReview(builder, handoff, checkpoint)
    : `No completed Builder reply is available. The run may have stopped or failed; do not assume checks passed.\n${handoff.task.length <= 10_000 ? `## Requested task\n${handoff.task}` : 'Requested task omitted due to size. Read the authoritative project plan and inspect current files before proposing a small diagnostic.'}`;
  return `${LEAD_RECOVERY_PREFIX}\n${LEAD_RECOVERY_RULES}\n\nRecorded task state: ${facts?.state ?? 'review-needed'}. ${facts?.reason ?? 'Acceptance still needs review.'}${facts?.continuationNote ? `\nRecorded pause: ${facts.continuationNote}` : ''}\nDo not accept this task or mark the phase complete in this planning reply. A proposed recovery task needs explicit approval, including when Auto handoff is selected.\n\n${evidence}`;
}
