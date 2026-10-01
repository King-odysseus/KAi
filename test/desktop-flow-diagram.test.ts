import { describe, expect, it } from 'vitest';
import { buildDesignPrompt, parseFlows, parsePages, stepKind } from '../apps/desktop/src/renderer/src/flow-diagram';

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

describe('pages and the design prompt', () => {
  it('lists the screens with the first route each section mentions', () => {
    const pages = parsePages('# Pages\n\n## Sign-in\nRoute: `/sign-in`. For logging in.\n\n## Dashboard\nAt /dashboard, shows chats.\n\n## Settings\nNo route yet.');
    expect(pages).toEqual([{ name: 'Sign-in', route: '/sign-in' }, { name: 'Dashboard', route: '/dashboard' }, { name: 'Settings', route: '' }]);
  });

  it('writes a prompt that names the files, the variables step and every screen', () => {
    const prompt = buildDesignPrompt({
      projectName: 'ZuriAI',
      goal: 'An internal AI chat workspace.',
      pages: [{ name: 'Sign-in', route: '/sign-in' }, { name: 'Dashboard', route: '' }],
      hasTokens: true,
      hasStyleGuide: true,
      references: ['mood.png'],
    });
    expect(prompt).toContain('open-pencil');
    expect(prompt).toContain('design/tokens.json');
    expect(prompt).toContain('design/references/ (mood.png)');
    expect(prompt).toContain('- Sign-in (/sign-in)');
    expect(prompt).toContain('- Dashboard');
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  it('does not mention files that are not there', () => {
    const prompt = buildDesignPrompt({ projectName: 'X', goal: 'Y', pages: [], hasTokens: false, hasStyleGuide: false, references: [] });
    expect(prompt).not.toContain('tokens.json');
    expect(prompt).not.toContain('references');
    expect(prompt).toContain('take them from pages.md');
  });
});
