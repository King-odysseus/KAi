import { ClipboardCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AutonomyMode } from '@kai/contracts';
import { usePlanProgress } from './PlanStrip';
import { UiButton } from './UiButton';

/** The access levels an approved plan can be built under. Full access is never one-click: it is a bigger decision. */
export type PlanApprovalLevel = Extract<AutonomyMode, 'ask' | 'autoEdit'>;

/** The prompt sent when a plan is approved, so the agent knows the hold is over and which plan it is building. */
export const PLAN_APPROVED_PROMPT = 'The plan is approved. Implement it now, step by step, keeping the plan up to date as steps finish, and run the relevant checks when you are done.';

/**
 * Plan mode only reads, so the end of a plan run is a decision: build this, or keep talking. This is that decision,
 * made once and in the open, instead of the person finding the access picker and retyping "go ahead". It appears
 * only while access is "Plan" and a run has just finished, and building is always at a level that still asks or
 * shows its edits; Full access stays a deliberate choice in the picker.
 */
export function PlanApprovalBar({
  projectId,
  conversationId,
  refreshKey,
  onApprove,
  onDismiss,
}: {
  projectId: string | null;
  conversationId: string | null;
  refreshKey?: string;
  onApprove: (level: PlanApprovalLevel) => void;
  onDismiss: () => void;
}): ReactNode {
  const progress = usePlanProgress(projectId, conversationId, refreshKey);
  const steps = progress ? `${progress.total} ${progress.total === 1 ? 'step' : 'steps'}` : 'the plan above';
  return (
    <section className="plan-approval" aria-label="Plan ready for approval">
      <ClipboardCheck size={14} />
      <span className="plan-approval-text"><strong>Plan ready.</strong> Nothing has been changed yet. Build {steps}?</span>
      <span className="plan-approval-actions">
        <UiButton type="button" className="primary-button" onClick={() => onApprove('autoEdit')} title="Switch to Edit files and build the plan">Approve and build</UiButton>
        <UiButton type="button" className="secondary-button" onClick={() => onApprove('ask')} title="Switch to Ask first and build the plan, asking before each change">Build, ask first</UiButton>
        <UiButton type="button" className="secondary-button" aria-label="Keep planning" title="Keep planning" onClick={onDismiss}><X size={13} /></UiButton>
      </span>
    </section>
  );
}
