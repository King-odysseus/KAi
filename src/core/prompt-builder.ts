/**
 * Assembles a final agent prompt from the user's text plus the context
 * chips attached in the composer (active file, added files, a selection,
 * uncommitted changes, a memory search, or an image). Kept as a pure
 * function so the exact preamble shape is unit-testable without a webview.
 */

export type ContextChip =
  | { type: 'file'; path: string }
  | { type: 'selection'; path: string; startLine: number; endLine: number }
  | { type: 'terminal'; content: string }
  | { type: 'gitDiff'; stat: string }
  | { type: 'memory'; query: string; summary: string }
  | { type: 'image'; name: string };

function describeChip(chip: ContextChip): string {
  switch (chip.type) {
    case 'file':
      return `- ${chip.path}`;
    case 'selection':
      return `- ${chip.path}:${chip.startLine}-${chip.endLine} (selection)`;
    case 'terminal':
      return `- terminal output:\n${indent(chip.content)}`;
    case 'gitDiff':
      return `- uncommitted changes:\n${indent(chip.stat)}`;
    case 'memory':
      return `- memory search "${chip.query}":\n${indent(chip.summary)}`;
    case 'image':
      return `- image: ${chip.name}`;
    default:
      return '';
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export function buildPromptWithContext(userText: string, chips: ContextChip[]): string {
  const trimmed = userText.trim();
  if (chips.length === 0) return trimmed;

  const lines = chips.map(describeChip).filter(Boolean);
  return `Context:\n${lines.join('\n')}\n\n${trimmed}`;
}

const MEMORY_BRIEFING_MAX_CHARS = 1500;
/** Placeholder recall summaries that carry no real memory content — never
 * worth injecting into a prompt. */
const EMPTY_RECALL_PATTERNS = [/^No recall results found\.?$/i, /^Cognitive1 disabled/i];

/**
 * Turns a Cognitive1 recall summary into a bounded prompt preamble, or ''
 * when there's nothing real to inject (recall found nothing, or the client
 * is disabled) — the orchestrator sends this ahead of the user's prompt so
 * the "Used N memories" chip reflects something the agent actually saw.
 */
export function buildMemoryBriefing(recallSummary: string | undefined): string {
  const text = (recallSummary ?? '').trim();
  if (!text || EMPTY_RECALL_PATTERNS.some((p) => p.test(text))) return '';
  const capped = text.length > MEMORY_BRIEFING_MAX_CHARS ? `${text.slice(0, MEMORY_BRIEFING_MAX_CHARS)}…` : text;
  return `Relevant memory from past sessions:\n${capped}`;
}
