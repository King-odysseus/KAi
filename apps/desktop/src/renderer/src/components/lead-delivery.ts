import { checkEvidenceFromEvents, verificationCaveat, type ConversationRecord, type CheckpointReview } from '@kai/contracts';
import { redactText } from '../../../../../../packages/runtime/src/redaction';

export type LeadHandoff = NonNullable<ConversationRecord['leadHandoffs']>[number];

/** A newer unsent draft must not hide the outcome of the reply that actually finished. */
export function latestBuilderResultHandoff(conversation: ConversationRecord): LeadHandoff | undefined {
  const last = conversation.turns?.at(-1);
  return last?.role === 'assistant'
    ? [...(conversation.leadHandoffs ?? [])].reverse().find((item) => handoffResult(conversation, item)?.answer.id === last.id)
    : conversation.leadHandoffs?.at(-1)?.completion ? conversation.leadHandoffs.at(-1) : undefined;
}

export function leadChatTitle(question: string): string {
  return question.trim().split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 90) || 'Lead';
}

export function handoffResult(conversation: ConversationRecord, handoff: LeadHandoff) {
  const requestIndex = conversation.turns.findIndex((turn, index) => index >= handoff.userTurnCount && turn.role === 'user' && turn.text.trim() === handoff.task.trim());
  if (requestIndex < 0) return null;
  const answer = conversation.turns[requestIndex + 1];
  if (answer?.role !== 'assistant') return null;
  const request = conversation.turns[requestIndex]!;
  const events = conversation.events.filter((event) => event.timestamp >= request.createdAt && event.timestamp <= answer.createdAt);
  const checks = checkEvidenceFromEvents(events);
  const commands = events.flatMap((event) => {
    if (event.type !== 'tool.call' || !['completed', 'failed'].includes(event.status)) return [];
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
    const command = input.command ?? input.cmd;
    if (typeof command !== 'string' || !command.trim()) return [];
    const output = event.output && typeof event.output === 'object' ? event.output as Record<string, unknown> : {};
    const content = Array.isArray(output.content) ? output.content.flatMap((item) => item && typeof item === 'object' && typeof item.text === 'string' ? [item.text] : []) : [];
    const text = typeof event.output === 'string' ? event.output : [...new Set([output.stdout, output.stderr, output.output, output.text, output.error, ...content].filter((part): part is string => typeof part === 'string'))].join('\n');
    const exit = output.exitCode ?? output.exit_code;
    return [{ id: event.id, command, output: text || 'No textual command output was recorded.', exitCode: typeof exit === 'number' ? exit : null, timestamp: event.timestamp }];
  });
  const last = checks.at(-1);
  const reason = last ? verificationCaveat(last.command, last.output) : 'No recorded project check for this result.';
  const status = checks.some((check) => check.exitCode !== 0) ? 'Failed' : !last || reason || checks.some((check) => verificationCaveat(check.command, check.output)) ? 'Not checked' : 'Checked';
  return { request, answer, checks, commands, status, reason };
}

/** Only complete evidence sections fit; omitted sections are named, never cut mid-code. */
export function leadResultReview(conversation: ConversationRecord, handoff: LeadHandoff, review: CheckpointReview | null): string {
  const result = handoffResult(conversation, handoff);
  if (!result) throw new Error('The linked Builder task has no completed reply yet.');
  const sections = [
    { name: 'Task', text: handoff.task },
    { name: 'Builder reply', text: result.answer.text },
    ...result.commands.map((command) => ({ name: `Command: ${command.command} (exit ${command.exitCode ?? 'unknown'}, ${command.timestamp})`, text: command.output })),
    ...(review?.files ?? []).map((file) => ({ name: `Changes: ${file.path}`, text: file.binary ? 'Binary change; inspect separately.' : `Before:\n${file.before}\n\nAfter:\n${file.after}` })),
  ];
  let text = `Review this linked Builder result read-only. Use headings and bullets. Check the task against the actual changes and evidence. State gaps and the next action. Do not claim checks passed without evidence.\nRecorded status: ${result.status}${result.reason ? ` — ${result.reason}` : ''}.\n${review ? '' : 'Checkpoint diff unavailable; recorded Builder command output below is still available. A recorded diff is not a fresh inspection of the current files.'}`;
  const omitted: string[] = [];
  for (const section of sections) {
    const part = redactText(`\n\n## ${section.name}\n${section.text}`);
    if (text.length + part.length <= 10_000) text += part;
    else omitted.push(section.name);
  }
  return text + (omitted.length ? `\n\nEvidence omitted due to size: ${omitted.join('; ')}. Read the relevant project files before drawing conclusions.` : '');
}

/** Resolve list-only records before a Lead request can save context or inspect history. */
export async function hydrateLeadConversation(record: ConversationRecord, load: (id: string) => Promise<ConversationRecord | null>): Promise<ConversationRecord> {
  if (!('__summary' in record)) return record;
  const full = await load(record.id);
  if (!full || '__summary' in full || full.id !== record.id || full.projectId !== record.projectId || full.origin?.kind !== 'lead') {
    throw new Error('Could not load the complete Lead conversation. Retry before sending; saved history has not been changed.');
  }
  return full;
}
