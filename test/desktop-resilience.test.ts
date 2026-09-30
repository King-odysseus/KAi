import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { streamProcess } from '../apps/desktop/src/main/agent-runtime';
import { fetchWithHeaderTimeout, readSseEvents } from '../apps/desktop/src/main/direct-provider-runtime';

const servers: http.Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function streamOf(chunks: string[], stallAfter = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
        return;
      }
      if (!stallAfter) controller.close();
      // Otherwise never settle: a provider that has gone quiet.
      return new Promise<void>(() => undefined);
    },
  });
}

describe('provider requests that never answer', () => {
  it('gives up when the response headers never arrive, with a message the user can read', async () => {
    const url = await listen(() => { /* accept the request and say nothing */ });
    const startedAt = Date.now();
    await expect(fetchWithHeaderTimeout(url, { method: 'POST', signal: new AbortController().signal }, 300)).rejects.toThrow(/did not respond within/);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('does not cut off a reply whose body takes longer than the header timeout', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.end('data: two\n\n'), 700);
    });
    const response = await fetchWithHeaderTimeout(url, { signal: new AbortController().signal }, 300);
    expect(await response.text()).toContain('data: two');
  });

  it('still reports a cancel as a cancel, not as a timeout', async () => {
    const url = await listen(() => { /* never answers */ });
    const controller = new AbortController();
    const pending = fetchWithHeaderTimeout(url, { signal: controller.signal }, 5_000);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('a provider stream that goes quiet', () => {
  it('delivers what arrived, then fails instead of waiting forever', async () => {
    const events: string[] = [];
    const run = async (): Promise<void> => {
      for await (const event of readSseEvents(streamOf(['data: first\n\n']).valueOf(), 200)) events.push(event.data);
    };
    // The generator ends its stream only when the provider does, so a stall must surface as an error.
    await expect(run()).resolves.toBeUndefined();
    const stalled = async (): Promise<void> => {
      for await (const event of readSseEvents(streamOf(['data: first\n\n'], true), 200)) events.push(event.data);
    };
    await expect(stalled()).rejects.toThrow(/stopped sending data/);
    expect(events).toEqual(['first', 'first']);
  });
});

describe('a CLI that leaves a background process behind', () => {
  it('ends the run once the CLI exits instead of waiting for the background process', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kai-cli-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'agent.cjs'), [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 9000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
      "console.log('agent output');",
    ].join(String.fromCharCode(10)));

    const startedAt = Date.now();
    const seen: string[] = [];
    let code: number | null | undefined;
    for await (const item of streamProcess(process.execPath, ['agent.cjs'], directory, new AbortController().signal)) {
      if ('text' in item) seen.push(item.text);
      else code = item.code;
    }
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(code).toBe(0);
    expect(seen.join('')).toContain('agent output');
  });
});
