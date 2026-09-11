import { describe, expect, it } from 'vitest';
import { parseClaudeJsonLine } from '../src/adapters/claude-parser';
import { parseCodexJsonLine } from '../src/adapters/codex-parser';
import { AcpAgentAdapter } from '../src/adapters/acp-adapter';
import type { ProcessChunk, ProcessResult, ProcessRunner } from '../src/adapters/process-runner';
import type { WorkbenchEvent } from '../src/core/events';

const taskId = 'task_snap';
const agent = 'claude' as const;

/**
 * Adapter conformance snapshot tests.
 *
 * These verify that each adapter's parser maps real-world agent output
 * shapes into the unified WorkbenchEvent model without dropping events
 * or producing unexpected types.
 */

describe('Unified event model conformance', () => {
  describe('Claude parser', () => {
    const claudeAssistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me help with that.' }] },
    });

    const claudeToolUse = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'read_file', input: { path: '/src/app.ts' } }] },
    });

    const claudeUsage = JSON.stringify({
      type: 'message',
      usage: { input_tokens: 200, output_tokens: 50 },
    });

    const claudeError = JSON.stringify({
      type: 'error',
      error: { type: 'overloaded', message: 'Service overloaded' },
    });

    const claudeUnknown = JSON.stringify({ type: 'custom_event', payload: 42 });

    it('maps assistant text → text.delta', () => {
      const result = parseClaudeJsonLine(claudeAssistant, taskId, agent);
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('text.delta');
    });

    it('maps tool_use → tool.call', () => {
      const result = parseClaudeJsonLine(claudeToolUse, taskId, agent);
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('tool.call');
    });

    it('maps usage → cost.update', () => {
      const result = parseClaudeJsonLine(claudeUsage, taskId, agent);
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('cost.update');
    });

    it('maps errors → error', () => {
      const result = parseClaudeJsonLine(claudeError, taskId, agent);
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('error');
    });

    it('maps unknown → raw.fallback (never drops)', () => {
      const result = parseClaudeJsonLine(claudeUnknown, taskId, agent);
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('raw.fallback');
    });

    it('suppresses system/ping events', () => {
      expect(parseClaudeJsonLine(JSON.stringify({ type: 'system' }), taskId, agent)).toBeNull();
      expect(parseClaudeJsonLine(JSON.stringify({ type: 'ping' }), taskId, agent)).toBeNull();
    });

    it('handles non-JSON as raw text.delta', () => {
      const result = parseClaudeJsonLine('plain text', taskId, agent);
      expect(result).toMatchObject({ type: 'text.delta', channel: 'raw' });
    });
  });

  // Fixtures verified against a real `codex exec --json --sandbox
  // read-only` run (codex-cli 0.153.4) — see codex-parser.ts's module doc.
  describe('Codex parser', () => {
    const codexAgentMessage = JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Here is the fix.' } });
    const codexToolStart = JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } });
    const codexUsage = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 60 } });
    const codexError = JSON.stringify({ type: 'error', error: 'Model unavailable' });
    const codexUnknown = JSON.stringify({ type: 'custom_event', data: 99 });

    it('maps an agent_message item → text.delta', () => {
      const result = parseCodexJsonLine(codexAgentMessage, taskId, 'codex');
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('text.delta');
    });

    it('maps a started command_execution item → tool.call', () => {
      const result = parseCodexJsonLine(codexToolStart, taskId, 'codex');
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('tool.call');
    });

    it('maps turn.completed usage → cost.update', () => {
      const result = parseCodexJsonLine(codexUsage, taskId, 'codex');
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('cost.update');
    });

    it('maps error → error', () => {
      const result = parseCodexJsonLine(codexError, taskId, 'codex');
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('error');
    });

    it('maps unknown → raw.fallback (never drops)', () => {
      const result = parseCodexJsonLine(codexUnknown, taskId, 'codex');
      expect(Array.isArray(result) ? result[0]?.type : result?.type).toBe('raw.fallback');
    });

    it('suppresses turn.started', () => {
      expect(parseCodexJsonLine(JSON.stringify({ type: 'turn.started' }), taskId, 'codex')).toBeNull();
    });
  });

  describe('ACP stream buffering', () => {
    it('buffers a JSON line split across three chunks', async () => {
      const adapter = new AcpAgentAdapter(
        {
          id: 'qwen',
          displayName: 'Qwen',
          command: 'qwen',
          parseLine: (line, taskId, agent) => ({
            id: 'acp_split_event',
            type: 'text.delta',
            taskId,
            timestamp: '2026-07-03T00:00:00.000Z',
            agent,
            channel: 'assistant',
            text: JSON.parse(line).message as string,
          }),
        },
        new SplitRunner(),
      );

      const events: WorkbenchEvent[] = [];
      for await (const event of adapter.run({ taskId: 'task_acp_split', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
        events.push(event);
      }

      expect(events).toContainEqual(expect.objectContaining({ id: 'acp_split_event', text: 'hello' }));
    });
  });

  describe('Parser event arrays', () => {
    it('yields every event returned by an ACP parser', async () => {
      const adapter = new AcpAgentAdapter(
        {
          id: 'qwen',
          displayName: 'Qwen',
          command: 'qwen',
          parseLine: (line, taskId, agent) => [
            {
              id: 'acp_event_1',
              type: 'text.delta',
              taskId,
              timestamp: '2026-07-03T00:00:00.000Z',
              agent,
              channel: 'assistant',
              text: line,
            },
            {
              id: 'acp_event_2',
              type: 'raw.fallback',
              taskId,
              timestamp: '2026-07-03T00:00:00.000Z',
              agent,
              sourceType: 'test',
              payload: line,
            },
          ],
        },
        new ArrayRunner(),
      );

      const events: WorkbenchEvent[] = [];
      for await (const event of adapter.run({ taskId: 'task_acp_parser', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
        events.push(event);
      }

      expect(events.filter((event) => event.id.startsWith('acp_event_')).map((event) => event.id))
        .toEqual(['acp_event_1', 'acp_event_2']);
    });
  });

  describe('Event shape invariants', () => {
    // Every event must carry id, type, taskId, timestamp
    const allParsers: Array<{ name: string; parse: (line: string) => WorkbenchEvent | WorkbenchEvent[] | null; line: string }> = [
      {
        name: 'claude text',
        parse: (l) => parseClaudeJsonLine(l, taskId, 'claude'),
        line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      },
      {
        name: 'codex agent_message',
        parse: (l) => parseCodexJsonLine(l, taskId, 'codex'),
        line: JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi' } }),
      },
    ];

    for (const { name, parse, line } of allParsers) {
      it(`${name} event has required fields`, () => {
        const result = parse(line);
        const event = Array.isArray(result) ? result[0] : result;
        expect(event).not.toBeNull();
        expect(event!.id).toBeTruthy();
        expect(event!.type).toBeTruthy();
        expect(event!.taskId).toBe(taskId);
        expect(event!.timestamp).toBeTruthy();
      });
    }
  });
});

class ArrayRunner implements ProcessRunner {
  async commandInfo() {
    return { available: true, version: 'qwen 1.0.0' };
  }

  async *run(): AsyncIterable<ProcessChunk | ProcessResult> {
    yield { stream: 'stdout', text: 'parsed\\n' };
    yield { code: 0, signal: null };
  }
}

class SplitRunner implements ProcessRunner {
  async commandInfo() {
    return { available: true, version: 'qwen 1.0.0' };
  }

  async *run(): AsyncIterable<ProcessChunk | ProcessResult> {
    yield { stream: 'stdout', text: '{"mes' };
    yield { stream: 'stdout', text: 'sage":"hello' };
    yield { stream: 'stdout', text: '"}\n' };
    yield { code: 0, signal: null };
  }
}
