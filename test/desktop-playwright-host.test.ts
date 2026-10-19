import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_HOST_PORT,
  PLAYWRIGHT_MCP_VERSION,
  playwrightEndpoint,
  playwrightLaunchCommand,
  playwrightServerArgs,
  startPlaywrightHost,
  type PlaywrightChild,
  type PlaywrightHostPorts,
} from '../apps/desktop/src/main/playwright-host';

/** A child that the test controls: it says what it printed, and when it stopped. */
function fakeChild(): PlaywrightChild & { print(text: string): void; stop(code: number | null): void } {
  let onExit: (code: number | null) => void = () => undefined;
  let onOutput: (text: string) => void = () => undefined;
  return {
    pid: 4242,
    onExit: (listener) => { onExit = listener; },
    onOutput: (listener) => { onOutput = listener; },
    print: (text) => onOutput(text),
    stop: (code) => onExit(code),
  };
}

interface Harness {
  ports: PlaywrightHostPorts;
  launched: Array<{ port: number; extraArgs: readonly string[] }>;
  killed: PlaywrightChild[];
  child: ReturnType<typeof fakeChild>;
  clock: { now: number };
}

/**
 * A harness whose clock only moves when the host sleeps, so a timeout is reached by waiting rather than by a real
 * wait. `answersFrom` says when, in polls, each endpoint starts answering.
 */
function harness(options: { answering?: Set<string>; busyPorts?: Set<number>; answersAfterPolls?: number } = {}): Harness {
  const launched: Harness['launched'] = [];
  const killed: PlaywrightChild[] = [];
  const child = fakeChild();
  const clock = { now: 0 };
  const answering = options.answering ?? new Set<string>();
  let polls = 0;
  const ports: PlaywrightHostPorts = {
    launch: (port, extraArgs) => { launched.push({ port, extraArgs }); return child; },
    killTree: async (target) => { killed.push(target); },
    portIsFree: async (port) => !(options.busyPorts ?? new Set()).has(port),
    anyFreePort: async () => 51_234,
    answers: async (endpoint) => {
      if (answering.has(endpoint)) return true;
      // Only the server this harness launched answers after a while.
      if (launched.length > 0 && options.answersAfterPolls !== undefined) {
        polls += 1;
        return polls > options.answersAfterPolls;
      }
      return false;
    },
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
  };
  return { ports, launched, killed, child, clock };
}

describe('the shared browser server command', () => {
  it('pins the version, binds the IPv4 loopback, allows both loopback names and shares one browser context', () => {
    const args = playwrightServerArgs(8931);
    expect(args).toContain(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1']);
    expect(args[args.indexOf('--allowed-hosts') + 1]).toBe('127.0.0.1:8931,localhost:8931');
    expect(args[args.indexOf('--port') + 1]).toBe('8931');
    expect(args).toContain('--shared-browser-context');
    // Left out on purpose: headless would take away the window the person is there to watch.
    expect(args).not.toContain('--headless');
  });

  it('adds extra flags last, for a run that must not open a window', () => {
    expect(playwrightServerArgs(1, ['--headless']).at(-1)).toBe('--headless');
  });

  it('goes through the command interpreter on Windows, where npx is a script, and runs npx directly elsewhere', () => {
    const windows = playwrightLaunchCommand(8931, 'win32');
    expect(windows.command).toBe('cmd.exe');
    expect(windows.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(windows.args[3]).toMatch(/^npx -y @playwright\/mcp@/);
    const linux = playwrightLaunchCommand(8931, 'linux');
    expect(linux.command).toBe('npx');
    expect(linux.args[0]).toBe('-y');
  });

  it('names the endpoint by the IPv4 address it is bound to', () => {
    expect(playwrightEndpoint(8931)).toBe('http://127.0.0.1:8931/mcp');
  });
});

describe('starting the shared browser server', () => {
  it('starts one on the usual port and answers with its endpoint once it is ready', async () => {
    const { ports, launched } = harness({ answersAfterPolls: 3 });
    const host = await startPlaywrightHost(ports);
    expect(launched).toEqual([{ port: PLAYWRIGHT_HOST_PORT, extraArgs: [] }]);
    expect(host).toMatchObject({ endpoint: `http://127.0.0.1:${PLAYWRIGHT_HOST_PORT}/mcp`, port: PLAYWRIGHT_HOST_PORT, adopted: false });
  });

  it('uses a server that is already running instead of starting a second one, and leaves it running', async () => {
    const answering = new Set([playwrightEndpoint(PLAYWRIGHT_HOST_PORT)]);
    const { ports, launched, killed } = harness({ answering });
    const host = await startPlaywrightHost(ports);
    expect(host.adopted).toBe(true);
    expect(launched).toEqual([]);
    await host.close();
    // It was not KAI's to end.
    expect(killed).toEqual([]);
  });

  it('takes another port when the usual one is busy with something that is not a browser server', async () => {
    const { ports, launched } = harness({ busyPorts: new Set([PLAYWRIGHT_HOST_PORT]), answersAfterPolls: 1 });
    const host = await startPlaywrightHost(ports);
    expect(launched[0]?.port).toBe(51_234);
    expect(host.endpoint).toBe('http://127.0.0.1:51234/mcp');
  });

  it('passes extra flags to the server it starts', async () => {
    const { ports, launched } = harness({ answersAfterPolls: 0 });
    await startPlaywrightHost(ports, { extraArgs: ['--headless'] });
    expect(launched[0]?.extraArgs).toEqual(['--headless']);
  });

  it('ends the whole process tree when the host is closed', async () => {
    const { ports, killed, child } = harness({ answersAfterPolls: 0 });
    const host = await startPlaywrightHost(ports);
    await host.close();
    expect(killed).toEqual([child]);
  });

  it('says why when the server stops before it is ready, with what it printed', async () => {
    const running = harness();
    const pending = startPlaywrightHost(running.ports);
    await untilLaunched(running);
    running.child.print('Error: browserType.launch: Executable does not exist');
    running.child.stop(1);
    await expect(pending).rejects.toThrow(/stopped \(exit 1\) before it was ready\. Its last output: .*Executable does not exist/);
  });

  it('does the same when the server fails the moment it is launched', async () => {
    await expect(startPlaywrightHost(harnessThatFailsFast())).rejects.toThrow(/Its last output: .*Executable does not exist/);
  });

  it('gives up and ends the server it started when it never answers', async () => {
    const { ports, killed, child } = harness();
    await expect(startPlaywrightHost(ports, { timeoutMs: 2_000 })).rejects.toThrow(/did not answer within 2 seconds/);
    expect(killed).toEqual([child]);
  });

  it('reports a server that stops after it was ready, so the loss is not silent', async () => {
    const { ports, child } = harness({ answersAfterPolls: 0 });
    const stops: Array<number | null> = [];
    await startPlaywrightHost(ports, { onStopped: (code) => stops.push(code) });
    child.stop(137);
    expect(stops).toEqual([137]);
  });

  it('does not report the stop of a server that failed to become ready as a stop after readiness', async () => {
    const running = harness();
    const stops: Array<number | null> = [];
    const pending = startPlaywrightHost(running.ports, { onStopped: (code) => stops.push(code) });
    await untilLaunched(running);
    running.child.stop(1);
    await expect(pending).rejects.toThrow(/stopped \(exit 1\)/);
    expect(stops).toEqual([]);
  });
});

/** Waits until the host has launched its server, and so has registered what it listens for. */
async function untilLaunched(running: Harness): Promise<void> {
  for (let turn = 0; turn < 100 && running.launched.length === 0; turn += 1) await Promise.resolve();
  expect(running.launched.length).toBeGreaterThan(0);
}

/** A harness whose server prints an error and exits as soon as it is started. */
function harnessThatFailsFast(): PlaywrightHostPorts {
  const { ports } = harness();
  return {
    ...ports,
    launch: (port, extraArgs) => {
      const child = fakeChild();
      // The host registers its listeners right after launch, so the failure is delivered on the next tick.
      queueMicrotask(() => { child.print('Error: browserType.launch: Executable does not exist'); child.stop(1); });
      void port; void extraArgs;
      return child;
    },
  };
}
