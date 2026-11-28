import type { ConversationRecord, LeadCycle, RoleTarget } from '@kai/contracts';
import { leadTaskFromReply } from './lead-model-selection';
import { parseLeadIdeaProposal } from './lead-idea-proposal';
import { taskGoal } from './lead-completion';

export type LeadHandoffMode = 'discuss' | 'ask' | 'auto';
export const leadHandoffMode = (record: ConversationRecord | null): LeadHandoffMode => record?.leadHandoffMode ?? 'ask';

export function leadHandoffInstructions(mode: LeadHandoffMode): string {
  return `\nHandoff setting: ${mode === 'auto' ? 'Auto handoff: KAI may start Builder after a new completed, agreed task.' : mode === 'ask' ? 'Ask first: the user must approve the exact task before KAI starts Builder.' : 'Discuss only: tasks can be manually copied to the Builder draft.'} This never grants you editing or command permissions. Only produce a Builder task for a change the user requested or agreed to; suggestions, unanswered questions and conflicting decisions must stay discussion. Idea proposals require their separate approval in every mode. Builder uses its own model and access settings.`;
}

/** Automatic delivery requires a complete, unambiguous task, never a partial stream or idea approval. */
export function runnableLeadTask(record: ConversationRecord, turnId: string): string | null {
  const turn = record.turns.find((item) => item.id === turnId);
  if (!turn || turn.role !== 'assistant' || turn.awaitingAnswer || /^LEAD EDIT:/m.test(turn.text) || /LEAD_IDEA_PROPOSAL/.test(turn.text) || parseLeadIdeaProposal(turn.text)) return null;
  if ((turn.text.match(/^\s*BUILDER TASK:\s*$/gm) ?? []).length !== 1 || !/^\s*END BUILDER TASK\s*$/m.test(turn.text)) return null;
  const task = leadTaskFromReply(turn.text);
  if (!task || /END BUILDER TASK/.test(task)) return null;
  let fence: string | null = null;
  for (const line of task.split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!delimiter) continue;
    if (!fence) fence = delimiter;
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
  }
  return fence ? null : task;
}

export interface LeadDeliveryPort {
  builderTarget?: RoleTarget;
  loadLead(): Promise<ConversationRecord>;
  assertCurrent(): void;
  getBuilder(): Promise<ConversationRecord>;
  save(record: ConversationRecord): Promise<ConversationRecord>;
  start(builder: ConversationRecord, task: string): Promise<void>;
  id(): string;
  now(): string;
}

/** Called from a completed Lead request or an explicit approval, never from mounting saved history. */
export async function dispatchLeadTask(turnId: string, automatic: boolean, port: LeadDeliveryPort, cycle?: LeadCycle): Promise<void> {
  const lead = await port.loadLead();
  port.assertCurrent();
  if (lead.origin?.kind !== 'lead' || !lead.projectId) throw new Error('Open the originating Lead chat before sending this task.');
  const mode = leadHandoffMode(lead);
  if (mode === 'discuss' || (automatic && mode !== 'auto')) throw new Error('Automatic handoff is off. The task remains in the Lead chat.');
  if (lead.leadDispatchedTurnIds?.includes(turnId)) throw new Error('This task was already sent. Open its linked Builder to review or retry it.');
  if (automatic && lead.turns.at(-1)?.id !== turnId) throw new Error('Only the newly completed Lead reply can be handed off automatically.');
  if (automatic && lead.leadRecoveryTurnIds?.includes(turnId)) throw new Error('Review and approve this recovery task before starting Builder. The blocked task remains open.');
  const task = runnableLeadTask(lead, turnId);
  if (!task) throw new Error('Ask the Lead for one complete Builder task before starting work. Idea proposals still need approval.');
  const builder = await port.getBuilder();
  port.assertCurrent();
  if (builder.projectId !== lead.projectId || builder.origin?.kind === 'lead' || builder.guidedBuild?.enabled || builder.sideOf || builder.origin?.kind === 'crew') throw new Error('Choose a development Builder conversation in this project.');
  if (automatic && builder.leadHandoffs?.some((item) => item.completion?.state === 'passed' && item.leadConversationId === lead.id && taskGoal(item.task) === taskGoal(task))) throw new Error('This task already passed review. Reconcile the existing plan before repeating completed work.');
  // Recheck permission and session after waiting, before recording or starting work.
  const current = await port.loadLead();
  port.assertCurrent();
  if (current.id !== lead.id || current.projectId !== lead.projectId || leadHandoffMode(current) !== mode || current.leadDispatchedTurnIds?.includes(turnId) || automatic && current.leadRecoveryTurnIds?.includes(turnId) || runnableLeadTask(current, turnId) !== task) throw new Error('The Lead chat or task changed. Review it again before starting Builder.');
  const linked = await port.save({ ...builder, leadHandoffs: [...(builder.leadHandoffs ?? []), { id: port.id(), leadConversationId: lead.id, sourceTurnId: turnId, delivery: 'run', task, createdAt: port.now(), userTurnCount: builder.turns.length, ...(cycle ? { cycle } : {}), ...(port.builderTarget ? { builderTarget: port.builderTarget } : {}) }] });
  port.assertCurrent();
  const latest = await port.loadLead();
  port.assertCurrent();
  if (latest.id !== current.id || latest.leadDispatchedTurnIds?.includes(turnId) || leadHandoffMode(latest) !== mode || latest.turns.at(-1)?.id !== current.turns.at(-1)?.id || runnableLeadTask(latest, turnId) !== task) throw new Error('The Lead chat changed before Builder started. Review the task again.');
  await port.save({ ...latest, leadDispatchedTurnIds: [...(latest.leadDispatchedTurnIds ?? []), turnId] });
  port.assertCurrent();
  await port.start(linked, task);
}
