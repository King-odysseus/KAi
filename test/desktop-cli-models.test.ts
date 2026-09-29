import { describe, expect, it } from 'vitest';
import { appSettingsV1Schema, CLI_MODEL_SUGGESTIONS, cliModelNameSchema, createDefaultSettings, themeModeSchema, THEME_MODES } from '../packages/contracts/src';
import { buildAgentArgs } from '../apps/desktop/src/main/agent-runtime';
import { mergeSettingsUpdate } from '../apps/desktop/src/main/service-controller';

const base = { prompt: 'Fix the bug', autonomy: 'ask' as const };

describe('CLI model selection', () => {
  it('offers verified model choices without duplicate menu entries', () => {
    expect(CLI_MODEL_SUGGESTIONS.claude).toEqual(['claude-opus-5']);
    expect(CLI_MODEL_SUGGESTIONS.codex).toEqual(['gpt-6-astra']);
    expect(CLI_MODEL_SUGGESTIONS.qwen).toEqual(expect.arrayContaining(['qwen3.8-max', 'qwen3.8-flash', 'qwen3-coder-plus']));
    expect(CLI_MODEL_SUGGESTIONS.gemini).toEqual(expect.arrayContaining(['gemini-3.8-pro', 'gemini-3.8-flash', 'flash']));

    for (const models of Object.values(CLI_MODEL_SUGGESTIONS)) {
      expect(new Set(models).size).toBe(models.length);
      expect(models.every((model) => cliModelNameSchema.safeParse(model).success)).toBe(true);
    }
  });

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
    const qwen = buildAgentArgs({ ...base, agent: 'qwen' }, 'C:/repo', undefined, undefined, 'qwen3.8-max');
    expect(qwen).toEqual(expect.arrayContaining(['--model', 'qwen3.8-max']));
    // The prompt travels on stdin, so the arguments carry only the short "-p" note.
    expect(qwen.slice(-2)).toEqual(['-p', 'Carry out the request above.']);
    expect(qwen).not.toContain('Fix the bug');
    const gemini = buildAgentArgs({ ...base, agent: 'gemini' }, 'C:/repo', 'resume-1', undefined, 'gemini-3.8-pro');
    expect(gemini).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-pro', '--resume', 'resume-1']));
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
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.agentModels;
    delete legacy.editor;
    const parsed = appSettingsV1Schema.parse(legacy);
    expect(parsed.agentModels).toEqual({});
    expect(parsed.editor).toEqual({ autoSave: true, autoSaveDelayMs: 1_000, formatOnSave: true });
  });

  it('replaces the whole map on update so clearing a field removes that override', () => {
    const settings = { ...createDefaultSettings(), agentModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' } };
    expect(mergeSettingsUpdate(settings, { agentModels: { codex: 'gpt-6-astra' } }).agentModels).toEqual({ codex: 'gpt-6-astra' });
    expect(mergeSettingsUpdate(settings, {}).agentModels).toEqual({ codex: 'gpt-5.5', claude: 'claude-opus-5' });
    expect(mergeSettingsUpdate(settings, { editor: { autoSave: false } }).editor).toEqual({ autoSave: false, autoSaveDelayMs: 1_000, formatOnSave: true });
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
