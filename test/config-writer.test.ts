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

  // Another tool sharing the file can strip our closing marker and leave the
  // opening one dangling. A `start[\s\S]*?end` match anchors on the earliest
  // start, so it would span from the orphan to the next real end marker and
  // delete every unrelated line in between.
  it('does not span a dangling start marker to a later block', () => {
    const writer = new ConfigWriter();
    const existing = [
      'model = "native"',
      '',
      '# >>> KAI codex-codeproxy',
      '[model_providers.codeproxy]',
      'base_url = "http://127.0.0.1:8082"',
      '',
      '[profiles.native]',
      'model = "gpt-5.5"',
      '',
      '# >>> KAI codex-codeproxy',
      '[model_providers.kai]',
      'base_url = "http://old"',
      '# <<< KAI codex-codeproxy',
      '',
    ].join('\n');

    const next = writer.upsertBlock(existing, {
      id: 'codex-codeproxy',
      content: '[model_providers.kai]\nbase_url = "http://new"',
    });

    // Everything between the orphan and the real block has to survive.
    expect(next).toContain('[profiles.native]');
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('model = "native"');
    // One block in, one block out — no duplicated markers.
    expect(next.match(/# >>> KAI codex-codeproxy/g)).toHaveLength(1);
    expect(next.match(/# <<< KAI codex-codeproxy/g)).toHaveLength(1);
    expect(next).toContain('http://new');
    expect(next).not.toContain('http://old');
  });

  it('clears a dangling start marker in the same write that appends', () => {
    const writer = new ConfigWriter();
    const existing = '# >>> KAI mcp\nurl = "old"\n\n[other]\nkey = 1\n';

    const next = writer.upsertBlock(existing, { id: 'mcp', content: 'url = "new"' });

    expect(next.match(/# >>> KAI mcp/g)).toHaveLength(1);
    expect(next).toContain('url = "new"');
    // The orphan's stray body and any later table stay put.
    expect(next).toContain('[other]');
    expect(next).toContain('key = 1');
  });
});

