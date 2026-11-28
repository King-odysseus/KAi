import { useRef } from 'react';
import type { ConversationRecord, LeadAccess } from '@kai/contracts';
import { unwrap } from '../types';

export function useLeadEdits(session: { lead: ConversationRecord | null; projectId: string | null; saveLocal(record: ConversationRecord): void }) {
  const current = useRef(session); current.current = session;
  const assert = (lead: ConversationRecord) => {
    if (current.current.projectId !== lead.projectId || current.current.lead?.id !== lead.id) throw new Error('Open the original Lead chat before reviewing its edit.');
  };
  const remember = (record: ConversationRecord) => { current.current.saveLocal(record); return record; };
  const changeAccess = async (leadAccess: LeadAccess): Promise<void> => {
    const id = current.current.lead?.id;
    if (!id) throw new Error('Open a Lead chat first.');
    const lead = unwrap(await window.kaiDesktop.getConversation(id));
    if (!lead) throw new Error('The Lead chat is unavailable.');
    assert(lead);
    remember(unwrap(await window.kaiDesktop.saveConversation({ ...lead, leadAccess })));
  };
  const decide = async (proposalId: string, action: 'approve' | 'reject' | 'refresh'): Promise<void> => {
    const lead = current.current.lead;
    if (!lead) throw new Error('Open a Lead chat first.');
    assert(lead);
    remember(unwrap(await window.kaiDesktop.decideLeadEdit({ conversationId: lead.id, proposalId, action })));
  };
  const prepare = async (record: ConversationRecord, turnId: string): Promise<ConversationRecord> => {
    assert(record);
    const prepared = remember(unwrap(await window.kaiDesktop.prepareLeadEdit({ conversationId: record.id, turnId })));
    const proposal = prepared.leadEditProposals?.find((item) => item.turnId === turnId);
    if (prepared.leadAccess === 'plan' && proposal?.state === 'pending') {
      assert(prepared);
      return remember(unwrap(await window.kaiDesktop.decideLeadEdit({ conversationId: prepared.id, proposalId: proposal.id, action: 'automatic' })));
    }
    return prepared;
  };
  return { changeAccess, decide, prepare };
}
