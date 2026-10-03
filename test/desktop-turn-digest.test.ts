import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '../packages/contracts/src';
import { buildTurnDigest } from '../apps/desktop/src/main/turn-digest';

function toolCall(name: string, status: 'completed' | 'failed', input?: unknown, output?: unknown): PersistedEvent {
  return {
    schemaVersion: 1,
    id: `evt_${name}_${status}`,
    taskId: 'conv-1',
    timestamp: '2026-10-03T00:00:00.000Z',
    type: 'tool.call',
    name,
    status,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

describe('buildTurnDigest', () => {
  it('returns an empty string for a turn with no tool calls', () => {
    const events: PersistedEvent[] = [{
      schemaVersion: 1,
      id: 'evt_text',
      taskId: 'conv-1',
      timestamp: '2026-10-03T00:00:00.000Z',
      type: 'text.delta',
      text: 'Just a conversational reply.',
      channel: 'assistant',
    }];
    expect(buildTurnDigest(events)).toBe('');
  });

  it('lists what each finished tool call did, in order, skipping started/updated statuses', () => {
    const events: PersistedEvent[] = [
      toolCall('read_file', 'completed', { path: 'src/a.ts' }),
      toolCall('read_file', 'started', { path: 'src/b.ts' }),
      toolCall('replace_in_file', 'completed', { path: 'src/a.ts' }),
      toolCall('run_command', 'completed', { command: 'npm test' }, { exitCode: 0 }),
      toolCall('run_command', 'failed', { command: 'npm run lint' }, { exitCode: 1 }),
      toolCall('delete_file', 'failed', { path: 'old.ts' }),
    ];

    const digest = buildTurnDigest(events);

    expect(digest).toBe([
      '- Read src/a.ts',
      '- Edited src/a.ts',
      '- Ran `npm test` (succeeded)',
      '- Ran `npm run lint` (failed)',
      '- Failed to delete old.ts',
    ].join('\n'));
  });

  it('caps the entries and says how many more there were', () => {
    const events: PersistedEvent[] = Array.from({ length: 25 }, (_, index) =>
      toolCall('read_file', 'completed', { path: `src/file-${index}.ts` }));

    const digest = buildTurnDigest(events);
    const lines = digest.split('\n');

    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe('- ...and 6 more actions');
  });
});
