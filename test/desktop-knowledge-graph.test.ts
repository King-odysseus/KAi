import { describe, expect, it } from 'vitest';
import {
  createSimulation,
  nodeAt,
  nodeRadius,
  parseKnowledgeGraph,
  settleSimulation,
  stepSimulation,
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
