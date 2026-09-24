import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../packages/contracts/src';
import { buildAgentArgs, cliProxyEnvironment, DesktopAgentRuntime } from '../apps/desktop/src/main/agent-runtime';

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
    expect(() => cliProxyEnvironment('qwen', access)).toThrow(/does not support/);
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
    });
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
    expect(buildAgentArgs({ ...base, agent: 'claude' }, 'C:/repo')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'qwen' }, 'C:/repo')).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      'Review this repository',
    ]);
    expect(buildAgentArgs({ ...base, agent: 'gemini' }, 'C:/repo')).toEqual([
      '-p',
      'Review this repository',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--skip-trust',
    ]);
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

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-agent-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeAgent(
  root: string,
  options: { reply?: string; sessionId?: string; resultFile?: string; fail?: boolean; lines?: unknown[]; authenticated?: boolean },
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
