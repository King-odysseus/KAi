import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  createDefaultSettings,
  type StudioReadiness,
} from '../packages/contracts/src';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { DESIGN_TOOLS, type DesignPorts } from '../apps/desktop/src/main/design-source';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { DesktopStudio, parsePlanChatReply, type StudioPorts } from '../apps/desktop/src/main/studio';
import { hashFile } from '../apps/desktop/src/main/verification';

const NOW = '2026-10-18T12:00:00.000Z';
const READY: StudioReadiness = { ready: true, displayName: 'OpenAI', model: 'gpt-6-luna', reason: null };
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-studio-plan-chat-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeDesign(initialName: string): { ports: DesignPorts; renamed: string[]; current: () => string } {
  let name = initialName;
  const renamed: string[] = [];
  const reply = (value: unknown): Array<{ type: string; text: string }> => [{ type: 'text', text: JSON.stringify(value) }];
  return {
    renamed,
    current: () => name,
    ports: {
      endpoint: () => 'http://127.0.0.1:7600',
      async call(tool, input) {
        switch (tool) {
          case DESIGN_TOOLS.tokens:
            return reply({ output: JSON.stringify({ Light: { '--color-bg': '#ffffff' } }), tokenCount: 1 });
          case DESIGN_TOOLS.components:
            return reply({ components: [] });
          case DESIGN_TOOLS.pages:
            return reply({ pages: [{ id: 'p1', name }], current: name });
          case DESIGN_TOOLS.tree:
            return reply({ nodes: [{ id: 'frame-1', name: 'Frame', type: 'FRAME', children: [] }] });
          case DESIGN_TOOLS.switchPage:
            return reply({ ok: true });
          case DESIGN_TOOLS.renameNode:
            name = String((input as Record<string, unknown>).name);
            renamed.push(name);
            return reply({ ok: true });
          default:
            throw new Error(`unexpected open-pencil tool ${tool}`);
        }
      },
    },
  };
}

function makeStudio(replies: Record<string, string> = {}, over: Partial<StudioPorts> = {}) {
  const calls: string[] = [];
  const settings = createDefaultSettings();
  const artifacts = new StudioArtifacts({ spec: new SpecStore(), projectRoot: async () => root, now: () => NOW });
  const board = new StudioBoardStore({
    spec: new SpecStore(),
    projectRoot: async () => root,
    dirtyFiles: async () => [],
    hashFile: (projectRoot, relative) => hashFile(projectRoot, relative),
    run: async () => null,
    now: () => NOW,
  });
  const ports: StudioPorts = {
    settings: async () => ({ ...settings, promptGuide: { ...settings.promptGuide, enabled: true } }),
    projectRoot: async () => root,
    requester: {
      structuredRequest: (_c, _n, _p, schemaName, _s, parse) => {
        calls.push(schemaName);
        if (!(schemaName in replies)) return Promise.reject(new Error(`no canned reply for ${schemaName}`));
        return Promise.resolve(parse(replies[schemaName]!));
      },
    },
    interview: { readiness: async () => READY },
    artifacts,
    board,
    uiCheck: {
      check: async () => { throw new Error('not used'); },
    } as unknown as StudioPorts['uiCheck'],
    now: () => NOW,
    ...over,
  };
  return { studio: new DesktopStudio(ports), calls, artifacts, board, ports };
}

const content = (markdown: string): string => JSON.stringify({ content: markdown });

describe('selective artifact generation', () => {
  it('writes only the chosen artifacts and lets the design stand without stories', async () => {
    const { studio, calls, artifacts } = makeStudio({
      kai_studio_style_guide: content('# Style\n\nCalm.'),
      kai_studio_tokens: content('{"colors":{"bg":"#ffffff"}}'),
      kai_studio_pages: content('## Sign up\n\nRoute: /sign-up\n\nA form.'),
    });
    await studio.saveArtifact('p1', 'brief', '# Brief\n\nA quiet sign-up flow.');

    const result = await studio.generateSelected('p1', ['style-guide', 'tokens', 'pages']);

    expect(result.failed).toEqual([]);
    expect(result.wrote).toEqual(['style-guide', 'tokens', 'pages']);
    expect(calls).toEqual(['kai_studio_style_guide', 'kai_studio_tokens', 'kai_studio_pages']);
    const written = result.artifacts.artifacts.map((entry) => entry.kind);
    expect(written).toEqual(expect.arrayContaining(['brief', 'style-guide', 'tokens', 'pages']));
    expect(written).not.toContain('stories');
    expect(written).not.toContain('prd');
    // The pages prompt was built from the brief rather than refusing because stories and flows do not exist.
    expect(await artifacts.readText('p1', 'pages')).toContain('Sign up');
  });

  it('reports an artifact it could not write without discarding the ones it did', async () => {
    const { studio } = makeStudio({
      kai_studio_style_guide: content('# Style\n\nCalm.'),
      kai_studio_tokens: 'not json at all',
      kai_studio_pages: content('## Sign up\n\nRoute: /sign-up'),
    });
    await studio.saveArtifact('p1', 'brief', '# Brief\n\nA quiet sign-up flow.');

    const result = await studio.generateSelected('p1', ['style-guide', 'tokens', 'pages']);
    expect(result.wrote).toContain('style-guide');
    expect(result.failed.some((entry) => entry.kind === 'tokens')).toBe(true);
    // pages depends on neither tokens nor style-guide in the table, so the failure did not block it.
    expect(result.wrote).toContain('pages');
  });
});

describe('plan chat replies', () => {
  it('keeps valid actions, fills the optional fields, and drops invalid ones', () => {
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'I can link the drawn page and add the portal.',
      actions: [
        { kind: 'link', summary: 'Link Register to Sign up', designName: 'Register', screenName: 'Sign up' },
        { kind: 'story', summary: 'Add the parent portal story', title: 'Parent portal', body: 'A parent sees their children.', acceptance: 'The parent sees each child.' },
        { kind: 'add', summary: 'Add the parent portal', title: 'Parent portal', route: '/parent', cardKind: 'screen', dependsOn: 'Auth endpoint' },
        { kind: 'add', summary: 'Add the report endpoint', title: 'Parent report endpoint', cardType: 'endpoint', story: 'A parent loads reports.', acceptance: ['It returns the reports.'], dependsOnTitles: ['Auth endpoint'] },
        { kind: 'add', summary: 'Broken add' },
        { kind: 'generate', summary: 'Write the pages and stories', artifacts: 'pages, stories' },
        { kind: 'invented', summary: 'Not a real action' },
      ],
    }));

    expect(result.reply).toContain('link');
    expect(result.actions.map((action) => action.kind)).toEqual(['link', 'story', 'add', 'add', 'generate']);
    // The broken add and the invented kind are counted, not silently dropped.
    expect(result.dropped).toBe(2);
    const story = result.actions[1];
    expect(story?.kind === 'story' && story.title).toBe('Parent portal');
    expect(story?.kind === 'story' && story.acceptance).toEqual(['The parent sees each child.']);
    const added = result.actions[2];
    expect(added?.kind === 'add' && added.purpose).toBe('');
    expect(added?.kind === 'add' && added.cardKind).toBe('page');
    expect(added?.kind === 'add' && added.dependsOn).toEqual(['Auth endpoint']);
    expect(added?.kind === 'add' && added.designName).toBeNull();
    const endpoint = result.actions[3];
    expect(endpoint?.kind === 'add' && endpoint.cardKind).toBe('backend');
    expect(endpoint?.kind === 'add' && endpoint.acceptance).toEqual(['It returns the reports.']);
    expect(endpoint?.kind === 'add' && endpoint.dependsOn).toEqual(['Auth endpoint']);
    const generated = result.actions[4];
    expect(generated?.kind === 'generate' && generated.artifacts).toEqual(['pages', 'stories']);
  });

  it('refuses a reply with no words rather than showing an empty proposal', () => {
    expect(() => parsePlanChatReply(JSON.stringify({ actions: [] }))).toThrow();
  });

  it('reads a change list under another name', () => {
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'Adding the portal.',
      changes: [{ kind: 'add', summary: 'Add Parent portal', cardKind: 'page', title: 'Parent portal', route: '/parent' }],
    }));

    expect(result.actions).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });

  it('reads the shapes models actually return', () => {
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'Adding it.',
      proposedChanges: [
        { type: 'create', name: 'Parent portal', path: '/parent', card_type: 'screen', dependencies: [{ title: 'Auth endpoint' }] },
        { action: 'create_story', name: 'Parent portal story', acceptance_criteria: [{ criterion: 'A parent sees a report.' }] },
      ],
    }));

    expect(result.actions.map((action) => action.kind)).toEqual(['add', 'story']);
    const added = result.actions[0];
    expect(added?.kind === 'add' && added.title).toBe('Parent portal');
    expect(added?.kind === 'add' && added.cardKind).toBe('page');
    expect(added?.kind === 'add' && added.dependsOn).toEqual(['Auth endpoint']);
    const story = result.actions[1];
    expect(story?.kind === 'story' && story.acceptance).toEqual(['A parent sees a report.']);
  });

  it('flattens a feature wrapper and clips an over-long field', () => {
    const long = 'A'.repeat(200);
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'Adding it.',
      actions: [{
        kind: 'feature',
        title: long,
        story: { title: 'Zuri everywhere', acceptance: ['The same account works on both.'] },
        screens: [{ title: long }],
        endpoints: [{ title: 'Sync endpoint', dependsOn: ['Chat workspace'] }],
      }],
    }));

    expect(result.actions.map((action) => action.kind)).toEqual(['story', 'add', 'add']);
    const story = result.actions[0];
    expect(story?.kind === 'story' && story.title).toBe('Zuri everywhere');
    const page = result.actions.find((action) => action.kind === 'add' && action.cardKind === 'page');
    expect(page?.kind === 'add' && page.title.length).toBe(120);
    const endpoint = result.actions.find((action) => action.kind === 'add' && action.cardKind === 'backend');
    expect(endpoint?.kind === 'add' && endpoint.dependsOn).toEqual(['Chat workspace']);
  });

  it('maps artifact aliases onto the artifacts the plan has', () => {
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'Writing the documents.',
      actions: [{ kind: 'generate', summary: 'Write the design documents', artifacts: ['design', 'docs', 'routes'] }],
    }));

    const generated = result.actions[0];
    expect(generated?.kind === 'generate' && generated.artifacts).toEqual([
      'style-guide', 'tokens', 'decisions', 'architecture', 'conventions', 'pages', 'flows',
    ]);
  });

  it('reads a top-level story and a bare screen list', () => {
    const result = parsePlanChatReply(JSON.stringify({
      reply: 'Adding the feature.',
      story: { title: 'Zuri everywhere', body: 'A person uses Zuri on web and Windows.', acceptance: ['The same account works on both.'] },
      screens: ['Parent portal', 'Account settings'],
    }));

    expect(result.actions.map((action) => action.kind)).toEqual(['story', 'add', 'add']);
    const pages = result.actions.slice(1);
    expect(pages.every((action) => action.kind === 'add' && action.cardKind === 'page')).toBe(true);
    expect(pages.map((action) => action.kind === 'add' && action.title)).toEqual(['Parent portal', 'Account settings']);
  });
});

describe('extracting actions', () => {
  it('runs a second pass when a feature reply has no actions', async () => {
    const { studio, calls } = makeStudio({
      kai_studio_plan_chat: JSON.stringify({ reply: 'The set adds a parent portal and its story.', actions: [] }),
      kai_studio_plan_actions: JSON.stringify({
        reply: 'Wired.',
        actions: [
          { kind: 'story', summary: 'Add the parent portal story', title: 'Parent portal', body: 'A parent sees reports.', acceptance: ['A parent sees a report.'] },
          { kind: 'add', summary: 'Add the parent portal screen', cardKind: 'page', title: 'Parent portal', route: '/parent', dependsOn: ['Auth endpoint'] },
        ],
      }),
    });

    const result = await studio.planChat('p1', 'Add a parent portal feature.', 'feature');

    expect(result.actions).toHaveLength(2);
    expect(calls).toEqual(['kai_studio_plan_chat', 'kai_studio_plan_actions']);
  });

  it('reports the stage of the turn as it runs', async () => {
    const stages: string[] = [];
    const { studio } = makeStudio({
      kai_studio_plan_chat: JSON.stringify({ reply: 'Adding it.', actions: [{ kind: 'add', summary: 'Add a card', title: 'A card' }] }),
    });

    await studio.planChat('p1', 'Add a card.', 'feature', (stage) => stages.push(stage));

    expect(stages).toEqual(['reading-plan', 'reading-design', 'asking-model', 'done']);
  });

  it('does not second-guess Ask', async () => {
    const { studio, calls } = makeStudio({
      kai_studio_plan_chat: JSON.stringify({ reply: 'It is missing a reports screen.', actions: [] }),
      kai_studio_plan_actions: JSON.stringify({ reply: 'Wired.', actions: [] }),
    });

    const result = await studio.planChat('p1', 'What is missing?', 'ask');

    expect(result.actions).toEqual([]);
    expect(calls).toEqual(['kai_studio_plan_chat']);
  });
});

describe('applying a plan change set', () => {
  async function seeded(): Promise<ReturnType<typeof makeStudio>> {
    const made = makeStudio();
    await made.studio.saveArtifact('p1', 'pages', [
      '# Pages',
      '',
      '## Sign up',
      '',
      'Route: /sign-up',
      '',
      'A sign-up form.',
      '',
      '## Old dashboard',
      '',
      'Route: /dashboard',
      '',
      'Replaced by the new home page.',
      '',
    ].join('\n'));
    await made.studio.saveArtifact('p1', 'stories', '# Stories\n\n## Sign in\n\nA person signs in.\n');
    const card = (id: string, title: string, route: string, kind: 'page' | 'backend' = 'page') => boardCardSchema.parse({
      id, title, kind, route, needsArtifacts: kind === 'backend' ? ['stack'] : ['tokens'], createdAt: NOW, updatedAt: NOW,
    });
    const catalog = await made.artifacts.read('p1');
    await made.board.replace('p1', [
      card('signup', 'Sign up', '/sign-up'),
      card('dashboard', 'Old dashboard', '/dashboard'),
      card('auth', 'Auth endpoint', '', 'backend'),
    ], catalog.artifacts);
    return made;
  }

  it('adds a screen, reroutes it, and removes another, each on the board and in the pages list', async () => {
    const { studio, board, artifacts, calls } = await seeded();
    expect(calls).toEqual([]);

    const result = await studio.applyPlanActions('p1', [
      { kind: 'add', summary: 'Add Reports', cardKind: 'page', title: 'Reports', route: '/reports', purpose: 'Monthly numbers.', story: '', acceptance: [], dependsOn: [], designName: null },
      { kind: 'route', summary: 'Move Reports under /reports/monthly', screenName: 'Reports', route: '/reports/monthly' },
      { kind: 'remove', summary: 'Remove Old dashboard', screenName: 'Old dashboard', deletePage: false },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.applied).toEqual(['Add Reports', 'Move Reports under /reports/monthly', 'Remove Old dashboard']);

    const pages = await artifacts.readText('p1', 'pages');
    expect(pages).toContain('## /reports/monthly — Reports');
    expect(pages).toContain('Route: /reports/monthly');
    expect(pages).not.toContain('Old dashboard');

    const cards = (await board.read('p1')).cards;
    const reports = cards.find((card) => card.title === 'Reports');
    expect(reports?.route).toBe('/reports/monthly');
    expect(cards.some((card) => card.title === 'Old dashboard')).toBe(false);
  });

  it('wires a whole feature into the stories, the pages and the board, with dependencies', async () => {
    const { studio, board, artifacts } = await seeded();

    const result = await studio.applyPlanActions('p1', [
      { kind: 'story', summary: 'Add the parent portal story', title: 'Parent portal', body: 'A parent signs in and sees each child\'s report.', acceptance: ['A parent sees a report per child.'] },
      { kind: 'add', summary: 'Add the report endpoint', cardKind: 'backend', title: 'Parent report endpoint', route: '', purpose: '', story: 'A parent loads reports.', acceptance: ['It returns reports for the parent\'s children.'], dependsOn: ['Auth endpoint'], designName: null },
      { kind: 'add', summary: 'Add the parent portal screen', cardKind: 'page', title: 'Parent portal', route: '/parent', purpose: 'A parent sees their children.', story: '', acceptance: [], dependsOn: ['Parent report endpoint'], designName: null },
      { kind: 'add', summary: 'Add the report card component', cardKind: 'component', title: 'Report card', route: '', purpose: '', story: 'A parent reads one child\'s report.', acceptance: ['It shows one child\'s report.'], dependsOn: ['Parent report endpoint'], designName: null },
      { kind: 'add', summary: 'Add the portal flow', cardKind: 'flow', title: 'Parent portal flow', route: '', purpose: '', story: 'A parent moves from sign-in to a report.', acceptance: ['The flow reaches the report.'], dependsOn: ['Parent portal', 'Sign up'], designName: null },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(5);
    const stories = await artifacts.readText('p1', 'stories');
    expect(stories).toContain('## Parent portal');
    expect(stories).toContain('A parent sees a report per child.');
    const pages = await artifacts.readText('p1', 'pages');
    expect(pages).toContain('## /parent — Parent portal');

    const cards = (await board.read('p1')).cards;
    const byTitle = new Map(cards.map((card) => [card.title, card]));
    expect(byTitle.get('Parent report endpoint')?.kind).toBe('backend');
    expect(byTitle.get('Parent portal')?.kind).toBe('page');
    expect(byTitle.get('Report card')?.kind).toBe('component');
    expect(byTitle.get('Parent portal flow')?.kind).toBe('flow');
    // Dependencies resolve by title, including cards created earlier in the same set.
    expect(byTitle.get('Parent report endpoint')?.dependsOn).toEqual(['auth']);
    expect(byTitle.get('Parent portal')?.dependsOn).toEqual([byTitle.get('Parent report endpoint')?.id]);
    expect(byTitle.get('Report card')?.dependsOn).toEqual([byTitle.get('Parent report endpoint')?.id]);
    expect(byTitle.get('Parent portal flow')?.dependsOn).toEqual([byTitle.get('Parent portal')?.id, 'signup']);
    // The work waits for what it depends on instead of appearing ready beside it.
    expect(byTitle.get('Parent portal')?.status).toBe('backlog');
  });

  it('keeps going when one action fails, and names the one that did', async () => {
    const { studio } = await seeded();

    const result = await studio.applyPlanActions('p1', [
      { kind: 'link', summary: 'Link a page that is not drawn', designName: 'Ghost page', screenName: 'Sign up' },
      { kind: 'route', summary: 'Reroute Sign up', screenName: 'Sign up', route: '/join' },
    ]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.summary).toBe('Link a page that is not drawn');
    expect(result.failed[0]?.reason).toContain('No drawn OpenPencil page');
    expect(result.applied).toEqual(['Reroute Sign up']);
  });

  it('links a drawn page to the planned screen by renaming the drawing, then attaches its card', async () => {
    const design = fakeDesign('Register');
    const made = await seeded();
    const studio = new DesktopStudio({ ...made.ports, openPencil: async () => design.ports });

    const result = await studio.applyPlanActions('p1', [
      { kind: 'link', summary: 'Link Register to Sign up', designName: 'Register', screenName: 'Sign up' },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.applied).toEqual(['Link Register to Sign up']);
    expect(design.renamed).toEqual(['Sign up']);
    expect(design.current()).toBe('Sign up');
    const signup = result.board.cards.find((card) => card.title === 'Sign up');
    expect(signup?.designRef).toBe('p1');
  });
});
