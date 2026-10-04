import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { endWhenParentGoes } from '../apps/desktop/src/main/kai-project-server';

/**
 * The `kai-project` MCP server has to end when the agent that launched it goes away.
 *
 * It did not: an MCP server is stdio, and the SDK's transport registers `data` and `error` but never `end`, so EOF on
 * stdin did nothing and the reader left attached kept the event loop alive. Every agent session that ended — normally,
 * by crashing, or by being killed — left one of these processes behind, holding its project open, and KAI's quit-time
 * `taskkill /T` never saw them because the agent launches them rather than KAI.
 */

/** The close-then-exit is chained through promises; a couple of ticks is plenty but the wait is generous. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('kai-project server lifetime', () => {
  it('ends when the agent that launched it closes the pipe', async () => {
    const input = new PassThrough();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    endWhenParentGoes({ close }, input, exit);

    input.end();
    await tick();

    // Closed before exiting, so a tool call in flight is not cut off mid-write.
    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ends once, however many ways the news arrives', async () => {
    const input = new PassThrough();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    endWhenParentGoes({ close }, input, exit);

    input.end();
    input.emit('close');
    input.emit('close');
    await tick();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still exits when closing the server is what fails', async () => {
    // A wedged server must not be the reason the process stays alive: the whole point is to leave.
    const input = new PassThrough();
    const close = vi.fn(async () => { throw new Error('transport already gone'); });
    const exit = vi.fn();
    endWhenParentGoes({ close }, input, exit);

    input.end();
    await tick();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('listens for a signal as well as for the pipe, and takes one handler each', () => {
    // Registered rather than emitted: raising SIGTERM in this process would run whatever else is listening for it.
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    endWhenParentGoes({ close: async () => undefined }, new PassThrough(), () => undefined);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);

    for (const listener of process.listeners('SIGTERM').slice(beforeTerm)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT').slice(beforeInt)) process.removeListener('SIGINT', listener);
  });
});
