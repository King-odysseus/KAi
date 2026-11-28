import { leadDeliverySettingsSchema, parseTestCounts, verificationCaveat, type CheckpointReview, type ConversationRecord, type LeadCompletion, type LeadCycle, type LeadDeliverySettings } from '@kai/contracts';
import { handoffResult, leadResultReview, type LeadHandoff } from './lead-delivery';

export const deliverySettings = (lead: ConversationRecord): LeadDeliverySettings => leadDeliverySettingsSchema.parse(lead.leadDeliverySettings ?? {});
export function leadProgressContext(records: readonly ConversationRecord[], leadId: string): string[] {
  const tasks = records.flatMap((record) => (record.leadHandoffs ?? []).filter((handoff) => handoff.leadConversationId === leadId && handoff.completion).map((handoff) => ({ handoff, builderId: record.id }))).sort((a, b) => b.handoff.createdAt.localeCompare(a.handoff.createdAt));
  return tasks.length ? [
    'Durable task results recorded by KAI; the existing Studio board or spec plan remains the authoritative plan. Skip completed task work, preserve finished steps, and reconcile stale plan entries instead of repeating work. Task completion alone never closes a phase.',
    ...tasks.slice(0, 8).map(({ handoff, builderId }) => `Builder ${builderId}, task ${handoff.id}: ${handoff.completion!.state}. ${handoff.completion!.reason}${handoff.completion!.continuationNote ? ` Continuation: ${handoff.completion!.continuationNote}` : ''}\nTask goal: ${taskGoal(handoff.task)}`),
    ...(tasks.length > 8 ? [`${tasks.length - 8} older task records omitted; inspect saved task results if needed.`] : []),
  ] : [];
}
export function taskGoal(task: string): string {
  return (/^#{1,4} Goal\s*\n([^\n]+)/im.exec(task)?.[1] ?? task).trim().replace(/\s+/g, ' ');
}
const normalCommand = (value: string) => value.replace(/```\w*|```/g, '').replace(/\s+/g, ' ').trim();
const segments = (value: string) => value.split(/\s*&&\s*|\r?\n/).map(normalCommand).filter((part) => part && !/^cd\s/i.test(part));

export function taskRequirements(task: string): { commands: string[]; criteria: string[] } {
  const section = (names: string) => new RegExp(`^#{1,4} (?:${names})[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4} |$(?![\\s\\S]))`, 'im').exec(task)?.[1] ?? '';
  const commands = segments(section('Check command|Check commands')).filter((line) => !/^[-*]\s*$/.test(line)).map((line) => line.replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')).filter((line) => !/no (?:real )?check|not available|unknown/i.test(line));
  const criteria = section('Done checks|Acceptance checks|Acceptance criteria').split('\n').map((line) => /^\s*[-*]\s+(.+)/.exec(line)?.[1]?.trim()).filter((line): line is string => Boolean(line));
  return { commands, criteria };
}

/** Uses all requested checks. A later successful check cannot conceal a different failed gate. */
export function completionFacts(builder: ConversationRecord, handoff: LeadHandoff, review: CheckpointReview | null, files: LeadCompletion['files'], stale = false): LeadCompletion {
  const result = handoffResult(builder, handoff);
  if (!result) throw new Error('Builder has no completed reply for this task yet.');
  const request = builder.turns.find((turn, index) => index >= handoff.userTurnCount && turn.role === 'user' && turn.text.trim() === handoff.task.trim())!;
  const { commands, criteria } = taskRequirements(handoff.task);
  const checks = builder.events.flatMap((event) => {
    if (event.type !== 'tool.call' || (event.status !== 'completed' && event.status !== 'failed') || event.timestamp < request.createdAt || event.timestamp > result.answer.createdAt) return [];
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
    const output = event.output && typeof event.output === 'object' ? event.output as Record<string, unknown> : {};
    const command = String(input.command ?? input.cmd ?? '');
    if (!command || !commands.some((needed) => segments(command).includes(normalCommand(needed))) && !result.checks.some((check) => check.command === command)) return [];
    const exit = output.exitCode ?? output.exit_code;
    return [{ command, exitCode: typeof exit === 'number' ? exit : -1, output: [output.stdout, output.stderr, output.output, output.error].filter((part): part is string => typeof part === 'string').join('\n'), timestamp: event.timestamp }];
  });
  const missingChecks = commands.filter((command) => !checks.some((check) => segments(check.command).includes(normalCommand(command))));
  const latestChecks = [...new Map(checks.map((check) => [normalCommand(check.command), check])).values()];
  const unknownExit = latestChecks.some((check) => check.exitCode === -1);
  const failed = latestChecks.some((check) => check.exitCode !== 0 && check.exitCode !== -1 || (parseTestCounts(check.output).failed ?? 0) > 0);
  const caveat = latestChecks.find((check) => verificationCaveat(check.command, check.output));
  const state = stale ? 'needs-you' : failed ? 'needs-repair' : unknownExit || !commands.length || !checks.length || missingChecks.length || caveat || !review ? 'not-checked' : 'review-needed';
  const reason = stale ? 'Files changed after the Builder result. Review the current changes before continuing.' : failed ? 'A required check failed. The task and phase remain open.' : unknownExit ? 'A check did not report an exit code. Its result could not be verified.' : !commands.length ? 'No real check command was specified.' : missingChecks.length ? `Checks not run: ${missingChecks.join('; ')}` : caveat ? verificationCaveat(caveat.command, caveat.output)! : !review ? 'Checkpoint changes could not be inspected.' : 'Checks recorded; acceptance criteria still need review. This does not complete a phase.';
  return { resultTurnId: result.answer.id, state, reason, recordedAt: new Date().toISOString(), checks, missingChecks, criteria, files };
}

export interface CompletionVerdict { verdict: 'pass' | 'changes' | 'needs-you'; criteria: Array<{ criterion: string; passed: boolean; evidence: string }>; summary: string }
export function parseCompletionVerdict(text: string): CompletionVerdict | null {
  const raw = /LEAD_RESULT_REVIEW\s*\n([\s\S]*?)\nEND_LEAD_RESULT_REVIEW/.exec(text)?.[1];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CompletionVerdict;
    return ['pass', 'changes', 'needs-you'].includes(value.verdict) && typeof value.summary === 'string' && Array.isArray(value.criteria) && value.criteria.every((item) => typeof item.criterion === 'string' && typeof item.passed === 'boolean' && typeof item.evidence === 'string') ? value : null;
  } catch { return null; }
}

export function applyCompletionVerdict(facts: LeadCompletion, text: string): LeadCompletion {
  const verdict = parseCompletionVerdict(text);
  if (!verdict) return { ...facts, state: facts.state === 'needs-repair' ? facts.state : 'not-checked', reason: 'Review did not contain a readable verdict. Nothing was accepted.' };
  const supported = facts.criteria.length > 0 && facts.criteria.every((criterion) => verdict.criteria.some((item) => item.criterion === criterion && item.passed && [...facts.files.map((file) => `file:${file.path}`), ...facts.checks.filter((check) => check.exitCode === 0).map((check) => `check:${check.command}`)].some((source) => item.evidence.includes(source))));
  const state = facts.state === 'needs-you' ? 'needs-you' : facts.state === 'needs-repair' || verdict.verdict === 'changes' ? 'needs-repair' : verdict.verdict === 'needs-you' ? 'needs-you' : (facts.state === 'review-needed' || facts.state === 'passed') && supported ? 'passed' : 'not-checked';
  return { ...facts, state, reviewVerdict: verdict.verdict, reason: state === 'passed' ? 'Recorded checks and all task acceptance criteria passed review. Phase completion still requires its own gates.' : `Task remains open: ${verdict.summary}${!supported ? ' Acceptance evidence is incomplete.' : ''}` };
}

export function completionPrompt(builder: ConversationRecord, handoff: LeadHandoff, review: CheckpointReview | null, facts: LeadCompletion): string {
  return leadResultReview(builder, handoff, review) + `\n\nKAI recorded task state: ${facts.state}. ${facts.reason}\nRequired criteria (copy exactly in your review): ${JSON.stringify(facts.criteria)}\nRequired checks still missing: ${JSON.stringify(facts.missingChecks)}\nKeep failed/pending gates open. Never equate finishing a reply or a task with completing a phase. Review read-only; do not emit a Builder task in this review. Explain the result with headings and bullets, then append:\nLEAD_RESULT_REVIEW\n{"verdict":"pass|changes|needs-you","criteria":[{"criterion":"exact criterion","passed":true,"evidence":"file:path or check:exact command, with specific evidence"}],"summary":"short explanation"}\nEND_LEAD_RESULT_REVIEW`;
}

export function nextCycle(handoff: LeadHandoff, facts: LeadCompletion, spentUsd: number): LeadCycle {
  const previous = handoff.cycle ?? { rootId: handoff.id, depth: 0, repairs: 0, spentUsd: 0, failures: [] };
  const failure = facts.checks.filter((check) => check.exitCode !== 0).map((check) => `${normalCommand(check.command)}:${check.output.replace(/\d+|\s+/g, ' ').trim()}`).join('|') || (facts.state === 'needs-repair' ? facts.reason : '');
  return { rootId: previous.rootId, depth: previous.depth + 1, repairs: previous.repairs + (facts.state === 'needs-repair' ? 1 : 0), spentUsd: previous.spentUsd + spentUsd, failures: failure ? [...previous.failures, failure] : previous.failures };
}

export function continuationBlock(cycle: LeadCycle, facts: LeadCompletion, settings: LeadDeliverySettings, costKnown: boolean): string | null {
  if (facts.state !== 'passed' && facts.state !== 'needs-repair') return 'Review, missing checks or your decision are required before continuing.';
  if (cycle.depth >= settings.maxTasks) return 'The automatic task limit was reached. Review the work before continuing.';
  if (cycle.repairs > settings.maxRepairs) return 'The repair attempt limit was reached.';
  if (cycle.failures.length >= 2 && cycle.failures.at(-1) === cycle.failures.at(-2)) return 'The same failure repeated twice. A decision or a smaller task is needed.';
  if (!costKnown) return 'Paid usage could not be measured. Continue manually instead of assuming the cost is zero.';
  if (cycle.spentUsd >= settings.maxUsd) return 'The automatic cycle spending limit was reached.';
  return null;
}
