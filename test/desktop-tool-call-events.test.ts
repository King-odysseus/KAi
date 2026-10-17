import { describe, expect, it } from 'vitest';
import type { PersistedEvent } from '@kai/contracts';
import { collapseToolCalls } from '../apps/desktop/src/renderer/src/tool-call-events';

const base = { schemaVersion: 1 as const, taskId: 'task-1', agent: 'codex' as const };

let counter = 0;
function call(name: string, status: 'started' | 'completed' | 'failed', callId: string | undefined, at: number): PersistedEvent {
  counter += 1;
  return {
    ...base,
    id: `event-${counter}`,
    timestamp: new Date(Date.UTC(2026, 9, 17, 12, 0, at)).toISOString(),
    type: 'tool.call',
    name,
    status,
    ...(callId ? { callId } : {}),
  } as PersistedEvent;
}

function note(at: number): PersistedEvent {
  counter += 1;
  return { ...base, id: `event-${counter}`, timestamp: new Date(Date.UTC(2026, 9, 17, 12, 0, at)).toISOString(), type: 'notice', message: `note ${at}` } as PersistedEvent;
}

/**
 * A call is stored as a "started" event and a result event. The transcript drew both, so every finished edit
 * appeared twice — its result, and the "started" card that stayed on screen as a spinner.
 */
describe('one row per tool call', () => {
  it('shows a finished call once, as the state it ended in', () => {
    const events = [call('replace_in_file', 'started', 'a', 1), call('replace_in_file', 'completed', 'a', 2)];
    const shown = collapseToolCalls(events);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ status: 'completed', callId: 'a' });
  });

  it('keeps a call that has not finished, and one that failed', () => {
    const running = collapseToolCalls([call('read_file', 'started', 'a', 1)]);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ status: 'started' });
    const failed = collapseToolCalls([call('run_command', 'started', 'b', 1), call('run_command', 'failed', 'b', 2)]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed' });
  });

  it('keeps calls in the order they began, even when they finish out of order', () => {
    const events = [
      call('read_file', 'started', 'a', 1),
      call('write_file', 'started', 'b', 2),
      note(3),
      call('write_file', 'completed', 'b', 4),
      call('read_file', 'completed', 'a', 5),
    ];
    const shown = collapseToolCalls(events);
    expect(shown.map((event) => (event.type === 'tool.call' ? `${event.callId}:${event.status}` : event.type))).toEqual([
      'a:completed',
      'b:completed',
      'notice',
    ]);
  });

  it('never merges calls that merely look alike, or events that carry no call id', () => {
    // Two edits to the same file are two calls. Without ids there is nothing to say a started event belongs to a result.
    const events = [
      call('replace_in_file', 'completed', 'a', 1),
      call('replace_in_file', 'completed', 'b', 2),
      call('web_fetch', 'started', undefined, 3),
      call('web_fetch', 'completed', undefined, 4),
    ];
    expect(collapseToolCalls(events)).toHaveLength(4);
  });

  it('leaves everything else untouched, and does not change the list it was given', () => {
    const events = [note(1), call('read_file', 'started', 'a', 2), call('read_file', 'completed', 'a', 3)];
    const before = [...events];
    expect(collapseToolCalls(events).filter((event) => event.type === 'notice')).toHaveLength(1);
    expect(events).toEqual(before);
    expect(collapseToolCalls([])).toEqual([]);
  });
});
