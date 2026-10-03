import { graphlib, layout } from '@dagrejs/dagre';
import type { FlowGraph, FlowGraphNode } from './flow-diagram';

/**
 * Places the boxes of a flow graph in layers with the library's layout, so branches fan out, the lines between
 * boxes avoid crossing where they can, and nothing is stacked on anything else. Pure: same graph, same places.
 */

export type FlowDirection = 'LR' | 'TB';

export const FLOW_NODE_WIDTH = 210;
const TITLE_WIDTH = 170;
const TITLE_CHARS_PER_LINE = 20;
const TITLE_MAX_LINES = 4;
/** The line box the stylesheet draws text in; every height below is a whole number of these. */
const LINE_HEIGHT = 15;
/**
 * The breathing room above and below the text, as the body's margin. It has to be a margin and not padding: a scroll
 * container clips at its padding box, so padding would let the next line show through under the last one.
 */
const BODY_GAP = 11;
/** The title box has no header, just its own padding. */
const TITLE_PADDING = 20;
/** The card's top and bottom border together. The drawn border can be fractional, so this rounds up. */
const CARD_BORDER = 2;
/** The header strip names the kind of step and its number. The stylesheet sets the same height. */
export const FLOW_HEADER_HEIGHT = 22;
/**
 * A card reserves room for this many lines of text and no more; the body scrolls when a step says more, so a long
 * step is readable inside its card instead of being cut off at an ellipsis.
 */
export const FLOW_MAX_LINES = 4;
const CHARACTERS_PER_LINE = 30;

export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The text area inside the card: a whole number of lines plus the body's padding. The card is drawn at this height
   * whatever the layout reserved, so the body ends on a line and never shows a sliver of the line below.
   */
  bodyHeight: number;
}

export function nodeSize(node: FlowGraphNode): { width: number; height: number; bodyHeight: number } {
  if (node.kind === 'title') {
    const lines = Math.min(TITLE_MAX_LINES, Math.max(1, Math.ceil(node.text.length / TITLE_CHARS_PER_LINE)));
    const bodyHeight = TITLE_PADDING + LINE_HEIGHT * lines;
    return { width: TITLE_WIDTH, height: CARD_BORDER + bodyHeight, bodyHeight };
  }
  const lines = Math.min(FLOW_MAX_LINES, Math.max(1, Math.ceil(node.text.length / CHARACTERS_PER_LINE)));
  const bodyHeight = LINE_HEIGHT * lines;
  return { width: FLOW_NODE_WIDTH, height: CARD_BORDER + FLOW_HEADER_HEIGHT + BODY_GAP + bodyHeight, bodyHeight };
}

/** Top-left corner and size of every box, keyed by node id. */
export function layoutFlowGraph(graph: FlowGraph, direction: FlowDirection = 'LR'): Map<string, FlowBox> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: direction === 'LR' ? 34 : 46, ranksep: direction === 'LR' ? 70 : 54, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map(graph.nodes.map((node) => [node.id, nodeSize(node)]));
  for (const node of graph.nodes) g.setNode(node.id, sizes.get(node.id)!);
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  layout(g);
  const boxes = new Map<string, FlowBox>();
  for (const node of graph.nodes) {
    const placed = g.node(node.id);
    const bodyHeight = sizes.get(node.id)!.bodyHeight;
    boxes.set(node.id, { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2, width: placed.width, height: placed.height, bodyHeight });
  }
  return boxes;
}
