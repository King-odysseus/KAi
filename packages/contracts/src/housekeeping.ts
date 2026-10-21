import { findScreen, isNonScreenName, parsePages } from './pages';

/**
 * What is untidy about a board, read from the board, the plan and the design alone. Nothing here changes a card: it is
 * the list a person works down, so a card named "ZZ probe" or one drawn in a design that no longer exists is found by
 * looking, not by scrolling a hundred and fifty cards.
 */

export interface HousekeepingCard {
  id: string;
  title: string;
  kind: string;
  status: string;
  route: string;
  designRef: string | null;
  stale: boolean;
}

export type HousekeepingCode = 'junk' | 'not-a-screen' | 'no-plan-entry' | 'dead-design-link' | 'no-route' | 'stale';

export interface HousekeepingFinding {
  code: HousekeepingCode;
  heading: string;
  hint: string;
  cards: Array<{ id: string; title: string }>;
}

const JUNK = /^(zz|tmp|temp|test|probe|scratch|untitled|lorem)\b/i;

const COPY: Record<HousekeepingCode, { heading: string; hint: string }> = {
  junk: { heading: 'Looks like a leftover', hint: 'The name reads like a test or placeholder. Delete the card if it is one.' },
  'not-a-screen': { heading: 'Not a screen', hint: 'A component sheet or scratch page. It cannot be built or checked as a screen, so delete the card or leave it.' },
  'no-plan-entry': { heading: 'Not in the pages plan', hint: 'No screen in the pages list matches this card. Add the screen to the plan, link it in the Studio chat, or remove the card.' },
  'dead-design-link': { heading: 'Drawn in a design that is gone', hint: 'The open-pencil node this card was drawn from is not in the current design. Draw the screen again or pull the design.' },
  'no-route': { heading: 'A screen with no route', hint: 'Its check has no address to open. Set the route on the card, or turn it into a component if it is a dialog or popover.' },
  stale: { heading: 'Waiting to be redone', hint: 'Its design changed since it was built. Autopilot will rebuild it; nothing to do unless it should not be.' },
};

export function boardHousekeeping(
  cards: readonly HousekeepingCard[],
  pagesMarkdown: string,
  designNodeIds: readonly string[] | null,
): HousekeepingFinding[] {
  const plan = parsePages(pagesMarkdown);
  const nodes = designNodeIds ? new Set(designNodeIds) : null;
  const found = new Map<HousekeepingCode, Array<{ id: string; title: string }>>();
  const add = (code: HousekeepingCode, card: HousekeepingCard): void => {
    const list = found.get(code) ?? [];
    list.push({ id: card.id, title: card.title });
    found.set(code, list);
  };
  for (const card of cards) {
    if (JUNK.test(card.title.trim())) { add('junk', card); continue; }
    if (isNonScreenName(card.title)) { add('not-a-screen', card); continue; }
    const isPage = card.kind === 'page';
    if (isPage && card.status !== 'done' && plan.length > 0 && !findScreen(plan, (entry) => entry.name, card.title)) add('no-plan-entry', card);
    if (nodes && card.designRef && !nodes.has(card.designRef)) add('dead-design-link', card);
    if (isPage && card.status !== 'done' && !card.route.trim()) add('no-route', card);
    if (card.stale && card.status !== 'done') add('stale', card);
  }
  const order: HousekeepingCode[] = ['junk', 'not-a-screen', 'dead-design-link', 'no-plan-entry', 'no-route', 'stale'];
  return order.flatMap((code) => {
    const list = found.get(code);
    return list && list.length > 0 ? [{ code, ...COPY[code], cards: list }] : [];
  });
}
