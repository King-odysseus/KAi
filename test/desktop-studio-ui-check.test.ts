import { describe, expect, it } from 'vitest';
import { boardCardSchema, type BoardCard } from '../packages/contracts/src';
import {
  DesktopUiCheck,
  evaluateUiChecks,
  failureSummary,
  joinUrl,
  parseProbe,
  uiCheckShots,
  uiShotName,
  type UiCheckPorts,
  type UiDomFacts,
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
    expect(shots).toEqual(['phone/light', 'phone/dark', 'desktop/light', 'desktop/dark']);
    expect(result.screenshots).toHaveLength(4);
    expect(result.screenshots[0]).toBe('board/sign-up-form/2026-09-28T12-00-00.000Z/phone-light.png');
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
    expect(uiCheckShots(card())).toHaveLength(4);
    expect(uiShotName({ name: 'phone' }, 'dark')).toBe('phone-dark.png');
  });

  it('reads the probe JSON out of whatever wrapper the server added', () => {
    const parsed = parseProbe(`Result:\n${JSON.stringify(facts())}\n`);
    expect(parsed.states).toContain('loading');
    expect(parsed.tabbables).toBe(6);
    expect(parseProbe('not json').tabbables).toBe(0);
  });
});
