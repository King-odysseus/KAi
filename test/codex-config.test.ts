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
      model: 'gpt-5.5',
      authToken: 'kai-test-token'
    });

    const next = await fs.readFile(configPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(next).toContain('model = "gpt-5.5"');
    expect(next).toContain('[profiles.native]');
    expect(next).toContain('[model_providers.codeproxy]');
    expect(next).toContain('base_url = "http://127.0.0.1:8082/a/codex/v1"');
    expect(next).toContain('http_headers = { Authorization = "Bearer kai-test-token" }');
    // Codex 0.153+ rejects `--profile` while a [profiles.<name>] table exists,
    // and the top-level model_provider key already selects the proxy. Writing
    // one would make `codex exec --profile codeproxy` a config-load error.
    expect(next).not.toContain('[profiles.codeproxy]');
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
    // A legacy [profiles.codeproxy] table is stripped, not re-emitted.
    expect(next).not.toContain('[profiles.codeproxy]');
    expect(next).toContain('base_url = "http://127.0.0.1:9090/a/codex/v1"');
  });

  it('collapses duplicate top-level routing keys and preserves custom config', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, [
      '# >>> KAI top-level',
      'model_provider = "codeproxy"',
      'model = "gpt-5.5"',
      'preferred_auth_method = "apikey"',
      '# <<< KAI top-level',
      '',
      'model_provider = "codeproxy"',
      'model = "gpt-5.5"',
      'preferred_auth_method = "apikey"',
      '',
      'service_tier = "default"',
      '',
      '[mcp_servers.cognitive1]',
      'url = "http://127.0.0.1:9876/mcp"',
      '',
    ].join('\n'), 'utf8');

    await new CodexConfigWriter().ensureProxyProfile({
      configPath,
      profile: 'codeproxy',
      port: 8083,
      model: 'gpt-5.5'
    });

    const next = await fs.readFile(configPath, 'utf8');
    const preamble = next.split(/\r?\n(?=\[)/)[0];
    expect(preamble.match(/^model_provider\s*=/gm)).toHaveLength(1);
    expect(preamble.match(/^model\s*=/gm)).toHaveLength(1);
    expect(preamble.match(/^preferred_auth_method\s*=/gm)).toHaveLength(1);
    expect(next).toContain('service_tier = "default"');
    expect(next.match(/\[mcp_servers\.cognitive1\]/g)).toHaveLength(1);
  });

  it('preserves the original routing values when routing again', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    const writer = new CodexConfigWriter();
    const input = { configPath, profile: 'codeproxy', port: 8083, model: 'gpt-5.5' };
    await fs.writeFile(configPath, [
      'model_provider = "openai"',
      'model = "gpt-5.4"',
      'service_tier = "default"',
      '',
      '[profiles.native]',
      'model = "gpt-5.4"',
      '',
    ].join('\n'), 'utf8');

    await writer.ensureProxyProfile(input);
    await writer.ensureProxyProfile(input);

    const next = await fs.readFile(configPath, 'utf8');
    expect(next.match(/\[proxy\.backup\]/g)).toHaveLength(1);
    expect(next).toContain('model_provider = "openai"');
    expect(next).toContain('model = "gpt-5.4"');
    expect(next).toContain('[profiles.native]');
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

  // Another tool sharing the file can strip our closing marker. The strip used
  // to run until it saw the partner, so an unterminated marker deleted every
  // line from there to EOF — including tables KAI never wrote.
  it('does not delete the tail when a start marker has no partner', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, [
      'model = "gpt-5.5"',
      '',
      '# >>> KAI codex-codeproxy',
      '[model_providers.codeproxy]',
      'base_url = "http://127.0.0.1:8082"',
      '',
      '[mcp_servers.important]',
      'command = "keep-me"',
      '',
    ].join('\n'), 'utf8');

    await new CodexConfigWriter().restoreConfig(configPath, 'codeproxy');
    const next = await fs.readFile(configPath, 'utf8');

    // The unrelated table below the dangling marker must survive.
    expect(next).toContain('[mcp_servers.important]');
    expect(next).toContain('keep-me');
    // The dangling marker and the codeproxy table itself are still cleaned up.
    expect(next).not.toContain('# >>> KAI codex-codeproxy');
    expect(next).not.toContain('[model_providers.codeproxy]');
  });

  it('removes only stale cognitive1 MCP tables for embedded mode', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.cognitive1]',
      'url = "http://127.0.0.1:9876/mcp"',
      'startup_timeout_sec = 20.0',
      '',
      '[mcp_servers.cognitive1.tools.remember]',
      'enabled = true',
      '',
      '[mcp_servers.important]',
      'command = "keep-me"',
      '',
      '[mcp_servers.important.env]',
      'TOKEN = "keep-me-too"',
      '',
      '[mcp_servers.penpot]',
      'url = "http://127.0.0.1:3333/mcp"',
      '',
    ].join('\n'), 'utf8');

    const result = await new CodexConfigWriter().reconcileCognitive1Mcp({
      configPath,
      removeCognitive1HttpServer: true,
    });
    const next = await fs.readFile(configPath, 'utf8');

    expect(result.changed).toBe(true);
    expect(next).not.toContain('[mcp_servers.cognitive1]');
    expect(next).not.toContain('[mcp_servers.cognitive1.tools.remember]');
    expect(next).not.toContain('http://127.0.0.1:9876/mcp');
    expect(next).toContain('[mcp_servers.important]');
    expect(next).toContain('command = "keep-me"');
    expect(next).toContain('[mcp_servers.important.env]');
    expect(next).toContain('TOKEN = "keep-me-too"');
    expect(next).toContain('[mcp_servers.penpot]');
    expect(next).toContain('url = "http://127.0.0.1:3333/mcp"');
  });

  it('leaves cognitive1 MCP tables intact when reconciliation is disabled', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    const original = '[mcp_servers.cognitive1]\nurl = "http://127.0.0.1:9876/mcp"\n';
    await fs.writeFile(configPath, original, 'utf8');

    const result = await new CodexConfigWriter().reconcileCognitive1Mcp({ configPath });

    expect(result.changed).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  });

  it('rewrites a legacy profiles table so Codex 0.153+ can load the config', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(configPath, [
      'model_provider = "codeproxy"',
      'model = "gpt-5.5"',
      'preferred_auth_method = "apikey"',
      '',
      '[model_providers.codeproxy]',
      'base_url = "http://127.0.0.1:8082/a/codex/v1"',
      '',
      '[profiles.codeproxy]',
      'model = "gpt-5.5"',
      'model_provider = "codeproxy"',
      '',
    ].join('\n'), 'utf8');

    await new CodexConfigWriter().ensureProxyProfile({
      configPath,
      profile: 'codeproxy',
      port: 8082,
      model: 'gpt-5.5',
    });

    const next = await fs.readFile(configPath, 'utf8');
    expect(next).not.toContain('[profiles.codeproxy]');
    expect(next).toContain('base_url = "http://127.0.0.1:8082/a/codex/v1"');
  });
});
