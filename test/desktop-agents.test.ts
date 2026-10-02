import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../packages/contracts/src';
import {
  agentInstallCommand,
  buildAgentArgs,
  cliProxyEnvironment,
  codexProxyProviderArgs,
  DesktopAgentRuntime,
  isMcpTransportNoise,
  isSignInError,
  kimiSignedIn,
  qwenProxySettings,
  resolveWindowsExecutable,
  singleLinePrompt,
} from '../apps/desktop/src/main/agent-runtime';

/** The line Codex prints on every run while a server in its config is down, taken verbatim from a real one. */
const MCP_OUTAGE_LINE =
  '2026-10-02T09:06:54.984662Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, '
  + 'when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (http://127.0.0.1:7600/mcp)")))';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('desktop agent runtime', () => {
  it('maps CLI proxy routes to each agent native environment contract', () => {
    const access = { endpoint: 'http://127.0.0.1:8082/', token: 'loopback-token' };
    expect(cliProxyEnvironment('claude', access)).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8082/a/claude',
      ANTHROPIC_AUTH_TOKEN: 'loopback-token',
      ANTHROPIC_API_KEY: 'loopback-token',
    });
    expect(cliProxyEnvironment('codex', access)).toMatchObject({
      OPENAI_BASE_URL: 'http://127.0.0.1:8082/a/codex/v1',
      OPENAI_API_KEY: 'loopback-token',
      CODEX_API_KEY: 'loopback-token',
    });
    expect(cliProxyEnvironment('qwen', access)).toMatchObject({
      OPENAI_BASE_URL: 'http://127.0.0.1:8082/a/qwen/v1',
      OPENAI_API_KEY: 'loopback-token',
    });
    expect(cliProxyEnvironment('kimi', access)).toMatchObject({
      KIMI_MODEL_NAME: 'kimi-for-coding',
      KIMI_MODEL_API_KEY: 'loopback-token',
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: 'http://127.0.0.1:8082/a/kimi/v1',
    });
    expect(cliProxyEnvironment('kimi', access, 'kimi-k2').KIMI_MODEL_NAME).toBe('kimi-k2');
    expect(() => cliProxyEnvironment('gemini', access)).toThrow(/does not support/);
  });

  it('gives a proxied Qwen run its own provider entry so ~/.qwen/settings.json cannot redirect it', () => {
    const url = 'http://127.0.0.1:8083/a/qwen/v1';
    expect(qwenProxySettings(url)).toEqual({
      modelProviders: { openai: [{ id: 'qwen-proxy', name: 'qwen-proxy', baseUrl: url, envKey: 'OPENAI_API_KEY' }] },
      model: { name: 'qwen-proxy' },
    });
    expect(qwenProxySettings(url, 'qwen3-coder')).toMatchObject({ model: { name: 'qwen3-coder' } });
  });

  it('offers the proxy route for Claude, Codex, Qwen and Kimi only', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, {});
    const runtime = new DesktopAgentRuntime({ claude: command, codex: command, qwen: command, gemini: command, kimi: command });

    const routes = Object.fromEntries((await runtime.capabilities()).map((agent) => [agent.id, agent.supportsRoutes]));

    expect(routes).toEqual({
      claude: ['direct', 'proxy'],
      codex: ['direct', 'proxy'],
      qwen: ['direct', 'proxy'],
      gemini: ['direct'],
      kimi: ['direct', 'proxy'],
    });
  });

  it('runs a signed-out CLI through the proxy, which supplies its own key', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { authenticated: false, reply: 'via proxy' });
    const runtime = new DesktopAgentRuntime({ codex: command }, undefined, {
      resolveProxyEnvironment: async (agent) => cliProxyEnvironment(agent, { endpoint: 'http://127.0.0.1:8083', token: 't' }),
    });

    const result = await runtime.run({ ...runRequest(), route: 'proxy' }, root);

    expect(result).toMatchObject({ status: 'completed', output: 'via proxy' });
  });

  it('flags a direct run that failed because the CLI is signed out', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { fail: true });
    const runtime = new DesktopAgentRuntime({ codex: command });

    await expect(runtime.run(runRequest(), root)).resolves.toMatchObject({ status: 'failed', signInRequired: true });
  });

  it('recognises CLI sign-in errors without matching ordinary failures', () => {
    for (const message of [
      'Not logged in · Please run /login',
      'Invalid API key · Please run /login',
      'Error: not signed in. Run `codex login` first.',
      'No authentication method configured.',
      'OAuth token has expired',
    ]) expect(isSignInError(message), message).toBe(true);
    for (const message of ['Rate limit reached', 'TypeError: cannot read properties of undefined', 'Build failed with 2 errors']) {
      expect(isSignInError(message), message).toBe(false);
    }
  });

  it('tells a server the CLI could not reach apart from the run failing', () => {
    for (const message of [
      MCP_OUTAGE_LINE,
      'error sending request for url (https://design.penpot.app/mcp/stream?userToken=abc)',
    ]) expect(isMcpTransportNoise(message), message).toBe(true);
    // A tool that was reached and then failed is a failure of the run, not an outage, and stays reportable.
    for (const message of [
      'MCP tool open-pencil__get_document failed: no document is open',
      'Error: unable to write to disk',
      'error sending request for url (https://api.openai.com/v1/responses)',
    ]) expect(isMcpTransportNoise(message), message).toBe(false);
  });

  it('does not fail a run over a server it could not reach', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { silent: true, stderr: [MCP_OUTAGE_LINE] });
    const runtime = new DesktopAgentRuntime({ codex: command });

    // The only thing the CLI said was that a design server is closed. Nothing was asked of it and nothing failed.
    await expect(runtime.run(runRequest(), root)).resolves.toMatchObject({ status: 'completed' });
  });

  it('blames a failed run for its own reason, not for a server it could not reach', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, {
      silent: true,
      exitCode: 1,
      // The outage arrives last, so reading the last line would report the design server instead of the disk.
      stderr: ['Error: unable to write to disk', MCP_OUTAGE_LINE],
    });
    const runtime = new DesktopAgentRuntime({ codex: command });

    await expect(runtime.run(runRequest(), root)).resolves.toMatchObject({
      status: 'failed',
      error: 'Error: unable to write to disk',
    });
  });

  it('reads Kimi Code sign-in from its credentials or configured providers', async () => {
    const empty = await temporaryDirectory();
    expect(kimiSignedIn(empty)).toBe(false);

    const oauth = await temporaryDirectory();
    await fs.mkdir(path.join(oauth, 'credentials'));
    await fs.writeFile(path.join(oauth, 'credentials', 'kimi-code.json'), '{}');
    expect(kimiSignedIn(oauth)).toBe(true);

    const provider = await temporaryDirectory();
    await fs.writeFile(path.join(provider, 'config.toml'), '[providers.moonshot]\ntype = "kimi"\n');
    expect(kimiSignedIn(provider)).toBe(true);
  });

  it('reads Kimi Code assistant messages and ignores tool output', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, {
      lines: [
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Shell' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'secret tool output' },
        { role: 'assistant', content: 'kimi reply' },
      ],
    });
    const runtime = new DesktopAgentRuntime({ kimi: command });

    const result = await withKimiHome(root, () => runtime.run({ ...runRequest(), agent: 'kimi' }, root));

    expect(result).toMatchObject({ status: 'completed', output: 'kimi reply' });
  });

  it('detects an installed CLI through its version command', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { reply: 'hello' });
    const runtime = new DesktopAgentRuntime({ codex: command });

    await expect(runtime.capability('codex')).resolves.toMatchObject({
      id: 'codex',
      displayName: 'Codex',
      available: true,
      state: 'ready',
      version: 'fake-agent 1.0.0',
      signInCommand: 'codex login',
      supportsRoutes: ['direct', 'proxy'],
    });
  });

  it('reports an installed CLI as unavailable when it has no signed-in account', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { authenticated: false });
    const runtime = new DesktopAgentRuntime({ gemini: command });

    await expect(runtime.capability('gemini')).resolves.toMatchObject({
      available: false,
      state: 'signed_out',
      unavailableReason: 'Gemini CLI is installed but not signed in. Use Sign in to connect your account.',
      signInCommand: 'gemini',
    });
  });

  it('fails a run for a signed-out account instead of switching to another route or a paid API', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { authenticated: false });
    const runtime = new DesktopAgentRuntime({ gemini: command });
    const events: string[] = [];

    const result = await runtime.run(
      { conversationId: 'c1', prompt: 'hello', agent: 'gemini', route: 'direct', autonomy: 'ask' },
      root,
      undefined,
      (event) => events.push(event.type),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Gemini CLI is unavailable: .*not signed in/);
    expect(result.output).toBe('');
    // Nothing was sent anywhere: the failure is reported and the user decides what to do next.
    expect(events).not.toContain('route.changed');
  });

  it('reports a missing CLI separately from a sign-in problem', async () => {
    const root = await temporaryDirectory();
    const runtime = new DesktopAgentRuntime({ codex: path.join(root, 'missing-agent') });

    await expect(runtime.capability('codex')).resolves.toMatchObject({
      available: false,
      state: 'not_installed',
      installCommand: 'npm install -g @openai/codex',
    });
  });

  it('opens the official installer for a missing CLI and refuses when it is already installed', async () => {
    const root = await temporaryDirectory();
    const installs: string[] = [];
    const installLauncher = async (commandLine: string) => {
      installs.push(commandLine);
    };
    const missing = new DesktopAgentRuntime({ qwen: path.join(root, 'missing-agent') }, undefined, { installLauncher });

    await expect(missing.install('qwen')).resolves.toMatchObject({ started: true, command: 'npm install -g @qwen-code/qwen-code@latest' });
    expect(installs).toEqual(['npm install -g @qwen-code/qwen-code@latest']);

    const installed = new DesktopAgentRuntime({ qwen: await fakeAgent(root, {}) }, undefined, { installLauncher });
    await expect(installed.install('qwen')).resolves.toMatchObject({ started: false, message: 'Qwen Code is already installed.' });
    expect(installs).toHaveLength(1);
  });

  it('gives every CLI an install command for the current OS', () => {
    for (const agent of ['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const) {
      expect(agentInstallCommand(agent)).toMatch(/\S/);
    }
    expect(agentInstallCommand('kimi', 'win32')).toContain('install.ps1');
    expect(agentInstallCommand('kimi', 'darwin')).toContain('install.sh');
  });

  it('launches the official CLI sign-in flow without embedding credentials', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { authenticated: false });
    const launches: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runtime = new DesktopAgentRuntime(
      { codex: command },
      async (launchCommand, args, options) => {
        launches.push({ command: launchCommand, args, cwd: options.cwd });
      },
    );

    const result = await runtime.signIn('codex');

    expect(result).toMatchObject({
      agent: 'codex',
      started: true,
      command: 'codex login',
    });
    expect(launches).toEqual([
      {
        command,
        args: ['login'],
        cwd: expect.any(String),
      },
    ]);
  });

  it('runs a new Codex conversation and captures the assistant reply and session', async () => {
    const root = await temporaryDirectory();
    const resultFile = path.join(root, 'result.json');
    const command = await fakeAgent(root, { reply: 'desktop reply', sessionId: 'session-123', resultFile });
    const runtime = new DesktopAgentRuntime({ codex: command });
    const request = runRequest();

    const result = await runtime.run(request, root, undefined);
    const observed = JSON.parse(await fs.readFile(resultFile, 'utf8')) as {
      args: string[];
      stdin: string;
    };

    expect(result).toMatchObject({
      status: 'completed',
      output: 'desktop reply',
      sessionId: 'session-123',
    });
    expect(observed.stdin).toBe('Inspect the project');
    expect(observed.args).toContain('--json');
    expect(observed.args).toContain('read-only');
    expect(observed.args).toContain('--skip-git-repo-check');
    expect(result.events.map((event) => event.type)).toEqual(['agent.lifecycle', 'text.delta', 'agent.lifecycle']);
  });

  it('surfaces a CLI failure instead of returning a silent empty response', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, { fail: true });
    const runtime = new DesktopAgentRuntime({ codex: command });

    const result = await runtime.run(runRequest(), root);

    expect(result.status).toBe('failed');
    expect(result.output).toBe('');
    expect(result.error).toContain('authentication required');
    expect(result.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('reports that no active run was cancelled when the conversation is idle', () => {
    const runtime = new DesktopAgentRuntime();

    expect(runtime.cancel('not-running')).toBe(false);
  });

  it('reads complete Qwen stream messages without duplicating the result event', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, {
      lines: [
        {
          type: 'assistant',
          session_id: 'qwen-session',
          message: { content: [{ type: 'text', text: 'qwen reply' }] },
        },
        { type: 'result', session_id: 'qwen-session', result: 'qwen reply' },
      ],
    });
    const runtime = new DesktopAgentRuntime({ qwen: command });

    const result = await runtime.run({ ...runRequest(), agent: 'qwen' }, root);

    expect(result).toMatchObject({ status: 'completed', output: 'qwen reply', sessionId: 'qwen-session' });
  });

  it('reads Gemini stream deltas and captures the session id', async () => {
    const root = await temporaryDirectory();
    const command = await fakeAgent(root, {
      lines: [
        { type: 'init', session_id: 'gemini-session', model: 'fake-model' },
        { type: 'message', role: 'assistant', content: 'gemini reply', delta: true },
        { type: 'result', status: 'success' },
      ],
    });
    const runtime = new DesktopAgentRuntime({ gemini: command });

    const result = await runtime.run({ ...runRequest(), agent: 'gemini' }, root);

    expect(result).toMatchObject({ status: 'completed', output: 'gemini reply', sessionId: 'gemini-session' });
  });

  it('builds truthful non-interactive arguments for every supported CLI', () => {
    const base = { prompt: 'Review this repository', autonomy: 'ask' as const };

    expect(buildAgentArgs({ ...base, agent: 'codex' }, 'C:/repo')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--cd',
      'C:/repo',
      '-',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'codex' }, 'C:/repo', undefined, undefined, 'gpt-6-astra', undefined, ['C:/kai/attachments/capture.png'])).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-6-astra',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--cd',
      'C:/repo',
      '--image',
      'C:/kai/attachments/capture.png',
      '-',
    ]);
    // stream-json: the run's own messages as they are written, and the tools it used, rather than one JSON blob at
    // the end. `--verbose` is required by that format.
    expect(buildAgentArgs({ ...base, agent: 'claude' }, 'C:/repo')).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'qwen' }, 'C:/repo')).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '-p',
      'Carry out the request above.',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'gemini' }, 'C:/repo')).toEqual([
      '-p',
      'Carry out the request above.',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--skip-trust',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'kimi' }, 'C:/repo')).toEqual([
      '-p',
      'Review this repository',
      '--output-format',
      'stream-json',
      '--plan',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'kimi', autonomy: 'full' }, 'C:/repo', 'kimi-session', undefined, 'kimi-for-coding')).toEqual([
      '-p',
      'Review this repository',
      '--output-format',
      'stream-json',
      '--auto',
      '--model',
      'kimi-for-coding',
      '--session',
      'kimi-session',
    ]);
  });

  it.each(['qwen', 'gemini'] as const)('sends a multi-line %s prompt on stdin, untouched, and keeps it out of the command line', async (agent) => {
    const root = await temporaryDirectory();
    const resultFile = path.join(root, 'invocation.json');
    const command = await fakeAgent(root, { resultFile, lines: [{ type: 'result', result: 'ok' }] });
    const runtime = new DesktopAgentRuntime({ [agent]: command });
    const prompt = 'Goal: fix "auth"\n\n- item & more\n- 100% | done\n```js\nconst x = 1;\n```';

    const result = await runtime.run({ ...runRequest(), agent, prompt }, root);

    expect(result.status).toBe('completed');
    const invocation = JSON.parse(await fs.readFile(resultFile, 'utf8')) as { args: string[]; stdin: string };
    expect(invocation.stdin).toBe(prompt);
    expect(invocation.args.join(' ')).not.toContain('Goal');
    expect(invocation.args).toContain('Carry out the request above.');
  });

  it('flattens newlines for a prompt that must travel as one argument, and leaves other text alone', () => {
    expect(singleLinePrompt('One\nTwo\r\nThree')).toBe('One \u23CE Two \u23CE Three');
    expect(singleLinePrompt('A\n\n\nB  \n  C')).toBe('A \u23CE B \u23CE C');
    expect(singleLinePrompt('no newline, "quotes" & more')).toBe('no newline, "quotes" & more');
    expect(singleLinePrompt('')).toBe('');
  });

  it.runIf(process.platform === 'win32')('runs a short Kimi prompt behind a .cmd shim as one line, and refuses one that cannot fit a Windows command line', async () => {
    const root = await temporaryDirectory();
    const resultFile = path.join(root, 'kimi-invocation.json');
    const command = await fakeAgent(root, { resultFile, lines: [{ role: 'assistant', content: 'kimi ok' }] });
    const runtime = new DesktopAgentRuntime({ kimi: command });

    const short = await withKimiHome(root, () => runtime.run({ ...runRequest(), agent: 'kimi', prompt: 'First line\nSecond line' }, root));
    expect(short).toMatchObject({ status: 'completed', output: 'kimi ok' });
    const invocation = JSON.parse(await fs.readFile(resultFile, 'utf8')) as { args: string[] };
    expect(invocation.args[invocation.args.indexOf('-p') + 1]).toBe('First line \u23CE Second line');

    const long = await withKimiHome(root, () => runtime.run({ ...runRequest(), agent: 'kimi', prompt: 'x'.repeat(9_000) }, root));
    expect(long.status).toBe('failed');
    expect(long.error).toMatch(/command-line argument, and Windows allows about 7,500 characters/);
    expect(long.error).toMatch(/Install the native Kimi Code/);
  });

  it('starts a native Windows executable directly but leaves an npm .cmd shim on cmd.exe', async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'shimmed.cmd'), '@echo off\r\n');
    await fs.writeFile(path.join(second, 'shimmed.exe'), '');
    await fs.writeFile(path.join(second, 'native.exe'), '');
    const environment = { Path: `${first};${second}` };

    expect(resolveWindowsExecutable('native', environment, 'win32')).toBe(path.join(second, 'native.exe'));
    // cmd.exe would run the earlier .cmd, so the later .exe must not be used.
    expect(resolveWindowsExecutable('shimmed', environment, 'win32')).toBeNull();
    expect(resolveWindowsExecutable('missing', environment, 'win32')).toBeNull();
    expect(resolveWindowsExecutable(path.join(second, 'native.exe'), {}, 'win32')).toBe(path.join(second, 'native.exe'));
    expect(resolveWindowsExecutable('native', environment, 'linux')).toBeNull();
  });

  it('points Codex at the proxy with config overrides because it ignores OPENAI_BASE_URL', () => {
    const url = 'http://127.0.0.1:8083/a/codex/v1';
    const provider = codexProxyProviderArgs(url);
    expect(provider).toContain(`model_providers.kai-proxy.base_url="${url}"`);
    expect(provider).toContain('model_provider="kai-proxy"');
    const request = { prompt: 'hi', autonomy: 'ask' as const, agent: 'codex' as const };
    expect(buildAgentArgs(request, 'C:/repo', undefined, undefined, undefined, url).slice(0, 1 + provider.length))
      .toEqual(['exec', ...provider]);
    expect(buildAgentArgs(request, 'C:/repo', 'session-1', undefined, undefined, url))
      .toEqual(['exec', ...provider, 'resume', 'session-1', '--json', '-']);
    // Only the name of the key's environment variable is on the command line, never the key.
    expect(provider).toContain('model_providers.kai-proxy.env_key="OPENAI_API_KEY"');
  });

  it('points Qwen at the proxy with a flag so its own settings file cannot override the route', () => {
    const args = buildAgentArgs(
      { prompt: 'hi', autonomy: 'ask', agent: 'qwen' },
      'C:/repo',
      undefined,
      undefined,
      undefined,
      'http://127.0.0.1:8083/a/qwen/v1',
    );
    expect(args).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--auth-type',
      'openai',
      '--openai-base-url',
      'http://127.0.0.1:8083/a/qwen/v1',
      '-p',
      'Carry out the request above.',
    ]);
    // The key travels in the environment, never on the command line.
    expect(args.join(' ')).not.toMatch(/api-key/);
  });
});

function runRequest(): AgentRunRequest {
  return {
    conversationId: 'conv-1',
    prompt: 'Inspect the project',
    agent: 'codex',
    route: 'direct',
    autonomy: 'ask',
  };
}

async function withKimiHome<T>(root: string, task: () => Promise<T>): Promise<T> {
  const home = path.join(root, 'kimi-home');
  await fs.mkdir(path.join(home, 'credentials'), { recursive: true });
  await fs.writeFile(path.join(home, 'credentials', 'kimi-code.json'), '{}');
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    return await task();
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-agent-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeAgent(
  root: string,
  options: {
    reply?: string;
    sessionId?: string;
    resultFile?: string;
    fail?: boolean;
    lines?: unknown[];
    authenticated?: boolean;
    /** Lines the CLI writes to stderr, as a real one does for its own diagnostics. */
    stderr?: string[];
    /** Write nothing to stdout and exit with `exitCode`, the way a CLI does when it has nothing to say. */
    silent?: boolean;
    /** The exit status for a `silent` run. */
    exitCode?: number;
  },
): Promise<string> {
  const scriptPath = path.join(root, 'fake-agent.mjs');
  const commandPath = path.join(root, process.platform === 'win32' ? 'fake-agent.cmd' : 'fake-agent');
  await fs.writeFile(scriptPath, fakeAgentScript(options), 'utf8');

  if (process.platform === 'win32') {
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    await fs.chmod(commandPath, 0o755);
  }
  return commandPath;
}

function fakeAgentScript(options: {
  reply?: string;
  sessionId?: string;
  resultFile?: string;
  fail?: boolean;
  lines?: unknown[];
  authenticated?: boolean;
  stderr?: string[];
  silent?: boolean;
  exitCode?: number;
}): string {
  return `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('fake-agent 1.0.0');
      process.exit(0);
    }
    if (args[0] === 'login' && args[1] === 'status') {
      console.log(${JSON.stringify(options.authenticated === false ? 'Not logged in' : 'Logged in using ChatGPT')});
      process.exit(${options.authenticated === false ? 1 : 0});
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      console.log(JSON.stringify({ loggedIn: ${options.authenticated !== false} }));
      console.log('=== Authentication Status ===');
      process.exit(0);
    }
    if (args[0] === '--list-sessions') {
      console.log('[]');
      process.exit(${options.authenticated === false ? 1 : 0});
    }
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { stdin += chunk; });
    process.stdin.on('end', () => {
      if (${JSON.stringify(options.resultFile ?? null)}) {
        fs.writeFileSync(${JSON.stringify(options.resultFile ?? '')}, JSON.stringify({ args, stdin }));
      }
      if (${Boolean(options.fail)}) {
        console.error('authentication required');
        process.exit(2);
      }
      // A synchronous write, because a piped stderr is not flushed by process.exit() on Windows and a line that
      // never arrived would make these cases pass for the wrong reason.
      for (const line of ${JSON.stringify(options.stderr ?? [])}) fs.writeSync(2, line + '\\n');
      if (${Boolean(options.silent)}) process.exit(${options.exitCode ?? 0});
      const lines = ${JSON.stringify(options.lines ?? [])};
      if (lines.length > 0) {
        for (const line of lines) console.log(JSON.stringify(line));
      } else {
        console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(options.sessionId ?? 'session-1')} }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(options.reply ?? 'ok')} } }));
      }
    });
  `;
}
