import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowDown, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildFlowGraph, type FlowGraph, type FlowGraphNode, type FlowJourney } from '../flow-diagram';
import { layoutFlowGraph, type FlowDirection } from '../flow-layout';

/**
 * The user journeys from the flows artifact, drawn with React Flow. Each journey has its own tab. A question in the
 * document becomes a decision that branches (its yes outcome beside it, "otherwise" carrying on), and the boxes are
 * laid out in layers so lines avoid crossing. It is interactive: pan and zoom, drag boxes to tidy them, click a step
 * to light up its path, step through with Previous and Next. It is drawn from the document's text, so editing the
 * flows and saving redraws it, and nothing here can drift from the file.
 */

/** Flows with more boxes than this open zoomed in, because fitted whole they are too small to read. */
const LONG_FLOW = 8;

const KIND_LABELS = { title: 'Flow', step: 'Step', screen: 'Screen', api: 'Endpoint', decision: 'Decision', outcome: 'Outcome' } as const;

/** The title box keeps its own class, which the stylesheet colours; every other box is named after its kind. */
function kindClass(kind: string): string {
  return kind === 'title' ? 'flow-title' : kind;
}

interface FlowBoxData extends Record<string, unknown> {
  text: string;
  kind: FlowGraphNode['kind'];
  /** The step's place in the journey, shown in the header. Zero for the title and for a branch's outcome. */
  step: number;
  /** How tall the text area is drawn: a whole number of lines, so the body ends on a line, plus its padding. */
  bodyHeight: number;
}

type FlowBoxNode = Node<FlowBoxData, 'flowBox'>;

/**
 * One card: a header naming the kind of step and its number, over the step's own words. The card is a fixed height,
 * so a step that says more than fits scrolls inside its own body rather than being cut off at an ellipsis. `nowheel`
 * keeps that inner scroll from zooming the canvas out from under the reader.
 */
function FlowBoxCard({ data, sourcePosition, targetPosition }: NodeProps<FlowBoxNode>): ReactNode {
  if (data.kind === 'title') {
    return (
      <>
        <Handle type="target" position={targetPosition ?? Position.Left} />
        <div className="flow-node-title">{data.text}</div>
        <Handle type="source" position={sourcePosition ?? Position.Right} />
      </>
    );
  }
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} />
      <div className="flow-node-head">
        <span className="flow-node-kind">{KIND_LABELS[data.kind]}</span>
        {data.step > 0 ? <span className="flow-node-step">{data.step}</span> : null}
      </div>
      <div className="flow-node-body nowheel" style={{ height: data.bodyHeight }}>{data.text}</div>
      <Handle type="source" position={sourcePosition ?? Position.Right} />
    </>
  );
}

function buildNodes(graph: FlowGraph, direction: FlowDirection, selected: string | null): FlowBoxNode[] {
  const boxes = layoutFlowGraph(graph, direction);
  const horizontal = direction === 'LR';
  const numbers = new Map(graph.order.map((id, index) => [id, index + 1]));
  return graph.nodes.map((node): FlowBoxNode => {
    const box = boxes.get(node.id)!;
    return {
      id: node.id,
      type: 'flowBox',
      position: { x: box.x, y: box.y },
      data: { text: node.text, kind: node.kind, step: numbers.get(node.id) ?? 0, bodyHeight: box.bodyHeight },
      className: `flow-node ${kindClass(node.kind)}${selected === node.id ? ' selected' : ''}`,
      // Only the width is pinned. The body's own height decides the card's, and the space the layout reserved for it
      // is a whole-pixel ceiling on that, so a card can be a hair shorter than its box but never overlap a neighbour.
      style: { width: box.width },
      sourcePosition: horizontal ? Position.Right : Position.Bottom,
      targetPosition: horizontal ? Position.Left : Position.Top,
    };
  });
}

function buildEdges(graph: FlowGraph, selected: string | null): Edge[] {
  return graph.edges.map((edge): Edge => {
    const hot = selected !== null && (edge.source === selected || edge.target === selected);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `flow-edge${hot ? ' hot' : ''}${edge.label ? ` labelled ${edge.label}` : ''}`,
      animated: hot,
      ...(edge.label ? { label: edge.label, labelShowBg: true, labelStyle: { fontSize: 10 }, labelBgPadding: [5, 2] as [number, number], labelBgBorderRadius: 4 } : {}),
    };
  });
}

/** Declared once: React Flow warns and re-renders every node if this object is rebuilt each render. */
const NODE_TYPES = { flowBox: FlowBoxCard };

function JourneyCanvas({ graph, direction, selected, fill, onSelect }: { graph: FlowGraph; direction: FlowDirection; selected: string | null; fill: boolean; onSelect: (id: string | null) => void }): ReactNode {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowBoxNode>(buildNodes(graph, direction, null));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(buildEdges(graph, null));
  const flow = useReactFlow();
  // The flow instance is kept in a ref so the effects below run when their own inputs change, not on every render.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const kinds = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.kind])), [graph]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Selecting restyles the boxes in place, so a box the user dragged keeps where they put it.
  useEffect(() => {
    setNodes((current) => current.map((node) => ({ ...node, className: `flow-node ${kindClass(kinds.get(node.id) ?? 'step')}${selected === node.id ? ' selected' : ''}` })));
    setEdges(buildEdges(graph, selected));
  }, [selected, graph, kinds, setNodes, setEdges]);

  // The starting view. A short flow fits whole. A long one fitted whole is a strip of text too small to read, so it
  // opens zoomed in on its beginning; the fit button in the corner shows all of it, and Walk through follows it.
  const showStart = useCallback(() => {
    const starting = graph.nodes.length > LONG_FLOW ? graph.nodes.slice(0, 5).map((node) => ({ id: node.id })) : undefined;
    void flowRef.current.fitView({ ...(starting ? { nodes: starting, maxZoom: 1, padding: 0.25 } : { padding: 0.12 }), duration: 200 });
  }, [graph]);

  // On opening, and when the canvas changes size (full screen and back): back to the selected step, else the start.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedRef.current) void flowRef.current.fitView({ nodes: [{ id: selectedRef.current }], duration: 200, maxZoom: 1.1, padding: 1.4 });
      else showStart();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [fill, showStart]);

  // Previous and Next move the view to the chosen step as well as lighting it up.
  useEffect(() => {
    if (selected === null) return;
    void flowRef.current.fitView({ nodes: [{ id: selected }], duration: 250, maxZoom: 1.1, padding: 1.4 });
  }, [selected]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelect(node.id === 'title' ? null : node.id)}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      // The chosen step is this component's own state. Left on, the library also marks the last clicked box selected,
      // which is the same class this stylesheet rings, so two boxes looked chosen at once.
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      minZoom={0.1}
    >
      <Background gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** `fill` makes the diagram take the height it is given (the artifact viewer's full screen) instead of a fixed one. */
export function FlowDiagram({ journeys, fill = false }: { journeys: readonly FlowJourney[]; fill?: boolean }): ReactNode {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [direction, setDirection] = useState<FlowDirection>('LR');

  const journey = journeys[Math.min(active, journeys.length - 1)];
  const graph = useMemo(() => (journey ? buildFlowGraph(journey) : null), [journey]);
  const choose = useCallback((index: number) => {
    setActive(index);
    setSelected(null);
  }, []);

  if (!journey || !graph) return null;

  const node = selected === null ? undefined : graph.nodes.find((item) => item.id === selected);
  const position = selected === null ? -1 : graph.order.indexOf(selected);
  const move = (offset: number): void => {
    const next = graph.order[Math.min(graph.order.length - 1, Math.max(0, position + offset))];
    if (next) setSelected(next);
  };
  const branches = graph.nodes.filter((item) => item.kind === 'decision').length;
  const height = Math.min(620, Math.max(320, 120 + graph.nodes.length * 34));

  return (
    <div className={`flow-panel${fill ? ' flow-fill' : ''}`}>
      <div className="flow-toolbar">
        <div className="flow-tabs" role="tablist" aria-label="Flows">
          {journeys.map((item, index) => (
            <button key={`${item.title}-${index}`} type="button" role="tab" aria-selected={index === active} className={index === active ? 'active' : undefined} onClick={() => choose(index)} title={`${item.steps.length} steps`}>
              {item.title}
            </button>
          ))}
        </div>
        <button type="button" className="secondary-button" onClick={() => setDirection((current) => (current === 'LR' ? 'TB' : 'LR'))} title="Switch between laying the flow out left to right and top to bottom">
          {direction === 'LR' ? <ArrowRight size={13} /> : <ArrowDown size={13} />} {direction === 'LR' ? 'Left to right' : 'Top to bottom'}
        </button>
      </div>
      <div className="flow-diagram" style={fill ? undefined : { height }}>
        <ReactFlowProvider key={`${active}-${journey.title}-${direction}`}>
          <JourneyCanvas graph={graph} direction={direction} selected={selected} fill={fill} onSelect={setSelected} />
        </ReactFlowProvider>
        <ul className="flow-legend" aria-label="Legend">
          <li className="screen">Screen</li>
          <li className="api">Endpoint</li>
          <li className="decision">Decision</li>
          <li className="outcome">Outcome</li>
        </ul>
      </div>
      <div className="flow-detail" role="status">
        {node && position >= 0 ? (
          <>
            <span className={`flow-kind ${node.kind}`}>{KIND_LABELS[node.kind]}</span>
            <span className="flow-detail-text"><strong>Step {position + 1} of {graph.order.length}.</strong> {node.text}</span>
            <span className="flow-detail-buttons">
              <button type="button" className="secondary-button" onClick={() => move(-1)} disabled={position <= 0} aria-label="Previous step"><ChevronLeft size={13} /> Previous</button>
              <button type="button" className="secondary-button" onClick={() => move(1)} disabled={position >= graph.order.length - 1} aria-label="Next step">Next <ChevronRight size={13} /></button>
            </span>
          </>
        ) : (
          <>
            <span className="studio-note">
              {graph.order.length} steps{branches > 0 ? `, ${branches} decision${branches === 1 ? '' : 's'} that branch` : ''}. Click a step to light up its path and read all of it, and scroll inside a card when a step says more than fits. Drag a box to tidy it, scroll the canvas to zoom, and use the fit button at the bottom left to see the whole flow.
            </span>
            <button type="button" className="secondary-button" onClick={() => setSelected(graph.order[0] ?? null)}>Walk through <ChevronRight size={13} /></button>
          </>
        )}
      </div>
    </div>
  );
}
