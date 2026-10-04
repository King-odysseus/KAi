import { describe, expect, it } from 'vitest';
import { foundationLanded, remainingScreens, rowsFromPull, screenLanded } from '../apps/desktop/src/renderer/src/design-build';
import { screenTitleKey } from '../apps/desktop/src/renderer/src/flow-diagram';

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
});
