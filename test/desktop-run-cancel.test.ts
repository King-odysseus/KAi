import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest } from '../packages/contracts/src';
import { DesktopAgentRuntime, type AgentExecutionResult } from '../apps/desktop/src/main/agent-runtime';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';

/**
 * What a stopped run looks like.
 *
 * Stopping a run is not a failure of the run — the person did it, and the next instruction is usually already on its
 * way. Both runtimes used to disagree about how to say so: the CLI path reported a failure carrying the text "run
 * cancelled" and a red error event, while the Direct API path reported a lifecycle word `cancelled` and no error. Every
 * caller then had to recognise whichever form it happened to get, by matching the word "cancel", and the ones that
 * matched only one form got the other wrong — a stopped API run raised a "Run failed" notification, and Auto started
 * another turn after a stopped CLI run.
 *
 * These cases pin the shape both paths now share, so no caller has to read the message text again.
 */

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('a stopped run', () => {
  it('is reported the same way by the CLI path and the Direct API path', async () => {
    const cli = await runAndCancelCli();
    const api = await runAndCancelApi();

    for (const [label, result] of [['cli', cli], ['api', api]] as const) {
      expect(result.status, label).toBe('failed');
      expect(result.cancelled, label).toBe(true);
      // No error: nothing broke, and an error box is what the transcript used to show for something the reader had
      // just deliberately done.
      expect(result.error, label).toBeUndefined();
      expect(hasLifecycle(result, 'cancelled'), label).toBe(true);
      expect(hasErrorEvent(result), label).toBe(false);
    }
  }, 60_000);

  it('does not report a run that was never stopped as stopped', async () => {
    const finished = await runToCompletionCli();

    expect(finished.status).toBe('completed');
    expect(finished.cancelled).toBeUndefined();
    expect(hasLifecycle(finished, 'completed')).toBe(true);
  }, 60_000);
});

/** A CLI run held open until it is cancelled, so the stop lands while the process is genuinely running. */
async function runAndCancelCli(): Promise<AgentExecutionResult> {
  const root = await temporaryDirectory();
  const command = await hangingAgent(root);
  const runtime = new DesktopAgentRuntime({ codex: command, claude: command, qwen: command, kimi: command, gemini: command });
  const request = cliRequest();
  const started = runtime.run(request, root);
  // Let the process spawn and print its first line before stopping it, so this is a stop mid-run rather than a stop
  // before the run began.
  await new Promise((resolve) => { setTimeout(resolve, 1_500); });
  runtime.cancel(request.conversationId);
  return started;
}

/** A provider that accepts the request and then never answers, held open until it is cancelled. */
async function runAndCancelApi(): Promise<AgentExecutionResult> {
  const server = http.createServer(() => {
    // Deliberately never responds: the run waits on it, which is what there is to stop.
  });
  const baseUrl = await listen(server);
  const settings = createDefaultSettings();
  settings.directApi.enabled = true;
  settings.directApi.provider = 'openai';
  settings.directApi.model = 'gpt-5.6-sol';
  settings.directApi.baseUrl = baseUrl;
  settings.directApi.credentialId = 'provider.openai';
  const runtime = new DesktopDirectProviderRuntime(
    { load: async () => structuredClone(settings) },
    {
      isAvailable: () => true,
      has: async (id) => id === 'provider.openai',
      get: async (id) => id === 'provider.openai' ? 'test-key' : undefined,
    },
  );
  const request = apiRequest();
  const started = runtime.run(request, await temporaryDirectory());
  await new Promise((resolve) => { setTimeout(resolve, 1_500); });
  runtime.cancel(request.conversationId);
  return started;
}

async function runToCompletionCli(): Promise<AgentExecutionResult> {
  const root = await temporaryDirectory();
  const command = await replyingAgent(root);
  const runtime = new DesktopAgentRuntime({ codex: command, claude: command, qwen: command, kimi: command, gemini: command });
  return runtime.run(cliRequest(), root);
}

function cliRequest(): AgentRunRequest {
  return {
    conversationId: 'conv-cancel',
    prompt: 'Inspect the project',
    agent: 'codex',
    execution: 'cli',
    route: 'direct',
    autonomy: 'ask',
  };
}

function apiRequest(): AgentRunRequest {
  return {
    conversationId: 'conv-cancel-api',
    prompt: 'Inspect the project',
    agent: 'codex',
    execution: 'api',
    route: 'direct',
    autonomy: 'ask',
  };
}

function hasLifecycle(result: AgentExecutionResult, status: string): boolean {
  return result.events.some((event) => event.type === 'agent.lifecycle' && (event as { status?: string }).status === status);
}

function hasErrorEvent(result: AgentExecutionResult): boolean {
  return result.events.some((event) => event.type === 'error');
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-cancel-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A fake CLI that reports it started, then stays up until it is killed. */
async function hangingAgent(root: string): Promise<string> {
  return writeFakeAgent(root, `
    process.stdin.resume();
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-hang' }));
    // Still working, as far as anyone watching is concerned.
    setTimeout(() => {}, 600_000);
  `);
}

/** A fake CLI that answers and exits. */
async function replyingAgent(root: string): Promise<string> {
  return writeFakeAgent(root, `
    process.stdin.resume();
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-done' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All done.' } }));
    process.exit(0);
  `);
}

async function writeFakeAgent(root: string, body: string): Promise<string> {
  const scriptPath = path.join(root, 'fake-agent.mjs');
  const commandPath = path.join(root, process.platform === 'win32' ? 'fake-agent.cmd' : 'fake-agent');
  await fs.writeFile(scriptPath, `import fs from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.includes('--version')) { console.log('fake-agent 1.0.0'); process.exit(0); }\nif (args.includes('--list-sessions')) { console.log('[]'); process.exit(0); }\nif (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }\nif (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }\n${body}\n`, 'utf8');
  if (process.platform === 'win32') {
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    await fs.chmod(commandPath, 0o755);
  }
  return commandPath;
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}/v1`;
}
