import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigWriter } from '../src/config/config-writer';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-config-writer-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigWriter', () => {
  it('adds a managed block without removing custom config', async () => {
    const targetPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(targetPath, 'model = "native"\n', 'utf8');

    const writer = new ConfigWriter();
    const result = await writer.mergeBlock(targetPath, {
      id: 'codex-provider',
      content: '[model_providers.kai]\nbase_url = "http://127.0.0.1:3456"'
    });

    const next = await fs.readFile(targetPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(next).toContain('model = "native"');
    expect(next).toContain('# >>> KAI codex-provider');
    expect(next).toContain('base_url = "http://127.0.0.1:3456"');
  });

  it('updates only the managed block on repeat writes', async () => {
    const targetPath = path.join(tempDir, 'settings.conf');
    const writer = new ConfigWriter();

    await writer.mergeBlock(targetPath, { id: 'mcp', content: 'url = "one"' });
    await writer.mergeBlock(targetPath, { id: 'mcp', content: 'url = "two"' });

    const next = await fs.readFile(targetPath, 'utf8');
    expect(next).not.toContain('url = "one"');
    expect(next).toContain('url = "two"');
    expect(next.match(/# >>> KAI mcp/g)).toHaveLength(1);
  });

  it('does not rewrite unchanged content', async () => {
    const targetPath = path.join(tempDir, 'settings.conf');
    const writer = new ConfigWriter();

    await writer.mergeBlock(targetPath, { id: 'mcp', content: 'url = "one"' });
    const result = await writer.mergeBlock(targetPath, { id: 'mcp', content: 'url = "one"' });

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });
});

