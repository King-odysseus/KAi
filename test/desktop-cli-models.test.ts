import { describe, expect, it } from 'vitest';
import { appSettingsV1Schema, cliModelNameSchema, createDefaultSettings, themeModeSchema, THEME_MODES } from '../packages/contracts/src';
import { buildAgentArgs } from '../apps/desktop/src/main/agent-runtime';
import { mergeSettingsUpdate } from '../apps/desktop/src/main/service-controller';

const base = { prompt: 'Fix the bug', autonomy: 'ask' as const };

describe('CLI model selection', () => {
  it('leaves every CLI on its own default when no model is set', () => {
    for (const agent of ['claude', 'codex', 'qwen', 'gemini'] as const) {
      expect(buildAgentArgs({ ...base, agent }, 'C:/repo')).not.toContain('--model');
    }
  });

  it('passes --model to codex, before the stdin marker, for new and resumed sessions', () => {
    const fresh = buildAgentArgs({ ...base, agent: 'codex' }, 'C:/repo', undefined, undefined, 'gpt-6-astra');
    expect(fresh.slice(0, 4)).toEqual(['exec', '--json', '--model', 'gpt-6-astra']);
    expect(fresh.at(-1)).toBe('-');
    const resumed = buildAgentArgs({ ...base, agent: 'codex' }, 'C:/repo', 'sess-1', undefined, 'gpt-6-astra');
    expect(resumed).toEqual(['exec', 'resume', 'sess-1', '--json', '--model', 'gpt-6-astra', '-']);
  });

  it('passes --model to claude, qwen and gemini without disturbing their other arguments', () => {
    expect(buildAgentArgs({ ...base, agent: 'claude' }, 'C:/repo', undefined, undefined, 'claude-sonnet-5')).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'claude-sonnet-5']),
    );
    const qwen = buildAgentArgs({ ...base, agent: 'qwen' }, 'C:/repo', undefined, undefined, 'qwen3-coder-plus');
    expect(qwen).toEqual(expect.arrayContaining(['--model', 'qwen3-coder-plus']));
    expect(qwen.at(-1)).toBe('Fix the bug');
    const gemini = buildAgentArgs({ ...base, agent: 'gemini' }, 'C:/repo', 'resume-1', undefined, 'gemini-2.5-pro');
    expect(gemini).toEqual(expect.arrayContaining(['--model', 'gemini-2.5-pro', '--resume', 'resume-1']));
  });
});

describe('CLI model setting', () => {
  it('accepts real model names and refuses anything that could be read as an option or a shell fragment', () => {
    for (const name of ['gpt-5.5', 'claude-opus-5', 'claude-sonnet-4-5[1m]', 'openai/gpt-6-astra', 'qwen3-coder-plus', 'o3']) {
      expect(cliModelNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ['', '--dangerously-skip-permissions', '-m', 'a b', 'gpt-5.5; rm -rf /', 'x'.repeat(101), '$(whoami)', 'a"b']) {
      expect(cliModelNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('defaults to no overrides, and settings saved before this existed still load', () => {
    const defaults = createDefaultSettings();
    expect(defaults.agentModels).toEqual({});
    const { agentModels: _omitted, ...legacy } = defaults;
    expect(appSettingsV1Schema.parse(legacy).agentModels).toEqual({});
  });

  it('replaces the whole map on update so clearing a field removes that override', () => {
    const settings = { ...createDefaultSettings(), agentModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' } };
    expect(mergeSettingsUpdate(settings, { agentModels: { codex: 'gpt-6-astra' } }).agentModels).toEqual({ codex: 'gpt-6-astra' });
    expect(mergeSettingsUpdate(settings, {}).agentModels).toEqual({ codex: 'gpt-5.5', claude: 'claude-opus-5' });
  });
});

describe('themes', () => {
  it('offers dark, navy, purple and light, and keeps the cycle order stable', () => {
    expect(themeModeSchema.options).toEqual(['dark', 'navy', 'purple', 'light']);
    expect(THEME_MODES.map((theme) => theme.id)).toEqual(['dark', 'navy', 'purple', 'light']);
    for (const theme of themeModeSchema.options) {
      expect(appSettingsV1Schema.parse({ ...createDefaultSettings(), theme }).theme).toBe(theme);
    }
    expect(() => appSettingsV1Schema.parse({ ...createDefaultSettings(), theme: 'neon' })).toThrow();
  });
});
