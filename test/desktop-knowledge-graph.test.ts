import { describe, expect, it } from 'vitest';
import {
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  createSimulation,
  nodeAt,
  nodeRadius,
  parseKnowledgeGraph,
  settleSimulation,
  stepSimulation,
  toWorld,
  zoomView,
} from '../apps/desktop/src/renderer/src/components/knowledge-graph';

const raw = {
  nodes: [
    { id: 'Payslip print 406', type: 'bugs', date: '2026-06-01', project: 'tijhabooks', agent: 'codex', linkCount: 2 },
    { id: 'Payslip print 502', type: 'bugs', date: '2026-06-10', project: 'tijhabooks', agent: 'qwen', linkCount: 1 },
    { id: 'Retry PDF proxy calls', type: 'patterns', date: '2026-06-12', project: 'tijhabooks', agent: 'claude-code', linkCount: 1 },
    { id: 'Unrelated island', type: 'decisions', date: '2026-05-01', project: 'other', agent: 'codex', linkCount: 0 },
    { id: 'Second island', type: 'gotchas', date: '2026-05-02', project: 'other', agent: 'codex', linkCount: 0 },
  ],
  edges: [
    { source: 'Payslip print 502', target: 'Payslip print 406' },
    { source: 'Retry PDF proxy calls', target: 'Payslip print 406' },
  ],
  totalNodes: 5,
  totalEdges: 2,
};

function distance(sim: ReturnType<typeof createSimulation>, a: string, b: string): number {
  const first = sim.nodes.find((node) => node.id === a);
  const second = sim.nodes.find((node) => node.id === b);
  if (!first || !second) throw new Error(`No note named ${a} or ${b}`);
  return Math.hypot(first.x - second.x, first.y - second.y);
}

describe('knowledge graph parsing', () => {
  it('reads nodes and edges from the daemon response', () => {
    const graph = parseKnowledgeGraph(raw);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({ id: 'Payslip print 406', type: 'bugs', project: 'tijhabooks', linkCount: 2 });
  });

  it('drops malformed rows, dangling edges, self links and repeated edges instead of throwing', () => {
    const graph = parseKnowledgeGraph({
      nodes: [{ id: 'A', type: 'weird' }, { id: 'A' }, { id: '' }, null, { id: 'B', linkCount: -4 }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
        { source: 'A', target: 'A' },
        { source: 'A', target: 'missing' },
        'nonsense',
      ],
    });
    expect(graph.nodes.map((node) => node.id)).toEqual(['A', 'B']);
    expect(graph.nodes[0].type).toBe('other');
    expect(graph.nodes[1].linkCount).toBe(0);
    expect(graph.edges).toEqual([{ source: 'A', target: 'B' }]);
  });

  it('returns an empty graph for anything that is not a graph', () => {
    expect(parseKnowledgeGraph(undefined)).toMatchObject({ nodes: [], edges: [] });
    expect(parseKnowledgeGraph('nope')).toMatchObject({ nodes: [], edges: [] });
  });
});

describe('knowledge graph layout', () => {
  it('is the same every time for the same notes', () => {
    const first = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    const second = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    settleSimulation(first);
    settleSimulation(second);
    expect(first.nodes.map((node) => [Math.round(node.x), Math.round(node.y)]))
      .toEqual(second.nodes.map((node) => [Math.round(node.x), Math.round(node.y)]));
  });

  it('keeps every note inside the canvas with finite positions', () => {
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    settleSimulation(sim);
    for (const node of sim.nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(node.radius);
      expect(node.x).toBeLessThanOrEqual(600 - node.radius);
      expect(node.y).toBeGreaterThanOrEqual(node.radius);
      expect(node.y).toBeLessThanOrEqual(360 - node.radius);
    }
  });

  it('pulls linked notes together and pushes unlinked ones apart', () => {
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    settleSimulation(sim);
    expect(distance(sim, 'Payslip print 502', 'Payslip print 406')).toBeLessThan(120);
    expect(distance(sim, 'Unrelated island', 'Second island')).toBeGreaterThan(distance(sim, 'Payslip print 502', 'Payslip print 406'));
  });

  it('separates two notes that start on the same spot', () => {
    const sim = createSimulation(parseKnowledgeGraph({ nodes: [{ id: 'A' }, { id: 'B' }], edges: [] }), 400, 300);
    sim.nodes[0].x = sim.nodes[1].x = 200;
    sim.nodes[0].y = sim.nodes[1].y = 150;
    settleSimulation(sim, 60);
    expect(distance(sim, 'A', 'B')).toBeGreaterThan(5);
  });

  it('cools to a floor rather than to zero, so the map can keep drifting', () => {
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    settleSimulation(sim, 1000);
    expect(sim.alpha).toBeGreaterThan(0);
    stepSimulation(sim);
    expect(sim.alpha).toBeGreaterThan(0);
  });

  it('leaves a held note where the pointer put it', () => {
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    const held = sim.nodes[0];
    held.pinned = true;
    held.x = 100;
    held.y = 100;
    settleSimulation(sim, 50);
    expect([held.x, held.y]).toEqual([100, 100]);
  });

  it('scales dots with how connected the note is and finds the one under a point', () => {
    expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(10_000)).toBeLessThanOrEqual(13);
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    const target = sim.nodes[2];
    expect(nodeAt(sim, target.x, target.y)?.id).toBe(target.id);
    expect(nodeAt(sim, -500, -500)).toBeNull();
  });
});

describe('knowledge graph zoom', () => {
  const screenOf = (view: { scale: number; x: number; y: number }, world: { x: number; y: number }) => ({
    x: world.x * view.scale + view.x,
    y: world.y * view.scale + view.y,
  });

  it('keeps the point under the cursor fixed while zooming in and out', () => {
    let view = { ...IDENTITY_VIEW, x: 30, y: -12 };
    const cursor = { x: 240, y: 130 };
    const before = toWorld(view, cursor);
    for (const factor of [1.35, 1.35, 0.6, 2, 0.5]) {
      view = zoomView(view, factor, cursor.x, cursor.y);
      const under = screenOf(view, before);
      expect(under.x).toBeCloseTo(cursor.x, 6);
      expect(under.y).toBeCloseTo(cursor.y, 6);
    }
  });

  it('holds the scale between the limits and returns the same view when nothing changes', () => {
    let view = IDENTITY_VIEW;
    for (let i = 0; i < 30; i++) view = zoomView(view, 1.5, 100, 100);
    expect(view.scale).toBe(MAX_ZOOM);
    expect(zoomView(view, 1.5, 100, 100)).toBe(view);
    for (let i = 0; i < 60; i++) view = zoomView(view, 0.6, 100, 100);
    expect(view.scale).toBe(MIN_ZOOM);
    expect(zoomView(view, 0.6, 100, 100)).toBe(view);
  });

  it('maps a screen point back to the layout after zooming and panning', () => {
    const view = { scale: 2, x: 50, y: 20 };
    expect(toWorld(view, { x: 250, y: 120 })).toEqual({ x: 100, y: 50 });
    expect(toWorld(IDENTITY_VIEW, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
  });

  it('finds a dot at its zoomed position when the pick is made in layout coordinates', () => {
    const sim = createSimulation(parseKnowledgeGraph(raw), 600, 360);
    const target = sim.nodes[1];
    const view = zoomView(IDENTITY_VIEW, 2.5, 300, 180);
    const world = toWorld(view, screenOf(view, target));
    expect(nodeAt(sim, world.x, world.y, 5 / view.scale)?.id).toBe(target.id);
  });
});
