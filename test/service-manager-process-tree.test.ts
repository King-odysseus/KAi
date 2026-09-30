import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceManager } from '../packages/integrations/src/service-manager';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('stopping a service', () => {
  let directory = '';
  afterEach(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  });

  it.runIf(process.platform === 'win32')('also ends the processes that service started', { timeout: 60_000 }, async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-service-tree-'));
    const script = path.join(directory, 'service.cjs');
    const pidFile = path.join(directory, 'grandchild.pid');
    await fs.writeFile(script, [
      "const http = require('http');",
      "const { spawn } = require('child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "http.createServer((request, response) => response.end('ok')).listen(Number(process.env.SERVICE_PORT), '127.0.0.1');",
    ].join('\n'));
    const port = await freePort();
    const manager = new ServiceManager();
    await manager.start({
      kind: 'cognitive1',
      label: 'Test service',
      version: '0',
      commit: '0',
      endpoint: `http://127.0.0.1:${port}`,
      healthPath: '/',
      executable: process.execPath,
      args: [script],
      cwd: directory,
      env: { ...process.env, SERVICE_PORT: String(port) },
    });
    const grandchildPid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(alive(grandchildPid)).toBe(true);

    await manager.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(grandchildPid)).toBe(false);
  });
});
