import { describe, expect, it } from 'vitest';
import { buildFoundationPrompt, buildPagePrompt, filterScreens, parseFlows, parsePages, screenRows, stepKind } from '../apps/desktop/src/renderer/src/flow-diagram';

const FLOWS = `# Flows

## Sign in
1. Employee opens the Sign-in page (/sign-in)
2. Employee submits their company email
3. POST /api/sessions checks the address
4. Is the email on the company domain?
5. Dashboard (/dashboard) opens
   - shows recent chats

## Export a document
- Employee asks for a report in chat
- The assistant answers
- Employee presses Download .docx
`;

const CONTEXT = { projectName: 'ZuriAI', goal: 'An internal AI chat workspace.', hasTokens: true, hasStyleGuide: true, references: ['mood.png'] };

describe('flow diagram parsing', () => {
  it('reads one journey per heading, with one step per top-level list item', () => {
    const journeys = parseFlows(FLOWS);
    expect(journeys.map((journey) => journey.title)).toEqual(['Sign in', 'Export a document']);
    expect(journeys[0]?.steps).toHaveLength(5);
    expect(journeys[1]?.steps.map((step) => step.text)).toEqual(['Employee asks for a report in chat', 'The assistant answers', 'Employee presses Download .docx']);
  });

  it('classifies screens, endpoints and decisions, and ignores sub-bullets', () => {
    const [signIn] = parseFlows(FLOWS);
    expect(signIn?.steps.map((step) => step.kind)).toEqual(['screen', 'step', 'api', 'decision', 'screen']);
    expect(stepKind('If the card is declined, show an error')).toBe('decision');
    expect(signIn?.steps.some((step) => step.text.includes('recent chats'))).toBe(false);
  });

  it('puts steps that have no heading into one journey, and returns none for prose', () => {
    expect(parseFlows('1. Open the app\n2. Sign in')).toEqual([{ title: 'Flow', steps: [{ text: 'Open the app', kind: 'step' }, { text: 'Sign in', kind: 'step' }] }]);
    expect(parseFlows('Just a paragraph with no list.')).toEqual([]);
  });
});

describe('pages and the drawing prompts', () => {
  const PAGES = '# Pages\n\n## Sign-in\nRoute: `/sign-in`. For logging in. States: empty, error.\n\n## Dashboard\nAt /dashboard, shows chats.\n\n## Settings\nNo route yet.';

  it('lists the screens with the first route and the section text each one mentions', () => {
    const pages = parsePages(PAGES);
    expect(pages.map((page) => [page.name, page.route])).toEqual([['Sign-in', '/sign-in'], ['Dashboard', '/dashboard'], ['Settings', '']]);
    expect(pages[0]?.details).toContain('States: empty, error.');
  });

  it('merges the screens from the pages list with those only in open-pencil, and marks what is drawn', () => {
    const rows = screenRows(parsePages(PAGES), ['dashboard', 'Admin console']);
    expect(rows.map((row) => [row.name, row.inPages, row.drawn])).toEqual([
      ['Sign-in', true, false],
      ['Dashboard', true, true],
      ['Settings', true, false],
      ['Admin console', false, true],
    ]);
  });

  it('searches by name, route and description', () => {
    const rows = screenRows(parsePages(PAGES), []);
    expect(filterScreens(rows, 'dash').map((row) => row.name)).toEqual(['Dashboard']);
    expect(filterScreens(rows, '/sign-in').map((row) => row.name)).toEqual(['Sign-in']);
    expect(filterScreens(rows, 'logging').map((row) => row.name)).toEqual(['Sign-in']);
    expect(filterScreens(rows, '  ')).toHaveLength(3);
    expect(filterScreens(rows, 'nothing here')).toEqual([]);
  });

  it('keeps the foundation prompt to variables and shared components, with no screens', () => {
    const prompt = buildFoundationPrompt(CONTEXT);
    expect(prompt).toContain('Do not draw any screens yet');
    expect(prompt).toContain('tokens.json');
    expect(prompt).toContain('design/references/ (mood.png)');
    expect(prompt).toContain('Do not retry it in a loop');
    expect(prompt.length).toBeLessThan(2_500);
  });

  it('writes one small prompt per screen that forbids touching anything else', () => {
    const [signIn] = parsePages(PAGES);
    const prompt = buildPagePrompt(signIn!, CONTEXT);
    expect(prompt).toContain('draw one screen for "ZuriAI": Sign-in (/sign-in)');
    expect(prompt).toContain('States: empty, error.');
    expect(prompt).toContain('Do not change any other page');
    expect(prompt).not.toContain('Dashboard');
    expect(prompt).not.toMatch(/\n{3,}/);
    expect(prompt.length).toBeLessThan(3_000);
  });

  it('does not mention files that are not there', () => {
    const prompt = buildFoundationPrompt({ projectName: 'X', goal: 'Y', hasTokens: false, hasStyleGuide: false, references: [] });
    expect(prompt).not.toContain('tokens.json');
    expect(prompt).not.toContain('references');
  });
});
