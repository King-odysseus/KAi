import { useEffect, useRef } from 'react';
import type { ConversationRecord, LeadCycle, LeadDeliverySettings, RoleTarget } from '@kai/contracts';
import { processLeadCompletion } from './lead-completion-workflow';
import { latestBuilderResultHandoff } from './lead-delivery';
import { leadTargetUnavailableReason, type LeadModelInventory } from './lead-model-selection';
import { unwrap } from '../types';

interface CompletionSession {
  projectId: string | null; lead: ConversationRecord | null; runningLead: boolean;
  inventory: LeadModelInventory;
  leadTarget(): RoleTarget | null;
  saveLocal(record: ConversationRecord): void;
  ask(prompt: string, target: RoleTarget, role: 'lead' | 'reviewer', maxCostUsd: number): Promise<ConversationRecord | undefined>;
  dispatch(turnId: string, cycle: LeadCycle): Promise<void>;
  notice(leadId: string, message: string): void;
}

export function useLeadCompletion(session: CompletionSession) {
  const current = useRef(session); current.current = session;
  const busy = useRef(new Set<string>());
  const pending = useRef(new Map<string, { builder: ConversationRecord; succeeded: boolean }>());
  const load = async (id: string): Promise<ConversationRecord> => {
    const record = unwrap(await window.kaiDesktop.getConversation(id));
    if (!record) throw new Error('The saved conversation is no longer available.');
    return record;
  };
  const process = async (builderId: string, handoffId: string, options: { manualTarget?: RoleTarget; succeeded?: boolean } = {}): Promise<void> => {
    const key = `${builderId}:${handoffId}`;
    if (busy.current.has(key)) return;
    busy.current.add(key);
    try {
      await processLeadCompletion(builderId, handoffId, {
        inventory: current.current.inventory,
        load,
        save: async (record) => { const saved = unwrap(await window.kaiDesktop.saveConversation(record)); current.current.saveLocal(saved); return saved; },
        checkpoint: (id, turnId) => window.kaiDesktop.reviewCheckpoint(id, turnId).then(unwrap).catch(() => null),
        read: (projectId, path) => window.kaiDesktop.readProjectFile(projectId, path).then(unwrap),
        assertSession: (lead) => {
          if (current.current.projectId !== lead.projectId || current.current.lead?.id !== lead.id) throw new Error('Builder result recorded. Open its original Lead chat to continue the review.');
          if (current.current.runningLead) throw new Error('Builder result recorded. Wait for the current Lead reply, then review it.');
        },
        leadTarget: () => current.current.leadTarget(),
        unavailable: (target) => leadTargetUnavailableReason(target, current.current.inventory),
        ask: (...args) => current.current.ask(...args),
        dispatch: (...args) => current.current.dispatch(...args),
        notice: (...args) => current.current.notice(...args),
      }, options);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const latest = await load(builderId).catch(() => null);
      if (latest?.leadHandoffs?.some((item) => item.id === handoffId && item.completion)) {
        const saved = unwrap(await window.kaiDesktop.saveConversation({ ...latest, leadHandoffs: latest.leadHandoffs.map((item) => item.id === handoffId && item.completion ? { ...item, completion: { ...item.completion, continuationNote: message } } : item) }));
        current.current.saveLocal(saved);
      }
      throw caught;
    } finally { busy.current.delete(key); }
  };
  const notify = async (builder: ConversationRecord, succeeded: boolean): Promise<void> => {
    builder = await load(builder.id);
    const handoff = latestBuilderResultHandoff(builder) ?? (!succeeded ? [...(builder.leadHandoffs ?? [])].reverse().find((item) => builder.turns.some((turn, index) => index >= item.userTurnCount && turn.role === 'user' && turn.text.trim() === item.task.trim())) : undefined);
    if (!handoff || handoff.completion?.notified) return;
    if (current.current.runningLead && current.current.lead?.id === handoff.leadConversationId) {
      pending.current.set(`${builder.id}:${handoff.id}`, { builder, succeeded });
      return;
    }
    try { await process(builder.id, handoff.id, { succeeded }); }
    catch (caught) { current.current.notice(handoff.leadConversationId, caught instanceof Error ? caught.message : String(caught)); }
  };
  useEffect(() => {
    if (session.runningLead) return;
    for (const [key, item] of pending.current) {
      if (!item.builder.leadHandoffs?.some((handoff) => handoff.leadConversationId === session.lead?.id) || item.builder.projectId !== session.projectId) continue;
      pending.current.delete(key);
      void notify(item.builder, item.succeeded).catch((caught) => current.current.notice(session.lead!.id, String(caught)));
    }
  }, [session.runningLead, session.lead?.id, session.projectId]);
  const saveSettings = async (settings: LeadDeliverySettings): Promise<void> => {
    const id = current.current.lead?.id;
    if (!id) throw new Error('Open a Lead chat first.');
    const lead = await load(id);
    if (current.current.projectId !== lead.projectId || current.current.lead?.id !== id) throw new Error('The Lead project changed.');
    current.current.saveLocal(unwrap(await window.kaiDesktop.saveConversation({ ...lead, leadDeliverySettings: settings })));
  };
  return { notify, review: (builderId: string, handoffId: string, target: RoleTarget) => process(builderId, handoffId, { manualTarget: target }), saveSettings };
}
