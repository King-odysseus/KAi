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
