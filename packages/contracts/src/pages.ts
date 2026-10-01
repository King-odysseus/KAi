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

/** The screens named in the pages artifact, with the first route each section mentions. */
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
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { name: plain(heading[1]!).slice(0, 80), text: [] };
    } else current?.text.push(line);
  }
  flush();
  return pages.filter((page) => page.name);
}
