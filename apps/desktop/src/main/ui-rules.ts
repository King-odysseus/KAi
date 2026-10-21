import { UI_CHECK_VIEWPORTS, type BoardCard } from '@kai/contracts';

/**
 * What an agent is told about building a screen and about driving the browser while it does.
 *
 * Two complaints produced these. Pages came back with a third of a large screen empty, and a phone layout that lost
 * its navigation as soon as the page scrolled. Neither was something the agent had been told to avoid: the brief
 * said what the card was and never how a screen should behave at different sizes. The numbers below come from the
 * same list the visual check uses, so the instructions and the check cannot drift apart.
 */

const PHONE = UI_CHECK_VIEWPORTS.find((viewport) => viewport.name === 'phone')!.width;
const DESKTOP = UI_CHECK_VIEWPORTS.find((viewport) => viewport.name === 'desktop')!.width;
const WIDE = UI_CHECK_VIEWPORTS.find((viewport) => viewport.name === 'wide')!.width;

/** Cards that draw something a person looks at, and so are judged on a screenshot. */
export function drawsScreen(card: Pick<BoardCard, 'kind'>): boolean {
  return card.kind === 'page' || card.kind === 'component' || card.kind === 'flow';
}

/** How a screen should behave at every size. Short enough to survive a trimmed brief. */
export const UI_BUILD_RULES: readonly string[] = [
  `BUILDING THE SCREEN (the visual check opens it at ${PHONE}px, ${DESKTOP}px and ${WIDE}px wide, in light and dark):`,
  '- The page template has <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">. Without it a phone shows a shrunken desktop page.',
  '- Build for the phone first, then widen. The app fills the window: html, body and the root are 100% wide with min-height 100dvh (dvh, not vh, so a phone address bar does not cut it off).',
  `- Full width: the header, top bar and every other bar span the whole window (width 100%, no max-width and no side margin on the bar itself), and the main area fills the rest of the window height. Put any max-width on the content inside the bar or the page, never on the bar or the app shell, so no bare strip is left beside a bar at ${WIDE}px.`,
  `- Large screens: never leave the content against the left edge with a dead strip on the right. Centre it in a max-width container (about 1200 to 1440px) with equal margins, or let the layout grow into a sidebar and a multi-column grid. ${WIDE}px is checked as well as ${DESKTOP}px.`,
  '- Phones: an app with two or more top-level destinations keeps its navigation on screen at all times. Use a bottom tab bar of 3 to 5 items, position fixed or sticky at the bottom with padding-bottom: env(safe-area-inset-bottom). Do not hide the navigation behind a hamburger. Below about 768px the desktop sidebar becomes that bar, and extra destinations go under a "More" item.',
  '- Scrolling: the content scrolls and the bar does not. The scrolling area has padding-bottom of at least the bar height plus the safe area, so the last item is never covered. Headers may be sticky. Nothing scrolls sideways at any width. Tap targets are at least 44px.',
];

/**
 * How to use the browser tools without opening a window per question.
 *
 * KAI runs one browser that every agent shares, so there is one window and each agent works in a tab of its own. Two
 * agents on the same tab move each other's page, so the rule is to open a tab first, and to close it afterwards so
 * tabs do not pile up. When the agent has a browser to itself, the first line says to use the blank tab it starts with.
 */
export const BROWSER_RULES: readonly string[] = [
  'USING THE BROWSER TOOLS:',
  '- Start with browser_tabs, action "list". If it shows tabs you did not open, other agents are using this browser: open your own with browser_tabs, action "new", and work only in it. Never navigate, resize or close a tab that is not yours. If it shows a single blank tab, use that one.',
  `- Stay in that one tab. Navigate it with browser_navigate and change its size with browser_resize (${PHONE}, 768, ${DESKTOP} and ${WIDE} wide) to look at each size. Do not open a second tab or window to compare sizes, do not open links in a new window, and do not start another browser.`,
  `- At ${PHONE}px wide, scroll to the bottom and confirm the navigation is still visible and the last item is not covered. At ${WIDE}px wide, confirm no large strip of the screen is empty.`,
  '- Before your first browser_resize, run browser_evaluate with the function () => [window.innerWidth, window.innerHeight] and note the two numbers. A resize fixes the page at that size and it stays there, so when you finish looking at sizes, call browser_resize again with the numbers you noted. That leaves the window filled instead of stuck at a phone width.',
  '- When you finish, close the tab you opened with browser_tabs, action "close". Do not call browser_close: the browser is shared and will refuse.',
];

/** The rules for one card, or nothing for a card that draws no screen. */
export function uiRulesFor(card: Pick<BoardCard, 'kind'>): string[] {
  return drawsScreen(card) ? [...UI_BUILD_RULES, '', ...BROWSER_RULES] : [];
}
