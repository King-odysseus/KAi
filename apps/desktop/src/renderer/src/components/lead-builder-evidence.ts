import type { ConversationRecord } from '@kai/contracts';
import { redactText } from '../../../../../../packages/runtime/src/redaction';
import { handoffResult } from './lead-delivery';

export interface LeadBuilderEvidence { name: string; text: string }

/** Fetch actual linked runs, including after restart when the list contains summaries only. Never save them here. */
export async function loadLeadBuilderEvidence(records: readonly ConversationRecord[], leadId: string, projectId: string, load: (id: string) => Promise<ConversationRecord | null>): Promise<{ sections: LeadBuilderEvidence[]; records: ConversationRecord[]; notes: string[] }> {
  const linked = records.filter((record) => record.projectId === projectId && record.leadHandoffs?.some((item) => item.leadConversationId === leadId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const loaded = await Promise.allSettled(linked.map((record) => load(record.id)));
  const full: ConversationRecord[] = [], notes: string[] = [];
  loaded.forEach((result, index) => {
    const record = result.status === 'fulfilled' ? result.value : null;
    if (!record || '__summary' in record || record.id !== linked[index]!.id || record.projectId !== projectId || !record.leadHandoffs?.some((item) => item.leadConversationId === leadId)) {
      notes.push(`Linked Builder ${linked[index]!.id} could not be loaded completely. Its output is unavailable; do not reconstruct it from old reports.`);
    } else full.push(record);
  });
  const tasks = full.flatMap((record) => (record.leadHandoffs ?? []).filter((item) => item.leadConversationId === leadId).map((handoff) => ({ record, handoff })))
    .sort((a, b) => b.handoff.createdAt.localeCompare(a.handoff.createdAt)).slice(0, 3);
  const sections: LeadBuilderEvidence[] = [];
  for (const { record, handoff } of tasks) {
    const prefix = `Builder ${record.id} / task ${handoff.id}`;
    const result = handoffResult(record, handoff);
    sections.push({ name: `${prefix} — recorded state`, text: `Linked task: ${handoff.task}\nRecorded state: ${handoff.completion?.state ?? 'awaiting review'}. ${handoff.completion?.reason ?? ''}\n${result ? `Builder reply recorded at ${result.answer.createdAt}. Actual reply and command outputs are attached in the following sections when they fit.` : 'No completed Builder reply is recorded yet. Do not treat the task as complete.'}` });
    if (!result) continue;
    for (const command of result.commands) sections.push({ name: `${prefix} — command ${command.id}`, text: `Recorded at: ${command.timestamp}\nCommand:\n${command.command}\nExit code: ${command.exitCode ?? 'unknown'}\nOutput:\n${command.output}` });
    sections.push({ name: `${prefix} — actual reply`, text: result.answer.text });
  }
  if (linked.length === 3) notes.push('Only the three most recently updated linked Builder conversations were inspected for this request.');
  return { sections: sections.map((section) => ({ ...section, text: redactText(section.text) })), records: full, notes };
}

export function packLeadBuilderEvidence(sections: readonly LeadBuilderEvidence[], budget: number): { text: string; included: string[]; omitted: string[] } {
  if (!sections.length) return { text: '', included: [], omitted: [] };
  const header = 'Actual linked Builder evidence (recorded output, not a fresh command run). Use the attached reply and output directly; do not search old reports to reconstruct them. Current files may have changed since these timestamps. Request a focused fresh command only if needed.\n';
  const included: string[] = [], omitted: string[] = [];
  let text = header;
  for (const section of sections) {
    const part = `\n## ${section.name}\n${section.text}\n`;
    if (text.length + part.length + 180 <= budget) { text += part; included.push(section.name); }
    else omitted.push(section.name);
  }
  if (!included.length && header.length + 180 > budget) return { text: '', included, omitted };
  if (omitted.length) text += `\n${omitted.length} whole Builder evidence sections omitted due to size; omitted names are listed in the request context. Do not invent their contents.\n`;
  return { text, included, omitted };
}
