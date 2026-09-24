import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentCapability,
  AgentId,
  AgentRunRequest,
  AgentSignInResult,
  AutonomyMode,
  PermissionKey,
  PersistedEvent,
} from '@kai/contracts';

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
};

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];

export interface AgentExecutionResult {
  status: 'completed' | 'failed';
  output: string;
  outputAgent: AgentId;
  events: PersistedEvent[];
  sessionId?: string;
  error?: string;
}

interface ProcessChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ParsedAgentLine {
  text?: string;
  resultText?: string;
  sessionId?: string;
  error?: string;
}

interface SignInLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type SignInLauncher = (command: string, args: string[], options: SignInLaunchOptions) => Promise<void>;

export interface DesktopAgentRuntimeOptions {
  resolveProxyEnvironment?: (
    agent: AgentId,
    request: AgentRunRequest,
  ) => Promise<NodeJS.ProcessEnv | null>;
  suspendProcess?: (pid: number) => Promise<void>;
  resumeProcess?: (pid: number) => Promise<void>;
}

export interface CliProxyAccess {
  endpoint: string;
  token: string;
}

/** Environment-only routing keeps the CLI's own configuration and credentials untouched. */
export function cliProxyEnvironment(agent: AgentId, access: CliProxyAccess): NodeJS.ProcessEnv {
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
  throw new Error(`${agent} does not support Universal Proxy routing.`);
}

interface ActiveAgentRun {
  controller: AbortController;
  child: ChildProcess | null;
  paused: boolean;
}

export class DesktopAgentRuntime {
  private readonly activeRuns = new Map<string, ActiveAgentRun>();

  constructor(
    private readonly commandOverrides: Partial<Record<AgentId, string>> = {},
    private readonly signInLauncher: SignInLauncher = launchDetachedSignIn,
    private readonly options: DesktopAgentRuntimeOptions = {},
  ) {}

  async capabilities(): Promise<AgentCapability[]> {
    return Promise.all(AGENT_ORDER.map((id) => this.capability(id)));
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
          ? `${definition.displayName} is not installed. Open the setup guide, then restart KAI.`
          : `${definition.displayName} could not start: ${info.detail || 'unknown command error'}`,
        command,
        signInCommand: definition.signInCommand,
        installUrl: definition.installUrl,
        supportsRoutes: supportsProxy(id) ? ['direct', 'proxy'] : ['direct'],
        supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      };
    }

    const auth = await commandInfo(id, command, definition.authArgs);
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

  async run(
    request: AgentRunRequest,
    cwd: string,
    resumeSessionId?: string,
    onEvent?: (event: PersistedEvent) => void,
    customPermissions?: Partial<Record<PermissionKey, boolean>>,
    model?: string,
  ): Promise<AgentExecutionResult> {
    const definition = AGENTS[request.agent];
    const capability = await this.capability(request.agent);
    if (!capability.available) {
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
        environment = await this.options.resolveProxyEnvironment(request.agent, request) ?? process.env;
      } catch (error) {
        return this.immediateFailure(
          request,
          `Universal Proxy route is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const args = buildAgentArgs(request, cwd, resumeSessionId, customPermissions, model);
    const controller = new AbortController();
    const active: ActiveAgentRun = { controller, child: null, paused: false };
    this.activeRuns.set(request.conversationId, active);

    const events: PersistedEvent[] = [lifecycleEvent(request, 'starting', `${definition.displayName} starting.`)];
    const outputParts: string[] = [];
    const errors: string[] = [];
    let sessionId = resumeSessionId;
    let hasOutputText = false;
    let stdoutCarry = '';
    let stderrCarry = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

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
            if (line.trim()) errors.push(stripAnsi(line.trim()));
          }
        }
      }

      if (stdoutCarry.trim()) consumeLine(stdoutCarry);
      if (stderrCarry.trim()) errors.push(stripAnsi(stderrCarry.trim()));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    } finally {
      this.activeRuns.delete(request.conversationId);
      active.child = null;
    }

    const output = outputParts.join('').trim();
    const aborted = controller.signal.aborted;
    const failed = !aborted && (exitCode !== 0 || (!output && errors.length > 0));
    const error = aborted
      ? `${definition.displayName} run cancelled.`
      : failed
        ? errors.at(-1) || `${definition.displayName} exited with code ${exitCode ?? 'unknown'}${exitSignal ? ` (${exitSignal})` : ''}.`
        : undefined;

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
        failed || aborted ? 'failed' : 'completed',
        failed || aborted ? error || `${definition.displayName} failed.` : `${definition.displayName} completed.`,
      ),
    );

    return {
      status: failed || aborted ? 'failed' : 'completed',
      output,
      outputAgent: request.agent,
      events,
      sessionId,
      error,
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
    active.paused = true;
    if (active.child?.pid) {
      await (this.options.suspendProcess ?? suspendProcessTree)(active.child.pid);
    }
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

export function buildAgentArgs(
  request: Pick<AgentRunRequest, 'agent' | 'prompt' | 'autonomy'>,
  cwd: string,
  resumeSessionId?: string,
  customPermissions?: Partial<Record<PermissionKey, boolean>>,
  model?: string,
): string[] {
  // Every supported CLI takes the model as `--model <name>`; without one the CLI keeps its own default.
  const modelArgs = model ? ['--model', model] : [];
  if (request.agent === 'codex') {
    if (resumeSessionId) return ['exec', 'resume', resumeSessionId, '--json', ...modelArgs, '-'];
    return [
      'exec',
      '--json',
      ...modelArgs,
      '--sandbox',
      codexSandbox(request.autonomy, customPermissions),
      '--skip-git-repo-check',
      '--cd',
      cwd,
      '-',
    ];
  }

  if (request.agent === 'claude') {
    const permissionMode = claudePermission(request.autonomy, customPermissions);
    const args = ['-p', '--output-format', 'json', '--permission-mode', permissionMode];
    if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    args.push(...modelArgs);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    return args;
  }

  if (request.agent === 'qwen') {
    const args = ['--output-format', 'stream-json', '--approval-mode', qwenApproval(request.autonomy), ...modelArgs];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push(request.prompt);
    return args;
  }

  const args = [
    '-p',
    request.prompt,
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
  return request.agent === 'codex' || request.agent === 'claude' ? request.prompt : undefined;
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

function geminiApproval(autonomy: AutonomyMode): 'plan' | 'auto_edit' | 'yolo' {
  if (autonomy === 'custom') return 'auto_edit';
  if (autonomy === 'autoEdit') return 'auto_edit';
  if (autonomy === 'full') return 'yolo';
  return 'plan';
}

function parseAgentLine(line: string, agent: AgentId): ParsedAgentLine {
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
    const error = errorText(value);
    return error ? { error } : {};
  }

  if (agent === 'claude') {
    const sessionId = commonSessionId(value);
    if (value.type === 'result') {
      return {
        sessionId,
        resultText: typeof value.result === 'string' ? value.result : undefined,
        error: errorText(value),
      };
    }
    if (value.type === 'assistant') {
      return { sessionId, text: textFromClaudeMessage(value.message) };
    }
    return { sessionId, error: errorText(value) };
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

async function* streamProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  stdin?: string,
  environment: NodeJS.ProcessEnv = process.env,
  onSpawn?: (child: ChildProcess) => void,
): AsyncIterable<ProcessChunk | ProcessResult> {
  const useShell = process.platform === 'win32';
  const child = spawn(useShell ? quoteWinArg(command) : command, useShell ? args.map(quoteWinArg) : args, {
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
    if (!child.killed) child.kill();
  };

  signal.addEventListener('abort', abort, { once: true });
  child.stdout?.on('data', (chunk) => push({ stream: 'stdout', text: chunk.toString() }));
  child.stderr?.on('data', (chunk) => push({ stream: 'stderr', text: chunk.toString() }));
  child.on('error', (error) => {
    push({ stream: 'stderr', text: error.message });
    done = true;
    push({ code: 1, signal: null });
  });
  child.on('close', (code, closeSignal) => {
    signal.removeEventListener('abort', abort);
    done = true;
    push({ code, signal: closeSignal });
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
  return agent === 'claude' || agent === 'codex';
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

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
