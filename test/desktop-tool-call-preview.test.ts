import { describe, expect, it } from 'vitest';
import { describeToolCall, isPreviewableTool, renderToolCallPreview } from '../apps/desktop/src/renderer/src/tool-call-preview';

describe('desktop tool call preview', () => {
  it('turns a single replacement into the lines that changed', () => {
    const preview = describeToolCall('replace_in_file', {
      path: 'src/a.ts',
      old_text: 'const active = true;\nif (active) setData(x);\n',
      new_text: 'const active = true;\nif (active) return;\n',
    }, undefined);
    expect(preview).toMatchObject({ kind: 'edit', path: 'src/a.ts' });

    const view = renderToolCallPreview(preview!);
    expect(view).toMatchObject({ verb: 'Edit', target: 'src/a.ts', added: 1, removed: 1 });
    expect(view.lines.map((line) => line.kind)).toEqual(['context', 'removed', 'added']);
    expect(view.lines[1]?.text).toBe('if (active) setData(x);');
    expect(view.lines[2]?.text).toBe('if (active) return;');
  });

  it('collects a multi_edit into one card, counting every replacement', () => {
    const preview = describeToolCall('multi_edit', {
      path: 'src/b.ts',
      edits: [
        { old_text: 'one\n', new_text: 'two\n' },
        { old_text: 'three\n', new_text: 'four\nfive\n' },
      ],
    }, undefined);
    const view = renderToolCallPreview(preview!);
    expect(view.added).toBe(3);
    expect(view.removed).toBe(2);
    expect(view.note).toBe('2 edits');
    // The blank row keeps the two replacements from reading as one change.
    expect(view.lines.some((line) => line.kind === 'gap')).toBe(true);
  });

  it('shows a new file as every line added, and says when a whole file was rewritten', () => {
    const created = renderToolCallPreview(describeToolCall('create_file', { path: 'src/new.ts', content: 'a\nb\n' }, undefined)!);
    expect(created).toMatchObject({ verb: 'Create file', added: 2, removed: 0, note: null });
    expect(created.lines.every((line) => line.kind === 'added')).toBe(true);

    const written = renderToolCallPreview(describeToolCall('write_file', { path: 'src/new.ts', content: 'a\n' }, undefined)!);
    expect(written).toMatchObject({ verb: 'Write file', note: 'Whole file written' });
  });

  it('describes deletes and moves without a body', () => {
    expect(renderToolCallPreview(describeToolCall('delete_file', { path: 'src/gone.ts' }, undefined)!)).toMatchObject({ verb: 'Delete file', target: 'src/gone.ts', lines: [] });
    expect(renderToolCallPreview(describeToolCall('move_file', { from: 'a.ts', to: 'b.ts' }, undefined)!)).toMatchObject({ verb: 'Move file', target: 'a.ts → b.ts' });
  });

  it('quotes a command and the tail of its output', () => {
    const preview = describeToolCall('run_command', { command: 'npm test', cwd: 'apps/desktop' }, { exitCode: 1, stdout: 'ok\n', stderr: 'failed\n' });
    const view = renderToolCallPreview(preview!);
    expect(view.verb).toBe('Command');
    expect(view.target).toBe('npm test  (in apps/desktop)');
    expect(view.note).toBe('Exit code 1');
    expect(view.lines.map((line) => line.text)).toEqual(['ok', 'failed']);

    const long = renderToolCallPreview(describeToolCall('run_command', { command: 'x' }, { stdout: `${'a'.repeat(5_000)}END` })!);
    expect(long.lines[0]?.text.length).toBe(4_000);
    expect(long.lines[0]?.text.endsWith('END')).toBe(true);
  });

  it('accepts the field names a provider-native edit arrives with', () => {
    const preview = describeToolCall('Edit', { file_path: 'src/c.ts', old_string: 'a\n', new_string: 'b\n' }, undefined);
    expect(renderToolCallPreview(preview!)).toMatchObject({ verb: 'Edit', target: 'src/c.ts', added: 1, removed: 1 });
  });

  it('leaves anything it cannot show, or cannot read, to the Activity list', () => {
    expect(isPreviewableTool('read_file')).toBe(false);
    expect(isPreviewableTool('Replace_In_File')).toBe(true);
    expect(describeToolCall('read_file', { path: 'src/a.ts' }, undefined)).toBeNull();
    expect(describeToolCall('replace_in_file', { path: 'src/a.ts' }, undefined)).toBeNull();
    expect(describeToolCall('replace_in_file', null, undefined)).toBeNull();
    expect(describeToolCall('multi_edit', { path: 'src/a.ts', edits: [] }, undefined)).toBeNull();
    expect(describeToolCall('run_command', { cwd: '.' }, undefined)).toBeNull();
  });

  it('shows a helper agent\'s task and answer', () => {
    const view = renderToolCallPreview(describeToolCall('task', { prompt: 'Find the parser entry point.' }, { answer: 'It starts in parser.ts.', costUsd: 0.02 })!);
    expect(view).toMatchObject({ verb: 'Explored', target: 'Find the parser entry point.' });
    expect(view.lines.map((line) => line.text)).toEqual(['It starts in parser.ts.']);
  });

  it('shows a web search with its sources, or the error it hit', () => {
    const found = renderToolCallPreview(describeToolCall('web_search', { query: 'electron security' }, {
      results: [{ title: 'Security', url: 'https://example.com/security', snippet: 'Use isolation.' }],
    })!);
    expect(found).toMatchObject({ verb: 'Searched the web', target: 'electron security', note: '1 result' });
    expect(found.lines.map((line) => line.text)).toEqual(['Security — https://example.com/security', 'Use isolation.']);

    const failed = renderToolCallPreview(describeToolCall('web_search', { query: 'x' }, { error: 'No key is stored.' })!);
    expect(failed.lines[0]).toMatchObject({ kind: 'removed', text: 'No key is stored.' });
  });

  it('shows a fetched page and notes when it was truncated', () => {
    const view = renderToolCallPreview(describeToolCall('web_fetch', { url: 'https://example.com/doc' }, {
      title: 'Docs',
      url: 'https://example.com/doc',
      text: 'First line\nSecond line',
      truncated: true,
    })!);
    expect(view).toMatchObject({ verb: 'Read page', target: 'Docs — https://example.com/doc', note: 'Page truncated' });
    expect(view.lines.map((line) => line.text)).toEqual(['Docs', 'First line', 'Second line']);
  });

  it('stops at the line cap but still counts the whole change', () => {
    const content = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const view = renderToolCallPreview(describeToolCall('create_file', { path: 'src/big.ts', content }, undefined)!);
    expect(view.added).toBe(500);
    expect(view.lines).toHaveLength(401);
    expect(view.lines.at(-1)).toEqual({ kind: 'gap', text: '… 100 more lines' });
  });
});
