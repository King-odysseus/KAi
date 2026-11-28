import { inventory } from './lead-model-inventory';
import { useState } from 'react';
import { conversationRecordV1Schema, type ConversationRecord } from '@kai/contracts';
import { LeadConversationPanel } from '../../apps/desktop/src/renderer/src/components/RightPane';
import { useLeadHandoff } from '../../apps/desktop/src/renderer/src/components/use-lead-handoff';
import { leadHandoffMode } from '../../apps/desktop/src/renderer/src/components/lead-handoff';
import { useLeadEdits } from '../../apps/desktop/src/renderer/src/components/use-lead-edits';
import { useLeadCompletion } from '../../apps/desktop/src/renderer/src/components/use-lead-completion';
import { TooltipLayer } from '../../apps/desktop/src/renderer/src/components/TooltipLayer';
import { isLeadRecoveryRequest, markLeadRecoveryReply } from '../../apps/desktop/src/renderer/src/components/lead-recovery';

const task = '### Goal\nAdd input validation.\n### Files\n- src/form.ts\n### Done checks\n- Invalid input displays an error.\n### Check command\nnpm test';
function initial(id: string): ConversationRecord {
  return { schemaVersion: 1, id, projectId: 'project-a', title: id === 'lead-a' ? 'Lead' : 'Builder', createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: id === 'lead-a' ? 'plan' : 'ask', ...(id === 'lead-a' ? { origin: { kind: 'lead', projectId: 'project-a' }, turns: [{ id: 'reply-1', role: 'assistant', text: `## Recommendation\nKeep the change small.\nBUILDER TASK:\n${task}\nEND BUILDER TASK`, createdAt: '2026-11-27T00:00:00.000Z' }] } : { turns: [] }), events: [] };
}
function load(id: string): ConversationRecord {
  return conversationRecordV1Schema.parse(JSON.parse(localStorage.getItem(`handoff.${id}`) ?? JSON.stringify(initial(id))));
}
function persist(record: ConversationRecord): ConversationRecord {
  const saved = conversationRecordV1Schema.parse(record);
  localStorage.setItem(`handoff.${saved.id}`, JSON.stringify(saved));
  return saved;
}

export function LeadHandoffHarness() {
  const [lead, setLead] = useState(() => load('lead-a'));
  const [builder, setBuilder] = useState(() => load('builder-a'));
  const [enabled, setEnabled] = useState(true);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('My unsent Builder draft');
  const [runs, setRuns] = useState(() => Number(localStorage.getItem('handoff.runs') ?? 0));
  const [leadBusy, setLeadBusy] = useState(false);
  const [reviewCalls, setReviewCalls] = useState(0);
  Object.assign(window, { kaiDesktop: {
    getConversation: async (id: string) => ({ ok: true, data: load(id) }),
    saveConversation: async (record: ConversationRecord) => ({ ok: true, data: persist(record) }),
    createConversation: async () => ({ ok: true, data: initial('builder-a') }),
    reviewCheckpoint: async () => ({ ok: true, data: null }),
    readProjectFile: async () => ({ ok: true, data: { hash: 'hash-a', content: 'current' } }),
    decideLeadEdit: async ({ proposalId, action }: { proposalId: string; action: string }) => ({ ok: true, data: persist({ ...load('lead-a'), leadEditProposals: load('lead-a').leadEditProposals?.map((item) => item.id === proposalId ? { ...item, state: action === 'approve' ? 'applied' : 'rejected' } : item) }) }),
  } });
  const completion = useLeadCompletion({ projectId: 'project-a', lead, runningLead: leadBusy, inventory,
    leadTarget: () => ({ execution: 'api', api: { provider: 'lmstudio', model: 'local-small', credentialId: 'provider.lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' } }),
    saveLocal: (record) => { if (record.id === lead.id) setLead(record); else setBuilder(record); },
    ask: async () => { setReviewCalls((value) => value + 1); return persist({ ...load(lead.id), turns: [...load(lead.id).turns, { id: crypto.randomUUID(), role: 'assistant', text: 'Missing checks remain open. Choose a concrete recovery action.', createdAt: lead.createdAt }] }); },
    dispatch: async () => { throw new Error('Unverified results must not dispatch.'); }, notice: (_id, message) => setError(message),
  });
  const edits = useLeadEdits({ lead, projectId: 'project-a', saveLocal: setLead });
  const askLead = (question: string) => {
    const current = load(lead.id);
    const recovering = isLeadRecoveryRequest(question);
    const recoveryTask = '### Goal\nCollect fresh check evidence.\n### Files\n- src/form.ts (read only)\n### Steps\n1. Run the existing project check and record its actual output. Do not edit files.\n### Done checks\n- Current check output is recorded.\n### Check command\nnpm test';
    const text = recovering ? `## Ways forward\nKeep the failed gate open. Collect fresh evidence first; continue existing independent work only after checking dependencies.\nBUILDER TASK:\n${recoveryTask}\nEND BUILDER TASK` : 'Hello. We can still discuss the project.';
    const next: ConversationRecord = { ...current, turns: [...current.turns, { id: `ask-${current.turns.length}`, role: 'user', text: question, createdAt: current.createdAt }, { id: `answer-${current.turns.length}`, role: 'assistant', text, createdAt: current.createdAt }] };
    setLead(persist(recovering ? markLeadRecoveryReply(next) : next));
  };
  const delivery = useLeadHandoff({ projectId: 'project-a', lead, builder, enabled, builderBusy, builderIdentity: 'local-model:ask',
    saveLocal: (record) => { if (record.id === lead.id) setLead(record); else setBuilder(record); },
    openBuilder: () => undefined,
    start: async (record, sentTask) => {
      if (record.origin?.kind === 'lead' || record.autonomy !== 'ask') throw new Error('Wrong role or changed access');
      localStorage.setItem('handoff.sentTask', sentTask);
      const count = Number(localStorage.getItem('handoff.runs') ?? 0) + 1;
      localStorage.setItem('handoff.runs', String(count)); setRuns(count);
    },
  });
  return <div>
    <button onClick={() => setLeadBusy(!leadBusy)}>Toggle Lead busy</button>
    <output aria-label="Completion review count">{reviewCalls}</output>
    <button onClick={() => {
      const next = persist({ ...load('builder-a'), turns: [{ id: 'request-a', role: 'user', text: task, createdAt: lead.createdAt }, { id: 'answer-a', role: 'assistant', text: 'Builder finished.', createdAt: lead.createdAt }], leadHandoffs: [{ id: 'result-a', leadConversationId: lead.id, task, createdAt: lead.createdAt, userTurnCount: 0 }, { id: 'unsent', leadConversationId: lead.id, task: 'Unsent draft', createdAt: lead.createdAt, userTurnCount: 2 }] });
      setBuilder(next); void completion.notify(builder, true);
    }}>Finish Builder during Lead reply</button>
    <button onClick={() => void completion.notify(builder, true)}>Repeat completion notification</button>
    <TooltipLayer />
    <button onClick={() => {
      const next = persist({ ...load('builder-a'), turns: [{ id: 'request-a', role: 'user', text: task, createdAt: lead.createdAt }, { id: 'answer-a', role: 'assistant', text: 'Builder finished.', createdAt: lead.createdAt }], leadHandoffs: [{ id: 'paused-a', leadConversationId: lead.id, task, createdAt: lead.createdAt, userTurnCount: 0, completion: { resultTurnId: 'answer-a', state: 'review-needed', reason: 'Checks recorded; acceptance still needs review.', recordedAt: lead.createdAt, checks: [], missingChecks: [], criteria: [], files: [], continuationNote: 'Paid usage could not be measured. Choose manual review before another paid request.' } }] }); setBuilder(next);
    }}>Show price pause</button>
    <button onClick={() => {
      const current = load('lead-a');
      const next = persist({ ...current, turns: [...current.turns, { id: 'edit-reply', role: 'assistant', text: 'A small correction.\nLEAD EDIT:\n{}\nEND LEAD EDIT\nBUILDER TASK:\nNone', createdAt: current.createdAt }], leadEditProposals: [{ id: 'edit-a', turnId: 'edit-reply', path: 'src/form.ts', before: 'return true;', after: 'return false;', reason: 'Correct the existing return value.', original: 'return true;\n', replacement: 'return false;\n', expectedHash: 'original-hash', eol: 'lf', bom: false, state: 'pending', automatic: false }] }); setLead(next);
    }}>Show edit proposal</button>
    <button onClick={() => setEnabled(!enabled)}>Toggle Builder</button>
    <button onClick={() => setBuilderBusy(!builderBusy)}>Toggle Builder busy</button>
    <button onClick={() => {
      const current = load(lead.id);
      const reply = { ...current.turns[0]!, id: `reply-${current.turns.length + 1}` };
      const next = persist({ ...current, turns: [...current.turns, reply] }); setLead(next);
      if (leadHandoffMode(next) === 'auto') void delivery.dispatch(reply.id, true).catch((caught) => setError(String(caught.message)));
    }}>Complete new Lead reply</button>
    <output aria-label="Builder run count">{runs}</output>
    <textarea aria-label="Existing Builder draft" value={draft} readOnly />
    <div style={{ height: '80vh', width: '100%' }}>
      <LeadConversationPanel projectName="Example project" projectId="project-a" conversation={lead} builderEnabled={enabled} builderConversations={[builder]} streamingText="" running={false} error={error} approvals={[]} inventory={inventory} savedCoach={null} onAsk={askLead} onReviewBuilder={async (_id, _handoff, target) => { localStorage.setItem('handoff.manualReviews', String(Number(localStorage.getItem('handoff.manualReviews') ?? 0) + 1)); localStorage.setItem('handoff.reviewTarget', JSON.stringify(target)); }} onStop={() => undefined} onClearError={() => setError(null)} onRespondApproval={() => undefined} onSendToBuilder={setDraft} onReviewIdea={() => undefined} onSaveReviewSettings={async (settings) => { const next = persist({ ...load(lead.id), leadDeliverySettings: settings }); setLead(next); }} onChangeHandoffMode={delivery.changeMode} onChangeAccess={edits.changeAccess} onDecideEdit={edits.decide} onStartBuilder={(id) => delivery.dispatch(id)} />
    </div>
  </div>;
}
