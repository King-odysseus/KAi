import { randomUUID } from 'node:crypto';
import { directProviderPreset } from '@kai/contracts';
import type {
  AppSettings,
  AgentRunRequest,
  DirectApiCapability,
  PermissionKey,
  PersistedEvent,
} from '@kai/contracts';
import type { AgentExecutionResult } from './agent-runtime';
import {
  DesktopProjectToolRuntime,
  projectToolDefinitions,
  type ExternalToolPort,
  type ProjectToolExecution,
} from './project-tools';

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
const MAX_PROVIDER_ROUNDS = 9;
const MAX_TOOL_ROUNDS = 8;
const MAX_APPROVAL_DETAIL = 4_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

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
}

export class DesktopDirectProviderRuntime {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly settings: DirectApiSettingsPort,
    private readonly credentials: DirectApiCredentialPort,
    private readonly externalTools?: ExternalToolPort,
    private readonly options: DirectProviderRuntimeOptions = {},
  ) {}

  async capability(): Promise<DirectApiCapability> {
    const settings = await this.settings.load();
    const directApi = settings.directApi;
    const preset = directProviderPreset(directApi.provider);
    const displayName = preset.displayName;
    const credentialStored = await this.credentials.has(directApi.credentialId);
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
    if (preset.protocol === 'unsupported') {
      return {
        ...base,
        available: false,
        unavailableReason: `${displayName} does not use an OpenAI-compatible adapter. Choose OpenRouter to access the same model family through a supported API.`,
      };
    }
    if (!directApi.model.trim()) {
      return { ...base, available: false, unavailableReason: 'Set a direct API model in Settings.' };
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
    let apiKey: string;
    if (request.route === 'proxy') {
      const preset = directProviderPreset(capability.provider);
      if (!capability.enabled) {
        return immediateFailure(request, 'Direct API mode is disabled in Settings.');
      }
      if (preset.protocol === 'unsupported') {
        return immediateFailure(request, `${capability.displayName} cannot be routed through the Universal Proxy adapter.`);
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
      const directApiKey = await this.credentials.get(capability.credentialId);
      if (!directApiKey) {
        return immediateFailure(request, `Credential ${capability.credentialId} is not available.`);
      }
      apiKey = directApiKey;
    }

    if (directProviderPreset(capability.provider).protocol === 'chat-completions') {
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

    const toolRuntime = new DesktopProjectToolRuntime(projectRoot, customPermissions);
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
    const toolRuntime = new DesktopProjectToolRuntime(projectRoot, customPermissions);
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

    try {
      for (let providerRound = 0; providerRound < MAX_PROVIDER_ROUNDS; providerRound += 1) {
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
            tools: chatToolDefinitions([...projectToolDefinitions, ...externalToolDefinitions]),
            tool_choice: 'auto',
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
    const policy = externalTools?.policy(name, request.autonomy) ?? toolRuntime.policy(name, request.autonomy);
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
