import { describe, expect, it } from 'vitest';
import { appSettingsV1Schema, createDefaultSettings, type ConversationRecord, type UsageBudget } from '../packages/contracts/src';
import {
  blockingReason,
  estimateCostUsd,
  evaluateLimits,
  collectPaidRuns,
  priceForModel,
  summarizeUsage,
} from '../apps/desktop/src/main/usage-budget';

const NOW = new Date(2026, 8, 23, 15, 0, 0);

function budget(overrides: Partial<UsageBudget> = {}): UsageBudget {
  return { mode: 'warn', perRunUsd: 5, perConversationUsd: 0, dailyUsd: 0, monthlyUsd: 0, providerDailyUsd: {}, ...overrides };
}

function costEvent(
  at: Date,
  fields: { provider?: string; model?: string; amountUsd?: number; inputTokens?: number; outputTokens?: number },
): ConversationRecord['events'][number] {
  return {
    schemaVersion: 1,
    id: `evt_${at.getTime()}_${Math.random()}`,
    taskId: 'c1',
    timestamp: at.toISOString(),
    type: 'cost.update',
    ...fields,
  } as ConversationRecord['events'][number];
}

function conversation(id: string, events: ConversationRecord['events']): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    projectId: null,
    title: `Conversation ${id}`,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archived: false,
    unread: false,
    activeAgent: 'codex',
    route: 'direct',
    autonomy: 'ask',
    turns: [],
    events,
  };
}

const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

describe('usage pricing', () => {
  it('prices known, prefixed, OpenRouter and family models and rejects unknown ones', () => {
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(1.37);
    expect(estimateCostUsd('openai/gpt-6-astra', 1_000_000, 0)).toBe(10);
    expect(estimateCostUsd('claude-haiku-4-5-20251001-extra', 1_000_000, 0)).toBe(1);
    expect(priceForModel('gpt-6-sol')).toEqual({ input: 10, output: 50 });
    expect(estimateCostUsd('some-local-model', 1000, 1000)).toBeNull();
    expect(priceForModel('')).toBeNull();
  });
});

describe('usage aggregation', () => {
  it('counts only paid API events and never subscription CLI cost events', () => {
    const runs = collectPaidRuns([
      conversation('a', [
        costEvent(hoursAgo(1), { amountUsd: 9, inputTokens: 1, outputTokens: 1 }),
        costEvent(hoursAgo(1), { provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 0 }),
      ]),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.usd).toBeCloseTo(0.27);
  });

  it('prefers a measured amount and flags unpriced runs without adding cost', () => {
    const summary = summarizeUsage(
      [
        conversation('a', [
          costEvent(hoursAgo(1), { provider: 'openai', model: 'gpt-6-astra', amountUsd: 0.5 }),
          costEvent(hoursAgo(1), { provider: 'custom', model: 'mystery', inputTokens: 500, outputTokens: 500 }),
        ]),
      ],
      budget(),
      NOW,
    );
    expect(summary.todayUsd).toBeCloseTo(0.5);
    expect(summary.unpricedRuns).toBe(1);
    expect(summary.estimate).toBe(true);
    expect(summary.byProvider.map((entry) => entry.provider).sort()).toEqual(['custom', 'openai']);
    expect(summary.byModel[0]?.model).toBe('gpt-6-astra');
    expect(summary.byDay).toHaveLength(30);
    expect(summary.byDay.at(-1)?.usd).toBeCloseTo(0.5);
  });

  it('resets the daily total at local midnight and the monthly total at the month boundary', () => {
    const yesterday = new Date(2026, 8, 22, 23, 0, 0);
    const lastMonth = new Date(2026, 7, 31, 12, 0, 0);
    const summary = summarizeUsage(
      [
        conversation('a', [
          costEvent(new Date(2026, 8, 23, 0, 5, 0), { provider: 'openai', model: 'gpt-6-astra', amountUsd: 1 }),
          costEvent(yesterday, { provider: 'openai', model: 'gpt-6-astra', amountUsd: 2 }),
          costEvent(lastMonth, { provider: 'openai', model: 'gpt-6-astra', amountUsd: 4 }),
        ]),
      ],
      budget(),
      NOW,
    );
    expect(summary.todayUsd).toBe(1);
    expect(summary.monthUsd).toBe(3);
  });
});

describe('usage limits', () => {
  const conversations = [
    conversation('a', [costEvent(hoursAgo(1), { provider: 'openai', model: 'gpt-6-astra', amountUsd: 0.85 })]),
    conversation('b', [costEvent(hoursAgo(2), { provider: 'deepseek', model: 'deepseek-chat', amountUsd: 0.1 })]),
  ];

  it('reports ok, warning at 80%, and exceeded at 100% for each scope', () => {
    const runs = collectPaidRuns(conversations);
    const limits = evaluateLimits(
      runs,
      budget({ dailyUsd: 2, monthlyUsd: 0.95, perConversationUsd: 0.85, providerDailyUsd: { openai: 1 } }),
      NOW,
      'a',
    );
    const level = (scope: string) => limits.find((limit) => limit.scope === scope)?.level;
    expect(level('daily')).toBe('ok');
    expect(level('monthly')).toBe('exceeded');
    expect(level('conversation')).toBe('exceeded');
    expect(limits.find((limit) => limit.scope === 'provider')?.level).toBe('warning');
  });

  it('skips scopes whose limit is 0 and ignores the conversation scope without a conversation id', () => {
    const runs = collectPaidRuns(conversations);
    expect(evaluateLimits(runs, budget(), NOW, 'a')).toEqual([]);
    expect(evaluateLimits(runs, budget({ perConversationUsd: 1 }), NOW)).toEqual([]);
  });

  it('blocks only in block mode, and only at the limit', () => {
    const runs = collectPaidRuns(conversations);
    const exceeded = evaluateLimits(runs, budget({ dailyUsd: 0.5 }), NOW);
    expect(blockingReason(exceeded, budget({ mode: 'warn', dailyUsd: 0.5 }))).toBeNull();
    expect(blockingReason(exceeded, budget({ mode: 'block', dailyUsd: 0.5 }))).toMatch(/daily budget of \$0\.50/);

    const warning = evaluateLimits(runs, budget({ dailyUsd: 1.1 }), NOW);
    expect(warning[0]?.level).toBe('warning');
    expect(blockingReason(warning, budget({ mode: 'block', dailyUsd: 1.1 }))).toBeNull();
  });

  it('marks the summary blocked with a reason so the run handler can refuse before any request', () => {
    const blocked = summarizeUsage(conversations, budget({ mode: 'block', perConversationUsd: 0.5 }), NOW, 'a');
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedReason).toMatch(/conversation budget/);
    const other = summarizeUsage(conversations, budget({ mode: 'block', perConversationUsd: 0.5 }), NOW, 'b');
    expect(other.blocked).toBe(false);
  });
});

describe('usage budget settings contract', () => {
  it('fills budget defaults so settings saved before this feature still load', () => {
    const defaults = createDefaultSettings();
    expect(defaults.usageBudget).toEqual({ mode: 'warn', perRunUsd: 5, perConversationUsd: 0, dailyUsd: 0, monthlyUsd: 0, providerDailyUsd: {} });
    const { usageBudget: _omitted, ...legacy } = defaults;
    expect(appSettingsV1Schema.parse(legacy).usageBudget.mode).toBe('warn');
  });

  it('rejects negative limits and unknown fields', () => {
    const defaults = createDefaultSettings();
    expect(() => appSettingsV1Schema.parse({ ...defaults, usageBudget: { ...defaults.usageBudget, dailyUsd: -1 } })).toThrow();
    expect(() => appSettingsV1Schema.parse({ ...defaults, usageBudget: { ...defaults.usageBudget, extra: true } })).toThrow();
  });
});
