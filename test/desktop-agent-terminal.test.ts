import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KAI_TERMINAL_MCP_SERVER_ID, createDefaultSettings, type TerminalEvent, type TerminalSession, type TerminalShell } from '../packages/contracts/src';
import { RedactedLogger } from '../packages/runtime/src';
import { AgentTerminal, availableShells, sentinelLine, terminalBriefing, sentinelPattern, stripAnsi, type AgentShell, type AgentTerminalPort } from '../apps/desktop/src/main/agent-terminal';
import { DesktopMcpRuntime } from '../apps/desktop/src/main/mcp-runtime';
import { startTerminalMcpHost, type TerminalMcpHost } from '../apps/desktop/src/main/terminal-mcp-host';
import { TerminalManager, findGitBash } from '../apps/desktop/src/main/terminal';
import { withKaiTerminalMcpSetting } from '../apps/desktop/src/main/agent-mcp-config';

vi.setConfig({ testTimeout: 90_000 });

/** A terminal that answers every command by printing the marker the way a real shell would, with status 0. */
function fakePort(): AgentTerminalPort & { written: string[]; started: Array<{ shell: TerminalShell; cwd: string; agent: boolean }> } {
  const sessions = new Map<string, TerminalSession>();
  const output = new Set<(id: string, data: string) => void>();
  const exits = new Set<(id: string) => void>();
  const written: string[] = [];
  let counter = 0;
  const started: Array<{ shell: TerminalShell; cwd: string; agent: boolean }> = [];
  return {
    written,
    started,
    start: (projectId, cwd, shell, cols, rows, _owner, options) => {
      const session: TerminalSession = { id: `term_${++counter}`, projectId, shell, cwd, cols, rows, ...(options.agent ? { agent: true } : {}) };
      sessions.set(session.id, session);
      started.push({ shell, cwd, agent: options.agent });
      return session;
    },
    write: (id, data) => {
      if (!sessions.has(id)) return false;
      written.push(data);
      const nonce = /__KAI_DONE_([0-9a-f]+)_/.exec(data)?.[1];
      if (nonce) for (const listener of output) listener(id, `hello\r\n__KAI_DONE_${nonce}_0__\r\n`);
      return true;
    },
    stop: (id) => {
      const had = sessions.delete(id);
      if (had) for (const listener of exits) listener(id);
      return had;
    },
    get: (id) => sessions.get(id) ?? null,
    list: () => [...sessions.values()],
    buffer: (id) => (sessions.has(id) ? 'earlier output' : null),
    onOutput: (listener) => { output.add(listener); return () => output.delete(listener); },
    onExit: (listener) => { exits.add(listener); return () => exits.delete(listener); },
  };
}

const project = { id: 'p1', path: os.tmpdir() };
const context = { activeProject: async () => project };

describe('agent terminal', () => {
  it('runs a command in a session KAI owns, reuses it, and reports the exit status', async () => {
    const port = fakePort();
    const terminal = new AgentTerminal(port, context, () => ['gitbash', 'powershell', 'cmd']);
    const first = await terminal.run({ command: 'echo hello' });
    expect(first).toMatchObject({ exitCode: 0, timedOut: false, shell: 'gitbash', output: 'hello' });
    const second = await terminal.run({ command: 'pwd' });
    expect(second.sessionId).toBe(first.sessionId);
    expect(port.started).toEqual([{ shell: 'gitbash', cwd: project.path, agent: true }]);
    // The command and the marker line go in as one write, command first.
    expect(port.written[0]).toMatch(/^echo hello\r.*__KAI_DONE_[0-9a-f]+_.*\r$/s);
  });

  it('lets the agent choose the shell, and refuses one that is not installed', async () => {
    const port = fakePort();
    const terminal = new AgentTerminal(port, context, () => ['powershell', 'cmd']);
    expect((await terminal.run({ command: 'dir', shell: 'cmd' })).shell).toBe('cmd');
    expect(port.started.at(-1)?.shell).toBe('default');
    expect((await terminal.run({ command: 'ls' })).shell).toBe('powershell');
    await expect(terminal.run({ command: 'ls', shell: 'gitbash' })).rejects.toThrow(/gitbash is not available.*powershell, cmd/);
  });

  it('starts a fresh session when the reused one has exited', async () => {
    const port = fakePort();
    const terminal = new AgentTerminal(port, context, () => ['gitbash']);
    const first = await terminal.run({ command: 'echo a' });
    port.stop(first.sessionId);
    const second = await terminal.run({ command: 'echo b' });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('returns what a never-ending command printed so far, flagged as timed out', async () => {
    const port = fakePort();
    port.write = (id) => { void id; return true; };
    const terminal = new AgentTerminal(port, context, () => ['gitbash']);
    const session = await terminal.start({ shell: 'gitbash' });
    const pending = terminal.run({ command: 'npm run dev', sessionId: session.id, timeoutMs: 1000 });
    await expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: null });
  });

  it('reads a session back, and says so when it is gone', async () => {
    const port = fakePort();
    const terminal = new AgentTerminal(port, context, () => ['gitbash']);
    const session = await terminal.start({});
    expect(terminal.read(session.id)).toBe('earlier output');
    expect(() => terminal.read('term_missing')).toThrow(/no terminal session/);
  });

  it('writes a marker line each shell can print with a numeric status, and finds only that', () => {
    for (const shell of ['gitbash', 'powershell', 'cmd'] as AgentShell[]) {
      const line = sentinelLine(shell, 'abc123', 'win32');
      // What the shell echoes back as it is typed must not look like a finished marker.
      expect(sentinelPattern('abc123').test(line)).toBe(false);
    }
    expect(sentinelPattern('abc123').exec('x __KAI_DONE_abc123_17__ y')?.[1]).toBe('17');
    expect(stripAnsi('\u001b[32mok\u001b[0m\r\n')).toBe('ok\n');
    expect(availableShells('win32', null)).toEqual(['powershell', 'cmd']);
    expect(availableShells('win32', 'C:\\Git\\bin\\bash.exe')).toEqual(['gitbash', 'powershell', 'cmd']);
  });
});

describe('terminal briefing', () => {
  it('offers every installed shell and the choice, and never steers to one or to an outside window', () => {
    const text = terminalBriefing('cli', ['gitbash', 'powershell', 'cmd']);
    expect(text).toContain('gitbash, powershell, cmd');
    expect(text).toMatch(/pick whichever fits/);
    expect(text).toMatch(/Never open a separate terminal window/);
    expect(text).toContain('kai-terminal');
    expect(terminalBriefing('api', ['cmd'])).not.toContain('MCP server');
  });
});

describe('KAI terminal MCP host', () => {
  let host: TerminalMcpHost | undefined;
  afterEach(async () => { await host?.close(); host = undefined; });

  it('refuses a caller without the token and serves the tools to one with it', async () => {
    const terminal = new AgentTerminal(fakePort(), context, () => ['gitbash', 'powershell']);
    host = await startTerminalMcpHost(terminal);
    expect((await fetch(host.endpoint, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(host.endpoint, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);

    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(host.endpoint), { requestInit: { headers: { Authorization: host.authorization } } }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(['terminal_list', 'terminal_read', 'terminal_run', 'terminal_start', 'terminal_stop', 'terminal_write']);
    const result = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo hello', shell: 'powershell' } });
    expect(JSON.parse(((result.content as Array<{ text: string }>)[0]).text)).toMatchObject({ exit_code: 0, shell: 'powershell', output: 'hello' });
    const bad = await client.callTool({ name: 'terminal_run', arguments: { command: 'ls', shell: 'cmd', session_id: 'term_nope' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('is offered to the API agent through the MCP runtime, with the shell tool rules', async () => {
    const terminal = new AgentTerminal(fakePort(), context, () => ['gitbash']);
    host = await startTerminalMcpHost(terminal);
    const settings = withKaiTerminalMcpSetting(createDefaultSettings(), { endpoint: host.endpoint }).settings;
    const authorization = host.authorization;
    const runtime = new DesktopMcpRuntime(
      { load: async () => structuredClone(settings) },
      { get: async (id) => (id === 'terminal.agent' ? authorization : undefined) },
      new RedactedLogger(),
    );
    try {
      const names = (await runtime.definitions()).map((definition) => String((definition as { name: string }).name));
      const run = names.find((name) => name.endsWith('terminal_run'))!;
      const read = names.find((name) => name.endsWith('terminal_read'))!;
      expect(run).toContain(KAI_TERMINAL_MCP_SERVER_ID);
      expect(runtime.policy(run, 'plan')).toMatchObject({ decision: 'deny' });
      expect(runtime.policy(run, 'ask')).toMatchObject({ decision: 'ask', risk: 'high' });
      expect(runtime.policy(run, 'autoEdit')).toMatchObject({ decision: 'ask' });
      expect(runtime.policy(run, 'full')).toEqual({ decision: 'allow' });
      expect(runtime.policy(read, 'plan')).toEqual({ decision: 'allow' });
      await expect(runtime.execute(run, { command: 'echo hello' })).resolves.toMatchObject({ ok: true });
    } finally {
      await runtime.dispose();
    }
  });
});

describe('the real terminal', () => {
  const shells: AgentShell[] = process.platform === 'win32' ? ['powershell', 'cmd', ...(findGitBash() ? ['gitbash' as const] : [])] : ['cmd'];
  let manager: TerminalManager | undefined;
  afterEach(async () => { await manager?.stopAll(); manager = undefined; });

  it.each(shells)('finishes a command and reports its status in %s', async (shell) => {
    const events: TerminalEvent[] = [];
    manager = new TerminalManager((event) => events.push(event));
    const terminal = new AgentTerminal(manager, { activeProject: async () => ({ id: 'p', path: os.tmpdir() }) }, () => shells);
    const ok = await terminal.run({ command: 'echo kai-marker-ok', shell, timeoutMs: 40_000 });
    expect(ok.timedOut).toBe(false);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain('kai-marker-ok');
    const failing = shell === 'powershell' ? 'Get-Item C:\\definitely\\not\\here' : shell === 'cmd' && process.platform === 'win32' ? 'dir C:\\definitely\\not\\here' : 'ls /definitely/not/here';
    const bad = await terminal.run({ command: failing, shell, timeoutMs: 40_000 });
    expect(bad.timedOut).toBe(false);
    expect(bad.exitCode).not.toBe(0);
    // The dock is told about the session so a person can watch it.
    expect(events.some((event) => event.kind === 'agent-session')).toBe(true);
  });
});
