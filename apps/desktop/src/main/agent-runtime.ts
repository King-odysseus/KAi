import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentCapability,
  AgentId,
  AgentRunRequest,
  AgentSignInResult,
  AutonomyMode,
  PermissionKey,
  PersistedEvent,
} from '@kai/contracts';

/** How long to keep reading a finished process's output before giving up on pipes a background process still holds. */
const OUTPUT_DRAIN_GRACE_MS = 1_000;

const AGENTS: Record<
  AgentId,
  {
    displayName: string;
    command: string;
    authArgs: string[];
    signInArgs: string[];
    signInCommand: string;
    installUrl: string;
  }
> = {
  claude: {
    displayName: 'Claude',
    command: 'claude',
    authArgs: ['auth', 'status'],
    signInArgs: ['auth', 'login'],
    signInCommand: 'claude auth login',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  codex: {
    displayName: 'Codex',
    command: 'codex',
    authArgs: ['login', 'status'],
    signInArgs: ['login'],
    signInCommand: 'codex login',
    installUrl: 'https://developers.openai.com/codex/quickstart/',
  },
  qwen: {
    displayName: 'Qwen Code',
    command: 'qwen',
    authArgs: ['auth', 'status'],
    signInArgs: ['auth'],
    signInCommand: 'qwen auth',
    installUrl: 'https://github.com/QwenLM/qwen-code',
  },
  gemini: {
    displayName: 'Gemini CLI',
    command: 'gemini',
    authArgs: ['--list-sessions'],
    signInArgs: [],
    signInCommand: 'gemini',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  kimi: {
    displayName: 'Kimi Code',
    command: 'kimi',
    // Kimi Code has no auth-status command; sign-in is read from its config directory instead (see kimiSignedIn).
    authArgs: [],
    signInArgs: ['login'],
    signInCommand: 'kimi login',
    installUrl: 'https://moonshotai.github.io/kimi-code/en/',
  },
};

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'qwen', 'gemini', 'kimi'];

/** Each CLI's official install, as its own docs give it. The npm ones need Node.js 18 or newer. */
export function agentInstallCommand(id: AgentId, platform: NodeJS.Platform = process.platform): string {
  switch (id) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
    case 'qwen':
      return 'npm install -g @qwen-code/qwen-code@latest';
    case 'gemini':
      return 'npm install -g @google/gemini-cli';
    case 'kimi':
      return platform === 'win32'
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"'
        : 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
  }
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed';
  output: string;
  outputAgent: AgentId;
  events: PersistedEvent[];
  sessionId?: string;
  error?: string;
  /**
   * The run was stopped rather than broken. It carries `status: 'failed'` so nothing has to change the shape it
   * expects, but it is not a failure: there is no `error`, no red box in the transcript, and a lifecycle event
   * saying `cancelled`. Callers that care about the difference read this flag instead of matching the word
   * "cancel" in the error text, which is what they used to do and is why a stop could be counted as a crash.
   */
  cancelled?: boolean;
  /** The run failed because the CLI is signed out; the caller should offer Sign in. */
  signInRequired?: boolean;
}

interface ProcessChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A command or tool the CLI reported it was running, as the line said it. */
export interface ParsedToolCall {
  name: string;
  status: 'started' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
  /** The CLI's own id for this call, so a later result line can be matched back to it (e.g. a spawned subagent). */
  callId?: string;
}

/** A file the CLI reported changing, which is how KAI sees the work without reading the whole tree. */
export interface ParsedFileChange {
  path: string;
  action: 'created' | 'edited' | 'deleted';
}

interface ParsedAgentLine {
  text?: string;
  resultText?: string;
  sessionId?: string;
  error?: string;
  tools?: ParsedToolCall[];
  /** Results for tool calls started earlier in the run, matched back to them by `callId`. */
  toolResults?: Array<{ callId: string; status: 'completed' | 'failed' }>;
  changes?: ParsedFileChange[];
  /** What the CLI said the run cost, when it says so at all — claude reports the figure, codex only tokens. */
  cost?: { amountUsd?: number; inputTokens?: number; outputTokens?: number };
}

interface SignInLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type SignInLauncher = (command: string, args: string[], options: SignInLaunchOptions) => Promise<void>;
type InstallLauncher = (commandLine: string, options: SignInLaunchOptions) => Promise<void>;

export interface DesktopAgentRuntimeOptions {
  resolveProxyEnvironment?: (
    agent: AgentId,
    request: AgentRunRequest,
    model?: string,
  ) => Promise<NodeJS.ProcessEnv | null>;
  suspendProcess?: (pid: number) => Promise<void>;
  resumeProcess?: (pid: number) => Promise<void>;
  installLauncher?: InstallLauncher;
}

export interface CliProxyAccess {
  endpoint: string;
  token: string;
}

/** Environment-only routing keeps the CLI's own configuration and credentials untouched. */
export function cliProxyEnvironment(agent: AgentId, access: CliProxyAccess, model?: string): NodeJS.ProcessEnv {
  const baseUrl = `${access.endpoint.replace(/\/+$/, '')}/a/${agent}`;
  if (agent === 'claude') {
    return {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: access.token,
      ANTHROPIC_API_KEY: access.token,
    };
  }
  if (agent === 'codex') {
    return {
      ...process.env,
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      OPENAI_API_KEY: access.token,
      CODEX_API_KEY: access.token,
    };
  }
  if (agent === 'qwen') {
    // buildAgentArgs also passes the base URL as a flag, because ~/.qwen/settings.json can override the environment.
    return {
      ...process.env,
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      OPENAI_API_KEY: access.token,
    };
  }
  if (agent === 'kimi') {
    // KIMI_MODEL_* makes Kimi Code build a temporary provider for this run without writing its config files.
    return {
      ...process.env,
      KIMI_MODEL_NAME: model || 'kimi-for-coding',
      KIMI_MODEL_API_KEY: access.token,
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: `${baseUrl}/v1`,
    };
  }
  throw new Error(`${agent} does not support Universal Proxy routing.`);
}

/**
 * Qwen ignores --openai-base-url when the model name matches a `modelProviders` entry in ~/.qwen/settings.json,
 * and other proxy tools rewrite those entries to their own ports. System settings outrank the user's file, so this
 * run gets a provider entry of its own that points at KAI's proxy. The file holds no secrets; the token stays in the env.
 */
export function qwenProxySettings(proxyBaseUrl: string, model?: string): Record<string, unknown> {
  const id = model || 'qwen-proxy';
  return {
    modelProviders: { openai: [{ id, name: id, baseUrl: proxyBaseUrl, envKey: 'OPENAI_API_KEY' }] },
    model: { name: id },
  };
}

/**
 * Codex ignores OPENAI_BASE_URL and would send the proxy token to api.openai.com, so a proxied run names its own
 * provider through config overrides. The key still comes from OPENAI_API_KEY in the environment.
 */
export function codexProxyProviderArgs(proxyBaseUrl: string): string[] {
  return [
    '-c', 'model_provider="kai-proxy"',
    '-c', 'model_providers.kai-proxy.name="KAI Universal Proxy"',
    '-c', `model_providers.kai-proxy.base_url=${JSON.stringify(proxyBaseUrl)}`,
    '-c', 'model_providers.kai-proxy.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.kai-proxy.wire_api="responses"',
  ];
}

function writeQwenProxySettings(proxyBaseUrl: string, model?: string): string {
  const content = JSON.stringify(qwenProxySettings(proxyBaseUrl, model), null, 2);
  const directory = path.join(tmpdir(), 'kai-qwen-proxy');
  // Named by content, so concurrent runs with the same route share a file and never overwrite each other's.
  const file = path.join(directory, `${createHash('sha256').update(content).digest('hex').slice(0, 16)}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** True when an agent's error text means its CLI has no signed-in account. */
export function isSignInError(message: string): boolean {
  return /not (?:logged|signed) in|please (?:run )?\/?log ?in|run [`'"]?\w+ (?:auth )?login|login required|no authentication method configured|authentication required|invalid api key|oauth token (?:has )?expired|credentials? (?:are |is )?(?:missing|expired)/i.test(message);
}

/**
 * True when a CLI rejected the requested model as unknown or inaccessible. This is worded the same whether the
 * model name is wrong or the CLI predates that model's release, so KAI treats it as a CLI-update hint rather than
 * assuming its own model catalog is at fault.
 */
export function isUnknownModelError(message: string): boolean {
  return /model[^.\n]{0,60}(?:does not exist|doesn't exist|not found|is unknown|is invalid|is not (?:a )?(?:valid|supported|recognized))|issue with the selected model|may not exist or you (?:may not|don't|do not) have access/i.test(message);
}

/**
 * True when a line is an agent CLI reporting that it could not reach an MCP server. That is a statement about the
 * machine, not about the run: an editor that is closed leaves its server down, and Codex prints one of these on
 * every run for as long as a server it was told about stays unreachable. Counting such a line as the run's error
 * blames the request for a server it never used; counting it as the only evidence of failure invents a failure.
 */
export function isMcpTransportNoise(message: string): boolean {
  // Codex's Rust client names its own transport module. Other clients phrase it as a request that never reached a
  // server's `/mcp` endpoint. Neither wording can come from a failure of the request the user actually made.
  return /rmcp::transport/i.test(message) || /error sending request for url\s*\(\s*https?:\/\/[^\s)]*\/mcp\b/i.test(message);
}

interface ActiveAgentRun {
  controller: AbortController;
  child: ChildProcess | null;
  paused: boolean;
}

// How long a capability check (CLI --version plus an auth-status probe, two spawned processes) stays valid for
// the pre-flight check in run(). Explicit callers (Settings' Refresh button, the capabilities list) go straight
// to capability()/capabilities() and always get a live result; only the per-message pre-flight check is cached,
// since paying for two process spawns before every single prompt is what made runs feel slow.
// A capability changes only after sign-in, install, or an explicit refresh (both invalidate this cache).
// Keep normal conversations off the shell process path long enough for consecutive requests to feel immediate.
const CAPABILITY_CACHE_MS = 120_000;

export class DesktopAgentRuntime {
  private readonly activeRuns = new Map<string, ActiveAgentRun>();
  private readonly capabilityCache = new Map<AgentId, { value: AgentCapability; expires: number }>();
  private readonly capabilityRequests = new Map<AgentId, Promise<AgentCapability>>();
  // A CLI has already authoritatively told us that this account cannot use a model. Do not make the user wait
  // through the same failed process launch again; install/sign-in clears it because access may have changed.
  private readonly rejectedModels = new Map<string, string>();

  constructor(
    private readonly commandOverrides: Partial<Record<AgentId, string>> = {},
    private readonly signInLauncher: SignInLauncher = launchDetachedSignIn,
    private readonly options: DesktopAgentRuntimeOptions = {},
  ) {}

  async capabilities(): Promise<AgentCapability[]> {
    return Promise.all(AGENT_ORDER.map((id) => this.capability(id)));
  }

  /** Same result as capability(), but reused across runs within CAPABILITY_CACHE_MS instead of re-spawning the CLI. */
  private async cachedCapability(id: AgentId): Promise<AgentCapability> {
    const cached = this.capabilityCache.get(id);
    if (cached && cached.expires > Date.now()) return cached.value;
    // A quick retry must share the pre-flight probe rather than launch duplicate CLIs.
    const inFlight = this.capabilityRequests.get(id);
    if (inFlight) return inFlight;
    const request = this.capability(id)
      .then((value) => {
        this.capabilityCache.set(id, { value, expires: Date.now() + CAPABILITY_CACHE_MS });
        return value;
      })
      .finally(() => this.capabilityRequests.delete(id));
    this.capabilityRequests.set(id, request);
    return request;
  }

  async capability(id: AgentId): Promise<AgentCapability> {
    const definition = AGENTS[id];
    const command = this.commandFor(id);
    const info = await commandInfo(id, command, ['--version']);
    if (!info.available) {
      const notInstalled = isCommandMissing(info.output, info.detail);
      return {
        id,
        displayName: definition.displayName,
        available: false,
        state: notInstalled ? 'not_installed' : 'unavailable',
        version: info.version,
        unavailableReason: notInstalled
          ? `${definition.displayName} is not installed. Use Install to set it up, then KAI picks it up automatically.`
          : `${definition.displayName} could not start: ${info.detail || 'unknown command error'}`,
        command,
        signInCommand: definition.signInCommand,
        installCommand: agentInstallCommand(id),
        installUrl: definition.installUrl,
        supportsRoutes: supportsProxy(id) ? ['direct', 'proxy'] : ['direct'],
        supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      };
    }

    const auth = id === 'kimi'
      ? { available: kimiSignedIn() }
      : await commandInfo(id, command, definition.authArgs);
    return {
      id,
      displayName: definition.displayName,
      available: auth.available,
      state: auth.available ? 'ready' : 'signed_out',
      version: info.version,
      unavailableReason: auth.available
        ? undefined
        : `${definition.displayName} is installed but not signed in. Use Sign in to connect your account.`,
      command,
      signInCommand: definition.signInCommand,
      installUrl: definition.installUrl,
      supportsRoutes: supportsProxy(id) ? ['direct', 'proxy'] : ['direct'],
      supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
    };
  }

  async install(id: AgentId): Promise<AgentSignInResult> {
    const definition = AGENTS[id];
    const command = agentInstallCommand(id);
    const capability = await this.capability(id);
    if (capability.state !== 'not_installed') {
      return { agent: id, started: false, command, message: `${definition.displayName} is already installed.` };
    }
    try {
      await (this.options.installLauncher ?? launchInstallTerminal)(command, { cwd: homedir(), env: process.env });
      // The install runs in a separate window and finishes later, but drop the cached "not_installed" verdict now
      // so the next run() re-checks live instead of waiting out CAPABILITY_CACHE_MS after the user comes back.
      this.capabilityCache.delete(id);
      this.clearRejectedModels(id);
      return {
        agent: id,
        started: true,
        command,
        message: `${definition.displayName} is installing in a separate window. KAI will notice when it finishes.`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { agent: id, started: false, command, message: `KAI could not open the installer: ${detail}. Run it yourself: ${command}` };
    }
  }

  async signIn(id: AgentId): Promise<AgentSignInResult> {
    const definition = AGENTS[id];
    const capability = await this.capability(id);
    if (capability.state === 'not_installed') {
      return {
        agent: id,
        started: false,
        command: definition.signInCommand,
        message: `${definition.displayName} must be installed before sign-in can start.`,
      };
    }

    try {
      await this.signInLauncher(this.commandFor(id), definition.signInArgs, {
        cwd: homedir(),
        env: process.env,
      });
      this.capabilityCache.delete(id);
      this.clearRejectedModels(id);
      return {
        agent: id,
        started: true,
        command: definition.signInCommand,
        message: `${definition.displayName} sign-in opened in a separate window. Complete the account flow, then refresh agent status.`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        agent: id,
        started: false,
        command: definition.signInCommand,
        message: `KAI could not open ${definition.displayName} sign-in: ${detail}`,
      };
    }
  }

  private clearRejectedModels(agent: AgentId): void {
    for (const key of this.rejectedModels.keys()) {
      if (key.startsWith(`${agent}:`)) this.rejectedModels.delete(key);
    }
  }

  async run(
    request: AgentRunRequest,
    cwd: string,
    resumeSessionId?: string,
    onEvent?: (event: PersistedEvent) => void,
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
    model?: string,
    /** Why KAI chose the model, when it chose it; shown on the run's first line. */
    modelNote?: string,
    /** Local image files already validated by the desktop IPC layer. */
    imagePaths: readonly string[] = [],
  ): Promise<AgentExecutionResult> {
    const definition = AGENTS[request.agent];
    const modelKey = model ? `${request.agent}:${model}` : null;
    const rejectedReason = modelKey ? this.rejectedModels.get(modelKey) : undefined;
    if (rejectedReason) {
      return this.immediateFailure(request, `${definition.displayName} cannot use "${model}" for the current CLI/account. ${rejectedReason}`);
    }
    const capability = await this.cachedCapability(request.agent);
    // The proxy supplies its own credentials, so a CLI that is installed but signed out can still run through it.
    const proxyWithoutAccount = request.route === 'proxy' && capability.state === 'signed_out' && supportsProxy(request.agent);
    if (!capability.available && !proxyWithoutAccount) {
      return this.immediateFailure(
        request,
        `${definition.displayName} is unavailable: ${capability.unavailableReason || 'command not found'}`,
      );
    }
    let environment = process.env;
    if (request.route === 'proxy') {
      if (!supportsProxy(request.agent) || !this.options.resolveProxyEnvironment) {
        return this.immediateFailure(request, `${definition.displayName} does not have a Universal Proxy route in this KAI build.`);
      }
      try {
        environment = await this.options.resolveProxyEnvironment(request.agent, request, model) ?? process.env;
      } catch (error) {
        return this.immediateFailure(
          request,
          `Universal Proxy route is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const proxyBaseUrl = request.route === 'proxy' && (request.agent === 'qwen' || request.agent === 'codex')
      ? environment.OPENAI_BASE_URL
      : undefined;
    if (proxyBaseUrl && request.agent === 'qwen') {
      environment = { ...environment, QWEN_CODE_SYSTEM_SETTINGS_PATH: writeQwenProxySettings(proxyBaseUrl, model) };
    }
    const args = buildAgentArgs(request, cwd, resumeSessionId, customPermissions, model, proxyBaseUrl, imagePaths);
    // Its prompt is an argument. Behind a Windows .cmd shim only the first line would arrive, and Windows caps a
    // command line at a few thousand characters, so say so plainly instead of failing with "command line too long".
    if (request.agent === 'kimi' && process.platform === 'win32') {
      const native = resolveWindowsExecutable(this.commandFor('kimi'), environment);
      const promptIndex = args.indexOf('-p') + 1;
      const kimiPrompt = args[promptIndex];
      if (!native && promptIndex > 0 && kimiPrompt) args[promptIndex] = singleLinePrompt(kimiPrompt);
      const limit = native ? KIMI_WINDOWS_NATIVE_LIMIT : KIMI_WINDOWS_SHIM_LIMIT;
      const needed = args.reduce((total, argument) => total + argument.length + 3, 0);
      if (needed > limit) {
        return this.immediateFailure(
          request,
          `Kimi Code takes its prompt as a command-line argument, and Windows allows about ${limit.toLocaleString('en-US')} characters (this run needs ${needed.toLocaleString('en-US')}). `
          + (native ? 'Use another agent for this part.' : 'Install the native Kimi Code with its PowerShell installer to raise the limit to about 30,000, or use another agent for this part.'),
        );
      }
    }
    const controller = new AbortController();
    const active: ActiveAgentRun = { controller, child: null, paused: false };
    this.activeRuns.set(request.conversationId, active);

    const events: PersistedEvent[] = [lifecycleEvent(request, 'starting', model
      ? `${definition.displayName} starting on ${model}${modelNote ? ` (${modelNote})` : ''}.`
      : `${definition.displayName} starting.`)];
    /**
     * One event, both places it has to be: the window watching the run, and the list this run returns.
     *
     * Only the returned list is saved with the conversation, so an event sent to the window alone would show while
     * the run was going and then disappear when the saved record replaced it. The Direct API runtime emits the same
     * way.
     */
    const emit = (event: PersistedEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    const outputParts: string[] = [];
    const errors: string[] = [];
    let sessionId = resumeSessionId;
    let hasOutputText = false;
    let stdoutCarry = '';
    let stderrCarry = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // Only the Task tool (claude's own sub-agent) is tracked by id, so a result line can mark it done — that is
    // what lets a run report how many sub-agents it has going at once, instead of just the one CLI process.
    const pendingAgentCalls = new Map<string, string>();

    try {
      for await (const chunk of streamProcess(
        this.commandFor(request.agent),
        args,
        cwd,
        controller.signal,
        inputFor(request),
        environment,
        (child) => {
          active.child = child;
        },
      )) {
        if (isProcessResult(chunk)) {
          exitCode = chunk.code;
          exitSignal = chunk.signal;
          continue;
        }

        if (chunk.stream === 'stdout') {
          const buffered = stdoutCarry + chunk.text;
          const lines = buffered.split(/\r?\n/);
          stdoutCarry = lines.pop() ?? '';
          for (const line of lines) consumeLine(line);
        } else {
          const buffered = stderrCarry + chunk.text;
          const lines = buffered.split(/\r?\n/);
          stderrCarry = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = stripAnsi(line.trim());
            // A server the CLI could not reach is not a failure of this run, so it is not kept where the run's
            // error is read from — neither as the reason nor as the sole evidence that there was one.
            if (trimmed && !isMcpTransportNoise(trimmed)) errors.push(trimmed);
          }
        }
      }

      if (stdoutCarry.trim()) consumeLine(stdoutCarry);
      // The line still in the carry never got its newline, and it counts like any other.
      const trailingStderr = stripAnsi(stderrCarry.trim());
      if (trailingStderr && !isMcpTransportNoise(trailingStderr)) errors.push(trailingStderr);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    } finally {
      this.activeRuns.delete(request.conversationId);
      active.child = null;
    }

    const output = outputParts.join('').trim();
    // A stop is the person's own doing, not a failure of the run, so it is reported the way the Direct API path has
    // always reported one: its own lifecycle word, and no error. It used to arrive as a failure carrying the text
    // "run cancelled", which every caller then had to recognise by matching that word.
    const cancelled = controller.signal.aborted;
    const failed = !cancelled && (exitCode !== 0 || (!output && errors.length > 0));
    const rawError = failed
      ? errors.at(-1) || `${definition.displayName} exited with code ${exitCode ?? 'unknown'}${exitSignal ? ` (${exitSignal})` : ''}.`
      : undefined;
    // The CLI rejects a model it does not recognize the same way whether the name is wrong or just newer than the
    // installed CLI build. Since KAI's model list is not the source of truth for what an account can reach, treat
    // this as "update the CLI" rather than "pick a different model".
    const error = failed && model && isUnknownModelError(rawError ?? '')
      ? `${rawError} If "${model}" was released after this copy of ${definition.displayName} was installed, update it and try again: ${agentInstallCommand(request.agent)}`
      : rawError;

    if (modelKey && failed && isUnknownModelError(rawError ?? '')) {
      this.rejectedModels.set(modelKey, `Update ${definition.displayName} or select another model.`);
    } else if (modelKey && !failed && !cancelled) {
      this.rejectedModels.delete(modelKey);
    }

    if (output) {
      events.push({
        schemaVersion: 1,
        id: eventId(),
        taskId: request.conversationId,
        timestamp: nowIso(),
        agent: request.agent,
        type: 'text.delta',
        channel: 'assistant',
        text: output,
      });
    }
    if (error) {
      events.push({
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
    events.push(
      lifecycleEvent(
        request,
        cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        cancelled
          ? `${definition.displayName} stopped before it finished.`
          : failed ? error || `${definition.displayName} failed.` : `${definition.displayName} completed.`,
      ),
    );

    return {
      status: failed || cancelled ? 'failed' : 'completed',
      ...(cancelled ? { cancelled: true } : {}),
      output,
      outputAgent: request.agent,
      events,
      sessionId,
      error,
      // A proxy run failing on credentials is the proxy's key, not the CLI's account.
      ...(failed && request.route !== 'proxy' && [error ?? '', ...errors].some(isSignInError) ? { signInRequired: true } : {}),
    };

    function consumeLine(line: string): void {
      if (!line.trim()) return;
      const parsed = parseAgentLine(line, request.agent);
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.error) errors.push(stripAnsi(parsed.error));
      if (parsed.text) {
        outputParts.push(parsed.text);
        hasOutputText = true;
        onEvent?.(streamTextEvent(request, parsed.text));
      }
      if (!hasOutputText && parsed.resultText) {
        outputParts.push(parsed.resultText);
        hasOutputText = true;
        onEvent?.(streamTextEvent(request, parsed.resultText));
      }
      for (const tool of parsed.tools ?? []) {
        if (tool.name.toLowerCase() === 'task' && tool.callId) pendingAgentCalls.set(tool.callId, tool.name);
      }
      const resolvedAgentCalls: ParsedToolCall[] = [];
      for (const result of parsed.toolResults ?? []) {
        const name = pendingAgentCalls.get(result.callId);
        if (!name) continue;
        pendingAgentCalls.delete(result.callId);
        resolvedAgentCalls.push({ name, status: result.status, callId: result.callId });
      }
      // What the CLI was doing, which is what makes an unattended run legible — and what lets a check the agent ran
      // itself be recorded. Text is left on the path above so nothing is emitted twice.
      const withResolvedAgents = resolvedAgentCalls.length > 0
        ? { ...parsed, tools: [...(parsed.tools ?? []), ...resolvedAgentCalls] }
        : parsed;
      for (const event of lineEvents(request, withResolvedAgents)) emit(event);
    }
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  async pause(conversationId: string): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.paused) return false;
    // No process to hold yet: the run is still starting up, so there is nothing to suspend and saying otherwise
    // would promise a pause that never happened.
    if (!active.child?.pid) return false;
    active.paused = true;
    await (this.options.suspendProcess ?? suspendProcessTree)(active.child.pid);
    return true;
  }

  async resume(conversationId: string): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (!active || !active.paused) return false;
    if (active.child?.pid) {
      await (this.options.resumeProcess ?? resumeProcessTree)(active.child.pid);
    }
    active.paused = false;
    return true;
  }

  private commandFor(id: AgentId): string {
    return this.commandOverrides[id] || AGENTS[id].command;
  }

  private immediateFailure(request: AgentRunRequest, message: string): AgentExecutionResult {
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
}

/**
 * Qwen Code and Gemini CLI take the prompt on stdin and append `-p` to it ("Appended to input on stdin"). A
 * multi-line prompt cannot travel as a Windows command-line argument: cmd.exe ends the command at the first
 * newline, so the agent would receive only the first line.
 */
const STDIN_PROMPT_NOTE = 'Carry out the request above.';

/** What a whole command line may hold on Windows: about 32,000 for a native program, about 8,000 behind cmd.exe. */
export const KIMI_WINDOWS_NATIVE_LIMIT = 30_000;
export const KIMI_WINDOWS_SHIM_LIMIT = 7_500;

/** Newlines flattened to a visible marker, for a CLI that can only receive its prompt as one command-line argument. */
export function singleLinePrompt(prompt: string): string {
  return prompt.replace(/[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*/g, ' \u23CE ');
}

/**
 * The real executable behind a command name on Windows, when it is a native .exe or .com. Those can be started
 * directly, so arguments reach them exactly; npm's .cmd shims cannot and still need cmd.exe.
 */
export function resolveWindowsExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const directories = /[\\/]/.test(command) ? [''] : (pathKey ? environment[pathKey] ?? '' : '').split(';').filter(Boolean);
  const extensions = path.extname(command) ? [''] : ['.com', '.exe', '.bat', '.cmd'];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? path.join(directory, `${command}${extension}`) : `${command}${extension}`;
      if (!existsSync(candidate)) continue;
      // cmd.exe would run whichever of these it finds first, so a .cmd shim found first means no direct start.
      return /\.(?:exe|com)$/i.test(candidate) ? candidate : null;
    }
  }
  return null;
}

export function buildAgentArgs(
  request: Pick<AgentRunRequest, 'agent' | 'prompt' | 'autonomy'>,
  cwd: string,
  resumeSessionId?: string,
  customPermissions?: Partial<Record<PermissionKey, boolean>>,
  model?: string,
  proxyBaseUrl?: string,
  imagePaths: readonly string[] = [],
): string[] {
  // Every supported CLI takes the model as `--model <name>`; without one the CLI keeps its own default.
  const modelArgs = model ? ['--model', model] : [];
  if (request.agent === 'codex') {
    const providerArgs = proxyBaseUrl ? codexProxyProviderArgs(proxyBaseUrl) : [];
    const imageArgs = imagePaths.flatMap((imagePath) => ['--image', imagePath]);
    // Full access is an explicit user choice in the composer. Preserve it when a
    // conversation resumes, otherwise Codex falls back to interactive approvals.
    const fullAccessArgs = request.autonomy === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
    if (resumeSessionId) return ['exec', ...providerArgs, 'resume', resumeSessionId, '--json', ...fullAccessArgs, ...modelArgs, ...imageArgs, '-'];
    return [
      'exec',
      ...providerArgs,
      '--json',
      ...fullAccessArgs,
      ...modelArgs,
      '--sandbox',
      codexSandbox(request.autonomy, customPermissions),
      '--skip-git-repo-check',
      '--cd',
      cwd,
      ...imageArgs,
      '-',
    ];
  }

  if (request.agent === 'claude') {
    const permissionMode = claudePermission(request.autonomy, customPermissions);
    // stream-json, not one JSON result at the end: it reports each message as it is written and names the tools the
    // run used, which is the difference between a claude run being legible while it works and being a blank hour
    // followed by a paragraph. `--verbose` is what the format requires. The CLI's own notices go to stderr, so they
    // never reach the reply.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
    if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    args.push(...modelArgs);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    return args;
  }

  if (request.agent === 'qwen') {
    const args = ['--output-format', 'stream-json', '--approval-mode', qwenApproval(request.autonomy), ...modelArgs];
    if (proxyBaseUrl) args.push('--auth-type', 'openai', '--openai-base-url', proxyBaseUrl);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push('-p', STDIN_PROMPT_NOTE);
    return args;
  }

  if (request.agent === 'kimi') {
    const args = ['-p', request.prompt, '--output-format', 'stream-json', ...kimiApproval(request.autonomy), ...modelArgs];
    if (resumeSessionId) args.push('--session', resumeSessionId);
    return args;
  }

  const args = [
    '-p',
    STDIN_PROMPT_NOTE,
    '--output-format',
    'stream-json',
    '--approval-mode',
    geminiApproval(request.autonomy),
    '--skip-trust',
    ...modelArgs,
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

function inputFor(request: Pick<AgentRunRequest, 'agent' | 'prompt'>): string | undefined {
  // Kimi Code is the only CLI here that still takes its prompt as an argument (see run()).
  return request.agent === 'kimi' ? undefined : request.prompt;
}

function codexSandbox(
  autonomy: AutonomyMode,
  customPermissions?: Partial<Record<PermissionKey, boolean>>,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (autonomy === 'autoEdit') return 'workspace-write';
  if (autonomy === 'full') return 'danger-full-access';
  if (autonomy === 'custom' && customPermissions?.workspaceEdit) return 'workspace-write';
  return 'read-only';
}

function claudePermission(
  autonomy: AutonomyMode,
  customPermissions?: Partial<Record<PermissionKey, boolean>>,
): 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default' {
  if (autonomy === 'custom') return customPermissions?.workspaceEdit ? 'acceptEdits' : 'default';
  if (autonomy === 'autoEdit') return 'acceptEdits';
  if (autonomy === 'full') return 'bypassPermissions';
  return 'plan';
}

function qwenApproval(autonomy: AutonomyMode): 'plan' | 'auto-edit' | 'yolo' {
  if (autonomy === 'custom') return 'auto-edit';
  if (autonomy === 'autoEdit') return 'auto-edit';
  if (autonomy === 'full') return 'yolo';
  return 'plan';
}

function kimiApproval(autonomy: AutonomyMode): string[] {
  if (autonomy === 'custom' || autonomy === 'autoEdit') return ['--yolo'];
  if (autonomy === 'full') return ['--auto'];
  return ['--plan'];
}

function geminiApproval(autonomy: AutonomyMode): 'plan' | 'auto_edit' | 'yolo' {
  if (autonomy === 'custom') return 'auto_edit';
  if (autonomy === 'autoEdit') return 'auto_edit';
  if (autonomy === 'full') return 'yolo';
  return 'plan';
}

export function parseAgentLine(line: string, agent: AgentId): ParsedAgentLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { text: `${stripAnsi(line)}\n` };
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const value = parsed as Record<string, unknown>;

  if (agent === 'codex') {
    if (value.type === 'thread.started' && typeof value.thread_id === 'string') {
      return { sessionId: value.thread_id };
    }
    const item = asRecord(value.item);
    if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      return { resultText: item.text };
    }
    // What the CLI did, as `codex exec --json` reports it. The tool is named `run_command` rather than codex's own
    // `command_execution` because the rest of KAI reads that name: the verification record and the command card both
    // look for a command in the call's input, and the exit code in its output.
    if (item?.type === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '';
      if (value.type === 'item.started' && command) {
        return { tools: [{ name: 'run_command', status: 'started', input: { command } }] };
      }
      if (value.type === 'item.completed' && command) {
        return {
          tools: [{
            name: 'run_command',
            status: item.exit_code === 0 ? 'completed' : 'failed',
            input: { command },
            output: {
              ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
              ...(typeof item.aggregated_output === 'string' ? { output: item.aggregated_output } : {}),
            },
          }],
        };
      }
    }
    if (value.type === 'item.completed' && item?.type === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const mapped = changes.flatMap((change) => {
        const record = asRecord(change);
        const path = typeof record?.path === 'string' ? record.path : '';
        if (!path) return [];
        const kind = typeof record?.kind === 'string' ? record.kind : 'update';
        return [{
          path,
          action: (kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'edited') as ParsedFileChange['action'],
        }];
      });
      if (mapped.length > 0) return { changes: mapped };
    }
    const error = errorText(value);
    return error ? { error } : {};
  }

  if (agent === 'claude') {
    const sessionId = commonSessionId(value);
    if (value.type === 'result') {
      const usage = asRecord(value.usage);
      const amountUsd = typeof value.total_cost_usd === 'number' ? value.total_cost_usd : undefined;
      return {
        sessionId,
        resultText: typeof value.result === 'string' ? value.result : undefined,
        error: errorText(value),
        ...(amountUsd === undefined ? {} : {
          cost: {
            amountUsd,
            ...(typeof usage?.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage?.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
          },
        }),
      };
    }
    if (value.type === 'assistant' || value.type === 'message') {
      return { sessionId, text: textFromClaudeMessage(value.message), tools: toolCallsFromClaudeMessage(value.message) };
    }
    // Carries the Task tool's result (and every other tool's), so a spawned sub-agent can be marked done rather
    // than showing as running for the rest of the turn.
    if (value.type === 'user') {
      return { sessionId, toolResults: toolResultsFromClaudeMessage(value.message) };
    }
    return { sessionId, error: errorText(value) };
  }

  if (agent === 'kimi') {
    // Kimi Code prints one chat message per line; only assistant messages are reply text (tool results are not).
    const error = errorText(value);
    if (error) return { error };
    if (value.role !== 'assistant') return { sessionId: commonSessionId(value) };
    return { sessionId: commonSessionId(value), text: textFromFlatValue(value.content) ?? textFromClaudeMessage(value) };
  }

  const error = errorText(value);
  if (error) return { error };
  const sessionId = commonSessionId(value);
  if (value.type === 'assistant') {
    return { sessionId, text: textFromClaudeMessage(value.message) };
  }
  const candidateText = textFromCandidates(value.candidates);
  if (candidateText) return { sessionId, text: candidateText };
  const text = textFromFlatValue(value.delta)
    || textFromFlatValue(value.text)
    || textFromFlatValue(value.content)
    || textFromFlatValue(value.message);
  if (text) return { sessionId, text };
  if (typeof value.result === 'string') return { sessionId, resultText: value.result };
  return { sessionId };
}

function textFromClaudeMessage(message: unknown): string | undefined {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (asRecord(block)?.type === 'text' ? asRecord(block)?.text : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text || undefined;
}

/** The tools a Claude message asked for, named the way its `tool_use` blocks name them. */
function toolCallsFromClaudeMessage(message: unknown): ParsedToolCall[] | undefined {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return undefined;
  const calls = content.flatMap((block) => {
    const record = asRecord(block);
    if (record?.type !== 'tool_use' || typeof record.name !== 'string') return [];
    return [{
      name: record.name,
      status: 'started' as const,
      ...(record.input === undefined ? {} : { input: record.input }),
      ...(typeof record.id === 'string' ? { callId: record.id } : {}),
    }];
  });
  return calls.length > 0 ? calls : undefined;
}

/**
 * The `tool_result` blocks a claude `user` message carries back, keyed by the `tool_use_id` they answer. Only the
 * Task tool (claude's own sub-agent) is tracked end to end today — that is the "N agents" count — so its name is
 * remembered in the run loop and matched back to these ids; other tools stay "started" for the run's duration.
 */
function toolResultsFromClaudeMessage(message: unknown): Array<{ callId: string; status: 'completed' | 'failed' }> | undefined {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return undefined;
  const results = content.flatMap((block) => {
    const record = asRecord(block);
    if (record?.type !== 'tool_result' || typeof record.tool_use_id !== 'string') return [];
    return [{ callId: record.tool_use_id, status: record.is_error ? ('failed' as const) : ('completed' as const) }];
  });
  return results.length > 0 ? results : undefined;
}

function textFromCandidates(candidates: unknown): string | undefined {
  if (!Array.isArray(candidates)) return undefined;
  const first = asRecord(candidates[0]);
  const parts = asRecord(first?.content)?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((part) => asRecord(part)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text || undefined;
}

function textFromFlatValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function commonSessionId(value: Record<string, unknown>): string | undefined {
  for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId']) {
    if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  }
  const result = asRecord(value.result);
  if (result) return commonSessionId(result);
  return undefined;
}

function errorText(value: Record<string, unknown>): string | undefined {
  if (typeof value.error === 'string') return value.error;
  const error = asRecord(value.error);
  if (typeof error?.message === 'string') return error.message;
  if (value.type === 'error' && typeof value.message === 'string') return value.message;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isCommandMissing(...values: Array<string | undefined>): boolean {
  const detail = values.filter(Boolean).join('\n');
  return /(?:not recognized|command not found|no such file or directory|is not installed|cannot find the (?:path|file))/i.test(
    detail,
  );
}

/** A visible terminal that stays open, so the user can read the installer's output and any error. */
async function launchInstallTerminal(commandLine: string, options: SignInLaunchOptions): Promise<void> {
  const [command, args, extra] = process.platform === 'win32'
    // Verbatim so cmd, not Node, parses the line; the Kimi pipe sits inside quotes and reaches PowerShell intact.
    ? ['cmd.exe', ['/d', '/c', `start "KAI install" cmd.exe /k ${commandLine}`], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin'
      ? ['osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(commandLine)}`], {}]
      : ['x-terminal-emulator', ['-e', 'sh', '-c', `${commandLine}; exec sh`], {}];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { ...extra, cwd: options.cwd, env: options.env, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

async function launchDetachedSignIn(
  command: string,
  args: string[],
  options: SignInLaunchOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const useShell = process.platform === 'win32';
    const child = spawn(useShell ? quoteWinArg(command) : command, useShell ? args.map(quoteWinArg) : args, {
      cwd: options.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: useShell,
      env: options.env,
    });
    let settled = false;
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function commandInfo(
  agent: AgentId,
  command: string,
  args: string[],
): Promise<{ available: boolean; version?: string; detail?: string; output?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    let error = '';
    let settled = false;
    const finish = (detail: { available: boolean; version?: string; detail?: string; output?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(detail);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ available: false, detail: `${command} ${args.join(' ')} timed out.` });
    }, 5_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', (caught) => finish({ available: false, detail: caught.message }));
    child.on('close', (code) => {
      const combined = stripAnsi((output || error).trim());
      if (code === 0 && args[0] === '--version') {
        finish({ available: true, version: combined || undefined, output: combined });
      } else if (code === 0 && isAuthenticated(agent, combined)) {
        finish({ available: true, output: combined });
      } else if (code === 0) {
        finish({ available: false, detail: combined || 'No signed-in account was reported.' });
      } else {
        finish({ available: false, detail: combined || `Exited with ${code}` });
      }
    });
  });
}

function isAuthenticated(agent: AgentId, output: string): boolean {
  if (agent === 'codex') return /logged in/i.test(output);
  if (agent === 'claude') {
    try {
      return (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      return /loggedIn["']?\s*:\s*true/i.test(output);
    }
  }
  if (agent === 'qwen') {
    return !/no authentication method configured/i.test(output) && /authentication (?:method|status)|status:/i.test(output);
  }
  return true;
}

export async function* streamProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  stdin?: string,
  environment: NodeJS.ProcessEnv = process.env,
  onSpawn?: (child: ChildProcess) => void,
): AsyncIterable<ProcessChunk | ProcessResult> {
  const executable = resolveWindowsExecutable(command, environment);
  const useShell = process.platform === 'win32' && !executable;
  const child = spawn(executable ?? (useShell ? quoteWinArg(command) : command), useShell ? args.map(quoteWinArg) : args, {
    cwd,
    shell: useShell,
    windowsHide: true,
    env: environment,
  });
  onSpawn?.(child);

  if (stdin !== undefined) {
    child.stdin?.write(stdin);
    child.stdin?.end();
  } else {
    child.stdin?.end();
  }

  const queue: Array<ProcessChunk | ProcessResult> = [];
  let done = false;
  let notify: (() => void) | undefined;
  const push = (item: ProcessChunk | ProcessResult): void => {
    queue.push(item);
    notify?.();
    notify = undefined;
  };
  const abort = (): void => {
    if (child.killed) return;
    // child.kill() alone only reaches the process node spawned directly. On Windows that is cmd.exe when the
    // CLI is an npm .cmd shim (useShell), so the real CLI process underneath survives and keeps running.
    if (child.pid) void killProcessTree(child.pid);
    else child.kill();
  };

  signal.addEventListener('abort', abort, { once: true });
  child.stdout?.on('data', (chunk) => push({ stream: 'stdout', text: chunk.toString() }));
  child.stderr?.on('data', (chunk) => push({ stream: 'stderr', text: chunk.toString() }));
  child.on('error', (error) => {
    push({ stream: 'stderr', text: error.message });
    done = true;
    push({ code: 1, signal: null });
  });
  // 'close' also waits for every process holding the CLI's output pipes. A tool the CLI started in the background
  // (a dev server, a watcher) can keep them open indefinitely, which would leave the run looking stuck long after
  // the agent finished. Once the CLI itself has exited, give its last output a moment and then stop waiting.
  let finished = false;
  const finishRun = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    child.stdout?.destroy();
    child.stderr?.destroy();
    done = true;
    push({ code, signal: closeSignal });
  };
  child.on('close', finishRun);
  child.on('exit', (code, closeSignal) => {
    const grace = setTimeout(() => finishRun(code, closeSignal), OUTPUT_DRAIN_GRACE_MS);
    grace.unref();
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => { notify = resolve; });
      continue;
    }
    yield queue.shift()!;
  }
}

function supportsProxy(agent: AgentId): boolean {
  return agent === 'claude' || agent === 'codex' || agent === 'qwen' || agent === 'kimi';
}

/** Kimi Code keeps OAuth credentials and configured providers under KIMI_CODE_HOME (default ~/.kimi-code). */
export function kimiSignedIn(home = process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code')): boolean {
  try {
    const credentials = path.join(home, 'credentials');
    if (existsSync(credentials) && readdirSync(credentials).length > 0) return true;
    const config = path.join(home, 'config.toml');
    return existsSync(config) && /^\s*\[providers\./m.test(readFileSync(config, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Ends a run's whole process tree, not just the directly spawned handle. Needed because a cancelled run is often
 * a shell (cmd.exe on Windows, /bin/sh elsewhere) wrapping the actual CLI process as a child of its own.
 */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  const descendants = [pid];
  for (let index = 0; index < descendants.length; index += 1) {
    try {
      const children = execSync(`pgrep -P ${descendants[index]}`, { encoding: 'utf8' }).trim();
      if (children) descendants.push(...children.split('\n').map(Number));
    } catch {
      // pgrep exits non-zero when a process has no children; nothing more to add for this branch.
    }
  }
  for (const id of descendants) {
    try { process.kill(id, 'SIGKILL'); } catch { /* already exited */ }
  }
}

async function suspendProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await windowsProcessAction(pid, 'NtSuspendProcess');
    return;
  }
  process.kill(-pid, 'SIGSTOP');
}

async function resumeProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await windowsProcessAction(pid, 'NtResumeProcess');
    return;
  }
  process.kill(-pid, 'SIGCONT');
}

async function windowsProcessAction(pid: number, method: 'NtSuspendProcess' | 'NtResumeProcess'): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=${pid}`,
    '$all=@($root)',
    '$pending=@($root)',
    'while($pending.Count -gt 0){$parents=$pending;$pending=@();$children=Get-CimInstance Win32_Process | Where-Object { $parents -contains $_.ParentProcessId };foreach($child in $children){if($all -notcontains $child.ProcessId){$all+=$child.ProcessId;$pending+=$child.ProcessId}}}',
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class KaiProcess{[DllImport(\"ntdll.dll\")]public static extern int NtSuspendProcess(IntPtr h);[DllImport(\"ntdll.dll\")]public static extern int NtResumeProcess(IntPtr h);}'",
    `foreach($id in $all){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){[KaiProcess]::${method}($p.Handle) | Out-Null;$p.Dispose()}}`,
  ].join(';');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Process ${method} failed with exit code ${code}.`)));
  });
}

function quoteWinArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function isProcessResult(value: ProcessChunk | ProcessResult): value is ProcessResult {
  return 'code' in value;
}

function lifecycleEvent(
  request: Pick<AgentRunRequest, 'agent' | 'conversationId'>,
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

function streamTextEvent(request: Pick<AgentRunRequest, 'agent' | 'conversationId'>, text: string): PersistedEvent {
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

/**
 * The tool calls and file changes one parsed line carries, as events the rest of KAI reads.
 *
 * Exported beside the parser so the mapping can be pinned on its own: what a command call puts in `input` and
 * `output` decides whether the verification record and the command card can read it at all.
 */
export function lineEvents(
  request: Pick<AgentRunRequest, 'agent' | 'conversationId'>,
  parsed: ParsedAgentLine,
): PersistedEvent[] {
  const built: PersistedEvent[] = [];
  for (const tool of parsed.tools ?? []) {
    built.push({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'tool.call',
      name: tool.name,
      status: tool.status,
      ...(tool.input === undefined ? {} : { input: tool.input }),
      ...(tool.output === undefined ? {} : { output: tool.output }),
      ...(tool.callId === undefined ? {} : { callId: tool.callId }),
    });
  }
  for (const change of parsed.changes ?? []) {
    built.push({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'file.change',
      path: change.path,
      action: change.action,
    });
  }
  // A CLI that states what the run cost is believed: the run's spend, the scorecard's cost and Auto's own figure all
  // read it from here. A CLI that only reports tokens is left alone rather than guessed at.
  if (parsed.cost) {
    built.push({
      schemaVersion: 1,
      id: eventId(),
      taskId: request.conversationId,
      timestamp: nowIso(),
      agent: request.agent,
      type: 'cost.update',
      ...parsed.cost,
    });
  }
  return built;
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
