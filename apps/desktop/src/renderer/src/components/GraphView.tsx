import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Maximize2, Minimize2, RefreshCw, Workflow } from 'lucide-react';
import type { BoardCard, BoardStatus, StudioBoard, StudioProjectSummary } from '@kai/contracts';
import { agentLinks, connectedCardIds, layoutAgentLinks, layoutCards, reducedDependencies } from '../graph-layout';
import { unwrap } from '../types';

/**
 * The board as a graph, on its own page. Two views of the same cards: what blocks what, and which agent is holding
 * which card right now. It only reads the board; moving a card stays with the Studio board and the agents, so the
 * graph can never contradict the rules that guard Done.
 */

const STATUS_LABELS: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  inProgress: 'In progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
};

/** How often the page re-reads the board, so a card an agent moves shows up without a refresh. */
const POLL_MS = 4_000;

type Mode = 'dependencies' | 'agents';

function moverLabel(card: BoardCard): string {
  if (!card.movedBy) return 'not moved yet';
  const who = card.movedBy === 'user' ? 'you' : card.movedBy === 'check' ? 'the check' : card.claimedBy ? `agent ${card.claimedBy}` : 'an agent';
  return `moved by ${who}${card.movedAt ? ` · ${card.movedAt.slice(0, 16).replace('T', ' ')}` : ''}`;
}

export function GraphView(): ReactNode {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [board, setBoard] = useState<StudioBoard | null>(null);
  const [mode, setMode] = useState<Mode>('dependencies');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.kaiDesktop.studioProjects().then(unwrap).then((next) => {
      if (cancelled) return;
      const active = next.filter((project) => !project.archivedAt);
      setProjects(active);
      setProjectId((current) => current ?? active[0]?.id ?? null);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not read the Studio projects.');
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (quiet: boolean) => {
    if (!projectId) return;
    if (!quiet) setBusy(true);
    try {
      setBoard(unwrap(await window.kaiDesktop.studioBoard(projectId)));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the board.');
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    setBoard(null);
    setSelected(null);
    void load(false);
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const cards = board?.cards ?? [];
  const { nodes, edges } = useMemo(() => buildGraph(cards, mode), [cards, mode]);
  const chosen = cards.find((card) => card.id === selected) ?? null;
  const counts = useMemo(() => {
    const result = new Map<BoardStatus, number>();
    for (const card of cards) result.set(card.status, (result.get(card.status) ?? 0) + 1);
    return result;
  }, [cards]);

  return (
    <div className={`graph-view${full ? ' graph-view-full' : ''}`}>
      <header className="graph-head">
        <div>
          <h1><Workflow size={16} /> Project graph</h1>
          <p className="studio-note">What blocks what, and which agent holds which card. Read-only: move cards from the Studio board.</p>
        </div>
        <div className="graph-controls">
          <select className="studio-move" value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value || null)} aria-label="Studio project" disabled={projects.length === 0}>
            {projects.length === 0 && <option value="">No Studio projects</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title.slice(0, 60)}</option>)}
          </select>
          <div className="mode-toggle" role="group" aria-label="Graph view">
            <button type="button" className={mode === 'dependencies' ? 'active' : ''} aria-pressed={mode === 'dependencies'} onClick={() => setMode('dependencies')}><span>Dependencies</span></button>
            <button type="button" className={mode === 'agents' ? 'active' : ''} aria-pressed={mode === 'agents'} onClick={() => setMode('agents')}><span>Agents</span></button>
          </div>
          <button type="button" className="secondary-button" onClick={() => void load(false)} disabled={busy || !projectId}>
            {busy ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />} Refresh
          </button>
          <button type="button" className="secondary-button" onClick={() => setFull((value) => !value)} aria-pressed={full} title={full ? 'Exit full screen (Esc)' : 'Show the project graph full screen'}>
            {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {full ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </header>

      {error && <p className="studio-notice warning" role="alert">{error}</p>}

      <div className="graph-legend" aria-label="Legend">
        {(Object.keys(STATUS_LABELS) as BoardStatus[]).map((status) => (
          <span key={status} className={`graph-chip ${status}`}>{STATUS_LABELS[status]} <b>{counts.get(status) ?? 0}</b></span>
        ))}
      </div>

      <div className="graph-body">
        <div className="graph-canvas">
          {nodes.length === 0 ? (
            <p className="studio-note graph-empty">
              {busy ? 'Reading the board…' : projectId ? (mode === 'agents' ? 'No agent is holding a card right now.' : 'This project has no cards yet. Build the board in the Studio first.') : 'Start a Studio project to see its graph here.'}
            </p>
          ) : (
            <ReactFlow
              key={`${projectId ?? ''}-${mode}-${full ? 'full' : 'page'}`}
              nodes={nodes}
              edges={edges}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => setSelected(node.id.startsWith('agent:') ? null : node.id)}
              onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
              minZoom={0.2}
            >
              <Background gap={22} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {chosen && (
          <aside className="graph-detail" aria-label="Card details">
            <h2>{chosen.title}</h2>
            <span className={`graph-chip ${chosen.status}`}>{STATUS_LABELS[chosen.status]}</span>
            <p className="studio-note">{chosen.kind} · {moverLabel(chosen)}</p>
            {chosen.claimedBy && <p className="studio-note">Held by {chosen.claimedBy}</p>}
            {chosen.dependsOn.length > 0 && <p className="studio-note">Waits on: {chosen.dependsOn.map((id) => cards.find((card) => card.id === id)?.title ?? id).join(', ')}</p>}
            {chosen.acceptance.length > 0 && (
              <>
                <h3>Done when</h3>
                <ul className="studio-list">{chosen.acceptance.map((item) => <li key={item}>{item}</li>)}</ul>
              </>
            )}
            {chosen.stale && <p className="studio-note">Stale: {chosen.staleReason ?? 'something it reads changed.'}</p>}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Nodes and edges for one view. Pure apart from the card data, so the page re-renders cleanly on every poll. */
function buildGraph(cards: readonly BoardCard[], mode: Mode): { nodes: Node[]; edges: Edge[] } {
  const cardNode = (card: BoardCard, x: number, y: number): Node => ({
    id: card.id,
    position: { x, y },
    data: { label: card.title },
    className: `graph-node ${card.status}${card.claimedBy ? ' held' : ''}`,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });

  if (mode === 'dependencies') {
    const connected = connectedCardIds(cards);
    const shown = cards.filter((card) => connected.has(card.id) || cards.length <= 12);
    const ids = new Set(shown.map((card) => card.id));
    const byId = new Map(cards.map((card) => [card.id, card]));
    const dependencies = reducedDependencies(shown);
    const positions = new Map(layoutCards(shown).map((position) => [position.id, position]));
    return {
      nodes: shown.map((card) => cardNode(card, positions.get(card.id)?.x ?? 0, positions.get(card.id)?.y ?? 0)),
      edges: shown.flatMap((card) => (dependencies.get(card.id) ?? []).filter((dependency) => ids.has(dependency)).map((dependency): Edge => ({
        id: `${dependency}->${card.id}`,
        source: dependency,
        target: card.id,
        type: 'step',
        animated: byId.get(dependency)?.status === 'done' && card.status === 'inProgress',
        markerEnd: { type: MarkerType.ArrowClosed },
        className: `graph-edge ${byId.get(dependency)?.status === 'done' ? 'met' : 'waiting'}`,
      }))),
    };
  }

  const links = agentLinks(cards);
  const agents = [...new Set(links.map((link) => link.agent))];
  const agentPositions = new Map(layoutAgentLinks(links).map((position) => [position.id, position]));
  const held = new Set(links.map((link) => link.cardId));
  const agentNodes: Node[] = agents.map((agent, index) => ({
    id: `agent:${agent}`,
    position: { x: agentPositions.get(`agent:${agent}`)?.x ?? 0, y: agentPositions.get(`agent:${agent}`)?.y ?? index * 120 },
    data: { label: agent },
    className: 'graph-node agent',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));
  const cardNodes = cards.filter((card) => held.has(card.id)).map((card, index) => cardNode(card, agentPositions.get(card.id)?.x ?? 300, agentPositions.get(card.id)?.y ?? index * 100));
  return {
    nodes: [...agentNodes, ...cardNodes],
    edges: links.map((link): Edge => ({
      id: `agent:${link.agent}->${link.cardId}`,
      source: `agent:${link.agent}`,
      target: link.cardId,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: 'graph-edge live',
    })),
  };
}
