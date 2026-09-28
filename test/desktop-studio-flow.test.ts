import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cardIdFromKey,
  cardsFromDraft,
  createDefaultSettings,
  defaultNeeds,
  studioBoardDraftSchema,
  type StudioReadiness,
} from '../packages/contracts/src';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { DesktopStudio, artifactPrompt, boardPrompt, parseArtifact, parseBoardDraft, type StudioPorts } from '../apps/desktop/src/main/studio';
import { DesktopUiCheck } from '../apps/desktop/src/main/ui-check';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { hashFile } from '../apps/desktop/src/main/verification';

const NOW = '2026-09-28T12:00:00.000Z';
const READY: StudioReadiness = { ready: true, displayName: 'OpenAI', model: 'gpt-6-luna', reason: null };
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-studio-flow-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function studio(replies: Record<string, string>, over: Partial<StudioPorts> = {}): { studio: DesktopStudio; calls: string[] } {
  const calls: string[] = [];
  const settings = createDefaultSettings();
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
    artifacts: new StudioArtifacts({ spec: new SpecStore(), projectRoot: async () => root, now: () => NOW }),
    board: new StudioBoardStore({
      spec: new SpecStore(),
      projectRoot: async () => root,
      dirtyFiles: async () => [],
      hashFile: (projectRoot, relative) => hashFile(projectRoot, relative),
      run: async () => null,
      now: () => NOW,
    }),
    uiCheck: new DesktopUiCheck({
      previewUrl: async () => 'http://localhost:5173',
      capture: async () => 'ZmFrZQ==',
      probe: async () => ({ route: '/', states: [], tokens: {}, phoneScrollWidth: 1, phoneClientWidth: 1, tabbables: 1, landedRoute: '/' }),
      tokens: async () => null,
      writeShot: async (_root, relativePath) => relativePath,
      now: () => NOW,
    }),
    now: () => NOW,
    ...over,
  };
  return { studio: new DesktopStudio(ports), calls };
}

describe('studio drafts', () => {
  it('slugs card ids and resolves key dependencies, dropping self-references', () => {
    expect(cardIdFromKey('Add Sign-up Form!')).toBe('add-sign-up-form');
    const draft = studioBoardDraftSchema.parse({
      cards: [
        { key: 'api', title: 'Sign-up endpoint', kind: 'backend' },
        { key: 'form', title: 'Sign-up form', kind: 'component', dependsOnKeys: ['api', 'form', 'nope'] },
      ],
    });
    const cards = cardsFromDraft(draft, NOW);
    expect(cards.map((card) => card.id)).toEqual(['api', 'form']);
    expect(cards[1]?.dependsOn).toEqual(['api', 'nope']);
    expect(cards[0]?.needsArtifacts).toEqual(defaultNeeds('backend'));
    expect(cards[1]?.needsArtifacts).toEqual(['tokens']);
    expect(cards.every((card) => card.status === 'backlog')).toBe(true);
  });

  it('gives two keys that slug the same id distinct ids', () => {
    const draft = studioBoardDraftSchema.parse({ cards: [{ key: 'a b', title: 'One', kind: 'chore' }, { key: 'a-b', title: 'Two', kind: 'chore' }] });
    expect(cardsFromDraft(draft, NOW).map((card) => card.id)).toEqual(['a-b', 'a-b-2']);
  });

  it('reads artifact markdown, stripping a fence the model added anyway', () => {
    expect(parseArtifact(JSON.stringify({ content: '```markdown\n# PRD\n\nBody\n```' }), 'prd')).toBe('# PRD\n\nBody\n');
    expect(() => parseArtifact(JSON.stringify({ content: '  ' }), 'prd')).toThrow(/did not match the expected shape/);
  });

  it('rejects an empty board draft rather than writing a board with no cards', () => {
    expect(() => parseBoardDraft(JSON.stringify({ cards: [] }))).toThrow(/no cards/);
  });

  it('builds prompts from the artifacts each one reads', () => {
    const prompt = artifactPrompt('stories', { prd: '# PRD\nSign-up.' }, null);
    expect(prompt.system).toContain('user stories');
    expect(prompt.user).toContain('PRD:\n# PRD');
    expect(prompt.user).toContain('No project snapshot is available.');
    const board = boardPrompt('# Brief', '# Stories', '# Stack', null);
    expect(board.system).toContain('One card per story');
    expect(board.user).toContain('STORIES:\n# Stories');
  });
});

describe('studio generation', () => {
  it('generates the artifact set in dependency order, then stops regenerating fresh work', async () => {
    const { studio: app, calls } = studio({
      kai_studio_prd: JSON.stringify({ content: '# PRD' }),
      kai_studio_stories: JSON.stringify({ content: '# Stories' }),
      kai_studio_stack: JSON.stringify({ content: '# Stack' }),
      kai_studio_flows: JSON.stringify({ content: '# Flows' }),
      kai_studio_style_guide: JSON.stringify({ content: '# Style' }),
    });
    // Seed the brief the interview would have written, then generate everything built on it.
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'brief.md'), '# Brief\n');
    const catalog = await app.generateAll('p1');
    expect(catalog.artifacts.map((item) => item.kind)).toEqual(['brief', 'prd', 'stories', 'stack', 'flows', 'style-guide']);
    expect(calls).toEqual(['kai_studio_prd', 'kai_studio_stories', 'kai_studio_stack', 'kai_studio_flows', 'kai_studio_style_guide']);
    const again = await app.generateAll('p1');
    expect(again.artifacts.every((item) => !item.stale)).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('refuses an artifact whose input has not been written yet', async () => {
    const { studio: app } = studio({});
    await expect(app.generate('p1', 'prd')).rejects.toThrow(/Write brief first/);
  });

  it('turns the stories into a board, and keeps work already done when the board is regenerated', async () => {
    const reply = JSON.stringify({
      cards: [
        { key: 'api', title: 'Sign-up endpoint', kind: 'backend', acceptance: ['POST /signup returns 201'] },
        { key: 'form', title: 'Sign-up form', kind: 'component', dependsOnKeys: ['api'] },
      ],
    });
    const { studio: app } = studio({ kai_studio_board: reply });
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'stories.md'), '# Stories\n');
    const board = await app.plan('p1');
    expect(board.cards.map((card) => card.id)).toEqual(['api', 'form']);
    // The endpoint is independent, so the board promotes it to ready; the form waits on it.
    expect(board.cards[0]?.status).toBe('ready');
    expect(board.cards[1]?.status).toBe('backlog');
    await app.recordRun('p1', 'api', { agent: 'claude', model: 'gpt-6-luna', at: NOW, files: ['src/api.ts'] });
    const replanned = await app.plan('p1');
    expect(replanned.cards.find((card) => card.id === 'api')?.runs).toHaveLength(1);
  });

  it('refuses to plan a board before the stories exist', async () => {
    const { studio: app } = studio({});
    await expect(app.plan('p1')).rejects.toThrow(/Write the stories first/);
  });
});

describe('pulling the design from open-pencil', () => {
  /** A fake editor: each tool answers with the canned text for it, and every call is recorded. */
  function openPencil(replies: Record<string, string>): { ports: NonNullable<StudioPorts['openPencil']> extends () => Promise<infer P> ? P : never; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      ports: {
        endpoint: () => 'http://127.0.0.1:7600/mcp',
        call: async (tool: string) => {
          calls.push(tool);
          return replies[tool] === undefined ? [] : [{ type: 'text', text: replies[tool] }];
        },
      },
    };
  }

  /** The design as open-pencil 0.14.0 actually answers: a JSON string inside `output`, a `{ tree }`, page ids. */
  const DESIGN = {
    design_to_tokens: JSON.stringify({
      output: JSON.stringify({ Light: { '--color-ink': '#111111', '--space-sm': '4px' } }),
      tokenCount: 2,
      modeCount: 1,
    }),
    get_components: '{"count":1,"components":[{"id":"c1","name":"Button","type":"COMPONENT","page":"Sign in"}]}',
    list_pages: '{"current":"Sign in","pages":[{"id":"p1","name":"Sign in"},{"id":"p2","name":"Sign up"}]}',
    get_page_tree: '{"tree":{"id":"f1","type":"FRAME","name":"Frame","children":[{"id":"c1","type":"COMPONENT","name":"Button"}]}}',
    switch_page: '{"ok":true}',
  };

  it('writes the tokens, gives each component and page its card, and reads the tools in one pass', async () => {
    const editor = openPencil(DESIGN);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });

    const pulled = await app.pullDesign('p1');

    expect(pulled.tokensChanged).toBe(true);
    expect(pulled.tokenCount).toBe(2);
    expect(JSON.parse(await app.artifactText('p1', 'tokens') ?? '{}')).toEqual({ Light: { '--color-ink': '#111111', '--space-sm': '4px' } });
    expect(pulled.board.cards.map((card) => [card.id, card.kind, card.designRef])).toEqual([['c1', 'component', 'c1'], ['p1', 'page', 'p1'], ['p2', 'page', 'p2']]);
    // Cards with no dependencies are promoted, so the design's own cards can be worked straight away.
    expect(pulled.board.cards.every((card) => card.status === 'ready')).toBe(true);
    expect(pulled.design.endpoint).toBe('http://127.0.0.1:7600/mcp');
    // `get_page_tree` only answers for the current page, so the second page is selected before it is read.
    expect([...new Set(editor.calls)].sort()).toEqual(['design_to_tokens', 'get_components', 'get_page_tree', 'list_pages', 'switch_page']);
  });

  it('does not move the token artifact when the design has not changed', async () => {
    const editor = openPencil(DESIGN);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.pullDesign('p1');
    const first = await app.artifacts('p1');

    const again = await app.pullDesign('p1');

    expect(again.tokensChanged).toBe(false);
    expect(again.changed).toEqual([]);
    expect((await app.artifacts('p1')).artifacts.find((entry) => entry.kind === 'tokens')?.version).toBe(first.artifacts.find((entry) => entry.kind === 'tokens')?.version);
  });

  it('marks the card drawn from a node the design changed stale, and keeps the rest alone', async () => {
    const replies: Record<string, string> = { ...DESIGN };
    const editor = openPencil(replies);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.pullDesign('p1');
    replies.get_page_tree = '{"tree":{"id":"f1","type":"FRAME","name":"Frame","children":[{"id":"c1","type":"COMPONENT","name":"Primary Button"}]}}';
    editor.calls.length = 0;

    const pulled = await app.pullDesign('p1');

    expect(pulled.changed).toEqual(['c1']);
    expect(pulled.board.cards.find((card) => card.id === 'c1')?.stale).toBe(true);
    expect(pulled.board.cards.find((card) => card.id === 'c1')?.staleReason).toContain('open-pencil node c1 changed');
    expect(pulled.board.cards.find((card) => card.id === 'p1')?.stale).toBe(false);
    // Every page is read, so a change on a page that is not the editor's current one still restales its card.
    expect(editor.calls.filter((tool) => tool === 'get_page_tree')).toHaveLength(2);
  });

  it('says the design layer is not set up rather than failing obscurely', async () => {
    const { studio: app } = studio({});

    await expect(app.pullDesign('p1')).rejects.toThrow('open-pencil is not configured');
  });
});
