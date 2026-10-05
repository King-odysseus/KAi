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
  type BoardCard,
  type BoardStatus,
  type StudioBoard,
  type StudioReadiness,
} from '../packages/contracts/src';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { DesktopStudio, arrangeBoardPrompt, artifactPrompt, boardPrompt, parseArrangePlan, parseArtifact, parseBoardDraft, type StudioPorts } from '../apps/desktop/src/main/studio';
import { DesktopUiCheck } from '../apps/desktop/src/main/ui-check';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { ReplyShapeError } from '../apps/desktop/src/main/learning-tutor';
import type { DesignPorts } from '../apps/desktop/src/main/design-source';
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
    // A provider that answers with the document itself, instead of the JSON wrapper, still gets its document kept.
    expect(parseArtifact('# PRD\n\nThe problem, who it is for, and the features in order.', 'prd')).toBe('# PRD\n\nThe problem, who it is for, and the features in order.\n');
    expect(parseArtifact('```markdown\n# Setup\n\nRun `npm install`, then `npm run dev` ({port} is 3000).\n```', 'setup')).toContain('# Setup');
    // A reply that opens like JSON but is broken is a failed wrapper, not a document.
    expect(() => parseArtifact('{"content": "# PRD', 'prd')).toThrow();
    expect(() => parseArtifact('ok', 'prd')).toThrow();
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
    // Hosting and managed infrastructure are ordered last, so the first cards an agent reaches are the ones that make
    // the product run locally. The old rule said the opposite, which put a hosted database near the front of the board.
    expect(board.system).toContain('comes LAST');
    expect(board.system).not.toContain('backend and setup first');
    expect(prompt.system).toContain('deployment, hosting and a managed database are the last stories');
  });

  it('asks for an existing board to be reordered, naming the cards it already has', () => {
    const boardCard = (id: string, kind: BoardCard['kind'], status: BoardStatus): BoardCard => ({
      id, title: `Card ${id}`, kind, story: '', acceptance: [], prompt: '', designRef: null, route: '', dependsOn: [],
      needsArtifacts: [], status, checks: [], check: null, runs: [], notes: '', stale: false, staleReason: null,
      claimedBy: null, movedBy: null, movedAt: null, createdAt: NOW, updatedAt: NOW,
    });
    const board: StudioBoard = {
      schemaVersion: 1,
      cards: [
        { ...boardCard('railway', 'backend', 'ready'), title: 'Use Railway-managed Postgres' },
        { ...boardCard('home', 'page', 'done'), title: 'Build the home page' },
      ],
    };
    const prompt = arrangeBoardPrompt(board, '# Brief', '# Stack', null);

    // It rearranges what is there rather than writing new cards.
    expect(prompt.system).toContain('Return every card exactly once');
    expect(prompt.system).toContain('comes LAST');
    expect(prompt.system).toContain('Use the ids exactly as given');
    expect(prompt.user).toContain('railway');
    expect(prompt.user).toContain('already done');

    // A reply that names nothing is refused, so arranging can never empty a board.
    expect(() => parseArrangePlan('{"cards":[]}')).toThrow();
    expect(parseArrangePlan('{"cards":[{"id":"home","dependsOn":["railway"]}]}').cards)
      .toEqual([{ id: 'home', dependsOn: ['railway'] }]);
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
      kai_studio_tokens: JSON.stringify({ content: '{}' }),
      kai_studio_pages: JSON.stringify({ content: '# Pages' }),
      kai_studio_decisions: JSON.stringify({ content: '# Decisions' }),
      kai_studio_architecture: JSON.stringify({ content: '# Architecture' }),
      kai_studio_conventions: JSON.stringify({ content: '# Conventions' }),
      kai_studio_acceptance: JSON.stringify({ content: '# Acceptance' }),
      kai_studio_risks: JSON.stringify({ content: '# Risks' }),
      kai_studio_glossary: JSON.stringify({ content: '# Glossary' }),
      kai_studio_setup: JSON.stringify({ content: '# Setup' }),
    });
    // Seed the brief the interview would have written, then generate everything built on it.
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'brief.md'), '# Brief\n');
    const catalog = await app.generateAll('p1');
    expect(catalog.artifacts.map((item) => item.kind)).toEqual(['brief', 'prd', 'stories', 'stack', 'flows', 'style-guide', 'tokens', 'pages', 'decisions', 'architecture', 'conventions', 'acceptance', 'risks', 'glossary', 'setup']);
    expect(calls).toEqual([
      'kai_studio_prd', 'kai_studio_stories', 'kai_studio_stack', 'kai_studio_flows', 'kai_studio_style_guide', 'kai_studio_tokens',
      'kai_studio_pages', 'kai_studio_decisions', 'kai_studio_architecture', 'kai_studio_conventions', 'kai_studio_acceptance',
      'kai_studio_risks', 'kai_studio_glossary', 'kai_studio_setup',
    ]);
    const again = await app.generateAll('p1');
    expect(again.artifacts.every((item) => !item.stale)).toBe(true);
    expect(calls).toHaveLength(14);
  });

  it('keeps writing the other artifacts when the model gets one wrong, and says which failed', async () => {
    const { studio: app } = studio({
      kai_studio_prd: JSON.stringify({ content: '# PRD' }),
      kai_studio_stack: JSON.stringify({ content: '# Stack' }),
      kai_studio_style_guide: JSON.stringify({ content: '# Style' }),
      kai_studio_tokens: JSON.stringify({ content: '{}' }),
      kai_studio_decisions: JSON.stringify({ content: '# Decisions' }),
      kai_studio_conventions: JSON.stringify({ content: '# Conventions' }),
      kai_studio_risks: JSON.stringify({ content: '# Risks' }),
      kai_studio_glossary: JSON.stringify({ content: '# Glossary' }),
      kai_studio_setup: JSON.stringify({ content: '# Setup' }),
    });
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'brief.md'), '# Brief\n');
    // The stories are the one reply the model never produced, so what is built from them cannot be written either.
    await expect(app.generateAll('p1')).rejects.toThrow(/Wrote 9 of 14 artifacts\. Could not write: stories, flows, pages, architecture, acceptance\. stories: no canned reply/);
    const catalog = await app.artifacts('p1');
    expect(catalog.artifacts.map((item) => item.kind)).toEqual(['brief', 'prd', 'stack', 'style-guide', 'tokens', 'decisions', 'conventions', 'risks', 'glossary', 'setup']);
  });

  it('builds the board from the stories when the model answers with something unreadable', async () => {
    // A reply that arrived and could not be read is exactly what the stories fallback is for.
    const { studio: app } = studio({}, {
      requester: {
        structuredRequest: () => Promise.reject(new ReplyShapeError('The provider did not return a JSON board response.')),
      },
    });
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'stories.md'), '# Stories\n\n## 1. Sign in\n- Employees sign in with a company email\n- A wrong password shows an error\n\n## 2. Export a document\n- The chat output downloads as a .docx file\n');
    const board = await app.plan('p1');
    expect(board.cards.map((card) => card.title)).toEqual(['1. Sign in', '2. Export a document']);
    expect(board.cards[0]?.acceptance).toEqual(['Employees sign in with a company email', 'A wrong password shows an error']);
  });

  it('reports a board request that never got an answer, instead of dressing it up as a thin board', async () => {
    // Signed out, no network, a provider refusing: these used to fall back to the stories too, so the person got a
    // poorer board and no idea that their key had expired.
    const { studio: app } = studio({}, {
      requester: { structuredRequest: () => Promise.reject(new Error('The provider is not signed in.')) },
    });
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'stories.md'), '# Stories\n\n## 1. Sign in\n- Employees sign in with a company email\n');

    await expect(app.plan('p1')).rejects.toThrow('The provider is not signed in.');
  });

  it('names what the model actually sent when a board reply is not JSON', () => {
    expect(() => parseBoardDraft('Here are your cards: sign in, export')).toThrow(/The reply began: "Here are your cards/);
  });

  it('keeps the tokens a model returns as an object, not wrapped as text', () => {
    expect(parseArtifact(JSON.stringify({ colors: { primary: { light: '#0b7f86', dark: '#3cc0c7' } } }), 'tokens')).toBe('{\n  "colors": {\n    "primary": {\n      "light": "#0b7f86",\n      "dark": "#3cc0c7"\n    }\n  }\n}\n');
    expect(() => parseArtifact(JSON.stringify({ colors: {} }), 'prd')).toThrow(/did not match the expected shape/);
  });

  it('still lists the brief after one artifact is written, so the screen keeps showing the project', async () => {
    const { studio: app } = studio({ kai_studio_prd: JSON.stringify({ content: '# PRD' }) });
    await fs.promises.mkdir(path.join(root, '.kai', 'spec'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.kai', 'spec', 'brief.md'), '# Brief\n');
    const catalog = await app.generate('p1', 'prd');
    expect(catalog.artifacts.map((item) => item.kind)).toEqual(['brief', 'prd']);
    expect((await app.markEdited('p1', 'prd')).artifacts.map((item) => item.kind)).toContain('brief');
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

  it('leaves the project tokens alone when the editor has none, and says the pull was empty', async () => {
    // What an editor open on a blank document, or the wrong one, looks like. This used to write `{}` over the tokens
    // the foundation prompt reads — and the artifact then counted as written by open-pencil, so regenerating all
    // never wrote the real ones back either.
    const full = openPencil(DESIGN);
    const { studio: app } = studio({}, { openPencil: async () => full.ports });
    await app.pullDesign('p1');
    const goodTokens = await app.artifactText('p1', 'tokens');

    const empty = openPencil({
      ...DESIGN,
      design_to_tokens: JSON.stringify({ output: '/* No matching variables found */', tokenCount: 0, modeCount: 0 }),
    });
    const { studio: blank } = studio({}, { openPencil: async () => empty.ports });
    // The same project on disk, so the token file it already holds is the one at stake.
    const pulled = await blank.pullDesign('p1');

    expect(pulled.tokenCount).toBe(0);
    expect(pulled.tokensPreserved).toBe(true);
    // The tokens from the first pull are still there, untouched — which is the whole point.
    expect(await blank.artifactText('p1', 'tokens')).toBe(goodTokens);
  });

  it('does replace the tokens when the editor genuinely has none and the project had none either', async () => {
    // The guard is "do not empty a file that has something in it", not "never write an empty read".
    const empty = openPencil({
      ...DESIGN,
      design_to_tokens: JSON.stringify({ output: '/* No matching variables found */', tokenCount: 0, modeCount: 0 }),
    });
    const { studio: app } = studio({}, { openPencil: async () => empty.ports });

    const pulled = await app.pullDesign('p1');

    expect(pulled.tokensPreserved).toBe(false);
    expect(JSON.parse(await app.artifactText('p1', 'tokens') ?? 'null')).toEqual({});
  });

  it('refuses a pull from a different document, rather than folding another project\'s pages in', async () => {
    const first = openPencil(DESIGN);
    const { studio: app } = studio({}, { openPencil: async () => first.ports });
    const adopted = await app.pullDesign('p1');
    expect(adopted.differentDocument).toBe(false);
    expect(adopted.board.cards.map((card) => card.id)).toEqual(['c1', 'p1', 'p2']);

    // Same editor, a different file open: no page id in common with the ones this project was drawn from.
    // Note the same page *name* in both — "Sign in" — under a different id. A name-based check would have called
    // this the same document and folded a stranger's page in as this project's own.
    const other = openPencil({
      ...DESIGN,
      list_pages: '{"current":"Landing","pages":[{"id":"z9","name":"Landing"},{"id":"z8","name":"Sign in"}]}',
    });
    const { studio: again } = studio({}, { openPencil: async () => other.ports });
    const pulled = await again.pullDesign('p1');

    expect(pulled.differentDocument).toBe(true);
    expect(pulled.changed).toEqual([]);
    // The board is the one the first pull built, not the other document's.
    expect(pulled.board.cards.map((card) => card.id)).toEqual(['c1', 'p1', 'p2']);
    // And nothing was written: the tokens are still this project's.
    expect(await again.artifactText('p1', 'tokens')).toContain('--color-ink');
  });

  it('treats a page added inside the same document as the same document', async () => {
    // An exact set comparison would read any edit as a different document and lock the project out of its own design.
    const editor = openPencil(DESIGN);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.pullDesign('p1');

    editor.ports.call = (async (tool: string) => {
      if (tool === 'list_pages') return [{ type: 'text', text: '{"current":"Sign in","pages":[{"id":"p1","name":"Sign in"},{"id":"p2","name":"Sign up"},{"id":"p3","name":"Forgot password"}]}' }];
      return { type: 'text', text: DESIGN[tool as keyof typeof DESIGN] ?? '{}' } as never;
    }) as typeof editor.ports.call;

    expect((await app.pullDesign('p1')).differentDocument).toBe(false);
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

    await expect(app.pullDesign('p1')).rejects.toThrow('open-pencil is not connected');
  });
});

describe('acting on one page: rename and delete', () => {
  /** A fake editor that records the tool name AND its input, so a page op's exact call can be pinned — the read-only
   * fake above records only names, because a read has nothing to pin. */
  function opEditor(replies: Record<string, string>): { ports: DesignPorts; calls: { tool: string; input: Record<string, unknown> }[] } {
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    return {
      calls,
      ports: {
        endpoint: () => 'http://127.0.0.1:7600/mcp',
        call: async (tool: string, input: Record<string, unknown>) => {
          calls.push({ tool, input });
          return replies[tool] === undefined ? [] : [{ type: 'text', text: replies[tool] }];
        },
      },
    };
  }

  const READ = {
    design_to_tokens: JSON.stringify({ output: JSON.stringify({ Light: { '--color-ink': '#111111' } }), tokenCount: 1, modeCount: 1 }),
    get_components: '{"count":0,"components":[]}',
    list_pages: '{"current":"Sign in","pages":[{"id":"p1","name":"Sign in"},{"id":"p2","name":"Sign up"}]}',
    get_page_tree: '{"tree":{"id":"f1","type":"FRAME","name":"Frame","children":[]}}',
    switch_page: '{"ok":true}',
  };

  const PAGES = [
    '# Pages',
    '',
    '## /sign-in — Sign in /sign-in',
    'Route: `/sign-in`. Log in.',
    '',
    '## /sign-up — Sign up /sign-up',
    'Route: `/sign-up`. Register.',
  ].join('\n');

  it('renames one screen in the pages list and in open-pencil, and retitles its card', async () => {
    const editor = opEditor({ ...READ, rename_node: '{"id":"p1","name":"/sign-in — Log in"}' });
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.saveArtifact('p1', 'pages', PAGES);
    await app.pullDesign('p1');
    editor.calls.length = 0;

    const pulled = await app.renameDesignPage('p1', '/sign-in — Sign in /sign-in', 'Log in');

    // The one page named, by its id, with the name the heading will carry — not a screen matched and guessed at.
    expect(editor.calls.filter((call) => call.tool === 'rename_node')).toEqual([{ tool: 'rename_node', input: { id: 'p1', name: '/sign-in — Log in' } }]);
    // The heading takes the new name and keeps the route it led with; the body, where the route is read from, is untouched.
    const pages = await app.artifactText('p1', 'pages');
    expect(pages).toContain('## /sign-in — Log in');
    expect(pages).toContain('Route: `/sign-in`. Log in.');
    // And the board card follows, so the tab and the board do not name the same screen two ways.
    expect(pulled.board.cards.find((card) => card.id === 'p1')?.title).toBe('/sign-in — Log in');
  });

  it('renames a screen that is only in the pages list, touching no page in the editor', async () => {
    const editor = opEditor({ ...READ, list_pages: '{"current":"Sign in","pages":[{"id":"p1","name":"Sign in"}]}' });
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.saveArtifact('p1', 'pages', PAGES);
    await app.pullDesign('p1');
    editor.calls.length = 0;

    await app.renameDesignPage('p1', '/sign-up — Sign up /sign-up', 'Register');

    expect(editor.calls.some((call) => call.tool === 'rename_node')).toBe(false);
    expect(await app.artifactText('p1', 'pages')).toContain('## /sign-up — Register');
  });

  it('refuses a rename no heading matches, and calls nothing', async () => {
    const editor = opEditor(READ);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.saveArtifact('p1', 'pages', PAGES);
    await app.pullDesign('p1');
    editor.calls.length = 0;

    await expect(app.renameDesignPage('p1', 'Ghost screen', 'Anything')).rejects.toThrow('no screen named "Ghost screen"');
    expect(editor.calls.some((call) => call.tool === 'rename_node')).toBe(false);
  });

  it('deletes one screen\'s page and detaches its card, keeping the screen in the pages list', async () => {
    const editor = opEditor({ ...READ, delete_node: '{"deleted":"p1"}' });
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.saveArtifact('p1', 'pages', PAGES);
    await app.pullDesign('p1');
    editor.calls.length = 0;

    const pulled = await app.deleteDesignPage('p1', 'p1');

    expect(editor.calls.filter((call) => call.tool === 'delete_node')).toEqual([{ tool: 'delete_node', input: { id: 'p1' } }]);
    const card = pulled.board.cards.find((item) => item.id === 'p1');
    // The card stops pointing at a node that is gone, and says why — kept, not dropped, because the work is still to do.
    expect(card?.designRef).toBeNull();
    expect(card?.stale).toBe(true);
    expect(card?.staleReason).toContain('deleted in KAI');
    // The screen itself is untouched in the pages list, so it reads as still to draw — that is the recovery path.
    expect(await app.artifactText('p1', 'pages')).toContain('## /sign-in — Sign in /sign-in');
  });

  it('refuses to delete a page that is not part of this project\'s design, and calls nothing', async () => {
    const editor = opEditor(READ);
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.pullDesign('p1');
    editor.calls.length = 0;

    await expect(app.deleteDesignPage('p1', 'zzz')).rejects.toThrow('not part of this project');
    expect(editor.calls).toHaveLength(0);
  });

  it('surfaces the editor\'s own error rather than reporting a delete that did not happen', async () => {
    // open-pencil reports failure in the payload, not by throwing; a call that returned is not a call that worked.
    const editor = opEditor({ ...READ, delete_node: '{"error":"the node is missing"}' });
    const { studio: app } = studio({}, { openPencil: async () => editor.ports });
    await app.pullDesign('p1');

    await expect(app.deleteDesignPage('p1', 'p1')).rejects.toThrow('could not delete the page');
  });

  it('says the design layer is not set up rather than failing obscurely', async () => {
    const { studio: app } = studio({});

    await expect(app.renameDesignPage('p1', 'Sign in', 'Log in')).rejects.toThrow('open-pencil is not connected');
    await expect(app.deleteDesignPage('p1', 'p1')).rejects.toThrow('open-pencil is not connected');
  });
});

describe('design build', () => {
  it('gets open-pencil ready before running the step, against the project its root resolves to, with its own step id', async () => {
    const order: string[] = [];
    const { studio: app } = studio({}, {
      ensureOpenPencilRunning: async () => { order.push('ensure'); },
      runDesignAgent: async (prompt, projectRoot, conversationId) => {
        order.push(`run:${prompt}:${projectRoot}:${conversationId}`);
        return { status: 'completed', output: 'done' };
      },
    });

    const result = await app.buildDesignStep('p1', 'Draw the pricing screen', 'step-1');

    expect(result).toEqual({ status: 'completed', output: 'done' });
    expect(order).toEqual(['ensure', `run:Draw the pricing screen:${root}:step-1`]);
  });

  it('passes the turn\'s own cost back out, when the run reported one', async () => {
    const { studio: app } = studio({}, {
      ensureOpenPencilRunning: async () => {},
      runDesignAgent: async () => ({ status: 'completed', output: 'done', costUsd: 0.014 }),
    });

    const result = await app.buildDesignStep('p1', 'Draw the pricing screen', 'step-1');

    expect(result).toEqual({ status: 'completed', output: 'done', costUsd: 0.014 });
  });

  it('carries live events from the turn back out to the caller', async () => {
    const event = { schemaVersion: 1 as const, id: 'e1', taskId: 'step-1', timestamp: '2026-10-04T00:00:00.000Z', type: 'tool.call' as const, name: 'render', status: 'started' as const };
    const seen: unknown[] = [];
    const { studio: app } = studio({}, {
      ensureOpenPencilRunning: async () => {},
      runDesignAgent: async (_prompt, _root, _conversationId, onEvent) => {
        onEvent?.(event);
        return { status: 'completed', output: 'done' };
      },
    });

    await app.buildDesignStep('p1', 'Draw the pricing screen', 'step-1', (seenEvent) => seen.push(seenEvent));

    expect(seen).toEqual([event]);
  });

  it('passes a failed turn straight back, with its error', async () => {
    const { studio: app } = studio({}, {
      ensureOpenPencilRunning: async () => {},
      runDesignAgent: async () => ({ status: 'failed', output: '', error: 'open-pencil refused the call' }),
    });

    const result = await app.buildDesignStep('p1', 'Draw the pricing screen', 'step-1');

    expect(result).toEqual({ status: 'failed', output: '', error: 'open-pencil refused the call' });
  });

  it('says the build loop is not available rather than failing obscurely, when the ports are not wired', async () => {
    const { studio: app } = studio({});

    await expect(app.buildDesignStep('p1', 'Draw the pricing screen', 'step-1')).rejects.toThrow('not available in this build');
  });
});
