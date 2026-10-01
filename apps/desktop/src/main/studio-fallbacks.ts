import type { StudioCardDraft } from '@kai/contracts';

/**
 * What the Studio does when a model will not return what it was asked for. None of this calls a model: it reads
 * text that is already on disk, so a provider with poor JSON discipline can still leave the project with a board.
 */

/** The start of a reply that could not be used, on one line, so an error says what the model actually sent. */
export function replySnippet(content: string): string {
  const flat = content.trim().replace(/\s+/g, ' ');
  return flat ? `The reply began: "${flat.slice(0, 140)}${flat.length > 140 ? '…' : ''}"` : 'The reply was empty.';
}

const KIND_PAGE = /\b(page|screen|form|dashboard|sign.?in|log.?in|view)\b/;
const KIND_BACKEND = /\b(api|endpoint|database|schema|server|auth|webhook|integration)\b/;

function clean(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/^story\s*\d*\s*[:.\-–]\s*/i, '')
    .trim();
}

/**
 * Reads cards straight from the stories document, for when the model will not return the board as JSON. A story is
 * a heading or a numbered item; bullets under it become its acceptance checks. The cards carry no dependencies,
 * since the stories do not state them, so they all start ready and the user can reorder them.
 */
export function boardDraftFromStories(stories: string): { cards: StudioCardDraft[] } {
  const lines = stories.split(/\r?\n/);
  const match = (pattern: RegExp): Array<{ index: number; text: string }> =>
    lines.flatMap((line, index) => {
      const found = pattern.exec(line);
      return found?.[1] ? [{ index, text: found[1] }] : [];
    });
  const headings = match(/^#{2,4}\s+(.+?)\s*#*\s*$/);
  const rows = headings.length >= 2 ? headings : match(/^\d+[.)]\s+(.+?)\s*$/);

  const cards = rows.slice(0, 60).map((row, position): StudioCardDraft => {
    const end = rows[position + 1]?.index ?? lines.length;
    const body = lines.slice(row.index + 1, end);
    const acceptance = body
      .map((line) => /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1] ?? '')
      .map(clean)
      .filter(Boolean)
      .slice(0, 8)
      .map((item) => item.slice(0, 400));
    const title = clean(row.text).slice(0, 120) || `Story ${position + 1}`;
    const haystack = `${title} ${body.join(' ')}`.toLowerCase();
    return {
      key: `story-${position + 1}`,
      title,
      kind: KIND_PAGE.test(haystack) ? 'page' : KIND_BACKEND.test(haystack) ? 'backend' : 'flow',
      story: [row.text, ...body].join('\n').trim().slice(0, 4_000),
      acceptance,
      route: '',
      dependsOnKeys: [],
    };
  });
  return { cards };
}
