import type {
  ConversationRecord,
  UsageBudget,
  UsageLimitStatus,
  UsageSummary,
} from '@kai/contracts';

/** USD per million tokens. Mirrors the Universal Agent Proxy catalogue and DeepSeek's published rates. */
interface ModelPrice {
  input: number;
  output: number;
}

const EXACT_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-5.6-cyber': { input: 12.5, output: 75 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  // DeepSeek peak (cache-miss) rates, so spend is never understated.
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-flash': { input: 0.3, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
};

const FAMILY_PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ['claude-opus', { input: 5, output: 25 }],
  ['claude-fable', { input: 10, output: 50 }],
  ['claude-sonnet', { input: 2, output: 10 }],
  ['claude-haiku', { input: 1, output: 5 }],
  ['claude-', { input: 5, output: 25 }],
  ['gpt-6', { input: 10, output: 50 }],
  ['gpt-', { input: 4, output: 20 }],
];

/** Look up a price, tolerating OpenRouter `vendor/model` ids and dated snapshots. Unknown models return null. */
export function priceForModel(model: string): ModelPrice | null {
  let id = model.trim().toLowerCase();
  if (!id) return null;
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  const exact = EXACT_PRICES[id];
  if (exact) return exact;
  const extended = Object.entries(EXACT_PRICES).find(([known]) => id.startsWith(known));
  if (extended) return extended[1];
  return FAMILY_PRICES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}

/** USD for a run, or null when the model has no known price. */
export function estimateCostUsd(model: string, inputTokens = 0, outputTokens = 0): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export const WARNING_RATIO = 0.8;

export function limitLevel(ratio: number): UsageLimitStatus['level'] {
  if (ratio >= 1) return 'exceeded';
  return ratio >= WARNING_RATIO ? 'warning' : 'ok';
}

interface PaidRun {
  conversationId: string;
  title: string;
  provider: string;
  model: string;
  timestamp: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  priced: boolean;
}

/** Only events that carry a provider are paid API runs; subscription CLI usage is never counted. */
export function collectPaidRuns(conversations: readonly ConversationRecord[]): PaidRun[] {
  const runs: PaidRun[] = [];
  for (const conversation of conversations) {
    for (const event of conversation.events) {
      if (event.type !== 'cost.update' || !event.provider) continue;
      const timestamp = Date.parse(event.timestamp);
      if (Number.isNaN(timestamp)) continue;
      const model = event.model ?? 'unknown';
      const inputTokens = event.inputTokens ?? 0;
      const outputTokens = event.outputTokens ?? 0;
      const usd = event.amountUsd ?? estimateCostUsd(model, inputTokens, outputTokens);
      runs.push({
        conversationId: conversation.id,
        title: conversation.title,
        provider: event.provider,
        model,
        timestamp,
        usd: usd ?? 0,
        inputTokens,
        outputTokens,
        priced: usd !== null,
      });
    }
  }
  return runs;
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfLocalMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

const sum = (runs: readonly PaidRun[]): number => runs.reduce((total, run) => total + run.usd, 0);

function status(
  scope: UsageLimitStatus['scope'],
  limitUsd: number,
  spentUsd: number,
  provider?: string,
): UsageLimitStatus {
  const ratio = spentUsd / limitUsd;
  return { scope, ...(provider ? { provider } : {}), limitUsd, spentUsd, ratio, level: limitLevel(ratio) };
}

export function evaluateLimits(
  runs: readonly PaidRun[],
  budget: UsageBudget,
  now: Date,
  conversationId?: string,
): UsageLimitStatus[] {
  const dayStart = startOfLocalDay(now);
  const monthStart = startOfLocalMonth(now);
  const today = runs.filter((run) => run.timestamp >= dayStart);
  const limits: UsageLimitStatus[] = [];
  if (budget.perConversationUsd > 0 && conversationId) {
    limits.push(status('conversation', budget.perConversationUsd, sum(runs.filter((run) => run.conversationId === conversationId))));
  }
  if (budget.dailyUsd > 0) limits.push(status('daily', budget.dailyUsd, sum(today)));
  if (budget.monthlyUsd > 0) {
    limits.push(status('monthly', budget.monthlyUsd, sum(runs.filter((run) => run.timestamp >= monthStart))));
  }
  for (const [provider, limitUsd] of Object.entries(budget.providerDailyUsd)) {
    if (limitUsd > 0) limits.push(status('provider', limitUsd, sum(today.filter((run) => run.provider === provider)), provider));
  }
  return limits;
}

function describeLimit(limit: UsageLimitStatus): string {
  const scope = limit.scope === 'provider' ? `${limit.provider} daily` : limit.scope === 'conversation' ? 'conversation' : limit.scope;
  return `The ${scope} budget of $${limit.limitUsd.toFixed(2)} is used up ($${limit.spentUsd.toFixed(2)} spent, estimated).`;
}

/** Reason to refuse the next paid request, or null. Only block mode ever refuses. */
export function blockingReason(limits: readonly UsageLimitStatus[], budget: UsageBudget): string | null {
  if (budget.mode !== 'block') return null;
  const exceeded = limits.find((limit) => limit.level === 'exceeded');
  return exceeded ? describeLimit(exceeded) : null;
}

const DAYS_SHOWN = 30;

export function summarizeUsage(
  conversations: readonly ConversationRecord[],
  budget: UsageBudget,
  now: Date,
  conversationId?: string,
): UsageSummary {
  const runs = collectPaidRuns(conversations);
  const dayStart = startOfLocalDay(now);
  const monthStart = startOfLocalMonth(now);

  const byDay = new Map<string, number>();
  for (let offset = DAYS_SHOWN - 1; offset >= 0; offset -= 1) {
    byDay.set(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime()), 0);
  }
  for (const run of runs) {
    const key = localDayKey(run.timestamp);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + run.usd);
  }

  const totals = <T extends string>(keyOf: (run: PaidRun) => T) => {
    const map = new Map<T, { usd: number; inputTokens: number; outputTokens: number; runs: number; sample: PaidRun }>();
    for (const run of runs) {
      const key = keyOf(run);
      const entry = map.get(key) ?? { usd: 0, inputTokens: 0, outputTokens: 0, runs: 0, sample: run };
      entry.usd += run.usd;
      entry.inputTokens += run.inputTokens;
      entry.outputTokens += run.outputTokens;
      entry.runs += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((left, right) => right.usd - left.usd);
  };

  const perConversation = new Map<string, { title: string; usd: number }>();
  for (const run of runs) {
    const entry = perConversation.get(run.conversationId) ?? { title: run.title, usd: 0 };
    entry.usd += run.usd;
    perConversation.set(run.conversationId, entry);
  }

  const limits = evaluateLimits(runs, budget, now, conversationId);
  const reason = blockingReason(limits, budget);
  return {
    generatedAt: now.toISOString(),
    currency: 'USD',
    estimate: true,
    todayUsd: sum(runs.filter((run) => run.timestamp >= dayStart)),
    monthUsd: sum(runs.filter((run) => run.timestamp >= monthStart)),
    conversationUsd: conversationId ? sum(runs.filter((run) => run.conversationId === conversationId)) : null,
    unpricedRuns: runs.filter((run) => !run.priced).length,
    byDay: [...byDay].map(([day, usd]) => ({ day, usd })),
    byProvider: totals((run) => run.provider).map(({ sample, ...rest }) => ({ provider: sample.provider, ...rest })),
    byModel: totals((run) => `${run.provider}\u0000${run.model}`).map(({ sample, ...rest }) => ({
      provider: sample.provider,
      model: sample.model,
      ...rest,
    })),
    byConversation: [...perConversation]
      .map(([id, entry]) => ({ conversationId: id, title: entry.title, usd: entry.usd }))
      .sort((left, right) => right.usd - left.usd)
      .slice(0, 10),
    budget,
    limits,
    blocked: reason !== null,
    blockedReason: reason,
  };
}
