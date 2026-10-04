import { graphlib, layout } from '@dagrejs/dagre';
import type { BoardCard } from '@kai/contracts';

/**
 * Pure layout for the board graph: cards in columns by how many cards must finish before them, so the left edge is
 * what can start now and the right edge is what waits on everything.
 *
 * The columns are the same idea as before; what changed is who decides the places. This used to stack each column in
 * board order and centre it, which is fine for a handful of cards and unreadable for a real board: a column of forty
 * independent cards (which is what an unplanned backlog is) became one tall ladder, and the edges to the few cards
 * that did depend on something crossed the whole picture to reach them. The flow diagram next door already used
 * dagre, which orders the cards *within* a column and picks the order that crosses fewest edges — this is the same
 * library doing the same job, so a board now reads like a flow rather than a swarm.
 */

/**
 * The card's drawn width, from the stylesheet. Dagre needs a real size to keep boxes apart, and the columns are the
 * pitch they always were: `GRAPH_COLUMN_WIDTH` apart horizontally, `GRAPH_ROW_HEIGHT` vertically, so the numbers
 * below are the gaps left once a card's own box is accounted for.
 */
const GRAPH_NODE_WIDTH = 220;
const GRAPH_NODE_HEIGHT = 72;
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

/**
 * One column per depth, with dagre choosing where each card sits inside its column: it orders the cards so the lines
 * between them cross as little as possible, and centres each column against its neighbours.
 *
 * Cards are added in board order, which is what dagre falls back on for two cards it has no reason to order either
 * way — so a board with no dependencies at all still lays out exactly as it read.
 */
export function layoutCards(cards: readonly Pick<BoardCard, 'id' | 'dependsOn'>[]): GraphPosition[] {
  const graph = new graphlib.Graph();
  graph.setGraph({
    rankdir: 'LR',
    ranksep: GRAPH_COLUMN_WIDTH - GRAPH_NODE_WIDTH,
    nodesep: GRAPH_ROW_HEIGHT - GRAPH_NODE_HEIGHT,
    // The board is read top to bottom in the order it was written, so a tie is broken by insertion rather than by
    // dagre's own default ordering, which moves cards around on every relayout.
    ranker: 'tight-tree',
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const known = new Set(cards.map((card) => card.id));
  for (const card of cards) graph.setNode(card.id, { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT });
  for (const card of cards) {
    for (const dependency of card.dependsOn) {
      // A dependency on a card that is not on the board is not an edge; it is ignored, as it always was.
      if (known.has(dependency)) graph.setEdge(dependency, card.id);
    }
  }
  layout(graph);
  return cards.map((card) => {
    // Dagre answers with each node's centre; React Flow wants its top-left corner.
    const placed = graph.node(card.id) as { x: number; y: number };
    return { id: card.id, x: Math.round(placed.x - GRAPH_NODE_WIDTH / 2), y: Math.round(placed.y - GRAPH_NODE_HEIGHT / 2) };
  });
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
