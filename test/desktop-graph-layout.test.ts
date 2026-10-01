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
