import type { CheckpointReview, ConversationRecord, LeadCompletion, LeadCycle, RoleTarget } from '@kai/contracts';
import { applyCompletionVerdict, completionFacts, completionPrompt, continuationBlock, deliverySettings, nextCycle } from './lead-completion';
import { handoffResult, type LeadHandoff } from './lead-delivery';
import { leadHandoffMode, runnableLeadTask } from './lead-handoff';
import { leadModelTier, stableLeadTargetIdentity, type LeadModelInventory } from './lead-model-selection';
import { leadPricePause, isLeadPricePause } from './lead-review-pause';
import { leadRecoveryPrompt, markLeadRecoveryReply } from './lead-recovery';

export interface CompletionPort {
  inventory?: LeadModelInventory;
  load(id: string): Promise<ConversationRecord>;
  save(record: ConversationRecord): Promise<ConversationRecord>;
  checkpoint(builderId: string, turnId: string): Promise<CheckpointReview | null>;
  read(projectId: string, path: string): Promise<{ hash: string; content: string }>;
  assertSession(lead: ConversationRecord): void;
  leadTarget(lead: ConversationRecord): RoleTarget | null;
  unavailable(target: RoleTarget): string | null;
  ask(prompt: string, target: RoleTarget, role: 'lead' | 'reviewer', maxCostUsd: number): Promise<ConversationRecord | undefined>;
  dispatch(turnId: string, cycle: LeadCycle): Promise<void>;
  notice(leadId: string, message: string): void;
}

function recordedSpend(record: ConversationRecord, previous: Set<string>, target: RoleTarget, inventory?: LeadModelInventory): { amount: number; known: boolean } {
  const events = record.events.filter((event) => !previous.has(event.id) && event.type === 'cost.update');
  const costs = events.flatMap((event) => event.type === 'cost.update' && event.amountUsd !== undefined ? [event.amountUsd] : []);
  return { amount: costs.reduce((sum, amount) => sum + amount, 0), known: leadModelTier(target, inventory) !== 'Paid API' || costs.length > 0 };
}

/** A deterministic completion workflow; the models review and propose, code controls acceptance and continuation. */
export async function processLeadCompletion(builderId: string, handoffId: string, port: CompletionPort, options: { manualTarget?: RoleTarget; succeeded?: boolean } = {}): Promise<void> {
  let builder = await port.load(builderId);
  const handoff = builder.leadHandoffs?.find((item) => item.id === handoffId);
  if (!handoff || (handoff.completion?.notified && !options.manualTarget)) return;
  let lead = await port.load(handoff.leadConversationId);
  const result = handoffResult(builder, handoff);
  if (!lead.projectId || builder.projectId !== lead.projectId || lead.origin?.kind !== 'lead') throw new Error('The Builder result does not belong to this Lead project.');
  let checkpoint = result ? await port.checkpoint(builderId, result.request.id) : null;
  const files: LeadCompletion['files'] = [];
  let stale = false;
  const snapshot = result?.request.fileSnapshot;
  const snapshotContent: Array<{ path: string; before: string; after: string; added: number; removed: number; binary: boolean }> = [];
  if (snapshot) for (const file of snapshot) {
    try {
      const current = await port.read(lead.projectId, file.path);
      if (file.hash === null || current.hash !== file.hash) stale = true;
      files.push({ path: file.path, hash: current.hash });
      snapshotContent.push({ path: file.path, before: 'Before snapshot unavailable; review current code and recorded checks.', after: current.content, added: 0, removed: 0, binary: false });
    } catch { stale = true; }
  }
  if ((!checkpoint || !checkpoint.gitAvailable) && snapshotContent.length) checkpoint = { conversationId: builder.id, turnId: result!.request.id, gitAvailable: false, files: snapshotContent };
  for (const file of checkpoint?.files ?? []) {
    if (snapshot && !snapshot.some((item) => item.path === file.path)) stale = true;
    try {
      const current = await port.read(lead.projectId, file.path);
      if (!files.some((item) => item.path === file.path)) files.push({ path: file.path, hash: current.hash });
      const frozenMatches = snapshot?.some((item) => item.path === file.path && item.hash === current.hash);
      if (!file.binary && frozenMatches) {
        // Checkpoint previews have a size cap; a matching frozen hash proves the full current text is unchanged.
        file.after = current.content;
        if (file.before.length >= 200_000) file.before = 'Before evidence reached the checkpoint preview limit; compare with repository history.';
      } else if (!file.binary && current.content.replace(/\r\n/g, '\n') !== file.after.replace(/\r\n/g, '\n')) stale = true;
    } catch { if (file.after) stale = true; }
  }
  let facts: LeadCompletion = result ? completionFacts(builder, handoff, checkpoint, files, stale) : { resultTurnId: `incomplete:${handoff.id}`, state: 'needs-you', reason: 'Builder stopped or failed before a completed reply. Review its conversation before continuing.', recordedAt: new Date().toISOString(), checks: [], missingChecks: [], criteria: [], files };
  if (result && !snapshot) facts = { ...facts, state: facts.state === 'needs-repair' ? facts.state : 'not-checked', reason: 'This older task has no frozen file evidence. Inspect the current files and run fresh checks before acceptance.' };
  if (options.succeeded === false) facts = { ...facts, state: 'needs-you', reason: 'Builder stopped or failed. Nothing will continue automatically.' };
  facts.notified = true;
  const storeFacts = async (): Promise<void> => {
    builder = await port.load(builderId);
    const latestHandoff = builder.leadHandoffs?.find((item) => item.id === handoff.id);
    if (!latestHandoff || (result && handoffResult(builder, latestHandoff)?.answer.id !== result.answer.id)) throw new Error('The Builder result changed. Review the updated task.');
    builder = await port.save({ ...builder, leadHandoffs: builder.leadHandoffs?.map((item) => item.id === handoff.id ? { ...item, completion: facts } : item) });
  };
  await storeFacts();
  const recordNotice = async (message: string): Promise<void> => {
    facts = { ...facts, continuationNote: message };
    await storeFacts();
  };
  if (!result || options.succeeded === false) return;
  port.assertSession(lead);
  const config = deliverySettings(lead);
  const leadTarget = port.leadTarget(lead);
  const firstTarget = options.manualTarget ?? leadTarget;
  if (!firstTarget) { await recordNotice('Builder result is ready. Choose a Lead model to review it.'); return; }
  let spent = 0;
  let costKnown = true;
  // The Builder's own recorded usage belongs to this cycle too.
  const builderCost = builder.events.filter((event) => event.timestamp >= handoff.createdAt && event.timestamp <= result.answer.createdAt && event.type === 'cost.update');
  let unpricedSource = handoff.builderTarget?.execution === 'api' ? handoff.builderTarget.api?.model ?? 'the preceding Builder run' : builderCost.flatMap((event) => event.type === 'cost.update' && event.model ? [event.model] : [])[0] ?? 'the preceding Builder run';
  spent += builderCost.reduce((sum, event) => sum + (event.type === 'cost.update' ? event.amountUsd ?? 0 : 0), 0);
  if ((builder.route === 'proxy' || (handoff.builderTarget ? leadModelTier(handoff.builderTarget, port.inventory) === 'Paid API' : builder.execution === 'api')) && !builderCost.some((event) => event.type === 'cost.update' && event.amountUsd !== undefined)) costKnown = false;
  if (builder.execution === 'api' && !builderCost.some((event) => event.type === 'cost.update' && event.amountUsd !== undefined) && builderCost.some((event) => event.type === 'cost.update' && event.provider && !/lmstudio|ollama|local/.test(event.provider))) costKnown = false;
  const remaining = () => config.maxUsd - (handoff.cycle?.spentUsd ?? 0) - spent;
  const ensureCurrent = async (): Promise<void> => {
    const latest = await port.load(lead.id);
    port.assertSession(latest);
    if (JSON.stringify(deliverySettings(latest)) !== JSON.stringify(config)) throw new Error('Review or continuation settings changed. Review the result again.');
    const selected = port.leadTarget(latest);
    if ((selected ? stableLeadTargetIdentity(selected) : '') !== (leadTarget ? stableLeadTargetIdentity(leadTarget) : '')) throw new Error('The Lead model changed while reviewing. Review the next step with the visible model.');
    lead = latest;
    for (const file of files) {
      const current = await port.read(lead.projectId!, file.path);
      if (current.hash !== file.hash) {
        facts = { ...facts, state: 'needs-you', reason: 'A reviewed file changed. The task must be reviewed again before continuing.' };
        await storeFacts();
        throw new Error(facts.reason);
      }
    }
  };
  const reviewWith = async (target: RoleTarget, role: 'lead' | 'reviewer'): Promise<boolean> => {
    await ensureCurrent();
    const unavailable = port.unavailable(target);
    if (unavailable) throw new Error(unavailable);
    if (remaining() <= 0) throw new Error('Cycle spending limit reached before review. Review manually with a new budget.');
    if (!options.manualTarget && leadModelTier(target, port.inventory) === 'Paid API' && !costKnown) { await recordNotice(leadPricePause(unpricedSource)); return false; }
    const previousEvents = new Set(lead.events.map((event) => event.id));
    const reviewed = await port.ask(completionPrompt(builder, handoff, checkpoint, facts), target, role, remaining());
    if (!reviewed) throw new Error('Review stopped or failed. The task remains open.');
    const reply = reviewed.turns.at(-1);
    if (reply?.role !== 'assistant') throw new Error('Review has no completed reply.');
    const cost = recordedSpend(reviewed, previousEvents, target, port.inventory); spent += cost.amount; costKnown &&= cost.known;
    if (!cost.known) unpricedSource = target.execution === 'api' ? target.api?.model ?? 'the selected reviewer' : 'the selected reviewer';
    await ensureCurrent();
    facts = { ...applyCompletionVerdict(facts, reply.text), reviewTurnId: reply.id, reviewedBy: target };
    await storeFacts();
    return true;
  };
  const originalEvidence = { state: facts.state, reason: facts.reason };
  if (!await reviewWith(firstTarget, options.manualTarget && (!leadTarget || stableLeadTargetIdentity(firstTarget) !== stableLeadTargetIdentity(leadTarget)) ? 'reviewer' : 'lead')) return;
  if (!options.manualTarget && config.autoReview && config.reviewer) {
    // An unreadable local summary is not acceptance; the explicitly chosen reviewer may supply the missing verdict.
    if (!facts.reviewVerdict) facts = { ...facts, ...originalEvidence };
    if (!await reviewWith(config.reviewer, 'reviewer')) return;
  }
  const cycle = nextCycle(handoff, facts, spent);
  const block = continuationBlock(cycle, facts, config, costKnown);
  if (block || !leadTarget) {
    const note = !costKnown || isLeadPricePause(block ?? undefined) ? leadPricePause(unpricedSource) : block ?? 'Choose a Lead model before preparing the next task.';
    await recordNotice(note);
    const canPlan = !options.manualTarget && leadTarget && ['not-checked', 'needs-you'].includes(facts.state)
      && cycle.depth < config.maxTasks && cycle.repairs <= config.maxRepairs && remaining() > 0
      && !(cycle.failures.length >= 2 && cycle.failures.at(-1) === cycle.failures.at(-2))
      && (costKnown || leadModelTier(leadTarget, port.inventory) !== 'Paid API');
    if (canPlan && leadTarget) {
      await ensureCurrent();
      const unavailable = port.unavailable(leadTarget);
      if (unavailable) throw new Error(unavailable);
      const recovery = await port.ask(leadRecoveryPrompt(builder, handoff, checkpoint, facts), leadTarget, 'lead', remaining());
      if (recovery?.turns.at(-1)?.role === 'assistant') {
        await ensureCurrent();
        await port.save(markLeadRecoveryReply(recovery));
        await recordNotice(`${note} Lead prepared ways forward in this chat. Review the recovery task or decision; the blocked task and its gates remain open.`);
      }
    }
    return;
  }
  await ensureCurrent();
  if (options.manualTarget) { await recordNotice('Independent review recorded. Ask the Lead for the next step when ready.'); return; }
  // Discuss and Ask modes may prepare a task, but only Auto can dispatch it without another approval.
  const priorEvents = new Set(lead.events.map((event) => event.id));
  const next = await port.ask(`Builder result reviewed. Recorded task state: ${facts.state}. ${facts.reason}\nKeep the existing project plan and decisions as the source of truth. Do not mark a phase complete from this task alone. ${facts.state === 'needs-repair' ? 'Prepare one smaller repair task for the failed criteria only.' : 'Identify the next unfinished, unblocked step in the existing plan; do not invent additional scope. If nothing remains, explain that and return no Builder task.'}\nUse the normal bounded BUILDER TASK format. Leave decisions requiring approval as questions.`, leadTarget, 'lead', remaining());
  if (!next) return;
  const nextCost = recordedSpend(next, priorEvents, leadTarget, port.inventory);
  cycle.spentUsd += nextCost.amount;
  await ensureCurrent();
  const nextReply = next.turns.at(-1);
  if (leadHandoffMode(lead) === 'auto' && nextReply?.role === 'assistant' && runnableLeadTask(next, nextReply.id)) {
    const limit = continuationBlock(cycle, facts, config, costKnown && nextCost.known);
    if (limit) await recordNotice(limit);
    else await port.dispatch(nextReply.id, cycle);
  }
}
