import { Link2, Maximize2, Minus, Network, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { unwrap } from '../types';
import {
  GRAPH_TYPE_LABEL,
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  createSimulation,
  nodeAt,
  parseKnowledgeGraph,
  settleSimulation,
  stepSimulation,
  toWorld,
  zoomView,
  type GraphNodeType,
  type KnowledgeGraph,
  type Simulation,
  type View,
} from './knowledge-graph';

const MAP_HEIGHT = 380;
const NODE_LIMIT = 150;
const TYPES: GraphNodeType[] = ['bugs', 'decisions', 'gotchas', 'patterns', 'other'];


interface Palette {
  colours: Record<GraphNodeType, string>;
  text: string;
  muted: string;
  line: string;
}

function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const pick = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    colours: {
      bugs: pick('--red', '#f27d87'),
      decisions: pick('--lavender', '#b8a7ff'),
      gotchas: pick('--amber', '#f2bd68'),
      patterns: pick('--mint', '#66e3bd'),
      other: pick('--text-muted', '#8493a8'),
    },
    text: pick('--text', '#dce6f3'),
    muted: pick('--text-muted', '#8493a8'),
    line: pick('--text-muted', '#8493a8'),
  };
}

/** An rgba() string for a colour that may be hex or already rgb, so glow and fade work in every theme. */
function withAlpha(colour: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const value = hex[1].length === 3 ? hex[1].split('').map((digit) => digit + digit).join('') : hex[1];
    const number = parseInt(value, 16);
    return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return colour;
}

interface Ambient {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
}

function makeAmbient(width: number, height: number): Ambient[] {
  return Array.from({ length: 34 }, (_, index) => ({
    x: ((index * 97) % 100) / 100 * width,
    y: ((index * 53) % 100) / 100 * height,
    vx: (((index * 31) % 7) - 3) * 0.012,
    vy: (((index * 17) % 7) - 3) * 0.012,
    size: 0.7 + ((index * 13) % 5) * 0.3,
    phase: index * 1.3,
  }));
}

/**
 * What C1 remembers, drawn as a map: each dot is a note (bug, decision, gotcha or pattern) and each line is a link
 * Overwatch found between two notes. Dots that connect to more notes are larger. The drifting specks behind them are
 * decoration; every dot and line in front is real data from the brain.
 */
export function KnowledgeMap({ disabled, onNotice }: { disabled: boolean; onNotice: (message: string) => void }): ReactNode {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState<'loading' | 'linking' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Simulation | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const redrawRef = useRef<() => void>(() => undefined);
  const viewRef = useRef<View>(IDENTITY_VIEW);
  // Set by the drawing effect, so the buttons can zoom about the middle of the canvas.
  const zoomRef = useRef<(factor: number | 'reset', cx?: number, cy?: number) => void>(() => undefined);

  const load = useCallback(async (): Promise<void> => {
    setBusy('loading');
    try {
      const result = await window.kaiDesktop.cognitive1Operation({ operation: 'graph', payload: { limit: String(NODE_LIMIT) } }).then(unwrap);
      setGraph(parseKnowledgeGraph(result));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The knowledge map could not be loaded.');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!disabled) void load();
  }, [disabled, load]);

  async function connect(): Promise<void> {
    setBusy('linking');
    try {
      const result = await window.kaiDesktop.cognitive1Operation({ operation: 'overwatch-link', payload: {} }).then(unwrap) as { applied?: number; proposed?: number };
      const applied = Number(result?.applied ?? 0);
      onNotice(applied > 0
        ? `Connected ${applied} pair${applied === 1 ? '' : 's'} of related notes.`
        : 'No new connections found. Everything that belongs together is already linked.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Linking related notes failed.');
      setBusy(null);
    }
  }

  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) counts.set(node.project, (counts.get(node.project) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const visible = useMemo<KnowledgeGraph | null>(() => {
    if (!graph) return null;
    if (!scope) return graph;
    const nodes = graph.nodes.filter((node) => node.project === scope);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges, totalNodes: nodes.length, totalEdges: edges.length };
  }, [graph, scope]);

  useEffect(() => {
    selectedRef.current = selectedId;
    redrawRef.current();
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !visible || visible.nodes.length === 0) {
      simRef.current = null;
      return undefined;
    }
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let palette = readPalette(canvas);
    let width = Math.max(320, host.clientWidth);
    const height = MAP_HEIGHT;
    let ambient = makeAmbient(width, height);
    let frame = 0;
    let stopped = false;

    const sim = createSimulation(visible, width, height);
    simRef.current = sim;
    if (reduced) settleSimulation(sim);
    viewRef.current = IDENTITY_VIEW;
    setZoom(1);

    const size = (): void => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    size();

    const draw = (time: number): void => {
      context.clearRect(0, 0, width, height);
      const focus = hoverRef.current ?? selectedRef.current;
      const near = new Set<string>(focus ? [focus, ...(sim.neighbours.get(focus) ?? [])] : []);

      for (const speck of ambient) {
        if (!reduced) {
          speck.x = (speck.x + speck.vx + width) % width;
          speck.y = (speck.y + speck.vy + height) % height;
        }
        const twinkle = 0.35 + 0.25 * Math.sin(time / 900 + speck.phase);
        context.fillStyle = withAlpha(palette.muted, twinkle * 0.5);
        context.beginPath();
        context.arc(speck.x, speck.y, speck.size, 0, Math.PI * 2);
        context.fill();
      }

      const view = viewRef.current;
      context.save();
      context.translate(view.x, view.y);
      context.scale(view.scale, view.scale);
      const offset = (index: number, axis: number): number => (reduced ? 0 : Math.sin(time / 1900 + index * 1.7 + axis) * 1.4);
      const position = new Map(sim.nodes.map((node, index) => [node.id, { x: node.x + offset(index, 0), y: node.y + offset(index, 2) }]));

      for (const { source, target } of sim.edges) {
        const a = position.get(source.id)!;
        const b = position.get(target.id)!;
        const active = focus ? near.has(source.id) && near.has(target.id) && (source.id === focus || target.id === focus) : false;
        const gradient = context.createLinearGradient(a.x, a.y, b.x, b.y);
        const from = palette.colours[source.type];
        const to = palette.colours[target.type];
        const strength = focus ? (active ? 0.75 : 0.06) : 0.24;
        gradient.addColorStop(0, withAlpha(from, strength));
        gradient.addColorStop(1, withAlpha(to, strength));
        context.strokeStyle = gradient;
        context.lineWidth = (active ? 1.6 : 1) / view.scale;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      const biggest = new Set([...sim.nodes].sort((a, b) => b.linkCount - a.linkCount).slice(0, 5).filter((node) => node.linkCount > 0).map((node) => node.id));
      sim.nodes.forEach((node, index) => {
        const at = position.get(node.id)!;
        const colour = palette.colours[node.type];
        const dim = focus ? !near.has(node.id) : false;
        const pulse = reduced ? 0 : Math.sin(time / 1100 + index) * 0.6;
        context.save();
        context.globalAlpha = dim ? 0.22 : 1;
        context.shadowColor = withAlpha(colour, 0.85);
        context.shadowBlur = node.id === focus ? node.radius * 3 : node.radius * 1.6;
        context.fillStyle = colour;
        context.beginPath();
        context.arc(at.x, at.y, node.radius + pulse * 0.4, 0, Math.PI * 2);
        context.fill();
        context.restore();
        if (node.id === selectedRef.current) {
          context.strokeStyle = palette.text;
          context.lineWidth = 1.5 / view.scale;
          context.beginPath();
          context.arc(at.x, at.y, node.radius + 4, 0, Math.PI * 2);
          context.stroke();
        }
        if (node.id === focus || (!focus && biggest.has(node.id))) {
          const label = node.id.length > 34 ? `${node.id.slice(0, 33)}…` : node.id;
          // Labels keep a readable size however far the map is zoomed, and stay inside the visible part of the canvas.
          context.font = `${11 / view.scale}px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
          context.textAlign = 'center';
          context.fillStyle = withAlpha(palette.text, dim ? 0.3 : 0.92);
          const low = (60 - view.x) / view.scale;
          const high = (width - 60 - view.x) / view.scale;
          context.fillText(label, Math.min(high, Math.max(low, at.x)), at.y - node.radius - 7 / view.scale);
        }
      });
      context.restore();
    };

    const tick = (time: number): void => {
      if (stopped) return;
      stepSimulation(sim);
      draw(time);
      frame = requestAnimationFrame(tick);
    };
    redrawRef.current = () => draw(performance.now());
    if (reduced) draw(0);
    else frame = requestAnimationFrame(tick);

    // Zoom about a point on screen, so the note under the pointer stays under it.
    const applyZoom = (factor: number | 'reset', cx = width / 2, cy = height / 2): void => {
      viewRef.current = factor === 'reset' ? IDENTITY_VIEW : zoomView(viewRef.current, factor, cx, cy);
      hoverRef.current = null;
      setHover(null);
      setZoom(viewRef.current.scale);
      if (reduced) draw(0);
    };
    zoomRef.current = applyZoom;

    const onWheel = (event: WheelEvent): void => {
      // A page that scrolls under the map would fight the zoom, so the map keeps the wheel while the pointer is on it.
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      const step = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
      applyZoom(step, event.clientX - box.left, event.clientY - box.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const observer = new ResizeObserver(() => {
      const next = Math.max(320, host.clientWidth);
      if (next === width) return;
      const scale = next / width;
      width = next;
      sim.width = width;
      for (const node of sim.nodes) node.x *= scale;
      ambient = makeAmbient(width, height);
      size();
      if (reduced) draw(0);
    });
    observer.observe(host);

    // Theme switches change the CSS variables the colours come from.
    const themes = new MutationObserver(() => {
      palette = readPalette(canvas);
      if (reduced) draw(0);
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      themes.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      redrawRef.current = () => undefined;
      zoomRef.current = () => undefined;
      if (simRef.current === sim) simRef.current = null;
    };
  }, [visible]);

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const dragRef = useRef<
    | { kind: 'node'; id: string; moved: boolean; startX: number; startY: number }
    | { kind: 'pan'; moved: boolean; startX: number; startY: number; lastX: number; lastY: number }
    | null
  >(null);


  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const sim = simRef.current;
    if (!sim) return;
    const point = local(event);
    const drag = dragRef.current;
    if (drag?.kind === 'pan') {
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
      viewRef.current = { ...viewRef.current, x: viewRef.current.x + point.x - drag.lastX, y: viewRef.current.y + point.y - drag.lastY };
      drag.lastX = point.x;
      drag.lastY = point.y;
      redrawRef.current();
      return;
    }
    if (drag) {
      const node = sim.nodes.find((item) => item.id === drag.id);
      if (node) {
        if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
        const world = toWorld(viewRef.current, point);
        node.x = world.x;
        node.y = world.y;
        sim.alpha = Math.max(sim.alpha, 0.3);
        redrawRef.current();
      }
      return;
    }
    const world = toWorld(viewRef.current, point);
    const found = nodeAt(sim, world.x, world.y, 5 / viewRef.current.scale);
    const id = found?.id ?? null;
    if (id !== hoverRef.current) {
      hoverRef.current = id;
      setHover(found ? { id: found.id, x: point.x, y: point.y } : null);
      redrawRef.current();
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const sim = simRef.current;
    if (!sim) return;
    const point = local(event);
    const world = toWorld(viewRef.current, point);
    const found = nodeAt(sim, world.x, world.y, 5 / viewRef.current.scale);
    if (!found) {
      // Dragging empty space moves the map; a plain click on it clears the selection when the pointer comes up.
      dragRef.current = { kind: 'pan', moved: false, startX: point.x, startY: point.y, lastX: point.x, lastY: point.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    found.pinned = true;
    dragRef.current = { kind: 'node', id: found.id, moved: false, startX: point.x, startY: point.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === 'pan') {
      if (!drag.moved) setSelectedId(null);
    } else {
      const node = simRef.current?.nodes.find((item) => item.id === drag.id);
      if (node) node.pinned = false;
      if (!drag.moved) setSelectedId((current) => (current === drag.id ? null : drag.id));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onPointerLeave(): void {
    if (dragRef.current) return;
    hoverRef.current = null;
    setHover(null);
    redrawRef.current();
  }

  const nodes = visible?.nodes ?? [];
  const edges = visible?.edges ?? [];
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const hovered = hover ? nodes.find((node) => node.id === hover.id) ?? null : null;
  const neighbourIds = selected ? simRef.current?.neighbours.get(selected.id) ?? [] : [];
  const topNotes = useMemo(() => [...nodes].filter((node) => node.linkCount > 0).sort((a, b) => b.linkCount - a.linkCount).slice(0, 6), [nodes]);
  const typeCounts = useMemo(() => {
    const counts: Record<GraphNodeType, number> = { bugs: 0, decisions: 0, gotchas: 0, patterns: 0, other: 0 };
    for (const node of nodes) counts[node.type] += 1;
    return counts;
  }, [nodes]);

  return (
    <section className="cognitive1-card knowledge-map">
      <div className="cognitive1-card-heading">
        <div>
          <span className="eyebrow">Knowledge map</span>
          <h3>How what C1 remembers connects</h3>
        </div>
        <Network size={16} />
      </div>
      <p className="cognitive1-copy">
        Each dot is a note an agent filed: a bug, decision, gotcha or pattern. Each line is a link between two notes about the same thing.
        Bigger dots connect to more notes, so they are the ideas your projects keep running into.
      </p>

      <div className="cognitive1-actions knowledge-map-actions">
        <button type="button" className="primary-button" disabled={disabled || busy !== null} onClick={() => void connect()} title="Compare every note and link the ones that are about the same thing">
          <Link2 size={13} className={busy === 'linking' ? 'spin' : undefined} /><span>{busy === 'linking' ? 'Connecting…' : 'Connect related notes'}</span>
        </button>
        <button type="button" className="secondary-button" disabled={disabled || busy !== null} onClick={() => void load()}>
          <RefreshCw size={13} className={busy === 'loading' ? 'spin' : undefined} /><span>Refresh</span>
        </button>
        {projects.length > 1 && (
          <select aria-label="Show notes from" value={scope} onChange={(event) => { setScope(event.target.value); setSelectedId(null); }}>
            <option value="">All projects ({graph?.nodes.length ?? 0})</option>
            {projects.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
          </select>
        )}
        <span className="knowledge-map-count">{nodes.length} note{nodes.length === 1 ? '' : 's'} · {edges.length} connection{edges.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="proxy-error" role="alert"><span>{error}</span></div>}

      {nodes.length === 0 ? (
        <div className="knowledge-map-empty">
          {busy === 'loading' ? 'Loading the map…' : disabled ? 'Start C1 to see its map.' : 'C1 has no notes for this view yet. Notes appear here as agents file bugs, decisions, gotchas and patterns.'}
        </div>
      ) : (
        <>
          <div className="knowledge-map-stage" ref={hostRef}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`Knowledge map with ${nodes.length} notes and ${edges.length} connections`}
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerLeave}
              onDoubleClick={() => zoomRef.current('reset')}
            />
            <div className="knowledge-map-zoom" role="group" aria-label="Zoom">
              <button type="button" aria-label="Zoom in" title="Zoom in (or scroll up over the map)" disabled={zoom >= MAX_ZOOM} onClick={() => zoomRef.current(1.35)}><Plus size={13} /></button>
              <button type="button" aria-label="Zoom out" title="Zoom out (or scroll down over the map)" disabled={zoom <= MIN_ZOOM} onClick={() => zoomRef.current(1 / 1.35)}><Minus size={13} /></button>
              <button type="button" aria-label="Reset zoom" title="Reset the view (or double-click the map)" onClick={() => zoomRef.current('reset')}><Maximize2 size={12} /></button>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
            </div>
            {hovered && hover && (
              <div className="knowledge-map-tip" style={{ left: Math.min(hover.x + 14, Math.max(0, (hostRef.current?.clientWidth ?? 600) - 250)), top: Math.max(6, hover.y - 46) }}>
                <strong>{hovered.id}</strong>
                <span>{GRAPH_TYPE_LABEL[hovered.type]} · {hovered.project} · {hovered.linkCount} link{hovered.linkCount === 1 ? '' : 's'}</span>
              </div>
            )}
            {edges.length === 0 && (
              <div className="knowledge-map-hint">No connections yet. Press “Connect related notes” and C1 will link the ones about the same thing.</div>
            )}
          </div>

          <div className="knowledge-map-legend" aria-label="Colour key">
            {TYPES.filter((type) => typeCounts[type] > 0).map((type) => (
              <span key={type} className={`knowledge-map-key ${type}`}><i />{GRAPH_TYPE_LABEL[type]}s <b>{typeCounts[type]}</b></span>
            ))}
          </div>

          {selected ? (
            <div className="knowledge-map-detail">
              <span className={`knowledge-map-key ${selected.type}`}><i />{GRAPH_TYPE_LABEL[selected.type]}</span>
              <strong>{selected.id}</strong>
              <small>{selected.project} · filed by {selected.agent}{selected.date ? ` · ${selected.date}` : ''} · {selected.linkCount} link{selected.linkCount === 1 ? '' : 's'}</small>
              {neighbourIds.length > 0 && (
                <div className="knowledge-map-links">
                  <span>Connected to</span>
                  {neighbourIds.map((id) => <button key={id} type="button" onClick={() => setSelectedId(id)}>{id}</button>)}
                </div>
              )}
            </div>
          ) : topNotes.length > 0 && (
            <div className="knowledge-map-detail">
              <small>Most connected notes. Click a dot, or one of these, to see what it links to. Scroll to zoom and drag empty space to move around.</small>
              <div className="knowledge-map-links">
                {topNotes.map((node) => <button key={node.id} type="button" onClick={() => setSelectedId(node.id)}>{node.id} <b>{node.linkCount}</b></button>)}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
