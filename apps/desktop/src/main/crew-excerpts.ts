/**
 * Code attached to a card for a small local model.
 *
 * A small model spends much of its turn (and its context) finding the file a card is about, and often gets lost doing it.
 * The Lead writes cards that name their files, so KAI reads those files for it and puts the start of each in the card.
 * Everything here is pure; reading the files is a port the runner is given.
 */

const EXTENSIONS = 'tsx|ts|jsx|js|mjs|cjs|json|jsonc|css|scss|html|md|mdx|yaml|yml|toml|py|rs|go|java|kt|sh|ps1|sql|vue|svelte|txt';
// A relative path with a directory or a bare file name, ending in a known extension. A path never starts with a slash or
// `..`, and a URL's host is not mistaken for one because a `://` before it rules it out.
const PATH = new RegExp(`(?<![\\w:/\\\\.@-])((?:\\./)?(?:[\\w@-][\\w@.-]*/)*[\\w@-][\\w@.-]*\\.(?:${EXTENSIONS}))(?![\\w/])`, 'g');

/** The files a card's text names, in the order named, without repeats, at most `limit`. */
export function pathsMentioned(text: string, limit = 3): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH)) {
    const path = match[1]!.replace(/^\.\//, '');
    if (path.includes('..') || /^https?$/i.test(path) || found.includes(path)) continue;
    found.push(path);
    if (found.length >= limit) break;
  }
  return found;
}

/** Characters of each file attached. A card is for a small change, so the top of the file is the part that is needed. */
export const EXCERPT_CHARS = 3_500;

export interface Excerpt {
  path: string;
  text: string;
  /** True when the file was longer than what is attached. */
  cut: boolean;
}

/** The attached code as a section of the card, saying what it is and that it may be cut so the builder reads on if needed. */
export function excerptSection(excerpts: readonly Excerpt[]): string {
  if (excerpts.length === 0) return '';
  const blocks = excerpts.map((item) => `--- ${item.path}${item.cut ? ' (the start of the file; read on if you need more)' : ''}\n${item.text}`);
  return `Code this card names, read for you so you do not have to search for it:\n\n${blocks.join('\n\n')}`;
}
