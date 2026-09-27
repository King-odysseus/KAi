import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  MAX_PITCH,
  MAX_ZOOM,
  MIN_ZOOM,
  angleDelta,
  arcPoints,
  clampPitch,
  clampZoom,
  createOrb,
  fibonacciSphere,
  focusView,
  hitTest,
  nodeRadius,
  parseKnowledgeGraph,
  projectPoint,
  rotate,
  type Vec3,
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

const size = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const chord = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A larger graph: two tight clusters of linked notes plus loose ones. */
function bigGraph(clusters = 2, perCluster = 12, loose = 20): unknown {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  for (let c = 0; c < clusters; c++) {
    for (let i = 0; i < perCluster; i++) {
      nodes.push({ id: `c${c}-n${i}`, type: 'patterns', project: `p${c}`, linkCount: 2 });
      if (i > 0) edges.push({ source: `c${c}-n${i}`, target: `c${c}-n${i - 1}` });
    }
  }
  for (let i = 0; i < loose; i++) nodes.push({ id: `loose-${i}`, type: 'bugs', project: `l${i % 3}`, linkCount: 0 });
  return { nodes, edges };
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

describe('orb layout', () => {
  it('always puts every note and every decorative particle on the surface of a sphere', () => {
    for (const graph of [raw, bigGraph(), { nodes: [{ id: 'only' }], edges: [] }, { nodes: [], edges: [] }]) {
      const orb = createOrb(parseKnowledgeGraph(graph));
      for (const node of orb.nodes) expect(size(node.p)).toBeCloseTo(1, 6);
      for (const point of orb.shell) expect(size(point)).toBeCloseTo(1, 6);
    }
  });

  it('spreads decorative particles evenly, so the orb reads as a sphere whatever the data', () => {
    const shell = fibonacciSphere(240);
    expect(shell).toHaveLength(240);
    const centroid = shell.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y, z: sum.z + p.z }), { x: 0, y: 0, z: 0 });
    expect(size({ x: centroid.x / 240, y: centroid.y / 240, z: centroid.z / 240 })).toBeLessThan(0.02);
  });

  it('is the same every time for the same notes', () => {
    const first = createOrb(parseKnowledgeGraph(bigGraph()));
    const second = createOrb(parseKnowledgeGraph(bigGraph()));
    expect(first.nodes.map((node) => node.p)).toEqual(second.nodes.map((node) => node.p));
  });

  it('keeps notes apart instead of stacking them', () => {
    const orb = createOrb(parseKnowledgeGraph(bigGraph()));
    let closest = Infinity;
    for (let i = 0; i < orb.nodes.length; i++) {
      for (let j = i + 1; j < orb.nodes.length; j++) closest = Math.min(closest, chord(orb.nodes[i].p, orb.nodes[j].p));
    }
    expect(closest).toBeGreaterThan(0.04);
  });

  it('pulls linked notes closer together than unlinked ones', () => {
    const orb = createOrb(parseKnowledgeGraph(bigGraph()));
    const linked = orb.edges.map(({ source, target }) => chord(source.p, target.p));
    const linkedKeys = new Set(orb.edges.map(({ source, target }) => [source.id, target.id].sort().join('|')));
    const unlinked: number[] = [];
    for (let i = 0; i < orb.nodes.length; i++) {
      for (let j = i + 1; j < orb.nodes.length; j++) {
        if (!linkedKeys.has([orb.nodes[i].id, orb.nodes[j].id].sort().join('|'))) unlinked.push(chord(orb.nodes[i].p, orb.nodes[j].p));
      }
    }
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(linked)).toBeLessThan(mean(unlinked) * 0.6);
  });

  it('scales dots with how connected the note is', () => {
    expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(10_000)).toBeLessThanOrEqual(11);
  });
});

describe('orb view', () => {
  it('turning to focus a note brings it to the front, centred', () => {
    const orb = createOrb(parseKnowledgeGraph(bigGraph()));
    for (const node of orb.nodes.slice(0, 12)) {
      const { yaw, pitch } = focusView(node.p);
      const turned = rotate(node.p, yaw, pitch);
      if (Math.abs(node.p.y) < 0.97) {
        expect(turned.x).toBeCloseTo(0, 6);
        expect(turned.y).toBeCloseTo(0, 6);
        expect(turned.z).toBeCloseTo(1, 6);
      }
    }
  });

  it('draws the near side larger than the far side and the front point at the centre', () => {
    const front = projectPoint({ x: 0, y: 0, z: 1 }, { yaw: 0, pitch: 0, zoom: 1 }, 800, 400);
    const back = projectPoint({ x: 0, y: 0, z: -1 }, { yaw: 0, pitch: 0, zoom: 1 }, 800, 400);
    expect([front.x, front.y]).toEqual([400, 200]);
    expect(front.scale).toBeGreaterThan(back.scale);
    expect(front.z).toBeCloseTo(1, 6);
    expect(back.z).toBeCloseTo(-1, 6);
  });

  it('zooming in spreads points further from the centre', () => {
    const point = { x: 0.6, y: 0, z: 0.8 };
    const near = projectPoint(point, { ...DEFAULT_VIEW, yaw: 0, pitch: 0, zoom: 1 }, 800, 400);
    const closer = projectPoint(point, { ...DEFAULT_VIEW, yaw: 0, pitch: 0, zoom: 2 }, 800, 400);
    expect(Math.abs(closer.x - 400)).toBeGreaterThan(Math.abs(near.x - 400));
  });

  it('holds zoom and pitch between their limits', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(1.2)).toBe(1.2);
    expect(clampPitch(9)).toBe(MAX_PITCH);
    expect(clampPitch(-9)).toBe(-MAX_PITCH);
  });

  it('takes the short way round when turning toward a note', () => {
    expect(angleDelta(0.1, 0.3)).toBeCloseTo(0.2, 9);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 9);
    expect(Math.abs(angleDelta(0, 7))).toBeLessThan(Math.PI);
  });
});

describe('picking', () => {
  const orb = createOrb(parseKnowledgeGraph(raw));
  const view = { yaw: 0, pitch: 0, zoom: 1 };

  it('finds the note under the pointer on the near side', () => {
    const near = orb.nodes.find((node) => rotate(node.p, view.yaw, view.pitch).z > 0.3);
    expect(near).toBeDefined();
    if (!near) return;
    const at = projectPoint(near.p, view, 800, 400);
    expect(hitTest(orb, view, 800, 400, at.x, at.y)?.id).toBe(near.id);
  });

  it('ignores notes on the far side, which the viewer cannot see', () => {
    const far = orb.nodes.find((node) => rotate(node.p, view.yaw, view.pitch).z < -0.4);
    if (!far) return;
    const at = projectPoint(far.p, view, 800, 400);
    const found = hitTest(orb, view, 800, 400, at.x, at.y);
    expect(found?.id).not.toBe(far.id);
  });

  it('returns nothing where there is no note', () => {
    expect(hitTest(orb, view, 800, 400, -500, -500)).toBeNull();
  });
});

describe('link arcs', () => {
  const a: Vec3 = { x: 1, y: 0, z: 0 };
  const b: Vec3 = { x: 0, y: 0, z: 1 };

  it('starts and ends on the two notes and bows outward in between', () => {
    const points = arcPoints(a, b, 12, 0.2);
    expect(points).toHaveLength(13);
    expect(points[0]).toEqual(a);
    expect(size(points[12])).toBeCloseTo(1, 6);
    expect(size(points[6])).toBeGreaterThan(1.05);
  });

  it('copes with two notes on the same spot', () => {
    const points = arcPoints(a, { ...a }, 6, 0.2);
    expect(points.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
  });
});
