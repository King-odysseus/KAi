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
});
