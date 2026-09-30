import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../apps/desktop/src/renderer/src/components/Markdown';
import { isSafeHref, parseInline, parseMarkdown } from '../apps/desktop/src/renderer/src/markdown';

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('markdown blocks', () => {
  it('parses headings, paragraphs and rules', () => {
    expect(parseMarkdown('# Title\n\nSome text\nsecond line\n\n---\n\n### Small ###')).toMatchObject([
      { type: 'heading', level: 1 },
      { type: 'paragraph' },
      { type: 'hr' },
      { type: 'heading', level: 3 },
    ]);
  });

  it('keeps single newlines in a paragraph as line breaks', () => {
    const [paragraph] = parseMarkdown('one\ntwo');
    expect(paragraph).toMatchObject({ type: 'paragraph', children: [{ type: 'text', text: 'one' }, { type: 'br' }, { type: 'text', text: 'two' }] });
  });

  it('parses fenced code with a language, and treats an unfinished fence as code to the end', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```\nafter')).toMatchObject([
      { type: 'code', language: 'ts', text: 'const a = 1;' },
      { type: 'paragraph' },
    ]);
    expect(parseMarkdown('Look:\n```bash\nnpm test')).toMatchObject([{ type: 'paragraph' }, { type: 'code', language: 'bash', text: 'npm test' }]);
    // A fence inside a longer fence does not close it, and markdown inside code is not interpreted.
    expect(parseMarkdown('````md\n```\n# not a heading\n```\n````')).toMatchObject([{ type: 'code', text: '```\n# not a heading\n```' }]);
  });

  it('parses bullet and numbered lists, including nesting and a numbered start', () => {
    const [list] = parseMarkdown('- one\n- two\n  - nested a\n  - nested b\n- three');
    expect(list).toMatchObject({ type: 'list', ordered: false });
    const items = (list as Extract<ReturnType<typeof parseMarkdown>[number], { type: 'list' }>).items;
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject([{ type: 'paragraph' }, { type: 'list', items: [expect.anything(), expect.anything()] }]);

    expect(parseMarkdown('3. c\n4. d')).toMatchObject([{ type: 'list', ordered: true, start: 3 }]);
  });

  it('keeps a loose list (blank lines between items) as one list', () => {
    const blocks = parseMarkdown('1. first\n\n2. second\n\n3. third');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
  });

  it('parses tables with alignment and pads short rows', () => {
    const [table] = parseMarkdown('| Name | Score |\n| :-- | --: |\n| a | 1 |\n| b |');
    expect(table).toMatchObject({ type: 'table', aligns: ['left', 'right'] });
    expect((table as { rows: unknown[][] }).rows).toHaveLength(2);
    expect((table as { rows: unknown[][] }).rows[1]).toHaveLength(2);
  });

  it('parses block quotes containing other blocks', () => {
    expect(parseMarkdown('> Note\n> - a\n> - b')).toMatchObject([{ type: 'quote', blocks: [{ type: 'paragraph' }, { type: 'list' }] }]);
  });

  it('does not mistake a dash line or pipes in prose for a table or rule', () => {
    expect(parseMarkdown('a | b\nplain')).toMatchObject([{ type: 'paragraph' }]);
    expect(parseMarkdown('- - -')).toMatchObject([{ type: 'hr' }]);
  });
});

describe('markdown inline', () => {
  it('handles emphasis, code and strikethrough', () => {
    expect(parseInline('a **bold** and *it* and `code` and ~~gone~~')).toMatchObject([
      { text: 'a ' }, { type: 'strong' }, { text: ' and ' }, { type: 'em' }, { text: ' and ' }, { type: 'code', text: 'code' }, { text: ' and ' }, { type: 'del' },
    ]);
  });

  it('nests bold inside italic and leaves unmatched markers and snake_case alone', () => {
    expect(parseInline('*a **b** c*')).toMatchObject([{ type: 'em', children: [{ text: 'a ' }, { type: 'strong' }, { text: ' c' }] }]);
    expect(parseInline('2 * 3 and **open')).toEqual([{ type: 'text', text: '2 * 3 and **open' }]);
    expect(parseInline('use my_var_name here')).toEqual([{ type: 'text', text: 'use my_var_name here' }]);
  });

  it('keeps markup inside inline code literal and honours escapes', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ type: 'code', text: '**not bold**' }]);
    expect(parseInline('\\*literal\\*')).toEqual([{ type: 'text', text: '*literal*' }]);
  });

  it('makes links from markdown and bare addresses, without the trailing punctuation', () => {
    expect(parseInline('[docs](https://example.com/a_(b)) ok')).toMatchObject([{ type: 'link', href: 'https://example.com/a_(b)' }, { text: ' ok' }]);
    expect(parseInline('see https://example.com/x.')).toMatchObject([{ text: 'see ' }, { type: 'link', href: 'https://example.com/x' }, { text: '.' }]);
  });

  it('only allows http, https and mailto links', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('file:///C:/secret')).toBe(false);
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', text: 'click' }]);
  });
});

describe('Markdown component', () => {
  it('renders formatted elements instead of raw symbols', () => {
    const out = html('## Plan\n\n- **Fix** the `parser`\n- [Docs](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<h2');
    expect(out).toContain('<strong>Fix</strong>');
    expect(out).toContain('<code class="md-inline-code">parser</code>');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('<table>');
    expect(out).not.toContain('##');
    expect(out).not.toContain('**');
  });

  it('cannot inject markup: agent HTML is shown as text', () => {
    const out = html('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });

  it('renders a code block as a card with a copy button', () => {
    const out = html('```js\nlet a = 1;\n```');
    expect(out).toContain('class="response-code"');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toContain('let a = 1;');
  });
});
