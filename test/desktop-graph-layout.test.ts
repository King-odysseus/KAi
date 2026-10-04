import { describe, expect, it } from 'vitest';
import { agentLinks, cardDepths, connectedCardIds, layoutCards } from '../apps/desktop/src/renderer/src/graph-layout';

const cards = [
  { id: 'api', dependsOn: [] as string[], status: 'done' as const, claimedBy: null as string | null },
  { id: 'form', dependsOn: ['api'], status: 'inProgress' as const, claimedBy: 'claude' },
  { id: 'page', dependsOn: ['form', 'api'], status: 'backlog' as const, claimedBy: null },
  { id: 'docs', dependsOn: [], status: 'ready' as const, claimedBy: null },
];

describe('graph layout', () => {
  it('puts a card one column right of its deepest dependency', () => {
    const depths = cardDepths(cards);
    expect(depths.get('api')).toBe(0);
    expect(depths.get('form')).toBe(1);
    expect(depths.get('page')).toBe(2);
    expect(depths.get('docs')).toBe(0);
  });

  it('gives every card its own spot, stacking each column in board order', () => {
    const positions = layoutCards(cards);
    expect(positions).toHaveLength(cards.length);
    const spots = new Set(positions.map((position) => `${position.x},${position.y}`));
    expect(spots.size).toBe(cards.length);
    const api = positions.find((position) => position.id === 'api')!;
    const docs = positions.find((position) => position.id === 'docs')!;
    expect(docs.x).toBe(api.x);
    expect(docs.y).toBeGreaterThan(api.y);
  });

  it('lays a realistic board out in columns, without overlapping the cards', () => {
    // What the hand-rolled layout could not do: forty independent cards became one tall ladder with the edges to the
    // few dependent cards crossing the whole picture. Dagre keeps the columns and picks the order inside them.
    const realistic = [
      ...Array.from({ length: 40 }, (_, index) => ({ id: `backlog-${index}`, dependsOn: [] as string[] })),
      { id: 'api', dependsOn: ['backlog-0'] },
      { id: 'page', dependsOn: ['api', 'backlog-1'] },
      { id: 'deploy', dependsOn: ['page'] },
    ];
    const positions = layoutCards(realistic);
    expect(positions).toHaveLength(realistic.length);

    const byId = new Map(positions.map((position) => [position.id, position]));
    // Depth still reads left to right: nothing that waits on something sits to its left.
    expect(byId.get('page')!.x).toBeGreaterThan(byId.get('api')!.x);
    expect(byId.get('deploy')!.x).toBeGreaterThan(byId.get('page')!.x);
    expect(byId.get('api')!.x).toBeGreaterThan(byId.get('backlog-0')!.x);

    // And no two cards are drawn on top of each other, which is what the 220x72 boxes are for.
    for (const left of positions) {
      for (const right of positions) {
        if (left.id === right.id) continue;
        const apart = Math.abs(left.x - right.x) >= 220 || Math.abs(left.y - right.y) >= 72;
        expect(apart, `${left.id} overlaps ${right.id}`).toBe(true);
      }
    }
  });

  it('survives a dependency cycle instead of looping', () => {
    const looped = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ];
    expect(layoutCards(looped)).toHaveLength(2);
  });

  it('ignores dependencies that point at cards that are not on the board', () => {
    expect(cardDepths([{ id: 'a', dependsOn: ['gone'] }]).get('a')).toBe(0);
  });

  it('lists only the agents holding a card in progress', () => {
    expect(agentLinks(cards)).toEqual([{ agent: 'claude', cardId: 'form' }]);
  });

  it('finds the cards that take part in a dependency', () => {
    expect([...connectedCardIds(cards)].sort()).toEqual(['api', 'form', 'page']);
  });
});
