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
 * What the plan says each screen's route is, read from the `Route:` line of its section.
 *
 * `routes` has the path the line names, whether it stands alone (`/settings`), sits in backticks or brackets (`` `/` ``,
 * `(/)`) or ends a phrase ("inside `/`"). `routeless` has the screens whose line names no path at all — a modal raised
 * from a view, a popover, the OS tray menu — which are drawn but cannot be opened at an address. A file path such as
 * `src/main/main.js` is not a route, and neither is a lone slash between two words, as in "`openApp` / `openUrl`".
 * A section with no `Route:` line says nothing either way. Keys match `screenTitleKey`, so a card finds its section by name.
 */
export function screenRoutesFromPages(markdown: string): { routes: Map<string, string>; routeless: Set<string> } {
  const routes = new Map<string, string>();
  const routeless = new Set<string>();
  let name = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { name = plain(heading[1]!).slice(0, 80); continue; }
    if (!name) continue;
    const route = /^\s*(?:[-*]\s*)?\**Route\**\s*:\s*\**\s*(.*)$/i.exec(line);
    if (!route) continue;
    const key = screenTitleKey(name);
    const named = /[`(](\/[A-Za-z0-9\-_/:{}.]*)[`)]/.exec(route[1]!)?.[1]
      ?? /(?:^|\s)(\/[A-Za-z0-9\-_:{}.][A-Za-z0-9\-_/:{}.]*)/.exec(route[1]!)?.[1];
    if (key) {
      const clean = named?.replace(/[.,;:]+$/, '').replace(/\/+$/, '');
      if (named && !named.includes('*')) routes.set(key, clean || '/');
      else if (!named) routeless.add(key);
    }
    name = '';
  }
  return { routes, routeless };
}

/**
 * The key of the text before a `—` that is a subtitle, not a route: `Act-mode proposal — steps` gives
 * `act mode proposal`. Empty when the name has no such dash, or when what leads it is a route (`/pricing — Pricing`),
 * which `screenTitleKey` already drops.
 */
export function subtitleStemKey(name: string): string {
  const match = /^(.*?)\s*[—–]\s*\S/.exec(name.trim());
  const head = match?.[1]?.trim() ?? '';
  if (!head || head.startsWith('/')) return '';
  return screenTitleKey(head);
}

/**
 * The one answer to "is this the same screen", for the plan, the board, the drawing and the chat alike. Names are
 * written in several places and drift, so the match is tried in a fixed order and each fallback must be unambiguous:
 * the same key; the name is the stem of exactly one item's subtitled name; or the name carries a subtitle the item
 * left off. `Settings — providers` and `Settings — appearance` share a stem, so neither is matched by `Settings`.
 */
export function findScreen<T>(items: readonly T[], nameOf: (item: T) => string, name: string): T | undefined {
  const key = screenTitleKey(name);
  if (!key) return undefined;
  const exact = items.find((item) => screenTitleKey(nameOf(item)) === key);
  if (exact) return exact;
  const byItemStem = items.filter((item) => subtitleStemKey(nameOf(item)) === key);
  if (byItemStem.length === 1) return byItemStem[0];
  const own = subtitleStemKey(name);
  if (own) {
    const byOwnStem = items.filter((item) => screenTitleKey(nameOf(item)) === own);
    if (byOwnStem.length === 1) return byOwnStem[0];
  }
  return undefined;
}

/**
 * Pages a design holds or a plan lists that are not screens: the component sheet, a scratch canvas, the plan's own
 * notes. They are real and worth keeping, but a card for one can never be built or checked, so none is made for them.
 */
const NON_SCREEN_PAGES = new Set([
  'design system', 'components', 'component library', 'style guide', 'foundation', 'cover', 'scratch', 'playground',
  'internal only canvas', 'page inventory', 'excluded screens',
]);
/** Test probes and scratch pages left in a design: a card for one is work that does not exist. */
const PROBE_NAME = /^zz\b|^(?:probe|sandbox|playground)$|\bprobe$/i;

export function isNonScreenName(name: string): boolean {
  const key = screenTitleKey(name);
  return NON_SCREEN_PAGES.has(key) || PROBE_NAME.test(key);
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
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0] ?? '';
  const embedded = /[([{](\/[A-Za-z0-9_.*{}:/-]+)[)\]}]/.exec(trimmed)?.[1] ?? '';
  const candidate = first.startsWith('/') ? first : embedded;
  if (!candidate.startsWith('/')) return '';
  // A shell wildcard names its base URL; a dynamic segment uses a harmless sample value so the checker can open it.
  const route = candidate.replace(/\/\*$/, '').replace(/\{[A-Za-z_][\w-]*\}/g, '1').replace(/[.,;:]+$/, '').replace(/\/+$/, '');
  if (route.includes('*')) return '';
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

/** The heading a new screen is written under. The route leads, as the pages brief writes it, so `routeFromScreenName`
 * and `parsePages` agree on the route without a second copy in the body. */
export function newPageHeading(title: string, route: string): string {
  const name = plain(title).slice(0, 80);
  const path = route.trim();
  return path.startsWith('/') ? `${path} — ${name}`.slice(0, 120) : name;
}

/**
 * Adds one screen to the pages inventory: a `##` section with the route in the heading and the purpose in the body.
 * Appends, so every section already there keeps its text and its order. Answers the same shape `renamePageHeading`
 * does, so a caller can tell an add that happened from one that had nothing to add to.
 */
export function appendPageSection(markdown: string, title: string, route: string, purpose: string): string {
  const heading = newPageHeading(title, route);
  const body = purpose.trim() || 'Added from the Studio chat.';
  const routeLine = route.trim().startsWith('/') ? `Route: ${route.trim()}` : 'Route: (missing — set it on the board card)';
  const section = `## ${heading}\n\n${routeLine}\n\n${body}\n`;
  const trimmed = markdown.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${section}`;
}

/**
 * Removes the one `##` section whose name reduces to `key`, up to the next `##` heading. `###` sub-headings belong
 * to the section and go with it. Answers whether a section was found, so a removal that matched nothing is not
 * reported as a success.
 */
export function removePageSection(markdown: string, key: string): { markdown: string; removed: boolean } {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(lines[index]!);
    if (!heading) continue;
    if (start >= 0) { end = index; break; }
    if (screenTitleKey(plain(heading[1]!).slice(0, 80)) === key) start = index;
  }
  if (start < 0) return { markdown, removed: false };
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  return { markdown: next.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', removed: true };
}

/**
 * Sets the route of one section, in both places the pages inventory carries it: the heading's leading `/<route> —`
 * and a `Route:` line in the body. Replacing only the body would leave the old route in the heading, where
 * `routeFromScreenName` reads it, so the plan would say two different things about the same screen.
 */
export function setPageRoute(markdown: string, key: string, route: string): { markdown: string; changed: boolean } {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(lines[index]!);
    if (!heading) continue;
    if (screenTitleKey(plain(heading[1]!).slice(0, 80)) !== key) continue;
    let end = index + 1;
    while (end < lines.length && !/^##(?!#)\s/.test(lines[end]!)) end += 1;
    const body = lines.slice(index + 1, end);
    const routeLine = `Route: ${route}`;
    const existing = body.findIndex((line) => /^\s*(?:[-*]\s*)?(?:\*\*)?Route(?:\*\*)?\s*:/i.test(line));
    if (existing >= 0) body[existing] = routeLine;
    else body.unshift('', routeLine);
    // Keep the name and replace the route it led with. A heading with no route gains one.
    const current = plain(heading[1]!).slice(0, 80);
    const display = current
      .replace(/^.*?[—–]\s*/, '')
      .replace(/(?:^|\s)\/[A-Za-z0-9\-_/:{}.]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || current;
    lines[index] = `## ${newPageHeading(display, route)}`;
    const next = [...lines.slice(0, index + 1), ...body, ...lines.slice(end)];
    return { markdown: next.join('\n'), changed: true };
  }
  return { markdown, changed: false };
}

/**
 * Adds one story to the stories document, in the shape the stories artifact already uses: a `##` heading, the story
 * itself, then its acceptance criteria. A section whose heading reduces to the same key is left alone, so a feature
 * change set that re-sends the same story does not duplicate it.
 */
export function appendStorySection(
  markdown: string,
  title: string,
  body: string,
  acceptance: readonly string[],
): { markdown: string; added: boolean } {
  const key = screenTitleKey(title);
  if (!key) return { markdown, added: false };
  const existing = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) existing.add(screenTitleKey(plain(heading[1]!).slice(0, 80)));
  }
  if (existing.has(key)) return { markdown, added: false };
  const criteria = acceptance.map((item) => item.trim()).filter(Boolean);
  const section = [
    `## ${plain(title).slice(0, 120)}`,
    '',
    body.trim() || 'Added from the Studio chat.',
    '',
    ...(criteria.length > 0 ? ['**Acceptance criteria**', ...criteria.map((item) => `- ${item}`), ''] : []),
  ].join('\n');
  const trimmed = markdown.trimEnd();
  return { markdown: `${trimmed ? `${trimmed}\n\n` : ''}${section}`, added: true };
}
