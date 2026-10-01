import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { layoutSteps, type FlowJourney } from '../flow-diagram';

/**
 * The user journeys from the flows artifact, drawn with React Flow. Each journey has its own tab, so a project with
 * many flows is not one wall of boxes. The diagram is interactive: pan and zoom, drag boxes to tidy them, click a
 * step to light up its path, step through with Previous and Next, and open it full screen. It is drawn from the
 * document's text, so editing the flows and saving redraws it, and nothing here can drift from the file.
 */

const KIND_LABELS = { step: 'Step', screen: 'Screen', api: 'Endpoint', decision: 'Decision' } as const;

function buildNodes(journey: FlowJourney, selected: number | null): Node[] {
  const positions = layoutSteps(journey.steps.length);
  return [
    {
      id: 'title',
      position: positions[0]!,
      data: { label: journey.title },
      className: 'flow-node flow-title',
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    },
    ...journey.steps.map((step, index): Node => ({
      id: `s${index}`,
      position: positions[index + 1]!,
      data: { label: step.text },
      className: `flow-node ${step.kind}${selected === index ? ' selected' : ''}`,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })),
  ];
}

function buildEdges(journey: FlowJourney, selected: number | null): Edge[] {
  const ids = ['title', ...journey.steps.map((_step, index) => `s${index}`)];
  return ids.slice(1).map((target, index): Edge => {
    const source = ids[index]!;
    // Selecting step n lights the line into it and the line out of it.
    const hot = selected !== null && (target === `s${selected}` || source === `s${selected}`);
    return {
      id: `${source}->${target}`,
      source,
      target,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `flow-edge${hot ? ' hot' : ''}`,
      animated: hot,
    };
  });
}

function JourneyCanvas({ journey, selected, fill, onSelect }: { journey: FlowJourney; selected: number | null; fill: boolean; onSelect: (index: number | null) => void }): ReactNode {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(buildNodes(journey, null));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(buildEdges(journey, null));
  const flow = useReactFlow();

  // Selecting restyles the boxes in place, so a box the user dragged keeps where they put it.
  useEffect(() => {
    setNodes((current) => current.map((node) => {
      if (node.id === 'title') return node;
      const index = Number(node.id.slice(1));
      const kind = journey.steps[index]?.kind ?? 'step';
      return { ...node, className: `flow-node ${kind}${selected === index ? ' selected' : ''}` };
    }));
    setEdges(buildEdges(journey, selected));
  }, [selected, journey, setNodes, setEdges]);

  // Going full screen (or back) changes the size of the canvas, so fit the whole flow to the new size.
  useEffect(() => {
    const timer = window.setTimeout(() => { void flow.fitView({ duration: 200, padding: 0.14 }); }, 120);
    return () => window.clearTimeout(timer);
  }, [fill, flow]);

  // Previous and Next move the view to the chosen step as well as lighting it up.
  useEffect(() => {
    if (selected === null) return;
    void flow.fitView({ nodes: [{ id: `s${selected}` }], duration: 250, maxZoom: 1.1, padding: 1.6 });
  }, [selected, flow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelect(node.id === 'title' ? null : Number(node.id.slice(1)))}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.14 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
    >
      <Background gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** `fill` makes the diagram take the height it is given (the artifact viewer's full screen) instead of a fixed one. */
export function FlowDiagram({ journeys, fill = false }: { journeys: readonly FlowJourney[]; fill?: boolean }): ReactNode {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const journey = journeys[Math.min(active, journeys.length - 1)];
  const choose = useCallback((index: number) => {
    setActive(index);
    setSelected(null);
  }, []);

  const step = journey && selected !== null ? journey.steps[selected] : undefined;
  const height = useMemo(() => {
    if (!journey) return 320;
    const rows = Math.ceil((journey.steps.length + 1) / 6);
    return Math.min(560, Math.max(300, rows * 130 + 90));
  }, [journey]);

  if (!journey) return null;

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
      </div>
      <div className="flow-diagram" style={fill ? undefined : { height }}>
        <ReactFlowProvider key={`${active}-${journey.title}`}>
          <JourneyCanvas journey={journey} selected={selected} fill={fill} onSelect={setSelected} />
        </ReactFlowProvider>
        <ul className="flow-legend" aria-label="Legend">
          <li className="screen">Screen</li>
          <li className="api">Endpoint</li>
          <li className="decision">Decision</li>
          <li className="step">Step</li>
        </ul>
      </div>
      <div className="flow-detail" role="status">
        {step && selected !== null ? (
          <>
            <span className={`flow-kind ${step.kind}`}>{KIND_LABELS[step.kind]}</span>
            <span className="flow-detail-text"><strong>Step {selected + 1} of {journey.steps.length}.</strong> {step.text}</span>
            <span className="flow-detail-buttons">
              <button type="button" className="secondary-button" onClick={() => setSelected(Math.max(0, selected - 1))} disabled={selected === 0} aria-label="Previous step"><ChevronLeft size={13} /> Previous</button>
              <button type="button" className="secondary-button" onClick={() => setSelected(Math.min(journey.steps.length - 1, selected + 1))} disabled={selected >= journey.steps.length - 1} aria-label="Next step">Next <ChevronRight size={13} /></button>
            </span>
          </>
        ) : (
          <span className="studio-note">Click a step to light up its path. Drag to move around, scroll to zoom, drag a box to tidy it. {journey.steps.length} steps in this flow.</span>
        )}
        {step === undefined && selected === null && journey.steps.length > 0 && (
          <button type="button" className="secondary-button" onClick={() => setSelected(0)}>Walk through <ChevronRight size={13} /></button>
        )}
      </div>
    </div>
  );
}
