import type { AgentId, RouteMode } from '../core/types';

export interface CostEstimate {
  agent: AgentId;
  route: RouteMode;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  modelName: string;
}

// Rough pricing per 1M tokens (input / output), as of mid-2026
const PRICING: Record<string, { input: number; output: number; model: string }> = {
  'claude:direct': { input: 3.0, output: 15.0, model: 'Claude Sonnet 4' },
  'claude:proxy': { input: 0.5, output: 1.5, model: 'DeepSeek V4 Pro (via proxy)' },
  'codex:direct': { input: 2.5, output: 10.0, model: 'GPT-5.5' },
  'codex:proxy': { input: 0.3, output: 0.9, model: 'DeepSeek V4 Flash (via proxy)' },
  'qwen:direct': { input: 1.0, output: 4.0, model: 'Qwen Code' },
  'qwen:proxy': { input: 0.4, output: 1.2, model: 'DeepSeek V4 Pro (via proxy)' },
  'gemini:direct': { input: 1.5, output: 6.0, model: 'Gemini 2.5 Pro' },
  'gemini:proxy': { input: 0.4, output: 1.2, model: 'DeepSeek V4 Pro (via proxy)' },
};

function resolvePricing(agent: AgentId, route: RouteMode): { input: number; output: number; model: string } {
  const key = `${agent}:${route}`;
  return PRICING[key] || PRICING['claude:direct'];
}

/**
 * The display model name for an agent/route pair — used for the reply
 * header's route chip (e.g. "Proxy · DeepSeek V4 Pro (via proxy)").
 */
export function getModelName(agent: AgentId, route: RouteMode): string {
  return resolvePricing(agent, route).model;
}

// Approximate context window (tokens) per agent/route pair, as of mid-2026.
// Used only for the composer's context-used meter — an estimate, not a hard
// limit enforced anywhere.
const CONTEXT_WINDOW: Record<string, number> = {
  'claude:direct': 200_000,
  'claude:proxy': 128_000,
  'codex:direct': 200_000,
  'codex:proxy': 64_000,
  'qwen:direct': 128_000,
  'qwen:proxy': 64_000,
  'gemini:direct': 1_000_000,
  'gemini:proxy': 64_000,
};

/** The approximate context window size for an agent/route pair, in tokens. */
export function getContextWindow(agent: AgentId, route: RouteMode): number {
  const key = `${agent}:${route}`;
  return CONTEXT_WINDOW[key] || CONTEXT_WINDOW['claude:direct'];
}

/**
 * Improved token estimation using character-count heuristics that better
 * model real tokenization.
 *
 * Strategy:
 * - Code tokens average ~3.3 characters (not 4.0) — code uses shorter
 *   identifiers, punctuation-heavy syntax, and whitespace.
 * - Natural-language tokens average ~3.8 characters.
 * - We classify the input and weight the estimate accordingly.
 */

/** Characters-per-token ratios by content type. */
const CHARS_PER_TOKEN = {
  code: 3.3,
  naturalLanguage: 3.8,
  mixed: 3.5,
} as const;

/** Code-related keywords that signal the prompt is about programming. */
const CODE_SIGNALS = [
  'function', 'const', 'let', 'var', 'class', 'import', 'export',
  'return', 'async', 'await', 'interface', 'type', 'enum', 'struct',
  'impl', 'def', 'fn', 'pub', 'use', 'mod', 'package', 'require',
  'component', 'props', 'state', 'render', 'useState', 'useEffect',
  'div', 'span', '<div', '<script', 'css', '```', 'diff ', 'patch',
  'error ', 'bug', 'fix', 'refactor', 'test', 'deploy', 'build',
  'npm ', 'yarn ', 'git ', 'docker', 'api', 'endpoint', 'route',
];

/**
 * Classify a prompt as predominantly code, natural language, or mixed.
 */
function classifyPrompt(prompt: string): 'code' | 'naturalLanguage' | 'mixed' {
  const lower = prompt.toLowerCase();
  let codeSignals = 0;
  for (const signal of CODE_SIGNALS) {
    if (lower.includes(signal)) {
      codeSignals++;
    }
  }

  // Also check for code blocks (```) and indentation patterns
  const codeBlockMatches = (prompt.match(/```/g) || []).length;
  const indentedLines = prompt.split('\n').filter((l) => l.startsWith('  ') || l.startsWith('\t')).length;

  codeSignals += codeBlockMatches;
  codeSignals += Math.min(indentedLines, 5); // cap at 5 signals from indentation

  if (codeSignals >= 3) return 'code';
  if (codeSignals >= 1) return 'mixed';
  return 'naturalLanguage';
}

/**
 * Count tokens using a heuristic that distinguishes code from natural language.
 *
 * The average ratio of ~3.5 chars/token is more accurate than the previous 4.0
 * for typical coding prompts, and gets even better with content classification.
 */
export function countTokens(prompt: string): number {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return 0;

  const category = classifyPrompt(trimmed);
  const ratio = CHARS_PER_TOKEN[category];
  return Math.max(1, Math.ceil(trimmed.length / ratio));
}

/**
 * Estimates token usage and cost before dispatching a task.
 *
 * Input tokens use content-classified counting. Output tokens are
 * estimated at 3x input for coding tasks (conservative default)
 * or 4x for proxy routes (higher verbosity on cheaper models).
 */
export function estimateCost(
  prompt: string,
  agent: AgentId,
  route: RouteMode,
): CostEstimate {
  const pricing = resolvePricing(agent, route);

  const inputTokens = Math.max(100, countTokens(prompt));
  // Conservative output estimate: 3–4x input
  const outputMultiplier = route === 'proxy' ? 4 : 3;
  const outputTokens = Math.ceil(inputTokens * outputMultiplier);

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return {
    agent,
    route,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: inputCost + outputCost,
    modelName: pricing.model,
  };
}

/**
 * Returns a human-readable summary of the cost estimate.
 */
export function formatCostEstimate(estimate: CostEstimate): string {
  const cost =
    estimate.estimatedCostUsd < 0.01
      ? '<$0.01'
      : `$${estimate.estimatedCostUsd.toFixed(2)}`;

  return `${estimate.modelName}: ~${estimate.estimatedInputTokens.toLocaleString()} in / ~${estimate.estimatedOutputTokens.toLocaleString()} out ≈ ${cost}`;
}
