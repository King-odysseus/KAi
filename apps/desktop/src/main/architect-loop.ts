import {
  ARCHITECT_BRIEF_SENTINEL,
  isSafeCheckCommand,
  ARCHITECT_STUCK_SENTINEL,
  ARCHITECT_VERDICT_SENTINEL,
  architectBriefSchema,
  architectSplitActive,
  architectVerdictSchema,
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
const REVIEW_MATERIAL_CHARS = 60_000;

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
  const parsed = architectBriefSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseVerdict(output: string): ArchitectVerdict | null {
  const raw = extractJsonAfter(output, ARCHITECT_VERDICT_SENTINEL);
  if (!raw) return null;
  const parsed = architectVerdictSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the Implementer asked for help with the exact marker. */
export function implementerIsStuck(output: string): boolean {
  return output.includes(ARCHITECT_STUCK_SENTINEL);
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

export function briefText(brief: ArchitectBrief): string {
  const lines = [`Goal: ${brief.goal}`];
  if (brief.files.length) lines.push(`Files to touch:\n${brief.files.map((file) => `- ${file}`).join('\n')}`);
  if (brief.avoid.length) lines.push(`Leave alone:\n${brief.avoid.map((item) => `- ${item}`).join('\n')}`);
  lines.push(`Done when:\n${brief.doneChecks.map((check) => `- ${check}`).join('\n')}`);
  if (brief.checkCommand && isSafeCheckCommand(brief.checkCommand)) lines.push(`KAI will run this before the review and the work cannot be approved while it fails: ${brief.checkCommand}`);
  return lines.join('\n\n');
}

export function planPrompt(task: string, label: string): string {
  return [
    `[Architect · ${label}]`,
    'You are the Architect. Another agent, the Implementer, will write the code; you only plan. You are read-only: do not edit files or run commands that change anything. Read what you need to plan well.',
    `Task:\n${task}`,
    `Write a brief the Implementer can work from without asking you anything. Keep it short and concrete. Finish your reply with its own line:\n${ARCHITECT_BRIEF_SENTINEL} ${BRIEF_SHAPE}`,
    'Every item in "doneChecks" must be something a reviewer can check against the files or a command, not a feeling.',
  ].join('\n\n');
}

export function implementPrompt(brief: ArchitectBrief, task: string, label: string): string {
  return [
    `[Implementer · ${label}]`,
    'You are the Implementer. The Architect planned this work; build exactly what the brief says, no more and no less. A reviewer will judge your work against the "Done when" list.',
    `Original request:\n${task}`,
    `Brief:\n${briefText(brief)}`,
    `If you cannot make progress, stop and end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on what blocks you. The Architect will step in.`,
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
}

function checkSection(check: BriefCheck | null | undefined): string {
  if (!check) return '';
  if (!check.ran) return `The brief's check command was not run (${check.skipped ?? 'no reason given'}): ${check.command}`;
  const tail = (check.output ?? '').trim().slice(-1_500);
  return `KAI ran the brief's check command: ${check.command}\nResult: ${check.passed ? 'PASSED' : `FAILED${check.exitCode === null || check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}`}${tail ? `\nOutput (end):\n${tail}` : ''}`;
}

export function reviewPrompt(brief: ArchitectBrief, task: string, material: string, implementerNote: string, label: string, check?: BriefCheck | null): string {
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
      `Finish your reply with its own line:\n${ARCHITECT_VERDICT_SENTINEL} ${VERDICT_SHAPE}`,
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
    `If you cannot make progress, end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on what blocks you.`,
  ].join('\n\n');
}

export function stepInPrompt(brief: ArchitectBrief, task: string, why: string, material: string, label: string): string {
  return [
    `[Architect · ${label}]`,
    'You are the Architect, and the Implementer is stuck. You are read-only: do not edit files and do not write the code yourself. Work out what is going wrong, then either give a corrected brief or point the Implementer in the right direction.',
    `Why you are stepping in:\n${why}`,
    `Original request:\n${task}`,
    `Current brief:\n${briefText(brief)}`,
    `What changed in the project so far:\n${material || '(nothing yet)'}`,
    `Finish your reply with its own line, a new brief that includes whatever the Implementer was missing:\n${ARCHITECT_BRIEF_SENTINEL} ${BRIEF_SHAPE}`,
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
  /** Runs a command in the project and says whether it passed. Only ever given a command that passed `isSafeCheckCommand`. */
  runCheck?(projectId: string, command: string, signal: AbortSignal): Promise<{ passed: boolean; exitCode: number | null; output: string }>;
  agentNames?(): Record<string, string>;
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

  /**
   * Who plays the Architect right now: the chosen one, else the fallback, else the Implementer. Said every time the
   * stand-in is used, because a silent swap would be exactly the thing the person asked KAI not to do.
   */
  async architectTarget(context: CoachContext): Promise<{ target: RoleTarget; fallbackUsed: boolean }> {
    const { split } = context;
    if (!architectSplitActive(split)) throw new ArchitectUnavailableError('The Architect / Implementer split is not set up.');
    const chosen = await this.ports.ready(split.architect);
    if (chosen.ready) return { target: split.architect, fallbackUsed: false };
    const standIn = split.fallback ?? split.implementer;
    const standInReady = await this.ports.ready(standIn);
    if (!standInReady.ready) {
      throw new ArchitectUnavailableError(
        `The Architect (${this.label(split.architect)}) is unavailable${chosen.reason ? `: ${chosen.reason}` : ''}, and so is its stand-in (${this.label(standIn)})${standInReady.reason ? `: ${standInReady.reason}` : ''}.`,
      );
    }
    context.onFallback?.(
      `The Architect (${this.label(split.architect)}) is unavailable${chosen.reason ? `: ${chosen.reason}` : ''}. ${this.label(standIn)} is standing in.`,
    );
    return { target: standIn, fallbackUsed: true };
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
      throw new Error(`The Architect (${this.label(target)}) could not answer: ${(result.error ?? result.output ?? '').slice(-400) || 'the run failed'}`);
    }
    return { output: result.output ?? '', label: this.label(target), fallbackUsed, costUsd: result.costUsd ?? 0 };
  }

  async plan(context: CoachContext, task: string): Promise<{ brief: ArchitectBrief; readable: boolean; label: string; fallbackUsed: boolean; costUsd: number }> {
    const answer = await this.ask(context, (label) => planPrompt(task, label), context.firstTurn ?? {});
    const brief = parseBrief(answer.output);
    return { brief: brief ?? fallbackBrief(task), readable: brief !== null, label: answer.label, fallbackUsed: answer.fallbackUsed, costUsd: answer.costUsd };
  }

  /**
   * Runs the brief's check command, when it has one. A command the Architect wrote is only run if it is a plain test or
   * check command: the Architect is read-only, and this must not be a way round that. Anything else is skipped and said so.
   */
  async runBriefCheck(projectId: string, brief: ArchitectBrief, signal: AbortSignal | undefined): Promise<BriefCheck | null> {
    const command = brief.checkCommand?.trim();
    if (!command) return null;
    if (!isSafeCheckCommand(command)) return { command, ran: false, skipped: 'it is not a plain test or check command, so KAI will not run it' };
    if (!this.ports.runCheck) return { command, ran: false, skipped: 'this build cannot run checks' };
    try {
      const result = await this.ports.runCheck(projectId, command, signal ?? new AbortController().signal);
      return { command, ran: true, passed: result.passed, exitCode: result.exitCode, output: result.output.slice(-2_000) };
    } catch (error) {
      if (signal?.aborted) throw new RunStoppedError();
      return { command, ran: false, skipped: `it could not be started: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async review(
    context: CoachContext,
    brief: ArchitectBrief,
    task: string,
    implementerNote: string,
    signal?: AbortSignal,
  ): Promise<{ verdict: ArchitectVerdict; readable: boolean; label: string; fallbackUsed: boolean; costUsd: number; check: BriefCheck | null }> {
    const material = (await this.ports.reviewMaterial(context.projectId).catch(() => '')).slice(0, REVIEW_MATERIAL_CHARS);
    const check = await this.runBriefCheck(context.projectId, brief, signal);
    const answer = await this.ask(context, (label) => reviewPrompt(brief, task, material, implementerNote, label, check));
    const parsed = parseVerdict(answer.output);
    // A failing check overrules an approval: the Architect read the diff, but the work does not do what the brief said.
    const verdict = parsed && parsed.verdict === 'approve' && check?.ran && check.passed === false
      ? {
          verdict: 'revise' as const,
          summary: 'Approved on reading, but the brief\'s check command failed, so the work is sent back.',
          corrections: [`The check "${check.command}" failed${check.exitCode === null || check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}. Make it pass without weakening it. Output (end): ${(check.output ?? '').trim().slice(-800)}`],
        }
      : parsed;
    if (verdict) return { verdict, readable: true, label: answer.label, fallbackUsed: answer.fallbackUsed, costUsd: answer.costUsd, check };
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
    const material = (await this.ports.reviewMaterial(context.projectId).catch(() => '')).slice(0, REVIEW_MATERIAL_CHARS);
    const answer = await this.ask(context, (label) => stepInPrompt(brief, task, why, material, label));
    const next = parseBrief(answer.output);
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
  composer: ComposerRecord;
  controller: AbortController;
  ownerWindowId: number;
  done: Promise<void>;
  /** Set while the loop is parked on the person's Continue / Finish. */
  waiting: ((carryOn: boolean) => void) | null;
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
      composer: { agent: input.agent, execution: input.execution ?? 'cli', route: input.route, autonomy: input.autonomy },
      controller: new AbortController(),
      ownerWindowId,
      done: Promise.resolve(),
      waiting: null,
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
    // Said once, at the end, so a strong planner's share sits next to the builder's.
    const closing = spent > 0
      ? `${message} Cost about $${spent.toFixed(2)}: Architect $${state.architectCostUsd.toFixed(2)}, Implementer $${state.implementerCostUsd.toFixed(2)}.`
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
      const implementer = await this.coach.implementerTarget(context);
      const implementerLabel = this.coach.label(implementer);

      this.phase(conversationId, owner, 'planning', 'architect', 'The Architect is planning.');
      const planned = await this.coach.plan(context, input.prompt);
      this.addCost(conversationId, 'architect', planned.costUsd);
      if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
      let brief = planned.brief;
      this.state(conversationId).fallbackUsed = planned.fallbackUsed || this.state(conversationId).fallbackUsed;
      this.record(conversationId, owner, 'architect', planned.readable
        ? `Brief ready (${planned.label}): ${brief.goal}`
        : `${planned.label} did not return a readable brief, so the task itself is the brief.`);

      let prompt = implementPrompt(brief, input.prompt, implementerLabel);
      let revisionsInARow = 0;
      let roundsSinceAsk = 0;
      let steppedInSinceApproval = false;

      for (;;) {
        if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
        const state = this.state(conversationId);
        state.round += 1;
        roundsSinceAsk += 1;

        this.phase(conversationId, owner, state.round === 1 ? 'implementing' : 'correcting', 'implementer',
          state.round === 1 ? 'The Implementer is building from the brief.' : 'The Implementer is fixing what the Architect sent back.', implementerLabel);
        const built = await this.ports.runAgent(requestForTarget(implementer, base, prompt, state.round === 1 ? (context.firstTurn ?? {}) : {}), owner);
        this.addCost(conversationId, 'implementer', built.costUsd);
        if (stopped() || built.cancelled) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
        if (built.status === 'failed' || built.error) {
          return this.settle(conversationId, owner, 'failed', `The Implementer (${implementerLabel}) failed: ${(built.error ?? built.output ?? '').slice(-300) || 'the run failed'}`);
        }
        const stuck = implementerIsStuck(built.output ?? '');
        if (stuck) this.record(conversationId, owner, 'implementer', 'The Implementer asked for help.');

        this.phase(conversationId, owner, 'reviewing', 'architect', 'The Architect is reviewing the work.');
        const reviewed = await this.coach.review(context, brief, input.prompt, built.output ?? '', active.controller.signal);
        this.addCost(conversationId, 'architect', reviewed.costUsd);
        if (reviewed.check) {
          this.record(conversationId, owner, null, reviewed.check.ran
            ? `Check "${reviewed.check.command}" ${reviewed.check.passed ? 'passed' : 'failed'}.`
            : `Check "${reviewed.check.command}" was not run: ${reviewed.check.skipped ?? 'no reason'}.`);
        }
        if (stopped()) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
        if (reviewed.fallbackUsed) this.state(conversationId).fallbackUsed = true;
        const verdict = reviewed.verdict;
        this.record(conversationId, owner, 'architect', `${verdict.verdict.toUpperCase()} (${reviewed.label}): ${verdict.summary}`);
        if (!reviewed.readable) this.record(conversationId, owner, null, 'The review could not be read, so the work was sent back rather than waved through.');

        if (verdict.verdict === 'approve' && !stuck) {
          return this.settle(conversationId, owner, 'finished', `Approved by the Architect after ${state.round} round${state.round === 1 ? '' : 's'}.`);
        }

        revisionsInARow = verdict.verdict === 'revise' ? revisionsInARow + 1 : 0;
        const needsStepIn = stuck || verdict.verdict === 'replan' || revisionsInARow >= REVISIONS_BEFORE_STEP_IN;

        // Never a cut-off: after a long time without an approval the person is asked.
        let askedThisRound = false;
        if (roundsSinceAsk >= ROUNDS_BEFORE_ASKING) {
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
          const why = stuck
            ? 'The Implementer said it is stuck.'
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
          prompt = implementPrompt(brief, input.prompt, implementerLabel);
          continue;
        }

        prompt = correctionPrompt(verdict, brief, implementerLabel);
      }
    } catch (error) {
      if (active.controller.signal.aborted || error instanceof RunStoppedError) return this.settle(conversationId, owner, 'stopped', 'Stopped.');
      return this.settle(conversationId, owner, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
}
