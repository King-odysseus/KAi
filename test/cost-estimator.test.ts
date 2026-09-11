import { describe, expect, it } from 'vitest';
import { countTokens, estimateCost, formatCostEstimate, getModelName, getContextWindow } from '../src/core/cost-estimator';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('   ')).toBe(0);
  });

  it('classifies natural language prompts correctly', () => {
    const tokens = countTokens('Explain how the authentication system works');
    // ~3.8 chars/token for natural language
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(20);
  });

  it('classifies code prompts correctly', () => {
    const code = 'function hello() { return "world"; } export default hello;';
    const tokens = countTokens(code);
    // ~3.3 chars/token for code
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  it('uses mixed classification for prompts with some code signals', () => {
    const mixed = 'Please refactor this function to use async/await';
    const tokens = countTokens(mixed);
    expect(tokens).toBeGreaterThan(0);
  });

  it('detects code blocks as code signals', () => {
    const withCodeBlock = 'Here is a fix:\n```\nconst x = 1;\n```';
    const tokens = countTokens(withCodeBlock);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns at least 1 token for any non-empty input', () => {
    expect(countTokens('a')).toBe(1);
  });
});

describe('cost-estimator', () => {
  it('estimates tokens based on prompt length', () => {
    const est = estimateCost('Write a function that sorts an array', 'claude', 'direct');
    expect(est.estimatedInputTokens).toBeGreaterThan(5);
    expect(est.estimatedOutputTokens).toBeGreaterThan(est.estimatedInputTokens);
    expect(est.modelName).toContain('Claude');
  });

  it('proxy routes are cheaper than direct', () => {
    const direct = estimateCost('test prompt here for estimation', 'claude', 'direct');
    const proxy = estimateCost('test prompt here for estimation', 'claude', 'proxy');
    expect(proxy.estimatedCostUsd).toBeLessThan(direct.estimatedCostUsd);
  });

  it('handles very short prompts with minimum tokens', () => {
    const est = estimateCost('hi', 'codex', 'direct');
    expect(est.estimatedInputTokens).toBeGreaterThanOrEqual(100);
  });

  it('proxy routes have higher output multiplier', () => {
    const direct = estimateCost('test', 'claude', 'direct');
    const proxy = estimateCost('test', 'claude', 'proxy');
    expect(proxy.estimatedOutputTokens).toBeGreaterThan(direct.estimatedOutputTokens);
  });

  it('formats cost summary correctly', () => {
    const est = estimateCost('test prompt for formatting', 'codex', 'proxy');
    const summary = formatCostEstimate(est);
    expect(summary).toContain('~');
    expect(summary).toContain('in');
    expect(summary).toContain('out');
  });

  it('getContextWindow returns a positive size for every agent/route combo', () => {
    const agents = ['claude', 'codex', 'qwen', 'gemini'] as const;
    const routes = ['direct', 'proxy'] as const;
    for (const agent of agents) {
      for (const route of routes) {
        expect(getContextWindow(agent, route)).toBeGreaterThan(0);
      }
    }
  });

  it('getModelName matches the model name embedded in a cost estimate', () => {
    const agents = ['claude', 'codex', 'qwen', 'gemini'] as const;
    const routes = ['direct', 'proxy'] as const;
    for (const agent of agents) {
      for (const route of routes) {
        expect(getModelName(agent, route)).toBe(estimateCost('test', agent, route).modelName);
      }
    }
  });

  it('includes model name for each agent/route combo', () => {
    const agents = ['claude', 'codex', 'qwen', 'gemini'] as const;
    const routes = ['direct', 'proxy'] as const;
    for (const agent of agents) {
      for (const route of routes) {
        const est = estimateCost('test', agent, route);
        expect(est.modelName.length).toBeGreaterThan(0);
        expect(est.agent).toBe(agent);
        expect(est.route).toBe(route);
      }
    }
  });
});
