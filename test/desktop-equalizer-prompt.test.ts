import { describe, expect, it } from 'vitest';
import { equalizerReportSchema, type EqualizerReport } from '../packages/contracts/src';
import { allDifferences, buildFixPrompt, differenceKey, reportSummary } from '../apps/desktop/src/renderer/src/equalizer-prompt';

const NONE = { reference: null, live: null, difference: null };

function report(over: Partial<EqualizerReport> = {}): EqualizerReport {
  return equalizerReportSchema.parse({
    id: '20261001120000',
    createdAt: '2026-10-01T12:00:00.000Z',
    target: 'dev',
    reference: 'open-pencil',
    round: 0,
    rounds: 3,
    liveUrl: null,
    referenceUrl: null,
    notes: [],
    reportPath: '.kai/spec/equalizer/20261001120000/report.md',
    screens: [
      {
        name: 'Dashboard',
        route: '/dashboard',
        status: 'differs',
        pixelDifference: 0.12,
        images: NONE,
        error: null,
        differences: [
          { id: 'low', severity: 'low', kind: 'position', message: 'Sidebar sits 4px off.', expected: '', actual: '' },
          { id: 'high', severity: 'high', kind: 'radius', message: 'Card corner radius is 12px in the design, 4px live.', expected: '12px', actual: '4px' },
        ],
      },
      { name: 'Sign-in', route: '/sign-in', status: 'match', pixelDifference: 0, images: NONE, error: null, differences: [] },
      { name: 'Settings', route: '/settings', status: 'error', pixelDifference: null, images: NONE, error: 'The page did not load.', differences: [] },
    ],
    ...over,
  });
}

describe('the Equalizer fix prompt', () => {
  it('lists only the chosen differences, worst first, under their screen and route', () => {
    const prompt = buildFixPrompt(report(), allDifferences(report()))!;
    expect(prompt).toContain('Dashboard (/dashboard)');
    expect(prompt.indexOf('[high] Card corner radius')).toBeLessThan(prompt.indexOf('[low] Sidebar'));
    expect(prompt).toContain('found 2 differences to fix');
    expect(prompt).not.toContain('Sign-in');
  });

  it('leaves out what the user unticked, and says nothing when nothing is chosen', () => {
    const chosen = new Set([differenceKey('Dashboard', 'high')]);
    const prompt = buildFixPrompt(report(), chosen)!;
    expect(prompt).toContain('found 1 difference to fix');
    expect(prompt).not.toContain('Sidebar sits');
    expect(buildFixPrompt(report(), new Set())).toBeNull();
  });

  it('keeps the design as the source of truth, points at the report, and limits the attempts', () => {
    const prompt = buildFixPrompt(report(), allDifferences(report()))!;
    expect(prompt).toContain('change the code to match it, never the design');
    expect(prompt).toContain('.kai/spec/equalizer/20261001120000/report.md');
    expect(prompt).toContain('up to 3 attempts');
    expect(prompt).toContain('the dev server');
  });

  it('counts the attempts that are left after earlier rounds, never below one', () => {
    expect(buildFixPrompt(report({ round: 2 }), allDifferences(report()))).toContain('up to 1 attempt.');
    expect(buildFixPrompt(report({ round: 3 }), allDifferences(report()))).toContain('up to 1 attempt.');
  });

  it('names the production site and the website being matched', () => {
    const prompt = buildFixPrompt(report({ target: 'production', reference: 'website', liveUrl: 'https://prod.example.test', referenceUrl: 'https://ref.example.test' }), allDifferences(report()))!;
    expect(prompt).toContain('the production site (https://prod.example.test)');
    expect(prompt).toContain('the reference website (https://ref.example.test)');
    expect(prompt).toContain('not the other way round');
  });

  it('asks for the missing screens to be drawn after a design-only run', () => {
    const designOnly = report({
      target: 'design',
      screens: [{ name: 'Settings', route: '/settings', status: 'not-drawn', pixelDifference: null, images: NONE, error: null, differences: [{ id: 'not-drawn', severity: 'high', kind: 'screen', message: 'Settings is not drawn in open-pencil yet.', expected: '', actual: '' }] }],
    });
    const prompt = buildFixPrompt(designOnly, allDifferences(designOnly))!;
    expect(prompt).toContain('finish the design');
    expect(prompt).toContain('Settings is not drawn');
    expect(prompt).toContain('do not retry it in a loop');
  });

  it('summarises a report in one line', () => {
    expect(reportSummary(report())).toBe('3 screens checked · 1 match · 2 differences · 1 could not be checked');
  });
});
