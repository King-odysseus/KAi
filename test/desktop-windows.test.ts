import { describe, expect, it, vi } from 'vitest';
import type { AgentRunEvent } from '../packages/contracts/src';
import { DesktopWindowRegistry, projectSelectionForWindow } from '../apps/desktop/src/main/desktop-windows';
import { shouldHandleAgentEvent } from '../apps/desktop/src/renderer/src/agent-events';

function fakeWindow(id: number, focused = false) {
  const send = vi.fn();
  return {
    webContents: { id, send },
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    send,
  };
}

describe('desktop window routing', () => {
  it('keeps project state isolated while routing terminal and agent events to the owner', () => {
    const registry = new DesktopWindowRegistry();
    const first = fakeWindow(11, true) as never;
    const second = fakeWindow(22) as never;
    registry.register(first, 'project-a');
    registry.register(second, 'project-b');

    expect(registry.get(11)?.projectId).toBe('project-a');
    expect(registry.get(22)?.projectId).toBe('project-b');
    expect(registry.send(11, 'terminal:event', { output: 'a' })).toBe(true);
    expect((first as ReturnType<typeof fakeWindow>).send).toHaveBeenCalledWith('terminal:event', { output: 'a' });
    expect((second as ReturnType<typeof fakeWindow>).send).not.toHaveBeenCalled();

    registry.broadcast('app:shared-state', { settings: {} });
    expect((first as ReturnType<typeof fakeWindow>).send).toHaveBeenLastCalledWith('app:shared-state', { settings: {} });
    expect((second as ReturnType<typeof fakeWindow>).send).toHaveBeenCalledWith('app:shared-state', { settings: {} });
    expect(registry.focused()?.id).toBe(11);

    registry.remove(11);
    expect(registry.get(11)).toBeNull();
    expect(registry.get(22)?.projectId).toBe('project-b');
  });

  it('accepts workflow approvals even when this window has no running conversation', () => {
    const approval = {
      conversationId: 'workflow-conversation',
      event: { type: 'approval.request', requestId: 'approval-1' },
    } as AgentRunEvent;
    const output = {
      conversationId: 'another-conversation',
      event: { type: 'text.delta', channel: 'assistant', text: 'ignored' },
    } as AgentRunEvent;
    const currentOutput = {
      conversationId: 'running-conversation',
      event: { type: 'text.delta', channel: 'assistant', text: 'shown' },
    } as AgentRunEvent;

    expect(shouldHandleAgentEvent(approval, null)).toBe(true);
    expect(shouldHandleAgentEvent(output, 'running-conversation')).toBe(false);
    expect(shouldHandleAgentEvent(currentOutput, 'running-conversation')).toBe(true);
  });

  it('keeps an explicit empty project on a new window instead of inheriting the global selection', () => {
    expect(projectSelectionForWindow({ projectId: null }, 'project-a')).toBeNull();
    expect(projectSelectionForWindow({ projectId: 'project-b' }, 'project-a')).toBe('project-b');
    expect(projectSelectionForWindow(null, 'project-a')).toBe('project-a');
  });
});
