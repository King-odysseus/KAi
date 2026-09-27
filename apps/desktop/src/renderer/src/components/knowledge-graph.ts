/**
 * The data and geometry behind the C1 knowledge map.
 *
 * C1's `/api/graph` returns the notes it remembers (nodes) and the `Related:` links between them (edges). The map draws
 * them as an orb: every note sits on the surface of a sphere, notes that link to each other are pulled close together,
 * and the whole sphere turns. Nothing here touches the DOM: parsing is defensive because the daemon may be older or
 * newer than the app, and the layout and projection are plain maths a test can run and inspect.
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

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface OrbNode extends GraphNode {
  /** A point on the unit sphere. */
  p: Vec3;
  radius: number;
}

export interface Orb {
  nodes: OrbNode[];
  edges: Array<{ source: OrbNode; target: OrbNode }>;
  neighbours: Map<string, string[]>;
  /** Decorative particles spread evenly over the same sphere, so the orb reads as an orb whatever the data. */
  shell: Vec3[];
}

/** Bigger dots for notes that connect to more, so the ideas a project keeps returning to stand out. */
export function nodeRadius(linkCount: number): number {
  return Math.min(11, 3.2 + Math.sqrt(Math.max(0, linkCount)) * 2.1);
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalized(v: Vec3): Vec3 {
  const size = length(v) || 1;
  return { x: v.x / size, y: v.y / size, z: v.z / size };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** `count` points spread evenly over the unit sphere, running pole to pole so neighbouring indices sit close together. */
export function fibonacciSphere(count: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (2 * i) / (count - 1);
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = GOLDEN_ANGLE * i;
    points.push({ x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring });
  }
  return points;
}

/** A small seeded generator, so a given graph always settles into the same orb. */
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

/**
 * Move linked notes together and unlinked ones apart while keeping every note on the sphere. Each step pushes points
 * away from their neighbours, pulls linked pairs toward a resting distance, drops the sideways part of the move onto the
 * surface, and puts the point back on it.
 */
function relax(nodes: OrbNode[], edges: Orb['edges'], iterations: number): void {
  const count = nodes.length;
  if (count < 2) return;
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const rest = Math.min(0.7, Math.max(0.14, 1.7 / Math.sqrt(count)));
  const repel = 0.004;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 1 - iteration / iterations;
    const limit = 0.06 * (0.2 + 0.8 * cooling);
    const move = nodes.map((): Vec3 => ({ x: 0, y: 0, z: 0 }));

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = nodes[i].p;
        const b = nodes[j].p;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz + 1e-4;
        const push = repel / (distanceSquared * Math.sqrt(distanceSquared));
        move[i].x += dx * push;
        move[i].y += dy * push;
        move[i].z += dz * push;
        move[j].x -= dx * push;
        move[j].y -= dy * push;
        move[j].z -= dz * push;
      }
    }

    for (const { source, target } of edges) {
      const i = index.get(source.id);
      const j = index.get(target.id);
      if (i === undefined || j === undefined) continue;
      const dx = target.p.x - source.p.x;
      const dy = target.p.y - source.p.y;
      const dz = target.p.z - source.p.z;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-4);
      const pull = ((distance - rest) * 0.35) / distance;
      move[i].x += dx * pull;
      move[i].y += dy * pull;
      move[i].z += dz * pull;
      move[j].x -= dx * pull;
      move[j].y -= dy * pull;
      move[j].z -= dz * pull;
    }

    for (let i = 0; i < count; i++) {
      const p = nodes[i].p;
      const m = move[i];
      // Only the part of the move along the surface counts; the rest would lift the note off the sphere.
      const radial = m.x * p.x + m.y * p.y + m.z * p.z;
      let tx = m.x - radial * p.x;
      let ty = m.y - radial * p.y;
      let tz = m.z - radial * p.z;
      const size = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (size > limit) {
        tx = (tx / size) * limit;
        ty = (ty / size) * limit;
        tz = (tz / size) * limit;
      }
      nodes[i].p = normalized({ x: p.x + tx, y: p.y + ty, z: p.z + tz });
    }
  }
}

export const SHELL_PARTICLES = 240;

/**
 * Lay the notes out on a sphere. Notes from the same project start next to each other, then linked notes are pulled
 * together, so a project's ideas end up as a patch of the orb and the links between projects cross between patches.
 */
export function createOrb(graph: KnowledgeGraph, shellCount = SHELL_PARTICLES): Orb {
  const random = mulberry32(seedOf(graph));
  const order = [...graph.nodes].sort((a, b) => a.project.localeCompare(b.project) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const start = fibonacciSphere(order.length);
  const placed = new Map<string, Vec3>();
  order.forEach((node, position) => {
    const jitter = 0.02;
    placed.set(node.id, normalized({
      x: start[position].x + (random() - 0.5) * jitter,
      y: start[position].y + (random() - 0.5) * jitter,
      z: start[position].z + (random() - 0.5) * jitter,
    }));
  });

  const nodes: OrbNode[] = graph.nodes.map((node) => ({ ...node, p: placed.get(node.id) ?? { x: 0, y: 0, z: 1 }, radius: nodeRadius(node.linkCount) }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: Orb['edges'] = [];
  const neighbours = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    edges.push({ source, target });
    neighbours.get(source.id)?.push(target.id);
    neighbours.get(target.id)?.push(source.id);
  }
  relax(nodes, edges, 240);
  return { nodes, edges, neighbours, shell: fibonacciSphere(shellCount) };
}

/** Where the orb is turned to and how close it is: rotation about the vertical axis, then about the horizontal one. */
export interface OrbView {
  yaw: number;
  pitch: number;
  zoom: number;
}

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3;
export const MAX_PITCH = 1.35;
export const DEFAULT_VIEW: OrbView = { yaw: 0.5, pitch: 0.28, zoom: 1 };
const CAMERA_DISTANCE = 3.4;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch));
}

/** Turn a point: first about the vertical axis by `yaw`, then about the horizontal axis by `pitch`. */
export function rotate(v: Vec3, yaw: number, pitch: number): Vec3 {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x1 = v.x * cosY + v.z * sinY;
  const z1 = -v.x * sinY + v.z * cosY;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  return { x: x1, y: v.y * cosP - z1 * sinP, z: v.y * sinP + z1 * cosP };
}

/** The turn that brings a point on the sphere to face the viewer. */
export function focusView(p: Vec3): { yaw: number; pitch: number } {
  const yaw = Math.atan2(-p.x, p.z);
  const front = Math.sqrt(p.x * p.x + p.z * p.z);
  return { yaw, pitch: clampPitch(Math.atan2(p.y, front)) };
}

export interface Projected {
  x: number;
  y: number;
  /** How far toward the viewer the point faces: 1 is dead centre on the near side, -1 the far side. */
  z: number;
  /** Perspective scale, above 1 for points on the near side. */
  scale: number;
}

/** The pixel radius of the orb itself for a canvas of this size. */
export function orbRadius(width: number, height: number, zoom: number): number {
  return Math.min(width, height) * 0.4 * zoom;
}

export function projectPoint(v: Vec3, view: OrbView, width: number, height: number): Projected {
  const r = rotate(v, view.yaw, view.pitch);
  const radius = orbRadius(width, height, view.zoom);
  const scale = CAMERA_DISTANCE / (CAMERA_DISTANCE - r.z);
  return { x: width / 2 + r.x * radius * scale, y: height / 2 - r.y * radius * scale, z: r.z, scale };
}

/** How large a note's dot is on screen, growing a little with zoom and with nearness. */
export function nodeScreenRadius(node: OrbNode, projected: Projected, zoom: number): number {
  return node.radius * projected.scale * (0.75 + 0.25 * zoom);
}

/**
 * The note under a screen point. Notes on the far side of the orb are ignored so a click cannot land on something the
 * viewer cannot see; where dots overlap, the nearer one wins.
 */
export function hitTest(orb: Orb, view: OrbView, width: number, height: number, x: number, y: number, slack = 4): OrbNode | null {
  let best: OrbNode | null = null;
  let bestDepth = -Infinity;
  for (const node of orb.nodes) {
    const projected = projectPoint(node.p, view, width, height);
    if (projected.z < -0.1) continue;
    if (Math.hypot(projected.x - x, projected.y - y) > nodeScreenRadius(node, projected, view.zoom) + slack) continue;
    if (projected.z > bestDepth) {
      best = node;
      bestDepth = projected.z;
    }
  }
  return best;
}

/**
 * Points along the curve joining two notes. The curve follows the sphere and bows outward in the middle, so links read
 * as arcs floating over the orb instead of chords cutting through it.
 */
export function arcPoints(a: Vec3, b: Vec3, segments = 12, lift = 0.18): Vec3[] {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let point: Vec3;
    if (sine < 1e-4) {
      point = normalized({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    } else {
      const wa = Math.sin((1 - t) * angle) / sine;
      const wb = Math.sin(t * angle) / sine;
      point = { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb };
    }
    const height = 1 + lift * Math.sin(Math.PI * t) * Math.min(1, angle / 1.2);
    points.push({ x: point.x * height, y: point.y * height, z: point.z * height });
  }
  return points;
}

/** The shortest signed way round from one angle to another. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
