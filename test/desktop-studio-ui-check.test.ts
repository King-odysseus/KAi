import { describe, expect, it } from 'vitest';
import { UI_CHECK_VIEWPORTS, boardCardSchema, type BoardCard } from '../packages/contracts/src';
import {
  DesktopUiCheck,
  evaluateLayoutChecks,
  evaluateUiChecks,
  failureSummary,
  joinUrl,
  parseLayout,
  parseProbe,
  uiCheckShots,
  uiShotName,
  type UiCheckPorts,
  type UiDomFacts,
  type UiLayoutFacts,
} from '../apps/desktop/src/main/ui-check';

const NOW = '2026-09-28T12:00:00.000Z';
const TOKENS = { '--color-bg': '#101014', '--color-text': '#f5f5f5' };

function card(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id: 'sign-up-form', title: 'Sign-up form', kind: 'component', createdAt: NOW, updatedAt: NOW, ...over });
}

function facts(over: Partial<UiDomFacts> = {}): UiDomFacts {
  return {
    route: '/sign-up',
    states: ['empty', 'loading', 'error', 'disabled'],
    tokens: { ...TOKENS },
    phoneScrollWidth: 390,
    phoneClientWidth: 390,
    tabbables: 6,
    landedRoute: '/sign-up',
    ...over,
  };
}

/** A page that passes every layout rule, so a test names only the one thing it changes. */
function layout(over: Partial<UiLayoutFacts> = {}): UiLayoutFacts {
  return {
    innerWidth: 390,
    innerHeight: 844,
    scrollWidth: 390,
    clientWidth: 390,
    hasViewportMeta: true,
    contentLeft: 16,
    contentRight: 368,
    headerLeft: null,
    headerRight: null,
    headerBacked: false,
    scrollable: true,
    navCount: 1,
    navVisibleAtTop: true,
    navVisibleAtBottom: true,
    fixedNavTop: 780,
    contentBottomAtScrollEnd: 732,
    ...over,
  };
}

describe('the visual report', () => {
  it('passes a screen that shows every state, matches the tokens, fits the phone and takes the keyboard', () => {
    const outcomes = evaluateUiChecks(card(), facts(), TOKENS, '/sign-up');
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
  });

  it('names the states a screen is missing rather than just failing it', () => {
    const outcomes = evaluateUiChecks(card(), facts({ states: ['empty'] }), TOKENS, '/sign-up');
    const states = outcomes.find((outcome) => outcome.id === 'states');
    expect(states?.passed).toBe(false);
    expect(states?.detail).toContain('loading');
    expect(states?.detail).toContain('disabled');
  });

  it('reports the token it expected against the one the page computed', () => {
    const outcomes = evaluateUiChecks(card(), facts({ tokens: { '--color-bg': '#ffffff', '--color-text': '#f5f5f5' } }), TOKENS, '/sign-up');
    const tokens = outcomes.find((outcome) => outcome.id === 'tokens');
    expect(tokens?.passed).toBe(false);
    expect(tokens?.detail).toContain('expected #101014, found #ffffff');
  });

  it('catches sideways scroll at phone width, with one pixel of tolerance', () => {
    expect(evaluateUiChecks(card(), facts({ phoneScrollWidth: 391 }), TOKENS, '/sign-up').find((outcome) => outcome.id === 'phone-no-scroll')?.passed).toBe(true);
    expect(evaluateUiChecks(card(), facts({ phoneScrollWidth: 402 }), TOKENS, '/sign-up').find((outcome) => outcome.id === 'phone-no-scroll')?.passed).toBe(false);
  });

  it('fails a screen the keyboard cannot reach, and one whose flow lands elsewhere', () => {
    expect(evaluateUiChecks(card(), facts({ tabbables: 0 }), TOKENS, '/sign-up').find((outcome) => outcome.id === 'keyboard')?.passed).toBe(false);
    const page = card({ kind: 'page' });
    const flow = evaluateUiChecks(page, facts({ landedRoute: '/sign-in' }), TOKENS, '/sign-up').find((outcome) => outcome.id === 'flow');
    expect(flow?.passed).toBe(false);
    expect(flow?.detail).toContain('/sign-in');
  });

  it('does not ask a backend card to follow a route', () => {
    const backend = card({ kind: 'backend' });
    expect(evaluateUiChecks(backend, facts(), TOKENS, '/sign-up').some((outcome) => outcome.id === 'flow')).toBe(false);
  });

  it('skips the token check when the design layer has not written tokens yet', () => {
    const outcomes = evaluateUiChecks(card(), facts({ tokens: {} }), null, '/sign-up');
    expect(outcomes.find((outcome) => outcome.id === 'tokens')?.passed).toBe(true);
  });

  it('summarises only the failures, so the agent is handed what to repair', () => {
    const outcomes = evaluateUiChecks(card(), facts({ states: ['empty'], tabbables: 0 }), TOKENS, '/sign-up');
    const summary = failureSummary({ cardId: 'sign-up-form', at: NOW, passed: false, route: '/sign-up', outcomes, screenshots: [] });
    expect(summary).toContain('Shows empty, loading, error and disabled states');
    expect(summary).toContain('Reachable with the keyboard');
    expect(summary).not.toContain('No sideways scroll');
  });
});

describe('the layout rules', () => {
  const outcome = (layouts: UiDomFacts['layouts'], id: string) => evaluateLayoutChecks(layouts).find((entry) => entry.id === id);

  it('fails a phone page that loses its navigation behind a menu, and one whose navigation scrolls away', () => {
    expect(outcome({ phone: layout({ navCount: 1, navVisibleAtTop: false, navVisibleAtBottom: false }) }, 'phone-nav')).toMatchObject({ passed: false });
    expect(outcome({ phone: layout({ navCount: 1, navVisibleAtTop: false, navVisibleAtBottom: false }) }, 'phone-nav')?.detail).toContain('bottom tab bar');
    const scrolls = outcome({ phone: layout({ navCount: 1, navVisibleAtTop: true, navVisibleAtBottom: false }) }, 'phone-nav');
    expect(scrolls?.passed).toBe(false);
    expect(scrolls?.detail).toContain('fixed or sticky');
  });

  it('passes a phone page whose navigation stays on screen, and one that has no navigation to lose', () => {
    expect(outcome({ phone: layout({ navCount: 1, navVisibleAtTop: true, navVisibleAtBottom: true }) }, 'phone-nav')?.passed).toBe(true);
    // A sign-in screen has no navigation. It is not failed for that.
    expect(outcome({ phone: layout({ navCount: 0, navVisibleAtTop: false, navVisibleAtBottom: false }) }, 'phone-nav')).toBeUndefined();
  });

  it('fails content that ends under a fixed bottom bar, and passes content that clears it', () => {
    const covered = outcome({ phone: layout({ fixedNavTop: 780, contentBottomAtScrollEnd: 812 }) }, 'phone-content-clear');
    expect(covered?.passed).toBe(false);
    expect(covered?.detail).toContain('padding-bottom');
    expect(outcome({ phone: layout({ fixedNavTop: 780, contentBottomAtScrollEnd: 732 }) }, 'phone-content-clear')?.passed).toBe(true);
    // No fixed bar, nothing to be covered by.
    expect(outcome({ phone: layout({ fixedNavTop: null, contentBottomAtScrollEnd: 812 }) }, 'phone-content-clear')).toBeUndefined();
  });

  it('fails a page with no viewport meta, because a phone then shows a shrunken desktop page', () => {
    expect(outcome({ phone: layout({ hasViewportMeta: false }) }, 'viewport-meta')?.passed).toBe(false);
    expect(outcome({ phone: layout({ hasViewportMeta: true }) }, 'viewport-meta')?.passed).toBe(true);
  });

  it('fails content pinned to the left of a large screen, and passes a centred column or one that fills the width', () => {
    // The numbers are what a real 1920px page measured: a 640px column against the left edge.
    const pinned = outcome({ wide: layout({ innerWidth: 1920, contentLeft: 0, contentRight: 672 }) }, 'wide-fills');
    expect(pinned?.passed).toBe(false);
    expect(pinned?.detail).toContain('1248px empty on the right');
    // A 1200px column centred on a 1920px screen.
    expect(outcome({ wide: layout({ innerWidth: 1920, contentLeft: 344, contentRight: 1576 }) }, 'wide-fills')?.passed).toBe(true);
    // A sidebar and a main area that runs to the edge.
    expect(outcome({ wide: layout({ innerWidth: 1920, contentLeft: 272, contentRight: 1920 }) }, 'wide-fills')?.passed).toBe(true);
    // A narrow centred sign-in card: wide gaps, but equal ones.
    expect(outcome({ wide: layout({ innerWidth: 1920, contentLeft: 780, contentRight: 1140 }) }, 'wide-fills')?.passed).toBe(true);
  });

  it('fails a top bar that stops short of the window and passes one that spans it', () => {
    const top = (over: Partial<UiLayoutFacts>) => outcome({ wide: layout({ innerWidth: 1920, ...over }) }, 'wide-header-spans');
    const short = top({ headerLeft: 272, headerRight: 1500 });
    expect(short?.passed).toBe(false);
    expect(short?.detail).toContain('full width');
    expect(top({ headerLeft: 0, headerRight: 1920 })?.passed).toBe(true);
    // A narrow header box sitting on a full-width painted bar reads as full width.
    expect(top({ headerLeft: 272, headerRight: 1648, headerBacked: true })?.passed).toBe(true);
    // No top bar, no judgement.
    expect(top({})).toBeUndefined();
  });

  it('makes no layout judgement when nothing was measured', () => {
    expect(evaluateLayoutChecks(undefined)).toEqual([]);
    expect(evaluateLayoutChecks({})).toEqual([]);
    expect(evaluateLayoutChecks({ wide: layout({ contentLeft: null, contentRight: null }) })).toEqual([]);
  });
});

describe('the visual check run', () => {
  it('captures every width and theme, saves them with the card, and passes the result through', async () => {
    const shots: string[] = [];
    const ports: UiCheckPorts = {
      previewUrl: async () => 'http://localhost:5173',
      capture: async ({ viewport, theme }) => {
        shots.push(`${viewport.name}/${theme}`);
        return 'ZmFrZQ==';
      },
      probe: async () => facts(),
      tokens: async () => TOKENS,
      writeShot: async (_root, relativePath) => relativePath,
      now: () => NOW,
    };
    const result = await new DesktopUiCheck(ports).run('p1', 'C:/project', card(), '/sign-up');
    expect(result.passed).toBe(true);
    expect(shots).toEqual(['phone/light', 'phone/dark', 'desktop/light', 'desktop/dark', 'wide/light', 'wide/dark']);
    expect(result.screenshots).toHaveLength(6);
    expect(result.screenshots[0]).toBe('board/sign-up-form/2026-09-28T12-00-00.000Z/phone-light.png');
  });

  it('measures the phone and the wide screen at their own sizes, and reads the phone scroll from the phone', async () => {
    const measured: string[] = [];
    const ports: UiCheckPorts = {
      previewUrl: async () => 'http://localhost:5173',
      capture: async () => 'ZmFrZQ==',
      // The probe runs after the screenshots, at whatever size they left the browser. It reports a page that fits.
      probe: async () => facts({ phoneScrollWidth: 1280, phoneClientWidth: 1280 }),
      layout: async ({ viewport }) => {
        measured.push(viewport.name);
        return viewport.name === 'phone' ? layout({ scrollWidth: 520, clientWidth: 390 }) : layout({ innerWidth: 1920, contentLeft: 360, contentRight: 1560 });
      },
      tokens: async () => TOKENS,
      writeShot: async (_root, relativePath) => relativePath,
      now: () => NOW,
    };
    const result = await new DesktopUiCheck(ports).run('p1', 'C:/project', card(), '/sign-up');
    expect(measured).toEqual(['phone', 'wide']);
    // The page is wider than a phone, which the desktop-width reading of 1280 inside 1280 would have hidden.
    expect(result.passed).toBe(false);
    expect(result.outcomes.find((outcome) => outcome.id === 'phone-no-scroll')?.passed).toBe(false);
    expect(result.outcomes.find((outcome) => outcome.id === 'phone-no-scroll')?.detail).toContain('520px wide in a 390px viewport');
  });

  it('stays quiet about layout when the port cannot measure it', async () => {
    const ports: UiCheckPorts = {
      previewUrl: async () => 'http://localhost:5173',
      capture: async () => 'ZmFrZQ==',
      probe: async () => facts(),
      layout: async () => null,
      tokens: async () => TOKENS,
      writeShot: async (_root, relativePath) => relativePath,
      now: () => NOW,
    };
    const result = await new DesktopUiCheck(ports).run('p1', 'C:/project', card(), '/sign-up');
    expect(result.passed).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.id)).not.toContain('phone-nav');
    expect(result.outcomes.map((outcome) => outcome.id)).not.toContain('wide-fills');
  });

  it('refuses to pass a card when the dev server never printed a URL', async () => {
    const ports: UiCheckPorts = {
      previewUrl: async () => null,
      capture: async () => 'x',
      probe: async () => facts(),
      tokens: async () => null,
      writeShot: async (_root, relativePath) => relativePath,
      now: () => NOW,
    };
    await expect(new DesktopUiCheck(ports).run('p1', 'C:/project', card(), '/sign-up')).rejects.toThrow(/No dev server URL/);
  });
});

describe('ui check helpers', () => {
  it('joins a route onto the base without doubling or dropping the slash', () => {
    expect(joinUrl('http://localhost:5173/', '/sign-up')).toBe('http://localhost:5173/sign-up');
    expect(joinUrl('http://localhost:5173', 'sign-up')).toBe('http://localhost:5173/sign-up');
    expect(joinUrl('http://localhost:5173/', '')).toBe('http://localhost:5173');
  });

  it('asks for every viewport at every theme, and names the file after both', () => {
    expect(uiCheckShots(card())).toHaveLength(6);
    expect(uiShotName({ name: 'phone' }, 'dark')).toBe('phone-dark.png');
  });

  it('includes a screen wider than a laptop, and gives every size a height', () => {
    const names = UI_CHECK_VIEWPORTS.map((viewport) => viewport.name);
    expect(names).toContain('wide');
    expect(UI_CHECK_VIEWPORTS.find((viewport) => viewport.name === 'wide')?.width).toBeGreaterThanOrEqual(1920);
    expect(UI_CHECK_VIEWPORTS.every((viewport) => viewport.height > 0)).toBe(true);
  });

  it('reads the layout probe, and treats an unmeasured page as nothing rather than as a pass or a fail', () => {
    const parsed = parseLayout(`Result: ${JSON.stringify({ measured: true, innerWidth: 390, innerHeight: 844, scrollWidth: 390, clientWidth: 390, hasViewportMeta: true, contentLeft: 16, contentRight: 368, headerLeft: 0, headerRight: 390, headerBacked: true, scrollable: true, navCount: 1, navVisibleAtTop: true, navVisibleAtBottom: true, fixedNavTop: 780, contentBottomAtScrollEnd: 731.9 })}`);
    expect(parsed).toMatchObject({ innerWidth: 390, navCount: 1, fixedNavTop: 780, hasViewportMeta: true });
    expect(parseLayout(JSON.stringify({ measured: false, error: 'boom' }))).toBeNull();
    expect(parseLayout('not json')).toBeNull();
    expect(parseLayout('{ broken')).toBeNull();
  });

  it('reads the probe JSON out of whatever wrapper the server added', () => {
    const parsed = parseProbe(`Result:\n${JSON.stringify(facts())}\n`);
    expect(parsed.states).toContain('loading');
    expect(parsed.tabbables).toBe(6);
    expect(parseProbe('not json').tabbables).toBe(0);
  });
});
