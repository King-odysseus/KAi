import { useMemo, type ReactNode } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FlowJourney } from '../flow-diagram';

/**
 * The user journeys from the flows artifact, drawn with React Flow: one row per journey, a step per box, screens,
 * endpoints and decisions in their own colours. It is drawn from the document's text, so editing the flows and
 * saving redraws it, and nothing here can drift from the file.
 */

const COLUMN = 230;
const ROW = 118;

export function FlowDiagram({ journeys }: { journeys: readonly FlowJourney[] }): ReactNode {
  const { nodes, edges } = useMemo(() => {
    const builtNodes: Node[] = [];
    const builtEdges: Edge[] = [];
    journeys.forEach((journey, row) => {
      const y = row * ROW;
      const titleId = `j${row}`;
      builtNodes.push({
        id: titleId,
        position: { x: 0, y },
        data: { label: journey.title },
        className: 'flow-node flow-title',
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });
      let previous = titleId;
      journey.steps.forEach((step, index) => {
        const id = `j${row}s${index}`;
        builtNodes.push({
          id,
          position: { x: (index + 1) * COLUMN, y },
          data: { label: step.text },
          className: `flow-node ${step.kind}`,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        });
        builtEdges.push({
          id: `${previous}->${id}`,
          source: previous,
          target: id,
          markerEnd: { type: MarkerType.ArrowClosed },
          className: 'flow-edge',
          // A decision's outgoing line is dashed: the journey can leave from here another way.
          animated: false,
        });
        previous = id;
      });
    });
    return { nodes: builtNodes, edges: builtEdges };
  }, [journeys]);

  return (
    <div className="flow-diagram" style={{ height: Math.min(640, Math.max(260, journeys.length * ROW + 80)) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
      >
        <Background gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <ul className="flow-legend" aria-label="Legend">
        <li className="screen">Screen</li>
        <li className="api">Endpoint</li>
        <li className="decision">Decision</li>
        <li className="step">Step</li>
      </ul>
    </div>
  );
}
