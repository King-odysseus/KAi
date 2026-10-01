import { randomUUID } from 'node:crypto';
import { trimAnthropicToolResults, trimChatToolResults, trimGeminiToolResults } from './context-trimming';
import { directProviderPreset, isLocalProvider, LOCAL_PROVIDER_PLACEHOLDER_KEY, type ProviderId } from '@kai/contracts';
import type {
  AppSettings,
  AgentRunRequest,
  DirectApiCapability,
  PermissionKey,
  PersistedEvent,
} from '@kai/contracts';
import type { AgentExecutionResult } from './agent-runtime';
import { probeLocalServer, type LocalServerProbe } from './local-provider';
import {
  DesktopProjectToolRuntime,
  projectToolDefinitions,
  type ExternalToolPort,
  isPublishingCommand,
  type ProjectToolExecution,
} from './project-tools';
import { estimateCostUsd } from './usage-budget';
import { RateLimitError, RequestPacer } from './rate-limit';
import { DEFAULT_MAX_RUN_COST_USD, maxRunCostFromEnvironment, REPEAT_STOP_MESSAGE, REPEAT_WARNING, RunLimitError } from './run-guard';

function costFields(
  provider: string,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): { provider: string; model?: string; amountUsd?: number } {
  // A model on the user's own machine costs nothing, whatever its name looks like: without this a local
  // "gpt-oss" would be priced as a paid GPT and count against the budget.
  const amountUsd = isLocalProvider(provider as ProviderId) ? 0 : model ? estimateCostUsd(model, inputTokens, outputTokens) : null;
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
  content?: string | null;
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
const MAX_PROVIDER_ROUNDS = 101;
const MAX_TOOL_ROUNDS = 100;
const DEEPSEEK_MAX_TOOL_ROUNDS = 7;
/**
 * DeepSeek refuses more than DEEPSEEK_MAX_TOOL_ROUNDS tool rounds in one request. Rather than cutting the task short and
 * telling the user to finish it, a run continues in a fresh request whose history folds the earlier tool activity into a
 * short summary. These bound the whole run: the cost cap and repeat detection still apply on top.
 */
const DEEPSEEK_MAX_TOTAL_TOOL_ROUNDS = 300;
const DEEPSEEK_MAX_PROVIDER_ROUNDS = 340;
const CONTINUATION_ENTRY_LIMIT = 40;
const CONTINUATION_TEXT_LIMIT = 200;
const DEEPSEEK_WRAP_UP_MESSAGE = 'You have made many tool calls for this task. Stop calling tools now and give a clear final answer: summarize what you have done so far, call out anything left unfinished, and say how to continue if needed.';
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
export function compactChatToolHistory(tail: readonly ChatMessage[]): string {
  const results = new Map<string, ChatMessage>();
  for (const message of tail) {
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  }
  const entries: string[] = [];
  for (const message of tail) {
    if (message.role !== 'assistant') continue;
    const said = message.content?.trim();
    if (said) entries.push(`You said: ${clip(said, CONTINUATION_TEXT_LIMIT)}`);
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      const status = result ? (toolResultFailed(result.content) ? 'failed' : 'ok') : 'no result';
      entries.push(`${call.function.name} ${clip(call.function.arguments, CONTINUATION_TEXT_LIMIT)} -> ${status}${result?.content ? `: ${clip(result.content, CONTINUATION_TEXT_LIMIT)}` : ''}`);
    }
  }
  const shown = entries.slice(-CONTINUATION_ENTRY_LIMIT);
  const omitted = entries.length - shown.length;
  return [
    'Progress so far on this task (your earlier tool calls, oldest first):',
    ...(omitted > 0 ? [`(${omitted} earlier steps not shown)`] : []),
    ...shown.map((entry, index) => `${omitted + index + 1}. ${entry}`),
  ].join('\n');
}

/**
 * True when a reply that used no tools only says what the model is about to do ("Let me read the files"). Some models
 * end their turn there, which would end the run with the work not started.
 */
export function announcesUnfinishedWork(text: string): boolean {
  const said = text.trim();
  if (!said || said.length > 700 || said.endsWith('?')) return false;
  const last = said.split(/\n{2,}/).at(-1) ?? said;
  return /\b(let me|i'll|i will|i'm going to|i am going to|now i(?:'ll| will)?|next,? i)\b/i.test(last);
}

const UNFINISHED_WORK_NUDGE = 'You described what you would do but did not do it. Do it now with your tools. If the task is already complete, say what you did and stop.';
const MAX_UNFINISHED_NUDGES = 3;

/** A blank line to put before the first text of a round when earlier rounds already wrote some, so they do not run together. */
function roundBreak(outputParts: readonly string[]): string {
  const last = outputParts.at(-1);
  return last && !/\s$/.test(last) ? '\n\n' : '';
}

function continuationMessage(summary: string): string {
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

export interface DirectApiApprovalRequest {
  requestId: string;
  tool: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

export interface DirectApiApprovalPort {
  request(approval: DirectApiApprovalRequest): Promise<boolean>;
}

export interface DirectApiProxyRoute {
  baseUrl: string;
  apiKey: string;
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
  probeLocalServer?: (baseUrl: string) => Promise<LocalServerProbe>;
  /** Spaces requests out; Autopilot sets it so a long job stays under the provider's limit. Off by default. */
  pacer?: RequestPacer;
  /** Stop a run whose estimated cost passes this many USD. Zero disables it; defaults to KAI_MAX_RUN_COST_USD, then the Usage setting. */
  maxRunCostUsd?: number;
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
  private async pacedFetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    const pacer = this.pacer;
    if (!pacer) return fetchWithHeaderTimeout(url, init);
    await pacer.acquire(init.signal);
    try {
      const response = await fetchWithHeaderTimeout(url, init);
      pacer.report(response.status);
      return response;
    } finally {
      pacer.release();
    }
  }

  /** Autopilot turns pacing on for the length of a job and off again after. */
  setPacer(pacer: RequestPacer | undefined): void {
    this.pacer = pacer;
  }

  private async newToolRuntime(projectRoot: string, customPermissions?: Partial<Record<PermissionKey, boolean>>): Promise<DesktopProjectToolRuntime> {
    const runtime = new DesktopProjectToolRuntime(projectRoot, customPermissions);
    // The environment variable wins so a script can loosen or tighten the limit without touching settings.
    const fromSettings = await this.settings.load().then((loaded) => loaded.usageBudget.perRunUsd, () => undefined);
    runtime.guard.setMaxCost(this.options.maxRunCostUsd ?? maxRunCostFromEnvironment() ?? fromSettings ?? DEFAULT_MAX_RUN_COST_USD);
    return runtime;
  }

  async capability(): Promise<DirectApiCapability> {
    const settings = await this.settings.load();
    const directApi = settings.directApi;
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
    if (!directApi.model.trim()) {
      return { ...base, available: false, unavailableReason: 'Set a direct API model in Settings.' };
    }
    if (local) {
      // A local server needs no key, but it has to be running and have a model to offer.
      const probe = await (this.options.probeLocalServer ?? probeLocalServer)(directApi.baseUrl);
      if (!probe.reachable) {
        return {
          ...base,
          available: false,
          unavailableReason: `${displayName} is not reachable at ${directApi.baseUrl}. Open LM Studio, start its local server (Developer tab), load a model, then refresh.`,
        };
      }
      if (probe.models.length === 0) {
        return {
          ...base,
          available: false,
          unavailableReason: `${displayName} is running but has no models. Download one in LM Studio (for example Qwen2.5 Coder) and try again.`,
        };
      }
      return { ...base, available: true };
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
    let capability = await this.capability();
    // A model chosen in the composer applies to this run only.
    if (request.model) capability = { ...capability, model: request.model };
    let apiKey: string;
    if (request.route === 'proxy') {
      const preset = directProviderPreset(capability.provider);
      if (!capability.enabled) {
        return immediateFailure(request, 'Direct API mode is disabled in Settings.');
      }
      if (!capability.model.trim()) {
        return immediateFailure(request, 'Set a direct API model in Settings before using the proxy route.');
      }
      if (!this.options.resolveProxyRoute) {
        return immediateFailure(request, 'Universal Proxy routing is not available in this KAI build.');
      }
      try {
        const proxyRoute = await this.options.resolveProxyRoute(request);
        capability = { ...capability, baseUrl: proxyRoute.baseUrl };
        apiKey = proxyRoute.apiKey;
      } catch (error) {
        return immediateFailure(
          request,
          `Universal Proxy route is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      if (!capability.available) {
        return immediateFailure(request, capability.unavailableReason || 'Direct API mode is unavailable.');
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
        return immediateFailure(request, `Credential ${capability.credentialId} is not available.`);
      }
      apiKey = directApiKey ?? LOCAL_PROVIDER_PLACEHOLDER_KEY;
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
        watch,
        approvals,
        contextText,
        history,
        customPermissions,
      );
      if (!(attempt.status === 'failed' && !toolsUsed && !attempt.output.trim() && endpointRejected(attempt.error))) return attempt;
      // The endpoint is not available for this key or model; use the chat endpoint, and do not try again this session.
      this.deepSeekAnthropicRejected = true;
      onEvent?.(lifecycleEvent(request, 'starting', 'DeepSeek\'s Anthropic-style endpoint was not accepted; using its chat endpoint instead.'));
    }
    if (protocol === 'chat-completions') {
      return this.runChatCompletions(
        request,
        projectRoot,
        capability,
        apiKey,
        onEvent,
        approvals,
        contextText,
        history,
        customPermissions,
      );
    }
    if (protocol === 'anthropic-messages') {
      return this.runAnthropicMessages(
        request,
        projectRoot,
        capability,
        apiKey,
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
        onEvent,
        approvals,
        contextText,
        history,
        customPermissions,
      );
    }

    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions);
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await this.externalTools?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    const controller = new AbortController();
    this.activeRuns.set(request.conversationId, controller);
    const outputParts: string[] = [];
    const errors: string[] = [];
    let previousResponseId = resumeResponseId;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;
    let providerInput: unknown = contextText?.trim()
      ? `${contextText.trim()}\n\nUser request:\n${request.prompt}`
      : request.prompt;

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
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
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body)) {
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
            rememberToolCall(pendingToolCalls, asRecord(value.item));
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
            for (const item of outputItems(responseRecord?.output)) rememberToolCall(pendingToolCalls, item);
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
        if (toolCalls.length === 0) {
          if (nudges < MAX_UNFINISHED_NUDGES && announcesUnfinishedWork(roundText)) {
            nudges += 1;
            providerInput = UNFINISHED_WORK_NUDGE;
            continue;
          }
          break;
        }
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          errors.push(`The provider exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`);
          break;
        }
        toolRounds += 1;
        providerInput = await executeToolCalls(
          request,
          toolRuntime,
          toolCalls,
          controller.signal,
          approvals,
          this.externalTools,
          emit,
        );
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    const output = outputParts.join('').trim();
    const failed = !aborted && (errors.length > 0 || !output);
    const error = aborted
      ? `${capability.displayName} run cancelled.`
      : failed
        ? errors.at(-1) || `${capability.displayName} returned no output.`
        : undefined;

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
        ...costFields(capability.provider, capability.model, inputTokens, outputTokens),
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
        failed || aborted ? 'failed' : 'completed',
        failed || aborted ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
      ),
    );

    return {
      status: failed || aborted ? 'failed' : 'completed',
      output,
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
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions);
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await this.externalTools?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    const controller = new AbortController();
    this.activeRuns.set(request.conversationId, controller);
    const messages = chatMessages(request, contextText, history);
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
    const totalToolRoundLimit = deepSeek ? DEEPSEEK_MAX_TOTAL_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    const providerRoundLimit = deepSeek ? DEEPSEEK_MAX_PROVIDER_ROUNDS : MAX_PROVIDER_ROUNDS;
    let segmentRounds = 0;
    let segmentStart = messages.length;
    let forceFinalAnswer = false;
    let nudges = 0;

    try {
      for (let providerRound = 0; providerRound < providerRoundLimit; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
        const trimmedResults = trimChatToolResults(messages);
        if (trimmedResults > 0) emit(lifecycleEvent(request, 'starting', `Trimmed ${trimmedResults} earlier tool results to keep the request small.`));
        const pendingToolCalls = new Map<number, PendingChatToolCall>();
        let roundText = '';
        let roundProviderError: string | undefined;
        const response = await this.requestChatCompletionsResponse(
          request,
          capability,
          apiKey,
          messages,
          externalToolDefinitions,
          controller.signal,
          emit,
          !forceFinalAnswer,
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body)) {
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
          if (roundInputTokens !== undefined) inputTokens = (inputTokens ?? 0) + roundInputTokens;
          if (roundOutputTokens !== undefined) outputTokens = (outputTokens ?? 0) + roundOutputTokens;

          const choice = firstRecord(value.choices);
          const delta = asRecord(choice?.delta);
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
        }

        if (roundProviderError) {
          errors.push(roundProviderError);
          break;
        }

        const toolCalls = [...pendingToolCalls.values()]
          .sort((left, right) => left.index - right.index)
          .filter((call) => call.name);
        if (toolCalls.length === 0) {
          if (!forceFinalAnswer && nudges < MAX_UNFINISHED_NUDGES && announcesUnfinishedWork(roundText)) {
            nudges += 1;
            messages.push({ role: 'assistant', content: roundText });
            messages.push({ role: 'user', content: UNFINISHED_WORK_NUDGE });
            continue;
          }
          break;
        }
        if (toolRounds >= totalToolRoundLimit) {
          errors.push(`The provider exceeded the ${totalToolRoundLimit}-round tool limit.`);
          break;
        }
        toolRounds += 1;
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
          this.externalTools,
          emit,
          chatToolOutput,
        );
        messages.push(...toolResults as ChatMessage[]);
        segmentRounds += 1;
        if (!forceFinalAnswer && segmentRounds >= segmentLimit) {
          if (toolRounds < totalToolRoundLimit) {
            // DeepSeek stops accepting tools past its per-request cap. Fold this block of tool activity into a
            // summary and carry on in a fresh request, so the task is finished rather than handed back half-done.
            const summary = compactChatToolHistory(messages.slice(segmentStart));
            messages.length = segmentStart;
            messages.push({ role: 'user', content: continuationMessage(summary) });
            segmentStart = messages.length;
            segmentRounds = 0;
            emit(lifecycleEvent(request, 'starting', `${capability.displayName} reached its per-request tool limit; continuing in a fresh request.`));
          } else {
            forceFinalAnswer = true;
            messages.push({ role: 'user', content: DEEPSEEK_WRAP_UP_MESSAGE });
          }
        }
      }
    } catch (error) {
      aborted = controller.signal.aborted;
      if (!aborted) errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRuns.delete(request.conversationId);
    }

    const output = outputParts.join('').trim();
    const failed = !aborted && (errors.length > 0 || !output);
    const error = aborted
      ? `${capability.displayName} run cancelled.`
      : failed
        ? errors.at(-1) || `${capability.displayName} returned no output.`
        : undefined;

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
        ...costFields(capability.provider, capability.model, inputTokens, outputTokens),
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
      failed || aborted ? 'failed' : 'completed',
      failed || aborted ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
    ));

    return {
      status: failed || aborted ? 'failed' : 'completed',
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
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions);
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await this.externalTools?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    const controller = new AbortController();
    this.activeRuns.set(request.conversationId, controller);
    const messages = anthropicMessages(request, history);
    const outputParts: string[] = [];
    const errors: string[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
        const trimmedResults = trimAnthropicToolResults(messages);
        if (trimmedResults > 0) emit(lifecycleEvent(request, 'starting', `Trimmed ${trimmedResults} earlier tool results to keep the request small.`));
        const pendingToolCalls = new Map<string, PendingToolCall>();
        let roundText = '';
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
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body)) {
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
            if (roundInputTokens !== undefined) inputTokens = (inputTokens ?? 0) + roundInputTokens + cachedTokens;
            continue;
          }
          if (type === 'content_block_start') {
            const block = asRecord(value.content_block);
            if (block?.type === 'tool_use') rememberAnthropicToolCall(pendingToolCalls, block, integerValue(value.index));
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
            if (delta?.type === 'text_delta') {
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
        if (toolCalls.length === 0) {
          if (nudges < MAX_UNFINISHED_NUDGES && announcesUnfinishedWork(roundText)) {
            nudges += 1;
            messages.push({ role: 'assistant', content: [{ type: 'text', text: roundText }] });
            messages.push({ role: 'user', content: UNFINISHED_WORK_NUDGE });
            continue;
          }
          break;
        }
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          errors.push(`The provider exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`);
          break;
        }
        toolRounds += 1;
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
          this.externalTools,
          emit,
          anthropicToolOutput,
        );
        messages.push({ role: 'user', content: toolResults as Array<Record<string, unknown>> });
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
    });
  }

  private async runGoogleGenerativeAi(
    request: AgentRunRequest,
    projectRoot: string,
    capability: DirectApiCapability,
    apiKey: string,
    onEvent?: (event: PersistedEvent) => void,
    approvals?: DirectApiApprovalPort,
    contextText?: string,
    history?: readonly DirectApiHistoryTurn[],
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
  ): Promise<AgentExecutionResult> {
    const toolRuntime = await this.newToolRuntime(projectRoot, customPermissions);
    let externalToolDefinitions: readonly unknown[] = [];
    try {
      externalToolDefinitions = await this.externalTools?.definitions() ?? [];
    } catch {
      // A broken optional tool provider must not prevent built-in project tools from running.
    }
    const events: PersistedEvent[] = [];
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit(lifecycleEvent(request, 'starting', `${capability.displayName} starting.`));

    const controller = new AbortController();
    this.activeRuns.set(request.conversationId, controller);
    const contents = geminiContents(request, history);
    const outputParts: string[] = [];
    const errors: string[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let aborted = false;
    let toolRounds = 0;
    let nudges = 0;

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
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
        );
        if (!response.body) throw new Error('The provider returned no streaming response body.');

        for await (const streamEvent of readSseEvents(response.body)) {
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
        if (toolCalls.length === 0) {
          if (nudges < MAX_UNFINISHED_NUDGES && announcesUnfinishedWork(roundText)) {
            nudges += 1;
            contents.push({ role: 'model', parts: [{ text: roundText }] });
            contents.push({ role: 'user', parts: [{ text: UNFINISHED_WORK_NUDGE }] });
            continue;
          }
          break;
        }
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          errors.push(`The provider exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`);
          break;
        }
        toolRounds += 1;
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
          this.externalTools,
          emit,
          (callId, output) => geminiToolOutput(
            toolCalls.find((call) => call.callId === callId)?.name || 'unknown',
            output,
          ),
        );
        contents.push({ role: 'user', parts: toolResults as Array<Record<string, unknown>> });
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
    });
  }

  private async waitIfPaused(conversationId: string, signal: AbortSignal): Promise<void> {
    await this.options.waitIfPaused?.(conversationId, signal);
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
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.pacedFetch(chatCompletionsUrl(capability.baseUrl), {
          method: 'POST',
          headers: chatCompletionsHeaders(capability, apiKey),
          body: JSON.stringify({
            model: capability.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(includeTools
              ? { tools: chatToolDefinitions([...projectToolDefinitions, ...externalToolDefinitions]), tool_choice: 'auto' }
              : {}),
          }),
          signal,
        });
      } catch (error) {
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

  private async requestAnthropicResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    messages: readonly AnthropicMessage[],
    system: string | undefined,
    externalToolDefinitions: readonly unknown[],
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const tools = anthropicToolDefinitions([...projectToolDefinitions, ...externalToolDefinitions]);
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
            max_tokens: 8_192,
            stream: true,
            ...withAnthropicPromptCaching(capability.baseUrl, { messages, system: system?.trim(), tools }),
            ...(tools.length > 0 ? { tool_choice: { type: 'auto' } } : {}),
          }),
          signal,
        });
      } catch (error) {
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

  private async requestGoogleResponse(
    request: AgentRunRequest,
    capability: DirectApiCapability,
    apiKey: string,
    contents: readonly GeminiContent[],
    system: string | undefined,
    externalToolDefinitions: readonly unknown[],
    signal: AbortSignal,
    emit: (event: PersistedEvent) => void,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const functionDeclarations = geminiToolDefinitions([...projectToolDefinitions, ...externalToolDefinitions]);
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
        });
      } catch (error) {
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
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.options.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS);
    const baseDelayMs = Math.max(1, this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

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
            input: providerInput,
            stream: true,
            tools: [...projectToolDefinitions, ...externalToolDefinitions],
            tool_choice: 'auto',
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          }),
          signal,
        });
      } catch (error) {
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
}

function assertRunSpend(
  toolRuntime: DesktopProjectToolRuntime,
  capability: DirectApiCapability,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): void {
  if (inputTokens === undefined && outputTokens === undefined) return;
  toolRuntime.guard.assertSpend(costFields(capability.provider, capability.model, inputTokens, outputTokens).amountUsd);
}

function finishProviderRun(input: {
  request: AgentRunRequest;
  capability: DirectApiCapability;
  events: PersistedEvent[];
  emit: (event: PersistedEvent) => void;
  outputParts: string[];
  errors: string[];
  inputTokens?: number;
  outputTokens?: number;
  aborted: boolean;
}): AgentExecutionResult {
  const { request, capability, events, emit, outputParts, errors, inputTokens, outputTokens, aborted } = input;
  const output = outputParts.join('').trim();
  const failed = !aborted && (errors.length > 0 || !output);
  const error = aborted
    ? `${capability.displayName} run cancelled.`
    : failed
      ? errors.at(-1) || `${capability.displayName} returned no output.`
      : undefined;

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
      ...costFields(capability.provider, capability.model, inputTokens, outputTokens),
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
    failed || aborted ? 'failed' : 'completed',
    failed || aborted ? error || `${capability.displayName} failed.` : `${capability.displayName} completed.`,
  ));

  return {
    status: failed || aborted ? 'failed' : 'completed',
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

function anthropicMessages(
  request: AgentRunRequest,
  history?: readonly DirectApiHistoryTurn[],
): AnthropicMessage[] {
  const turns = history?.length ? history : [{ role: 'user' as const, text: request.prompt }];
  return turns
    .filter((turn) => turn.text.trim())
    .map((turn) => ({ role: turn.role, content: turn.text }));
}

function geminiContents(
  request: AgentRunRequest,
  history?: readonly DirectApiHistoryTurn[],
): GeminiContent[] {
  const turns = history?.length ? history : [{ role: 'user' as const, text: request.prompt }];
  return turns
    .filter((turn) => turn.text.trim())
    .map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    }));
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

function anthropicToolOutput(callId: string, output: unknown): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: callId,
    content: JSON.stringify(output),
  };
}

function geminiToolOutput(name: string, output: unknown): Record<string, unknown> {
  return {
    functionResponse: {
      name,
      response: output && typeof output === 'object' ? output : { output },
    },
  };
}

async function executeToolCalls(
  request: AgentRunRequest,
  toolRuntime: DesktopProjectToolRuntime,
  calls: PendingToolCall[],
  signal: AbortSignal,
  approvals: DirectApiApprovalPort | undefined,
  externalTools: ExternalToolPort | undefined,
  emit: (event: PersistedEvent) => void,
  formatOutput: (callId: string, output: unknown) => unknown = functionCallOutput,
): Promise<unknown[]> {
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
      emit(toolCallEvent(request, name, 'failed', undefined, { error: message }));
      results.push(formatOutput(callId, { error: message }));
      continue;
    }

    emit(toolCallEvent(request, name, 'started', argumentsValue));
    let policy = externalTools?.policy(name, request.autonomy) ?? toolRuntime.policy(name, request.autonomy);
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
      emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: policy.reason }));
      results.push(formatOutput(callId, { error: policy.reason }));
      continue;
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
        emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: reason }));
        results.push(formatOutput(callId, { error: reason }));
        continue;
      }
    }

    const execution: ProjectToolExecution = (
      (await externalTools?.execute(name, argumentsValue, signal)) ?? await toolRuntime.execute(name, argumentsValue, signal)
    );
    const repeat = toolRuntime.guard.recordToolCall(name, argumentsValue, execution.output);
    if (repeat === 'stop') {
      emit(toolCallEvent(request, name, 'failed', argumentsValue, { error: REPEAT_STOP_MESSAGE }));
      throw new RunLimitError(REPEAT_STOP_MESSAGE);
    }
    if (repeat === 'warn') {
      execution.output = { ...(asRecord(execution.output) ?? { result: execution.output }), kaiNotice: REPEAT_WARNING };
    }
    emit(toolCallEvent(request, name, execution.ok ? 'completed' : 'failed', argumentsValue, execution.output));
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
    }
    results.push(formatOutput(callId, execution.output));
  }
  return results;
}

/** A provider that accepts the request but never answers would leave the run waiting forever. */
const RESPONSE_HEADERS_TIMEOUT_MS = 90_000;
/** A provider that goes quiet in the middle of a reply, for longer than any real pause between chunks. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export async function fetchWithHeaderTimeout(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  timeoutMs: number = RESPONSE_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  // Only the wait for the response headers is timed. The body streams for as long as the model needs, and the
  // combined signal stays attached to it, so the caller's own abort still stops the stream.
  const slow = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    slow.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([init.signal, slow.signal]) });
  } catch (error) {
    if (timedOut && !init.signal.aborted) throw new Error(`The provider did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function chatToolOutput(callId: string, output: unknown): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: JSON.stringify(output),
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

function functionCallOutput(callId: string, output: unknown): Record<string, unknown> {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify(output),
  };
}

function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/responses$/i.test(trimmed) ? trimmed : `${trimmed}/responses`;
}

function chatMessages(
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
  return messages;
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
): PersistedEvent {
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
    ...(output === undefined ? {} : { output }),
  };
}

function lifecycleEvent(
  request: AgentRunRequest,
  status: 'starting' | 'completed' | 'failed',
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
