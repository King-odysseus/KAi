import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateProxyToken } from '../src/config/proxy-token';

describe('loadOrCreateProxyToken', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-proxy-token-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const tokenPath = () => path.join(dir, 'proxy-token');

  it('creates a token on first use and persists it', async () => {
    const token = await loadOrCreateProxyToken(dir);

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect((await fs.readFile(tokenPath(), 'utf8')).trim()).toBe(token);
  });

  it('returns the same token on the next activation', async () => {
    const first = await loadOrCreateProxyToken(dir);
    const second = await loadOrCreateProxyToken(dir);

    // The whole point of persisting: a fresh window must not invalidate the
    // token already sitting in ~/.claude/settings.json.
    expect(second).toBe(first);
  });

  it('creates the storage directory if it does not exist yet', async () => {
    const nested = path.join(dir, 'globalStorage', 'kai');

    const token = await loadOrCreateProxyToken(nested);

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect((await fs.readFile(path.join(nested, 'proxy-token'), 'utf8')).trim()).toBe(token);
  });

  it('replaces a blank token file rather than returning an empty token', async () => {
    await fs.writeFile(tokenPath(), '   \n', 'utf8');

    const token = await loadOrCreateProxyToken(dir);

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect((await fs.readFile(tokenPath(), 'utf8')).trim()).toBe(token);
  });

  it('tolerates a trailing newline and surrounding whitespace', async () => {
    await fs.writeFile(tokenPath(), '  abc123def456  \n', 'utf8');

    expect(await loadOrCreateProxyToken(dir)).toBe('abc123def456');
  });

  it('surfaces a real read error instead of silently rotating the token', async () => {
    // A directory where the token file is expected: reading it is EISDIR, not
    // ENOENT. Rotating on an unexpected error would silently break every agent
    // already pointed at the old token, so it must propagate.
    await fs.mkdir(tokenPath());

    await expect(loadOrCreateProxyToken(dir)).rejects.toThrow();
  });
});
