import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@kai/contracts';
import { blockedActions } from '../apps/desktop/src/renderer/src/components/blocked-actions';

const base = {
  schemaVersion: 1 as const,
  id: 'event-1',
  taskId: 'task-1',
  timestamp: '2026-09-24T10:00:00.000Z',
};

function event(overrides: Partial<PersistedEvent> & { id?: string }): PersistedEvent {
  return { ...base, ...overrides } as PersistedEvent;
}

describe('blockedActions', () => {
  it('finds nothing in a run with no blocked calls', () => {
    const completed = event({ id: 'e1', type: 'tool.call', name: 'read_file', status: 'completed', output: { content: 'hi' } });
    expect(blockedActions([completed])).toEqual([]);
  });

  it('ignores an ordinary tool failure that was not blocked by anything', () => {
    const failed = event({ id: 'e1', type: 'tool.call', name: 'run_command', status: 'failed', output: { error: 'command not found' } });
    expect(blockedActions([failed])).toEqual([]);
  });

  it('picks up a call the access level refused', () => {
    const denied = event({
      id: 'e1', type: 'tool.call', name: 'delete_file', status: 'failed', callId: 'call_1',
      output: { error: 'Plan mode does not allow delete_file.', blocked: true, blockedBy: 'policy' },
    });
    expect(blockedActions([denied])).toEqual([
      { id: 'call_1', tool: 'delete_file', reason: 'Plan mode does not allow delete_file.', blockedBy: 'policy', timestamp: base.timestamp },
    ]);
  });

  it('picks up a call a project hook blocked, and one the person declined', () => {
    const hookBlocked = event({
      id: 'e1', type: 'tool.call', name: 'run_command', status: 'failed', callId: 'call_2',
      output: { error: 'A project preTool hook blocked this call: no network access', blocked: true, blockedBy: 'hook' },
    });
    const userDeclined = event({
      id: 'e2', type: 'tool.call', name: 'write_file', status: 'failed', callId: 'call_3',
      output: { error: 'The user denied this project change.', blocked: true, blockedBy: 'user' },
    });
    expect(blockedActions([hookBlocked, userDeclined]).map((entry) => entry.blockedBy)).toEqual(['hook', 'user']);
  });

  it('falls back to the call id when there is none, and keeps the order they happened in', () => {
    const first = event({
      id: 'e1', type: 'tool.call', name: 'write_file', status: 'failed',
      output: { error: 'Blocked once.', blocked: true, blockedBy: 'policy' },
    });
    const second = event({
      id: 'e2', type: 'tool.call', name: 'write_file', status: 'failed',
      output: { error: 'Blocked twice.', blocked: true, blockedBy: 'policy' },
    });
    expect(blockedActions([first, second]).map((entry) => entry.id)).toEqual(['e1', 'e2']);
  });
});
