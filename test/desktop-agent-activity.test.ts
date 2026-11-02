import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@kai/contracts';
import { activeAgentCount, codingNuggets, deriveAgentActivity } from '../apps/desktop/src/renderer/src/components/AgentActivity';

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

  it('says Auto is waiting for the person, rather than calling a run they never paused "Paused"', () => {
    const read = event({ type: 'tool.call', name: 'read_file', status: 'started', input: { path: 'src/App.tsx' } });
    // Auto parked the run, so the composer treats it as paused too; the person still did not pause anything.
    const parked = deriveAgentActivity([read], true, true, false, true);
    expect(parked).toMatchObject({ kind: 'waiting', label: 'Waiting for you' });
    expect(parked.detail).toContain('Answer in the composer');
    expect(parked.detail).not.toContain('suspended');
    // A pause the person asked for keeps its own wording, and a pending approval still wins over both.
    expect(deriveAgentActivity([read], true, true, false, false)).toMatchObject({ kind: 'paused', label: 'Paused' });
    expect(deriveAgentActivity([read], true, true, true, true)).toMatchObject({ label: 'Waiting for approval' });
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

  it('counts sub-agents by matching each Task call\'s id to its result, not just by name', () => {
    expect(activeAgentCount([])).toBe(0);

    const oneRunning = [event({ type: 'tool.call', name: 'Task', status: 'started', callId: 'a' })];
    expect(activeAgentCount(oneRunning)).toBe(1);

    const twoRunning = [
      event({ type: 'tool.call', name: 'Task', status: 'started', callId: 'a' }),
      event({ type: 'tool.call', name: 'Task', status: 'started', callId: 'b' }),
    ];
    expect(activeAgentCount(twoRunning)).toBe(2);

    const oneFinished = [...twoRunning, event({ type: 'tool.call', name: 'Task', status: 'completed', callId: 'a' })];
    expect(activeAgentCount(oneFinished)).toBe(1);

    // A tool call with no id, or one that isn't a sub-agent tool, never counts.
    const unrelated = [
      event({ type: 'tool.call', name: 'Task', status: 'started' }),
      event({ type: 'tool.call', name: 'Read', status: 'started', callId: 'c' }),
    ];
    expect(activeAgentCount(unrelated)).toBe(0);

    // `explore` is a nested agent run too, in the Direct API route rather than claude's own Task tool.
    const exploring = [event({ type: 'tool.call', name: 'explore', status: 'started', callId: 'd' })];
    expect(activeAgentCount(exploring)).toBe(1);
  });

  it('offers a short coding concept from observable work instead of exposing hidden reasoning', () => {
    const react = event({ type: 'tool.call', name: 'read_file', status: 'started', input: { path: 'src/Profile.tsx' } });
    expect(codingNuggets([react])[0]).toContain('React re-renders');

    const django = event({ type: 'tool.call', name: 'read_file', status: 'started', input: { path: 'manage.py' } });
    expect(codingNuggets([django])[0]).toContain('Django views');

    expect(deriveAgentActivity([react], true, false, false).learningNuggets.length).toBeGreaterThan(0);
  });
});

function event(value: Omit<PersistedEvent, keyof typeof base>): PersistedEvent {
  return { ...base, ...value } as PersistedEvent;
}
