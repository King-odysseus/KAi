import { describe, expect, it } from 'vitest';
import { persistedEventV1Schema } from '@kai/contracts';
import { lineEvents, parseAgentLine } from '../apps/desktop/src/main/agent-runtime';
import { agentChecksFromEvents } from '../apps/desktop/src/main/verification';

/**
 * What a CLI run tells KAI it is doing.
 *
 * A CLI run used to report nothing but its prose, so KAI could not see the commands it ran — no command cards, no
 * verification record, and a run lesson whose verdict was "No check was run" however many tests the agent had run
 * itself. These lines are the ones `codex exec --json` really prints (the same captures the VS Code extension's
 * parser is pinned against), and the shapes here are what the rest of KAI reads: `agentChecksFromEvents` looks for
 * `input.command` and `output.exitCode`, and the command card expects an object to render.
 */
const codex = { agent: 'codex' as const, conversationId: 'conv-1' };

describe('the events a CLI line reports', () => {
  it('names a codex command the way the rest of KAI reads it', () => {
    const started = parseAgentLine(
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      'codex',
    );
    expect(lineEvents(codex, started)).toEqual([
      expect.objectContaining({
        type: 'tool.call',
        name: 'run_command',
        status: 'started',
        input: { command: 'npm test' },
      }),
    ]);
  });

  it('carries the exit code and the output of a finished command', () => {
    const completed = parseAgentLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"12 passed","exit_code":0,"status":"completed"}}',
      'codex',
    );
    expect(lineEvents(codex, completed)).toEqual([
      expect.objectContaining({
        status: 'completed',
        input: { command: 'npm test' },
        output: { exitCode: 0, output: '12 passed' },
      }),
    ]);

    // A failing check ends as a failed tool call, and is exactly the result worth recording.
    const failed = parseAgentLine(
      '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"npm test","aggregated_output":"1 failed","exit_code":1,"status":"completed"}}',
      'codex',
    );
    expect(lineEvents(codex, failed)).toEqual([expect.objectContaining({ status: 'failed', output: { exitCode: 1, output: '1 failed' } })]);
  });

  it('reports the files a codex run changed', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9',
        type: 'file_change',
        changes: [
          { path: 'src/a.ts', kind: 'update', added: 12, removed: 3 },
          { path: 'src/new.ts', kind: 'add', added: 7, removed: 0 },
          { path: 'src/gone.ts', kind: 'delete', added: 0, removed: 9 },
        ],
      },
    });
    expect(lineEvents(codex, parseAgentLine(line, 'codex'))).toEqual([
      expect.objectContaining({ type: 'file.change', path: 'src/a.ts', action: 'edited' }),
      expect.objectContaining({ type: 'file.change', path: 'src/new.ts', action: 'created' }),
      expect.objectContaining({ type: 'file.change', path: 'src/gone.ts', action: 'deleted' }),
    ]);
  });

  it('leaves the reply text where it was, so nothing is emitted twice', () => {
    const message = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi! How can I help?"}}';
    const parsed = parseAgentLine(message, 'codex');
    expect(parsed.resultText).toBe('Hi! How can I help?');
    expect(parsed.tools).toBeUndefined();
    expect(lineEvents(codex, parsed)).toEqual([]);
  });

  it('names a claude tool call from the message that asked for it', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me look at the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/app.ts' } },
        ],
      },
    });
    const parsed = parseAgentLine(line, 'claude');
    expect(parsed.text).toBe('Let me look at the file.');
    expect(lineEvents({ agent: 'claude', conversationId: 'conv-1' }, parsed)).toEqual([
      expect.objectContaining({ type: 'tool.call', name: 'Read', status: 'started', input: { file_path: 'src/app.ts' } }),
    ]);
  });

  it('carries a claude tool call\'s id, so its result can be matched back to it', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'Find the bug' } }],
      },
    });
    const parsed = parseAgentLine(line, 'claude');
    expect(parsed.tools).toEqual([
      expect.objectContaining({ name: 'Task', status: 'started', callId: 'toolu_1' }),
    ]);
    expect(lineEvents({ agent: 'claude', conversationId: 'conv-1' }, parsed)).toEqual([
      expect.objectContaining({ type: 'tool.call', name: 'Task', status: 'started', callId: 'toolu_1' }),
    ]);
  });

  it('reads a claude tool result back to the call it answers', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Found it.' }],
      },
    });
    const parsed = parseAgentLine(line, 'claude');
    // The text comes with it: for a failed command, or an edit the person refused, the message *is* the failure —
    // and without it the transcript showed a command card that never finished and no reason why.
    expect(parsed.toolResults).toEqual([{ callId: 'toolu_1', status: 'completed', output: 'Found it.' }]);

    const failedLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'The user does not want to proceed.' }] },
    });
    expect(parseAgentLine(failedLine, 'claude').toolResults).toEqual([
      { callId: 'toolu_2', status: 'failed', output: 'The user does not want to proceed.' },
    ]);
  });

  it('takes claude at its word about what the run cost', () => {
    // Taken from a real `claude -p --output-format stream-json --verbose` result line.
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'OK',
      session_id: '4f228d8f',
      total_cost_usd: 0.030354,
      usage: { input_tokens: 30_344, output_tokens: 2 },
    });
    const parsed = parseAgentLine(line, 'claude');
    expect(parsed.resultText).toBe('OK');
    expect(lineEvents({ agent: 'claude', conversationId: 'conv-1' }, parsed)).toEqual([
      expect.objectContaining({ type: 'cost.update', amountUsd: 0.030354, inputTokens: 30_344, outputTokens: 2 }),
    ]);
  });

  it('says nothing about cost for a CLI that reports none', () => {
    const codexResult = parseAgentLine('{"type":"thread.started","thread_id":"01a090b5"}', 'codex');
    expect(lineEvents(codex, codexResult)).toEqual([]);
  });

  it('emits events KAI will accept, not just objects that look like them', () => {
    const parsed = parseAgentLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
      'codex',
    );
    for (const event of lineEvents(codex, parsed)) {
      expect(persistedEventV1Schema.safeParse(event).success).toBe(true);
      expect(event).toMatchObject({ taskId: 'conv-1', agent: 'codex', schemaVersion: 1 });
    }
  });

  it('is what turns a command the agent ran into a recorded check', () => {
    // The whole point of the mapping: this is the function that feeds the verification history, the regression log
    // and the run lesson, and it could not see a CLI command before.
    const events = lineEvents(codex, parseAgentLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm run test","aggregated_output":"12 passed","exit_code":0,"status":"completed"}}',
      'codex',
    ));
    expect(agentChecksFromEvents(events)).toEqual([
      expect.objectContaining({ command: 'npm run test', source: 'agent', exitCode: 0, output: '12 passed' }),
    ]);

    // A build is not a check, and reading the file is not either.
    const build = lineEvents(codex, parseAgentLine(
      '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"npm run build","aggregated_output":"built","exit_code":0,"status":"completed"}}',
      'codex',
    ));
    expect(agentChecksFromEvents(build)).toEqual([]);
  });
});
