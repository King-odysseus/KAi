import { useRef } from 'react';
import type { ConversationRecord, LeadCycle, RoleTarget } from '@kai/contracts';
import { dispatchLeadTask, type LeadHandoffMode } from './lead-handoff';
import { unwrap } from '../types';

interface HandoffSession {
  projectId: string | null;
  lead: ConversationRecord | null;
  builder: ConversationRecord | null;
  enabled: boolean;
  builderBusy: boolean;
  builderIdentity: string;
  builderTarget?: RoleTarget | null;
  saveLocal(record: ConversationRecord): void;
  openBuilder(id: string): void;
  start(builder: ConversationRecord, task: string): Promise<void>;
}

/** Owns delivery outside the panel, so hiding the panel cannot launch or repeat tasks. */
export function useLeadHandoff(session: HandoffSession) {
  const current = useRef(session);
  current.current = session;
  const dispatching = useRef(new Set<string>());

  async function load(id: string): Promise<ConversationRecord> {
    const record = unwrap(await window.kaiDesktop.getConversation(id));
    if (!record) throw new Error('This conversation no longer exists.');
    return record;
  }

  async function changeMode(mode: LeadHandoffMode): Promise<void> {
    const snapshot = current.current;
    if (!snapshot.lead) throw new Error('Start a Lead chat before choosing its handoff mode.');
    const lead = await load(snapshot.lead.id);
    if (current.current.lead?.id !== lead.id || current.current.projectId !== lead.projectId) throw new Error('The project or Lead chat changed. Choose the mode again.');
    const saved = unwrap(await window.kaiDesktop.saveConversation({ ...lead, leadHandoffMode: mode }));
    current.current.saveLocal(saved);
  }

  async function dispatch(turnId: string, automatic = false, sourceLeadId = current.current.lead?.id, cycle?: LeadCycle): Promise<void> {
    const snapshot = current.current;
    const key = `${sourceLeadId}:${turnId}`;
    if (dispatching.current.has(key)) return;
    dispatching.current.add(key);
    const assertCurrent = (): void => {
      const latest = current.current;
      if (!sourceLeadId || latest.lead?.id !== sourceLeadId || latest.projectId !== snapshot.projectId || latest.builderIdentity !== snapshot.builderIdentity || latest.builder?.id !== snapshot.builder?.id) throw new Error('The project, chat or Builder selection changed. Review the task before sending again.');
      if (!latest.enabled) throw new Error('Builder is off. Enable Lead & Builder to start this task.');
      if (latest.builderBusy) throw new Error('Builder is already running. Wait for it to finish, then approve this task.');
    };
    try {
      assertCurrent();
      await dispatchLeadTask(turnId, automatic, {
        builderTarget: snapshot.builderTarget ?? undefined,
        loadLead: () => load(sourceLeadId!),
        assertCurrent,
        getBuilder: async () => {
          const builder = snapshot.builder;
          if (builder && builder.projectId === snapshot.projectId && builder.origin?.kind !== 'lead' && builder.origin?.kind !== 'crew' && !builder.guidedBuild?.enabled && !builder.sideOf) return load(builder.id);
          return unwrap(await window.kaiDesktop.createConversation(snapshot.projectId, ''));
        },
        save: async (record) => {
          const saved = unwrap(await window.kaiDesktop.saveConversation(record));
          current.current.saveLocal(saved);
          return saved;
        },
        start: async (builder, task) => {
          // Starting a Builder task does not replace or clear any composer draft.
          current.current.openBuilder(builder.id);
          await current.current.start(builder, task);
        },
        id: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      }, cycle);
    } finally { dispatching.current.delete(key); }
  }

  return { changeMode, dispatch };
}
