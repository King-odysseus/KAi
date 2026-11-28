/**
 * How KAI sends one request to a model, shared by the agent loop and the helper requester.
 *
 * A cloud provider answers quickly or not at all. A model on the person's own hardware is different: a request can sit
 * in a queue for hours with no headers and no bytes, behind a long video job, and that is not a fault. Node's `fetch`
 * gives up on silent headers after about five minutes and says "fetch failed", which looks like a dropped connection,
 * so the request was sent again and again behind the copy that was still queued. Own-hardware and this-computer
 * requests therefore go through `node:http`, where the only timers are the ones set here.
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { ModelHost } from '@kai/contracts';

export interface ModelWaitStatus {
  state: 'queued' | 'running' | 'busy' | 'queue-full';
  position?: number;
  detail?: string;
}

export type ModelHostErrorKind = 'busy' | 'queue-full' | 'dropped' | 'failed' | 'timeout';

/** A final answer from the transport: the caller must not send the request again on its own. */
export class ModelHostError extends Error {
  constructor(message: string, readonly kind: ModelHostErrorKind) {
    super(message);
    this.name = 'ModelHostError';
  }
}

export interface ModelTiming {
  /** A server that does not accept the connection in this time is not there. */
  connectTimeoutMs: number;
  /** The longest silent wait for the first byte from the person's own hardware. */
  ownHeadersTimeoutMs: number;
  /** The same for a server on this computer, which has no queue but can take a long time over a large prompt. */
  localHeadersTimeoutMs: number;
  pollMs: number;
  statusTimeoutMs: number;
  /** With no status route, how long to stay silent before saying the Mac may be busy. */
  quietNoticeMs: number;
  /** Status checks that may fail in a row, after the gateway has answered one, before the run stops waiting. */
  unreachableLimit: number;
  /** Waits before resending after 503. When they run out the run says why it stopped. */
  busyDelaysMs: readonly number[];
  /** Waits before resending after `model_queue_full`; the last one repeats. */
  queueFullDelaysMs: readonly number[];
  queueFullMaxMs: number;
  /** A failure from a relay after this long is its own time limit rather than a fault. The relay's limit is 600 s. */
  relayCutMs: number;
  /** Wait before resending a request that never reached the server. */
  reconnectDelayMs: number;
}

export const DEFAULT_MODEL_TIMING: ModelTiming = {
  connectTimeoutMs: 10_000,
  ownHeadersTimeoutMs: 4 * 60 * 60 * 1000,
  localHeadersTimeoutMs: 30 * 60 * 1000,
  pollMs: 5_000,
  statusTimeoutMs: 10_000,
  quietNoticeMs: 20_000,
  unreachableLimit: 60,
  busyDelaysMs: [30_000, 60_000, 120_000],
  queueFullDelaysMs: [30_000, 60_000, 120_000],
  queueFullMaxMs: 3 * 60 * 60 * 1000,
  relayCutMs: 550_000,
  reconnectDelayMs: 1_500,
};

export interface ModelFetchOptions {
  host: ModelHost;
  /** The gateway's root address, set only when its status routes can be reached (the home address). */
  statusRoot?: string;
  apiKey?: string;
  onStatus?: (status: ModelWaitStatus) => void;
  /** Replaced in tests. */
  timing?: Partial<ModelTiming>;
}

type ModelRequestInit = RequestInit & { signal: AbortSignal };

/** A provider that accepts the request but never answers would leave the run waiting forever. */
const RESPONSE_HEADERS_TIMEOUT_MS = 500_000;

export async function fetchWithHeaderTimeout(
  url: string,
  init: ModelRequestInit,
  timeoutMs: number = RESPONSE_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  // A dropped connection ("fetch failed": reset, DNS, an idle socket the provider closed) rejects before any headers
  // arrive, so the model never saw the request and sending it again is safe. One such drop used to end a whole run.
  for (let attempt = 0; ; attempt += 1) {
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
      const dropped = error instanceof TypeError && /fetch failed/i.test(error.message);
      if (!dropped || init.signal.aborted || attempt >= 2) throw error;
    } finally {
      clearTimeout(timer);
    }
    await pause(1_500 * (attempt + 1), init.signal);
    if (init.signal.aborted) throw init.signal.reason ?? new Error('Cancelled.');
  }
}

/**
 * Sends a model request the way its host needs. Cloud requests behave as they always have, and the caller's own retry
 * rules apply to them. For the person's own hardware this owns the waiting and the resending: a `ModelHostError` is
 * final, and a 503 or a full queue is handled here and never handed back.
 */
export async function modelFetch(url: string, init: ModelRequestInit, options: ModelFetchOptions): Promise<Response> {
  if (options.host === 'cloud') return fetchWithHeaderTimeout(url, init);
  const timing: ModelTiming = { ...DEFAULT_MODEL_TIMING, ...options.timing };
  if (options.host === 'this-computer') return fetchFromThisComputer(url, init, timing);
  return fetchFromOwnHardware(url, init, options, timing);
}

async function fetchFromThisComputer(url: string, init: ModelRequestInit, timing: ModelTiming): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(url, init, timing.connectTimeoutMs, timing.localHeadersTimeoutMs, init.signal);
    } catch (error) {
      if (!(error instanceof SendFailure)) throw error;
      if (error.timedOut) throw new ModelHostError(`The provider did not respond within ${Math.round(timing.localHeadersTimeoutMs / 1000)} seconds.`, 'timeout');
      // The same words `fetch` uses, so the existing retry and diagnosis rules read it as they did before.
      if (attempt >= 2) throw new TypeError('fetch failed', { cause: error.cause });
      await pause(timing.reconnectDelayMs * (attempt + 1), init.signal);
      throwIfAborted(init.signal);
    }
  }
}

async function fetchFromOwnHardware(
  url: string,
  init: ModelRequestInit,
  options: ModelFetchOptions,
  timing: ModelTiming,
): Promise<Response> {
  let reported = '';
  const report = (status: ModelWaitStatus): void => {
    const key = `${status.state}|${status.position ?? ''}`;
    if (key === reported) return;
    reported = key;
    options.onStatus?.(status);
  };

  let unsent = 0;
  let busy = 0;
  let full = 0;
  let fullWaitedMs = 0;
  let resentAfterDrop = false;

  for (;;) {
    throwIfAborted(init.signal);
    const requestId = options.statusRoot ? `kai-${randomUUID()}` : undefined;
    const giveUp = new AbortController();
    const settled = new AbortController();
    const startedAt = Date.now();
    let quiet: NodeJS.Timeout | undefined;
    if (requestId && options.statusRoot) {
      void watchQueue(options.statusRoot, requestId, options.apiKey, timing, settled.signal, report, (error) => giveUp.abort(error));
    } else {
      quiet = setTimeout(() => report({ state: 'queued', detail: 'No reply yet. The Mac may be busy with another job.' }), timing.quietNoticeMs);
    }

    let response: Response;
    try {
      response = await send(
        url,
        requestId ? withRequestId(init, requestId) : init,
        timing.connectTimeoutMs,
        timing.ownHeadersTimeoutMs,
        AbortSignal.any([init.signal, giveUp.signal]),
      );
    } catch (error) {
      if (!(error instanceof SendFailure)) throw error;
      const waitedMs = Date.now() - startedAt;
      if (error.timedOut) {
        throw new ModelHostError(`The Mac did not answer within ${minutes(timing.ownHeadersTimeoutMs)}. The request was not sent again.`, 'timeout');
      }
      if (!error.sent) {
        // Nothing reached the server, so sending again cannot make a second copy.
        if (unsent >= 2) throw new TypeError('fetch failed', { cause: error.cause });
        unsent += 1;
        await pause(timing.reconnectDelayMs * unsent, init.signal);
        continue;
      }
      if (!options.statusRoot && waitedMs >= timing.relayCutMs) throw relayCut(waitedMs);
      // At home the gateway can say whether it still holds the request. Only when it does not is a resend safe.
      if (requestId && options.statusRoot && !resentAfterDrop && await isGone(options.statusRoot, requestId, options.apiKey, timing, init.signal)) {
        resentAfterDrop = true;
        await pause(timing.reconnectDelayMs, init.signal);
        continue;
      }
      throw new ModelHostError(
        `The connection to the Mac dropped while waiting for a reply (${messageOf(error.cause)}). The request was not sent again, in case it is still queued.`,
        'dropped',
      );
    } finally {
      settled.abort();
      clearTimeout(quiet);
    }

    const elapsedMs = Date.now() - startedAt;
    if (!options.statusRoot && elapsedMs >= timing.relayCutMs && [502, 503, 504, 524].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw relayCut(elapsedMs);
    }
    if (response.status === 503) {
      const detail = errorDetail(await response.text());
      const wait = timing.busyDelaysMs[busy];
      if (wait === undefined) {
        throw new ModelHostError(`The Mac cannot take this request yet (503${detail}). It was tried ${busy + 1} times. Send "continue" to try again.`, 'busy');
      }
      busy += 1;
      const delayMs = Math.max(wait, retryAfterMs(response.headers.get('retry-after')));
      reported = '';
      report({ state: 'busy', detail: `The Mac is short of room${detail}. Trying again in ${seconds(delayMs)}.` });
      await pause(delayMs, init.signal);
      continue;
    }
    if (response.status === 429) {
      const body = await response.text();
      if (!body.includes('model_queue_full')) return new Response(body, { status: 429, headers: response.headers });
      if (fullWaitedMs >= timing.queueFullMaxMs) {
        throw new ModelHostError(`The Mac's queue is still full (model_queue_full) after ${minutes(fullWaitedMs)}. Send "continue" to try again.`, 'queue-full');
      }
      const wait = timing.queueFullDelaysMs[Math.min(full, timing.queueFullDelaysMs.length - 1)] ?? 30_000;
      full += 1;
      const delayMs = Math.max(wait, retryAfterMs(response.headers.get('retry-after')));
      fullWaitedMs += delayMs;
      report({ state: 'queue-full', detail: `The Mac's queue is full. Trying again in ${seconds(delayMs)}.` });
      await pause(delayMs, init.signal);
      continue;
    }
    if (reported) report({ state: 'running' });
    return response;
  }
}

function relayCut(waitedMs: number): ModelHostError {
  return new ModelHostError(
    `The Mac may be busy: no reply came through the relay within ${minutes(waitedMs)}. The request was not sent again. Send "continue" to retry, or use the home address.`,
    'busy',
  );
}

class SendFailure extends Error {
  constructor(readonly cause: unknown, readonly sent: boolean, readonly timedOut: boolean) {
    super(messageOf(cause));
  }
}

/** `fetch` over `node:http`, with a connect timer and a headers timer that are ours and no others. */
function send(
  url: string,
  init: ModelRequestInit,
  connectTimeoutMs: number,
  headersTimeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const body = typeof init.body === 'string' ? Buffer.from(init.body) : undefined;
    if (body) headers['content-length'] = String(body.byteLength);

    let connected = false;
    let incoming: http.IncomingMessage | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let headersTimer: NodeJS.Timeout | undefined;
    const clearTimers = (): void => { clearTimeout(connectTimer); clearTimeout(headersTimer); };

    // A connection of its own each time: a reused idle socket the server had closed looks like a drop after sending.
    const outgoing = (secure ? https : http).request(target, { method: init.method ?? 'GET', headers, agent: false });

    const onAbort = (): void => {
      clearTimers();
      const reason = abortReason(signal);
      incoming?.destroy(reason);
      outgoing.destroy();
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const fail = (cause: unknown, timedOut = false): void => {
      clearTimers();
      signal.removeEventListener('abort', onAbort);
      reject(new SendFailure(cause, connected, timedOut));
      outgoing.destroy();
    };

    outgoing.on('socket', (socket) => {
      connectTimer = setTimeout(() => fail(new Error('the server did not accept the connection')), connectTimeoutMs);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        // Notices a machine that vanished during a long silent wait.
        socket.setKeepAlive(true, 30_000);
      });
    });
    outgoing.on('error', (error) => { if (!incoming) fail(error); });
    outgoing.on('response', (message) => {
      clearTimers();
      connected = true;
      incoming = message;
      message.once('close', () => signal.removeEventListener('abort', onAbort));
      const responseHeaders = new Headers();
      for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
        responseHeaders.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
      }
      const status = message.statusCode ?? 502;
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) message.resume();
      resolve(new Response(empty ? null : bodyStream(message), { status, headers: responseHeaders }));
    });
    headersTimer = setTimeout(() => fail(new Error('no response headers'), true), headersTimeoutMs);
    outgoing.end(body);
  });
}

/**
 * The reply body as a web stream. Node's own `Readable.toWeb` closes its controller a second time when the reader
 * cancels, which throws where nothing can catch it, so the ends are guarded here.
 */
function bodyStream(message: http.IncomingMessage): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const end = (error?: unknown): void => {
        if (finished) return;
        finished = true;
        if (error) controller.error(error);
        else controller.close();
      };
      message.on('data', (chunk: Buffer) => {
        if (finished) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) message.pause();
      });
      // Listened to even when nothing reads the body: an abort destroys the message with an error.
      message.on('error', end);
      message.on('end', () => end());
      message.on('close', () => end(message.complete ? undefined : new TypeError('terminated')));
    },
    pull() {
      message.resume();
    },
    cancel() {
      finished = true;
      message.destroy();
    },
  });
}

interface QueueRecord {
  state: ModelWaitStatus['state'] | 'failed' | 'unknown';
  position?: number;
  detail?: string;
  /** The gateway's own word for the state, shown when KAI does not recognise it. */
  status?: string;
}

function statusUrl(statusRoot: string, requestId: string): string {
  return `${statusRoot.replace(/\/+$/, '')}/api/routing/requests/${encodeURIComponent(requestId)}/`;
}

async function readStatus(
  statusRoot: string,
  requestId: string,
  apiKey: string | undefined,
  timing: ModelTiming,
  signal: AbortSignal,
): Promise<QueueRecord | 'missing' | 'unreachable'> {
  try {
    const response = await fetch(statusUrl(statusRoot, requestId), {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timing.statusTimeoutMs)]),
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) return 'unreachable';
    const value = await response.json() as { status?: unknown; detail?: unknown; position?: unknown };
    const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
    // Matched loosely: only a clear failure changes what KAI does, everything else is shown to the person.
    const state: QueueRecord['state'] = /fail|error|cancel|reject|expired/.test(status) ? 'failed'
      : /queue|wait|pending/.test(status) ? 'queued'
        : /run|work|active|process|start|generat|load/.test(status) ? 'running'
          : 'unknown';
    return {
      state,
      status: status.slice(0, 40),
      ...(typeof value.position === 'number' ? { position: value.position } : {}),
      ...(typeof value.detail === 'string' && value.detail ? { detail: value.detail.slice(0, 300) } : {}),
    };
  } catch {
    return 'unreachable';
  }
}

async function watchQueue(
  statusRoot: string,
  requestId: string,
  apiKey: string | undefined,
  timing: ModelTiming,
  settled: AbortSignal,
  report: (status: ModelWaitStatus) => void,
  giveUp: (error: ModelHostError) => void,
): Promise<void> {
  // A gateway that has never answered a status check may not have the route, so silence then proves nothing.
  let known = false;
  let failed = 0;
  let missing = 0;
  let unreachable = 0;
  while (!settled.aborted) {
    await pause(timing.pollMs, settled);
    if (settled.aborted) return;
    const record = await readStatus(statusRoot, requestId, apiKey, timing, settled);
    if (settled.aborted) return;
    if (record === 'unreachable') {
      unreachable += 1;
      if (known && unreachable >= timing.unreachableLimit) return giveUp(new ModelHostError('The Mac stopped answering status checks, so KAI stopped waiting. The request was not sent again.', 'dropped'));
      continue;
    }
    unreachable = 0;
    if (record === 'missing') {
      missing += 1;
      if (known && missing >= 3) return giveUp(new ModelHostError('The Mac no longer knows about this request, so it will not answer. Send "continue" to try again.', 'failed'));
      // Never seen: the gateway may simply not record this id, so a request that is truly queued must not be thrown
      // away on that alone. The person is told, and decides.
      if (!known && missing >= 3) report({ state: 'queued', detail: 'The Mac has no record of this request. Still waiting; press Stop if this goes on.' });
      continue;
    }
    known = true;
    missing = 0;
    // Twice in a row, so a failure the gateway is about to send as its own reply gets the chance to arrive.
    failed = record.state === 'failed' ? failed + 1 : 0;
    if (failed >= 2) return giveUp(new ModelHostError(`The Mac reports this request failed${record.detail ? `: ${record.detail}` : '.'}`, 'failed'));
    if (record.state === 'queued' || record.state === 'running') {
      report({
        state: record.state,
        ...(record.position !== undefined ? { position: record.position } : {}),
        ...(record.detail ? { detail: record.detail } : {}),
      });
    } else if (record.state === 'unknown') {
      report({
        state: 'queued',
        ...(record.position !== undefined ? { position: record.position } : {}),
        detail: `The Mac reports "${record.status || 'no status'}"${record.detail ? `: ${record.detail}` : ''}. Still waiting; press Stop if this goes on.`,
      });
    }
  }
}

async function isGone(
  statusRoot: string,
  requestId: string,
  apiKey: string | undefined,
  timing: ModelTiming,
  signal: AbortSignal,
): Promise<boolean> {
  const record = await readStatus(statusRoot, requestId, apiKey, timing, signal);
  return record === 'missing' || (record !== 'unreachable' && record.state === 'failed');
}

function withRequestId(init: ModelRequestInit, requestId: string): ModelRequestInit {
  if (typeof init.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return init;
    return { ...init, body: JSON.stringify({ ...body, gateway_request_id: requestId }) };
  } catch {
    return init;
  }
}

function errorDetail(body: string): string {
  let text = body.trim();
  try {
    const value = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } | string };
    const message = typeof value.error === 'string' ? value.error : value.error?.message ?? value.detail;
    if (typeof message === 'string') text = message;
  } catch { /* Plain text is shown as it came. */ }
  return text ? `: ${text.slice(0, 300).replace(/\.+$/, '')}` : '';
}

function retryAfterMs(value: string | null): number {
  const wait = Number(value?.trim() || Number.NaN);
  return Number.isFinite(wait) && wait > 0 ? Math.ceil(wait * 1000) : 0;
}

/** Resolves after the time, or at once when the signal aborts. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function minutes(milliseconds: number): string {
  const value = Math.max(1, Math.round(milliseconds / 60_000));
  return `${value} ${value === 1 ? 'minute' : 'minutes'}`;
}

function seconds(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1000))} seconds`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
