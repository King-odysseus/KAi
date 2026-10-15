import { describe, expect, it } from 'vitest';
import {
  CLI_EFFORT_LEVELS,
  CLI_MODEL_SUGGESTIONS,
  agentRunRequestSchema,
  effortFitsAgent,
  modelBelongsToOtherAgent,
} from '../packages/contracts/src';
import { buildAgentArgs } from '../apps/desktop/src/main/agent-runtime';
import { responseStyleBriefing } from '../apps/desktop/src/main/working-method';
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, clampScale } from '../apps/desktop/src/renderer/src/appearance';

describe('models and thinking effort per agent', () => {
  it('offers the lighter Claude and Codex models, not just the strongest', () => {
    expect(CLI_MODEL_SUGGESTIONS.claude).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
    expect(CLI_MODEL_SUGGESTIONS.codex).toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']));
  });

  it('recognises a model that belongs to a different agent, and leaves typed ones alone', () => {
    // The failure that started this: a Codex model left over on a Claude run.
    expect(modelBelongsToOtherAgent('claude', 'gpt-6-astra')).toBe(true);
    expect(modelBelongsToOtherAgent('codex', 'sonnet')).toBe(true);
    expect(modelBelongsToOtherAgent('claude', 'sonnet')).toBe(false);
    expect(modelBelongsToOtherAgent('claude', 'claude-sonnet-9-custom')).toBe(false);
    expect(modelBelongsToOtherAgent('claude', '')).toBe(false);
  });

  it('lists effort levels only for the agents whose CLI takes one', () => {
    expect(CLI_EFFORT_LEVELS.claude.length).toBeGreaterThan(0);
    expect(CLI_EFFORT_LEVELS.codex.length).toBeGreaterThan(0);
    expect(CLI_EFFORT_LEVELS.qwen).toEqual([]);
    expect(effortFitsAgent('claude', 'max')).toBe(true);
    expect(effortFitsAgent('codex', 'max')).toBe(false);
    expect(effortFitsAgent('gemini', 'low')).toBe(false);
  });

  it('passes effort to Claude as a flag and to Codex as a config override', () => {
    const base = { prompt: 'hi', autonomy: 'ask' as const };
    expect(buildAgentArgs({ ...base, agent: 'claude', reasoning: 'low' }, 'C:/repo', undefined, undefined, 'haiku')).toEqual(
      expect.arrayContaining(['--model', 'haiku', '--effort', 'low']),
    );
    const codex = buildAgentArgs({ ...base, agent: 'codex', reasoning: 'high' }, 'C:/repo', undefined, undefined, 'gpt-6-luna');
    expect(codex).toEqual(expect.arrayContaining(['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="high"']));
    // Codex stops reading its own options at the trailing "-", so the override must come before it.
    expect(codex.indexOf('model_reasoning_effort="high"')).toBeLessThan(codex.lastIndexOf('-'));
  });

  it('never passes an effort the agent does not accept', () => {
    const base = { prompt: 'hi', autonomy: 'ask' as const };
    expect(buildAgentArgs({ ...base, agent: 'claude' }, 'C:/repo')).not.toContain('--effort');
    expect(buildAgentArgs({ ...base, agent: 'codex', reasoning: 'max' }, 'C:/repo').join(' ')).not.toContain('model_reasoning_effort');
    expect(buildAgentArgs({ ...base, agent: 'qwen', reasoning: 'low' }, 'C:/repo')).not.toContain('--effort');
  });

  it('accepts effort and reply style on a run request', () => {
    const parsed = agentRunRequestSchema.parse({
      conversationId: 'c1',
      prompt: 'do it',
      agent: 'claude',
      route: 'direct',
      autonomy: 'ask',
      reasoning: 'low',
      responseStyle: 'plain',
    });
    expect(parsed.reasoning).toBe('low');
    expect(parsed.responseStyle).toBe('plain');
    expect(() => agentRunRequestSchema.parse({ conversationId: 'c1', prompt: 'x', agent: 'claude', route: 'direct', autonomy: 'ask', reasoning: 'extreme' })).toThrow();
  });
});

describe('reply style', () => {
  it('defaults to plain words and says it applies to wording only', () => {
    const text = responseStyleBriefing();
    expect(text).toMatch(/not an engineer/);
    expect(text).toMatch(/wording only/);
  });

  it('has a different instruction for each style', () => {
    const all = (['plain', 'concise', 'detailed', 'technical'] as const).map((style) => responseStyleBriefing(style));
    expect(new Set(all).size).toBe(4);
  });
});

describe('text size', () => {
  it('snaps to steps and stays inside the allowed range', () => {
    expect(clampScale(100)).toBe(100);
    expect(clampScale(102)).toBe(100);
    expect(clampScale(5)).toBe(TEXT_SCALE_MIN);
    expect(clampScale(900)).toBe(TEXT_SCALE_MAX);
    expect(clampScale(Number.NaN)).toBe(100);
  });
});
