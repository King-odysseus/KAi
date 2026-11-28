import { isLeadRun, toolsForLead, leadToolAllowed } from './lead-run-policy';
import { LEAD_FINAL_ANSWER, leadToolProgress, leadToolRoundLimit } from './lead-tool-progress';
import { randomUUID } from 'node:crypto';
import { trimAnthropicToolResults, trimChatToolResults, trimGeminiToolResults } from './context-trimming';
import { withBrainTools, type BrainAccess } from './brain-tools';
import { withHistoryTools, type HistoryAccess } from './history-tools';
import { compactThresholdFor, modelContextFor, directProviderPreset, helperLimitOf, isLocalProvider, LOCAL_PROVIDER_PLACEHOLDER_KEY, openPlanReminder, pickLocalModel, planIsUnfinished, modelHostOf, type ApiConnection, type ModelHost, type ProviderId } from '@kai/contracts';
import { localServerHint, resolveApiConnection, withGatewayProfile } from './api-connection';
import { resolveGatewayAddress } from './gateway-address';
import { fetchWithHeaderTimeout, modelFetch, ModelHostError, type ModelTiming, type ModelWaitStatus } from './model-transport';
import { capToolOutput, toolOutputLimit } from './tool-output-cap';
import type {
  AppSettings,
  AgentRunRequest,
  AutonomyMode,
  DirectApiCapability,
  PermissionKey,
  PermissionRule,
  PersistedEvent,
} from '@kai/contracts';
import type { AgentExecutionResult } from './agent-runtime';
import { notifyRepeatDetected, withRepeatNotice } from './repeat-watch';
import { readPlan } from './plan-store';
import { hasStepFile, stepFilePath } from './step-file';
import { interjectionImages, steeringInstructionFor, takeInterjectionMessage } from './interjections';
import {
  toolOutputImages,
  toolOutputImageDataUrls,
  withoutImageData,
  anthropicImagePart,
  attachedImages,
  geminiImagePart,
  hasImageParts,
  isImageRefusal,
  openAiImagePart,
  responsesImagePart,
  withoutImageParts,
  type AttachedImage,
} from './image-attachments';
import { probeLocalServer, type LocalServerProbe } from './local-provider';
import { generatedImageFromOutputItem, supportsImageGenerationTool } from './generated-images';
import {
  askUserInputSchema,
  describeArgumentError,
  DesktopProjectToolRuntime,
  exploreInputSchema,
  taskInputSchema,
  projectToolDefinitions,
  type ExternalToolPort,
  isPublishingCommand,
  type ProjectToolExecution,
} from './project-tools';
import { cacheSavingsUsd, estimateCostUsd } from './usage-budget';
import { WebToolRuntime } from './web-tools';
import { applyPermissionRules } from './permission-rules';
import { deferExternalTools } from './deferred-tools';
import type { ToolHookRunner } from './automation';
import { RateLimitError, RequestPacer } from './rate-limit';
import { DEFAULT_MAX_RUN_COST_USD, maxRunCostFromEnvironment, REPEAT_STOP_MESSAGE, REPEAT_WARNING, type RunGuard } from './run-guard';
import { createParallelSession, isParallelCopy } from './parallel-session';
import { runCheckCommand, suggestTestCommand } from './verification';
import { describeOutcome, runWritingHelpers, type WritingBatchResult, type WritingTask } from './writing-helpers';

/** KAI's terminal tools, by the names an MCP tool is given here. */
const TERMINAL_TOOL = /^mcp_kai[-_]terminal_/;

/** The same outside tools without KAI's terminal: not offered, and refused if a model asks for one anyway. */
export function withoutTerminalTools(port: ExternalToolPort): ExternalToolPort {
  const refusal = 'KAI\'s terminal is not available while you work in a copy of the project: it runs in the project\'s own folder. Use run_command, which runs in your copy.';
  return {
    definitions: async () => (await port.definitions()).filter((definition) => !TERMINAL_TOOL.test(String((definition as { name?: unknown }).name ?? ''))),
    policy: (name, autonomy) => (TERMINAL_TOOL.test(name) ? { decision: 'deny', reason: refusal } : port.policy(name, autonomy)),
    execute: (name, input, signal) => (TERMINAL_TOOL.test(name) ? Promise.resolve<ProjectToolExecution>({ ok: false, output: { error: refusal } }) : port.execute(name, input, signal)),
  };
}

/** What a helper run gives back to the model that started it. */
type TaskResult = { answer: string; costUsd: number; provider?: string; model?: string };

/**
 * Starts one helper. `write` lets it edit files. `writeBatch` is present on a run that may start helpers: it runs a round
 * of writing helpers in separate copies of the project and merges them. A nested helper has neither, so it cannot
 * start helpers of its own.
 */
type TaskRun = ((prompt: string, model: string | undefined, options?: { write?: boolean }) => Promise<TaskResult>) & {
  writeBatch?: (tasks: WritingTask[], signal: AbortSignal, limit?: number) => Promise<WritingBatchResult>;
};

/** What a writing helper is told before its task: where it works, what it may touch, and what to report. */
const WRITING_HELPER_BRIEF = [
  'You are a helper agent started by another agent to do one part of a larger job, and you write code.',
  '- You work in your own copy of the project. Your changes are checked and merged back for you afterwards.',
  '- Edit only the files your task needs. Other helpers are working on other parts at the same time, so do not touch files that belong to someone else\'s part.',
  '- You can run project commands in your own copy when the run gives you the `run_command` tool. Do not ask the person to run commands for you; report a blocker if the tool is unavailable or a command is refused.',
  '- Finish the task completely, then answer with a short summary: the files you created or changed, and anything the caller still has to do.',
].join('\n');

/** Access levels at which a helper may edit without anyone being asked: a helper has nobody to ask. */
const WRITING_HELPER_AUTONOMY: ReadonlySet<AutonomyMode> = new Set<AutonomyMode>(['autoEdit', 'full']);
/** A writing helper reads, searches and edits. It runs no commands, deletes nothing and never asks or delegates. */
const SUBAGENT_WRITER_TOOLS: ReadonlySet<string> = new Set([
  'view_image',
  'read_file',
  'outline_file',
  'search_files',
  'list_files',
  'diagnostics',
  'web_search',
  'web_fetch',
  'replace_in_file',
  'create_file',
  'multi_edit',
  'write_file',
  'move_file',
]);
/** Full-access writing helpers run checks in their own copy; lower-access helpers keep commands behind parent review. */
const SUBAGENT_FULL_WRITER_TOOLS: ReadonlySet<string> = new Set([...SUBAGENT_WRITER_TOOLS, 'run_command']);

/** What the provider's prompt cache did for a run, for the usage line. Nothing when it served nothing from cache. */
function cacheFields(provider: string, model: string, inputTokens: number | undefined, cachedInputTokens: number | undefined, host?: ModelHost): { cachedInputTokens?: number; cacheSavedUsd?: number } {
  if (!cachedInputTokens || cachedInputTokens <= 0) return {};
  const saved = isLocalProvider(provider as ProviderId) || (host && host !== 'cloud') || !model ? null : cacheSavingsUsd(model, inputTokens ?? 0, cachedInputTokens);
  return { cachedInputTokens, ...(saved ? { cacheSavedUsd: saved } : {}) };
}

function costFields(
  provider: string,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cachedInputTokens?: number,
  host?: ModelHost,
): { provider: string; model?: string; amountUsd?: number } {
  // A model on the user's own machine costs nothing, whatever its name looks like: without this a local
  // "gpt-oss" would be priced as a paid GPT and count against the budget.
  // The same holds for a gateway the person has said is their own hardware.
  const free = isLocalProvider(provider as ProviderId) || host === 'own-hardware';
  const amountUsd = free ? 0 : model ? estimateCostUsd(model, inputTokens, outputTokens, cachedInputTokens) : null;
  return {
    provider,
    ...(model ? { model } : {}),
    ...(amountUsd === null ? {} : { amountUsd }),
  };
}

export interface DirectApiHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text, or the parts a message with an image in it is made of. */
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
/**
 * The tool-round ceiling for every provider. A real task is nowhere near this; a run that reaches it is either enormous
 * or stuck, and the cost cap and repeat detection stop a stuck one long before. It is deliberately not a small round
 * number: a limit of a hundred cut productive runs off mid-task, which is not something the CLIs do.
 */
const MAX_TOTAL_TOOL_ROUNDS = 1_000;
/** A helper's own loop is bounded much tighter than the main run's: it answers one question, not a whole task. */
const EXPLORE_MAX_ROUNDS = 6;
const EXPLORE_OUTPUT_TOKEN_BUDGET = 4_096;
/** A nested helper may read and search, but never writes, runs commands, asks questions or starts another helper. */
const SUBAGENT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'view_image',
  'read_file',
  'outline_file',
  'search_files',
  'list_files',
  'diagnostics',
  'web_search',
  'web_fetch',
]);
/** Provider iterations allowed beyond the tool rounds, for nudges and truncated continuations. */
const PROVIDER_ROUND_HEADROOM = 40;
const DEEPSEEK_MAX_TOOL_ROUNDS = 7;
/**
 * DeepSeek's chat endpoint refuses more than DEEPSEEK_MAX_TOOL_ROUNDS tool rounds in one request. Rather than cutting the
 * task short and telling the user to finish it, a run continues in a fresh request whose history folds the earlier tool
 * activity into a short summary. These bound the whole run: the cost cap and repeat detection still apply on top.
 */
const DEEPSEEK_MAX_TOTAL_TOOL_ROUNDS = 300;
const CONTINUATION_ENTRY_LIMIT = 40;
const CONTINUATION_TEXT_LIMIT = 200;
/**
 * Said at the ceiling instead of failing the run, so the work done is reported rather than thrown away with an error.
 * The user sees what was finished and what is left, which is what they would ask for anyway.
 */
const WRAP_UP_MESSAGE = 'You have made many tool calls for this task. Stop calling tools now and give a clear final answer: summarize what you have done so far, call out anything left unfinished, and say how to continue if needed.';

/**
 * Keep pending tool outputs when a user adds guidance between Responses API rounds. Images the person attached ride
 * beside the words as `input_image` parts, in the same user message.
 */
export function appendUserInput(input: unknown, message: string, images: readonly AttachedImage[] = []): unknown {
  const content = (text: string): string | Array<Record<string, unknown>> => (
    images.length === 0 ? text : [{ type: 'input_text', text }, ...images.map(responsesImagePart)]
  );
  if (Array.isArray(input)) return [...input, { role: 'user', content: content(message) }];
  if (typeof input === 'string') {
    return images.length === 0
      ? `${input}\n\nUser update: ${message}`
      : [{ role: 'user', content: content(`${input}\n\nUser update: ${message}`) }];
  }
  return [{ role: 'user', content: content(message) }];
}

/** A user message's content: plain text, or the text followed by the images when there are any. */
function textWithImages(
  text: string,
  images: readonly AttachedImage[],
  part: (image: AttachedImage) => Record<string, unknown>,
): string | Array<Record<string, unknown>> {
  return images.length === 0 ? text : [{ type: 'text', text }, ...images.map(part)];
}

/** Said to the model when a provider would not take an image, so it tells the person instead of searching for the file. */
const IMAGE_REMOVED_NOTE = '[KAI removed the attached image from this request because the model could not accept it. You cannot see it. Say so plainly and ask the person to switch to a model that accepts images; do not search the file system for it.]';

/** The size the model reported for its latest request, with no cost or totals, so nothing is counted twice. */
function contextSizeEvent(request: AgentRunRequest, contextTokens: number, fixedTokens: number): PersistedEvent {
  const total = Math.max(0, Math.round(contextTokens));
  return { schemaVersion: 1, id: eventId(), taskId: request.conversationId, timestamp: nowIso(), agent: request.agent, type: 'cost.update', contextTokens: total, fixedTokens: Math.min(total, Math.max(0, Math.round(fixedTokens))) };
}

/** The size of what is sent with every request whatever the conversation holds: the tool list, as the provider receives it. */
function toolListTokens(...lists: ReadonlyArray<readonly unknown[]>): number {
  return Math.ceil(JSON.stringify(lists.flat()).length / 4);
}

function noticeEvent(request: AgentRunRequest, message: string): PersistedEvent {
  return { schemaVersion: 1, id: eventId(), taskId: request.conversationId, timestamp: nowIso(), agent: request.agent, type: 'notice', message };
}
const MAX_APPROVAL_DETAIL = 4_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

// DeepSeek is the one Chat Completions provider whose tool round cap (8) sits far below the others.
// OpenRouter and openai-compatible routes can still point at a DeepSeek model, so match on the id too.
function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Whether a tool result reads as a failure: an error field, or a command that exited non-zero. */
function toolResultFailed(content: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(content ?? '') as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return false;
    if (typeof parsed.error === 'string' && parsed.error) return true;
    return typeof parsed.exitCode === 'number' && parsed.exitCode !== 0;
  } catch {
    return false;
  }
}

/**
 * The tool activity of a run so far, as a short plain-text list. It replaces the raw tool calls and results in the
 * history when a run continues in a fresh request, so the model keeps what it learned without the request growing.
 */
/**
 * The text of a message's content, whether it is plain text or the parts a message with an image is made of. Tool
 * results and replies are always the former; this is here so the two can share one type.
 */
function textOfContent(content: string | Array<Record<string, unknown>> | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Rough size of a chat history in tokens (4 characters each): text and tool calls only, never the bytes of an image. */
export function estimateChatTokens(messages: readonly ChatMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    characters += textOfContent(message.content).length;
    for (const call of message.tool_calls ?? []) characters += call.function.name.length + call.function.arguments.length;
  }
  return Math.ceil(characters / 4);
}

/**
 * Whether the part of a run since the last fold should be folded into a summary now: the whole history has reached the
 * size the person chose, and this block is a real share of it (so a long starting history that cannot shrink does not
 * make every round fold on its own). Zero turns it off.
 */
export function shouldCompactRun(messages: readonly ChatMessage[], segmentStart: number, compactAt: number, reportedTokens = 0, fixedTokens = 0): boolean {
  if (compactAt <= 0 || messages.length - segmentStart < 2) return false;
  // What can be folded is the conversation and the run's own activity, not the instructions and the tool list that go
  // with every request: counting those made a small limit unreachable, so a local model never folded or always did.
  // The size the model itself reported for its last request beats our estimate, which cannot see everything it was sent.
  const history = Math.max(estimateChatTokens(messages) - estimateChatTokens(messages.filter((message) => message.role === 'system')), reportedTokens - fixedTokens);
  return history >= compactAt && foldCanHelp(estimateChatTokens(messages.slice(segmentStart)), history, compactAt);
}

/**
 * Whether folding the run's own activity would make a real difference. It folds only the part since the last fold, so
 * when most of what is held is the starting prompt or a summary already made, folding gives nothing back and the run
 * only loses its working state: it re-reads what it had read, reaches the size again, folds again, and never finishes.
 * The block has to be a good share of the history, and big enough to be worth the loss.
 */
export function foldCanHelp(segmentTokens: number, historyTokens: number, compactAt: number): boolean {
  return segmentTokens >= Math.max(2_000, compactAt / 2) && segmentTokens >= historyTokens * 0.4;
}

/** Rough size of an Anthropic-shaped history in tokens: text, tool calls and tool results, never the bytes of an image. */
export function estimateAnthropicTokens(messages: readonly AnthropicMessage[]): number {
  let characters = 0;
  for (const message of messages) characters += anthropicBlocksText(message.content).length;
  return Math.ceil(characters / 4);
}

function anthropicBlocksText(content: AnthropicMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'tool_use') return `${String(block.name ?? '')}${JSON.stringify(block.input ?? {})}`;
      if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : anthropicBlocksText(Array.isArray(block.content) ? block.content as Array<Record<string, unknown>> : []);
      return '';
    })
    .join('\n');
}

/** The same decision as `shouldCompactRun`, for an Anthropic-shaped history. */
export function shouldCompactAnthropicRun(messages: readonly AnthropicMessage[], segmentStart: number, compactAt: number, reportedTokens = 0, fixedTokens = 0): boolean {
  if (compactAt <= 0 || messages.length - segmentStart < 2) return false;
  const history = Math.max(estimateAnthropicTokens(messages), reportedTokens - fixedTokens);
  return history >= compactAt && foldCanHelp(estimateAnthropicTokens(messages.slice(segmentStart)), history, compactAt);
}

/** The tool activity of an Anthropic-shaped run so far, as the same short plain-text list the chat shape uses. */
export function compactAnthropicToolHistory(tail: readonly AnthropicMessage[]): string {
  const results = new Map<string, string>();
  for (const message of tail) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, typeof block.content === 'string' ? block.content : anthropicBlocksText(Array.isArray(block.content) ? block.content as Array<Record<string, unknown>> : []));
      }
    }
  }
  const entries: string[] = [];
  let lastCommand: { name: string; args: string; output: string } | null = null;
  // Only the last thing the model said is kept; see compactChatToolHistory.
  const spoken = (message: AnthropicMessage): boolean => message.role === 'assistant' && anthropicBlocksText(message.content).trim().length > 0 && (typeof message.content === 'string' || message.content.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0));
  const lastSaid = tail.map((message, index) => (spoken(message) ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
  for (const [index, message] of tail.entries()) {
    if (message.role !== 'assistant') continue;
    const blocks: Array<Record<string, unknown>> = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() && index === lastSaid) entries.push(`You said: ${clip(block.text, CONTINUATION_TEXT_LIMIT)}`);
      if (block.type !== 'tool_use') continue;
      const result = results.get(String(block.id));
      const status = result === undefined ? 'no result' : (toolResultFailed(result) ? 'failed' : 'ok');
      entries.push(`${String(block.name ?? 'unknown')} ${clip(JSON.stringify(block.input ?? {}), CONTINUATION_TEXT_LIMIT)} -> ${status}${result ? `: ${clip(result, CONTINUATION_TEXT_LIMIT)}` : ''}`);
      if (COMMAND_TOOL.test(String(block.name ?? '')) && result !== undefined) lastCommand = { name: String(block.name), args: JSON.stringify(block.input ?? {}), output: result };
    }
  }
  const shown = entries.slice(-CONTINUATION_ENTRY_LIMIT);
  const omitted = entries.length - shown.length;
  return [
    'Progress so far on this task (your earlier tool calls, oldest first):',
    ...(omitted > 0 ? [`(${omitted} earlier steps not shown)`] : []),
    ...shown.map((entry, index) => `${omitted + index + 1}. ${entry}`),
  ].join('\n') + lastCommandNote(lastCommand);
}

/** Adds text as the next user turn, joining it to a user turn that is already last, as the Anthropic API wants roles to alternate. */
function pushUserText(messages: AnthropicMessage[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    last.content = typeof last.content === 'string' ? `${last.content}\n\n${text}` : [...last.content, { type: 'text', text }];
    return;
  }
  messages.push({ role: 'user', content: text });
}

/** A tool that runs a command or a check: its output is what the model would otherwise run again after a fold. */
const COMMAND_TOOL = /run_command|diagnostics|terminal_(?:run|read|write)/;
const LAST_OUTPUT_CHARS = 2_000;

/**
 * The last command the run made and the end of its output, kept whole across a fold. A summary clips every result, and
 * a model that lost the test failures it was fixing runs the tests again, every fold, to read them.
 */
function lastCommandNote(call: { name: string; args: string; output: string } | null): string {
  if (!call) return '';
  const output = call.output.length > LAST_OUTPUT_CHARS ? `…${call.output.slice(-LAST_OUTPUT_CHARS)}` : call.output;
  return `\n\nThe last command you ran (${call.name} ${clip(call.args, 300)}) and the end of its output, kept in full so you do not need to run it again:\n${output}`;
}

export function compactChatToolHistory(tail: readonly ChatMessage[]): string {
  const results = new Map<string, ChatMessage>();
  for (const message of tail) {
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  }
  const entries: string[] = [];
  let lastCommand: { name: string; args: string; output: string } | null = null;
  // Every "I will continue..." the model wrote would otherwise stay in the summary, and a model that reads a page of its
  // own announcements announces again. Only the last thing it said is kept; what it did is kept in full.
  const lastSaid = tail.map((message, index) => (message.role === 'assistant' && textOfContent(message.content).trim() ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
  for (const [index, message] of tail.entries()) {
    if (message.role !== 'assistant') continue;
    const said = textOfContent(message.content).trim();
    if (said && index === lastSaid) entries.push(`You said: ${clip(said, CONTINUATION_TEXT_LIMIT)}`);
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      const resultText = textOfContent(result?.content);
      const status = result ? (toolResultFailed(resultText) ? 'failed' : 'ok') : 'no result';
      entries.push(`${call.function.name} ${clip(call.function.arguments, CONTINUATION_TEXT_LIMIT)} -> ${status}${resultText ? `: ${clip(resultText, CONTINUATION_TEXT_LIMIT)}` : ''}`);
      if (COMMAND_TOOL.test(call.function.name) && result) lastCommand = { name: call.function.name, args: call.function.arguments, output: resultText };
    }
  }
  const shown = entries.slice(-CONTINUATION_ENTRY_LIMIT);
  const omitted = entries.length - shown.length;
  return [
    'Progress so far on this task (your earlier tool calls, oldest first):',
    ...(omitted > 0 ? [`(${omitted} earlier steps not shown)`] : []),
    ...shown.map((entry, index) => `${omitted + index + 1}. ${entry}`),
  ].join('\n') + lastCommandNote(lastCommand);
}

/**
 * A model that is about to act says so with its last word, so only the closing sentences are read: the last block of
 * the reply, and inside it the final two sentences. That keeps an announcement sitting at the top of a finished
 * report ("I'll summarise. …The build passed.") from counting as a promise. `let me know` is excluded because it is
 * a sign-off, not an intention — it ends far more replies than it announces.
 *
 * There is deliberately no length limit. The long replies are exactly the ones that promise work and then stop, and
 * skipping them entirely is how a run ends silently with the task half done.
 */
const ANNOUNCEMENT = /\b(let me (?!know\b)|i'll|i will|i'm going to|i am going to|now i(?:'ll| will)?|i now (?:have|know)|next,? i)\b/i;

/**
 * A reply that asks the person something is not a stall, and must not be answered with "the work is not done, do it
 * now". The model cannot go on until they reply, so nudging it produces exactly the wrong behaviour: it works around
 * the missing answer instead of waiting for it, and the question never gets asked properly.
 *
 * This is what a real run looked like: the model finished by saying "tell me the remote and I will push", which the
 * announcement pattern read as `i will` and treated as a promise. It was a question.
 */
const AWAITS_THE_USER = /\?|\b(tell me|let me know|which (?:remote|one|option|branch|account)|please (?:provide|confirm|tell|share)|where should|should i|do you want|would you like)\b/i;

/**
 * True when a reply that used no tools only says what the model is about to do ("Let me read the files"). Some models
 * end their turn there, which would end the run with the work not started.
 */
/**
 * The last two sentences of the reply's final block. A model that is about to act says so as its last word, and the
 * same place is where it asks for something it cannot get itself.
 */
export function closingSentences(text: string): string {
  const said = text.trim();
  const block = said.split(/\n{2,}/).at(-1) ?? said;
  return block.split(/(?<=[.!?])\s+/).slice(-2).join(' ');
}

/**
 * Whether the reply is asking the person for something. Exported because it decides more than one thing: it stops the
 * prose nudge, and it stops the plan from pushing the run on. A model waiting on an answer cannot be carried past it
 * by any means — doing so is what produced the behaviour that started all of this.
 */
export function awaitsTheUser(text: string): boolean {
  return AWAITS_THE_USER.test(closingSentences(text));
}

export function announcesUnfinishedWork(text: string): boolean {
  const said = text.trim();
  if (!said || said.endsWith('?')) return false;
  const closing = closingSentences(said);
  // Checked before the pattern, so a question wins over an "I will" in the same breath.
  if (AWAITS_THE_USER.test(closing)) return false;
  return ANNOUNCEMENT.test(closing);
}

const UNFINISHED_WORK_NUDGE = 'Your turn ended with no tool call, so the work is not done. Call the tools yourself now — do not restate the plan, do not describe what you are about to do, and do not ask for permission. If the task is genuinely complete, say what you changed and stop.';

/**
 * How many stalls in a row to nudge through before the run is interrupted. The budget resets on every real tool round,
 * so this bounds a model that keeps promising without acting, not the whole run. It is generous because a reasoning
 * model writing out a long plan can easily promise work several times before it acts; and when it is reached the
 * person is asked rather than the run being failed.
 */
const MAX_UNFINISHED_NUDGES = 20;

/** Explains a run that ended because the model kept describing work instead of doing it, rather than stopping silently. */
const UNFINISHED_STALL = 'The model kept describing what it would do instead of calling its tools, so the run ended with the task unfinished. Send "continue" to carry on, or switch to a model that uses tools more readily.';

/**
 * How many output tokens to ask for. A reasoning model spends this budget on its thinking before it writes a single
 * visible word, so a ceiling that is too low leaves the turn cut off with nothing to show and the run looks empty.
 * The smaller value is kept for endpoints that refuse the larger one, rather than dropping to the chat endpoint —
 * that is a different protocol and a far bigger change than the model actually needs.
 */
const OUTPUT_TOKEN_BUDGET = 32_768;
const OUTPUT_TOKEN_BUDGET_FALLBACK = 8_192;

/** How many cut-off turns in a row to resume, so a model that only ever reasons cannot loop forever. */
const MAX_TRUNCATED_CONTINUATIONS = 5;

/** Sent when a turn was cut off mid-thought, so the model carries on instead of the run ending with nothing. */
const TRUNCATED_TURN_CONTINUATION = 'Your previous turn reached the output limit before you wrote a reply or called a tool, so nothing was shown. Continue from where you left off and act now: call the tools you need instead of reasoning further.';

/** Names the real problem when a reasoning model thinks until the budget runs out and never writes a reply. */
const REASONING_ONLY = ' produced only reasoning and no reply: the model spent its whole output budget thinking. Raise the output limit for this model, or choose one that does not reason.';

/**
 * What to say next because the plan is unfinished, or null when there is nothing to say.
 *
 * This is the run's answer to "is it finished?", and it is looked up rather than inferred — which is the whole point
 * of the plan existing. The prose nudge below it stays as a fallback for runs with no plan at all; it is a guess about
 * the model's wording, and it has been wrong twice.
 *
 * Two things stop it carrying on, and both matter more than finishing the plan:
 * A reply that asks the person something is not a cue to proceed, however much the plan still lists. And the nudge
 * budget is shared, so a model that keeps stalling on an open item ends the run instead of looping.
 */
async function planContinuation(projectRoot: string, conversationId: string, roundText: string, nudges: number): Promise<string | null> {
  if (nudges >= MAX_UNFINISHED_NUDGES) return null;
  if (awaitsTheUser(roundText)) return null;
  const plan = await readPlan(projectRoot, conversationId).catch(() => null);
  if (!plan || !planIsUnfinished(plan)) return null;
  return openPlanReminder(plan);
}

/** A blank line to put before the first text of a round when earlier rounds already wrote some, so they do not run together. */
function roundBreak(outputParts: readonly string[]): string {
  const last = outputParts.at(-1);
  return last && !/\s$/.test(last) ? '\n\n' : '';
}

/** True when the endpoint turned the request down over the output-token ceiling rather than the request itself. */
export function outputBudgetRejected(error: string | undefined): boolean {
  return /max_tokens|max output|output token|maximum number of tokens|too large|too many tokens/i.test(error ?? '');
}

/** The model's open plan as a reminder, for after a fold: the plan is where its place in the task is kept. Empty when there is none. */
async function foldPlanNote(projectRoot: string, conversationId: string): Promise<string> {
  const plan = await readPlan(projectRoot, conversationId).catch(() => null);
  const planNote = plan && planIsUnfinished(plan) ? `\n\n${openPlanReminder(plan)}` : '';
  // A builder working through steps keeps its plan and its notes in the step file: point it there, since the summary is lossy.
  const stepNote = await hasStepFile(projectRoot, conversationId)
    ? `\n\nYour step plan and the notes from earlier steps are in ${stepFilePath(conversationId)}. Read it before you carry on.`
    : '';
  return planNote + stepNote;
}

function continuationMessage(summary: string, request: AgentRunRequest): string {
  if (isLeadRun(request)) return `${summary}\nContinue the read-only Lead discussion. Finish the explanation or Builder handoff; do not execute implementation steps or claim they passed.`;
  return `${summary}\n\nContinue the task from where you left off. Do not repeat steps that already succeeded. Run any remaining commands and edits yourself with your tools instead of listing them for the user, and give the final answer only when the task is done.`;
}

/** The Anthropic-style address of the official DeepSeek API, or undefined for any other provider or a custom address. */
export function deepSeekAnthropicBaseUrl(capability: Pick<DirectApiCapability, 'provider' | 'baseUrl'>): string | undefined {
  if (capability.provider !== 'deepseek') return undefined;
  try {
    const url = new URL(capability.baseUrl);
    if (url.hostname.toLowerCase() !== 'api.deepseek.com') return undefined;
    return 'https://api.deepseek.com/anthropic';
  } catch {
    return undefined;
  }
}

/** True when a failed request says the endpoint itself refused the call, rather than the key, quota or content. */
export function endpointRejected(error: string | undefined): boolean {
  return /Provider request failed \((400|404|405|415|422)\)/.test(error ?? '');
}

function isDeepSeekCapability(capability: DirectApiCapability): boolean {
  return capability.provider === 'deepseek' || capability.model.trim().toLowerCase().includes('deepseek');
}

interface ProviderStreamEvent {
  event: string;
  data: string;
}

export interface PendingToolCall {
  key: string;
  callId?: string;
  name?: string;
  argumentsText: string;
  /** Anthropic streams a call's arguments by the index of its content block, which counts text blocks too. */
  blockIndex?: number;
}

interface PendingChatToolCall extends PendingToolCall {
  index: number;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<Record<string, unknown>>;
}

/** The two named answers to a question about the run itself, for a dialog that must not offer allow and deny. */
export interface RunQuestion {
  continueLabel: string;
  finishLabel: string;
}

export interface DirectApiApprovalRequest {
  requestId: string;
  /** The tool being approved. Absent for a question about the run itself, such as one of its limits. */
  tool?: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  /** Set for a question about the run, so the prompt says what its answers do instead of what allow and deny do. */
  runQuestion?: RunQuestion;
  /** Set for a question the model asked via `ask_user`: the choices to show instead of allow/deny buttons. */
  options?: readonly string[];
  /** Whether a typed answer is also acceptable for an `options` question, not only one of the choices. */
  allowFreeText?: boolean;
}

export interface DirectApiApprovalPort {
  request(approval: DirectApiApprovalRequest): Promise<boolean>;
  /**
   * Puts a question with options to the person and returns the one they chose (or typed, when the question allows
   * free text), or null if they declined to answer or no one was there to ask. Optional because most callers of
   * this port never ask a question with options — only `ask_user` does — and a caller without this method is
   * treated the same as one nobody answered.
   */
  requestChoice?(approval: DirectApiApprovalRequest): Promise<string | null>;
}

export interface DirectApiProxyRoute {
  baseUrl: string;
  apiKey: string;
}

/** Where a run's model lives, worked out once per run. Absent means a cloud provider. */
interface ModelRoute {
  host?: ModelHost;
  statusRoot?: string;
  /** The characters one tool result may take. Absent for a cloud model, whose results are sent whole. */
  outputLimit?: number;
}

function hostOf(capability: DirectApiCapability): ModelHost | undefined {
  return (capability as DirectApiCapability & ModelRoute).host;
}

function waitMessage(capability: DirectApiCapability, status: ModelWaitStatus): string {
  if (status.state === 'running') return `${capability.model} has started on this request.`;
  if (status.state === 'queued') {
    const place = status.position !== undefined ? `queue position ${status.position}` : 'no reply yet';
    return `Waiting for your hardware: ${place}.${status.detail ? ` ${status.detail}` : ''}`;
  }
  return status.detail ?? 'Your hardware is busy. Waiting before trying again.';
}

interface DirectApiSettingsPort {
  load(): Promise<AppSettings>;
}

interface DirectApiCredentialPort {
  isAvailable(): boolean;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
}

export interface DirectProviderRuntimeOptions {
  maxProviderAttempts?: number;
  retryBaseDelayMs?: number;
  resolveProxyRoute?: (request: AgentRunRequest) => Promise<DirectApiProxyRoute>;
  waitIfPaused?: (conversationId: string, signal: AbortSignal) => Promise<void>;
  /** Asks a local server (LM Studio) which models it offers; replaced in tests. */
  probeLocalServer?: (baseUrl: string, apiKey?: string) => Promise<LocalServerProbe>;
  /** Chooses between the home and away addresses of the person's own gateway; replaced in tests. */
  resolveGatewayAddress?: typeof resolveGatewayAddress;
  /** Shortens the transport's waits in tests. */
  modelTiming?: Partial<ModelTiming>;
  /** Spaces requests out; Autopilot sets it so a long job stays under the provider's limit. Off by default. */
  pacer?: RequestPacer;
  /** Stop a run whose estimated cost passes this many USD. Zero disables it; defaults to KAI_MAX_RUN_COST_USD, then the Usage setting. */
  maxRunCostUsd?: number;
  /**
   * Tool rounds allowed in one run before it is asked to sum up. Defaults to MAX_TOTAL_TOOL_ROUNDS, which no real task
   * reaches; a test sets it low to exercise the wrap-up without driving a thousand rounds.
   */
  maxToolRounds?: number;
  /** User-owned allow/ask/deny rules for the project a run is about to work in. */
  loadPermissionRules?: (projectRoot: string) => Promise<readonly PermissionRule[]>;
  /** Runs the project's matching preTool/postTool hooks around a tool call. */
  runToolHook?: ToolHookRunner;
  /** False for a nested helper, so a subagent cannot start its own. */
  allowSubagents?: boolean;
  /** When set, a nested helper is offered only these built-in tools. */
  allowedToolNames?: ReadonlySet<string>;
}

export class DesktopDirectProviderRuntime {
  private readonly activeRuns = new Map<string, AbortController>();
  /** Set once DeepSeek's Anthropic-style endpoint refuses a call, so later runs go straight to the chat endpoint. */
  private deepSeekAnthropicRejected = false;
  private pacer: RequestPacer | undefined;

  constructor(
    private readonly settings: DirectApiSettingsPort,
    private readonly credentials: DirectApiCredentialPort,
    private readonly externalTools?: ExternalToolPort,
    private readonly options: DirectProviderRuntimeOptions = {},
  ) {
    this.pacer = options.pacer;
  }

  /** Spaces requests out before the provider has to ask, and tells the pacer how each one went. */
  private async pacedFetch(
    url: string,
    init: RequestInit & { signal: AbortSignal },
    capability: DirectApiCapability & ModelRoute,
    request: AgentRunRequest,
    apiKey: string,
    emit: (event: PersistedEvent) => void,
  ): Promise<Response> {
    const host = capability.host ?? 'cloud';
    const send = (): Promise<Response> => modelFetch(url, init, {
      host,
      apiKey,
      ...(capability.statusRoot ? { statusRoot: capability.statusRoot } : {}),
      ...(this.options.modelTiming ? { timing: this.options.modelTiming } : {}),
      onStatus: (status) => emit(lifecycleEvent(request, 'starting', waitMessage(capability, status))),
    });
    // The person's own hardware queues requests itself, and one can wait hours: it must not hold a pacing slot that a
    // cloud run is waiting for.
    const pacer = host === 'own-hardware' ? undefined : this.pacer;
    if (!pacer) return send();
    await pacer.acquire(init.signal);
    try {
      const response = await send();
      pacer.report(response.status);
      return response;
    } finally {
      pacer.release();
    }
  }

  /**
   * Where this run's model lives. For the person's own gateway that also settles which address is used, home or away,
   * and says so in the conversation.
   */
  private async routeModel(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
  ): Promise<{ capability: DirectApiCapability & ModelRoute; notice?: PersistedEvent }> {
    const settings = await this.settings.load();
    const connection = { provider: capability.provider, baseUrl: capability.baseUrl };
    const classified = modelHostOf(connection, settings);
    // A paid provider reached through an address on this computer is a relay to the cloud, not a model running here:
    // it keeps its cost, its limits and its full context.
    const host = classified === 'this-computer' && !isLocalProvider(capability.provider) ? 'cloud' : classified;
    if (host === 'cloud') return { capability: { ...capability, host } };
    const outputLimit = toolOutputLimit(modelContextFor(settings, capability.model));
    if (host !== 'own-hardware') return { capability: { ...capability, host, outputLimit } };
    const address = await (this.options.resolveGatewayAddress ?? resolveGatewayAddress)(connection, settings, apiKey);
    const where = address.label === 'home' ? 'at its home address' : address.label === 'away' ? 'through its away address' : 'at its configured address';
    return {
      capability: { ...capability, host, outputLimit, baseUrl: address.baseUrl, ...(address.statusRoot ? { statusRoot: address.statusRoot } : {}) },
      notice: lifecycleEvent(request, 'starting', `Using your own hardware ${where}: ${address.baseUrl}`),
    };
  }

  /** Autopilot turns pacing on for the length of a job and off again after. */
  setPacer(pacer: RequestPacer | undefined): void {
    this.pacer = pacer;
  }

  /**
   * Checks the run's spend, and asks before a limit the person set ends their run. Either answer lifts the limit for
   * the rest of this run, so the question is asked once rather than every round, and the wrap-up request - which also
   * costs money - is not blocked by the very limit that asked for it.
   */
  private async checkRunSpend(
    toolRuntime: DesktopProjectToolRuntime,
    capability: DirectApiCapability,
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    approvals: DirectApiApprovalPort | undefined,
    cachedInputTokens?: number,
  ): Promise<void> {
    if (inputTokens === undefined && outputTokens === undefined && toolRuntime.guard.externalCostUsd === 0) return;
    const limitUsd = toolRuntime.guard.maxCostLimitUsd;
    if (limitUsd <= 0) return;
    // Helper agents report their own spend, so the parent's limit covers the whole tree of work.
    const costUsd = (costFields(capability.provider, capability.model, inputTokens, outputTokens, cachedInputTokens, hostOf(capability)).amountUsd ?? 0)
      + toolRuntime.guard.externalCostUsd;
    if (costUsd < limitUsd) return;
    toolRuntime.guard.setMaxCost(0);
    const answer = await askToContinue(approvals, SPEND_QUESTION(costUsd, limitUsd));
    if (answer === 'wrap-up') toolRuntime.guard.requestWrapUp();
  }

  private async newToolRuntime(projectRoot: string, customPermissions: Partial<Record<PermissionKey, boolean>> | undefined, conversationId: string, requestRules?: AgentRunRequest['permissionRules'], requestMaxCost?: number): Promise<DesktopProjectToolRuntime> {
    const loaded = await this.settings.load().catch(() => undefined);
    const web = loaded
      ? new WebToolRuntime({
        settings: loaded.webSearch,
        directApi: {
          provider: loaded.directApi.provider,
          credentialId: loaded.directApi.credentialId,
          baseUrl: loaded.directApi.baseUrl,
        },
      }, this.credentials)
      : undefined;
    const runtime = new DesktopProjectToolRuntime(projectRoot, customPermissions, web);
    runtime.conversationId = conversationId;
    const permissionRules = this.options.loadPermissionRules
      ? await this.options.loadPermissionRules(projectRoot).catch(() => [])
      : [];
    runtime.setPolicy({ permissionRules: [...permissionRules, ...(requestRules ?? [])], toolHook: this.options.runToolHook });
    runtime.toolFilter = this.options.allowedToolNames;
    // The environment variable wins so a script can loosen or tighten the limit without touching settings.
    const fromSettings = loaded?.usageBudget.perRunUsd;
    const configured = this.options.maxRunCostUsd ?? maxRunCostFromEnvironment() ?? fromSettings ?? DEFAULT_MAX_RUN_COST_USD;
    runtime.guard.setMaxCost(requestMaxCost ? Math.min(requestMaxCost, configured && configured > 0 ? configured : Infinity) : configured);
    return runtime;
  }

  /**
   * A read-only helper the main run can hand a question off to: it reads and searches on its own and reports back
   * a short answer, so the question's intermediate reads never land in the parent run's own context — only the
   * answer does.
   *
   * Written against the Anthropic Messages protocol (and DeepSeek's Anthropic-shaped endpoint, which already
   * takes the same request body) because that is the one existing request/parse path this reuses rather than
   * duplicates. A provider on a different protocol gets a clear message instead of a fabricated answer; the
   * person can still read the files themselves, which is no worse than before this tool existed.
   */
  private async runExploreQuery(
    question: string,
    projectRoot: string,
    capability: DirectApiCapability,
    apiKey: string,
    signal: AbortSignal,
    contextText?: string,
  ): Promise<string> {
    const preset = directProviderPreset(capability.provider);
    const anthropicBase = preset.protocol === 'anthropic-messages'
      ? capability.baseUrl
      : preset.protocol === 'chat-completions' ? deepSeekAnthropicBaseUrl(capability) : undefined;
    if (!anthropicBase) {
      return 'Explore could not run: this provider is not reachable through an Anthropic-shaped endpoint in this build. Read the files yourself instead.';
    }
    const exploreCapability: DirectApiCapability = { ...capability, baseUrl: anthropicBase };
    // A plain instance, not `newToolRuntime`: explore reads only, so it needs no spend guard of its own — its
    // tokens are folded into the parent run's totals by the caller, which is where the parent's guard already is.
    const toolRuntime = new DesktopProjectToolRuntime(projectRoot);
    const readOnlyTools = projectToolDefinitions.filter(
      (definition) => definition.name === 'view_image' || definition.name === 'read_file' || definition.name === 'outline_file' || definition.name === 'search_files' || definition.name === 'list_files',
    );
    const messages: AnthropicMessage[] = [{
      role: 'user',
      // The standing rules ride in the parent's context, so a helper is held to them like the run that started it.
      content: `${contextText?.trim() ? `${contextText.trim()}\n\n` : ''}Answer this question about the project by reading and searching files as needed. Give a short, direct answer. Do not propose or make any edits.\n\nQuestion: ${question}`,
    }];
    const noop = (): void => {};
    const fakeRequest = { conversationId: 'explore', prompt: question, agent: 'codex' as const, route: 'direct' as const, autonomy: 'plan' as const } as AgentRunRequest;
    let answer = '';
    for (let round = 0; round < EXPLORE_MAX_ROUNDS; round += 1) {
      const pendingToolCalls = new Map<string, PendingToolCall>();
      let roundText = '';
      const response = await this.requestAnthropicResponse(
        fakeRequest,
        exploreCapability,
        apiKey,
        messages,
        undefined,
        [],
        signal,
        noop,
        EXPLORE_OUTPUT_TOKEN_BUDGET,
        true,
        readOnlyTools,
      );
      if (!response.body) return 'Explore could not run: the provider returned no response.';
      for await (const streamEvent of readSseEvents(response.body, streamIdleTimeout(capability))) {
        let value: Record<string, unknown>;
        try {
          value = asRecord(JSON.parse(streamEvent.data)) ?? {};
        } catch {
          continue;
        }
        const type = streamEvent.event || stringValue(value.type) || '';
        if (type === 'content_block_start') {
          const block = asRecord(value.content_block);
          if (block?.type === 'tool_use') rememberAnthropicToolCall(pendingToolCalls, block, integerValue(value.index));
          const initialText = block?.type === 'text' ? stringValue(block.text) : undefined;
          if (initialText) roundText += initialText;
          continue;
        }
        if (type === 'content_block_delta') {
          const delta = asRecord(value.delta);
          if (delta?.type === 'text_delta') {
            const text = stringValue(delta.text);
            if (text) roundText += text;
          } else if (delta?.type === 'input_json_delta') {
            rememberAnthropicToolArguments(pendingToolCalls, value, stringValue(delta.partial_json));
          }
          continue;
        }
      }
      const toolCalls = [...pendingToolCalls.values()].filter((call) => call.name);
      if (toolCalls.length === 0) {
        answer = roundText.trim();
        break;
      }
      for (const call of toolCalls) call.callId ||= `toolu_${randomUUID()}`;
      const assistantContent: Array<Record<string, unknown>> = [];
      if (roundText) assistantContent.push({ type: 'text', text: roundText });
      assistantContent.push(...toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.callId,
        name: call.name,
        input: safeToolArguments(call.argumentsText),
      })));
      messages.push({ role: 'assistant', content: assistantContent });
      const toolResults: unknown[] = [];
      for (const call of toolCalls) {
        const callId = call.callId!;
        let argumentsValue: unknown;
        try {
          argumentsValue = parseToolArguments(call.argumentsText);
        } catch (error) {
          toolResults.push(anthropicToolOutput(callId, { error: error instanceof Error ? error.message : String(error) }));
          continue;
        }
        const execution = await toolRuntime.execute(call.name || 'unknown', argumentsValue, signal);
        toolResults.push(anthropicToolOutput(callId, execution?.output ?? { error: 'No output.' }));
      }
      messages.push({ role: 'user', content: toolResults as Array<Record<string, unknown>> });
      if (round === EXPLORE_MAX_ROUNDS - 1) answer = roundText.trim();
    }
    return answer || 'The helper made no finding to report.';
  }

  /**
   * The callback a run gives to the `task` tool. A nested helper gets a second runtime with the same settings but a
   * read-only tool list and no `task` of its own, so it cannot recurse or widen its access. Only its answer and the
   * cost of its calls come back; its intermediate reads stay in its own context.
   */
  /**
   * The outside tools a run is offered. A run working in a copy of the project (a card or a writing helper beside
   * others) does not get KAI's terminal: its sessions open in the project's own folder, so agents in copies used it
   * to run builds and edit files in the project itself, under the other agents' feet and outside the merge.
   */
  private externalFor(projectRoot: string, request?: AgentRunRequest, smallModel = false): ExternalToolPort | undefined {
    // Lead reads with the bounded project tools; external tools can expose writes beyond the project.
    if (request?.permissionRules?.some((rule) => rule.id === 'lead-read-only')) return undefined;
    const reachable = this.externalTools && isParallelCopy(projectRoot) ? withoutTerminalTools(this.externalTools) : this.externalTools;
    // A local model is offered the outside (MCP) tools through tool_search, whatever their number. The brain and history
    // tools are added after this, so they stay in view.
    const base = smallModel ? deferExternalTools(reachable, true) : reachable;
    // A run reads its earlier turns when it needs them rather than being sent them all; a helper's own short-lived
    // conversation has none to read.
    const outside = this.history && request && !request.conversationId.startsWith('sub_') ? withHistoryTools(base, request.conversationId, this.history) : base;
    // The project brain is offered to every run that can reach it, in a copy of the project as well: what a helper
    // learns belongs to the project, not to the copy.
    return this.brain ? withBrainTools(outside, projectRoot, this.brain) : outside;
  }

  private brain: BrainAccess | undefined;
  private history: HistoryAccess | undefined;

  /** Lets runs read earlier turns of their conversation with `read_history`. Set once conversations exist. */
  setHistoryAccess(access: HistoryAccess | undefined): void {
    this.history = access;
  }

  /** Gives runs the project brain's two tools. Set once the brain's service exists; without it, runs have no such tools. */
  setBrainAccess(access: BrainAccess | undefined): void {
    this.brain = access;
  }

  /** Whether runs on this runtime are offered the brain tools, so a caller can say so in the context it builds. */
  hasBrainAccess(): boolean {
    return this.brain !== undefined;
  }

  private taskRunner(request: AgentRunRequest, projectRoot: string, contextText: string | undefined): TaskRun {
    if (this.options.allowSubagents === false) {
      return async (): Promise<TaskResult> => {
        throw new Error('A helper cannot start another helper.');
      };
    }
    const run: TaskRun = (prompt, model, options) => this.runTaskQuery(prompt, model, request, projectRoot, contextText, options?.write === true);
    // The project's check is found once per round, and run in each helper's copy before anything is merged.
    let command: Promise<string | null> | undefined;
    run.writeBatch = (tasks, signal, limit) => runWritingHelpers(tasks, {
      prepare: () => createParallelSession(projectRoot, `helpers-${randomUUID()}`),
      run: (prompt, model, folder) => this.runTaskQuery(prompt, model, request, folder ?? projectRoot, contextText, true),
      check: async (folder, checkSignal) => {
        command ??= suggestTestCommand(projectRoot).catch(() => null);
        const found = await command;
        if (!found) return null;
        const result = await runCheckCommand(folder, found, checkSignal);
        return { passed: result.exitCode === 0, output: result.output };
      },
    }, signal, limit);
    return run;
  }

  private async runTaskQuery(
    prompt: string,
    model: string | undefined,
    request: AgentRunRequest,
    projectRoot: string,
    contextText: string | undefined,
    write = false,
  ): Promise<TaskResult> {
    const nested = new DesktopDirectProviderRuntime(this.settings, this.credentials, this.externalTools, {
      ...this.options,
      allowSubagents: false,
      allowedToolNames: write
        ? request.autonomy === 'full' ? SUBAGENT_FULL_WRITER_TOOLS : SUBAGENT_WRITER_TOOLS
        : SUBAGENT_READ_ONLY_TOOLS,
    });
    // A helper reads and writes the same project memory its parent does.
    nested.setBrainAccess(this.brain);
    const childRequest: AgentRunRequest = {
      ...request,
      conversationId: `sub_${request.conversationId}_${randomUUID()}`,
      prompt: write ? `${WRITING_HELPER_BRIEF}\n\nYOUR TASK:\n${prompt}` : prompt,
      execution: 'api',
      route: request.route,
      autonomy: write ? request.autonomy === 'full' ? 'full' : 'autoEdit' : 'plan',
      ...(model ? { model } : {}),
    };
    const result = await nested.run(childRequest, projectRoot, undefined, undefined, undefined, contextText);
    if (result.status === 'failed' && !result.cancelled) {
      throw new Error(result.error ?? 'The helper could not finish.');
    }
    const costEvents = result.events.filter((event) => event.type === 'cost.update');
    const costUsd = costEvents.reduce((total, event) => total + (event.amountUsd ?? 0), 0);
    const lastCost = costEvents.at(-1);
    return {
      answer: result.output,
      costUsd,
      ...(lastCost?.provider ? { provider: lastCost.provider } : {}),
      ...(lastCost?.model ? { model: lastCost.model } : {}),
    };
  }

  /**
   * What the API can do right now. With `connection` it answers for that connection instead of the one in Settings —
   * a role in the Architect / Implementer split names its own provider, key and model. Choosing a connection for a
   * run is itself the instruction to use the API, so Settings' on/off switch does not veto it.
   */
  async capability(connection?: ApiConnection): Promise<DirectApiCapability> {
    const settings = await this.settings.load();
    const directApi = connection ? resolveApiConnection(settings.directApi, withGatewayProfile(settings, connection)) : settings.directApi;
    const preset = directProviderPreset(directApi.provider);
    const displayName = preset.displayName;
    const local = isLocalProvider(directApi.provider);
    const credentialStored = await this.credentials.has(directApi.credentialId).catch(() => false);
    const base = {
      enabled: directApi.enabled,
      provider: directApi.provider,
      displayName,
      model: directApi.model,
      baseUrl: directApi.baseUrl,
      credentialId: directApi.credentialId,
      credentialStored,
      supportsStreaming: true,
      supportsTools: preset.supportsTools,
    } satisfies Omit<DirectApiCapability, 'available'>;

    if (!directApi.enabled) {
      return { ...base, available: false, unavailableReason: 'Direct API mode is disabled in Settings.' };
    }
    // A role's own local connection with no model chosen takes one from the running server, the way Settings' refresh
    // does. Everything else must name a model: guessing one for a paid provider would spend money on a choice nobody made.
    const modelFromServer = Boolean(connection) && local && !directApi.model.trim();
    if (!directApi.model.trim() && !modelFromServer) {
      return { ...base, available: false, unavailableReason: 'Set a direct API model in Settings.' };
    }
    if (local) {
      // A local server needs no key, but it has to be running and have a model to offer.
      const key = credentialStored ? await this.credentials.get(directApi.credentialId).catch(() => undefined) : undefined;
      const probe = await (this.options.probeLocalServer ?? probeLocalServer)(directApi.baseUrl, key || undefined);
      if (!probe.reachable) {
        return {
          ...base,
          available: false,
          unavailableReason: `${displayName} is not reachable at ${directApi.baseUrl}. ${localServerHint(directApi.provider)}`,
        };
      }
      if (probe.models.length === 0 && /wants a key/.test(probe.detail ?? '')) {
        return { ...base, available: false, unavailableReason: `${displayName} at ${directApi.baseUrl} wants a key. Save one for this provider in Settings (${directApi.credentialId}).` };
      }
      if (probe.models.length === 0) {
        return {
          ...base,
          available: false,
          unavailableReason: `${displayName} is running but has no models. Download or load one (for example Qwen2.5 Coder) and try again.`,
        };
      }
      return { ...base, ...(modelFromServer ? { model: pickLocalModel(probe.models) } : {}), available: true };
    }
    if (!this.credentials.isAvailable()) {
      return {
        ...base,
        available: false,
        unavailableReason: 'OS credential encryption is unavailable. Direct API mode will not use a plaintext key.',
      };
    }
    if (!credentialStored) {
      return {
        ...base,
        available: false,
        unavailableReason: `Save the ${directApi.credentialId} credential in Settings.`,
      };
    }
    return { ...base, available: true };
  }

  async run(
    request: AgentRunRequest,
    projectRoot: string,
    resumeResponseId?: string,
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    // Says so, once, if the run starts repeating the same paragraph; never touches the run.
    onEvent = withRepeatNotice(onEvent, request);
    approvals = announceRunQuestions(approvals, request, onEvent);
    // Registered before any `await` below, not after — `cancel(conversationId)` only has something to abort once
    // this exists, and the awaits below (capability, credential, proxy-route lookups) used to run first, so a
    // cancel arriving during any of them found nothing registered and silently did nothing: the run went on to
    // start anyway. This is one of the ways "Stop" fails to stop a Direct API (Auto) turn. The same controller is
    // threaded into whichever protocol method ends up handling the run, instead of each one minting (and
    // re-registering) its own — a second controller would silently replace this one in `activeRuns` and lose any
    // abort already requested against the first.
    const controller = new AbortController();
    this.activeRuns.set(request.conversationId, controller);
    const bailEarly = (message: string): AgentExecutionResult => {
      this.activeRuns.delete(request.conversationId);
      return immediateFailure(request, message);
    };
    const checkCancelledEarly = (): AgentExecutionResult | null => {
      if (!controller.signal.aborted) return null;
      this.activeRuns.delete(request.conversationId);
      return cancelledEarly(request);
    };

    let capability = await this.capability(request.apiConnection);
    const cancelledDuringCapability = checkCancelledEarly();
    if (cancelledDuringCapability) return cancelledDuringCapability;
    // A model chosen in the composer applies to this run only. A role's own connection already carries its model.
    if (request.model && !request.apiConnection?.model) capability = { ...capability, model: request.model };
    let apiKey: string;
    let routeNotice: PersistedEvent | undefined;
    if (request.route === 'proxy') {
      const preset = directProviderPreset(capability.provider);
      if (!capability.enabled) {
        return bailEarly('Direct API mode is disabled in Settings.');
      }
      if (!capability.model.trim()) {
        return bailEarly('Set a direct API model in Settings before using the proxy route.');
      }
      if (!this.options.resolveProxyRoute) {
        return bailEarly('Universal Proxy routing is not available in this KAI build.');
      }
      try {
        const proxyRoute = await this.options.resolveProxyRoute(request);
        capability = { ...capability, baseUrl: proxyRoute.baseUrl };
        apiKey = proxyRoute.apiKey;
      } catch (error) {
        return bailEarly(`Universal Proxy route is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const cancelledDuringProxyLookup = checkCancelledEarly();
      if (cancelledDuringProxyLookup) return cancelledDuringProxyLookup;
    } else {
      if (!capability.available) {
        return bailEarly(capability.unavailableReason || 'Direct API mode is unavailable.');
      }
      const local = isLocalProvider(capability.provider);
      // A key is optional for a local server (LM Studio can be set to require one); use it when one is stored.
      let directApiKey: string | undefined;
      try {
        directApiKey = await this.credentials.get(capability.credentialId);
      } catch (error) {
        if (!local) throw error;
      }
      if (!directApiKey && !local) {
        return bailEarly(`Credential ${capability.credentialId} is not available.`);
      }
      apiKey = directApiKey ?? LOCAL_PROVIDER_PLACEHOLDER_KEY;
      const cancelledDuringCredentialLookup = checkCancelledEarly();
      if (cancelledDuringCredentialLookup) return cancelledDuringCredentialLookup;
      const routed = await this.routeModel(request, capability, apiKey);
      capability = routed.capability;
      routeNotice = routed.notice;
      if (routeNotice) onEvent?.(routeNotice);
      if (capability.model.trim().toLowerCase() === 'gateway/auto' && routed.capability.host === 'own-hardware') {
        return bailEarly('gateway/auto is not used on your own gateway, because it refuses a request that matches more than one kind of task. Choose gateway/coding, gateway/general, gateway/research or gateway/vision.');
      }
      const cancelledDuringRouting = checkCancelledEarly();
      if (cancelledDuringRouting) return cancelledDuringRouting;
    }

    const protocol = directProviderPreset(capability.provider).protocol;
    // DeepSeek's chat endpoint refuses more than a few tool rounds per request, which forces runs to be cut into blocks.
    // Its Anthropic-style endpoint has no such cap, so the official API is tried that way first.
    const anthropicBase = protocol === 'chat-completions' && request.route !== 'proxy' ? deepSeekAnthropicBaseUrl(capability) : undefined;
    if (anthropicBase && !this.deepSeekAnthropicRejected) {
      let toolsUsed = false;
      const watch = (event: PersistedEvent): void => {
        if (event.type !== 'agent.lifecycle' && event.type !== 'text.delta') toolsUsed = true;
        onEvent?.(event);
      };
      const attempt = await this.runAnthropicMessages(
        request,
        projectRoot,
        { ...capability, baseUrl: anthropicBase },
        apiKey,
        controller,
        watch,
        approvals,
        contextText,
        history,
        customPermissions,
      );
      if (!(attempt.status === 'failed' && !toolsUsed && !attempt.output.trim() && endpointRejected(attempt.error))) return attempt;
      // A ceiling the endpoint will not accept is a much smaller problem than a protocol it does not speak, so ask
      // for the older budget before giving up on the Anthropic-style endpoint altogether.
      if (outputBudgetRejected(attempt.error)) {
        const smaller = await this.runAnthropicMessages(
          request,
          projectRoot,
          { ...capability, baseUrl: anthropicBase },
          apiKey,
          controller,
          watch,
          approvals,
          contextText,
          history,
          customPermissions,
          OUTPUT_TOKEN_BUDGET_FALLBACK,
        );
        if (!(smaller.status === 'failed' && !toolsUsed && !smaller.output.trim() && endpointRejected(smaller.error))) return smaller;
      }
      // The endpoint is not available for this key or model; use the chat endpoint, and do not try again this session.
      this.deepSeekAnthropicRejected = true;
      onEvent?.(lifecycleEvent(request, 'starting', 'DeepSeek\'s Anthropic-style endpoint was not accepted; using its chat endpoint instead.'));
    }
    if (protocol === 'chat-completions') {
      const result = await this.runChatCompletions(
        request,
        projectRoot,
        capability,
        apiKey,
        controller,
        onEvent,
        approvals,
        contextText,
        history,
        customPermissions,
      );
      return routeNotice ? { ...result, events: [routeNotice, ...result.events] } : result;
    }
    if (protocol === 'anthropic-messages') {
      return this.runAnthropicMessages(
        request,
        projectRoot,
        capability,
        apiKey,
        controller,
        onEvent,
        approvals,
        contextText,
        history,
        customPermissions,
      );
    }
    if (protocol === 'google-generative-ai') {
      return this.runGoogleGenerativeAi(
        request,
        projectRoot,
        capability,
        apiKey,
        controller,
        onEvent,
        approvals,
        contextText,
        history,
        customPermissions,
      );
    }

    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions, request.conversationId, request.permissionRules, request.maxCostUsd);
    toolRuntime.outputLimit = (capability as DirectApiCapability & ModelRoute).outputLimit;
    const cancelledDuringToolRuntime = checkCancelledEarly();
    if (cancelledDuringToolRuntime) return cancelledDuringToolRuntime;
    // One outside-tool view per run: large tool sets are offered through tool_search instead of all at once.
    const externalPort = deferExternalTools(this.externalFor(projectRoot, request, isLocalProvider(capability.provider)));
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await externalPort?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    // `controller` is the one created at the top of this method, already registered — not re-created here.
    const outputParts: string[] = [];
    const generatedImages = new Map<string, string>();
    const errors: string[] = [];
    let previousResponseId = resumeResponseId;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;
    let forceFinalAnswer = false;
    let resumeAfterSteer = false;
    const toolRoundLimit = leadToolRoundLimit(request, request.toolRoundLimit ?? this.options.maxToolRounds ?? MAX_TOTAL_TOOL_ROUNDS);
    const firstInputText = contextText?.trim()
      ? `${contextText.trim()}\n\nUser request:\n${request.prompt}`
      : request.prompt;
    // The Responses API takes the text as a string, which has no room for an image. With one attached the first
    // message goes as a user message of parts instead, so what the person attached is actually sent: the other three
    // protocols already did this, and this one quietly sent only a prompt that described a file.
    const firstImages = attachedImages(request.contextChips);
    let providerInput: unknown = firstImages.length > 0
      ? [{ role: 'user', content: [{ type: 'input_text', text: firstInputText }, ...firstImages.map(responsesImagePart)] }]
      : firstInputText;

    try {
      for (let providerRound = 0; providerRound < toolRoundLimit + PROVIDER_ROUND_HEADROOM; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        await this.checkRunSpend(toolRuntime, capability, inputTokens, outputTokens, approvals);

        // Something the person said while this run was going. It is put to the model at its next turn, so it
        // answers — or takes the correction — and carries on, rather than the run being cancelled and started
        // again from the same prompt.
        const interjected = takeInterjectionMessage(request.conversationId);
        if (interjected) {
          resumeAfterSteer = true;
          providerInput = appendUserInput(providerInput, steeringInstructionFor(interjected), interjectionImages(interjected));
        }
        if (toolRuntime.guard.wrapUpRequested && !forceFinalAnswer) {
          forceFinalAnswer = true;
          providerInput = appendUserInput(providerInput, isLeadRun(request) ? LEAD_FINAL_ANSWER : WRAP_UP_MESSAGE);
          emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached a run limit; asking it to sum up what it has done.`));
        }
        const pendingToolCalls = new Map<string, PendingToolCall>();
        let roundEmittedText = false;
        let roundText = '';
        let roundProviderError: string | undefined;

        const response = await this.requestProviderResponse(
          request,
          capability,
          apiKey,
          providerInput,
          externalToolDefinitions,
          previousResponseId,
          controller.signal,
          emit,
          !forceFinalAnswer,
          toolRuntime.toolDefinitions(),
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body, streamIdleTimeout(capability))) {
          if (streamEvent.data === '[DONE]') break;
          let value: Record<string, unknown>;
          try {
            value = asRecord(JSON.parse(streamEvent.data)) ?? {};
          } catch {
            continue;
          }

          const type = streamEvent.event || stringValue(value.type) || '';
          if (type === 'response.created') {
            previousResponseId = responseIdFrom(value) ?? previousResponseId;
            continue;
          }
          if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const item = asRecord(value.item);
            rememberToolCall(pendingToolCalls, item);
            const image = generatedImageFromOutputItem(item);
            if (image) generatedImages.set(image.id, image.dataUrl);
            continue;
          }
          if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
            rememberToolArguments(pendingToolCalls, value);
            continue;
          }
          if (type === 'response.output_text.delta') {
            const delta = stringValue(value.delta);
            if (delta) {
              const shown = (roundText ? '' : roundBreak(outputParts)) + delta;
              roundText += delta;
              outputParts.push(shown);
              roundEmittedText = true;
              onEvent?.(textEvent(request, shown));
            }
            continue;
          }
          if (type === 'response.completed') {
            const responseRecord = asRecord(value.response);
            previousResponseId = stringValue(responseRecord?.id) ?? previousResponseId;
            const usage = asRecord(responseRecord?.usage);
            const roundInputTokens = integerValue(usage?.input_tokens);
            const roundOutputTokens = integerValue(usage?.output_tokens);
            if (roundInputTokens !== undefined) inputTokens = (inputTokens ?? 0) + roundInputTokens;
            if (roundOutputTokens !== undefined) outputTokens = (outputTokens ?? 0) + roundOutputTokens;
            for (const item of outputItems(responseRecord?.output)) {
              rememberToolCall(pendingToolCalls, item);
              const image = generatedImageFromOutputItem(item);
              if (image) generatedImages.set(image.id, image.dataUrl);
            }
            if (!roundEmittedText) {
              const finalText = outputText(responseRecord?.output);
              if (finalText) {
                const shown = (roundText ? '' : roundBreak(outputParts)) + finalText;
                roundText += finalText;
                outputParts.push(shown);
                roundEmittedText = true;
                onEvent?.(textEvent(request, shown));
              }
            }
            continue;
          }
          if (type === 'response.failed' || type === 'error') {
            roundProviderError = providerEventError(value) || `${capability.displayName} reported a failed response.`;
          }
        }

        if (roundProviderError) {
          errors.push(roundProviderError);
          break;
        }

        const toolCalls = [...pendingToolCalls.values()].filter((call) => call.name);
        if (forceFinalAnswer && isLeadRun(request) && toolCalls.length) {
          errors.push('Lead ignored the request to finish and called tools after inspection ended. No further tools were run; choose another model or ask for one specific next action.');
          break;
        }
        if (toolCalls.length === 0) {
          if (!isLeadRun(request) && resumeAfterSteer && !forceFinalAnswer) {
            resumeAfterSteer = false;
            providerInput = 'Now resume the original task from where you paused. Keep working through its unfinished steps; do not stop after only addressing the interruption.';
            continue;
          }
          // The plan is consulted first, because it answers the question the prose can only guess at: open items mean
          // the work is not done, whatever the wording of the reply looked like.
          const planned = isLeadRun(request) ? null : await planContinuation(projectRoot, request.conversationId, roundText, nudges);
          if (planned) {
            nudges += 1;
            providerInput = planned;
            continue;
          }
          if (!isLeadRun(request) && announcesUnfinishedWork(roundText)) {
            // Out of nudges: ask rather than end the run. Continue buys another stretch of the same nudging.
            if (nudges >= MAX_UNFINISHED_NUDGES && (await askToContinue(approvals, TALK_ONLY_QUESTION)) === 'continue') {
              nudges = 0;
            }
            if (nudges < MAX_UNFINISHED_NUDGES) {
              nudges += 1;
              providerInput = UNFINISHED_WORK_NUDGE;
              continue;
            }
            // Ended, not failed: the words the model did write are kept, and this says why it stopped.
            emit(lifecycleEvent(request, 'starting', UNFINISHED_STALL));
          }
          break;
        }
        if (toolRounds >= toolRoundLimit) {
          // Not a failure: the run is enormous or stuck, and the person wants what was done, not an error that throws
          // it away. Ask for a summary with the tools taken away, so the answer is words rather than more calls.
          if (!forceFinalAnswer) {
            forceFinalAnswer = true;
            providerInput = WRAP_UP_MESSAGE;
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached this run's tool limit; asking it to sum up what it has done.`));
            continue;
          }
          break;
        }
        toolRounds += 1;
        nudges = 0; // real work resets the budget: nudges are for stalls, not for the whole run
        providerInput = await executeToolCalls(
          request,
          toolRuntime,
          toolCalls,
          controller.signal,
          approvals,
          externalPort,
          emit,
          (question) => this.runExploreQuery(question, projectRoot, capability, apiKey, controller.signal, contextText),
          this.taskRunner(request, projectRoot, contextText),
        );
        if (isLeadRun(request) && !forceFinalAnswer && (toolRuntime.guard.wrapUpRequested || toolRounds >= toolRoundLimit)) {
          forceFinalAnswer = true;
          providerInput = appendUserInput(providerInput, LEAD_FINAL_ANSWER);
          emit(noticeEvent(request, 'Lead inspection finished; preparing a next step from the evidence already read.'));
        }
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    const output = outputParts.join('').trim() || (generatedImages.size > 0 ? 'Generated an image.' : '');
    const { failed, error } = runFailure({
      aborted,
      errors,
      output,
      guard: toolRuntime.guard,
      displayName: capability.displayName,
      autonomy: request.autonomy,
    });

    if (output) events.push(textEvent(request, output));
    if (inputTokens !== undefined || outputTokens !== undefined) {
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'cost.update',
        inputTokens,
        outputTokens,
        sessionId: previousResponseId,
        estimateProvenance: 'measured',
        ...costFields(capability.provider, capability.model, inputTokens, outputTokens, undefined, hostOf(capability)),
      });
    }
    if (error) {
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'error',
        message: error,
        recoverable: true,
      });
    }
    emit(
      lifecycleEvent(
        request,
        aborted ? 'cancelled' : failed ? 'failed' : 'completed',
        aborted ? `${capability.displayName} stopped before it finished.` : failed ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
      ),
    );

    return {
      status: failed || aborted ? 'failed' : 'completed',
      ...(aborted ? { cancelled: true } : {}),
      output,
      ...(generatedImages.size > 0 ? { generatedImages: [...generatedImages.values()].slice(0, 6).map((dataUrl, index) => ({ name: `Generated image ${index + 1}.png`, dataUrl })) } : {}),
      outputAgent: request.agent,
      events,
      sessionId: previousResponseId,
      error,
    };
  }

  private async runChatCompletions(
    request: AgentRunRequest,
    projectRoot: string,
    capability: DirectApiCapability,
    apiKey: string,
    /** Already registered in `activeRuns` by `run()` before any of its own preflight awaits; reused here rather
     *  than minted fresh, so a cancel that landed during `run()`'s own setup is not lost. */
    controller: AbortController,
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions, request.conversationId, request.permissionRules, request.maxCostUsd);
    toolRuntime.outputLimit = (capability as DirectApiCapability & ModelRoute).outputLimit;
    if (controller.signal.aborted) return cancelledEarly(request);
    // One outside-tool view per run: large tool sets are offered through tool_search instead of all at once.
    const externalPort = deferExternalTools(this.externalFor(projectRoot, request, isLocalProvider(capability.provider)));
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await externalPort?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    // `controller` is the caller's own, already registered in `activeRuns` — not re-created here.
    const messages = chatMessages(request, contextText, history);
    // Instructions and the tool list ride along with every request; folding cannot shrink them.
    const toolTokens = toolListTokens(externalToolDefinitions, toolRuntime.toolDefinitions());
    const fixedTokens = (): number => toolTokens + estimateChatTokens(messages.filter((message) => message.role === 'system'));
    const outputParts: string[] = [];
    const errors: string[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    // DeepSeek's cap on tool rounds per request is far lower than the generic limit, so its runs work in blocks:
    // after each block the history is compacted and the run carries on in a fresh request.
    const deepSeek = isDeepSeekCapability(capability);
    const segmentLimit = deepSeek ? DEEPSEEK_MAX_TOOL_ROUNDS : Number.POSITIVE_INFINITY;
    const totalToolRoundLimit = leadToolRoundLimit(request, request.toolRoundLimit ?? this.options.maxToolRounds ?? (deepSeek ? DEEPSEEK_MAX_TOTAL_TOOL_ROUNDS : MAX_TOTAL_TOOL_ROUNDS));
    const providerRoundLimit = totalToolRoundLimit + PROVIDER_ROUND_HEADROOM;
    let segmentRounds = 0;
    let segmentStart = messages.length;
    let forceFinalAnswer = false;
    let nudges = 0;
    let resumeAfterSteer = false;
    let continuations = 0;
    let reasoningOnly = false;
    // The size the person chose in Settings: a long run folds its older tool activity into a summary at this point,
    // so one run does not keep growing past it. Zero (or no setting) leaves the history alone.
    const loadedSettings = await this.settings.load().catch(() => undefined);
    const compactAt = compactThresholdFor(loadedSettings?.usageBudget ?? { compactAtTokens: 0, compactAtTokensLocal: 0 }, capability.provider, modelContextFor(loadedSettings ?? {}, capability.model));
    let lastContextTokens = 0;

    try {
      for (let providerRound = 0; providerRound < providerRoundLimit; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        await this.checkRunSpend(toolRuntime, capability, inputTokens, outputTokens, approvals);

        // Something the person said while this run was going. It is put to the model at its next turn, so it
        // answers — or takes the correction — and carries on, rather than the run being cancelled and started
        // again from the same prompt.
        const interjected = takeInterjectionMessage(request.conversationId);
        if (interjected) {
          resumeAfterSteer = true;
          messages.push({ role: 'user', content: textWithImages(steeringInstructionFor(interjected), interjectionImages(interjected), openAiImagePart) });
        }
        if (toolRuntime.guard.wrapUpRequested && !forceFinalAnswer) {
          forceFinalAnswer = true;
          messages.push({ role: 'user', content: isLeadRun(request) ? LEAD_FINAL_ANSWER : WRAP_UP_MESSAGE });
          emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached a run limit; asking it to sum up what it has done.`));
        }
        const trimmedResults = trimChatToolResults(messages);
        if (trimmedResults > 0) emit(lifecycleEvent(request, 'starting', `Trimmed ${trimmedResults} earlier tool results to keep the request small.`));
        const pendingToolCalls = new Map<number, PendingChatToolCall>();
        let roundText = '';
        let roundThinking = false;
        let truncated = false;
        let roundProviderError: string | undefined;
        if (providerRound === 0 && isLocalProvider(capability.provider)) {
          emit(lifecycleEvent(request, 'starting', `Waiting for the gateway to prepare model ${capability.model}. It will load the model when needed.`));
        }
        const response = await this.requestChatCompletionsResponse(
          request,
          capability,
          apiKey,
          messages,
          externalToolDefinitions,
          controller.signal,
          emit,
          !forceFinalAnswer,
          toolRuntime.toolDefinitions(),
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body, streamIdleTimeout(capability))) {
          if (streamEvent.data === '[DONE]') break;
          let value: Record<string, unknown>;
          try {
            value = asRecord(JSON.parse(streamEvent.data)) ?? {};
          } catch {
            continue;
          }
          const streamError = providerEventError(value);
          if (streamError) roundProviderError = streamError;
          const usage = asRecord(value.usage);
          const roundInputTokens = integerValue(usage?.prompt_tokens) ?? integerValue(usage?.input_tokens);
          const roundOutputTokens = integerValue(usage?.completion_tokens) ?? integerValue(usage?.output_tokens);
          if (roundInputTokens !== undefined) { inputTokens = (inputTokens ?? 0) + roundInputTokens; lastContextTokens = roundInputTokens; emit(contextSizeEvent(request, lastContextTokens, fixedTokens())); }
          if (roundOutputTokens !== undefined) outputTokens = (outputTokens ?? 0) + roundOutputTokens;

          const choice = firstRecord(value.choices);
          const delta = asRecord(choice?.delta);
          // DeepSeek's own reasoning stream. None of it is shown — it is the model working — but its presence still
          // means the turn produced something, so a turn that only reasoned is not mistaken for an empty reply.
          if (stringValue(delta?.reasoning_content)) roundThinking = true;
          const deltaText = chatContentText(delta?.content);
          if (deltaText) {
            // Text from an earlier round would otherwise run straight into this one ("...the files.I will...").
            if (!roundText && outputParts.length > 0 && !/\s$/.test(outputParts.join('').slice(-1))) {
              outputParts.push('\n\n');
              onEvent?.(textEvent(request, '\n\n'));
            }
            roundText += deltaText;
            outputParts.push(deltaText);
            onEvent?.(textEvent(request, deltaText));
          }
          for (const toolCall of chatToolDeltas(delta?.tool_calls)) {
            rememberChatToolCall(pendingToolCalls, toolCall);
          }
          if (choice?.finish_reason === 'error') {
            roundProviderError ||= `${capability.displayName} reported a failed response.`;
          }
          // Ran out of room mid-turn rather than finishing, so it has to be resumed instead of treated as the end.
          if (choice?.finish_reason === 'length') truncated = true;
        }

        if (roundProviderError) {
          errors.push(roundProviderError);
          break;
        }

        const toolCalls = [...pendingToolCalls.values()]
          .sort((left, right) => left.index - right.index)
          .filter((call) => call.name);
        if (forceFinalAnswer && isLeadRun(request) && toolCalls.length) {
          errors.push('Lead ignored the request to finish and called tools after inspection ended. No further tools were run; choose another model or ask for one specific next action.');
          break;
        }
        if (toolCalls.length === 0) {
          // Cut off mid-thought: the model spent the whole output budget working and never reached a word or a tool
          // call. That is an unfinished turn, so it is resumed rather than ended — ending it is what made a long,
          // productive run look like the agent had stopped for no reason.
          if (truncated && !forceFinalAnswer && continuations < MAX_TRUNCATED_CONTINUATIONS) {
            continuations += 1;
            if (roundThinking && !roundText) reasoningOnly = true;
            messages.push({ role: 'assistant', content: roundText || '(reasoning only)' });
            messages.push({ role: 'user', content: isLeadRun(request) ? 'Finish the read-only Lead reply concisely. Do not execute the Builder task or retry blocked tools.' : TRUNCATED_TURN_CONTINUATION });
            continue;
          }
          if (truncated && roundThinking && !roundText) reasoningOnly = true;
          if (!isLeadRun(request) && resumeAfterSteer && !forceFinalAnswer) {
            resumeAfterSteer = false;
            messages.push({ role: 'assistant', content: roundText });
            messages.push({ role: 'user', content: 'Resume the original task from where you paused. Continue its unfinished steps before you finish this run.' });
            continue;
          }
          const planned = isLeadRun(request) ? null : await planContinuation(projectRoot, request.conversationId, roundText, nudges);
          if (!forceFinalAnswer && planned) {
            nudges += 1;
            messages.push({ role: 'assistant', content: roundText });
            messages.push({ role: 'user', content: planned });
            continue;
          }
          if (!isLeadRun(request) && !forceFinalAnswer && announcesUnfinishedWork(roundText)) {
            // Out of nudges: ask rather than end the run. Continue buys another stretch of the same nudging.
            if (nudges >= MAX_UNFINISHED_NUDGES && (await askToContinue(approvals, TALK_ONLY_QUESTION)) === 'continue') {
              nudges = 0;
            }
            if (nudges < MAX_UNFINISHED_NUDGES) {
              nudges += 1;
              messages.push({ role: 'assistant', content: roundText });
              messages.push({ role: 'user', content: UNFINISHED_WORK_NUDGE });
              continue;
            }
            // Ended, not failed: the words the model did write are kept, and this says why it stopped.
            emit(lifecycleEvent(request, 'starting', UNFINISHED_STALL));
          }
          break;
        }
        if (toolRounds >= totalToolRoundLimit) {
          // Not a failure: the run is enormous or stuck, and the person wants what was done, not an error that throws
          // it away. Ask for a summary with the tools taken away, so the answer is words rather than more calls.
          if (!forceFinalAnswer) {
            forceFinalAnswer = true;
            messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached this run's tool limit; asking it to sum up what it has done.`));
            continue;
          }
          break;
        }
        toolRounds += 1;
        nudges = 0; // real work resets the budget: nudges are for stalls, not for the whole run
        for (const call of toolCalls) call.callId ||= `call_${randomUUID()}`;
        messages.push({
          role: 'assistant',
          content: roundText || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.callId || `call_${randomUUID()}`,
            type: 'function',
            function: { name: call.name || 'unknown', arguments: call.argumentsText || '{}' },
          })),
        });
        const toolResults = await executeToolCalls(
          request,
          toolRuntime,
          toolCalls,
          controller.signal,
          approvals,
          externalPort,
          emit,
          (question) => this.runExploreQuery(question, projectRoot, capability, apiKey, controller.signal, contextText),
          this.taskRunner(request, projectRoot, contextText),
          chatToolOutput,
        );
        // Chat APIs generally require text-only tool messages; deliver images in a user message
        // after all tool replies so parallel tool-call/result ordering stays valid.
        const visualParts: Array<Record<string, unknown>> = [];
        for (const result of toolResults as ChatMessage[]) {
          if (Array.isArray(result.content)) {
            visualParts.push({ type: 'text', text: `Images from tool call ${result.tool_call_id}:` }, ...result.content.filter((part) => part.type === 'image_url'));
            result.content = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          }
          messages.push(result);
        }
        if (visualParts.length) messages.push({ role: 'user', content: visualParts });
        segmentRounds += 1;
        const leadNeedsAnswer = isLeadRun(request) && (toolRuntime.guard.wrapUpRequested || toolRounds >= totalToolRoundLimit || segmentRounds >= segmentLimit || shouldCompactRun(messages, segmentStart, compactAt, lastContextTokens, fixedTokens()));
        if (!forceFinalAnswer && leadNeedsAnswer) {
          // Keep the actual evidence for the answer. A 200-character tool summary caused Lead to reread it all.
          forceFinalAnswer = true;
          messages.push({ role: 'user', content: LEAD_FINAL_ANSWER });
          emit(noticeEvent(request, 'Lead inspection finished; preparing a next step from the evidence already read.'));
        } else if (!forceFinalAnswer && segmentRounds >= segmentLimit) {
          if (toolRounds < totalToolRoundLimit) {
            // DeepSeek stops accepting tools past its per-request cap. Fold this block of tool activity into a
            // summary and carry on in a fresh request, so the task is finished rather than handed back half-done.
            const summary = compactChatToolHistory(messages.slice(segmentStart));
            messages.length = segmentStart;
            messages.push({ role: 'user', content: continuationMessage(summary, request) });
            segmentStart = messages.length;
            segmentRounds = 0;
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached its per-request tool limit; continuing in a fresh request.`));
          } else {
            forceFinalAnswer = true;
            messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
          }
        } else if (!forceFinalAnswer && toolRounds < totalToolRoundLimit && shouldCompactRun(messages, segmentStart, compactAt, lastContextTokens, fixedTokens())) {
          // The history reached the size chosen for auto-compact: the same fold as above, triggered by size.
          const summary = compactChatToolHistory(messages.slice(segmentStart)) + await foldPlanNote(projectRoot, request.conversationId);
          messages.length = segmentStart;
          messages.push({ role: 'user', content: continuationMessage(summary, request) });
          segmentStart = messages.length;
          segmentRounds = 0;
          emit(noticeEvent(request, `Compacted this run: its conversation reached the ${compactAt.toLocaleString()} tokens you set, so its earlier steps became a summary and it carried on.`));
        }
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    // An empty run that consisted only of reasoning would otherwise be reported as a model that said nothing, which
    // sends the reader looking for a broken provider instead of a budget the model thought its way through.
    if (!aborted && !outputParts.join('').trim() && reasoningOnly) errors.push(`${capability.displayName}${REASONING_ONLY}`);

    const output = outputParts.join('').trim();
    const { failed, error } = runFailure({
      aborted,
      errors,
      output,
      guard: toolRuntime.guard,
      displayName: capability.displayName,
      autonomy: request.autonomy,
    });

    if (output) events.push(textEvent(request, output));
    if (inputTokens !== undefined || outputTokens !== undefined) {
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'cost.update',
        inputTokens,
        outputTokens,
        estimateProvenance: 'measured',
        ...costFields(capability.provider, capability.model, inputTokens, outputTokens, undefined, hostOf(capability)),
      });
    }
    if (error) {
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'error',
        message: error,
        recoverable: true,
      });
    }
    emit(lifecycleEvent(
      request,
      aborted ? 'cancelled' : failed ? 'failed' : 'completed',
      aborted ? `${capability.displayName} stopped before it finished.` : failed ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
    ));

    return {
      status: failed || aborted ? 'failed' : 'completed',
      ...(aborted ? { cancelled: true } : {}),
      output,
      outputAgent: request.agent,
      events,
      error,
    };
  }

  private async runAnthropicMessages(
    request: AgentRunRequest,
    projectRoot: string,
    capability: DirectApiCapability,
    apiKey: string,
    /** Already registered in `activeRuns` by `run()` before any of its own preflight awaits; reused here rather
     *  than minted fresh, so a cancel that landed during `run()`'s own setup is not lost. */
    controller: AbortController,
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
    maxTokens: number = OUTPUT_TOKEN_BUDGET,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions, request.conversationId, request.permissionRules, request.maxCostUsd);
    toolRuntime.outputLimit = (capability as DirectApiCapability & ModelRoute).outputLimit;
    if (controller.signal.aborted) return cancelledEarly(request);
    // One outside-tool view per run: large tool sets are offered through tool_search instead of all at once.
    const externalPort = deferExternalTools(this.externalFor(projectRoot, request, isLocalProvider(capability.provider)));
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await externalPort?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    // `controller` is the caller's own, already registered in `activeRuns` — not re-created here.
    const messages = anthropicMessages(request, history);
    const fixedTokens = (): number => toolListTokens(externalToolDefinitions, toolRuntime.toolDefinitions()) + Math.ceil((contextText ?? '').length / 4);
    // The part of the prompt the provider served from its cache, which costs a fraction of a fresh one.
    let cachedReadTokens = 0;
    const outputParts: string[] = [];
    const errors: string[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;
    let continuations = 0;
    let reasoningOnly = false;
    let forceFinalAnswer = false;
    let resumeAfterSteer = false;
    const toolRoundLimit = leadToolRoundLimit(request, request.toolRoundLimit ?? this.options.maxToolRounds ?? MAX_TOTAL_TOOL_ROUNDS);
    // The size chosen for auto-compact (zero leaves the history alone), and where the part of this run that can be
    // folded into a summary begins.
    const loadedSettings = await this.settings.load().catch(() => undefined);
    const compactAt = compactThresholdFor(loadedSettings?.usageBudget ?? { compactAtTokens: 0, compactAtTokensLocal: 0 }, capability.provider, modelContextFor(loadedSettings ?? {}, capability.model));
    let segmentStart = messages.length;
    let lastContextTokens = 0;

    try {
      for (let providerRound = 0; providerRound < toolRoundLimit + PROVIDER_ROUND_HEADROOM; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        await this.checkRunSpend(toolRuntime, capability, inputTokens, outputTokens, approvals, cachedReadTokens);

        // Something the person said while this run was going. It is put to the model at its next turn, so it
        // answers — or takes the correction — and carries on, rather than the run being cancelled and started
        // again from the same prompt.
        const interjected = takeInterjectionMessage(request.conversationId);
        if (interjected) {
          resumeAfterSteer = true;
          messages.push({ role: 'user', content: textWithImages(steeringInstructionFor(interjected), interjectionImages(interjected), anthropicImagePart) });
        }
        if (toolRuntime.guard.wrapUpRequested && !forceFinalAnswer) {
          forceFinalAnswer = true;
          messages.push({ role: 'user', content: isLeadRun(request) ? LEAD_FINAL_ANSWER : WRAP_UP_MESSAGE });
          emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached a run limit; asking it to sum up what it has done.`));
        }
        const trimmedResults = trimAnthropicToolResults(messages);
        if (trimmedResults > 0) emit(lifecycleEvent(request, 'starting', `Trimmed ${trimmedResults} earlier tool results to keep the request small.`));
        const pendingToolCalls = new Map<string, PendingToolCall>();
        let roundText = '';
        let roundThinking = false;
        let truncated = false;
        let roundProviderError: string | undefined;
        const response = await this.requestAnthropicResponse(
          request,
          capability,
          apiKey,
          messages,
          contextText,
          externalToolDefinitions,
          controller.signal,
          emit,
          maxTokens,
          !forceFinalAnswer,
          toolRuntime.toolDefinitions(),
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body, streamIdleTimeout(capability))) {
          let value: Record<string, unknown>;
          try {
            value = asRecord(JSON.parse(streamEvent.data)) ?? {};
          } catch {
            continue;
          }
          const type = streamEvent.event || stringValue(value.type) || '';
          if (type === 'message_start') {
            const usage = asRecord(asRecord(value.message)?.usage);
            const roundInputTokens = integerValue(usage?.input_tokens);
            // Cached prompt tokens are reported separately; count them so budgets never undercount the prompt.
            const cachedTokens = (integerValue(usage?.cache_read_input_tokens) ?? 0) + (integerValue(usage?.cache_creation_input_tokens) ?? 0);
            if (roundInputTokens !== undefined) { inputTokens = (inputTokens ?? 0) + roundInputTokens + cachedTokens; lastContextTokens = roundInputTokens + cachedTokens; emit(contextSizeEvent(request, lastContextTokens, fixedTokens())); }
            cachedReadTokens += integerValue(usage?.cache_read_input_tokens) ?? 0;
            continue;
          }
          if (type === 'content_block_start') {
            const block = asRecord(value.content_block);
            if (block?.type === 'tool_use') rememberAnthropicToolCall(pendingToolCalls, block, integerValue(value.index));
            // A reasoning model opens its turn with a thinking block. None of that text is shown — it is the model
            // working — but the block still means the turn produced something, which keeps a long think from being
            // mistaken for a silent, empty turn.
            if (block?.type === 'thinking' || block?.type === 'redacted_thinking') roundThinking = true;
            const initialText = block?.type === 'text' ? stringValue(block.text) : undefined;
            if (initialText) {
              const shown = (roundText ? '' : roundBreak(outputParts)) + initialText;
              roundText += initialText;
              outputParts.push(shown);
              onEvent?.(textEvent(request, shown));
            }
            continue;
          }
          if (type === 'content_block_delta') {
            const delta = asRecord(value.delta);
            if (delta?.type === 'thinking_delta') {
              if (stringValue(delta.thinking)) roundThinking = true;
            } else if (delta?.type === 'text_delta') {
              const text = stringValue(delta.text);
              if (text) {
                const shown = (roundText ? '' : roundBreak(outputParts)) + text;
                roundText += text;
                outputParts.push(shown);
                onEvent?.(textEvent(request, shown));
              }
            } else if (delta?.type === 'input_json_delta') {
              rememberAnthropicToolArguments(pendingToolCalls, value, stringValue(delta.partial_json));
            }
            continue;
          }
          if (type === 'message_delta') {
            const usage = asRecord(value.usage);
            const roundOutputTokens = integerValue(usage?.output_tokens);
            if (roundOutputTokens !== undefined) outputTokens = (outputTokens ?? 0) + roundOutputTokens;
            const delta = asRecord(value.delta);
            if (delta?.stop_reason === 'error') roundProviderError = `${capability.displayName} reported a failed response.`;
            // The turn ran out of room rather than finishing, so it has to be resumed instead of treated as the end.
            if (delta?.stop_reason === 'max_tokens') truncated = true;
            continue;
          }
          if (type === 'error') {
            roundProviderError = providerEventError(value) || `${capability.displayName} reported a failed response.`;
          }
        }

        if (roundProviderError) {
          errors.push(roundProviderError);
          break;
        }

        const toolCalls = [...pendingToolCalls.values()].filter((call) => call.name);
        if (forceFinalAnswer && isLeadRun(request) && toolCalls.length) {
          errors.push('Lead ignored the request to finish and called tools after inspection ended. No further tools were run; choose another model or ask for one specific next action.');
          break;
        }
        if (toolCalls.length === 0) {
          // Cut off mid-thought. A reasoning model can spend the entire output budget working and stop before it
          // writes a word or calls a tool; that is an unfinished turn, so it is resumed rather than ended. Ending it
          // here is what made a long, productive run look like the agent had simply stopped for no reason.
          if (truncated && continuations < MAX_TRUNCATED_CONTINUATIONS) {
            continuations += 1;
            if (roundThinking && !roundText) reasoningOnly = true;
            const assistant = roundText
              ? [{ type: 'text', text: roundText }]
              : [{ type: 'text', text: '(reasoning only)' }];
            messages.push({ role: 'assistant', content: assistant });
            messages.push({ role: 'user', content: isLeadRun(request) ? 'Finish the read-only Lead reply concisely. Do not execute the Builder task or retry blocked tools.' : TRUNCATED_TURN_CONTINUATION });
            continue;
          }
          if (truncated && roundThinking && !roundText) reasoningOnly = true;
          if (!isLeadRun(request) && resumeAfterSteer && !forceFinalAnswer) {
            resumeAfterSteer = false;
            messages.push({ role: 'assistant', content: [{ type: 'text', text: roundText || '(reasoning only)' }] });
            messages.push({ role: 'user', content: [{ type: 'text', text: 'Resume the original task from where you paused. Continue its unfinished steps before you finish this run.' }] });
            continue;
          }
          const planned = isLeadRun(request) ? null : await planContinuation(projectRoot, request.conversationId, roundText, nudges);
          if (planned) {
            nudges += 1;
            messages.push({ role: 'assistant', content: [{ type: 'text', text: roundText }] });
            messages.push({ role: 'user', content: planned });
            continue;
          }
          if (!isLeadRun(request) && announcesUnfinishedWork(roundText)) {
            // Out of nudges: ask rather than end the run. Continue buys another stretch of the same nudging.
            if (nudges >= MAX_UNFINISHED_NUDGES && (await askToContinue(approvals, TALK_ONLY_QUESTION)) === 'continue') {
              nudges = 0;
            }
            if (nudges < MAX_UNFINISHED_NUDGES) {
              nudges += 1;
              messages.push({ role: 'assistant', content: [{ type: 'text', text: roundText }] });
              messages.push({ role: 'user', content: UNFINISHED_WORK_NUDGE });
              continue;
            }
            // Ended, not failed: the words the model did write are kept, and this says why it stopped.
            emit(lifecycleEvent(request, 'starting', UNFINISHED_STALL));
          }
          break;
        }
        if (toolRounds >= toolRoundLimit) {
          // Not a failure: the run is enormous or stuck, and the person wants what was done, not an error that throws
          // it away. Ask for a summary with the tools taken away, so the answer is words rather than more calls.
          if (!forceFinalAnswer) {
            forceFinalAnswer = true;
            messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached this run's tool limit; asking it to sum up what it has done.`));
            continue;
          }
          break;
        }
        toolRounds += 1;
        nudges = 0; // real work resets the budget: nudges are for stalls, not for the whole run
        for (const call of toolCalls) call.callId ||= `toolu_${randomUUID()}`;
        const assistantContent: Array<Record<string, unknown>> = [];
        if (roundText) assistantContent.push({ type: 'text', text: roundText });
        assistantContent.push(...toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.callId,
          name: call.name,
          input: safeToolArguments(call.argumentsText),
        })));
        messages.push({ role: 'assistant', content: assistantContent });
        const toolResults = await executeToolCalls(
          request,
          toolRuntime,
          toolCalls,
          controller.signal,
          approvals,
          externalPort,
          emit,
          (question) => this.runExploreQuery(question, projectRoot, capability, apiKey, controller.signal, contextText),
          this.taskRunner(request, projectRoot, contextText),
          anthropicToolOutput,
        );
        messages.push({ role: 'user', content: toolResults as Array<Record<string, unknown>> });
        if (!forceFinalAnswer && isLeadRun(request) && (toolRuntime.guard.wrapUpRequested || toolRounds >= toolRoundLimit || shouldCompactAnthropicRun(messages, segmentStart, compactAt, lastContextTokens, fixedTokens()))) {
          forceFinalAnswer = true;
          pushUserText(messages, LEAD_FINAL_ANSWER);
          emit(noticeEvent(request, 'Lead inspection finished; preparing a next step from the evidence already read.'));
        } else if (!forceFinalAnswer && toolRounds < toolRoundLimit && shouldCompactAnthropicRun(messages, segmentStart, compactAt, lastContextTokens, fixedTokens())) {
          // The history reached the size chosen for auto-compact: fold this block of tool activity into a summary.
          const summary = compactAnthropicToolHistory(messages.slice(segmentStart)) + await foldPlanNote(projectRoot, request.conversationId);
          messages.length = segmentStart;
          pushUserText(messages, continuationMessage(summary, request));
          segmentStart = messages.length;
          emit(noticeEvent(request, `Compacted this run: its conversation reached the ${compactAt.toLocaleString()} tokens you set, so its earlier steps became a summary and it carried on.`));
        }
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    // An empty run that consisted only of reasoning would otherwise be reported as a model that said nothing, which
    // sends the reader looking for a broken provider instead of a budget the model thought its way through.
    if (!aborted && !outputParts.join('').trim() && reasoningOnly) errors.push(`${capability.displayName}${REASONING_ONLY}`);

    return finishProviderRun({
      request,
      capability,
      events,
      emit,
      outputParts,
      errors,
      inputTokens,
      cachedInputTokens: cachedReadTokens,
      outputTokens,
      aborted,
      guard: toolRuntime.guard,
    });
  }

  private async runGoogleGenerativeAi(
    request: AgentRunRequest,
    projectRoot: string,
    capability: DirectApiCapability,
    apiKey: string,
    /** Already registered in `activeRuns` by `run()` before any of its own preflight awaits; reused here rather
     *  than minted fresh, so a cancel that landed during `run()`'s own setup is not lost. */
    controller: AbortController,
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions, request.conversationId, request.permissionRules, request.maxCostUsd);
    toolRuntime.outputLimit = (capability as DirectApiCapability & ModelRoute).outputLimit;
    if (controller.signal.aborted) return cancelledEarly(request);
    // One outside-tool view per run: large tool sets are offered through tool_search instead of all at once.
    const externalPort = deferExternalTools(this.externalFor(projectRoot, request, isLocalProvider(capability.provider)));
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await externalPort?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    // `controller` is the caller's own, already registered in `activeRuns` — not re-created here.
    const contents = geminiContents(request, history);
    const outputParts: string[] = [];
    const errors: string[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;
    let forceFinalAnswer = false;
    let resumeAfterSteer = false;
    const toolRoundLimit = leadToolRoundLimit(request, request.toolRoundLimit ?? this.options.maxToolRounds ?? MAX_TOTAL_TOOL_ROUNDS);

    try {
      for (let providerRound = 0; providerRound < toolRoundLimit + PROVIDER_ROUND_HEADROOM; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        await this.checkRunSpend(toolRuntime, capability, inputTokens, outputTokens, approvals);

        // Something the person said while this run was going. It is put to the model at its next turn, so it
        // answers — or takes the correction — and carries on, rather than the run being cancelled and started
        // again from the same prompt.
        const interjected = takeInterjectionMessage(request.conversationId);
        if (interjected) {
          resumeAfterSteer = true;
          contents.push({ role: 'user', parts: [{ text: steeringInstructionFor(interjected) }, ...interjectionImages(interjected).map(geminiImagePart)] });
        }
        if (toolRuntime.guard.wrapUpRequested && !forceFinalAnswer) {
          forceFinalAnswer = true;
          contents.push({ role: 'user', parts: [{ text: isLeadRun(request) ? LEAD_FINAL_ANSWER : WRAP_UP_MESSAGE }] });
          emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached a run limit; asking it to sum up what it has done.`));
        }
        const trimmedResults = trimGeminiToolResults(contents);
        if (trimmedResults > 0) emit(lifecycleEvent(request, 'starting', `Trimmed ${trimmedResults} earlier tool results to keep the request small.`));
        const pendingToolCalls = new Map<string, PendingToolCall>();
        let roundText = '';
        let roundProviderError: string | undefined;
        const response = await this.requestGoogleResponse(
          request,
          capability,
          apiKey,
          contents,
          contextText,
          externalToolDefinitions,
          controller.signal,
          emit,
          !forceFinalAnswer,
          toolRuntime.toolDefinitions(),
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body, streamIdleTimeout(capability))) {
          let value: Record<string, unknown>;
          try {
            value = asRecord(JSON.parse(streamEvent.data)) ?? {};
          } catch {
            continue;
          }
          const usage = asRecord(value.usageMetadata);
          const roundInputTokens = integerValue(usage?.promptTokenCount);
          const roundOutputTokens = integerValue(usage?.candidatesTokenCount);
          if (roundInputTokens !== undefined) inputTokens = (inputTokens ?? 0) + roundInputTokens;
          if (roundOutputTokens !== undefined) outputTokens = (outputTokens ?? 0) + roundOutputTokens;

          const candidate = firstRecord(value.candidates);
          const finishReason = stringValue(candidate?.finishReason);
          if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
            roundProviderError = `${capability.displayName} stopped with ${finishReason}.`;
          }
          const parts = asRecord(candidate?.content)?.parts;
          if (!Array.isArray(parts)) continue;
          for (const [index, rawPart] of parts.entries()) {
            const part = asRecord(rawPart);
            const text = stringValue(part?.text);
            if (text) {
              const shown = (roundText ? '' : roundBreak(outputParts)) + text;
              roundText += text;
              outputParts.push(shown);
              onEvent?.(textEvent(request, shown));
            }
            const functionCall = asRecord(part?.functionCall);
            const name = stringValue(functionCall?.name);
            if (name && functionCall) rememberGeminiToolCall(pendingToolCalls, functionCall, index);
          }
        }

        if (roundProviderError) {
          errors.push(roundProviderError);
          break;
        }

        const toolCalls = [...pendingToolCalls.values()].filter((call) => call.name);
        if (forceFinalAnswer && isLeadRun(request) && toolCalls.length) {
          errors.push('Lead ignored the request to finish and called tools after inspection ended. No further tools were run; choose another model or ask for one specific next action.');
          break;
        }
        if (toolCalls.length === 0) {
          if (!isLeadRun(request) && resumeAfterSteer && !forceFinalAnswer) {
            resumeAfterSteer = false;
            contents.push({ role: 'model', parts: [{ text: roundText || '(no text)' }] });
            contents.push({ role: 'user', parts: [{ text: 'Resume the original task from where you paused. Continue its unfinished steps before you finish this run.' }] });
            continue;
          }
          const planned = isLeadRun(request) ? null : await planContinuation(projectRoot, request.conversationId, roundText, nudges);
          if (planned) {
            nudges += 1;
            contents.push({ role: 'model', parts: [{ text: roundText }] });
            contents.push({ role: 'user', parts: [{ text: planned }] });
            continue;
          }
          if (!isLeadRun(request) && announcesUnfinishedWork(roundText)) {
            // Out of nudges: ask rather than end the run. Continue buys another stretch of the same nudging.
            if (nudges >= MAX_UNFINISHED_NUDGES && (await askToContinue(approvals, TALK_ONLY_QUESTION)) === 'continue') {
              nudges = 0;
            }
            if (nudges < MAX_UNFINISHED_NUDGES) {
              nudges += 1;
              contents.push({ role: 'model', parts: [{ text: roundText }] });
              contents.push({ role: 'user', parts: [{ text: UNFINISHED_WORK_NUDGE }] });
              continue;
            }
            // Ended, not failed: the words the model did write are kept, and this says why it stopped.
            emit(lifecycleEvent(request, 'starting', UNFINISHED_STALL));
          }
          break;
        }
        if (toolRounds >= toolRoundLimit) {
          // Not a failure: the run is enormous or stuck, and the person wants what was done, not an error that throws
          // it away. Ask for a summary with the tools taken away, so the answer is words rather than more calls.
          if (!forceFinalAnswer) {
            forceFinalAnswer = true;
            contents.push({ role: 'user', parts: [{ text: WRAP_UP_MESSAGE }] });
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached this run's tool limit; asking it to sum up what it has done.`));
            continue;
          }
          break;
        }
        toolRounds += 1;
        nudges = 0; // real work resets the budget: nudges are for stalls, not for the whole run
        const modelParts: Array<Record<string, unknown>> = [];
        if (roundText) modelParts.push({ text: roundText });
        modelParts.push(...toolCalls.map((call) => ({
          functionCall: {
            name: call.name,
            args: safeToolArguments(call.argumentsText),
          },
        })));
        contents.push({ role: 'model', parts: modelParts });
        const toolResults = await executeToolCalls(
          request,
          toolRuntime,
          toolCalls,
          controller.signal,
          approvals,
          externalPort,
          emit,
          (question) => this.runExploreQuery(question, projectRoot, capability, apiKey, controller.signal, contextText),
          this.taskRunner(request, projectRoot, contextText),
          (callId, output) => [geminiToolOutput(
            toolCalls.find((call) => call.callId === callId)?.name || 'unknown',
            output,
          ), ...toolOutputImages(output).images.map(geminiImagePart)],
        );
        contents.push({ role: 'user', parts: toolResults.flat() as Array<Record<string, unknown>> });
        if (isLeadRun(request) && !forceFinalAnswer && (toolRuntime.guard.wrapUpRequested || toolRounds >= toolRoundLimit)) {
          forceFinalAnswer = true;
          contents.push({ role: 'user', parts: [{ text: LEAD_FINAL_ANSWER }] });
          emit(noticeEvent(request, 'Lead inspection finished; preparing a next step from the evidence already read.'));
        }
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    return finishProviderRun({
      request,
      capability,
      events,
      emit,
      outputParts,
      errors,
      inputTokens,
      outputTokens,
      aborted,
      guard: toolRuntime.guard,
    });
  }

  private async waitIfPaused(conversationId: string, signal: AbortSignal): Promise<void> {
    await this.options.waitIfPaused?.(conversationId, signal);
  }

  /** True while this conversation has a live API run, so destructive conversation edits can refuse. */
  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  cancel(conversationId: string): boolean {
    const controller = this.activeRuns.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async requestChatCompletionsResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    messages: readonly ChatMessage[],
    externalToolDefinitions: readonly unknown[],
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
    includeTools = true,
    builtinToolDefinitions: readonly unknown[] = projectToolDefinitions,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    // A model without vision refuses the whole request over one image. Losing a run to an attachment the person did
    // not have to think about is worse than losing the attachment, so the images go and the request is made again.
    let outgoing: readonly ChatMessage[] = messages;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.pacedFetch(chatCompletionsUrl(capability.baseUrl), {
          method: 'POST',
          headers: chatCompletionsHeaders(capability, apiKey),
          body: JSON.stringify({
            model: capability.model,
            messages: outgoing,
            stream: true,
            stream_options: { include_usage: true },
            ...(includeTools
              ? { tools: chatToolDefinitions(toolsForLead(request, [...builtinToolDefinitions, ...externalToolDefinitions])), tool_choice: 'auto' }
              : {}),
          }),
          signal,
        }, capability, request, apiKey, emit);
      } catch (error) {
        // The transport has already waited or resent as far as is safe; another send could queue a second copy.
        if (error instanceof ModelHostError) throw error;
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (attempt >= maxAttempts) throw error;
        const delayMs = retryDelayMs(baseDelayMs, attempt, undefined);
        emit(lifecycleEvent(
          request,
          'starting',
          `${capability.displayName} connection failed. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
        ));
        await delay(delayMs, signal);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text();
      const message = providerErrorMessage(response.status, detail);
      // A model without vision refuses the whole request over one image. Losing a run to an attachment the person did
      // not have to think about would be worse than losing the attachment, so it goes and the request is made again.
      if (isImageRefusal(response.status, detail) && hasImageParts(outgoing)) {
        outgoing = withoutImageParts(outgoing, IMAGE_REMOVED_NOTE);
        emit(noticeEvent(request, `${capability.displayName} (${capability.model}) would not take the attached image, so this request was sent without it. Switch to a model that accepts images and send it again.`));
        continue;
      }
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw providerFailure(response.status, message, response.headers.get('retry-after'));
      const delayMs = retryDelayMs(baseDelayMs, attempt, response.headers.get('retry-after'));
      emit(lifecycleEvent(
        request,
        'starting',
        `${capability.displayName} returned ${response.status}. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
      ));
      await delay(delayMs, signal);
    }

    throw new Error(`${capability.displayName} exhausted retry attempts.`);
  }

  private async requestAnthropicResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    messages: readonly AnthropicMessage[],
    system: string | undefined,
    externalToolDefinitions: readonly unknown[],
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
    maxTokens: number = OUTPUT_TOKEN_BUDGET,
    // Off only for the last round of a run that has hit its tool ceiling, so the model answers instead of calling more.
    toolsEnabled = true,
    // Overridden by `runExploreQuery`, which must not offer the full project tool set (writes, commands, another
    // `explore`) to its read-only helper. Every ordinary caller takes the default, so this is additive.
    baseToolDefinitions: readonly unknown[] = projectToolDefinitions,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    // Mutable for the same reason as the chat sender's: an image a provider refuses can be dropped and the request
    // made again, rather than the run ending over an attachment.
    let outgoing: readonly AnthropicMessage[] = messages;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const tools = toolsEnabled ? anthropicToolDefinitions(toolsForLead(request, [...baseToolDefinitions, ...externalToolDefinitions])) : [];
        response = await this.pacedFetch(anthropicMessagesUrl(capability.baseUrl), {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: capability.model,
            max_tokens: maxTokens,
            stream: true,
            ...withAnthropicPromptCaching(capability.baseUrl, { messages: outgoing, system: system?.trim(), tools }),
            ...(tools.length > 0 ? { tool_choice: { type: 'auto' } } : {}),
          }),
          signal,
        }, capability, request, apiKey, emit);
      } catch (error) {
        // The transport has already waited or resent as far as is safe; another send could queue a second copy.
        if (error instanceof ModelHostError) throw error;
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (attempt >= maxAttempts) throw error;
        const delayMs = retryDelayMs(baseDelayMs, attempt, undefined);
        emit(lifecycleEvent(
          request,
          'starting',
          `${capability.displayName} connection failed. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
        ));
        await delay(delayMs, signal);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text();
      const message = providerErrorMessage(response.status, detail);
      // A model without vision refuses the whole request over one image. Losing a run to an attachment the person did
      // not have to think about would be worse than losing the attachment, so it goes and the request is made again.
      if (isImageRefusal(response.status, detail) && hasImageParts(outgoing)) {
        outgoing = withoutImageParts(outgoing, IMAGE_REMOVED_NOTE);
        emit(noticeEvent(request, `${capability.displayName} (${capability.model}) would not take the attached image, so this request was sent without it. Switch to a model that accepts images and send it again.`));
        continue;
      }
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw providerFailure(response.status, message, response.headers.get('retry-after'));
      const delayMs = retryDelayMs(baseDelayMs, attempt, response.headers.get('retry-after'));
      emit(lifecycleEvent(
        request,
        'starting',
        `${capability.displayName} returned ${response.status}. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
      ));
      await delay(delayMs, signal);
    }

    throw new Error(`${capability.displayName} exhausted retry attempts.`);
  }

  private async requestGoogleResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    contents: readonly GeminiContent[],
    system: string | undefined,
    externalToolDefinitions: readonly unknown[],
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
    // Off only for the last round of a run that has hit its tool ceiling, so the model answers instead of calling more.
    toolsEnabled = true,
    builtinToolDefinitions: readonly unknown[] = projectToolDefinitions,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const functionDeclarations = toolsEnabled ? geminiToolDefinitions(toolsForLead(request, [...builtinToolDefinitions, ...externalToolDefinitions])) : [];
        response = await this.pacedFetch(geminiGenerateUrl(capability.baseUrl, capability.model), {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: 8_192 },
            ...(system?.trim() ? { systemInstruction: { parts: [{ text: system.trim() }] } } : {}),
            ...(functionDeclarations.length > 0
              ? { tools: [{ functionDeclarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
              : {}),
          }),
          signal,
        }, capability, request, apiKey, emit);
      } catch (error) {
        // The transport has already waited or resent as far as is safe; another send could queue a second copy.
        if (error instanceof ModelHostError) throw error;
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (attempt >= maxAttempts) throw error;
        const delayMs = retryDelayMs(baseDelayMs, attempt, undefined);
        emit(lifecycleEvent(
          request,
          'starting',
          `${capability.displayName} connection failed. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
        ));
        await delay(delayMs, signal);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text();
      const message = providerErrorMessage(response.status, detail);
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw providerFailure(response.status, message, response.headers.get('retry-after'));
      const delayMs = retryDelayMs(baseDelayMs, attempt, response.headers.get('retry-after'));
      emit(lifecycleEvent(
        request,
        'starting',
        `${capability.displayName} returned ${response.status}. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
      ));
      await delay(delayMs, signal);
    }

    throw new Error(`${capability.displayName} exhausted retry attempts.`);
  }

  private async requestProviderResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    providerInput: unknown,
    externalToolDefinitions: readonly unknown[],
    previousResponseId: string | undefined,
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
    // Off only for the last round of a run that has hit its tool ceiling, so the model answers instead of calling more.
    toolsEnabled = true,
    builtinToolDefinitions: readonly unknown[] = projectToolDefinitions,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    // Mutable for the same reason as the other senders': an image a model refuses is dropped and the request made
    // again, rather than the run ending over an attachment.
    let outgoing: unknown = providerInput;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.pacedFetch(responsesUrl(capability.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: capability.model,
            input: outgoing,
            stream: true,
            ...(toolsEnabled ? { tools: [
              ...toolsForLead(request, [...builtinToolDefinitions, ...externalToolDefinitions]),
              ...(!isLeadRun(request) && supportsImageGenerationTool(capability.provider, capability.model)
                ? [{ type: 'image_generation', model: 'gpt-image-2.5-flare', output_format: 'png' }] : []),
            ], tool_choice: 'auto' } : {}),
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          }),
          signal,
        }, capability, request, apiKey, emit);
      } catch (error) {
        // The transport has already waited or resent as far as is safe; another send could queue a second copy.
        if (error instanceof ModelHostError) throw error;
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (attempt >= maxAttempts) throw error;
        const delayMs = retryDelayMs(baseDelayMs, attempt, undefined);
        emit(lifecycleEvent(
          request,
          'starting',
          `${capability.displayName} connection failed. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
        ));
        await delay(delayMs, signal);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text();
      const message = providerErrorMessage(response.status, detail);
      if (Array.isArray(outgoing) && isImageRefusal(response.status, detail) && hasImageParts(outgoing as Array<{ content?: unknown }>)) {
        outgoing = withoutImageParts(outgoing as Array<{ content?: string | Array<Record<string, unknown>> | null }>, IMAGE_REMOVED_NOTE);
        emit(noticeEvent(request, `${capability.displayName} (${capability.model}) would not take the attached image, so this request was sent without it. Switch to a model that accepts images and send it again.`));
        continue;
      }
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw providerFailure(response.status, message, response.headers.get('retry-after'));
      const delayMs = retryDelayMs(baseDelayMs, attempt, response.headers.get('retry-after'));
      emit(lifecycleEvent(
        request,
        'starting',
        `${capability.displayName} returned ${response.status}. Retrying in ${formatDelay(delayMs)} (attempt ${attempt + 1}/${maxAttempts}).`,
      ));
      await delay(delayMs, signal);
    }

    throw new Error(`${capability.displayName} exhausted retry attempts.`);
  }
}

/**
 * Asks the person before a guard ends their run, through the approval prompt the composer already shows. With nobody
 * to ask - a scheduled or team run, a test - the answer is to finish rather than to wait forever on a question that
 * has no one behind it.
 */
/**
 * A question about the run itself (it is repeating, past its spend limit, or only talking) has to be put on screen as
 * well as registered for an answer. A permission or `ask_user` question announces itself where it is asked; these did
 * not, so the run sat waiting for an answer to a question nobody could see.
 */
function announceRunQuestions(
  approvals: DirectApiApprovalPort | undefined,
  request: AgentRunRequest,
  onEvent: ((event: PersistedEvent) => void) | undefined,
): DirectApiApprovalPort | undefined {
  if (!approvals || !onEvent) return approvals;
  return {
    ...(approvals.requestChoice ? { requestChoice: approvals.requestChoice.bind(approvals) } : {}),
    request: (approval) => {
      // Registered first, so an answer given at once has something to answer.
      const answer = approvals.request(approval);
      if (approval.runQuestion) {
        onEvent({
          schemaVersion: 1,
          id: eventId(),
          taskId: request.conversationId,
          timestamp: nowIso(),
          agent: request.agent,
          type: 'approval.request',
          requestId: approval.requestId,
          title: approval.title,
          detail: approval.detail,
          risk: approval.risk,
          runQuestion: approval.runQuestion,
        });
      }
      return answer;
    },
  };
}

async function askToContinue(
  approvals: DirectApiApprovalPort | undefined,
  question: Omit<DirectApiApprovalRequest, 'requestId'>,
): Promise<'continue' | 'wrap-up'> {
  if (!approvals) return 'wrap-up';
  try {
    const approved = await approvals.request({ requestId: `limit_${randomUUID()}`, ...question });
    return approved ? 'continue' : 'wrap-up';
  } catch {
    // A prompt that cannot be delivered must not strand the run; ending it is the safe reading.
    return 'wrap-up';
  }
}

/**
 * Every question a guard asks about a run ends the same two ways, so they share one pair of labels. The detail line
 * already said "Continue" and "Finish"; the buttons are the part that never did.
 */
const CONTINUE_OR_FINISH: RunQuestion = { continueLabel: 'Continue', finishLabel: 'Finish' };

/** The model has promised work this many times in a row without calling a tool: enough rope before it is interrupted. */
const TALK_ONLY_QUESTION = {
  title: 'This run keeps describing work without doing any',
  detail: 'The model has said what it is about to do many times in a row without calling a tool. Continue gives it another stretch; Finish stops here and keeps what it has written.',
  risk: 'low' as const,
  runQuestion: CONTINUE_OR_FINISH,
};

const SPEND_QUESTION = (costUsd: number, limitUsd: number) => ({
  title: `This run has spent about $${costUsd.toFixed(2)}, past its $${limitUsd.toFixed(2)} limit`,
  detail: 'Continue lifts the per-run limit for the rest of this run. Finish stops here and asks the model to sum up what it has done.',
  risk: 'medium' as const,
  runQuestion: CONTINUE_OR_FINISH,
});

const REPEAT_QUESTION = (message: string) => ({
  title: 'The agent is repeating itself',
  detail: `${message} Continue lets it carry on; Finish stops here and asks it to sum up.`,
  risk: 'medium' as const,
  runQuestion: CONTINUE_OR_FINISH,
});

/**
 * Whether a run failed, and what to say about it.
 *
 * Stopping a run is not a failure — the person did it, and the next instruction is usually already on its way — so an
 * aborted run never fails here.
 *
 * The case that used to be missed: a run whose every tool call was refused by the access level. It answered with prose
 * about what it could not do, and prose counted as output, so the run was scored `completed`. Under Plan access that
 * meant a request to change files could end as a finished run having changed nothing, and Auto could treat it as one.
 */
function runFailure(input: {
  aborted: boolean;
  errors: readonly string[];
  output: string;
  guard: RunGuard;
  displayName: string;
  autonomy: AutonomyMode;
}): { failed: boolean; error?: string } {
  if (input.aborted) return { failed: false };
  if (input.errors.length > 0 || !input.output) {
    return { failed: true, error: input.errors.at(-1) || `${input.displayName} returned no output.` };
  }
  if (input.guard.walledOffByPolicy) {
    return {
      failed: true,
      error: `${input.displayName} could not do anything: every action it tried was refused by this run's access level (${autonomyLabel(input.autonomy)}). Choose a higher access level for the run, or ask for something it is allowed to do.`,
    };
  }
  return { failed: false };
}

function autonomyLabel(autonomy: AutonomyMode): string {
  if (autonomy === 'plan') return 'Plan, which allows no changes';
  if (autonomy === 'ask') return 'Ask, which asks before each change';
  if (autonomy === 'autoEdit') return 'Auto-edit, which allows file edits but not commands';
  if (autonomy === 'full') return 'Full access';
  return 'Custom permissions';
}

function finishProviderRun(input: {
  request: AgentRunRequest;
  capability: DirectApiCapability;
  events: PersistedEvent[];
  emit: (event: PersistedEvent) => void;
  outputParts: string[];
  errors: string[];
  inputTokens?: number;
  /** The part of `inputTokens` the provider served from its cache, which is charged at a fraction. */
  cachedInputTokens?: number;
  outputTokens?: number;
  aborted: boolean;
  guard: RunGuard;
}): AgentExecutionResult {
  const { request, capability, events, emit, outputParts, errors, inputTokens, cachedInputTokens, outputTokens, aborted, guard } = input;
  const output = outputParts.join('').trim();
  const { failed, error } = runFailure({
    aborted,
    errors,
    output,
    guard,
    displayName: capability.displayName,
    autonomy: request.autonomy,
  });

  if (output) events.push(textEvent(request, output));
  if (inputTokens !== undefined || outputTokens !== undefined) {
    emit({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'cost.update',
      inputTokens,
      outputTokens,
      estimateProvenance: 'measured',
      ...costFields(capability.provider, capability.model, inputTokens, outputTokens, cachedInputTokens, hostOf(capability)),
      ...cacheFields(capability.provider, capability.model, inputTokens, cachedInputTokens, hostOf(capability)),
    });
  }
  if (error) {
    emit({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'error',
      message: error,
      recoverable: true,
    });
  }
  emit(lifecycleEvent(
    request,
    aborted ? 'cancelled' : failed ? 'failed' : 'completed',
    aborted ? `${capability.displayName} stopped before it finished.` : failed ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
  ));

  return {
    status: failed || aborted ? 'failed' : 'completed',
    ...(aborted ? { cancelled: true } : {}),
    output,
    outputAgent: request.agent,
    events,
    error,
  };
}

function safeToolArguments(value: string): unknown {
  try {
    return parseToolArguments(value);
  } catch {
    return { _raw: value };
  }
}

export function rememberAnthropicToolCall(
  toolCalls: Map<string, PendingToolCall>,
  block: Record<string, unknown>,
  blockIndex?: number,
): void {
  const callId = stringValue(block.id);
  const name = stringValue(block.name);
  if (!callId || !name) return;
  const existing = toolCalls.get(callId) ?? { key: callId, callId, name, argumentsText: '' };
  existing.name = name;
  if (blockIndex !== undefined) existing.blockIndex = blockIndex;
  // A streamed call starts with an empty input object and then sends its real arguments as JSON fragments, so only a
  // non-empty input is kept here; an empty one would be glued in front of the fragments and break the JSON.
  const input = block.input;
  if (input && typeof input === 'object' && Object.keys(input).length > 0) existing.argumentsText = JSON.stringify(input);
  toolCalls.set(callId, existing);
}

export function rememberAnthropicToolArguments(
  toolCalls: Map<string, PendingToolCall>,
  value: Record<string, unknown>,
  partialJson: string | undefined,
): void {
  const index = integerValue(value.index);
  const existing = index === undefined ? undefined : [...toolCalls.values()].find((call) => call.blockIndex === index);
  // Fragments for a block that was never announced as a tool call cannot be attributed to one; dropping them is safer
  // than appending them to whichever call happens to sit at the same position in the list.
  if (!existing || !partialJson) return;
  existing.argumentsText += partialJson;
}

function rememberGeminiToolCall(
  toolCalls: Map<string, PendingToolCall>,
  functionCall: Record<string, unknown>,
  index: number,
): void {
  const name = stringValue(functionCall.name);
  if (!name) return;
  const key = stringValue(functionCall.id) || `gemini-${index}-${name}`;
  const existing = toolCalls.get(key) ?? { key, callId: key, name, argumentsText: '' };
  existing.name = name;
  if (functionCall.args !== undefined) existing.argumentsText = JSON.stringify(functionCall.args);
  toolCalls.set(key, existing);
}

export function anthropicMessages(
  request: AgentRunRequest,
  history?: readonly DirectApiHistoryTurn[],
): AnthropicMessage[] {
  const turns = history?.length ? history : [{ role: 'user' as const, text: request.prompt }];
  const messages = turns
    .filter((turn) => turn.text.trim())
    .map((turn) => ({ role: turn.role, content: turn.text }));
  return withImages(messages, request, anthropicImagePart);
}

/**
 * The images a run was given, put on the turn being sent rather than the ones already there.
 *
 * They belong with the request they were attached to: the last user turn is the one the person has just written, and
 * the chips are the composer's — it clears them when the turn is sent, so an older turn never has any.
 */
function withImages<T extends { role: string; content?: string | Array<Record<string, unknown>> | null }>(
  messages: T[],
  request: AgentRunRequest,
  part: (image: AttachedImage) => Record<string, unknown>,
): T[] {
  const images = attachedImages(request.contextChips);
  if (images.length === 0) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const parts = images.map(part);
    messages[index] = {
      ...message,
      content: [
        ...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []),
        ...parts,
      ],
    } as T;
    break;
  }
  return messages;
}

function geminiContents(
  request: AgentRunRequest,
  history?: readonly DirectApiHistoryTurn[],
): GeminiContent[] {
  const turns = history?.length ? history : [{ role: 'user' as const, text: request.prompt }];
  const contents: GeminiContent[] = turns
    .filter((turn) => turn.text.trim())
    .map((turn): GeminiContent => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    }));
  const images = attachedImages(request.contextChips);
  if (images.length === 0) return contents;
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index]!;
    if (content.role !== 'user') continue;
    content.parts.push(...images.map(geminiImagePart));
    break;
  }
  return contents;
}

/**
 * Mark the stable prefix of a request (tools, system, and the conversation so far) as cache breakpoints, so the
 * rules and tool list are not billed at full price on each of a run's tool rounds. Only Anthropic's own API is
 * given the field; compatible third-party endpoints may reject unknown keys.
 */
export function withAnthropicPromptCaching(
  baseUrl: string,
  parts: { messages: readonly AnthropicMessage[]; system?: string; tools: Array<Record<string, unknown>> },
): { messages: AnthropicMessage[]; system?: string | Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> } {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // An unparseable base URL is not Anthropic's; send the request unchanged.
  }
  const cache = { type: 'ephemeral' };
  if (host !== 'api.anthropic.com') {
    return {
      messages: [...parts.messages],
      ...(parts.system ? { system: parts.system } : {}),
      ...(parts.tools.length > 0 ? { tools: parts.tools } : {}),
    };
  }
  const messages = parts.messages.map((message) => ({ ...message }));
  const last = messages[messages.length - 1];
  if (last) {
    const blocks: Array<Record<string, unknown>> =
      typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((block) => ({ ...block }));
    if (blocks.length > 0) {
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cache };
      last.content = blocks;
    }
  }
  const tools = parts.tools.map((tool) => ({ ...tool }));
  if (tools.length > 0) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: cache };
  return {
    messages,
    ...(parts.system ? { system: [{ type: 'text', text: parts.system, cache_control: cache }] } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function anthropicToolDefinitions(definitions: readonly unknown[]): Array<Record<string, unknown>> {
  return definitions.flatMap((definition) => {
    const record = asRecord(definition);
    const name = stringValue(record?.name);
    if (!record || record.type !== 'function' || !name) return [];
    return [{
      name,
      description: stringValue(record.description) ?? '',
      input_schema: asRecord(record.parameters) ?? { type: 'object', properties: {} },
    }];
  });
}

function geminiToolDefinitions(definitions: readonly unknown[]): Array<Record<string, unknown>> {
  return definitions.flatMap((definition) => {
    const record = asRecord(definition);
    const name = stringValue(record?.name);
    if (!record || record.type !== 'function' || !name) return [];
    return [{
      name,
      description: stringValue(record.description) ?? '',
      parameters: geminiSchema(asRecord(record.parameters) ?? { type: 'object', properties: {} }),
    }];
  });
}

function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    if (Array.isArray(value)) {
      next[key] = value.map((item) => asRecord(item) ? geminiSchema(asRecord(item)!) : item);
    } else if (value && typeof value === 'object') {
      next[key] = geminiSchema(value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function anthropicToolOutput(callId: string, output: unknown): Record<string, unknown> {
  const { text, images } = toolOutputImages(output);
  return {
    type: 'tool_result',
    tool_use_id: callId,
    content: images.length ? [{ type: 'text', text }, ...images.map(anthropicImagePart)] : text,
  };
}

function geminiToolOutput(name: string, output: unknown): Record<string, unknown> {
  const clean = JSON.parse(toolOutputImages(output).text);
  return {
    functionResponse: {
      name,
      response: clean && typeof clean === 'object' ? clean : { output: clean },
    },
  };
}

/**
 * Runs one `task` call after its arguments have been parsed and its start announced. Shared by the normal
 * sequential path and the parallel batch path so both emit the same events and account for the same spend.
 */
async function executeTaskToolCall(
  request: AgentRunRequest,
  toolRuntime: DesktopProjectToolRuntime,
  callId: string,
  argumentsValue: unknown,
  signal: AbortSignal,
  emit: (event: PersistedEvent) => void,
  taskRun: TaskRun,
  formatOutput: (callId: string, output: unknown) => unknown,
): Promise<unknown> {
  const parsed = taskInputSchema.safeParse(argumentsValue);
  if (!parsed.success) {
    const message = describeArgumentError('task', argumentsValue, parsed.error);
    emit(toolCallEvent(request, 'task', 'failed', argumentsValue, { error: message }, callId));
    return formatOutput(callId, { error: message });
  }
  if (signal.aborted) throw new Error('Provider tool execution was cancelled.');
  const switchedOff = helpersOffRefusal(request);
  if (switchedOff) {
    toolRuntime.guard.noteToolOutcome(false);
    emit(toolCallEvent(request, 'task', 'failed', argumentsValue, { error: switchedOff }, callId));
    return formatOutput(callId, { error: switchedOff });
  }
  const refusal = writingRefusal(request, parsed.data.write === true);
  if (refusal) {
    toolRuntime.guard.noteToolOutcome(false);
    emit(toolCallEvent(request, 'task', 'failed', argumentsValue, { error: refusal }, callId));
    return formatOutput(callId, { error: refusal });
  }
  emit(helperNotice(request, parsed.data.prompt, parsed.data.write === true));
  let output: (TaskResult & Record<string, unknown>) | { error: string };
  try {
    output = await taskRun(parsed.data.prompt, parsed.data.model, parsed.data.write ? { write: true } : undefined);
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  return reportTaskOutput(request, toolRuntime, callId, argumentsValue, output, 'costUsd' in output ? output : undefined, emit, formatOutput);
}

/** Why a helper may not write in this run, or null when it may. A helper cannot ask anyone, so edits must already be allowed. */
function writingRefusal(request: AgentRunRequest, write: boolean): string | null {
  if (!write || WRITING_HELPER_AUTONOMY.has(request.autonomy)) return null;
  return `A helper that writes code needs Auto-edit or Full access, and this run is in ${request.autonomy} mode, where edits are approved one by one. Make the edit yourself, or use a read-only helper to look something up.`;
}

/** Why no helper may be started in this run, or null when helpers are allowed. The composer's Agents choice of 1 means none. */
function helpersOffRefusal(request: AgentRunRequest): string | null {
  if (helperLimitOf(request.helpers) !== 0) return null;
  return 'Helpers are switched off for this run (the composer\'s Agents choice is 1). Do the work yourself.';
}

function helperNotice(request: AgentRunRequest, prompt: string, write: boolean): PersistedEvent {
  return {
    schemaVersion: 1,
    id: eventId(),
    taskId: request.conversationId,
    timestamp: nowIso(),
    agent: request.agent,
    type: 'notice',
    message: `KAI asked a ${write ? 'writing ' : ''}helper agent to work on: ${prompt.slice(0, 200)}`,
  };
}

/**
 * Counts a helper's spend against the run, records how the call ended, and hands the model its result. Shared by a
 * single helper and by a round of writing helpers, so both emit the same events and account for the same spend.
 */
function reportTaskOutput(
  request: AgentRunRequest,
  toolRuntime: DesktopProjectToolRuntime,
  callId: string,
  argumentsValue: unknown,
  output: Record<string, unknown>,
  spend: { costUsd: number; provider?: string; model?: string } | undefined,
  emit: (event: PersistedEvent) => void,
  formatOutput: (callId: string, output: unknown) => unknown,
): unknown {
  if (spend && spend.costUsd > 0) {
    // The helper's spend belongs to this run: the per-run limit and the usage summary both count it.
    toolRuntime.guard.noteExternalCost(spend.costUsd);
    emit({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'cost.update',
      amountUsd: spend.costUsd,
      ...(spend.provider ? { provider: spend.provider } : {}),
      ...(spend.model ? { model: spend.model } : {}),
      estimateProvenance: 'estimated',
    });
  }
  toolRuntime.guard.noteToolOutcome(!('error' in output));
  emit(toolCallEvent(request, 'task', 'error' in output ? 'failed' : 'completed', argumentsValue, output, callId));
  return formatOutput(callId, output);
}

/** A round made only of helper tasks: they do not depend on each other, so they run together. */
async function executeTaskBatch(
  request: AgentRunRequest,
  toolRuntime: DesktopProjectToolRuntime,
  calls: PendingToolCall[],
  signal: AbortSignal,
  emit: (event: PersistedEvent) => void,
  taskRun: TaskRun,
  formatOutput: (callId: string, output: unknown) => unknown,
): Promise<unknown[]> {
  const results: unknown[] = new Array(calls.length);
  const entries = calls.map((call, index) => ({ call, index, callId: call.callId || `call_${randomUUID()}`, argumentsValue: undefined as unknown, ready: false }));

  // Arguments first, so the round can be sorted into helpers that only read and helpers that write.
  for (const entry of entries) {
    try {
      entry.argumentsValue = parseToolArguments(entry.call.argumentsText);
      entry.ready = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolRuntime.guard.noteToolOutcome(false);
      emit(toolCallEvent(request, 'task', 'failed', undefined, { error: message }, entry.callId));
      results[entry.index] = formatOutput(entry.callId, { error: message });
    }
  }

  // Two or more writing helpers in one round must not share the project: each gets its own copy, and the copies are
  // merged afterwards. One writing helper has nobody to clash with, so it takes the ordinary path below.
  const writing = entries.filter((entry) => {
    if (!entry.ready) return false;
    const parsed = taskInputSchema.safeParse(entry.argumentsValue);
    return parsed.success && parsed.data.write === true && writingRefusal(request, true) === null && helpersOffRefusal(request) === null;
  });
  const batched = taskRun.writeBatch && writing.length >= 2 ? new Set(writing) : new Set<(typeof entries)[number]>();
  const others = entries.filter((entry) => entry.ready && !batched.has(entry));

  // The composer's Agents choice is also the most helpers that run at once, when it names a number.
  const helperLimit = helperLimitOf(request.helpers);
  const helperCeiling = helperLimit ? Math.min(MAX_HELPERS_AT_ONCE, helperLimit) : MAX_HELPERS_AT_ONCE;
  let next = 0;
  // At most MAX_HELPERS_AT_ONCE run together and the rest wait their turn, so a model that asks for fifty helpers is
  // served, not refused. The number is Claude Code's own documented default for sub-agents running at once.
  const workers = Array.from({ length: Math.min(helperCeiling, others.length) }, async () => {
    while (next < others.length) {
      const entry = others[next];
      next += 1;
      if (!entry) continue;
      emit(toolCallEvent(request, 'task', 'started', entry.argumentsValue, undefined, entry.callId));
      results[entry.index] = await executeTaskToolCall(request, toolRuntime, entry.callId, entry.argumentsValue, signal, emit, taskRun, formatOutput);
    }
  });

  const writers = batched.size > 0 && taskRun.writeBatch
    ? runWritingRound([...batched], taskRun.writeBatch)
    : Promise.resolve();

  async function runWritingRound(group: Array<(typeof entries)[number]>, writeBatch: NonNullable<TaskRun['writeBatch']>): Promise<void> {
    const tasks: WritingTask[] = [];
    for (const entry of group) {
      const parsed = taskInputSchema.parse(entry.argumentsValue);
      emit(toolCallEvent(request, 'task', 'started', entry.argumentsValue, undefined, entry.callId));
      emit(helperNotice(request, parsed.prompt, true));
      tasks.push({ id: `helper-${tasks.length + 1}`, prompt: parsed.prompt, model: parsed.model });
    }
    const batch = await writeBatch(tasks, signal, helperLimit ?? undefined).catch((error: unknown): WritingBatchResult => ({
      outcomes: tasks.map((task) => ({
        id: task.id, answer: '', costUsd: 0, files: [], check: 'not run', checkOutput: '', applied: false, reran: false,
        error: error instanceof Error ? error.message : String(error),
      })),
      notice: null,
    }));
    if (batch.notice) {
      emit({ schemaVersion: 1, id: eventId(), taskId: request.conversationId, timestamp: nowIso(), agent: request.agent, type: 'notice', message: batch.notice });
    }
    group.forEach((entry, position) => {
      const outcome = batch.outcomes.find((item) => item.id === tasks[position]?.id);
      const described = outcome ? describeOutcome(outcome) : { error: 'The helper did not report back.' };
      const note = batch.notice && position === 0 ? { round_note: batch.notice } : {};
      results[entry.index] = reportTaskOutput(
        request, toolRuntime, entry.callId, entry.argumentsValue, { ...described, ...note },
        outcome ? { costUsd: outcome.costUsd, ...(outcome.provider ? { provider: outcome.provider } : {}), ...(outcome.model ? { model: outcome.model } : {}) } : undefined,
        emit, formatOutput,
      );
    });
  }

  await Promise.all([...workers, writers]);
  return results;
}

/** Read-only helpers one round may run together; more are queued behind them. Writing helpers have their own, lower limit. */
const MAX_HELPERS_AT_ONCE = 20;

async function executeToolCalls(
  request: AgentRunRequest,
  toolRuntime: DesktopProjectToolRuntime,
  calls: PendingToolCall[],
  signal: AbortSignal,
  approvals: DirectApiApprovalPort | undefined,
  externalTools: ExternalToolPort | undefined,
  emit: (event: PersistedEvent) => void,
  /** Runs a read-only helper's nested loop for `explore` and returns its answer. See `runExploreQuery`. */
  explore: (question: string) => Promise<string>,
  /** Runs a nested helper agent and reports its answer and what it cost. See `runTaskQuery`. */
  taskRun: TaskRun,
  formatOutput: (callId: string, output: unknown) => unknown = functionCallOutput,
): Promise<unknown[]> {
  // Helper tasks are independent, so a round made only of them runs concurrently. Mixed rounds stay sequential:
  // a read or edit later in the same round may depend on what came before it.
  if (!isLeadRun(request) && calls.length > 1 && calls.every((call) => call.name === 'task')) {
    return executeTaskBatch(request, toolRuntime, calls, signal, emit, taskRun, formatOutput);
  }
  const results: unknown[] = [];
  for (const call of calls) {
    if (signal.aborted) throw new Error('Provider tool execution was cancelled.');
    const callId = call.callId || `call_${randomUUID()}`;
    const name = call.name || 'unknown';
    let argumentsValue: unknown;
    try {
      argumentsValue = parseToolArguments(call.argumentsText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toolRuntime.guard.noteToolOutcome(false);
      emit(toolCallEvent(request, name, 'failed', undefined, { error: message }, callId));
      results.push(formatOutput(callId, { error: message }));
      continue;
    }

    if (isLeadRun(request) && !leadToolAllowed(name)) {
      const error = 'Lead is read-only. Stop trying to execute this task. Explain the limitation once and prepare a Builder handoff scoped to the user’s selected option; do not broaden it or retry.';
      toolRuntime.guard.requestWrapUp();
      emit(toolCallEvent(request, name, 'failed', argumentsValue, { error, blocked: true }, callId));
      results.push(formatOutput(callId, { error }));
      continue;
    }
    emit(toolCallEvent(request, name, 'started', argumentsValue, undefined, callId));

    // Handled here rather than through the normal policy/execute path: `ask_user` needs the approval port to put
    // a question (not a permission) to a person, and `explore` needs a nested provider loop, neither of which
    // `DesktopProjectToolRuntime.execute` can do on its own.
    if (name === 'ask_user') {
      const parsed = askUserInputSchema.safeParse(argumentsValue);
      if (!parsed.success) {
        const message = describeArgumentError(name, argumentsValue, parsed.error);
        emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: message }, callId));
        results.push(formatOutput(callId, { error: message }));
        continue;
      }
      const approvalRequest: DirectApiApprovalRequest = {
        requestId: `question_${randomUUID()}`,
        tool: name,
        title: parsed.data.question,
        detail: parsed.data.context ?? '',
        risk: 'low',
        options: parsed.data.options,
        allowFreeText: parsed.data.allow_free_text,
      };
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'approval.request',
        requestId: approvalRequest.requestId,
        tool: name,
        title: approvalRequest.title,
        detail: approvalRequest.detail,
        risk: approvalRequest.risk,
        options: approvalRequest.options ? [...approvalRequest.options] : undefined,
        allowFreeText: approvalRequest.allowFreeText,
      });
      const answer = approvals?.requestChoice ? await approvals.requestChoice(approvalRequest) : null;
      const output = answer ? { answer } : { error: 'Nobody answered the question; no approval channel was available for this run.' };
      // Asking a question is not a change, so whether it was answered says nothing about whether the run was walled
      // off. It is not counted as a policy blockage — an unanswered question is its own outcome.
      toolRuntime.guard.noteToolOutcome(Boolean(answer));
      emit(toolCallEvent(request, name, answer ? 'completed' : 'failed', argumentsValue, output, callId));
      results.push(formatOutput(callId, output));
      continue;
    }
    if (name === 'task') {
      results.push(await executeTaskToolCall(request, toolRuntime, callId, argumentsValue, signal, emit, taskRun, formatOutput));
      continue;
    }
    if (name === 'explore') {
      const parsed = exploreInputSchema.safeParse(argumentsValue);
      if (!parsed.success) {
        const message = describeArgumentError(name, argumentsValue, parsed.error);
        emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: message }, callId));
        results.push(formatOutput(callId, { error: message }));
        continue;
      }
      // A notice, not just the tool-call card: the card only appears once the helper has already finished and is
      // collapsed by default, so without this the only sign a helper ran at all was a line easy to miss or expand
      // after the fact. This is said up front, while the helper is still working.
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'notice',
        message: `KAI sent a read-only helper to look into: ${parsed.data.question}`,
      });
      let output: { answer: string } | { error: string };
      try {
        output = { answer: await explore(parsed.data.question) };
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      toolRuntime.guard.noteToolOutcome(!('error' in output));
      emit(toolCallEvent(request, name, 'error' in output ? 'failed' : 'completed', argumentsValue, output, callId));
      results.push(formatOutput(callId, output));
      continue;
    }

    let policy = externalTools?.policy(name, request.autonomy) ?? toolRuntime.policy(name, request.autonomy);
    // User-written project rules sit on top of the mode's own decision. A base deny is never relaxed.
    policy = applyPermissionRules(policy, toolRuntime.permissionRules, { tool: name, input: argumentsValue });
    // Ask-first protects publishing operations, but an explicit Full access choice in
    // the composer authorizes the entire run, including Git commit/push.
    if (
      policy.decision === 'allow'
      && request.autonomy !== 'full'
      && name === 'run_command'
      && isPublishingCommand(String((argumentsValue as { command?: unknown } | null)?.command ?? ''))
    ) {
      policy = {
        decision: 'ask',
        title: 'Publish work off this machine?',
        detail: 'This command pushes commits or changes a shared service such as GitHub or a package registry. Approve it to continue.',
        risk: 'high',
      };
    }
    if (policy.decision === 'deny') {
      // The access level refused this, which is the one refusal that means "the run could not work", as opposed to
      // "the person said no" or "the call failed". See RunGuard.walledOffByPolicy.
      toolRuntime.guard.noteToolOutcome(false, true);
      emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: policy.reason, blocked: true, blockedBy: 'policy' }, callId));
      results.push(formatOutput(callId, { error: policy.reason }));
      continue;
    }
    let preToolContext = '';
    if (toolRuntime.toolHook) {
      try {
        const hook = await toolRuntime.toolHook({
          event: 'preTool',
          tool: name,
          input: argumentsValue,
          autonomy: request.autonomy,
          projectRoot: toolRuntime.rootPath,
          conversationId: request.conversationId,
          signal,
        });
        if (hook.blocked) {
          const reason = `A project preTool hook blocked this call: ${hook.blocked}`;
          toolRuntime.guard.noteToolOutcome(false);
          emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: reason, blocked: true, blockedBy: 'hook' }, callId));
          results.push(formatOutput(callId, { error: reason }));
          continue;
        }
        preToolContext = hook.context;
      } catch (error) {
        // A guard that cannot run must not silently let the call through.
        const reason = `The project's preTool hook could not run, so the call was refused: ${error instanceof Error ? error.message : String(error)}`;
        toolRuntime.guard.noteToolOutcome(false);
        emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: reason, blocked: true, blockedBy: 'hook' }, callId));
        results.push(formatOutput(callId, { error: reason }));
        continue;
      }
    }
    if (policy.decision === 'ask') {
      const approvalRequest: DirectApiApprovalRequest = {
        requestId: `approval_${randomUUID()}`,
        tool: name,
        title: policy.title,
        detail: `${policy.detail}\n\n${truncate(JSON.stringify(argumentsValue, null, 2), MAX_APPROVAL_DETAIL)}`,
        risk: policy.risk,
      };
      emit({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'approval.request',
        requestId: approvalRequest.requestId,
        tool: name,
        title: approvalRequest.title,
        detail: approvalRequest.detail,
        risk: approvalRequest.risk,
      });
      const approved = approvals ? await approvals.request(approvalRequest) : false;
      if (!approved) {
        const reason = 'The user denied this project change.';
        // A no from the person is an answer, not a wall: counted as an attempt that did not succeed, but never as a
        // policy blockage, so a run that asked and was told no is not then called a failure.
        toolRuntime.guard.noteToolOutcome(false);
        emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: reason, blocked: true, blockedBy: 'user' }, callId));
        results.push(formatOutput(callId, { error: reason }));
        continue;
      }
    }

    const execution: ProjectToolExecution = (
      (await externalTools?.execute(name, argumentsValue, signal)) ?? await toolRuntime.execute(name, argumentsValue, signal)
    );
    if (preToolContext) execution.output = withHookContext(execution.output, preToolContext);
    if (toolRuntime.toolHook) {
      try {
        const hook = await toolRuntime.toolHook({
          event: 'postTool',
          tool: name,
          input: argumentsValue,
          output: execution.output,
          autonomy: request.autonomy,
          projectRoot: toolRuntime.rootPath,
          conversationId: request.conversationId,
          signal,
        });
        if (hook.output !== undefined) execution.output = hook.output;
        if (hook.context) execution.output = withHookContext(execution.output, hook.context);
      } catch (error) {
        // The work already happened; a broken observer must not turn it into a failure.
        execution.output = withHookContext(execution.output, `The project's postTool hook could not run: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    toolRuntime.guard.noteToolOutcome(execution.ok);
    if (isLeadRun(request)) {
      const progress = leadToolProgress(toolRuntime).observe(name, argumentsValue, execution.output);
      if (progress.notice) execution.output = { ...(asRecord(execution.output) ?? { result: execution.output }), kaiNotice: progress.notice };
      if (progress.finish) {
        toolRuntime.guard.requestWrapUp();
        emit(noticeEvent(request, 'Lead was rereading unchanged evidence; preparing the answer instead of repeating inspection.'));
      }
    }
    const repeat = isLeadRun(request) ? 'ok' : toolRuntime.guard.recordToolCall(name, argumentsValue, execution.output);
    if (repeat === 'stop') {
      // In an Architect / Implementer run, repeating the same tool result is a build turn going in circles. Hand that
      // turn back to the Architect instead of opening a Continue / Finish question while the Implementer stays active.
      if (request.splitRole === 'implementer' && notifyRepeatDetected(request.conversationId)) {
        execution.output = { ...(asRecord(execution.output) ?? { result: execution.output }), kaiNotice: 'The same tool call and result repeated; handing this turn to the Architect.' };
        emit(toolCallEvent(request, name, execution.ok ? 'completed' : 'failed', argumentsValue, execution.output, callId));
        throw signal.reason ?? new Error('The Architect is taking over after repeated tool calls.');
      }
      // Stuck, not broken: ask rather than throw the run away. Continue sets the count aside, so it takes five more
      // identical calls before the person is bothered again; Finish leaves the run to sum itself up.
      const answer = await askToContinue(approvals, REPEAT_QUESTION(REPEAT_STOP_MESSAGE));
      if (answer === 'wrap-up') toolRuntime.guard.requestWrapUp();
      else toolRuntime.guard.resetRepeat();
      const notice = answer === 'wrap-up' ? REPEAT_STOP_MESSAGE : `${REPEAT_STOP_MESSAGE} Carrying on because you asked.`;
      execution.output = { ...(asRecord(execution.output) ?? { result: execution.output }), kaiNotice: notice };
    }
    if (repeat === 'warn') {
      execution.output = { ...(asRecord(execution.output) ?? { result: execution.output }), kaiNotice: REPEAT_WARNING };
    }
    emit(toolCallEvent(request, name, execution.ok ? 'completed' : 'failed', argumentsValue, execution.output, callId));
    if (execution.changedFile) {
      if (execution.changedFile.action === 'created') {
        emit({
          schemaVersion: 1,
          id: eventId(),
          taskId: request.conversationId,
          timestamp: nowIso(),
          agent: request.agent,
          type: 'file.change',
          path: execution.changedFile.path,
          action: 'created',
        });
      } else {
        emit({
          schemaVersion: 1,
          id: eventId(),
          taskId: request.conversationId,
          timestamp: nowIso(),
          agent: request.agent,
          type: 'file.edit.applied',
          filePath: execution.changedFile.path,
          summary: execution.changedFile.summary,
        });
      }
      // The comparison the activity card opens. It travels with the change, so the row is clickable as soon as the
      // edit lands rather than waiting for a turn summary that only knows the counts.
      if (execution.changedFile.diff) {
        emit({
          schemaVersion: 1,
          id: eventId(),
          taskId: request.conversationId,
          timestamp: nowIso(),
          agent: request.agent,
          type: 'diff.proposal',
          filePath: execution.changedFile.path,
          summary: execution.changedFile.summary,
          diff: execution.changedFile.diff,
          applied: true,
        });
      }
    }
    // The person sees the whole result; the model gets what its window can hold.
    results.push(formatOutput(callId, toolRuntime.outputLimit
      ? await capToolOutput(toolRuntime.rootPath, callId, name, execution.output, toolRuntime.outputLimit)
      : execution.output));
  }
  return results;
}

export { fetchWithHeaderTimeout };

/** A provider that goes quiet in the middle of a reply, for longer than any real pause between chunks. */
const STREAM_IDLE_TIMEOUT_MS = 500_000;
/** A model on the person's own hardware can go quiet far longer: it may still be reading a very large prompt. */
export const OWN_MODEL_STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function streamIdleTimeout(capability: { model?: string; host?: ModelHost }): number {
  return capability.host && capability.host !== 'cloud' ? OWN_MODEL_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
}

function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error(`The provider stopped sending data for ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>, idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS): AsyncGenerator<ProviderStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  const reader = body.getReader();

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line) {
          if (dataLines.length > 0) yield { event: eventName, data: dataLines.join('\n') };
          eventName = '';
          dataLines = [];
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length > 0) yield { event: eventName, data: dataLines.join('\n') };
}

function rememberToolCall(toolCalls: Map<string, PendingToolCall>, item: Record<string, unknown> | undefined): void {
  if (!item || item.type !== 'function_call') return;
  const callId = stringValue(item.call_id);
  const key = stringValue(item.id) || callId || stringValue(item.name);
  if (!key) return;
  const existing = toolCalls.get(key) ?? { key, argumentsText: '' };
  existing.callId = callId ?? existing.callId;
  existing.name = stringValue(item.name) ?? existing.name;
  const argumentsText = stringValue(item.arguments);
  if (argumentsText !== undefined) existing.argumentsText = argumentsText;
  toolCalls.set(key, existing);
}

function rememberToolArguments(
  toolCalls: Map<string, PendingToolCall>,
  value: Record<string, unknown>,
): void {
  const key = stringValue(value.item_id) || stringValue(value.call_id);
  if (!key) return;
  const existing = toolCalls.get(key) ?? { key, argumentsText: '' };
  existing.callId = stringValue(value.call_id) ?? existing.callId;
  existing.name = stringValue(value.name) ?? existing.name;
  const delta = stringValue(value.delta);
  if (delta) existing.argumentsText += delta;
  const complete = stringValue(value.arguments);
  if (complete !== undefined) existing.argumentsText = complete;
  toolCalls.set(key, existing);
}

function rememberChatToolCall(
  toolCalls: Map<number, PendingChatToolCall>,
  delta: Record<string, unknown>,
): void {
  const index = integerValue(delta.index) ?? 0;
  const functionValue = asRecord(delta.function);
  const existing = toolCalls.get(index) ?? { key: String(index), index, argumentsText: '' };
  existing.callId = stringValue(delta.id) ?? existing.callId;
  existing.name = stringValue(functionValue?.name) ?? existing.name;
  const argumentDelta = stringValue(functionValue?.arguments);
  if (argumentDelta) existing.argumentsText += argumentDelta;
  toolCalls.set(index, existing);
}

function chatToolDeltas(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function chatContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => stringValue(asRecord(part)?.text))
    .filter((part): part is string => Boolean(part))
    .join('');
}

export function chatToolOutput(callId: string, output: unknown): ChatMessage {
  const { text, images } = toolOutputImages(output);
  return {
    role: 'tool',
    tool_call_id: callId,
    content: images.length ? [{ type: 'text', text }, ...images.map(openAiImagePart)] : text,
  };
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : undefined;
}

function outputItems(output: unknown): Array<Record<string, unknown> | undefined> {
  return Array.isArray(output) ? output.map((item) => asRecord(item)) : [];
}

function parseToolArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('The provider returned malformed JSON tool arguments.');
  }
}

export function functionCallOutput(callId: string, output: unknown): Record<string, unknown> {
  const { text, images } = toolOutputImages(output);
  return {
    type: 'function_call_output',
    call_id: callId,
    output: images.length ? [{ type: 'input_text', text }, ...images.map((image) => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.base64}` }))] : text,
  };
}

function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/responses$/i.test(trimmed) ? trimmed : `${trimmed}/responses`;
}

export function chatMessages(
  request: AgentRunRequest,
  contextText?: string,
  history?: readonly DirectApiHistoryTurn[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (contextText?.trim()) messages.push({ role: 'system', content: contextText.trim() });
  const turns = history?.length ? history : [{ role: 'user' as const, text: request.prompt }];
  for (const turn of turns) {
    if (turn.text.trim()) messages.push({ role: turn.role, content: turn.text });
  }
  return withImages(messages, request, openAiImagePart);
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/messages$/i.test(trimmed) ? trimmed : `${trimmed}/messages`;
}

function geminiGenerateUrl(baseUrl: string, model: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const modelId = model.trim().replace(/^models\//, '');
  const encoded = encodeURIComponent(modelId);
  if (/:streamGenerateContent$/i.test(trimmed)) return `${trimmed}?alt=sse`;
  return `${trimmed}/models/${encoded}:streamGenerateContent?alt=sse`;
}

function chatCompletionsHeaders(capability: DirectApiCapability, apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(capability.provider === 'openrouter' ? { 'X-Title': 'KAI Desktop' } : {}),
  };
}

function chatToolDefinitions(definitions: readonly unknown[]): Array<Record<string, unknown>> {
  return definitions.flatMap((definition) => {
    const record = asRecord(definition);
    const name = stringValue(record?.name);
    if (!record || record.type !== 'function' || !name) return [];
    return [{
      type: 'function',
      function: {
        name,
        description: stringValue(record.description) ?? '',
        parameters: asRecord(record.parameters) ?? { type: 'object', properties: {} },
      },
    }];
  });
}

/** A 429 becomes a typed error carrying the provider's own wait, so a long job can rest instead of just failing. */
function providerFailure(status: number, message: string, retryAfter: string | null): Error {
  if (status !== 429) return new Error(message);
  const waitMs = parseRetryAfterMs(retryAfter);
  // The failure reaches the caller as text, so the wait is written into it where the detector can read it back.
  return new RateLimitError(waitMs ? `${message} The provider asked to wait ${Math.ceil(waitMs / 1_000)}s.` : message, waitMs);
}

function providerErrorMessage(status: number, detail: string): string {
  const parsed = parseJsonRecord(detail);
  const error = asRecord(parsed?.error);
  const message = stringValue(error?.message) || detail.trim();
  return `Provider request failed (${status})${message ? `: ${message}` : '.'}`;
}

function providerEventError(value: Record<string, unknown>): string | undefined {
  const response = asRecord(value.response);
  const error = asRecord(value.error) ?? asRecord(response?.error);
  return stringValue(error?.message);
}

function responseIdFrom(value: Record<string, unknown>): string | undefined {
  return stringValue(asRecord(value.response)?.id) ?? stringValue(value.response_id);
}

function outputText(output: unknown): string | undefined {
  const parts: string[] = [];
  for (const item of outputItems(output)) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type === 'output_text') {
        const text = stringValue(record.text);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join('') || undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Adds a hook's message to a tool result so the model sees it, without discarding the result itself. */
function withHookContext(output: unknown, context: string): unknown {
  if (!context.trim()) return output;
  const record = asRecord(output);
  return record ? { ...record, kaiHookContext: context } : { result: output, kaiHookContext: context };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(baseDelayMs: number, attempt: number, retryAfter: string | null | undefined): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(exponential, retryAfterMs ?? 0));
}

function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function formatDelay(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds % 1_000 === 0 ? 0 : 1)}s`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Provider retry was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Provider retry was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** Cancelled before any request ever went out — setup (capability/credential/tool-runtime lookup) was still in
 *  flight when Stop landed. */
function cancelledEarly(request: AgentRunRequest): AgentExecutionResult {
  return {
    status: 'failed',
    cancelled: true,
    output: '',
    outputAgent: request.agent,
    events: [lifecycleEvent(request, 'cancelled', `${request.agent} stopped before it started.`)],
    error: undefined,
  };
}

function immediateFailure(request: AgentRunRequest, message: string): AgentExecutionResult {
  return {
    status: 'failed',
    output: '',
    outputAgent: request.agent,
    events: [
      lifecycleEvent(request, 'failed', message),
      {
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'error',
        message,
        recoverable: true,
      },
    ],
    error: message,
  };
}

function textEvent(request: AgentRunRequest, text: string): PersistedEvent {
  return {
    schemaVersion: 1,
    id: eventId(),
    taskId: request.conversationId,
    timestamp: nowIso(),
    agent: request.agent,
    type: 'text.delta',
    channel: 'assistant',
    text,
  };
}

function toolCallEvent(
  request: AgentRunRequest,
  name: string,
  status: 'started' | 'updated' | 'completed' | 'failed',
  input?: unknown,
  output?: unknown,
  /** The call's own id, so its completion can be matched back to its start — what lets `explore` (a nested
   * read-only agent run) be counted as a sub-agent rather than an ordinary tool call. */
  callId?: string,
): PersistedEvent {
  // A tool that answers with pictures (a screenshot, a render, a looked-at image) puts the bytes here, where the
  // conversation can draw them, rather than leaving a megabyte of base64 inside `output` for the card to print.
  const images = output === undefined ? [] : toolOutputImageDataUrls(output);
  return {
    schemaVersion: 1,
    id: eventId(),
    taskId: request.conversationId,
    timestamp: nowIso(),
    agent: request.agent,
    type: 'tool.call',
    name,
    status,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output: withoutImageData(output) }),
    ...(images.length > 0 ? { images } : {}),
    ...(callId === undefined ? {} : { callId }),
  };
}

function lifecycleEvent(
  request: AgentRunRequest,
  status: 'starting' | 'completed' | 'failed' | 'cancelled',
  detail: string,
): PersistedEvent {
  return {
    schemaVersion: 1,
    id: eventId(),
    taskId: request.conversationId,
    timestamp: nowIso(),
    agent: request.agent,
    type: 'agent.lifecycle',
    status,
    detail,
  };
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
