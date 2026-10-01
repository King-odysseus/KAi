import { graphlib, layout } from '@dagrejs/dagre';
import type { FlowGraph, FlowGraphNode } from './flow-diagram';

/**
 * Places the boxes of a flow graph in layers with the library's layout, so branches fan out, the lines between
 * boxes avoid crossing where they can, and nothing is stacked on anything else. Pure: same graph, same places.
 */

export type FlowDirection = 'LR' | 'TB';

export const FLOW_NODE_WIDTH = 210;
const TITLE_WIDTH = 170;
const LINE_HEIGHT = 15;
const PADDING_HEIGHT = 24;
/** The boxes show at most this many lines of text; the detail strip shows the rest. */
export const FLOW_MAX_LINES = 4;
const CHARACTERS_PER_LINE = 30;

export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function nodeSize(node: FlowGraphNode): { width: number; height: number } {
  if (node.kind === 'title') return { width: TITLE_WIDTH, height: PADDING_HEIGHT + LINE_HEIGHT * Math.min(2, Math.ceil(node.text.length / 22)) };
  const lines = Math.min(FLOW_MAX_LINES, Math.max(1, Math.ceil(node.text.length / CHARACTERS_PER_LINE)));
  return { width: FLOW_NODE_WIDTH, height: PADDING_HEIGHT + LINE_HEIGHT * lines };
}

/** Top-left corner and size of every box, keyed by node id. */
export function layoutFlowGraph(graph: FlowGraph, direction: FlowDirection = 'LR'): Map<string, FlowBox> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: direction === 'LR' ? 34 : 46, ranksep: direction === 'LR' ? 70 : 54, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) g.setNode(node.id, nodeSize(node));
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  layout(g);
  const boxes = new Map<string, FlowBox>();
  for (const node of graph.nodes) {
    const placed = g.node(node.id);
    boxes.set(node.id, { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2, width: placed.width, height: placed.height });
  }
  return boxes;
}
