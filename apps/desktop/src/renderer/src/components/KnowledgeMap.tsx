import { Link2, Maximize2, Minus, Network, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { unwrap } from '../types';
import {
  DEFAULT_VIEW,
  GRAPH_TYPE_LABEL,
  MAX_ZOOM,
  MIN_ZOOM,
  angleDelta,
  arcPoints,
  clampPitch,
  clampZoom,
  createOrb,
  focusView,
  hitTest,
  nodeScreenRadius,
  orbRadius,
  parseKnowledgeGraph,
  projectPoint,
  type GraphNodeType,
  type KnowledgeGraph,
  type Orb,
  type OrbView,
} from './knowledge-graph';

const MAP_HEIGHT = 440;
const NODE_LIMIT = 150;
const TYPES: GraphNodeType[] = ['bugs', 'decisions', 'gotchas', 'patterns', 'other'];
/** Radians per second the orb turns when nothing is touching it. */
const IDLE_SPIN = 0.16;

interface Palette {
  colours: Record<GraphNodeType, string>;
  text: string;
  muted: string;
  glow: string;
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
    glow: pick('--mint', '#66e3bd'),
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

/**
 * What C1 remembers, drawn as an orb of particles: each bright dot is a note (bug, decision, gotcha or pattern) sitting on
 * a sphere, each arc is a link Overwatch found between two notes, and notes about the same thing gather in the same
 * patch. The faint specks that fill out the sphere are decoration; every bright dot and arc is real data from the brain.
 * Drag to spin it, scroll to zoom, click a note to bring it round to the front.
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
  const orbRef = useRef<Orb | null>(null);
  const viewRef = useRef<OrbView>({ ...DEFAULT_VIEW });
  const sizeRef = useRef({ width: 600, height: MAP_HEIGHT });
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Where the orb is turning to, when a note has been chosen and is being brought to the front. */
  const focusRef = useRef<{ yaw: number; pitch: number } | null>(null);
  /** Spin left over from a drag, in radians per second, so a flick keeps turning and eases out. */
  const spinRef = useRef({ yaw: 0, pitch: 0 });
  const reducedRef = useRef(false);
  const redrawRef = useRef<() => void>(() => undefined);
  const dragRef = useRef<{ moved: boolean; startX: number; startY: number; lastX: number; lastY: number; lastTime: number } | null>(null);

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

  // Choosing a note, from a click or from the list below, turns the orb until that note faces the viewer.
  useEffect(() => {
    selectedRef.current = selectedId;
    const node = selectedId ? orbRef.current?.nodes.find((item) => item.id === selectedId) : undefined;
    if (node) {
      const target = focusView(node.p);
      if (reducedRef.current) {
        viewRef.current = { ...viewRef.current, ...target };
        focusRef.current = null;
      } else {
        focusRef.current = target;
      }
      spinRef.current = { yaw: 0, pitch: 0 };
    } else {
      focusRef.current = null;
    }
    redrawRef.current();
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !visible || visible.nodes.length === 0) {
      orbRef.current = null;
      return undefined;
    }
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    reducedRef.current = reduced;
    let palette = readPalette(canvas);
    let frame = 0;
    let stopped = false;
    let last = performance.now();

    const orb = createOrb(visible);
    orbRef.current = orb;
    viewRef.current = { ...DEFAULT_VIEW };
    focusRef.current = null;
    spinRef.current = { yaw: 0, pitch: 0 };
    setZoom(1);

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(320, host.clientWidth);
      sizeRef.current = { width, height: MAP_HEIGHT };
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(MAP_HEIGHT * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${MAP_HEIGHT}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const draw = (time: number): void => {
      const { width, height } = sizeRef.current;
      const view = viewRef.current;
      const centre = { x: width / 2, y: height / 2 };
      const radius = orbRadius(width, height, view.zoom);
      context.clearRect(0, 0, width, height);

      // A soft glow behind the sphere, so it reads as a lit orb rather than a scatter of dots.
      const glow = context.createRadialGradient(centre.x, centre.y, radius * 0.15, centre.x, centre.y, radius * 1.35);
      glow.addColorStop(0, withAlpha(palette.glow, 0.13));
      glow.addColorStop(0.55, withAlpha(palette.glow, 0.05));
      glow.addColorStop(1, withAlpha(palette.glow, 0));
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      const focus = hoverRef.current ?? selectedRef.current;
      const near = new Set<string>(focus ? [focus, ...(orb.neighbours.get(focus) ?? [])] : []);

      // The particles that fill out the sphere: dimmer and smaller on the far side, brighter on the near side.
      orb.shell.forEach((point, index) => {
        const projected = projectPoint(point, view, width, height);
        const depth = (projected.z + 1) / 2;
        const twinkle = reducedRef.current ? 0.8 : 0.65 + 0.35 * Math.sin(time / 800 + index * 2.3);
        context.fillStyle = withAlpha(palette.muted, (0.1 + 0.55 * depth) * twinkle);
        context.beginPath();
        context.arc(projected.x, projected.y, (0.5 + 1.1 * depth) * projected.scale, 0, Math.PI * 2);
        context.fill();
      });

      // Links, drawn as arcs that float over the sphere.
      for (const { source, target } of orb.edges) {
        const points = arcPoints(source.p, target.p).map((point) => projectPoint(point, view, width, height));
        const depth = (points.reduce((sum, point) => sum + point.z, 0) / points.length + 1) / 2;
        const touching = focus ? source.id === focus || target.id === focus : false;
        const strength = focus ? (touching ? 0.9 : 0.05) : 0.12 + 0.36 * depth;
        const first = points[0];
        const lastPoint = points[points.length - 1];
        const gradient = context.createLinearGradient(first.x, first.y, lastPoint.x, lastPoint.y);
        gradient.addColorStop(0, withAlpha(palette.colours[source.type], strength));
        gradient.addColorStop(1, withAlpha(palette.colours[target.type], strength));
        context.strokeStyle = gradient;
        context.lineWidth = touching ? 1.8 : 0.6 + depth * 0.8;
        context.beginPath();
        points.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
        context.stroke();
      }

      // Notes, far side first so nearer ones sit on top.
      const projected = orb.nodes
        .map((node) => ({ node, at: projectPoint(node.p, view, width, height) }))
        .sort((a, b) => a.at.z - b.at.z);
      const biggest = new Set([...orb.nodes].sort((a, b) => b.linkCount - a.linkCount).slice(0, 5).filter((node) => node.linkCount > 0).map((node) => node.id));

      for (const { node, at } of projected) {
        const depth = (at.z + 1) / 2;
        const colour = palette.colours[node.type];
        const dim = focus ? !near.has(node.id) : false;
        const size = nodeScreenRadius(node, at, view.zoom) * (0.7 + 0.3 * depth);
        context.save();
        context.globalAlpha = (dim ? 0.18 : 1) * (0.35 + 0.65 * depth);
        context.shadowColor = withAlpha(colour, 0.9);
        context.shadowBlur = node.id === focus ? size * 3.2 : size * 1.7;
        context.fillStyle = colour;
        context.beginPath();
        context.arc(at.x, at.y, size, 0, Math.PI * 2);
        context.fill();
        context.restore();
        if (node.id === selectedRef.current) {
          context.strokeStyle = palette.text;
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(at.x, at.y, size + 4, 0, Math.PI * 2);
          context.stroke();
        }
        // Names only on the near side, so labels never pile up over the back of the orb.
        if (at.z > 0.15 && (node.id === focus || (!focus && biggest.has(node.id)))) {
          const label = node.id.length > 34 ? `${node.id.slice(0, 33)}…` : node.id;
          context.font = '11px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
          context.textAlign = 'center';
          context.fillStyle = withAlpha(palette.text, dim ? 0.3 : 0.94);
          context.fillText(label, Math.min(width - 60, Math.max(60, at.x)), at.y - size - 8);
        }
      }
    };

    const tick = (time: number): void => {
      if (stopped) return;
      const delta = Math.min(0.05, (time - last) / 1000);
      last = time;
      const view = viewRef.current;
      const dragging = dragRef.current !== null;
      const focusTarget = focusRef.current;

      if (dragging) {
        // The pointer is in charge while it is down.
      } else if (focusTarget) {
        // Ease toward the chosen note, then stay put so it can be read.
        const yawStep = angleDelta(view.yaw, focusTarget.yaw);
        const pitchStep = focusTarget.pitch - view.pitch;
        view.yaw += yawStep * Math.min(1, delta * 7);
        view.pitch = clampPitch(view.pitch + pitchStep * Math.min(1, delta * 7));
        if (Math.abs(yawStep) < 0.002 && Math.abs(pitchStep) < 0.002) focusRef.current = null;
      } else {
        const spin = spinRef.current;
        view.yaw += spin.yaw * delta;
        view.pitch = clampPitch(view.pitch + spin.pitch * delta);
        const decay = Math.exp(-2.6 * delta);
        spin.yaw *= decay;
        spin.pitch *= decay;
        // Idle turning stops while a note is hovered or chosen, so it is easy to aim at and to read.
        if (!hoverRef.current && !selectedRef.current) view.yaw += IDLE_SPIN * delta;
      }
      draw(time);
      frame = requestAnimationFrame(tick);
    };
    redrawRef.current = () => draw(performance.now());
    if (reduced) draw(0);
    else frame = requestAnimationFrame(tick);

    const onWheel = (event: WheelEvent): void => {
      // A page that scrolls under the map would fight the zoom, so the map keeps the wheel while the pointer is on it.
      event.preventDefault();
      const next = clampZoom(viewRef.current.zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016)));
      viewRef.current = { ...viewRef.current, zoom: next };
      hoverRef.current = null;
      setHover(null);
      setZoom(next);
      if (reduced) draw(0);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const observer = new ResizeObserver(() => {
      resize();
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
      canvas.removeEventListener('wheel', onWheel);
      observer.disconnect();
      themes.disconnect();
      redrawRef.current = () => undefined;
      if (orbRef.current === orb) orbRef.current = null;
    };
  }, [visible]);

  function setZoomBy(factor: number | 'reset'): void {
    const next = factor === 'reset' ? 1 : clampZoom(viewRef.current.zoom * factor);
    viewRef.current = factor === 'reset' ? { ...DEFAULT_VIEW } : { ...viewRef.current, zoom: next };
    if (factor === 'reset') {
      focusRef.current = null;
      spinRef.current = { yaw: 0, pitch: 0 };
    }
    hoverRef.current = null;
    setHover(null);
    setZoom(next);
    redrawRef.current();
  }

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = local(event);
    dragRef.current = { moved: false, startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, lastTime: performance.now() };
    focusRef.current = null;
    spinRef.current = { yaw: 0, pitch: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const orb = orbRef.current;
    if (!orb) return;
    const point = local(event);
    const drag = dragRef.current;
    if (drag) {
      const now = performance.now();
      const dx = point.x - drag.lastX;
      const dy = point.y - drag.lastY;
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
      const view = viewRef.current;
      // Dragging carries the near side of the orb with the pointer.
      view.yaw += dx * 0.008;
      view.pitch = clampPitch(view.pitch + dy * 0.008);
      const seconds = Math.max(0.008, (now - drag.lastTime) / 1000);
      spinRef.current = { yaw: Math.max(-4, Math.min(4, (dx * 0.008) / seconds)), pitch: Math.max(-3, Math.min(3, (dy * 0.008) / seconds)) };
      drag.lastX = point.x;
      drag.lastY = point.y;
      drag.lastTime = now;
      if (hoverRef.current) {
        hoverRef.current = null;
        setHover(null);
      }
      redrawRef.current();
      return;
    }
    const { width, height } = sizeRef.current;
    const found = hitTest(orb, viewRef.current, width, height, point.x, point.y);
    const id = found?.id ?? null;
    if (id !== hoverRef.current) {
      hoverRef.current = id;
      setHover(found ? { id: found.id, x: point.x, y: point.y } : null);
      redrawRef.current();
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const orb = orbRef.current;
    if (!drag.moved && orb) {
      const { width, height } = sizeRef.current;
      const point = local(event);
      const found = hitTest(orb, viewRef.current, width, height, point.x, point.y);
      setSelectedId((current) => (found && found.id !== current ? found.id : null));
    } else if (reducedRef.current) {
      spinRef.current = { yaw: 0, pitch: 0 };
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
  const neighbourIds = selected ? orbRef.current?.neighbours.get(selected.id) ?? [] : [];
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
        Every bright dot on the orb is a note an agent filed: a bug, decision, gotcha or pattern. Each arc is a link between two notes about
        the same thing, and notes about the same thing gather in the same patch. Bigger dots connect to more notes, so they are the ideas
        your projects keep running into.
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
              aria-label={`Knowledge orb with ${nodes.length} notes and ${edges.length} connections`}
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerLeave}
              onDoubleClick={() => setZoomBy('reset')}
            />
            <div className="knowledge-map-zoom" role="group" aria-label="Zoom">
              <button type="button" aria-label="Zoom in" title="Zoom in (or scroll up over the orb)" disabled={zoom >= MAX_ZOOM} onClick={() => setZoomBy(1.3)}><Plus size={13} /></button>
              <button type="button" aria-label="Zoom out" title="Zoom out (or scroll down over the orb)" disabled={zoom <= MIN_ZOOM} onClick={() => setZoomBy(1 / 1.3)}><Minus size={13} /></button>
              <button type="button" aria-label="Reset view" title="Reset the view (or double-click the orb)" onClick={() => setZoomBy('reset')}><Maximize2 size={12} /></button>
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
              <small>Most connected notes. Click a dot, or one of these, to bring it round to the front. Drag to spin the orb and scroll to zoom.</small>
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
