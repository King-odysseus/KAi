import { describe, expect, it } from 'vitest';
import { buildFlowGraph, buildFoundationPrompt, buildPagePrompt, filterScreens, parseFlows, parsePages, screenRows, splitDecision, stepKind } from '../apps/desktop/src/renderer/src/flow-diagram';
import { FLOW_NODE_WIDTH, layoutFlowGraph, nodeSize } from '../apps/desktop/src/renderer/src/flow-layout';

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

  it('drops the full stop or comma that follows a route at the end of a sentence', () => {
    const pages = parsePages(['## Dashboard', 'At /dashboard.', '', '## Settings', 'Open /settings, then save.', '', '## Item', 'Shown at /items/:id.'].join('\n'));
    expect(pages.map((page) => page.route)).toEqual(['/dashboard', '/settings', '/items/:id']);
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

const SIGN_IN = [
  '## Sign in',
  '1. Employee opens the sign-in page (/sign-in).',
  '2. Employee submits email and password to POST /api/auth/sign-in.',
  '3. If the address is outside the approved company domain? It is rejected with a visible error before any password check.',
  '4. Otherwise lib/auth/password.ts verifies the argon2id hash.',
  '5. If the email is unknown or the password is wrong? The same generic failure message is returned and no cookie is set at all.',
  '6. Otherwise one httpOnly session cookie is set.',
  '7. Employee lands in the chat workspace (/).',
  '8. Is the session still valid?',
  '9. The handler loads the sessions row.',
  '',
].join('\n');

describe('flow graph', () => {
  const graph = buildFlowGraph(parseFlows(SIGN_IN)[0]!);
  const byId = (id: string) => graph.nodes.find((node) => node.id === id)!;
  const edgesFrom = (id: string) => graph.edges.filter((edge) => edge.source === id);

  it('keeps all of a long step, not a cut-off start of it', () => {
    const step = parseFlows(SIGN_IN)[0]!.steps[4]!;
    expect(step.text.endsWith('no cookie is set at all.')).toBe(true);
  });

  it('splits a question into the decision and what happens on yes', () => {
    expect(splitDecision('If the address is outside the domain? It is rejected.')).toEqual({ condition: 'If the address is outside the domain?', outcome: 'It is rejected.' });
    expect(splitDecision('If the card is declined, show an error')).toEqual({ condition: 'If the card is declined', outcome: 'show an error' });
    expect(splitDecision('Is the session still valid?')).toEqual({ condition: 'Is the session still valid?', outcome: '' });
    expect(splitDecision('Check the cookie \u2192 redirect to /sign-in')).toEqual({ condition: 'Check the cookie', outcome: 'redirect to /sign-in' });
  });

  it('branches a decision: yes goes to its outcome, otherwise carries the main path on', () => {
    expect(byId('s2').kind).toBe('decision');
    expect(edgesFrom('s2').map((edge) => [edge.target, edge.label])).toEqual([['s2o', 'yes'], ['s3', 'otherwise']]);
    expect(byId('s2o').kind).toBe('outcome');
    expect(byId('s3').text).toBe('lib/auth/password.ts verifies the argon2id hash.');
    expect(edgesFrom('s2o')).toEqual([]);
  });

  it('continues from a decision on no when no otherwise follows, and on yes when it states no outcome', () => {
    expect(edgesFrom('s7').map((edge) => [edge.target, edge.label])).toEqual([['s8', 'yes']]);
    const bare = buildFlowGraph({ title: 'T', steps: [{ text: 'If it fails? Show an error.', kind: 'decision' }, { text: 'Show the page', kind: 'step' }] });
    expect(bare.edges.filter((edge) => edge.source === 's0').map((edge) => [edge.target, edge.label])).toEqual([['s0o', 'yes'], ['s1', 'no']]);
  });

  it('chains every other step on, connects everything, and lists the steps in reading order', () => {
    expect(graph.edges.find((edge) => edge.target === 's1')).toMatchObject({ source: 's0' });
    const reachable = new Set(['title']);
    for (let pass = 0; pass < graph.nodes.length; pass += 1) for (const edge of graph.edges) if (reachable.has(edge.source)) reachable.add(edge.target);
    expect(reachable.size).toBe(graph.nodes.length);
    expect(graph.order[0]).toBe('s0');
    expect(graph.order).toHaveLength(graph.nodes.length - 1);
  });
});

describe('flow layout', () => {
  const graph = buildFlowGraph(parseFlows(SIGN_IN)[0]!);

  it('gives every box its own space with no two boxes overlapping', () => {
    for (const direction of ['LR', 'TB'] as const) {
      const boxes = [...layoutFlowGraph(graph, direction).values()];
      expect(boxes).toHaveLength(graph.nodes.length);
      for (let first = 0; first < boxes.length; first += 1) {
        for (let second = first + 1; second < boxes.length; second += 1) {
          const a = boxes[first]!;
          const b = boxes[second]!;
          const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it('flows left to right, with every line going forward, so lines do not double back', () => {
    const boxes = layoutFlowGraph(graph, 'LR');
    for (const edge of graph.edges) expect(boxes.get(edge.source)!.x).toBeLessThan(boxes.get(edge.target)!.x);
  });

  it('puts a decision and its two outcomes in different places, and flows top to bottom on request', () => {
    const boxes = layoutFlowGraph(graph, 'LR');
    expect(boxes.get('s2o')!.y).not.toBe(boxes.get('s3')!.y);
    const vertical = layoutFlowGraph(graph, 'TB');
    for (const edge of graph.edges) expect(vertical.get(edge.source)!.y).toBeLessThan(vertical.get(edge.target)!.y);
  });

  it('sizes a box by how much it says, up to four lines', () => {
    expect(nodeSize({ id: 'a', text: 'Short', kind: 'step' }).height).toBeLessThan(nodeSize({ id: 'b', text: 'x'.repeat(400), kind: 'step' }).height);
    expect(nodeSize({ id: 'c', text: 'x'.repeat(2_000), kind: 'step' }).height).toBe(nodeSize({ id: 'd', text: 'x'.repeat(130), kind: 'step' }).height);
    expect(nodeSize({ id: 'e', text: 'x', kind: 'step' }).width).toBe(FLOW_NODE_WIDTH);
  });
});
