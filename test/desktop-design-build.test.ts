import { describe, expect, it } from 'vitest';
import { parsePages, renamePageHeading, renamedPageName, type StudioDesign } from '../packages/contracts/src';
import { drawnPageNames, foundationLanded, remainingScreens, rowsFromPull, screenLanded, screenPageId, screensToRedraw } from '../apps/desktop/src/renderer/src/design-build';
import { screenRoutesFromPages } from '../packages/contracts/src';
import { withPlanRoutes } from '../apps/desktop/src/main/board';
import { buildPagePrompt, screenRows, screenTitleKey, type DesignContext, type ScreenRow } from '../apps/desktop/src/renderer/src/flow-diagram';

/**
 * What the design build loop decides between steps.
 *
 * The loop used to decide on the agent's own say-so: a turn that reported `completed` ticked the box. A turn reports
 * `completed` whenever it ends without a technical error, which includes a turn whose every call was refused — under
 * Plan access that is every write — so the checklist filled up with ticks for work that had not happened, and
 * "N screens drawn" counted attempts rather than screens.
 *
 * These cases pin the replacement: read the design back, and believe only what it shows.
 */

const PAGES = [
  '# Pages',
  '',
  '## / — Marketing home (sharpsite.ng)',
  'Route: `/`. The landing page.',
  '',
  '## /pricing — Pricing page /pricing',
  'Route: `/pricing`. Plans and prices.',
].join('\n');

/** A pull as `studio:design-pull` answers it, with only the fields these decisions read. */
function pull(options: { tokens?: number; pages?: string[]; components?: string[] }) {
  return {
    tokenCount: options.tokens ?? 0,
    design: {
      components: [
        ...(options.components ?? []).map((name, index) => ({ id: `c${index}`, name, page: '', screen: false })),
        ...(options.pages ?? []).map((name, index) => ({ id: `p${index}`, name, page: name, screen: true })),
      ],
    },
  };
}

describe('did the foundation land', () => {
  it('says no for a blank document, even though every page counts as a component', () => {
    // The old check asked for "no tokens and no components", and could never fire: `componentsFrom` reports every
    // page as a component, so a fresh document was already non-empty and the box ticked for nothing.
    expect(foundationLanded(pull({ pages: ['Page 1'] }))).toBe(false);
    expect(foundationLanded(pull({}))).toBe(false);
  });

  it('says yes for a token, or for a component that is not a page', () => {
    expect(foundationLanded(pull({ tokens: 3, pages: ['Page 1'] }))).toBe(true);
    expect(foundationLanded(pull({ components: ['Button'], pages: ['Page 1'] }))).toBe(true);
  });
});

describe('what is left to draw', () => {
  it('reads the remaining screens from the pull, not from a list taken earlier', () => {
    expect(remainingScreens(PAGES, pull({})).map((row) => row.name))
      .toEqual(['/ — Marketing home (sharpsite.ng)', '/pricing — Pricing page /pricing']);

    const one = remainingScreens(PAGES, pull({ pages: ['Pricing page'] }));
    expect(one.map((row) => row.name)).toEqual(['/ — Marketing home (sharpsite.ng)']);

    expect(remainingScreens(PAGES, pull({ pages: ['Marketing home', 'Pricing page'] }))).toEqual([]);
  });

  it('matches a section heading against the name a model would actually give the page', () => {
    // `## /pricing — Pricing page /pricing` names the route twice and the screen once. A model told to create "one
    // page named as above" reasonably calls it "Pricing page", and comparing raw text left that row to draw forever.
    expect(screenLanded('/pricing — Pricing page /pricing', pull({ pages: ['Pricing page'] }))).toBe(true);
    expect(screenLanded('/ — Marketing home (sharpsite.ng)', pull({ pages: ['Marketing home'] }))).toBe(true);
    expect(screenLanded('/pricing — Pricing page /pricing', pull({ pages: ['Dashboard'] }))).toBe(false);
  });

  it('lists a page that only exists in open-pencil as drawn, without asking for it', () => {
    const rows = rowsFromPull(PAGES, pull({ pages: ['Pricing page', 'A page nobody planned'] }));
    expect(rows.find((row) => row.name === 'A page nobody planned')).toMatchObject({ inPages: false, drawn: true });
    expect(rows.filter((row) => row.inPages && !row.drawn)).toHaveLength(1);
  });

  it('handles a project with no pages list yet without inventing screens', () => {
    expect(remainingScreens(null, pull({ pages: ['Something'] }))).toEqual([]);
  });
});

describe('the name two sides are compared by', () => {
  it('drops the route, the dash prefix and any parenthesised aside', () => {
    expect(screenTitleKey('/pricing — Pricing page /pricing')).toBe('pricing page');
    expect(screenTitleKey('/ — Marketing home (sharpsite.ng)')).toBe('marketing home');
    expect(screenTitleKey('Dashboard')).toBe('dashboard');
    expect(screenTitleKey('  Sign-up  ')).toBe('sign up');
  });

  it('leaves a plain heading alone, so two genuinely different screens stay different', () => {
    expect(screenTitleKey('Dashboard')).not.toBe(screenTitleKey('Dashboard admin'));
  });

  it('counts a drawn page as the plan entry whose subtitle it left off, unless the stem is ambiguous', () => {
    const pages = [
      { name: 'Act-mode proposal — desktop automation step list', route: '', details: '' },
      { name: 'Settings — providers and keys (/)', route: '', details: '' },
      { name: 'Settings — appearance and layout (/)', route: '', details: '' },
    ];
    const rows = screenRows(pages, ['Act-mode proposal (/)', 'Settings (/)']);
    expect(rows.filter((row) => !row.inPages).map((row) => row.name)).toEqual(['Settings (/)']);
    expect(rows[0]!.drawn).toBe(true);
    expect(rows[1]!.drawn).toBe(false);
  });
});

describe('what a redraw asks for', () => {
  it('names every screen in the pages list, drawn or not — the drawn ones are the point', () => {
    expect(screensToRedraw(PAGES, pull({ pages: ['Marketing home', 'Pricing page'] })).map((row) => row.name))
      .toEqual(['/ — Marketing home (sharpsite.ng)', '/pricing — Pricing page /pricing']);
  });

  it('asks for one screen by a name the pull might spell differently', () => {
    expect(screensToRedraw(PAGES, pull({ pages: ['Pricing page'] }), '/pricing — Pricing page /pricing').map((row) => row.name))
      .toEqual(['/pricing — Pricing page /pricing']);
    expect(screensToRedraw(PAGES, pull({ pages: ['Sign-in'] }), 'Sign-in')).toEqual([]);
  });

  it('leaves out a page that only exists in open-pencil, so a redraw cannot delete work nobody planned', () => {
    const rows = screensToRedraw(PAGES, pull({ pages: ['A page nobody planned'] }));
    expect(rows.map((row) => row.name)).not.toContain('A page nobody planned');
  });

  it('reports the pages open-pencil holds, for a failure that shows the name that did not match', () => {
    expect(drawnPageNames(pull({ pages: ['Sign-in', 'Dashboard'] }))).toEqual(['Sign-in', 'Dashboard']);
  });
});

describe('the drawing prompt', () => {
  const context: DesignContext = { projectName: 'Sharp Site', goal: 'a marketing site', hasTokens: false, hasStyleGuide: false, hasStyleReference: false, references: [] };
  const row = (over: Partial<ScreenRow>): ScreenRow => ({ name: 'Sign-in', route: '/sign-in', details: '', inPages: true, drawn: false, ...over });

  it('tells a first draw to reuse an existing page rather than make a duplicate', () => {
    // The reported failure: a turn that found the page already there, decided there was nothing to do, and ended —
    // while Studio, which matches by name, saw no page for the screen and stopped the build.
    const first = buildPagePrompt(row({}), context);
    expect(first).toContain('Create one page named exactly as above');
    expect(first).toMatch(/do not add a second page/i);
    expect(first).toContain('Studio matches by name');
    expect(first).toContain('rename_node');
  });

  it('tells a redraw to keep one page and refill it, never to create a second', () => {
    const redraw = buildPagePrompt(row({ name: '/terms — Terms and privacy', route: '/terms', drawn: true }), context, 'redraw');
    expect(redraw).toContain('already exists');
    expect(redraw).not.toContain('Create one page named exactly as above');
    expect(redraw).toContain('delete_node');
  });

  it('tells a clean to delete what stands for the screen, and only that screen', () => {
    // The escape hatch: a page Studio can never match — a duplicate, a half-drawn leftover, a wrong name — has to be
    // removable, or the screen is stuck undrawn forever.
    const clean = buildPagePrompt(row({ name: '/terms — Terms and privacy', route: '/terms' }), context, 'clean');
    expect(clean).toContain('delete_node');
    expect(clean).toMatch(/delete nothing that belongs to another screen/i);
    expect(clean).toMatch(/create one page named exactly as above/i);
  });
});

describe('renaming one screen in the pages list', () => {
  it('replaces only the matching heading, leaving the other heading and every body alone', () => {
    const result = renamePageHeading(PAGES, screenTitleKey('/pricing — Pricing page /pricing'), 'Prices');

    expect(result.renamed).toBe(true);
    expect(result.markdown).toContain('## Prices');
    expect(result.markdown).not.toContain('Pricing page');
    // The other screen is untouched, heading and body — the splice is a line edit, not a rewrite.
    expect(result.markdown).toContain('## / — Marketing home (sharpsite.ng)');
    expect(result.markdown).toContain('Route: `/`. The landing page.');
  });

  it('matches the heading the loose way, so a route, a dash or emphasis still finds it', () => {
    // The heading a rename is asked for comes from the checklist row, which matched the heading by `screenTitleKey`.
    // A strict text match here would find a heading the checklist had just shown, and refuse to rename it.
    const withEmphasis = '## `/pricing` — **Pricing page** /pricing\nRoute: `/pricing`.';
    expect(renamePageHeading(withEmphasis, screenTitleKey('Pricing page'), 'Prices').renamed).toBe(true);
  });

  it('leaves the text exactly as it was when no heading matches, and says so', () => {
    const result = renamePageHeading(PAGES, screenTitleKey('Nowhere'), 'Elsewhere');
    expect(result.renamed).toBe(false);
    expect(result.markdown).toBe(PAGES);
  });

  it('never treats a ### as a screen, the same as the parser', () => {
    const text = '## Settings\n### States\nEmpty, error.';
    const result = renamePageHeading(text, screenTitleKey('States'), 'Shapes');
    expect(result.renamed).toBe(false);
    expect(result.markdown).toBe(text);
  });

  it('keeps the route a heading led with, does not double a route, and caps the name at 80', () => {
    expect(renamedPageName('/pricing — Pricing page /pricing', 'Prices')).toBe('/pricing — Prices');
    expect(renamedPageName('Pricing page', 'Prices')).toBe('Prices');
    // A name that already leads with a route is the whole heading; it is given no second prefix.
    expect(renamedPageName('/pricing — Pricing page', '/pricing — Prices')).toBe('/pricing — Prices');
    expect(renamedPageName('Page', 'x'.repeat(120))).toHaveLength(80);
  });

  it('round-trips: the renamed file parses to the new name, with the route still read from the body', () => {
    const next = renamedPageName('/pricing — Pricing page /pricing', 'Prices');
    const result = renamePageHeading(PAGES, screenTitleKey('/pricing — Pricing page /pricing'), next);
    const parsed = parsePages(result.markdown);

    expect(parsed.map((page) => page.name)).toEqual(['/ — Marketing home (sharpsite.ng)', '/pricing — Prices']);
    expect(parsed[1]!.route).toBe('/pricing');
  });
});

describe('the page a checklist row stands for', () => {
  it('resolves the open-pencil id by the loose name, and null when only the pages list has it', () => {
    const design = pull({ pages: ['Pricing page'] }).design as unknown as StudioDesign;
    // The row's name carries a route and a dash the page's does not; the loose key is what resolves it.
    expect(screenPageId(design, '/pricing — Pricing page /pricing')).toBe('p0');
    expect(screenPageId(design, 'Sign in')).toBeNull();
    expect(screenPageId(null, 'Pricing page')).toBeNull();
  });
});

describe('routes the plan gives each screen', () => {
  const PLAN = [
    '## Tray menu',
    '- **Route:** OS tray icon registered in `src/main/main.js`.',
    '## Open app confirmation',
    '- **Route:** modal raised from `src/renderer/ui/steps.js` for `openApp` / `openUrl`.',
    '## Sidebar list',
    '- **Route:** the aside column inside `/`, module `src/renderer/ui/shell.js`.',
    '## Pricing page',
    '- **Route:** `/pricing`',
    '## No route line',
    'Just text.',
  ].join('\n');

  it('reads a named path, and calls a screen routeless only when its line names none', () => {
    const { routes, routeless } = screenRoutesFromPages(PLAN);
    expect(Object.fromEntries(routes)).toEqual({ 'sidebar list': '/', 'pricing page': '/pricing' });
    expect([...routeless].sort()).toEqual(['open app confirmation', 'tray menu']);
  });

  it('gives a routeless card the plan route, or makes a page with none a component, and leaves the rest alone', () => {
    const card = (title: string, over: Record<string, unknown> = {}) => ({ id: title, title, kind: 'page', route: '', status: 'ready', ...over }) as never;
    const out = withPlanRoutes([card('Tray menu'), card('Sidebar list'), card('Pricing page', { route: '/custom' }), card('Done tray', { status: 'done' }), card('Elsewhere')], PLAN);
    expect(out.map((c) => [c.kind, c.route])).toEqual([['component', ''], ['page', '/'], ['page', '/custom'], ['page', ''], ['page', '']]);
  });
});
