import { describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  createStudioDesign,
  type BoardCard,
  type StudioBoard,
  type StudioDesign,
} from '../packages/contracts/src';
import { applyDesignStaleness, clearRenumberedStaleness, designCardId, mergeDesign } from '../apps/desktop/src/main/board';
import {
  changedNodes,
  componentsFrom,
  designErrorMessage,
  nodeHashes,
  nodesFromReply,
  tokensFromReply,
  unwrapReply,
} from '../apps/desktop/src/main/design-source';

const AT = '2026-09-28T12:00:00.000Z';

function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({
    id,
    title: `${id} card`,
    kind: 'component',
    needsArtifacts: ['brief'],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
}

function board(cards: BoardCard[]): StudioBoard {
  return { schemaVersion: 1, cards };
}

describe('reading open-pencil replies', () => {
  it('unwraps the content list the MCP transport returns', () => {
    expect(unwrapReply([{ type: 'text', text: '{"a":1}' }])).toEqual({ a: 1 });
    expect(unwrapReply([{ type: 'text', text: 'not json at all' }])).toBe('not json at all');
    expect(unwrapReply({ json: { b: 2 } })).toEqual({ b: 2 });
  });

  it('reads the token map out of the JSON string `design_to_tokens` puts in "output"', () => {
    const reply = [{ type: 'text', text: JSON.stringify({ output: JSON.stringify({ Light: { '--color-ink': '#111' } }), tokenCount: 1, modeCount: 1 }) }];

    expect(tokensFromReply(reply)).toEqual({ Light: { '--color-ink': '#111' } });
  });

  it('takes the token document, whether it is the reply or nested under "tokens"', () => {
    expect(tokensFromReply([{ type: 'text', text: '{"colors":{"ink":"#111"}}' }])).toEqual({ colors: { ink: '#111' } });
    expect(tokensFromReply([{ type: 'text', text: '{"tokens":{"space":{"sm":4}}}' }])).toEqual({ space: { sm: 4 } });
  });

  it('refuses an empty or non-object token reply rather than writing an empty file', () => {
    expect(() => tokensFromReply([{ type: 'text', text: '' }])).toThrow('did not return a token document');
    expect(() => tokensFromReply([{ type: 'text', text: '[1,2]' }])).toThrow('did not return a token document');
  });

  it('surfaces the editor\'s own error instead of treating it as a token document', () => {
    expect(() => tokensFromReply([{ type: 'text', text: '{"error":"No document is open"}' }])).toThrow('open-pencil could not export tokens: No document is open');
    expect(() => tokensFromReply([{ type: 'text', text: JSON.stringify({ output: 'not a document' }) }])).toThrow('were not a JSON document');
  });

  it('reads a document with no variables defined as zero tokens, not a broken reply', () => {
    // The real reply from a document with no variables yet: a CSS comment instead of JSON, even with format: 'json'.
    const reply = [{ type: 'text', text: JSON.stringify({ output: '/* No matching variables found */', tokenCount: 0, modeCount: 0 }) }];
    expect(tokensFromReply(reply)).toEqual({});
  });

  it('reads components and pages from the shapes the editor may answer with', () => {
    const components = componentsFrom(
      [{ type: 'text', text: '{"components":[{"id":"c1","name":"Button","page":"Main"}]}' }],
      [{ type: 'text', text: '{"pages":[{"id":"p1","name":"Sign in"}]}' }],
    );

    expect(components).toEqual([
      { id: 'c1', name: 'Button', page: 'Main', screen: false },
      { id: 'p1', name: 'Sign in', page: 'Sign in', screen: true },
    ]);
  });

  it('walks the node tree the editor answers with, keeping each node identity and children', () => {
    const nodes = nodesFromReply([{ type: 'text', text: '{"tree":{"id":"n1","type":"FRAME","name":"Card","children":[{"id":"n2","type":"TEXT","name":"Title"}]}}' }]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children[0]).toMatchObject({ id: 'n2', name: 'Title' });
    expect(nodes[0]!.component).toBe(false);
  });

  it('hashes a node by its own name and kind, so a child change does not restale its parent', () => {
    const before = nodeHashes(nodesFromReply([{ text: '{"tree":{"id":"n1","type":"FRAME","name":"Card","children":[{"id":"n2","type":"TEXT","name":"Title"}]}}' }]));
    const after = nodeHashes(nodesFromReply([{ text: '{"tree":{"id":"n1","type":"FRAME","name":"Card","children":[{"id":"n2","type":"TEXT","name":"Subtitle"}]}}' }]));

    expect(changedNodes(before, after)).toEqual(['n2']);
  });

  it('reports what a redesign changed and what it did not, and a new node is no change to any card', () => {
    const before: StudioDesign = { ...createStudioDesign('http://127.0.0.1:7600/mcp'), hashes: { a: '1', b: '2' } };
    const after: StudioDesign = { ...createStudioDesign('http://127.0.0.1:7600/mcp'), hashes: { a: '1', b: '9', c: '3' } };

    expect(changedNodes(before.hashes, after.hashes)).toEqual(['b']);
  });

  it('reports nothing when the document was renumbered: most of its nodes changing at once is not a redesign', () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      before[`0:${index}`] = `node ${index}`;
      // The same ids, handed to other nodes, as open-pencil does when a file is reopened.
      after[`0:${index}`] = `node ${(index + 7) % 60}`;
    }
    expect(changedNodes(before, after)).toEqual([]);
    // A handful of real changes among many is still reported.
    const edited = { ...before, '0:3': 'renamed', '0:9': 'renamed' };
    expect(changedNodes(before, edited)).toEqual(['0:3', '0:9']);
  });

  it('turns a 401 into something the user can act on, and leaves a real error alone', () => {
    expect(designErrorMessage(new Error('MCP error 401: Unauthorized'))).toContain('does not match the one the editor was started with');
    expect(designErrorMessage(new Error('ECONNREFUSED 127.0.0.1:7600'))).toContain('open-pencil is not running');
    expect(designErrorMessage(new Error('the node is missing'))).toBe('the node is missing');
  });

  it('says the folder scope is the editor\'s own setting when a read falls outside it', () => {
    expect(designErrorMessage(new Error('path is outside the allowed directory'))).toContain('OPENPENCIL_MCP_ROOT');
  });
});

describe('design staleness on the board', () => {
  it('staleness a card holding a node the design moved, and anything built on it', () => {
    const cards = [
      card('button', { designRef: 'n1' }),
      card('sign-in', { designRef: 'n2', dependsOn: ['button'] }),
      card('settings', { designRef: 'n3' }),
    ];

    const next = applyDesignStaleness(cards, ['n1']);

    expect(next.map((item) => item.stale)).toEqual([true, true, false]);
    expect(next[0]!.staleReason).toContain('open-pencil node n1 changed');
    expect(next[1]!.staleReason).toContain('built on');
  });

  it('leaves every card alone when no node moved, and never touches a card with no design node', () => {
    const cards = [card('button', { designRef: 'n1' }), card('chore')];

    expect(applyDesignStaleness(cards, []).every((item) => !item.stale)).toBe(true);
    expect(applyDesignStaleness(cards, ['n9']).every((item) => !item.stale)).toBe(true);
  });
});

describe('cards from the design', () => {
  it('gives a component and a page their own cards, each carrying its node id', () => {
    const merged = mergeDesign(board([]).cards, [
      { id: 'c1', name: 'Button', page: 'Main', screen: false },
      { id: 'p1', name: 'Sign in', page: 'Sign in', screen: true },
    ], AT);

    expect(merged.map((item) => item.id)).toEqual(['c1', 'p1']);
    expect(merged.map((item) => item.kind)).toEqual(['component', 'page']);
    expect(merged[0]!.designRef).toBe('c1');
    expect(merged[1]!.designRef).toBe('p1');
    expect(merged.every((item) => item.status === 'backlog')).toBe(true);
  });

  it('attaches the node id to a card that already names the thing instead of adding a second card', () => {
    const merged = mergeDesign([card('sign-in', { title: 'Sign in' })], [{ id: 'p1', name: 'Sign in', page: 'Sign in', screen: true }], AT);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.designRef).toBe('p1');
    expect(merged[0]!.kind).toBe('component');
  });

  it('matches a card the board already tied to a node, and keeps its status', () => {
    const merged = mergeDesign([card('button', { designRef: 'c1', status: 'review' })], [{ id: 'c1', name: 'Button', page: 'Main', screen: false }], AT);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('review');
    expect(merged[0]!.updatedAt).toBe(AT);
  });

  it('never gives two nodes the same card id', () => {
    const merged = mergeDesign(board([]).cards, [
      { id: 'Main/Button', name: 'Button', page: 'Main', screen: false },
      { id: 'Main-Button', name: 'Other button', page: 'Main', screen: false },
    ], AT);

    expect(new Set(merged.map((item) => item.id)).size).toBe(2);
    expect(merged[0]!.id).toBe('main-button');
    expect(merged[1]!.id).toBe('main-button-2');
  });

  it('makes a readable id from a node id', () => {
    expect(designCardId('Page 1 / Primary Button')).toBe('page-1-primary-button');
    expect(designCardId('   ')).toBe('node');
  });
});

describe('a document open-pencil renumbered', () => {
  // What a real Zuri board showed: the ids were handed to other nodes, so 0:24, once Button / Light Danger, is now Button / Danger.
  const renumbered = [
    { id: '0:24', name: 'Button / Danger', page: 'Components', screen: false },
    { id: '0:16', name: 'Button / Ghost', page: 'Components', screen: false },
    { id: '0:30', name: 'Button / Light Danger', page: 'Components', screen: false },
  ];

  it('links each card to the node that carries its name, not to the node its old id now belongs to', () => {
    const cards = [
      card('danger', { title: 'Button / Danger', designRef: '0:12' }),
      card('light-danger', { title: 'Button / Light Danger', designRef: '0:24' }),
      card('ghost', { title: 'Button / Ghost', designRef: '0:10' }),
      card('small', { title: 'Button / Small', designRef: '0:16' }),
    ];
    const merged = mergeDesign(cards, renumbered, AT);
    const ref = (id: string) => merged.find((item) => item.id === id)?.designRef;
    expect(ref('danger')).toBe('0:24');
    expect(ref('light-danger')).toBe('0:30');
    expect(ref('ghost')).toBe('0:16');
    // Button / Small is not in the document any more: it lets go of the id another card now has, rather than sharing it.
    expect(ref('small')).toBeNull();
    expect(merged.filter((item) => item.designRef === '0:16')).toHaveLength(1);
    // And no extra cards were made for nodes that already had one.
    expect(merged).toHaveLength(4);
  });

  it('still follows a node the person renamed: same id, new name, and no card with the new name', () => {
    const merged = mergeDesign([card('sign-up', { title: 'Sign up', designRef: 'p1', kind: 'page' })], [{ id: 'p1', name: 'Create account', page: 'Create account', screen: true }], AT);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.designRef).toBe('p1');
  });

  it('takes back staleness the renumbering put on a card once its node carries its name again, and on cards built on it', () => {
    const cards = [
      card('danger', { title: 'Button / Danger', designRef: '0:24', stale: true, staleReason: 'open-pencil node 0:24 changed since this card was written.' }),
      card('form', { title: 'Delete form', dependsOn: ['danger'], stale: true, staleReason: 'Something this card is built on has to be redone for the new design.' }),
      card('other', { title: 'Something else', designRef: '0:99', stale: true, staleReason: 'open-pencil node 0:99 changed since this card was written.' }),
      card('person', { title: 'Manual', stale: true, staleReason: 'A person marked this to be redone.' }),
    ];
    const cleared = clearRenumberedStaleness(cards, renumbered, AT);
    const stale = (id: string) => cleared.find((item) => item.id === id)?.stale;
    expect(stale('danger')).toBe(false);
    expect(stale('form')).toBe(false);
    // A node not in the document, and a reason that is not the design's, are left as they are.
    expect(stale('other')).toBe(true);
    expect(stale('person')).toBe(true);
  });
});
