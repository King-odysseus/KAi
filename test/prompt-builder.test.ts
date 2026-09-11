import { describe, expect, it } from 'vitest';
import { buildPromptWithContext, buildMemoryBriefing, type ContextChip } from '../src/core/prompt-builder';

describe('buildPromptWithContext', () => {
  it('returns the trimmed prompt unchanged with no chips', () => {
    expect(buildPromptWithContext('  hello  ', [])).toBe('hello');
  });

  it('prepends a single file chip as a context preamble', () => {
    const chips: ContextChip[] = [{ type: 'file', path: 'src/a.ts' }];
    expect(buildPromptWithContext('fix this', chips)).toBe(
      'Context:\n- src/a.ts\n\nfix this',
    );
  });

  it('renders a selection chip with its line range', () => {
    const chips: ContextChip[] = [{ type: 'selection', path: 'src/a.ts', startLine: 10, endLine: 40 }];
    expect(buildPromptWithContext('explain', chips)).toContain('- src/a.ts:10-40 (selection)');
  });

  it('renders multiple chips in order, each on its own line', () => {
    const chips: ContextChip[] = [
      { type: 'file', path: 'src/a.ts' },
      { type: 'file', path: 'src/b.ts' },
      { type: 'image', name: 'screenshot.png' },
    ];
    const result = buildPromptWithContext('do it', chips);
    expect(result).toBe('Context:\n- src/a.ts\n- src/b.ts\n- image: screenshot.png\n\ndo it');
  });

  it('indents multi-line chip content (git diff, terminal, memory)', () => {
    const chips: ContextChip[] = [{ type: 'gitDiff', stat: 'a.ts | 2 +-\nb.ts | 1 +' }];
    const result = buildPromptWithContext('review', chips);
    expect(result).toBe('Context:\n- uncommitted changes:\n  a.ts | 2 +-\n  b.ts | 1 +\n\nreview');
  });

  it('renders a memory chip with its query and summary', () => {
    const chips: ContextChip[] = [{ type: 'memory', query: 'proxy bug', summary: 'Fixed /v1 stripping.' }];
    const result = buildPromptWithContext('continue', chips);
    expect(result).toContain('- memory search "proxy bug":');
    expect(result).toContain('  Fixed /v1 stripping.');
  });
});

describe('buildMemoryBriefing', () => {
  it('returns empty for undefined or blank input', () => {
    expect(buildMemoryBriefing(undefined)).toBe('');
    expect(buildMemoryBriefing('   ')).toBe('');
  });

  it('returns empty for the embedded client\'s "nothing found" message', () => {
    expect(buildMemoryBriefing('No recall results found.')).toBe('');
  });

  it('returns empty when Cognitive1 is disabled', () => {
    expect(buildMemoryBriefing('Cognitive1 disabled: recall pending.')).toBe('');
  });

  it('wraps a real recall summary as a briefing preamble', () => {
    const result = buildMemoryBriefing('Recall found 2 relevant result(s): [session] claude: fixed the bug');
    expect(result).toBe('Relevant memory from past sessions:\nRecall found 2 relevant result(s): [session] claude: fixed the bug');
  });

  it('caps a very long recall summary', () => {
    const long = 'x'.repeat(2000);
    const result = buildMemoryBriefing(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('…');
  });
});
