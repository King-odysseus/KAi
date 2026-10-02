/**
 * What the two answers to a pending prompt are called, and whether the second one exists at all.
 *
 * A run can reach the person through the approval channel for two different reasons, and they are not the same
 * question. A tool call wants permission to change the project, so it offers allow and deny. A guard watching the
 * run — it has spent past its limit, it is repeating itself, it keeps describing work without doing any — wants to
 * know whether to carry on, and its answers are named actions instead.
 *
 * The rule worth holding in one place: **a question about the run never offers full access.** That button sits
 * beside "Allow once" on a permission prompt, where it means "stop asking me about edits". Put next to a spend
 * limit it reads as consent to keep spending, and it does more than that — it sets the conversation to full access
 * for every later run. The most inviting button on the prompt that exists to stop runaway spending was the one that
 * removed the limit permanently.
 */

export interface ApprovalRunQuestion {
  continueLabel: string;
  finishLabel: string;
}

export interface ApprovalActions {
  /** The purposeful answer: allow this change, or let the run carry on. */
  confirmLabel: string;
  /** The cautious answer: deny this change, or stop and let the run sum up. */
  cancelLabel: string;
  /** Whether to offer full access beside them. Only a permission prompt has anything to offer it for. */
  offersFullAccess: boolean;
}

export function approvalActions(approval: { runQuestion?: ApprovalRunQuestion | null }): ApprovalActions {
  const question = approval.runQuestion;
  if (question) {
    return { confirmLabel: question.continueLabel, cancelLabel: question.finishLabel, offersFullAccess: false };
  }
  return { confirmLabel: 'Allow once', cancelLabel: 'Deny', offersFullAccess: true };
}
