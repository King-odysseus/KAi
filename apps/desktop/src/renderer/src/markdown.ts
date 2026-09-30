/**
 * A small, dependency-free Markdown parser for agent replies. It produces a plain tree, never HTML, so nothing an
 * agent writes can inject markup: the renderer turns each node into a React element. It covers what agents actually
 * write: headings, emphasis, inline code, fenced code, lists (nested), quotes, tables, rules and safe links.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'table'; header: Inline[][]; aligns: Align[]; rows: Inline[][][] }
  | { type: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

export function isSafeHref(href: string): boolean {
  return SAFE_LINK.test(href.trim());
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || startsTable(lines, index);
}

function startsTable(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return Boolean(header && separator && header.includes('|') && TABLE_SEPARATOR.test(separator) && separator.includes('-'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] ?? '';
      const body: string[] = [];
      index += 1;
      // An unterminated fence, common while a reply is still streaming, runs to the end of the text.
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', language, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        inner.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block. Single newlines are kept as line breaks,
    // because chat replies rely on them.
    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index]!) && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(lines[index]!.replace(/[ \t]+$/, ''));
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], start: number): { block: Block; next: number } {
  const header = splitRow(lines[start]!);
  const aligns: Align[] = splitRow(lines[start + 1]!).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows: Inline[][][] = [];
  let index = start + 2;
  while (index < lines.length && !isBlank(lines[index]!) && lines[index]!.includes('|')) {
    const cells = splitRow(lines[index]!);
    rows.push(header.map((_, column) => parseInline(cells[column] ?? '')));
    index += 1;
  }
  return { block: { type: 'table', header: header.map((cell) => parseInline(cell)), aligns, rows }, next: index };
}

function nextNonBlank(lines: string[], from: number): number {
  let look = from;
  while (look < lines.length && isBlank(lines[look]!)) look += 1;
  return look;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const sibling = (line: string | undefined): RegExpExecArray | null => {
    const match = line === undefined ? null : LIST_ITEM.exec(line);
    return match && indentOf(match[1]!) === baseIndent && /\d/.test(match[2]!) === ordered ? match : null;
  };
  const items: Block[][] = [];
  let index = start;

  while (index < lines.length) {
    // Blank lines between items keep it one (loose) list, but only when another item follows.
    if (isBlank(lines[index]!)) {
      const look = nextNonBlank(lines, index);
      if (!sibling(lines[look])) break;
      index = look;
    }
    const match = sibling(lines[index]);
    if (!match) break;
    const contentIndent = baseIndent + match[2]!.length + 1;
    const body: string[] = [match[3]!];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (isBlank(next)) {
        // The item carries on after a blank line only when what follows is indented under it.
        const look = nextNonBlank(lines, index);
        if (look < lines.length && indentOf(lines[look]!) > baseIndent) {
          for (; index < look; index += 1) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(next) > baseIndent) {
        body.push(next.slice(Math.min(indentOf(next), contentIndent)));
        index += 1;
        continue;
      }
      // At or left of the marker: a sibling item or another block ends this one; plain text is a lazy continuation.
      if (LIST_ITEM.test(next) || startsBlock(lines, index)) break;
      body.push(next);
      index += 1;
    }
    items.push(parseBlocks(body));
  }
  return { block: { type: 'list', ordered, start: startNumber, items }, next: index };
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Inline formatting. Unmatched markers stay as literal text, so half-streamed replies never look broken. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;

    if (char === '\\' && index + 1 < source.length && PUNCTUATION.test(source[index + 1]!)) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '\n') {
      flush();
      out.push({ type: 'br' });
      index += 1;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (source[index + run] === '`') run += 1;
      const marker = '`'.repeat(run);
      const close = source.indexOf(marker, index + run);
      if (close > index + run) {
        flush();
        out.push({ type: 'code', text: source.slice(index + run, close).replace(/^ (.*) $/s, '$1') });
        index = close + run;
        continue;
      }
      buffer += marker;
      index += run;
      continue;
    }
    if (char === '[') {
      const link = matchLink(source, index);
      if (link) {
        flush();
        out.push(isSafeHref(link.href)
          ? { type: 'link', href: link.href, children: parseInline(link.label) }
          : { type: 'text', text: link.label });
        index = link.end;
        continue;
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      const styled = matchEmphasis(source, index, char);
      if (styled) {
        flush();
        out.push({ type: styled.kind, children: parseInline(styled.inner) } as Inline);
        index = styled.end;
        continue;
      }
    }
    if ((char === 'h' || char === 'H') && (index === 0 || /[\s(]/.test(source[index - 1]!))) {
      const url = /^https?:\/\/[^\s<>]+/i.exec(source.slice(index));
      if (url) {
        let text = url[0];
        // Trailing sentence punctuation is not part of the address.
        while (/[.,;:!?)\]'"]$/.test(text) && !(text.endsWith(')') && text.includes('('))) text = text.slice(0, -1);
        flush();
        out.push({ type: 'link', href: text, children: [{ type: 'text', text }] });
        index += text.length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

function matchLink(source: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '\\') {
      index += 1;
    } else if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end < 0) break;
      index = end;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0 || source[close + 1] !== '(') return null;
  let parens = 1;
  let end = close + 2;
  for (; end < source.length && parens > 0; end += 1) {
    if (source[end] === '(') parens += 1;
    else if (source[end] === ')') parens -= 1;
    else if (source[end] === '\n') return null;
  }
  if (parens !== 0) return null;
  const target = source.slice(close + 2, end - 1).trim();
  const href = /^<(.+)>$/.exec(target)?.[1] ?? target.replace(/\s+["'].*$/, '');
  if (!href) return null;
  return { label: source.slice(start + 1, close), href, end };
}

function matchEmphasis(
  source: string,
  start: number,
  char: '*' | '_' | '~',
): { kind: 'strong' | 'em' | 'del'; inner: string; end: number } | null {
  const double = source[start + 1] === char;
  if (char === '~' && !double) return null;
  const width = double ? 2 : 1;
  const marker = char.repeat(width);
  const after = source[start + width];
  if (!after || /\s/.test(after)) return null;
  // Underscores inside a word (snake_case) are not emphasis.
  if (char === '_' && start > 0 && /[A-Za-z0-9]/.test(source[start - 1]!)) return null;
  let from = start + width;
  while (from < source.length) {
    const close = source.indexOf(marker, from);
    if (close < 0) return null;
    const before = source[close - 1]!;
    const following = source[close + width];
    const closes = close > start + width && !/\s/.test(before) && !(char === '_' && following !== undefined && /[A-Za-z0-9]/.test(following));
    // A single marker must not stop at the first half of a doubled one (**bold** inside *italic*).
    const partOfDouble = width === 1 && source[close + 1] === char;
    if (closes && !partOfDouble) {
      return { kind: char === '~' ? 'del' : double ? 'strong' : 'em', inner: source.slice(start + width, close), end: close + width };
    }
    from = close + (partOfDouble ? 2 : width);
  }
  return null;
}
