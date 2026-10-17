import { describe, expect, it, vi } from 'vitest';
import { runToolHooks, type ToolHookCall } from '../apps/desktop/src/main/automation';

function call(overrides: Partial<ToolHookCall> = {}): ToolHookCall {
  return {
    event: 'preTool',
    tool: 'run_command',
    input: { command: 'npm test' },
    autonomy: 'autoEdit',
    projectRoot: 'C:/project',
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('tool hooks', () => {
  it('blocks the call when a matching preTool hook fails, and gives the agent the reason', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 1, output: 'blocked: migrations are hand-written' }));
    const result = await runToolHooks({ preTool: [{ command: 'check.ps1' }] }, call(), runShell);
    expect(result.blocked).toContain('check.ps1');
    expect(result.blocked).toContain('migrations are hand-written');
    expect(runShell).toHaveBeenCalledOnce();
  });

  it('can deny through stdout JSON without a failing exit code', async () => {
    const result = await runToolHooks(
      { preTool: [{ command: 'policy.ps1' }] },
      call(),
      async () => ({ exitCode: 0, output: '{"decision":"deny","reason":"No network commands."}' }),
    );
    expect(result.blocked).toBe('No network commands.');
  });

  it('runs only hooks whose tool matcher fits', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, output: 'ran' }));
    const result = await runToolHooks(
      { preTool: [{ command: 'only-writes.ps1', tool: 'write_file' }, { command: 'commands.ps1', tool: 'run_command' }] },
      call(),
      runShell,
    );
    expect(result.blocked).toBeNull();
    expect(result.context).toBe('ran');
    expect(runShell).toHaveBeenCalledOnce();
    expect(runShell.mock.calls[0][0]).toBe('commands.ps1');
  });

  it('passes the tool, input and output through the environment', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, output: '' }));
    await runToolHooks(
      { postTool: [{ command: 'log.ps1' }] },
      call({ event: 'postTool', output: { ok: true } }),
      runShell,
    );
    const env = runShell.mock.calls[0][2] as Record<string, string>;
    expect(env).toMatchObject({
      KAI_EVENT: 'postTool',
      KAI_TOOL_NAME: 'run_command',
      KAI_TOOL_INPUT: '{"command":"npm test"}',
      KAI_TOOL_OUTPUT: '{"ok":true}',
      KAI_CONVERSATION_ID: 'conv-1',
    });
  });

  it('lets a postTool hook replace the output and add context', async () => {
    const result = await runToolHooks(
      { postTool: [{ command: 'rewrite.ps1' }] },
      call({ event: 'postTool', output: { ok: true } }),
      async () => ({ exitCode: 0, output: '{"output":{"ok":false},"context":"formatter changed a line"}' }),
    );
    expect(result.output).toEqual({ ok: false });
    expect(result.context).toBe('formatter changed a line');
    expect(result.blocked).toBeNull();
  });

  it('reports a failing postTool hook without blocking, because the work already happened', async () => {
    const result = await runToolHooks(
      { postTool: [{ command: 'notify.ps1' }] },
      call({ event: 'postTool', output: {} }),
      async () => ({ exitCode: 2, output: 'no such command' }),
    );
    expect(result.blocked).toBeNull();
    expect(result.context).toContain('postTool hook failed');
    expect(result.context).toContain('no such command');
  });

  it('does nothing when no hooks are configured', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, output: '' }));
    expect(await runToolHooks(undefined, call(), runShell)).toEqual({ blocked: null, context: '' });
    expect(runShell).not.toHaveBeenCalled();
  });
});
