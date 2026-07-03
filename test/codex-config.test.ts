import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexConfigWriter } from '../src/config/codex-config';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-codex-config-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('CodexConfigWriter', () => {
  it('adds a proxy profile while preserving user config', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, 'model = "gpt-5.5"\n\n[profiles.native]\nmodel = "gpt-5.5"\n', 'utf8');

    const result = await new CodexConfigWriter().ensureProxyProfile({
      configPath,
      profile: 'codeproxy',
      port: 8082,
      model: 'gpt-5.5'
    });

    const next = await fs.readFile(configPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[profiles.native]');
    expect(next).toContain('[model_providers.codeproxy]');
    expect(next).toContain('base_url = "http://127.0.0.1:8082/v1"');
    expect(next).toContain('[profiles.codeproxy]');
  });

  it('replaces existing codeproxy tables instead of duplicating them', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, '[model_providers.codeproxy]\nbase_url = "old"\n\n[profiles.codeproxy]\nmodel = "old"\n', 'utf8');

    await new CodexConfigWriter().ensureProxyProfile({
      configPath,
      profile: 'codeproxy',
      port: 9090,
      model: 'gpt-5.5'
    });

    const next = await fs.readFile(configPath, 'utf8');
    expect(next).not.toContain('base_url = "old"');
    expect(next.match(/\[model_providers\.codeproxy\]/g)).toHaveLength(1);
    expect(next.match(/\[profiles\.codeproxy\]/g)).toHaveLength(1);
    expect(next).toContain('base_url = "http://127.0.0.1:9090/v1"');
  });

  it('does not rewrite when already current', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    const writer = new CodexConfigWriter();
    const input = { configPath, profile: 'codeproxy', port: 8082, model: 'gpt-5.5' };

    await writer.ensureProxyProfile(input);
    const result = await writer.ensureProxyProfile(input);

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });
});

