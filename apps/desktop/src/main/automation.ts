import type { AgentRunRequest, AgentRunResult, ConversationRecord, ProjectAutomation, ProjectHook } from '@kai/contracts';
import { hasProjectAutomation, MAX_AUTO_FIX_ROUNDS } from '@kai/contracts';
import { globMatches } from './glob-match';

const HOOK_DEFAULT_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const FIX_OUTPUT_TAIL = 6_000;
const HOOK_OUTPUT_TAIL = 2_000;

export interface ShellResult {
  exitCode: number | null;
  output: string;
}

/** Everything the automation needs from the app, so the flow can be tested without Electron or a model. */
export interface AutomationPorts {
  /** One ordinary agent turn: saves the transcript, streams events, records changes. */
  runOnce(request: AgentRunRequest): Promise<AgentRunResult>;
  automation(): Promise<ProjectAutomation | undefined>;
  conversation(): Promise<ConversationRecord | null>;
  /** The check command KAI detects from the project, used when none is configured. */
  suggestCheck(): Promise<string | null>;
  runShell(command: string, timeoutMs: number, env: Record<string, string>): Promise<ShellResult>;
  /** Store a finished check so the Verification panel and Cognitive1 see it. */
  recordCheck(command: string, result: ShellResult): Promise<void>;
  /** Add a short assistant message to the conversation so the user sees what the automation did. */
  note(text: string): Promise<void>;
  /** A second model's opinion of the change, or null when review is unavailable. */
  review(request: AgentRunRequest, changedFiles: string[]): Promise<string | null>;
  /** True once the user pressed Stop; the flow then ends without running anything further. */
  cancelled?(): boolean;
}

export interface AutomationOutcome {
  result: AgentRunResult;
  /** Automatic fix rounds that were needed. */
  fixRounds: number;
  /** Null when no check ran. */
  checkPassed: boolean | null;
  filesChanged: number;
}

/**
 * Run a prompt with the project's automation around it: hooks, then the agent, then (only if it changed files) the
 * formatter hooks, the project's checks with automatic fixes, a review, and the closing hooks. With no automation
 * configured this is exactly one agent turn.
 */
export async function runWithAutomation(ports: AutomationPorts, request: AgentRunRequest): Promise<AutomationOutcome> {
  const automation = await ports.automation();
  if (!hasProjectAutomation(automation)) {
    const result = await ports.runOnce(request);
    return { result, fixRounds: 0, checkPassed: null, filesChanged: await countChangedFiles(ports, new Set()) };
  }

  const hookEnv = (event: string): Record<string, string> => ({ KAI_EVENT: event, KAI_CONVERSATION_ID: request.conversationId });
  let prompt = request.prompt;
  const before = await runHooks(ports, 'beforeRun', automation.hooks?.beforeRun, hookEnv('beforeRun'));
  if (before.failure) {
    const conversation = await ports.conversation();
    if (!conversation) throw new Error('Conversation not found.');
    const error = `The beforeRun hook failed, so the run did not start: ${before.failure}`;
    await ports.note(`Automation stopped this run. ${before.failure}`);
    return {
      result: { conversation: (await ports.conversation()) ?? conversation, status: 'failed', output: '', error },
      fixRounds: 0,
      checkPassed: null,
      filesChanged: 0,
    };
  }
  if (before.context) prompt = `${before.context}\n\n${prompt}`;

  if (ports.cancelled?.()) return stoppedOutcome(ports);
  let result = await ports.runOnce({ ...request, prompt });
  const changed = new Set<string>();
  await collectChangedFiles(ports, changed);
  let fixRounds = 0;
  let checkPassed: boolean | null = null;

  if (result.status === 'completed' && changed.size > 0) {
    const edit = await runHooks(ports, 'afterEdit', automation.hooks?.afterEdit, hookEnv('afterEdit'));
    if (edit.failure) await ports.note(`An afterEdit hook failed. ${edit.failure}`);

    const check = automation.autoCheck;
    if (check?.enabled) {
      const command = check.command?.trim() || (await ports.suggestCheck());
      const maxRounds = Math.min(Math.max(check.maxRounds, 1), MAX_AUTO_FIX_ROUNDS);
      if (!command) {
        await ports.note('Automatic checks are on, but this project has no check command. Set one in Settings, Project automation.');
      } else {
        for (let round = 0; ; round += 1) {
          if (ports.cancelled?.()) break;
          const outcome = await ports.runShell(command, CHECK_TIMEOUT_MS, hookEnv('check'));
          if (ports.cancelled?.()) {
            await ports.note('Stopped while checking your changes.');
            break;
          }
          await ports.recordCheck(command, outcome).catch(() => undefined);
          if (outcome.exitCode === 0) {
            checkPassed = true;
            await ports.note(
              round === 0
                ? `Check passed: ${command}`
                : `Check passed after ${round} automatic ${round === 1 ? 'fix' : 'fixes'}: ${command}`,
            );
            break;
          }
          checkPassed = false;
          if (round >= maxRounds) {
            await ports.note(`Check still failing after ${maxRounds} automatic ${maxRounds === 1 ? 'fix' : 'fixes'}: ${command} (${describeExit(outcome)}). Review the output and decide what to do next.`);
            break;
          }
          await ports.note(`Check failed: ${command} (${describeExit(outcome)}). Asking the agent to fix it, attempt ${round + 1} of ${maxRounds}.`);
          fixRounds += 1;
          result = await ports.runOnce({ ...request, prompt: buildFixPrompt(command, outcome, round + 1, maxRounds) });
          await collectChangedFiles(ports, changed);
          if (result.status !== 'completed') break;
        }
      }
    }

    if (result.status === 'completed' && automation.review?.enabled && !ports.cancelled?.()) {
      const opinion = await ports.review(request, [...changed]).catch(() => null);
      if (opinion) await ports.note(opinion);
    }
  }

  const after = ports.cancelled?.() ? { context: '', failure: null } : await runHooks(ports, 'afterRun', automation.hooks?.afterRun, {
    ...hookEnv('afterRun'),
    KAI_RUN_STATUS: result.status,
    KAI_FILES_CHANGED: String(changed.size),
  });
  if (after.failure) await ports.note(`An afterRun hook failed. ${after.failure}`);

  const conversation = await ports.conversation();
  return {
    result: conversation ? { ...result, conversation } : result,
    fixRounds,
    checkPassed,
    filesChanged: changed.size,
  };
}

async function stoppedOutcome(ports: AutomationPorts): Promise<AutomationOutcome> {
  const conversation = await ports.conversation();
  if (!conversation) throw new Error('Conversation not found.');
  return {
    result: { conversation, status: 'failed', output: '', error: 'Run cancelled.' },
    fixRounds: 0,
    checkPassed: null,
    filesChanged: 0,
  };
}

export function buildFixPrompt(command: string, outcome: ShellResult, round: number, maxRounds: number): string {
  return [
    `Automatic check ${round} of ${maxRounds}: KAI ran \`${command}\` after your changes and it failed (${describeExit(outcome)}).`,
    'Fix what is failing. Change only what the failures require, do not weaken or delete tests to make them pass, and stop once the command would succeed.',
    '',
    'End of the command output:',
    '```',
    outcome.output.slice(-FIX_OUTPUT_TAIL).trim() || '(no output)',
    '```',
  ].join('\n');
}

function describeExit(outcome: ShellResult): string {
  return outcome.exitCode === null ? 'it could not finish' : `exit code ${outcome.exitCode}`;
}

async function collectChangedFiles(ports: AutomationPorts, into: Set<string>): Promise<void> {
  const conversation = await ports.conversation();
  const lastUser = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === 'user');
  for (const change of lastUser?.fileChanges ?? []) into.add(change.path);
}

async function countChangedFiles(ports: AutomationPorts, into: Set<string>): Promise<number> {
  await collectChangedFiles(ports, into);
  return into.size;
}

interface HookOutcome {
  /** Anything the hooks printed, ready to hand to the agent. */
  context: string;
  failure: string | null;
}

/** One tool call as the hooks see it. Tool hooks only run on KAI's own API runs, which own the tool call. */
export interface ToolHookCall {
  event: 'preTool' | 'postTool';
  tool: string;
  input: unknown;
  output?: unknown;
  autonomy: string;
  projectRoot: string;
  conversationId: string;
  signal?: AbortSignal;
}

export interface ToolHookResult {
  /** Set when a preTool hook refused the call. */
  blocked: string | null;
  /** stdout from the hooks, appended to the tool result the model sees. */
  context: string;
  /** A postTool hook may replace the tool output with `{ "output": ... }`. */
  output?: unknown;
}

export type ToolHookRunner = (call: ToolHookCall) => Promise<ToolHookResult>;

/**
 * Runs the matching preTool/postTool hooks for one call. A failing preTool blocks the call; a failing postTool is
 * reported but does not undo work that already happened. Output is capped with the same tail limit as run hooks.
 */
export async function runToolHooks(
  hooks: ProjectAutomation['hooks'] | undefined,
  call: ToolHookCall,
  runShell: (command: string, timeoutMs: number, env: Record<string, string>) => Promise<ShellResult>,
): Promise<ToolHookResult> {
  const matching = (hooks?.[call.event] ?? []).filter((hook) => !hook.tool || globMatches(hook.tool, call.tool));
  if (matching.length === 0) return { blocked: null, context: '' };

  const environment: Record<string, string> = {
    KAI_EVENT: call.event,
    KAI_TOOL_NAME: call.tool,
    KAI_TOOL_INPUT: jsonTail(call.input),
    KAI_AUTONOMY: call.autonomy,
    KAI_PROJECT_ROOT: call.projectRoot,
    KAI_CONVERSATION_ID: call.conversationId,
  };
  if (call.event === 'postTool') environment.KAI_TOOL_OUTPUT = jsonTail(call.output);

  const printed: string[] = [];
  let replacement: unknown;

  for (const hook of matching) {
    const outcome = await runShell(hook.command, (hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_MS / 1_000) * 1_000, environment);
    const tail = outcome.output.slice(-HOOK_OUTPUT_TAIL).trim();
    const parsed = parseJsonObject(tail);

    if (call.event === 'preTool' && parsed?.decision === 'deny') {
      return { blocked: typeof parsed.reason === 'string' ? parsed.reason : `The preTool hook \`${hook.command}\` refused ${call.tool}.`, context: '' };
    }
    if (outcome.exitCode !== 0) {
      const reason = `\`${hook.command}\` ${describeExit(outcome)}.${tail ? `\n\n${tail}` : ''}`;
      if (call.event === 'preTool') return { blocked: reason, context: '' };
      printed.push(`[The project's postTool hook failed: ${reason}]`);
      continue;
    }
    if (!tail) continue;
    if (call.event === 'postTool' && parsed && 'output' in parsed) replacement = parsed.output;
    printed.push(call.event === 'postTool' && parsed && typeof parsed.context === 'string' ? parsed.context : tail);
  }

  return { blocked: null, context: printed.join('\n\n'), output: replacement };
}

function jsonTail(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 8_000);
  } catch {
    return '';
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function runHooks(
  ports: AutomationPorts,
  event: string,
  hooks: readonly ProjectHook[] | undefined,
  env: Record<string, string>,
): Promise<HookOutcome> {
  const printed: string[] = [];
  for (const hook of hooks ?? []) {
    const outcome = await ports.runShell(hook.command, (hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_MS / 1_000) * 1_000, env);
    const tail = outcome.output.slice(-HOOK_OUTPUT_TAIL).trim();
    if (outcome.exitCode !== 0) {
      return { context: '', failure: `\`${hook.command}\` ${describeExit(outcome)}.${tail ? `\n\n${tail}` : ''}` };
    }
    if (tail && event === 'beforeRun') printed.push(`[Output of the project's ${event} hook \`${hook.command}\`]\n${tail}`);
  }
  return { context: printed.join('\n\n'), failure: null };
}
