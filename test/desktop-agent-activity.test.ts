import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@kai/contracts';
import { deriveAgentActivity } from '../apps/desktop/src/renderer/src/components/AgentActivity';

const base = {
  schemaVersion: 1 as const,
  id: 'event-1',
  taskId: 'task-1',
  timestamp: '2026-09-24T10:00:00.000Z',
};

describe('desktop agent activity summary', () => {
  it('distinguishes reading, editing, checking, approval, blocked, and paused states', () => {
    const read = event({ type: 'tool.call', name: 'read_file', status: 'started', input: { path: 'src/App.tsx' } });
    expect(deriveAgentActivity([read], true, false, false)).toMatchObject({
      kind: 'reading',
      label: 'Reading files',
      detail: 'src/App.tsx',
    });

    const edit = event({ type: 'tool.call', name: 'apply_patch', status: 'started', input: { path: 'src/App.tsx' } });
    expect(deriveAgentActivity([edit], true, false, false).kind).toBe('editing');

    const check = event({ type: 'tool.call', name: 'shell_command', status: 'started', input: { command: 'npm test' } });
    expect(deriveAgentActivity([check], true, false, false)).toMatchObject({ kind: 'checking', detail: 'npm test' });
    expect(deriveAgentActivity([read], true, false, true)).toMatchObject({ kind: 'waiting', label: 'Waiting for approval' });
    expect(deriveAgentActivity([read], true, true, false)).toMatchObject({ kind: 'paused', label: 'Paused' });

    const blocked = event({ type: 'error', message: 'The build failed.', recoverable: false });
    expect(deriveAgentActivity([blocked], true, false, false)).toMatchObject({ kind: 'blocked', detail: 'The build failed.' });
  });

  it('surfaces reviewable changes and the last meaningful action when idle', () => {
    const changes = event({
      type: 'turn.changes',
      turnId: 'turn-1',
      files: [{ path: 'src/App.tsx', added: 4, removed: 2 }],
      hasCheckpoint: true,
    });
    expect(deriveAgentActivity([changes], false, false, false)).toMatchObject({
      kind: 'completed',
      label: 'Changes ready to review',
      lastAction: 'Changed 1 file',
    });
  });
});

function event(value: Omit<PersistedEvent, keyof typeof base>): PersistedEvent {
  return { ...base, ...value } as PersistedEvent;
}
