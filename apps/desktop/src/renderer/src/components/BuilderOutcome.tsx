import type { ConversationRecord } from '@kai/contracts';
import { latestBuilderResultHandoff } from './lead-delivery';
import { UiButton } from './UiButton';

export function BuilderOutcome({ conversation, onOpenLead }: { conversation: ConversationRecord | null; onOpenLead?: (leadId: string) => void }) {
  const handoff = conversation ? latestBuilderResultHandoff(conversation) : null;
  const completion = handoff?.completion;
  if (!handoff) return null;
  if (!completion) return <div className="workspace-outcome" role="status"><strong>Builder result ready for Lead</strong><span>The result is saved; review its evidence and choose the next step.</span>{onOpenLead && <UiButton type="button" className="secondary-button" onClick={() => onOpenLead(handoff.leadConversationId)}>Review result with Lead</UiButton>}</div>;
  const labels = { 'passed': 'Passed', 'needs-repair': 'Needs repair', 'not-checked': 'Not checked', 'needs-you': 'Needs you', 'review-needed': 'Review needed' };
  return <div className="workspace-outcome" role="status"><strong>Recorded task outcome: {labels[completion.state]}</strong><span>{completion.reason}</span>{completion.continuationNote && <small>{completion.continuationNote}</small>}{onOpenLead && <UiButton type="button" className="secondary-button" onClick={() => onOpenLead(handoff.leadConversationId)}>Review result with Lead</UiButton>}<small>Finishing a Builder reply does not complete a phase. Its required gates must pass.</small></div>;
}
