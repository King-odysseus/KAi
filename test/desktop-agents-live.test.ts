import { describe, expect, it } from 'vitest';
import { DesktopAgentRuntime } from '../apps/desktop/src/main/agent-runtime';

const liveAgentSmoke = process.env.KAI_REAL_AGENT_SMOKE === '1';

describe.skipIf(!liveAgentSmoke)('live desktop agent smoke', () => {
  it(
    'runs the installed Codex CLI in read-only mode and returns its final reply',
    async () => {
      const runtime = new DesktopAgentRuntime();
      const capability = await runtime.capability('codex');
      expect(capability.available).toBe(true);

      const result = await runtime.run(
        {
          conversationId: 'live-codex-smoke',
          prompt: 'Reply with exactly KAI_CLI_OK. Do not run any tools.',
          agent: 'codex',
          route: 'direct',
          autonomy: 'ask',
        },
        process.cwd(),
      );

      expect(result.status, result.error).toBe('completed');
      expect(result.output).toContain('KAI_CLI_OK');
    },
    120_000,
  );

  /**
   * The wiring the unit tests cannot reach: that a command the CLI reports reaches the run's own event list, which
   * is the only list saved with the conversation. Sent to the window alone it would show while the run went and then
   * vanish, which is what a CLI run used to do with everything except its prose.
   */
  it(
    'reports the commands the CLI ran, and they survive the run',
    async () => {
      const runtime = new DesktopAgentRuntime();
      const result = await runtime.run(
        {
          conversationId: 'live-codex-tools',
          prompt: 'Run the shell command: echo KAI_TOOL_OK. Then reply with exactly DONE.',
          agent: 'codex',
          route: 'direct',
          autonomy: 'ask',
        },
        process.cwd(),
      );

      expect(result.status, result.error).toBe('completed');
      const calls = result.events.filter((event) => event.type === 'tool.call') as Array<Record<string, unknown>>;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toMatchObject({ name: 'run_command', status: 'started' });
      // The finished call carries what the rest of KAI reads out of it: the command, and the exit code it ended on.
      expect(calls.some((event) => event.status === 'completed')).toBe(true);
      const finished = calls.find((event) => event.status === 'completed');
      expect(finished).toMatchObject({
        input: { command: expect.stringContaining('KAI_TOOL_OK') },
        output: { exitCode: 0 },
      });
    },
    180_000,
  );

  /** Claude's run is invoked in the streaming format now, and that format is what these two facts depend on. */
  it(
    'runs the installed Claude CLI in its streaming format and reads what it costs',
    async () => {
      const runtime = new DesktopAgentRuntime();
      const result = await runtime.run(
        {
          conversationId: 'live-claude-stream',
          prompt: 'Reply with exactly KAI_CLI_OK. Do not run any tools.',
          agent: 'claude',
          route: 'direct',
          autonomy: 'ask',
        },
        process.cwd(),
      );

      expect(result.status, result.error).toBe('completed');
      expect(result.output).toContain('KAI_CLI_OK');
      // Only the streaming result line carries the figure, and only the returned events are saved with the run.
      const cost = result.events.find((event) => event.type === 'cost.update') as { amountUsd?: number } | undefined;
      expect(cost?.amountUsd).toBeGreaterThan(0);
    },
    180_000,
  );
});
