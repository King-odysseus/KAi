import { describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../packages/contracts/src';

/**
 * `registerIpc` builds its handler table before wiring it to ipcMain, so these tests need an
 * electron stub but no real IpcContext: nothing in the registration path touches the context.
 * The two members below are all the ipcMain wrapper reads before it reaches a handler body.
 */
const { wired } = vi.hoisted(() => ({ wired: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: unknown) => wired.set(channel, handler) },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  shell: {},
}));

const { registerIpc } = await import('../apps/desktop/src/main/ipc');
type IpcContext = Parameters<typeof registerIpc>[0];
type IpcRequestContext = Parameters<ReturnType<typeof registerIpc>['dispatch']>[2];
type InvokeResponse = { ok: true; data: unknown } | { ok: false; error: { code: string } };

const stubContext = {
  windows: { fromWebContentsId: () => null },
  logger: { error: () => undefined },
} as unknown as IpcContext;

const stubRequest = { session: null, ownerWindowId: 0 } as IpcRequestContext;
const fakeEvent = { senderFrame: { url: 'file:///renderer/index.html' }, sender: { id: 7 } };

const registry = registerIpc(stubContext);

/** The renderer path, as Electron would call it: (event, rawInput) -> IpcResponse. */
function invokeFromRenderer(channel: string, rawInput: unknown): Promise<InvokeResponse> {
  const handler = wired.get(channel) as (event: unknown, rawInput: unknown) => Promise<InvokeResponse>;
  return handler(fakeEvent, rawInput);
}

describe('registerIpc handler registry', () => {
  it('registers exactly one handler for every declared channel', () => {
    expect([...registry.channels()].sort()).toEqual([...ipcChannels].sort());
  });

  it('wires the same set of channels to ipcMain', () => {
    expect([...wired.keys()].sort()).toEqual([...ipcChannels].sort());
  });

  it('registers the escape hatch for a run the renderer has lost control of', () => {
    // Named explicitly, because the two equality checks above would also pass if this channel were dropped from
    // both the contract and the registry at once, which is the one way it could go missing unnoticed.
    expect([...registry.channels()]).toContain('runs:stop-all');
  });

  it('validates input on the ipcMain path, before any handler body runs', async () => {
    const result = await invokeFromRenderer('agents:run', { not: 'a valid run request' });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('validates input on the dispatch path too', async () => {
    await expect(registry.dispatch('agents:run', { not: 'a valid run request' }, stubRequest))
      .rejects.toThrow();
  });

  it('refuses an untrusted renderer before validating anything', async () => {
    const handler = wired.get('agents:run') as (event: unknown, rawInput: unknown) => Promise<InvokeResponse>;
    const result = await handler(
      { senderFrame: { url: 'https://evil.example/' }, sender: { id: 7 } },
      { not: 'a valid run request' },
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: 'INTERNAL' } });
  });

  it('rejects a channel that has no handler', async () => {
    await expect(
      registry.dispatch('nope:not-real' as never, {}, stubRequest),
    ).rejects.toThrow(/No handler is registered/);
  });
});
