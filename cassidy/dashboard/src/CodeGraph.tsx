import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import ForceGraph from 'force-graph';

// ---------------------------------------------------------------------------
// Codebase starfield — Graphify-inspired prototype.
// Nodes = source files, edges = imports, communities = top-level folder.
// Pulses nodes whose community matches a recent agent event (live "thinking").
// Built entirely in-house with the same `force-graph` canvas library used
// by Agent Mind — no Graphify code is bundled or copied.
// ---------------------------------------------------------------------------

interface CodeNode {
  id: string;
  label: string;
  community: string;
  size: number;
  degree?: number;
  // augmented at runtime
  __color?: string;
  __r?: number;
  __pulse?: number; // ms timestamp of last pulse
  // physics (force-graph mutates these)
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}
interface CodeEdge { source: string | CodeNode; target: string | CodeNode; }
interface CodeCommunity { id: string; label: string; color: string; count: number }
interface CodeGraphResponse {
  nodes: CodeNode[];
  edges: CodeEdge[];
  communities: CodeCommunity[];
  builtAt: string;
}

/**
 * Ephemeral "synapse" — a transient curved arc drawn between two nodes
 * to visualise an inferred connection between thoughts. Lives ~6s and fades.
 */
interface Synapse {
  a: CodeNode;
  b: CodeNode;
  bornAt: number;
  color: string;
  /** ms it takes the travelling spark to traverse the curve */
  travelMs: number;
}

const SYNAPSE_TTL_MS = 14_000;     // longer life so the eye catches them
const MAX_SYNAPSES = 140;
const MIN_SYNAPSES_VISIBLE = 6;    // ambient brain-activity baseline

interface AgentEvent {
  id: string;
  ts: string;
  kind: string;
  label: string;
  module?: string;
  data?: Record<string, unknown>;
}

const BG = '#0b0d14';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FG = any;

export function CodeGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<FG | null>(null);
  const hiddenCommsRef = useRef<Set<string>>(new Set());
  const pulseRef = useRef<Map<string, number>>(new Map());
  const synapsesRef = useRef<Synapse[]>([]);
  const lastPulsedRef = useRef<{ node: CodeNode; community: string } | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const hoverNodeRef = useRef<CodeNode | null>(null);
  const [selected, setSelected] = useState<CodeNode | null>(null);
  const [search, setSearch] = useState('');
  const [, forceRender] = useState(0); // to repaint sidebar on toggle

  const { data, error, refetch } = useQuery({
    queryKey: ['codegraph'],
    queryFn: () => fetchJson<CodeGraphResponse>('/api/dashboard/codegraph'),
    staleTime: 60_000,
  });

  // Live agent-event polling — when a new event lands, pulse nodes in
  // the matching community.
  const { data: eventsResp } = useQuery({
    queryKey: ['codegraph-events'],
    queryFn: () => fetchJson<{ events: AgentEvent[] }>(
      `/api/dashboard/events?limit=20${lastEventIdRef.current ? `&sinceId=${lastEventIdRef.current}` : ''}`,
    ),
    refetchInterval: 2_500,
  });

  // Index node → color, and pre-compute lookups
  const colorByCommunity = useMemo(() => {
    const m = new Map<string, string>();
    data?.communities.forEach((c) => m.set(c.id, c.color));
    return m;
  }, [data]);

  const moduleToCommunity = useMemo(() => {
    // Map an event's `module` field (e.g. 'corpgen.day' or 'tools.mcp')
    // onto a top-level folder community.
    if (!data) return new Map<string, string>();
    const m = new Map<string, string>();
    for (const c of data.communities) m.set(c.id, c.id);
    return m;
  }, [data]);

  // React to new events → register pulses + synapses (along REAL import edges)
  useEffect(() => {
    if (!eventsResp?.events?.length || !data) return;
    const fresh = eventsResp.events;
    const now = Date.now();
    for (let evIdx = 0; evIdx < fresh.length; evIdx++) {
      const ev = fresh[evIdx];
      lastEventIdRef.current = ev.id;
      const top = ev.module?.split('.')[0] || '';
      const community = moduleToCommunity.get(top);
      if (!community) continue;
      const matching = data.nodes.filter((n) => n.community === community);
      if (matching.length === 0) continue;

      // Prefer high-degree ("important") nodes — they have actual import
      // wiring to traverse, which is what makes the synapses visible.
      const sorted = [...matching].sort((a, b) => (b.degree || 0) - (a.degree || 0));
      const epicentre = sorted[Math.floor(Math.random() * Math.min(8, sorted.length))];
      const sample = [epicentre, ...sorted.slice(1, 5).sort(() => Math.random() - 0.5).slice(0, 3)];
      for (const n of sample) pulseRef.current.set(n.id, now);

      const color = colorByCommunity.get(community) || '#9aa5ce';

      // PRIMARY: spread synapses along the actual import edges of the
      // epicentre. This is what makes the visualisation feel like a brain
      // — thoughts travel along the wiring that genuinely connects code.
      const neighbours = neighboursRef.current.get(epicentre.id) || [];
      const picked = neighbours
        .map((id) => idIndex.current.get(id))
        .filter((n): n is CodeNode => !!n)
        .sort(() => Math.random() - 0.5)
        .slice(0, 6);
      for (let i = 0; i < picked.length; i++) {
        const tgt = picked[i];
        synapsesRef.current.push({
          a: epicentre, b: tgt,
          bornAt: now + i * 220,         // staggered — cascading dendrite firing
          color,
          travelMs: 3500 + Math.random() * 1500,
        });
        // Also pulse the target so the receiver "lights up" when the spark arrives
        pulseRef.current.set(tgt.id, now + i * 220);
      }

      // SECONDARY: chain pulsed nodes inside the community when imports
      // alone don't cover them — keeps activity inside the cluster.
      for (let i = 0; i < sample.length - 1; i++) {
        if (sample[i] !== sample[i + 1]) {
          synapsesRef.current.push({
            a: sample[i], b: sample[i + 1],
            bornAt: now + 400 + i * 180,
            color,
            travelMs: 3000 + Math.random() * 1500,
          });
        }
      }

      // CROSS-EVENT: bridge from the previous thought's last node to this
      // one's epicentre — the slow long arc that carries the stream of
      // consciousness from one part of the brain to another.
      const prev = lastPulsedRef.current;
      if (prev && prev.node !== epicentre) {
        synapsesRef.current.push({
          a: prev.node, b: epicentre,
          bornAt: now + 600,
          color: blendColors(colorByCommunity.get(prev.community) || color, color),
          travelMs: 5500 + Math.random() * 2500, // really slow inter-region jump
        });
      }
      lastPulsedRef.current = { node: epicentre, community };
    }

    if (synapsesRef.current.length > MAX_SYNAPSES) {
      synapsesRef.current = synapsesRef.current.slice(-MAX_SYNAPSES);
    }
  }, [eventsResp, data, moduleToCommunity, colorByCommunity]);

  // Search highlight
  const searchMatches = useMemo(() => {
    if (!search.trim() || !data) return new Set<string>();
    const q = search.trim().toLowerCase();
    return new Set(
      data.nodes
        .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        .map((n) => n.id),
    );
  }, [search, data]);

  // Build / mount force-graph
  useEffect(() => {
    if (!containerRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = ForceGraph as unknown as new (el: HTMLElement) => any;
    const graph: FG = new Ctor(containerRef.current);

    graph
      .backgroundColor(BG)
      .nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .linkColor((l: CodeEdge) => {
        const sId = typeof l.source === 'string' ? l.source : (l.source as CodeNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as CodeNode).id;
        const sN = idIndex.current.get(sId);
        const tN = idIndex.current.get(tId);
        const hidden = (sN && hiddenCommsRef.current.has(sN.community))
                    || (tN && hiddenCommsRef.current.has(tN.community));
        if (hidden) return 'rgba(0,0,0,0)';
        // color edge by source community, low opacity for "wispy" look
        const c = sN ? sN.__color || '#888' : '#888';
        return hexToRgba(c, 0.1);
      })
      .linkWidth(0.4)
      .nodeCanvasObject((node: CodeNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        if (hiddenCommsRef.current.has(node.community)) return;
        const isHover = hoverNodeRef.current?.id === node.id;
        const isMatch = searchMatchesRef.current.has(node.id);
        const dimmed = !!searchMatchesRef.current.size && !isMatch;

        const baseR = node.__r || 1.5;
        const r = isHover ? baseR * 2 : baseR;
        const color = node.__color || '#9aa5ce';

        // Pulse halo (decays over ~1.5s)
        const pulseTs = pulseRef.current.get(node.id);
        if (pulseTs) {
          const age = Date.now() - pulseTs;
          if (age < 1500) {
            const alpha = (1 - age / 1500) * 0.7;
            const haloR = r + (age / 1500) * 12;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, haloR, 0, 2 * Math.PI);
            ctx.fillStyle = hexToRgba(color, alpha * 0.4);
            ctx.fill();
            ctx.strokeStyle = hexToRgba('#ffffff', alpha);
            ctx.lineWidth = 1.2 / globalScale;
            ctx.stroke();
          } else {
            pulseRef.current.delete(node.id);
          }
        }

        // Search/hover halo
        if (isMatch || isHover) {
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r * 3, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(color, 0.2);
          ctx.fill();
        }

        // Core dot
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
        ctx.fillStyle = dimmed ? hexToRgba(color, 0.2) : color;
        ctx.fill();

        // Hover/match label
        if (isHover || (isMatch && globalScale > 1.5)) {
          const fontSize = Math.max(3, 10 / globalScale);
          ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(node.label, node.x!, node.y! + r + 2);
        }
      })
      .nodePointerAreaPaint((node: CodeNode, color: string, ctx: CanvasRenderingContext2D) => {
        if (hiddenCommsRef.current.has(node.community)) return;
        const r = (node.__r || 1.5) * 2.5;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, Math.max(3, r), 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .onNodeHover((node: CodeNode | null) => {
        hoverNodeRef.current = node;
        if (containerRef.current) {
          containerRef.current.style.cursor = node ? 'pointer' : 'default';
        }
      })
      .onNodeClick((node: CodeNode) => {
        setSelected(node);
        graphRef.current?.centerAt(node.x, node.y, 600);
        graphRef.current?.zoom(2.5, 600);
      })
      .onBackgroundClick(() => setSelected(null))
      .cooldownTicks(220)
      .d3AlphaDecay(0.01)
      .d3VelocityDecay(0.3);

    graph.d3Force('charge')?.strength(-22).distanceMax(220);
    graph.d3Force('link')?.distance(18).strength(0.5);
    graph.d3Force('center')?.strength(0.04);

    // Custom overlay pass — synapses (animated arcs between thought nodes).
    // Rendered AFTER nodes so the glow sits on top.
    graph.onRenderFramePost?.((ctx: CanvasRenderingContext2D, globalScale: number) => {
      const now = Date.now();
      const live: Synapse[] = [];
      for (const s of synapsesRef.current) {
        const age = now - s.bornAt;
        if (age < 0) { live.push(s); continue; }
        if (age > SYNAPSE_TTL_MS) continue;
        if (hiddenCommsRef.current.has(s.a.community) || hiddenCommsRef.current.has(s.b.community)) {
          live.push(s); continue;
        }
        if (s.a.x == null || s.b.x == null) { live.push(s); continue; }
        live.push(s);
        drawSynapse(ctx, s, age, globalScale);
      }
      synapsesRef.current = live;
    });

    graphRef.current = graph;

    // Continuous repaint so pulses animate even when forces have settled.
    let raf = 0;
    const tick = () => { graph._animationFrameRequested = false; graph.refresh?.(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      graph.width(containerRef.current?.clientWidth || window.innerWidth);
      graph.height(containerRef.current?.clientHeight || window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    onResize();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      graph._destructor?.();
    };
  }, []);

  // Index for O(1) lookup inside render callbacks
  const idIndex = useRef<Map<string, CodeNode>>(new Map());
  const searchMatchesRef = useRef<Set<string>>(new Set());
  const neighboursRef = useRef<Map<string, string[]>>(new Map());

  // Push data into the graph
  useEffect(() => {
    if (!graphRef.current || !data) return;
    // Augment nodes with color + radius
    idIndex.current.clear();
    neighboursRef.current.clear();
    for (const n of data.nodes) {
      n.__color = colorByCommunity.get(n.community) || '#9aa5ce';
      n.__r = 1 + Math.sqrt((n.degree || 0)) * 0.9 + Math.log10(Math.max(10, n.size)) * 0.4;
      idIndex.current.set(n.id, n);
    }
    // Build adjacency list from import edges → drives the synapses.
    for (const e of data.edges) {
      const sId = typeof e.source === 'string' ? e.source : (e.source as CodeNode).id;
      const tId = typeof e.target === 'string' ? e.target : (e.target as CodeNode).id;
      const sArr = neighboursRef.current.get(sId) || [];
      sArr.push(tId);
      neighboursRef.current.set(sId, sArr);
      const tArr = neighboursRef.current.get(tId) || [];
      tArr.push(sId);
      neighboursRef.current.set(tId, tArr);
    }
    graphRef.current.graphData({ nodes: data.nodes, links: data.edges });
    // Initial fit
    setTimeout(() => graphRef.current?.zoomToFit(800, 80), 800);
  }, [data, colorByCommunity]);

  // Keep search-matches ref in sync
  useEffect(() => { searchMatchesRef.current = searchMatches; }, [searchMatches]);

  // Ambient brain activity — every ~1.2s, fire a synapse along a random
  // import edge so the graph always feels alive even between agent events.
  // This is the "resting-state" cortex.
  useEffect(() => {
    if (!data || data.edges.length === 0) return;
    const id = setInterval(() => {
      // Don't drown out real activity
      if (synapsesRef.current.length >= MAX_SYNAPSES - 10) return;
      const target = Math.max(MIN_SYNAPSES_VISIBLE - synapsesRef.current.length, 1);
      for (let k = 0; k < target; k++) {
        const e = data.edges[Math.floor(Math.random() * data.edges.length)];
        const sId = typeof e.source === 'string' ? e.source : (e.source as CodeNode).id;
        const tId = typeof e.target === 'string' ? e.target : (e.target as CodeNode).id;
        const a = idIndex.current.get(sId);
        const b = idIndex.current.get(tId);
        if (!a || !b || a === b) continue;
        if (hiddenCommsRef.current.has(a.community) || hiddenCommsRef.current.has(b.community)) continue;
        synapsesRef.current.push({
          a, b,
          bornAt: Date.now(),
          color: a.__color || '#7aa2f7',
          travelMs: 4000 + Math.random() * 2000,
        });
      }
    }, 1200);
    return () => clearInterval(id);
  }, [data]);

  const toggleCommunity = useCallback((id: string) => {
    const set = hiddenCommsRef.current;
    if (set.has(id)) set.delete(id); else set.add(id);
    forceRender((x) => x + 1);
  }, []);

  const handleFit = useCallback(() => {
    graphRef.current?.zoomToFit(800, 60);
    setSelected(null);
  }, []);

  return (
    <div className="codegraph-wrap" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 600, background: BG }}>
      <div className="codegraph-toolbar">
        <input
          type="search"
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="codegraph-search"
        />
      </div>

      <div className="codegraph-side">
        <div className="cg-section">
          <div className="cg-section-title">NODE INFO</div>
          {!selected ? (
            <div className="cg-muted">Click a node to inspect it</div>
          ) : (
            <div className="cg-node-info">
              <div className="cg-node-label" style={{ color: selected.__color }}>{selected.label}</div>
              <div className="cg-node-meta">{selected.id}</div>
              <div className="cg-node-meta">{selected.degree || 0} edges · {selected.size} loc</div>
              <div className="cg-node-meta">community: <strong>{selected.community}</strong></div>
            </div>
          )}
        </div>

        <div className="cg-section">
          <div className="cg-section-title">COMMUNITIES</div>
          <div className="cg-commlist">
            {data?.communities.map((c) => {
              const hidden = hiddenCommsRef.current.has(c.id);
              return (
                <button
                  key={c.id}
                  className={`cg-comm-row${hidden ? ' is-off' : ''}`}
                  onClick={() => toggleCommunity(c.id)}
                  title={`Toggle ${c.label}`}
                >
                  <span className="cg-comm-dot" style={{ background: c.color }} />
                  <span className="cg-comm-label">{c.label}</span>
                  <span className="cg-comm-count">{c.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="codegraph-fab">
        <button onClick={handleFit} className="cg-btn">Fit</button>
        <button onClick={() => refetch()} className="cg-btn" title="Rebuild">↻</button>
      </div>

      {data && (
        <div className="codegraph-stats">
          {data.nodes.length} nodes · {data.edges.length} edges · {data.communities.length} communities
        </div>
      )}

      {error && (
        <div style={{ position: 'absolute', top: 60, left: 20, color: '#f7768e', fontSize: 13 }}>
          Failed to load codebase graph: {(error as Error).message}
        </div>
      )}

      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

function hexToRgba(hex: string, a: number): string {
  if (hex.startsWith('rgba')) return hex;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function blendColors(a: string, b: string): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round((x + y) / 2).toString(16).padStart(2, '0');
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`;
}

/**
 * Draw a single synapse: a curved bezier arc between two nodes with a
 * travelling spark and a fading glow. The curve's control point is
 * perpendicular to the chord — gives the brain-tissue, dendritic look.
 */
function drawSynapse(
  ctx: CanvasRenderingContext2D,
  s: Synapse,
  age: number,
  globalScale: number,
): void {
  const ax = s.a.x!, ay = s.a.y!;
  const bx = s.b.x!, by = s.b.y!;
  const dx = bx - ax, dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.5) return;

  // Perpendicular control point — curvature scales with distance.
  const curvature = Math.min(120, dist * 0.4);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const cx = mx - (dy / dist) * curvature;
  const cy = my + (dx / dist) * curvature;

  // Lifecycle: fade in (0–500ms), hold, fade out (last 30%).
  const lifeProgress = age / SYNAPSE_TTL_MS;
  const fadeIn = Math.min(1, age / 500);
  const fadeOut = Math.max(0, 1 - Math.max(0, lifeProgress - 0.7) / 0.3);
  const baseAlpha = fadeIn * fadeOut;
  if (baseAlpha <= 0.02) return;

  // Wide outer glow (the bloom)
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.strokeStyle = hexToRgba(s.color, baseAlpha * 0.32);
  ctx.lineWidth = Math.max(3, 8 / globalScale);
  ctx.lineCap = 'round';
  ctx.stroke();

  // Mid-stroke
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.strokeStyle = hexToRgba(s.color, baseAlpha * 0.65);
  ctx.lineWidth = Math.max(1.4, 3 / globalScale);
  ctx.stroke();

  // Bright inner core line (white-tinted)
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.strokeStyle = hexToRgba('#ffffff', baseAlpha * 0.55);
  ctx.lineWidth = Math.max(0.6, 1 / globalScale);
  ctx.stroke();

  // Travelling spark — a bright dot moving along the curve. Loops if the
  // synapse outlives one travel cycle.
  const t = (age % s.travelMs) / s.travelMs;
  // Quadratic bezier point at t
  const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
  const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
  const sparkR = Math.max(1.5, 3 / globalScale);

  // Outer spark glow
  ctx.beginPath();
  ctx.arc(px, py, sparkR * 6, 0, 2 * Math.PI);
  ctx.fillStyle = hexToRgba(s.color, baseAlpha * 0.4);
  ctx.fill();

  // Mid spark glow
  ctx.beginPath();
  ctx.arc(px, py, sparkR * 2.5, 0, 2 * Math.PI);
  ctx.fillStyle = hexToRgba(s.color, baseAlpha * 0.7);
  ctx.fill();

  // Spark core (white-hot)
  ctx.beginPath();
  ctx.arc(px, py, sparkR, 0, 2 * Math.PI);
  ctx.fillStyle = hexToRgba('#ffffff', baseAlpha);
  ctx.fill();
}
