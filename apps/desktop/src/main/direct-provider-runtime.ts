import { randomUUID } from 'node:crypto';
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

interface ChatMessage {
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
const MAX_PROVIDER_ROUNDS = 41;
const MAX_TOOL_ROUNDS = 40;
const DEEPSEEK_MAX_TOOL_ROUNDS = 7;
const DEEPSEEK_WRAP_UP_MESSAGE = 'You have made many tool calls for this task. Stop calling tools now and give a clear final answer: summarize what you have done so far, call out anything left unfinished, and say how to continue if needed.';
const MAX_APPROVAL_DETAIL = 4_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

// DeepSeek is the one Chat Completions provider whose tool round cap (8) sits far below the others.
// OpenRouter and openai-compatible routes can still point at a DeepSeek model, so match on the id too.
function isDeepSeekCapability(capability: DirectApiCapability): boolean {
  return capability.provider === 'deepseek' || capability.model.trim().toLowerCase().includes('deepseek');
}

interface ProviderStreamEvent {
  event: string;
  data: string;
}

interface PendingToolCall {
  key: string;
  callId?: string;
  name?: string;
  argumentsText: string;
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
  /** Stop a run whose estimated cost passes this many USD. Zero disables it; defaults to KAI_MAX_RUN_COST_USD, then the Usage setting. */
  maxRunCostUsd?: number;
}

export class DesktopDirectProviderRuntime {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly settings: DirectApiSettingsPort,
    private readonly credentials: DirectApiCredentialPort,
    private readonly externalTools?: ExternalToolPort,
    private readonly options: DirectProviderRuntimeOptions = {},
  ) {}

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
    let providerInput: unknown = contextText?.trim()
      ? `${contextText.trim()}\n\nUser request:\n${request.prompt}`
      : request.prompt;

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
        const pendingToolCalls = new Map<string, PendingToolCall>();
        let roundEmittedText = false;
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
              outputParts.push(delta);
              roundEmittedText = true;
              onEvent?.(textEvent(request, delta));
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
                outputParts.push(finalText);
                roundEmittedText = true;
                onEvent?.(textEvent(request, finalText));
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
        if (toolCalls.length === 0) break;
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
    // DeepSeek's hard cap is far lower than the generic limit; stop one round early and summarize.
    const toolRoundLimit = isDeepSeekCapability(capability) ? DEEPSEEK_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    let forceFinalAnswer = false;

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
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
        if (toolCalls.length === 0) break;
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          errors.push(`The provider exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`);
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
        // DeepSeek stops accepting tools past its own cap; drop tools from the next request and
        // nudge it to wrap up instead of hitting the hard MAX_TOOL_ROUNDS error.
        if (!forceFinalAnswer && toolRounds >= toolRoundLimit) {
          forceFinalAnswer = true;
          messages.push({ role: 'user', content: DEEPSEEK_WRAP_UP_MESSAGE });
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

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
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
            if (block?.type === 'tool_use') rememberAnthropicToolCall(pendingToolCalls, block);
            const initialText = block?.type === 'text' ? stringValue(block.text) : undefined;
            if (initialText) {
              roundText += initialText;
              outputParts.push(initialText);
              onEvent?.(textEvent(request, initialText));
            }
            continue;
          }
          if (type === 'content_block_delta') {
            const delta = asRecord(value.delta);
            if (delta?.type === 'text_delta') {
              const text = stringValue(delta.text);
              if (text) {
                roundText += text;
                outputParts.push(text);
                onEvent?.(textEvent(request, text));
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
        if (toolCalls.length === 0) break;
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

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
        await this.waitIfPaused(request.conversationId, controller.signal);
        assertRunSpend(toolRuntime, capability, inputTokens, outputTokens);
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
              roundText += text;
              outputParts.push(text);
              onEvent?.(textEvent(request, text));
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
        if (toolCalls.length === 0) break;
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
        response = await fetch(chatCompletionsUrl(capability.baseUrl), {
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
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw new Error(message);
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
        response = await fetch(anthropicMessagesUrl(capability.baseUrl), {
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
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw new Error(message);
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
        response = await fetch(geminiGenerateUrl(capability.baseUrl, capability.model), {
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
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw new Error(message);
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
        response = await fetch(responsesUrl(capability.baseUrl), {
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
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) throw new Error(message);
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

function rememberAnthropicToolCall(
  toolCalls: Map<string, PendingToolCall>,
  block: Record<string, unknown>,
): void {
  const callId = stringValue(block.id);
  const name = stringValue(block.name);
  if (!callId || !name) return;
  const existing = toolCalls.get(callId) ?? { key: callId, callId, name, argumentsText: '' };
  existing.name = name;
  const input = block.input;
  if (input && typeof input === 'object') existing.argumentsText = JSON.stringify(input);
  toolCalls.set(callId, existing);
}

function rememberAnthropicToolArguments(
  toolCalls: Map<string, PendingToolCall>,
  value: Record<string, unknown>,
  partialJson: string | undefined,
): void {
  const index = integerValue(value.index) ?? 0;
  const existing = [...toolCalls.values()].find((call) => call.key === `anthropic-index-${index}`)
    ?? [...toolCalls.values()][index]
    ?? { key: `anthropic-index-${index}`, argumentsText: '' };
  if (partialJson) existing.argumentsText += partialJson;
  toolCalls.set(existing.key, existing);
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

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  const reader = body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
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
