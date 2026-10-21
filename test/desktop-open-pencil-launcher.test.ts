import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOpenPencilRunning, readOpenPencilDiscovery } from '../apps/desktop/src/main/open-pencil-launcher';

vi.setConfig({ testTimeout: 30_000 });

const alive = async (): Promise<boolean> => true;

describe('open-pencil launcher', () => {
  let localAppData: string;

  beforeEach(async () => {
    localAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-openpencil-'));
  });

  afterEach(async () => {
    await fs.rm(localAppData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reads the modded build\'s discovery file first, over the baseline', async () => {
    await writeDiscovery(localAppData, 'OpenPencilMod', 7600, 'mod-token');
    await writeDiscovery(localAppData, 'OpenPencil', 7700, 'baseline-token');

    const found = await readOpenPencilDiscovery(localAppData, alive);

    expect(found).toEqual({ endpoint: 'http://127.0.0.1:7600/mcp', token: 'mod-token' });
  });

  it('falls back to the baseline build when the mod is not installed', async () => {
    await writeDiscovery(localAppData, 'OpenPencil', 7700, 'baseline-token');

    const found = await readOpenPencilDiscovery(localAppData, alive);

    expect(found).toEqual({ endpoint: 'http://127.0.0.1:7700/mcp', token: 'baseline-token' });
  });

  it('reports nothing running rather than throwing, when no discovery file exists', async () => {
    expect(await readOpenPencilDiscovery(localAppData, alive)).toBeNull();
  });

  it('ignores a discovery file that is missing the fields a connection needs', async () => {
    await fs.mkdir(path.join(localAppData, 'OpenPencilMod'), { recursive: true });
    await fs.writeFile(path.join(localAppData, 'OpenPencilMod', 'mcp.json'), JSON.stringify({ pid: 1 }));

    expect(await readOpenPencilDiscovery(localAppData, alive)).toBeNull();
  });

  it('reads a null token as a real connection when the editor is running with auth off, not as missing', async () => {
    const dir = path.join(localAppData, 'OpenPencilMod');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ pid: 1, httpPort: 7600, authRequired: false, authToken: null, version: '0.15.0' }));

    expect(await readOpenPencilDiscovery(localAppData, alive)).toEqual({ endpoint: 'http://127.0.0.1:7600/mcp', token: null });
  });

  it('refuses a file that claims auth is required but holds no usable token', async () => {
    const dir = path.join(localAppData, 'OpenPencilMod');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ pid: 1, httpPort: 7600, authRequired: true, authToken: null, version: '0.15.0' }));

    expect(await readOpenPencilDiscovery(localAppData, alive)).toBeNull();
  });

  it('returns the live connection straight away when the editor is already running', async () => {
    await writeDiscovery(localAppData, 'OpenPencilMod', 7600, 'mod-token');

    const connection = await ensureOpenPencilRunning({ localAppData, timeoutMs: 1_000, pollMs: 50, isLive: alive });

    expect(connection).toEqual({ endpoint: 'http://127.0.0.1:7600/mcp', token: 'mod-token' });
  });

  it('skips a discovery file left behind by an editor that is no longer running', async () => {
    await writeDiscovery(localAppData, 'OpenPencil', 7600, 'stale-token');
    await writeDiscovery(localAppData, 'OpenPencilMod', 7601, 'live-token');

    const found = await readOpenPencilDiscovery(localAppData, async (port) => port === 7601);

    expect(found).toEqual({ endpoint: 'http://127.0.0.1:7601/mcp', token: 'live-token' });
    expect(await readOpenPencilDiscovery(localAppData, async () => false)).toBeNull();
  });

  it('launches the editor instead of trusting a stale discovery file', async () => {
    await writeDiscovery(localAppData, 'OpenPencil', 7600, 'stale-token');

    await expect(ensureOpenPencilRunning({ localAppData, timeoutMs: 500, pollMs: 50, isLive: async () => false }))
      .rejects.toThrow('open-pencil is not installed');
  });

  it('says plainly that it cannot find open-pencil to launch, rather than hanging on a timeout', async () => {
    // No discovery file and no executable at either candidate path.
    await expect(ensureOpenPencilRunning({ localAppData, timeoutMs: 500, pollMs: 50 }))
      .rejects.toThrow('open-pencil is not installed');
  });
});

async function writeDiscovery(localAppData: string, folder: string, httpPort: number, authToken: string): Promise<void> {
  const dir = path.join(localAppData, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ pid: 1, httpPort, authRequired: true, authToken, version: '0.15.0' }));
}
