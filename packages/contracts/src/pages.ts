/**
 * The screens named in the pages artifact. It lives with the contracts because both sides read it: the Studio's
 * Design tab lists them, and the Equalizer takes them as the screens to compare.
 */

export interface PageEntry {
  name: string;
  route: string;
  /** What the pages document says about this screen: its purpose, components and states. */
  details: string;
}

function plain(value: string): string {
  return value.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The part of a screen's name that identifies it, for matching a page in the artifact against a page in the editor.
 *
 * Exact text is too strict to be useful. A section heading carries things that are not the screen's name —
 * `## /pricing — Pricing page /pricing` names the route twice and the screen once — and a model told to "create one
 * page named as above" reasonably names it "Pricing page". Comparing the raw strings left the row "to draw" forever
 * and gave the board a second card for a screen it already had.
 *
 * So a leading route and a trailing route are dropped, a `—`-separated prefix and any parenthesised aside with them,
 * and what is left is compared with punctuation and spacing flattened.
 *
 * It lives here, beside the parser, because both sides need it: the Studio's checklist in the renderer, and the board
 * merge in the main process. Two copies would be two answers to "is this the same screen".
 */
export function screenTitleKey(name: string): string {
  let title = name.trim();
  // `## / — Marketing home (sharpsite.ng)`: a route, a dash, then the name the model will actually use.
  const dashed = /^.*?[—–]\s*(.+)$/.exec(title);
  if (dashed) title = dashed[1]!;
  return title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(?:^|\s)\/[A-Za-z0-9\-_/:{}.]*/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The route a screen's name carries, when it carries one.
 *
 * open-pencil pages are named the way the pages brief writes them — `/ — Marketing home (sharpsite.ng)`,
 * `/pricing — Pricing page` — so a name that starts with a slash has its route as the first word. A card built from
 * such a page needs it: the board will not close a component or page card without a passing screen check, and the
 * screen check needs a route to open. Pages pulled before this existed had no route at all, so every page card the
 * design created was unclosable, and everything waiting on those cards waited forever. A name with no slash in front
 * (`Page 1`) has no route to give, so it yields nothing and a person fills it in on the card.
 */
export function routeFromScreenName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  if (!first.startsWith('/')) return '';
  const route = first.replace(/[.,;:]+$/, '').replace(/\/+$/, '');
  return (route || '/').slice(0, 300);
}

/**
 * The screens named in the pages artifact, with the first route each section mentions.
 *
 * Only `##` starts a screen. `###` is a sub-heading inside one — the pages brief asks for `## Page name` per screen
 * and everything else under it — so reading a `###` as a screen turned "### States" and "### Components" into
 * screens of their own. They then appeared in the drawing checklist as screens to draw, and two sections could
 * reduce to the same name and produce duplicate entries.
 */
export function parsePages(markdown: string): PageEntry[] {
  const pages: PageEntry[] = [];
  let current: { name: string; text: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const body = current.text.join('\n').trim();
    // A route at the end of a sentence must not keep the sentence's full stop or comma.
    const route = (/(?:^|[\s`(])(\/[A-Za-z0-9\-_/:{}.]*)/.exec(body)?.[1] ?? '').replace(/[.,;:]+$/, '');
    pages.push({ name: current.name, route, details: body });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { name: plain(heading[1]!).slice(0, 80), text: [] };
    } else current?.text.push(line);
  }
  flush();
  return pages.filter((page) => page.name);
}

/**
 * The heading text a rename writes: the new screen name, keeping a `/route` the heading already led with so the route
 * the editor knows the page by is not dropped. Capped at 80, the cap `parsePages` applies, so the heading a reader
 * sees and the page name in the editor are the same string — a mismatch would leave the row "to draw" forever.
 */
export function renamedPageName(currentName: string, newName: string): string {
  const name = plain(newName);
  // A person who types a leading `/` is giving the whole heading; do not stack a second route on it.
  if (name.startsWith('/')) return name.slice(0, 80);
  const route = routeFromScreenName(currentName);
  return (route ? `${route} — ${name}` : name).slice(0, 80);
}

/**
 * Replaces the one `##` heading whose `screenTitleKey` is `key`, leaving every line of every body — and so the route
 * `parsePages` reads out of one — untouched. A `###` is not a screen, the same as in `parsePages`, so it is left alone.
 *
 * `renamed` says whether a heading was found, so a caller can tell a rename that happened from one whose name matched
 * nothing, rather than writing the same text back and calling it a success.
 */
export function renamePageHeading(markdown: string, key: string, nextName: string): { markdown: string; renamed: boolean } {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(lines[index]!);
    if (!heading) continue;
    // The same reduction `parsePages` matches on, so the line found here is the line that produced `key`.
    if (screenTitleKey(plain(heading[1]!).slice(0, 80)) !== key) continue;
    lines[index] = `## ${nextName}`;
    return { markdown: lines.join('\n'), renamed: true };
  }
  return { markdown, renamed: false };
}
