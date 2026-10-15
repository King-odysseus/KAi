import { describe, expect, it } from 'vitest';
import { toolCallStatus } from '../apps/desktop/src/renderer/src/components/ToolCallCard';
import { groupExecutableCommands } from '../apps/desktop/src/renderer/src/components/Workspace';
import type { PersistedEvent } from '@kai/contracts';

/**
 * How a tool call reads in the transcript.
 *
 * A call is stored as `started` (or `updated`) and only flips to a finished status when its result arrives. A run
 * that died with the process never delivers one, so the stored status on its own left those calls spinning forever
 * and claiming work that nothing was doing. The second half of the question — is anything still running — is what
 * separates the two. Derived by a plain function returning a mark rather than an icon, so it is testable without a
 * DOM, the same shape as `desktop-composer-run-line`.
 */
describe('toolCallStatus', () => {
  it('reads a finished call as done whether or not the run is going', () => {
    expect(toolCallStatus('completed', true)).toEqual({ mark: 'check', word: 'Done' });
    expect(toolCallStatus('completed', false)).toEqual({ mark: 'check', word: 'Done' });
  });

  it('reads a failed call as failed whether or not the run is going', () => {
    expect(toolCallStatus('failed', true)).toEqual({ mark: 'x', word: 'Failed' });
    expect(toolCallStatus('failed', false)).toEqual({ mark: 'x', word: 'Failed' });
  });

  it('spins only while something is still running', () => {
    expect(toolCallStatus('started', true)).toEqual({ mark: 'spin', word: 'Running' });
    expect(toolCallStatus('updated', true)).toEqual({ mark: 'spin', word: 'Running' });
  });

  it('reads an unfinished call with no run behind it as interrupted, never as running', () => {
    const started = toolCallStatus('started', false);
    const updated = toolCallStatus('updated', false);
    expect(started).toEqual({ mark: 'dash', word: 'Interrupted' });
    expect(updated).toEqual({ mark: 'dash', word: 'Interrupted' });
    // The mark is the point: a spinner is a claim that work is happening, which is exactly what was untrue.
    expect(started.mark).not.toBe('spin');
    expect(updated.mark).not.toBe('spin');
  });
});

describe('groupExecutableCommands', () => {
  const event = (id: string, name: string): PersistedEvent => ({
    id,
    type: 'tool.call',
    timestamp: '2026-10-15T20:00:00.000Z',
    name,
    status: 'completed',
  }) as PersistedEvent;

  it('folds consecutive commands together without moving other transcript events', () => {
    const edit = event('edit', 'replace_in_file');
    const groups = groupExecutableCommands([
      event('command-1', 'run_command'),
      event('command-2', 'shell_command'),
      edit,
      event('command-3', 'bash'),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ kind: 'commands', events: [{ id: 'command-1' }, { id: 'command-2' }] });
    expect(groups[1]).toEqual({ kind: 'event', event: edit });
    expect(groups[2]).toMatchObject({ kind: 'commands', events: [{ id: 'command-3' }] });
  });
});
