import { describe, expect, it } from 'vitest';
import { UI_CHECK_VIEWPORTS, boardCardSchema, type BoardCard } from '../packages/contracts/src';
import { PART_PROMPT_LIMIT, boardCardPart, boardCardPrompt, fitBrief } from '../apps/desktop/src/main/board-brief';
import { BROWSER_RULES, UI_BUILD_RULES, drawsScreen, uiRulesFor } from '../apps/desktop/src/main/ui-rules';

const NOW = '2026-10-19T12:00:00.000Z';

function card(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({
    id: 'tasks-page',
    title: 'Tasks page',
    kind: 'page',
    story: 'A person sees their tasks.',
    acceptance: ['Tasks are listed.'],
    needsArtifacts: ['pages', 'tokens'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}

describe('the rules for building a screen', () => {
  it('say how a screen behaves on a phone and on a large monitor, with the sizes the check uses', () => {
    const text = UI_BUILD_RULES.join('\n');
    for (const viewport of UI_CHECK_VIEWPORTS) expect(text).toContain(`${viewport.width}px`);
    expect(text).toContain('viewport');
    expect(text).toContain('bottom tab bar');
    expect(text).toContain('hamburger');
    expect(text).toContain('safe-area-inset-bottom');
    expect(text).toContain('100dvh');
    expect(text).toMatch(/dead strip on the right/);
  });

  it('give each agent a tab of its own in a shared browser, and keep it to that one tab', () => {
    const text = BROWSER_RULES.join('\n');
    expect(text).toContain('browser_tabs, action "list"');
    expect(text).toMatch(/then open your own preview tab/);
    expect(text).toContain('action "new"');
    expect(text).toMatch(/Never navigate, resize or close a tab that is not yours/);
    expect(text).toContain('browser_resize');
    expect(text).toMatch(/Check sizes one at a time/);
  });

  it('keep the preview tab unresized and close temporary check tabs', () => {
    const text = BROWSER_RULES.join('\n');
    expect(text).toMatch(/Keep the preview tab unresized/);
    expect(text).toMatch(/close every temporary resized tab/);
    expect(text).toContain('Do not call browser_close');
    expect(text).toMatch(/Leave that preview tab available for the person to inspect/);
  });

  it('apply to cards that draw something, and to no others', () => {
    expect(drawsScreen({ kind: 'page' })).toBe(true);
    expect(drawsScreen({ kind: 'component' })).toBe(true);
    expect(drawsScreen({ kind: 'flow' })).toBe(true);
    expect(drawsScreen({ kind: 'backend' })).toBe(false);
    expect(drawsScreen({ kind: 'chore' })).toBe(false);
    expect(uiRulesFor({ kind: 'backend' })).toEqual([]);
    expect(uiRulesFor({ kind: 'page' }).length).toBeGreaterThan(UI_BUILD_RULES.length);
  });
});

describe('a card brief', () => {
  it('carries the screen and browser rules for a page, before the lines about when to stop', () => {
    const prompt = boardCardPrompt(card(), {});
    expect(prompt).toContain('BUILDING THE SCREEN');
    expect(prompt).toContain('USING THE BROWSER TOOLS');
    expect(prompt.indexOf('BUILDING THE SCREEN')).toBeLessThan(prompt.indexOf('WHEN YOU STOP'));
  });

  it('leaves them out of a card that draws no screen', () => {
    const prompt = boardCardPrompt(card({ kind: 'backend', needsArtifacts: ['stack'] }), {});
    expect(prompt).not.toContain('BUILDING THE SCREEN');
    expect(prompt).not.toContain('USING THE BROWSER TOOLS');
    expect(prompt).toContain('WHEN YOU STOP');
  });
});

describe('fitting a brief to a part', () => {
  const long = 'A long page inventory line that goes on. '.repeat(400);

  it('leaves a brief that already fits exactly as it was', () => {
    const artifacts = { pages: 'Short.', tokens: '{}' };
    expect(fitBrief(card(), artifacts)).toBe(boardCardPrompt(card(), artifacts));
  });

  it('shortens the artifact text, not the rules and the stop lines that come after it', () => {
    const artifacts = { pages: long, tokens: long };
    expect(boardCardPrompt(card(), artifacts).length).toBeGreaterThan(PART_PROMPT_LIMIT);

    const fitted = fitBrief(card(), artifacts);
    expect(fitted.length).toBeLessThanOrEqual(PART_PROMPT_LIMIT);
    expect(fitted).toContain('[shortened; the full text is in');
    expect(fitted).toContain('BUILDING THE SCREEN');
    expect(fitted).toContain('USING THE BROWSER TOOLS');
    expect(fitted).toContain('WHEN YOU STOP');
    expect(fitted).toContain('A passing check run against the current files decides that');
  });

  it('is what a plan part carries', () => {
    const part = boardCardPart(card(), { pages: long, tokens: long });
    expect(part.prompt.length).toBeLessThanOrEqual(PART_PROMPT_LIMIT);
    expect(part.prompt).toContain('WHEN YOU STOP');
  });

  it('still cuts a brief that cannot be made to fit by shortening artifacts', () => {
    const huge = card({ story: 'x'.repeat(4_000), prompt: 'y'.repeat(9_000) });
    expect(fitBrief(huge, {}).length).toBeLessThanOrEqual(PART_PROMPT_LIMIT);
  });
});
