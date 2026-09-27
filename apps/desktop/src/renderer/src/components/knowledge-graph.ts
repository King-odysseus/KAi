/**
 * The data and layout behind the C1 knowledge map.
 *
 * C1's `/api/graph` returns the notes it remembers (nodes) and the `Related:` links between them (edges). Nothing here
 * touches the DOM: parsing is defensive because the daemon may be older or newer than the app, and the layout is a small
 * force simulation that a test can run to a settled state and inspect.
 */

export type GraphNodeType = 'bugs' | 'decisions' | 'gotchas' | 'patterns' | 'other';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  date: string;
  project: string;
  agent: string;
  linkCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
}

export const GRAPH_TYPE_LABEL: Record<GraphNodeType, string> = {
  bugs: 'Bug',
  decisions: 'Decision',
  gotchas: 'Gotcha',
  patterns: 'Pattern',
  other: 'Note',
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function typeOf(value: unknown): GraphNodeType {
  return value === 'bugs' || value === 'decisions' || value === 'gotchas' || value === 'patterns' ? value : 'other';
}

/** Read whatever the daemon sent into a graph the map can draw, dropping edges that point at notes it did not send. */
export function parseKnowledgeGraph(raw: unknown): KnowledgeGraph {
  const body = recordOf(raw);
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const item of Array.isArray(body.nodes) ? body.nodes : []) {
    const node = recordOf(item);
    const id = text(node.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const linkCount = Number(node.linkCount);
    nodes.push({
      id,
      type: typeOf(node.type),
      date: text(node.date),
      project: text(node.project, 'global'),
      agent: text(node.agent, 'unknown'),
      linkCount: Number.isFinite(linkCount) && linkCount > 0 ? Math.round(linkCount) : 0,
    });
  }

  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const item of Array.isArray(body.edges) ? body.edges : []) {
    const edge = recordOf(item);
    const source = text(edge.source);
    const target = text(edge.target);
    if (!source || !target || source === target || !seen.has(source) || !seen.has(target)) continue;
    const key = [source, target].sort().join('\u0000');
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ source, target });
  }

  const totalNodes = Number(body.totalNodes);
  const totalEdges = Number(body.totalEdges);
  return {
    nodes,
    edges,
    totalNodes: Number.isFinite(totalNodes) ? totalNodes : nodes.length,
    totalEdges: Number.isFinite(totalEdges) ? totalEdges : edges.length,
  };
}

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** True while a pointer is holding the node, so the forces leave it where it is. */
  pinned: boolean;
}

export interface Simulation {
  nodes: SimNode[];
  edges: Array<{ source: SimNode; target: SimNode }>;
  neighbours: Map<string, string[]>;
  width: number;
  height: number;
  alpha: number;
}

/** A small seeded generator, so a given graph always starts from the same positions. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(graph: KnowledgeGraph): number {
  let hash = 2166136261;
  for (const node of graph.nodes) {
    for (let i = 0; i < node.id.length; i++) hash = Math.imul(hash ^ node.id.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/** Bigger dots for notes that connect to more, so the ideas a project keeps returning to stand out. */
export function nodeRadius(linkCount: number): number {
  return Math.min(13, 4 + Math.sqrt(Math.max(0, linkCount)) * 2.4);
}

export function createSimulation(graph: KnowledgeGraph, width: number, height: number): Simulation {
  const random = mulberry32(seedOf(graph));
  const cx = width / 2;
  const cy = height / 2;
  const spread = Math.max(40, Math.min(width, height) * 0.36);
  const nodes: SimNode[] = graph.nodes.map((node) => {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * spread;
    return {
      ...node,
      x: cx + Math.cos(angle) * distance,
      y: cy + Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      radius: nodeRadius(node.linkCount),
      pinned: false,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: Simulation['edges'] = [];
  const neighbours = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    edges.push({ source, target });
    neighbours.get(source.id)?.push(target.id);
    neighbours.get(target.id)?.push(source.id);
  }
  return { nodes, edges, neighbours, width, height, alpha: 1 };
}

export const SETTLED_ALPHA = 0.02;

/**
 * Advance the layout one tick. Unconnected notes push apart, linked notes pull together, and everything is held near
 * the middle so the map never drifts out of view. `alpha` cools toward a floor, so a settled map stops moving.
 */
export function stepSimulation(sim: Simulation): void {
  const { nodes, edges, width, height } = sim;
  const cx = width / 2;
  const cy = height / 2;
  const strength = Math.max(sim.alpha, SETTLED_ALPHA);
  const repulsion = 2600;
  const restLength = Math.max(34, Math.min(64, Math.sqrt((width * height) / Math.max(nodes.length, 1)) * 0.5));

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 0.01) {
        // Two notes on the same spot would never separate, so nudge one by a fixed amount.
        dx = 0.1 * (i % 2 === 0 ? 1 : -1);
        dy = 0.1;
        distanceSquared = dx * dx + dy * dy;
      }
      if (distanceSquared > 90_000) continue;
      const distance = Math.sqrt(distanceSquared);
      // Repulsion keeps a floor of its own so a settled map still holds unlinked notes apart instead of clumping.
      const push = (repulsion * Math.max(strength, 0.25)) / Math.max(distanceSquared, 64);
      const fx = (dx / distance) * push;
      const fy = (dy / distance) * push;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const { source, target } of edges) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const pull = (distance - restLength) * 0.05 * Math.max(strength, 0.25);
    const fx = (dx / distance) * pull;
    const fy = (dy / distance) * pull;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  for (const node of nodes) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx += (cx - node.x) * 0.006 * Math.max(strength, 0.2);
    node.vy += (cy - node.y) * 0.006 * Math.max(strength, 0.2);
    node.vx *= 0.82;
    node.vy *= 0.82;
    node.x += node.vx;
    node.y += node.vy;
    const pad = node.radius + 6;
    node.x = Math.min(width - pad, Math.max(pad, node.x));
    node.y = Math.min(height - pad, Math.max(pad, node.y));
  }
  sim.alpha = Math.max(SETTLED_ALPHA, sim.alpha * 0.985);
}

/** Run enough ticks for the layout to settle, for reduced-motion users and for tests. */
export function settleSimulation(sim: Simulation, ticks = 320): void {
  for (let i = 0; i < ticks; i++) stepSimulation(sim);
}

/** The note under a point, preferring the closest one when dots overlap. */
export function nodeAt(sim: Simulation, x: number, y: number, slack = 5): SimNode | null {
  let best: SimNode | null = null;
  let bestDistance = Infinity;
  for (const node of sim.nodes) {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= node.radius + slack && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}
