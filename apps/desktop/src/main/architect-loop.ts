import { lenient } from '@kai/contracts';
import { normalizeText, onRepeatDetected, repeatsItself } from './repeat-watch';
import { detectRateLimit } from './rate-limit';
import {
  ARCHITECT_BRIEF_SENTINEL,
  ARCHITECT_REPORT_SENTINEL,
  architectReportSchema,
  type ArchitectReport,
  isSafeCheckCommand,
  ARCHITECT_STUCK_SENTINEL,
  ARCHITECT_VERDICT_SENTINEL,
  architectBriefSchema,
  architectSplitActive,
  architectVerdictSchema,
  roleTargetKey,
  splitWorker,
  directProviderPreset,
  type AgentId,
  type AgentRunRequest,
  type AgentRunResult,
  type ArchitectBrief,
  type ArchitectLogEntry,
  type ArchitectPhase,
  type ArchitectRunInput,
  type ArchitectSplit,
  type ArchitectStatus,
  type ArchitectVerdict,
  type AutonomyMode,
  type RoleTarget,
  type RouteMode,
} from '@kai/contracts';

import type { ArchitectNote } from './architect-notes';
export { repeatsItself };

/**
 * The Architect / Implementer split.
 *
 * The Architect (a strong model) plans, reviews and sends work back; the Implementer writes the code. The Architect
 * never does the building: it runs read-only (`plan` autonomy), so "never implements" is a permission and not a
 * request. Everything here talks to the outside world through ports, the way the Auto session does, so the loop can
 * be driven in a test with no agent, no disk and no clock.
 */

const LOG_LIMIT = 80;
/** Revisions in a row the Implementer may fail review before the Architect steps in with a new brief. */
export const REVISIONS_BEFORE_STEP_IN = 3;
/** Rounds without an approval before the person is asked whether to carry on. A question, never a cut-off. */
export const ROUNDS_BEFORE_ASKING = 6;
/**
 * How much of the project's diff goes into one review prompt. Every review is a turn in the conversation, and a diff of
 * 60,000 characters (about 15,000 tokens) in each one made the conversation outgrow the auto-compact size as fast as it
 * could be compacted. The reviewer can read any file itself, so it gets a fair share of each file, not all of it.
 */
export const REVIEW_MATERIAL_CHARS = 12_000;

/**
 * The project's changes, cut to `limit` characters by giving every changed file an equal share, so one big file cannot
 * push the others out. The list of every file is always kept, and the cut is stated so the reviewer reads the rest.
 */
export function trimReviewMaterial(material: string, limit: number = REVIEW_MATERIAL_CHARS): string {
  if (material.length <= limit) return material;
  const chunks = material.split(/\n\n(?=--- )/);
  const names = chunks.map((chunk) => (chunk.split('\n', 1)[0] ?? '').replace(/^--- /, '').replace(/ \(new or unreadable as a diff\)$/, ''));
  const header = `${chunks.length} ${chunks.length === 1 ? 'file' : 'files'} changed: ${names.join(', ')}`.slice(0, 1_500);
  const footer = 'Parts of the diffs below were left out to keep this short. You can read any file yourself for the rest.';
  const budget = Math.max(400, Math.floor((limit - header.length - footer.length - 8) / chunks.length));
  const shown = chunks.map((chunk) => {
    if (chunk.length <= budget) return chunk;
    return `${chunk.slice(0, budget)}\n… (${(chunk.length - budget).toLocaleString()} more characters of this file's changes left out)`;
  });
  return [header, ...shown, footer].join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the Architect's answers
// ---------------------------------------------------------------------------------------------------------------------

/** The first balanced JSON object after the last occurrence of a marker, or null. Never read out of prose. */
export function extractJsonAfter(output: string, sentinel: string): unknown {
  const index = output.lastIndexOf(sentinel);
  if (index === -1) return null;
  const rest = output.slice(index + sentinel.length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let position = start; position < rest.length; position += 1) {
    const char = rest[position]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, position + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseBrief(output: string): ArchitectBrief | null {
  const raw = extractJsonAfter(output, ARCHITECT_BRIEF_SENTINEL);
  if (!raw) return null;
  const parsed = lenient(architectBriefSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseVerdict(output: string): ArchitectVerdict | null {
  const raw = extractJsonAfter(output, ARCHITECT_VERDICT_SENTINEL);
  if (!raw) return null;
  const parsed = lenient(architectVerdictSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the Implementer asked for help with the exact marker. */
export function implementerIsStuck(output: string): boolean {
  return output.includes(ARCHITECT_STUCK_SENTINEL);
}

/** The sentence the Implementer gave after the marker, or null when it did not ask for help. */
export function stuckReason(output: string): string | null {
  const at = output.indexOf(ARCHITECT_STUCK_SENTINEL);
  if (at < 0) return null;
  return output.slice(at + ARCHITECT_STUCK_SENTINEL.length).split(/\r?\n/, 1)[0]!.trim().slice(0, 300);
}

const normalizeReason = normalizeText;

/** The same blocker said again, ignoring case, punctuation and a little rewording at the end. */
export function sameStuckReason(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = normalizeReason(a);
  const y = normalizeReason(b);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = short === x ? y : x;
  return short === long || (short.length >= 25 && long.startsWith(short.slice(0, Math.floor(short.length * 0.8))));
}

/** When the blocker is a permission, say that in plain words in the log; otherwise null. */
export function namedStuckCause(reason: string | null): string | null {
  if (!reason) return null;
  if (/plan mode|read[- ]only|permission|denied|not allowed|cannot (edit|write|modify)|can't (edit|write|modify)/i.test(reason)) {
    return 'The Implementer says it is not allowed to edit or run commands. A split run builds in Auto-edit, so check that the Implementer\'s agent or its connection is not forced into a read-only mode.';
  }
  return null;
}

export function parseReport(output: string): ArchitectReport | null {
  const raw = extractJsonAfter(output, ARCHITECT_REPORT_SENTINEL);
  if (!raw) return null;
  const parsed = lenient(architectReportSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** The paths in the review material: each changed file starts its own chunk with `--- path`. */
export function changedPaths(material: string): string[] {
  return material.split('\n')
    .filter((line) => line.startsWith('--- '))
    .map((line) => line.slice(4).replace(/ \(new or unreadable as a diff\)$/, '').trim())
    .filter(Boolean);
}

/**
 * Sets what the Implementer says it did beside what the working tree shows. The diff is the truth: a file the report
 * names that is nowhere in it is a claim with nothing behind it. Returned as lines for the Architect, plus the files
 * that could not be found so an approval can be overruled.
 */
export function crossCheckReport(report: ArchitectReport | null, material: string): { lines: string[]; missing: string[] } {
  if (!report) return { lines: ['The Implementer gave no structured report (<<KAI_REPORT>>), so only the changes below can be trusted.'], missing: [] };
  const changed = changedPaths(material).map(normalizePath);
  const missing = report.filesChanged.filter((file) => {
    const wanted = normalizePath(file);
    return !changed.some((path) => path === wanted || path.endsWith(`/${wanted}`) || wanted.endsWith(`/${path}`));
  });
  const lines = [
    `The Implementer's own report: changed ${report.filesChanged.length ? report.filesChanged.join(', ') : 'nothing'}; ran ${report.checksRun.length ? report.checksRun.join('; ') : 'nothing'}; ${report.unfinished.length ? `left unfinished: ${report.unfinished.join('; ')}` : 'says nothing is unfinished'}.`,
  ];
  if (missing.length) lines.push(`KAI's cross-check: the report says ${missing.join(', ')} changed, but ${missing.length === 1 ? 'it is' : 'they are'} not in the working-tree changes. Treat the report as unreliable.`);
  return { lines, missing };
}

/**
 * The brief to work from when the Architect's answer could not be read. Said plainly in the log; the task itself is
 * the goal and the only done-check is that the task is actually complete, which the review then judges.
 */
export function fallbackBrief(task: string): ArchitectBrief {
  return {
    goal: task.trim().slice(0, 2_000),
    files: [],
    avoid: [],
    doneChecks: ['The task is fully done as the request describes it, and nothing outside it was changed.'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------------

const BRIEF_SHAPE = `{"goal": "one or two sentences", "files": ["path/to/touch"], "avoid": ["things to leave alone"], "doneChecks": ["a checkable statement that must be true when done"], "checkCommand": "optional: one plain test or typecheck command, for example npm test"}`;
const VERDICT_SHAPE = `{"verdict": "approve" | "revise" | "replan", "summary": "one or two sentences", "corrections": ["a specific fix"], "brief": <a new brief, only for "replan">}`;
/** The brief and verdict shapes when a Worker is in the split: the brief may list routine steps, and a verdict may say its fixes are mechanical. */
const BRIEF_SHAPE_WITH_WORKER = BRIEF_SHAPE.replace('"checkCommand"', '"routine": ["a mechanical step for the Worker, specific enough to do without judgement"], "checkCommand"');
const VERDICT_SHAPE_WITH_WORKER = VERDICT_SHAPE.replace('"brief"', '"routine": true only when every correction is mechanical and the Worker may apply it, "brief"');
const WORKER_PLAN_NOTE = (workerLabel: string): string =>
  `A second builder, the Worker (${workerLabel}), is a smaller model for routine edits. Put in "routine" only mechanical steps it can do without judgement: renames, boilerplate, tests, docs, applying an edit you describe exactly. Leave the hard parts out of it: they stay with the Implementer. Leave "routine" out if nothing qualifies.`;

export function briefText(brief: ArchitectBrief): string {
  const lines = [`Goal: ${brief.goal}`];
  if (brief.files.length) lines.push(`Files to touch:\n${brief.files.map((file) => `- ${file}`).join('\n')}`);
  if (brief.avoid.length) lines.push(`Leave alone:\n${brief.avoid.map((item) => `- ${item}`).join('\n')}`);
  lines.push(`Done when:\n${brief.doneChecks.map((check) => `- ${check}`).join('\n')}`);
  if (brief.checkCommand && isSafeCheckCommand(brief.checkCommand)) lines.push(`KAI will run this before the review and the work cannot be approved while it fails: ${brief.checkCommand}`);
  return lines.join('\n\n');
}

export function planPrompt(task: string, label: string, workerLabel?: string): string {
  return [
    `[Architect · ${label}]`,
    'You are the Architect. Another agent, the Implementer, will write the code; you only plan. You are read-only: do not edit files or run commands that change anything. Read what you need to plan well.',
    `Task:\n${task}`,
    `Write a brief the Implementer can work from without asking you anything. Keep it short and concrete. Finish your reply with its own line:\n${ARCHITECT_BRIEF_SENTINEL} ${workerLabel ? BRIEF_SHAPE_WITH_WORKER : BRIEF_SHAPE}`,
    'Every item in "doneChecks" must be something a reviewer can check against the files or a command, not a feeling.',
    ...(workerLabel ? [WORKER_PLAN_NOTE(workerLabel)] : []),
  ].join('\n\n');
}

/** Local models repeat any "plan mode" wording they have seen, so the build run says plainly that it is one. */
const BUILD_ACCESS_LINE = 'This is a build run, not a planning run. You may edit files and run commands in this project. Do not say you are in plan mode; make the changes.';

/** The structured report every Implementer turn ends with, so the Architect can check the claim against the diff. */
const REPORT_LINE = `When you finish a turn, end your reply with its own line: ${ARCHITECT_REPORT_SENTINEL} {"filesChanged": ["path"], "checksRun": ["command and how it came out"], "unfinished": ["what you did not get to"]}. Report only what is true.`;

export function implementPrompt(brief: ArchitectBrief, task: string, label: string, workerLabel?: string): string {
  const routine = workerLabel ? (brief.routine ?? []) : [];
  return [
    `[Implementer · ${label}]`,
    'You are the Implementer. The Architect planned this work; build exactly what the brief says, no more and no less. A reviewer will judge your work against the "Done when" list.',
    `Original request:\n${task}`,
    `Brief:\n${briefText(brief)}`,
    ...(routine.length ? [`A second builder, the Worker (${workerLabel}), will do these routine steps after you. Do not do them yourself:\n${routine.map((step) => `- ${step}`).join('\n')}`] : []),
    BUILD_ACCESS_LINE,
    REPORT_LINE,
    `If you cannot make progress, stop and end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on what blocks you. The Architect will step in.`,
  ].join('\n\n');
}

/** The Worker's turn: the brief's routine steps, done exactly as written, and nothing else. */
export function workerPrompt(brief: ArchitectBrief, task: string, label: string, steps: readonly string[]): string {
  return [
    `[Worker · ${label}]`,
    'You are the Worker. A stronger model planned this work and another builder has done the hard part. Do exactly the routine steps below, as written. Do not redesign anything and do not touch other files.',
    `Original request:\n${task}`,
    `Goal of the whole job: ${brief.goal}`,
    `Your steps:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    BUILD_ACCESS_LINE,
    REPORT_LINE,
    `If a step is not possible as written, stop and end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on why. The Architect will step in.`,
  ].join('\n\n');
}

/** What running the brief's check command came to, for the review and the log. */
export interface BriefCheck {
  command: string;
  ran: boolean;
  passed?: boolean;
  exitCode?: number | null;
  /** The tail of what the command printed. */
  output?: string;
  /** Why it was not run. */
  skipped?: string;
  /** KAI picked the command from the project (its test script), because the brief named none. Informs; never blocks. */
  auto?: boolean;
}

function checkSection(check: BriefCheck | null | undefined): string {
  if (!check) return '';
  if (!check.ran) return `The brief's check command was not run (${check.skipped ?? 'no reason given'}): ${check.command}`;
  const tail = (check.output ?? '').trim().slice(-1_500);
  if (check.auto) return `The brief named no check command, so KAI ran the project's own: ${check.command}
Result: ${check.passed ? 'PASSED' : `FAILED${check.exitCode === null || check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}`} (for your information: it may have been failing before this work, so judge whether the failure is this change's)${tail ? `
Output (end):
${tail}` : ''}`;
  return `KAI ran the brief's check command: ${check.command}\nResult: ${check.passed ? 'PASSED' : `FAILED${check.exitCode === null || check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}`}${tail ? `\nOutput (end):\n${tail}` : ''}`;
}

/** The revise verdict a failing check gives, whether it overrules an approval or is the whole review. */
export function checkFailedVerdict(check: BriefCheck, summary: string): ArchitectVerdict {
  return {
    verdict: 'revise',
    summary,
    corrections: [`The check "${check.command}" failed${check.exitCode === null || check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}. Make it pass without weakening it. Output (end): ${(check.output ?? '').trim().slice(-800)}`],
  };
}

export function reviewPrompt(brief: ArchitectBrief, task: string, material: string, implementerNote: string, label: string, check?: BriefCheck | null, withWorker = false): string {
  return [
    `[Architect · ${label}]`,
    'You are the Architect, reviewing the Implementer\'s work. You are read-only: do not edit files. Judge the work against the brief\'s "Done when" list and the original request. Be strict and specific: name what is wrong, not that it "could be better".',
    `Original request:\n${task}`,
    `Brief:\n${briefText(brief)}`,
    `The Implementer's closing note:\n${implementerNote.slice(-2_500) || '(none)'}`,
    `What changed in the project:\n${material || '(no changes were found in the working tree)'}`,
    ...(check ? [checkSection(check)] : []),
    [
      'Decide:',
      '- "approve": every "Done when" item holds.',
      '- "revise": the approach is right but specific things are wrong; list them in "corrections", each one fixable on its own.',
      '- "replan": the approach itself is wrong or the Implementer is going in circles; give a new "brief".',
      ...(withWorker ? ['A Worker model is available for mechanical fixes. For "revise", set "routine": true only if every correction is mechanical (a rename, a missing line, a listed edit); anything needing judgement stays with the Implementer.'] : []),
      `Finish your reply with its own line:\n${ARCHITECT_VERDICT_SENTINEL} ${withWorker ? VERDICT_SHAPE_WITH_WORKER : VERDICT_SHAPE}`,
    ].join('\n'),
  ].join('\n\n');
}

export function correctionPrompt(verdict: ArchitectVerdict, brief: ArchitectBrief, label: string): string {
  const fixes = verdict.corrections.length
    ? verdict.corrections.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : verdict.summary;
  return [
    `[Implementer · ${label}]`,
    'The Architect reviewed your work and sent it back. Fix exactly these, then stop. Do not redo what already passes.',
    `Fixes:\n${fixes}`,
    `Still the brief:\n${briefText(brief)}`,
    BUILD_ACCESS_LINE,
    REPORT_LINE,
    `If you cannot make progress, end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on what blocks you.`,
  ].join('\n\n');
}

/** The review's mechanical corrections, handed to the Worker instead of the Implementer. */
export function workerCorrectionPrompt(verdict: ArchitectVerdict, brief: ArchitectBrief, label: string): string {
  const fixes = verdict.corrections.length ? verdict.corrections.map((item, index) => `${index + 1}. ${item}`).join('\n') : verdict.summary;
  return [
    `[Worker · ${label}]`,
    'You are the Worker. The Architect reviewed the work and found fixes that are mechanical. Make exactly these, then stop. Do not redo what already passes and do not change anything else.',
    `Fixes:\n${fixes}`,
    `Goal of the whole job: ${brief.goal}`,
    BUILD_ACCESS_LINE,
    REPORT_LINE,
    `If a fix is not possible as written, end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on why.`,
  ].join('\n\n');
}

export function stepInPrompt(brief: ArchitectBrief, task: string, why: string, material: string, label: string, workerLabel?: string): string {
  return [
    `[Architect · ${label}]`,
    'You are the Architect, and the Implementer is stuck. You are read-only: do not edit files and do not write the code yourself. Work out what is going wrong, then either give a corrected brief or point the Implementer in the right direction.',
    `Why you are stepping in:\n${why}`,
    `Original request:\n${task}`,
    `Current brief:\n${briefText(brief)}`,
    `What changed in the project so far:\n${material || '(nothing yet)'}`,
    `Finish your reply with its own line, a new brief that includes whatever the Implementer was missing:\n${ARCHITECT_BRIEF_SENTINEL} ${workerLabel ? BRIEF_SHAPE_WITH_WORKER : BRIEF_SHAPE}`,
    ...(workerLabel ? [WORKER_PLAN_NOTE(workerLabel)] : []),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------------------------------

/** "Claude · opus" or "DeepSeek API · deepseek-v4-pro": what a person reads to know who is working. */
export function targetLabel(target: RoleTarget, agentNames: Readonly<Record<string, string>> = {}): string {
  if (target.execution === 'cli') {
    const name = agentNames[target.agent ?? ''] ?? target.agent ?? 'agent';
    return target.model ? `${name} · ${target.model}` : name;
  }
  const api = target.api;
  if (!api) return 'API';
  const preset = directProviderPreset(api.provider);
  const model = api.model || preset.defaultModel;
  return model ? `${preset.displayName} · ${model}` : preset.displayName;
}

/**
 * The access an Implementer runs with. Its whole job is to edit files, for every agent, CLI or API: Plan and a
 * custom setup without edit permission are read-only, and Ask waits for an approval a headless run cannot give, so the
 * Implementer would report itself stuck and no new brief could fix that. Everything short of Full becomes Auto-edit;
 * Full is already more than enough and stays as chosen.
 */
export function implementerAutonomy(autonomy: AutonomyMode): AutonomyMode {
  return autonomy === 'full' ? 'full' : 'autoEdit';
}

/** One builder's turn in a round: who builds, and what it is told. */
interface BuildTurn {
  role: 'implementer' | 'worker';
  prompt: string;
}

export interface RunBase {
  conversationId: string;
  route: RouteMode;
  autonomy: AutonomyMode;
  /** Used where a request needs an agent id and the target is an API: the schema asks for one, the API run ignores it. */
  placeholderAgent: AgentId;
}

/** The run request for one target. An API role runs direct: the proxy route would replace the role's own connection. */
export function requestForTarget(target: RoleTarget, base: RunBase, prompt: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
  if (target.execution === 'api') {
    return {
      conversationId: base.conversationId,
      prompt,
      agent: base.placeholderAgent,
      execution: 'api',
      route: 'direct',
      autonomy: base.autonomy,
      ...(target.api ? { apiConnection: target.api } : {}),
      ...extra,
    };
  }
  return {
    conversationId: base.conversationId,
    prompt,
    agent: target.agent ?? base.placeholderAgent,
    execution: 'cli',
    route: base.route,
    autonomy: base.autonomy,
    ...(target.model ? { model: target.model } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Architect's side: plan, review, step in
// ---------------------------------------------------------------------------------------------------------------------

export interface TargetReadiness {
  ready: boolean;
  reason?: string;
}

export interface ArchitectCoachPorts {
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  /** Whether a target can run right now: a CLI that is signed in, an API with its key or its server reachable. */
  ready(target: RoleTarget): Promise<TargetReadiness>;
  /** The changes in the project's working tree, as text for the Architect to read; empty when there are none. */
  reviewMaterial(projectId: string): Promise<string>;
  /**
   * A fingerprint of the content of every changed file, for telling whether a turn changed anything. Without it the
   * review material is compared instead, which is bounded and so can miss an edit.
   */
  fingerprint?(projectId: string): Promise<string>;
  /** The project's own test command, when the brief names none. Run for information only, never to block. */
  suggestCheck?(projectId: string): Promise<string | null>;
  /** Runs a command in the project and says whether it passed. Only ever given a command that passed `isSafeCheckCommand`. */
  runCheck?(projectId: string, command: string, signal: AbortSignal): Promise<{ passed: boolean; exitCode: number | null; output: string }>;
  agentNames?(): Record<string, string>;
  /**
   * Told every plan and every verdict the Architect gives, so the project keeps its direction and decisions outside
   * the conversation. KAI calls it, not the Architect, so it happens whether or not the model remembers to. A failure
   * here never stops the run.
   */
  record?(projectId: string, note: ArchitectNote): Promise<void>;
}

export interface CoachContext {
  split: ArchitectSplit;
  projectId: string;
  base: RunBase;
  ownerWindowId: number;
  /** The composer's own context (skills, chosen files, chips, goal): the planning and first building turns carry it. */
  firstTurn?: Partial<AgentRunRequest>;
  /** Told when the Architect's stand-in works instead, so the person is never left guessing. */
  onFallback?: (message: string) => void;
  /** Accounts that have hit a usage limit in this run, by `limitKey`; every role on one is skipped from then on. */
  exhausted?: Set<string>;
  /** Told each time a role moves to another model because of a limit, so a switch is never silent. */
  onSwitch?: (message: string) => void;
}

/**
 * The account a target spends from. A usage limit belongs to the account, not to a model: Claude on opus and Claude on
 * sonnet share one subscription window, so a limit on one is a limit on both.
 */
export function limitKey(target: RoleTarget): string {
  if (target.execution === 'cli') return `cli:${target.agent ?? ''}`;
  return `api:${target.api?.provider ?? ''}:${target.api?.credentialId ?? ''}:${target.api?.baseUrl ?? ''}`;
}

/** Whether a failed run's message reads as a usage or rate limit. */
export function failedOnLimit(result: { error?: string | undefined; output?: string | undefined }): boolean {
  return detectRateLimit(result.error ?? result.output ?? '') !== null;
}

export class ArchitectUnavailableError extends Error {}

/** The person stopped a run while an agent was working. Not a failure, and never reported as one. */
export class RunStoppedError extends Error {
  constructor() {
    super('The run was stopped.');
  }
}

/** Everything the Architect does in a run. Shared by the Auto session and the normal-mode loop. */
export class ArchitectCoach {
  constructor(private readonly ports: ArchitectCoachPorts) {}

  names(): Readonly<Record<string, string>> {
    return this.ports.agentNames?.() ?? {};
  }

  label(target: RoleTarget): string {
    return targetLabel(target, this.names());
  }

  /** The Worker's label for prompts, or undefined when the split has none. */
  workerLabel(context: CoachContext): string | undefined {
    const worker = splitWorker(context.split);
    return worker ? this.label(worker) : undefined;
  }

  /** The Worker, when there is one and it can run now; null otherwise (the Implementer then does everything). */
  async workerTarget(context: CoachContext): Promise<{ target: RoleTarget | null; why?: string }> {
    const worker = splitWorker(context.split);
    if (!worker) return { target: null };
    const ready = await this.ports.ready(worker);
    return ready.ready ? { target: worker } : { target: null, why: `The Worker (${this.label(worker)}) is unavailable${ready.reason ? `: ${ready.reason}` : ''}, so the Implementer does the routine steps too.` };
  }

  /**
   * Who plays the Architect right now: the chosen one, else the fallback, else the Implementer. Said every time the
   * stand-in is used, because a silent swap would be exactly the thing the person asked KAI not to do.
   */
  async architectTarget(context: CoachContext): Promise<{ target: RoleTarget; fallbackUsed: boolean }> {
    const { split } = context;
    if (!architectSplitActive(split)) throw new ArchitectUnavailableError('The Architect / Implementer split is not set up.');
    const spent = (target: RoleTarget): boolean => context.exhausted?.has(limitKey(target)) === true;
    const limitReason = 'its usage limit is reached';
    const chosen = spent(split.architect) ? { ready: false, reason: limitReason } : await this.ports.ready(split.architect);
    if (chosen.ready) return { target: split.architect, fallbackUsed: false };
    // Next available, in order: the fallback the person chose (else the Implementer), then whoever else is in the split.
    const standIn = split.fallback ?? split.implementer;
    const others = [split.implementer, splitWorker(split)].filter((target): target is RoleTarget => target !== null && roleTargetKey(target) !== roleTargetKey(standIn));
    const first = spent(standIn) ? { ready: false, reason: limitReason } : await this.ports.ready(standIn);
    let chosenStandIn: RoleTarget | null = first.ready ? standIn : null;
    for (const other of chosenStandIn ? [] : others) {
      if (spent(other)) continue;
      if ((await this.ports.ready(other)).ready) { chosenStandIn = other; break; }
    }
    if (!chosenStandIn) {
      throw new ArchitectUnavailableError(
        `The Architect (${this.label(split.architect)}) is unavailable${chosen.reason ? `: ${chosen.reason}` : ''}, and so is its stand-in (${this.label(standIn)})${first.reason ? `: ${first.reason}` : ''}.`,
      );
    }
    context.onFallback?.(
      `The Architect (${this.label(split.architect)}) is unavailable${chosen.reason ? `: ${chosen.reason}` : ''}. ${this.label(chosenStandIn)} is standing in.`,
    );
    return { target: chosenStandIn, fallbackUsed: true };
  }

  /**
   * Who builds next when the current builder has hit a usage limit: the Worker, else the fallback, whichever is ready and
   * not itself spent. Null when there is nobody, and the run then fails or asks as it did before.
   */
  async nextBuilder(context: CoachContext, current: RoleTarget): Promise<RoleTarget | null> {
    const candidates = [splitWorker(context.split), context.split.fallback ?? null, context.split.architect]
      .filter((target): target is RoleTarget => target !== null && limitKey(target) !== limitKey(current) && !context.exhausted?.has(limitKey(target)));
    for (const candidate of candidates) {
      if ((await this.ports.ready(candidate)).ready) return candidate;
    }
    return null;
  }

  async implementerTarget(context: CoachContext): Promise<RoleTarget> {
    const { split } = context;
    if (!architectSplitActive(split)) throw new ArchitectUnavailableError('The Architect / Implementer split is not set up.');
    const ready = await this.ports.ready(split.implementer);
    if (!ready.ready) {
      throw new ArchitectUnavailableError(`The Implementer (${this.label(split.implementer)}) is unavailable${ready.reason ? `: ${ready.reason}` : ''}.`);
    }
    return split.implementer;
  }

  /**
   * One read-only Architect run. Always a fresh session, so the Architect never inherits the Implementer's. The prompt
   * is built from the label of whoever is actually answering, which is only known once the fallback is settled.
   */
  private async ask(
    context: CoachContext,
    buildPrompt: (label: string) => string,
    extra: Partial<AgentRunRequest> = {},
  ): Promise<{ output: string; label: string; fallbackUsed: boolean; costUsd: number }> {
    // A usage limit moves the work to the next available model and the answer is asked for again; any other failure,
    // or running out of models, is reported as it always was. At most one switch per model in the split.
    for (let attempt = 0; ; attempt += 1) {
      const { target, fallbackUsed } = await this.architectTarget(context);
      const request = requestForTarget(
        target,
        { ...context.base, autonomy: 'plan' },
        buildPrompt(this.label(target)),
        { freshSession: true, ...extra },
      );
      const result = await this.ports.runAgent(request, context.ownerWindowId);
      if (result.cancelled) throw new RunStoppedError();
      if (result.status === 'failed' || result.error) {
        if (context.exhausted && attempt < 4 && failedOnLimit(result)) {
          context.exhausted.add(limitKey(target));
          context.onSwitch?.(`The Architect (${this.label(target)}) has reached its usage limit, so the next available model takes over.`);
          continue;
        }
        throw new Error(`The Architect (${this.label(target)}) could not answer: ${(result.error ?? result.output ?? '').slice(-400) || 'the run failed'}`);
      }
      return { output: result.output ?? '', label: this.label(target), fallbackUsed, costUsd: result.costUsd ?? 0 };
    }
  }

  /** Hands a note to the port without waiting for it: the notes are a record, and a slow or failed write must not hold up the run. */
  private note(projectId: string, note: ArchitectNote): void {
    void Promise.resolve(this.ports.record?.(projectId, note)).catch(() => undefined);
  }

  async plan(context: CoachContext, task: string): Promise<{ brief: ArchitectBrief; readable: boolean; label: string; fallbackUsed: boolean; costUsd: number }> {
    const answer = await this.ask(context, (label) => planPrompt(task, label, this.workerLabel(context)), { ...(context.firstTurn ?? {}), splitRole: 'architect', taskText: task });
    const brief = parseBrief(answer.output);
    if (brief) this.note(context.projectId, { kind: 'plan', title: brief.goal, lines: [briefText(brief)] });
    return { brief: brief ?? fallbackBrief(task), readable: brief !== null, label: answer.label, fallbackUsed: answer.fallbackUsed, costUsd: answer.costUsd };
  }

  /**
   * Runs the brief's check command, when it has one. A command the Architect wrote is only run if it is a plain test or
   * check command: the Architect is read-only, and this must not be a way round that. Anything else is skipped and said so.
   */
  async runBriefCheck(projectId: string, brief: ArchitectBrief, signal: AbortSignal | undefined): Promise<BriefCheck | null> {
    let command = brief.checkCommand?.trim();
    let auto = false;
    if (!command) {
      // No check in the brief: the project's own test script is the next best thing to look at, but only as information.
      command = (await this.ports.suggestCheck?.(projectId).catch(() => null))?.trim() || undefined;
      if (!command || !this.ports.runCheck || !isSafeCheckCommand(command)) return null;
      auto = true;
    }
    if (!isSafeCheckCommand(command)) return { command, ran: false, skipped: 'it is not a plain test or check command, so KAI will not run it' };
    if (!this.ports.runCheck) return { command, ran: false, skipped: 'this build cannot run checks' };
    try {
      const result = await this.ports.runCheck(projectId, command, signal ?? new AbortController().signal);
      return { command, ran: true, passed: result.passed, exitCode: result.exitCode, output: result.output.slice(-2_000), ...(auto ? { auto } : {}) };
    } catch (error) {
      if (signal?.aborted) throw new RunStoppedError();
      return { command, ran: false, skipped: `it could not be started: ${error instanceof Error ? error.message : String(error)}`, ...(auto ? { auto } : {}) };
    }
  }

  async review(
    context: CoachContext,
    brief: ArchitectBrief,
    task: string,
    implementerNote: string,
    signal?: AbortSignal,
    /** The check, when the loop already ran it before asking for a review. */
    ranCheck?: BriefCheck | null,
  ): Promise<{ verdict: ArchitectVerdict; readable: boolean; label: string; fallbackUsed: boolean; costUsd: number; check: BriefCheck | null }> {
    const rawMaterial = await this.ports.reviewMaterial(context.projectId).catch(() => '');
    const material = trimReviewMaterial(rawMaterial);
    const check = ranCheck !== undefined ? ranCheck : await this.runBriefCheck(context.projectId, brief, signal);
    // What the Implementer says it did, set beside what the working tree shows. The diff wins.
    const crossCheck = crossCheckReport(parseReport(implementerNote), rawMaterial);
    const note = `${implementerNote.slice(-2_500) || '(none)'}\n\n${crossCheck.lines.join('\n')}`;
    const answer = await this.ask(context, (label) => reviewPrompt(brief, task, material, note, label, check, splitWorker(context.split) !== null), { splitRole: 'architect', taskText: task });
    const parsed = parseVerdict(answer.output);
    // A failing check overrules an approval: the Architect read the diff, but the work does not do what the brief said.
    // So does a report that names changes the working tree does not have: an approval cannot rest on a claim nothing backs.
    const verdict = parsed && parsed.verdict === 'approve' && check?.ran && check.passed === false && !check.auto
      ? checkFailedVerdict(check, 'Approved on reading, but the brief\'s check command failed, so the work is sent back.')
      : parsed && parsed.verdict === 'approve' && crossCheck.missing.length
        ? {
            verdict: 'revise' as const,
            summary: 'Approved on reading, but the Implementer\'s report names changes that are not in the project, so the work is sent back.',
            corrections: [`Your report says ${crossCheck.missing.join(', ')} changed, but nothing in the project shows it. Make the change, or correct the report.`],
          }
        : parsed;
    if (verdict) {
      this.note(context.projectId, {
        kind: verdict.verdict === 'approve' ? 'approved' : verdict.verdict === 'replan' ? 'replan' : 'revise',
        title: brief.goal,
        lines: [verdict.summary, ...verdict.corrections.map((correction) => `- ${correction}`)],
      });
      return { verdict, readable: true, label: answer.label, fallbackUsed: answer.fallbackUsed, costUsd: answer.costUsd, check };
    }
    // An unreadable verdict is not an approval. Sending it back with the Architect's own words is firmer than letting
    // unreviewed work through, and it is said in the log.
    const words = answer.output.trim().slice(-600) || 'The Architect gave no readable verdict.';
    return {
      verdict: { verdict: 'revise', summary: 'The review could not be read.', corrections: [words] },
      readable: false,
      label: answer.label,
      fallbackUsed: answer.fallbackUsed,
      costUsd: answer.costUsd,
      check,
    };
  }

  /** The Architect steps in: a new brief, or a pointer, after a review. */
  async stepIn(
    context: CoachContext,
    brief: ArchitectBrief,
    task: string,
    why: string,
  ): Promise<{ brief: ArchitectBrief; readable: boolean; label: string; fallbackUsed: boolean; costUsd: number }> {
    const material = trimReviewMaterial(await this.ports.reviewMaterial(context.projectId).catch(() => ''));
    const answer = await this.ask(context, (label) => stepInPrompt(brief, task, why, material, label, this.workerLabel(context)), { splitRole: 'architect', taskText: task });
    const next = parseBrief(answer.output);
    if (next) this.note(context.projectId, { kind: 'step-in', title: next.goal, lines: [`Why: ${why.slice(0, 400)}`, briefText(next)] });
    return { brief: next ?? brief, readable: next !== null, label: answer.label, fallbackUsed: answer.fallbackUsed, costUsd: answer.costUsd };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The normal-mode loop
// ---------------------------------------------------------------------------------------------------------------------

export interface ArchitectLoopPorts extends ArchitectCoachPorts {
  cancelAgent(conversationId: string): boolean;
  /** Opens a blank conversation for a task started with none, and shows it in the window. Without it one must be given. */
  openNewConversation?(projectId: string, title: string, ownerWindowId: number): Promise<{ id: string }>;
  /**
   * Puts the composer's own agent, mode, route and access back on the conversation once the run ends. Each role's run
   * records itself as the conversation's agent, so without this a tab reopened elsewhere would show whichever role ran last.
   */
  restoreComposer?(conversationId: string, composer: ComposerRecord): Promise<void>;
  /** Saves the split on the conversation, so the tab comes back with the same Architect and Implementer. */
  rememberSplit?(conversationId: string, split: ArchitectSplit): Promise<void>;
  announce(ownerWindowId: number, status: ArchitectStatus): void;
  now(): number;
}

/** A run with its conversation settled: given, or just opened. */
type ResolvedRun = ArchitectRunInput & { conversationId: string };

/** What the composer showed when the run was started. */
export interface ComposerRecord {
  agent: AgentId;
  execution: 'cli' | 'api';
  route: RouteMode;
  autonomy: AutonomyMode;
}

interface ActiveLoop {
  split: ArchitectSplit;
  composer: ComposerRecord;
  controller: AbortController;
  ownerWindowId: number;
  done: Promise<void>;
  /** Set while the loop is parked on the person's Continue / Finish. */
  waiting: ((carryOn: boolean) => void) | null;
  /** The person ended the Implementer's turn on purpose, to hand the work to the Architect rather than stop the run. */
  handoff: boolean;
  /** What the hand-off says about why the turn ended. */
  handoffReason: string;
}

/** Plan → implement → review → correct, for a normal send. The same Architect that Auto uses, without Auto's check loop. */
export class ArchitectLoop {
  private readonly runs = new Map<string, ActiveLoop>();
  private readonly statuses = new Map<string, ArchitectStatus>();
  readonly coach: ArchitectCoach;

  constructor(private readonly ports: ArchitectLoopPorts) {
    this.coach = new ArchitectCoach(ports);
  }

  status(conversationId: string): ArchitectStatus | null {
    return this.statuses.get(conversationId) ?? null;
  }

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  async start(requested: ArchitectRunInput, ownerWindowId: number): Promise<ArchitectStatus> {
    if (!architectSplitActive(requested.split)) throw new Error('Choose an Architect and an Implementer first.');
    let conversationId = requested.conversationId;
    if (!conversationId) {
      if (!this.ports.openNewConversation) throw new Error('A conversation is needed to run in.');
      conversationId = (await this.ports.openNewConversation(requested.projectId, requested.prompt.slice(0, 64), ownerWindowId)).id;
    }
    const input: ResolvedRun = { ...requested, conversationId };
    if (this.runs.has(input.conversationId)) throw new Error('The Architect is already working on this conversation.');
    await this.ports.rememberSplit?.(input.conversationId, input.split).catch(() => undefined);
    const active: ActiveLoop = {
      split: input.split,
      composer: { agent: input.agent, execution: input.execution ?? 'cli', route: input.route, autonomy: input.autonomy },
      controller: new AbortController(),
      ownerWindowId,
      done: Promise.resolve(),
      waiting: null,
      handoff: false,
      handoffReason: '',
    };
    const status = this.fresh(input);
    this.runs.set(input.conversationId, active);
    this.statuses.set(input.conversationId, status);
    this.phase(input.conversationId, ownerWindowId, 'preparing', null, 'Checking that both agents are ready.');
    active.done = this.drive(input, active).finally(() => this.runs.delete(input.conversationId));
    return status;
  }

  async stop(conversationId: string): Promise<ArchitectStatus | null> {
    const active = this.runs.get(conversationId);
    if (!active) return this.status(conversationId);
    active.controller.abort(new Error('Stopped.'));
    active.waiting?.(false);
    this.ports.cancelAgent(conversationId);
    await active.done.catch(() => undefined);
    return this.status(conversationId);
  }

  /**
   * Ends the Implementer's current turn and has the Architect step in, instead of stopping the whole run. For a turn that
   * is going in circles: the work done so far stays, and the Architect reads it. Does nothing when no turn is running.
   */
  handoff(conversationId: string, reason = 'you ended this turn because it was going in circles'): ArchitectStatus | null {
    const active = this.runs.get(conversationId);
    if (active && !active.waiting && this.status(conversationId)?.role === 'implementer') {
      active.handoff = true;
      active.handoffReason = reason;
      this.ports.cancelAgent(conversationId);
    }
    return this.status(conversationId);
  }

  /** The person's answer to a Continue / Finish question. */
  answer(conversationId: string, carryOn: boolean): ArchitectStatus | null {
    this.runs.get(conversationId)?.waiting?.(carryOn);
    return this.status(conversationId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((conversationId) => this.stop(conversationId)));
  }

  // -------------------------------------------------------------------------------------------------------------------

  private fresh(input: ResolvedRun): ArchitectStatus {
    const split = input.split;
    const now = new Date(this.ports.now()).toISOString();
    return {
      conversationId: input.conversationId,
      projectId: input.projectId,
      phase: 'preparing',
      role: null,
      label: '',
      message: '',
      round: 0,
      fallbackUsed: false,
      architectLabel: split.architect ? this.coach.label(split.architect) : '',
      implementerLabel: split.implementer ? this.coach.label(split.implementer) : '',
      architectCostUsd: 0,
      implementerCostUsd: 0,
      startedAt: now,
      updatedAt: now,
      log: [],
    };
  }

  private state(conversationId: string): ArchitectStatus {
    const state = this.statuses.get(conversationId);
    if (!state) throw new Error('No Architect run for this conversation.');
    return state;
  }

  private record(conversationId: string, ownerWindowId: number, role: ArchitectLogEntry['role'], text: string): void {
    const state = this.state(conversationId);
    state.log = [...state.log, { at: new Date(this.ports.now()).toISOString(), role, text: text.slice(0, 600) }].slice(-LOG_LIMIT);
    state.updatedAt = new Date(this.ports.now()).toISOString();
    this.ports.announce(ownerWindowId, { ...state });
  }

  private phase(conversationId: string, ownerWindowId: number, phase: ArchitectPhase, role: ArchitectStatus['role'], message: string, label = ''): void {
    const state = this.state(conversationId);
    state.phase = phase;
    state.role = role;
    state.message = message.slice(0, 600);
    state.label = label;
    state.updatedAt = new Date(this.ports.now()).toISOString();
    this.ports.announce(ownerWindowId, { ...state });
  }

  private addCost(conversationId: string, role: 'architect' | 'implementer', usd: number | undefined): void {
    if (!usd || usd <= 0) return;
    const state = this.state(conversationId);
    if (role === 'architect') state.architectCostUsd += usd;
    else state.implementerCostUsd += usd;
  }

  private settle(conversationId: string, ownerWindowId: number, phase: 'finished' | 'stopped' | 'failed', message: string): void {
    const state = this.state(conversationId);
    const spent = state.architectCostUsd + state.implementerCostUsd;
    const split = this.runs.get(conversationId)?.split;
    // A CLI on its own subscription does not report what a run cost, so "$0.00" would read as "free" when it is "unknown".
    const share = (usd: number, target: RoleTarget | null | undefined): string =>
      usd > 0 ? `$${usd.toFixed(2)}` : target?.execution === 'cli' ? 'not reported' : '$0.00';
    // Said once, at the end, so a strong planner's share sits next to the builder's.
    const closing = spent > 0
      ? `${message} Cost about $${spent.toFixed(2)} (what was reported): Architect ${share(state.architectCostUsd, split?.architect)}, Implementer ${share(state.implementerCostUsd, split?.implementer)}.`
      : message;
    this.phase(conversationId, ownerWindowId, phase, null, closing);
    this.record(conversationId, ownerWindowId, null, closing);
    const run = this.runs.get(conversationId);
    if (run) void Promise.resolve(this.ports.restoreComposer?.(conversationId, run.composer)).catch(() => undefined);
  }

  /** Parks for Continue / Finish. Resolves true to carry on. */
  private async ask(conversationId: string, active: ActiveLoop, message: string): Promise<boolean> {
    this.phase(conversationId, active.ownerWindowId, 'waiting-for-you', null, message);
    this.record(conversationId, active.ownerWindowId, null, message);
    const carryOn = await new Promise<boolean>((resolve) => { active.waiting = resolve; });
    active.waiting = null;
    return carryOn && !active.controller.signal.aborted;
  }

  /** What the project's changed files hold right now, to compare one moment with another; null when it cannot be read. */
  private async treeSnapshot(projectId: string): Promise<string | null> {
    try {
      return this.ports.fingerprint ? await this.ports.fingerprint(projectId) : await this.ports.reviewMaterial(projectId);
    } catch {
      return null;
    }
  }

  /**
   * One builder turn (the Implementer's or the Worker's). A turn that starts repeating itself is ended and handed to the
   * Architect; one that fails is tried once more; and one that fails on a usage limit moves to the next available model,
   * which then carries the rest of the run. Returns who ended up running it.
   */
  private async buildTurn(args: {
    context: CoachContext;
    input: ResolvedRun;
    active: ActiveLoop;
    owner: number;
    base: RunBase;
    prompt: string;
    target: RoleTarget;
    first: boolean;
  }): Promise<{ built: AgentRunResult; target: RoleTarget }> {
    const { context, input, active, owner, base, prompt } = args;
    const { conversationId } = input;
    const stopped = (): boolean => active.controller.signal.aborted;
    let target = args.target;
    for (let switches = 0; ; switches += 1) {
      const request = requestForTarget(target, base, prompt, { ...(args.first ? (context.firstTurn ?? {}) : {}), splitRole: 'implementer', taskText: input.prompt });
      // A turn that starts repeating the same paragraph is going in circles: it is ended and handed to the Architect, who
      // keeps the work so far and gives it a smaller first step. Said in the log; the same blocker twice asks the person.
      const stopListening = onRepeatDetected(conversationId, () => {
        this.record(conversationId, owner, null, 'The builder turn kept repeating itself, so KAI ended it and handed the work to the Architect.');
        this.handoff(conversationId, 'it kept repeating itself without making progress, so KAI ended the turn');
      });
      let built: AgentRunResult;
      try {
        built = await this.ports.runAgent(request, owner);
        // Ended on purpose, by the person or by the repeat watch, to hand the turn to the Architect: that is a stuck turn, not a stop.
        if (active.handoff && built.cancelled && !stopped()) {
          active.handoff = false;
          built = { ...built, cancelled: false, status: 'completed', output: `${built.output ?? ''}\n${ARCHITECT_STUCK_SENTINEL} ${active.handoffReason}` };
        }
        active.handoff = false;
        const failed = (): boolean => !stopped() && !built.cancelled && (built.status === 'failed' || Boolean(built.error));
        // A usage limit is the account's, not the work's: the next available model takes over instead of the run failing.
        if (failed() && failedOnLimit(built) && switches < 3) {
          context.exhausted?.add(limitKey(target));
          const next = await this.coach.nextBuilder(context, target);
          if (next) {
            this.addCost(conversationId, 'implementer', built.costUsd);
            this.record(conversationId, owner, null, `${this.coach.label(target)} has reached its usage limit, so ${this.coach.label(next)} carries on from here.`);
            target = next;
            continue;
          }
        }
        // A server that dropped or a CLI that hiccuped fails the turn without the work being wrong. One more go, said in
        // the log, before the whole run is given up; a stop is never retried.
        if (failed() && !failedOnLimit(built)) {
          this.record(conversationId, owner, null, `The turn failed (${(built.error ?? built.output ?? '').slice(-200).trim() || 'no reason given'}). Trying that turn once more.`);
          this.addCost(conversationId, 'implementer', built.costUsd);
          built = await this.ports.runAgent(request, owner);
        }
      } finally {
        stopListening();
      }
      return { built, target };
    }
  }

  private async drive(input: ResolvedRun, active: ActiveLoop): Promise<void> {
    const { conversationId } = input;
    const owner = active.ownerWindowId;
    const split = input.split;
    const base: RunBase = { conversationId, route: input.route, autonomy: input.autonomy, placeholderAgent: input.agent };
    const context: CoachContext = {
      split,
      projectId: input.projectId,
      base,
      ownerWindowId: owner,
      firstTurn: {
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.skills?.length ? { skills: input.skills } : {}),
        ...(input.selectedPaths?.length ? { selectedPaths: input.selectedPaths } : {}),
        ...(input.contextChips?.length ? { contextChips: input.contextChips } : {}),
      },
      exhausted: new Set<string>(),
      onSwitch: (message) => this.record(conversationId, owner, null, message),
      // Said the first time and not on every round; the status keeps showing that a stand-in is working.
      onFallback: (message) => {
        const state = this.state(conversationId);
        if (state.fallbackUsed) return;
        state.fallbackUsed = true;
        this.record(conversationId, owner, 'architect', message);
      },
    };
    const stopped = (): boolean => active.controller.signal.aborted;
    try {
      // The Implementer must be ready before any planning is paid for.
      let implementer = await this.coach.implementerTarget(context);
      let implementerLabel = this.coach.label(implementer);
      // The Worker only takes part if it can run now; otherwise the Implementer does the routine steps too, and the log says so.
      const workerChoice = await this.coach.workerTarget(context);
      let worker = workerChoice.target;
      if (workerChoice.why) {
        this.record(conversationId, owner, null, workerChoice.why);
        context.split = { ...context.split, worker: null };
      }
      let workerLabel = worker ? this.coach.label(worker) : undefined;

      this.phase(conversationId, owner, 'planning', 'architect', 'The Architect is planning.');
      const planned = await this.coach.plan(context, input.prompt);
      this.addCost(conversationId, 'architect', planned.costUsd);
      if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
      let brief = planned.brief;
      this.state(conversationId).fallbackUsed = planned.fallbackUsed || this.state(conversationId).fallbackUsed;
      this.record(conversationId, owner, 'architect', planned.readable
        ? `Brief ready (${planned.label}): ${brief.goal}`
        : `${planned.label} did not return a readable brief, so the task itself is the brief.`);

      // What one round builds: the Implementer first, then the Worker for the brief's routine steps when there are any.
      const turnsFor = (forBrief: ArchitectBrief): BuildTurn[] => {
        const steps = worker ? (forBrief.routine ?? []) : [];
        const planned: BuildTurn[] = [{ role: 'implementer', prompt: implementPrompt(forBrief, input.prompt, implementerLabel, steps.length ? workerLabel : undefined) }];
        if (worker && workerLabel && steps.length) planned.push({ role: 'worker', prompt: workerPrompt(forBrief, input.prompt, workerLabel, steps) });
        return planned;
      };
      let turns = turnsFor(brief);
      let revisionsInARow = 0;
      let roundsSinceAsk = 0;
      let steppedInSinceApproval = false;
      let lastStuckReason: string | null = null;

      for (;;) {
        if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
        const state = this.state(conversationId);
        state.round += 1;
        roundsSinceAsk += 1;

        // The Implementer's whole job is to write code. Plan autonomy (the composer's setting, or the Architect's own
        // read-only one) would deny every edit, it would report itself stuck, and the Architect's new brief could never
        // fix that: an endless loop. So every builder works in Auto-edit whatever the composer says.
        const builderBase: RunBase = { ...base, autonomy: implementerAutonomy(base.autonomy) };
        // What the project looked like before this round, so a round that changed nothing is seen as that.
        const treeBefore = await this.treeSnapshot(input.projectId);
        const outputs: string[] = [];
        for (const [index, turn] of turns.entries()) {
          const isWorker = turn.role === 'worker' && worker !== null;
          const label = isWorker ? (workerLabel ?? 'Worker') : implementerLabel;
          this.phase(conversationId, owner, state.round === 1 && index === 0 ? 'implementing' : 'correcting', 'implementer',
            isWorker ? 'The Worker is doing the routine steps.' : state.round === 1 ? 'The Implementer is building from the brief.' : 'The Implementer is fixing what the Architect sent back.', label);
          const outcome = await this.buildTurn({
            context, input, active, owner, base: builderBase, prompt: turn.prompt,
            target: isWorker ? worker! : implementer, first: state.round === 1 && index === 0,
          });
          const built = outcome.built;
          this.addCost(conversationId, 'implementer', built.costUsd);
          // A switch because of a usage limit holds for the rest of the run.
          if (isWorker) { worker = outcome.target; workerLabel = this.coach.label(outcome.target); } else { implementer = outcome.target; implementerLabel = this.coach.label(outcome.target); }
          if (stopped() || built.cancelled) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
          if (built.status === 'failed' || built.error) {
            return this.settle(conversationId, owner, 'failed', `The ${isWorker ? 'Worker' : 'Implementer'} (${this.coach.label(outcome.target)}) failed: ${(built.error ?? built.output ?? '').slice(-300) || 'the run failed'}`);
          }
          outputs.push(built.output ?? '');
          // A turn that asked for help or went round in circles ends the round: the Architect steps in, not the next builder.
          if (implementerIsStuck(built.output ?? '') || repeatsItself(built.output ?? '')) break;
        }
        const builtOutput = outputs.join('\n\n');
        const asked = implementerIsStuck(builtOutput);
        const looping = !asked && repeatsItself(builtOutput);
        // A turn that left the working tree exactly as it was has built nothing, whatever its closing note says. That is
        // stuck, and there is nothing for a paid review to read.
        const treeAfter = asked || looping ? null : await this.treeSnapshot(input.projectId);
        const changedNothing = treeBefore !== null && treeAfter !== null && treeBefore === treeAfter;
        const stuck = asked || looping || changedNothing;
        const reason = asked ? stuckReason(builtOutput) : looping ? 'its reply repeats the same paragraphs' : changedNothing ? 'its turn changed nothing in the project' : null;
        if (stuck) {
          this.record(conversationId, owner, 'implementer', looping
            ? 'The Implementer\'s reply repeats itself, so it is treated as stuck.'
            : changedNothing
              ? 'The Implementer\'s turn changed nothing in the project, so it is treated as stuck.'
              : `The Implementer asked for help${reason ? `: ${reason}` : '.'}`);
          const cause = namedStuckCause(reason);
          if (cause) this.record(conversationId, owner, null, cause);
        }
        // The same blocker twice running means another brief will not help: ask the person at once, not after N rounds.
        const sameBlocker = stuck && sameStuckReason(reason, lastStuckReason);
        lastStuckReason = stuck ? reason : null;

        // The cheap check comes first. A failing check, or a turn that built nothing, goes straight back to the Implementer
        // without a paid review; the Architect reads the work once it is at least green.
        const precheck = changedNothing ? null : await this.coach.runBriefCheck(input.projectId, brief, active.controller.signal);
        let reviewed: Awaited<ReturnType<ArchitectCoach['review']>>;
        if (changedNothing) {
          reviewed = {
            verdict: { verdict: 'revise', summary: 'The Implementer\'s turn changed nothing in the project.', corrections: ['Your last turn left the project exactly as it was. Make the changes the brief asks for, then report them.'] },
            readable: true, label: 'KAI', fallbackUsed: false, costUsd: 0, check: null,
          };
        } else if (!stuck && precheck?.ran && precheck.passed === false && !precheck.auto) {
          reviewed = { verdict: checkFailedVerdict(precheck, 'The brief\'s check command failed, so the work went back without a review.'), readable: true, label: 'KAI check', fallbackUsed: false, costUsd: 0, check: precheck };
        } else {
          this.phase(conversationId, owner, 'reviewing', 'architect', 'The Architect is reviewing the work.');
          reviewed = await this.coach.review(context, brief, input.prompt, builtOutput, active.controller.signal, precheck);
        }
        this.addCost(conversationId, 'architect', reviewed.costUsd);
        if (reviewed.check) {
          this.record(conversationId, owner, null, reviewed.check.ran
            ? `Check "${reviewed.check.command}" ${reviewed.check.passed ? 'passed' : 'failed'}.`
            : `Check "${reviewed.check.command}" was not run: ${reviewed.check.skipped ?? 'no reason'}.`);
        }
        if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
        if (reviewed.fallbackUsed) this.state(conversationId).fallbackUsed = true;
        const verdict = reviewed.verdict;
        // KAI's own checks are not the Architect's words, and the log must not say they are.
        this.record(conversationId, owner, reviewed.label.startsWith('KAI') ? null : 'architect', `${verdict.verdict.toUpperCase()} (${reviewed.label}): ${verdict.summary}`);
        if (!reviewed.readable) this.record(conversationId, owner, null, 'The review could not be read, so the work was sent back rather than waved through.');

        if (verdict.verdict === 'approve' && !stuck) {
          return this.settle(conversationId, owner, 'finished', `Approved by the Architect after ${state.round} round${state.round === 1 ? '' : 's'}.`);
        }

        revisionsInARow = verdict.verdict === 'revise' ? revisionsInARow + 1 : 0;
        const needsStepIn = stuck || verdict.verdict === 'replan' || revisionsInARow >= REVISIONS_BEFORE_STEP_IN;

        // Never a cut-off: after a long time without an approval the person is asked.
        let askedThisRound = false;
        if (sameBlocker) {
          const carryOn = await this.ask(conversationId, active, `The Implementer is stuck on the same thing again${reason ? ` (${reason})` : ''}, and another brief is unlikely to change that. Continue, or finish here?`);
          if (!carryOn) return this.settle(conversationId, owner, active.controller.signal.aborted ? 'stopped' : 'finished', 'Finished at your request, without the Architect\'s approval.');
          roundsSinceAsk = 0;
          askedThisRound = true;
          lastStuckReason = null;
        } else if (roundsSinceAsk >= ROUNDS_BEFORE_ASKING) {
          const carryOn = await this.ask(conversationId, active, `${state.round} rounds and the Architect has not approved. Continue, or finish here?`);
          if (!carryOn) return this.settle(conversationId, owner, active.controller.signal.aborted ? 'stopped' : 'finished', 'Finished at your request, without the Architect\'s approval.');
          roundsSinceAsk = 0;
          askedThisRound = true;
        }

        if (needsStepIn) {
          // One question per round: having just been told to carry on, the person is not asked the same thing again.
          if (!askedThisRound && steppedInSinceApproval && revisionsInARow >= REVISIONS_BEFORE_STEP_IN) {
            const carryOn = await this.ask(conversationId, active, 'The Architect has already stepped in and the work is still not right. Continue, or finish here?');
            if (!carryOn) return this.settle(conversationId, owner, active.controller.signal.aborted ? 'stopped' : 'finished', 'Finished at your request, without the Architect\'s approval.');
            revisionsInARow = 0;
          }
          this.phase(conversationId, owner, 'replanning', 'architect', 'The Architect is stepping in.');
          const circling = stuck && /repeat|circles|changed nothing/i.test(reason ?? '');
          const why = stuck
            ? `The Implementer is stuck${reason ? `: ${reason}` : '.'}${circling ? ' It keeps re-reading and describing the work instead of editing. A small model needs one concrete first step: name the single file and the exact change to make first, and tell it to make that edit before reading anything else.' : ''}`
            : verdict.verdict === 'replan'
              ? `Your review found the approach is wrong: ${verdict.summary}`
              : `The Implementer has failed review ${revisionsInARow} times in a row. Latest problems: ${verdict.corrections.join('; ') || verdict.summary}`;
          // A replacement brief in the verdict is taken as it stands; otherwise the Architect is asked for one.
          if (verdict.verdict === 'replan' && verdict.brief) {
            brief = verdict.brief;
            this.record(conversationId, owner, 'architect', 'New brief issued.');
          } else {
            const stepped = await this.coach.stepIn(context, brief, input.prompt, why);
            this.addCost(conversationId, 'architect', stepped.costUsd);
            if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
            brief = stepped.brief;
            this.record(conversationId, owner, 'architect', stepped.readable ? `Stepped in with a new brief (${stepped.label}).` : 'Stepped in, but the new brief could not be read; the old one stands.');
          }
          steppedInSinceApproval = true;
          revisionsInARow = 0;
          turns = turnsFor(brief);
          continue;
        }

        // Corrections the Architect calls mechanical go to the Worker; anything needing judgement stays with the Implementer.
        turns = worker && workerLabel && verdict.verdict === 'revise' && verdict.routine
          ? [{ role: 'worker', prompt: workerCorrectionPrompt(verdict, brief, workerLabel) }]
          : [{ role: 'implementer', prompt: correctionPrompt(verdict, brief, implementerLabel) }];
      }
    } catch (error) {
      if (active.controller.signal.aborted || error instanceof RunStoppedError) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
      return this.settle(conversationId, owner, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
}
