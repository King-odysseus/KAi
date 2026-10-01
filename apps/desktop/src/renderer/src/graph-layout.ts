import type { BoardCard } from '@kai/contracts';

/**
 * Pure layout for the board graph. Cards sit in columns by how many cards must finish before them, so the left
 * edge is what can start now and the right edge is what waits on everything. No library: React Flow draws, this
 * decides where.
 */

export const GRAPH_COLUMN_WIDTH = 280;
export const GRAPH_ROW_HEIGHT = 92;

/** How deep each card sits: 0 for a card with no dependencies, else one more than its deepest dependency. */
export function cardDepths(cards: readonly Pick<BoardCard, 'id' | 'dependsOn'>[]): Map<string, number> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    // A dependency cycle cannot be laid out; treat the repeated card as a root instead of looping.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const card = byId.get(id);
    const depth = card ? card.dependsOn.filter((dependency) => byId.has(dependency)).reduce((deepest, dependency) => Math.max(deepest, depthOf(dependency) + 1), 0) : 0;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const card of cards) depthOf(card.id);
  return depths;
}

export interface GraphPosition {
  id: string;
  x: number;
  y: number;
}

/** One column per depth, cards stacked in board order, each column centred on the tallest one. */
export function layoutCards(cards: readonly Pick<BoardCard, 'id' | 'dependsOn'>[]): GraphPosition[] {
  const depths = cardDepths(cards);
  const columns = new Map<number, string[]>();
  for (const card of cards) {
    const depth = depths.get(card.id) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), card.id]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const positions: GraphPosition[] = [];
  for (const [depth, ids] of columns) {
    const offset = ((tallest - ids.length) * GRAPH_ROW_HEIGHT) / 2;
    ids.forEach((id, index) => positions.push({ id, x: depth * GRAPH_COLUMN_WIDTH, y: offset + index * GRAPH_ROW_HEIGHT }));
  }
  return positions;
}

export interface AgentLink {
  agent: string;
  cardId: string;
}

/** Which agent holds which card right now, for the live run map. */
export function agentLinks(cards: readonly Pick<BoardCard, 'id' | 'status' | 'claimedBy'>[]): AgentLink[] {
  return cards.flatMap((card) => (card.claimedBy && card.status === 'inProgress' ? [{ agent: card.claimedBy, cardId: card.id }] : []));
}

/** The cards with at least one dependency or dependent, which is what a dependency view is worth drawing. */
export function connectedCardIds(cards: readonly Pick<BoardCard, 'id' | 'dependsOn'>[]): Set<string> {
  const ids = new Set(cards.map((card) => card.id));
  const connected = new Set<string>();
  for (const card of cards) {
    for (const dependency of card.dependsOn) {
      if (!ids.has(dependency)) continue;
      connected.add(card.id);
      connected.add(dependency);
    }
  }
  return connected;
}
