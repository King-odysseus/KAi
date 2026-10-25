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
 * KAI runs one browser that every agent shares. A preview tab must stay unresized so it follows the actual window.
 * Viewport checks use a separate temporary tab, which is closed after the check. Two agents must never use the same tab.
 */
export const BROWSER_RULES: readonly string[] = [
  'USING THE BROWSER TOOLS:',
  '- Start with browser_tabs, action "list", then open your own preview tab with browser_tabs, action "new". Navigate the preview to the page. Never navigate, resize or close a tab that is not yours.',
  `- Keep the preview tab unresized so it follows the Chrome window and fills it when maximised. For each responsive check, open one temporary tab with browser_tabs, action "new", navigate it to the page, use browser_resize (${PHONE}, 768, ${DESKTOP} or ${WIDE} wide), inspect it, then close that temporary tab. Check sizes one at a time; do not start another browser or open another window.`,
  `- At ${PHONE}px wide, scroll to the bottom and confirm the navigation is still visible and the last item is not covered. At ${WIDE}px wide, confirm no large strip of the screen is empty.`,
  '- browser_resize fixes the page viewport at that size, not the Chrome window. Maximising Chrome will then leave empty space beside a narrow page. Never call browser_resize on the preview tab. If a temporary tab cannot be opened, stop rather than resize an existing tab.',
  '- When finished, close every temporary resized tab and select your unresized preview tab so the desktop page is visible at the window width. Leave that preview tab available for the person to inspect. Do not call browser_close: the browser is shared and will refuse.',
];

/** The rules for one card, or nothing for a card that draws no screen. */
export function uiRulesFor(card: Pick<BoardCard, 'kind'>): string[] {
  return drawsScreen(card) ? [...UI_BUILD_RULES, '', ...BROWSER_RULES] : [];
}
