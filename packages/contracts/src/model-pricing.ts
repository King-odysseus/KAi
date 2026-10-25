/** Published USD per million tokens used for clearly labelled rough estimates. Unknown models stay unpriced. */
export interface ModelPrice { input: number; output: number }

const EXACT: Readonly<Record<string, ModelPrice>> = {
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
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'deepseek-flash': { input: 0.3, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
  'glm-5.3': { input: 0.6, output: 2.2 },
  'glm-5.1': { input: 0.6, output: 2.2 },
  'glm-4.7': { input: 0.6, output: 2.2 },
  'kimi-k3': { input: 1, output: 4 },
  'kimi-k2.6': { input: 0.6, output: 2.5 },
  'moonshot-v1-128k': { input: 1, output: 3 },
};

const FAMILIES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ['claude-opus', { input: 5, output: 25 }], ['claude-fable', { input: 10, output: 50 }],
  ['claude-sonnet', { input: 2, output: 10 }], ['claude-haiku', { input: 1, output: 5 }],
  ['claude-', { input: 5, output: 25 }], ['gpt-6', { input: 10, output: 50 }], ['gpt-', { input: 4, output: 20 }],
  ['glm-', { input: 0.6, output: 2.2 }], ['kimi-', { input: 0.6, output: 2.5 }], ['moonshot-', { input: 1, output: 3 }],
];

export function modelPriceFor(model: string): ModelPrice | null {
  let id = model.trim().toLowerCase();
  if (!id) return null;
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  const exact = EXACT[id] ?? Object.entries(EXACT).find(([known]) => id.startsWith(known))?.[1];
  return exact ?? FAMILIES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}

/** Lower-to-upper one-response estimate; the caller supplies a rough input-token count. */
export function estimateResponseCostUsd(model: string, inputTokens: number): { low: number; high: number } | null {
  const price = modelPriceFor(model);
  if (!price) return null;
  const input = Math.max(0, inputTokens);
  const toUsd = (outputTokens: number) => (input * price.input + outputTokens * price.output) / 1_000_000;
  return { low: toUsd(500), high: toUsd(2_500) };
}
