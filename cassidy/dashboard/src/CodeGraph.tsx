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
    // The codebase doesn't change while the user is watching it. Disable
    // background refetching so the camera never gets reset under the user
    // mid-demo. Manual ↻ button still works via refetch().
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
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

        // Active-element ORB — soft breathing halo around any node that
        // has fired recently (lasts ~12s, gently pulses while alive).
        const ORB_TTL_MS = 12_000;
        const pulseTs = pulseRef.current.get(node.id);
        if (pulseTs) {
          const age = Date.now() - pulseTs;
          if (age < ORB_TTL_MS) {
            const lifeP = age / ORB_TTL_MS;
            // Slow breathing oscillation (~2s period)
            const breathe = 0.5 + 0.5 * Math.sin(age / 320);
            const baseAlpha = (1 - lifeP) * 0.65;
            // Outer soft orb (large, very soft)
            const orbR = r + 6 + breathe * 6;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, orbR * 1.6, 0, 2 * Math.PI);
            ctx.fillStyle = hexToRgba(color, baseAlpha * 0.18);
            ctx.fill();
            // Mid orb
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, orbR, 0, 2 * Math.PI);
            ctx.fillStyle = hexToRgba(color, baseAlpha * 0.32);
            ctx.fill();
            // Crisp ring at the centre dot
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r * 1.6, 0, 2 * Math.PI);
            ctx.strokeStyle = hexToRgba('#ffffff', baseAlpha * 0.55);
            ctx.lineWidth = Math.max(0.5, 1.2 / globalScale);
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

        // Labels: always for hover/match, automatically for ALL nodes
        // once the user zooms in enough that the labels won't overlap.
        // Threshold tuned so labels appear smoothly as you zoom into a
        // cluster — perfect for showing one node at a time.
        const showAutoLabel = globalScale > 1.6;
        if (isHover || isMatch || showAutoLabel) {
          const fontSize = Math.max(3, 10 / globalScale);
          ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          // Soft dark backing so labels stay readable over synapse glow
          const textW = ctx.measureText(node.label).width;
          const padX = 2 / globalScale;
          const padY = 1 / globalScale;
          ctx.fillStyle = isHover
            ? 'rgba(0,0,0,0.85)'
            : `rgba(0,0,0,${Math.min(0.7, (globalScale - 1.4) * 0.8)})`;
          ctx.fillRect(
            node.x! - textW / 2 - padX,
            node.y! + r + 1.5,
            textW + padX * 2,
            fontSize + padY * 2,
          );
          ctx.fillStyle = isHover ? '#fff' : `rgba(255,255,255,${Math.min(1, (globalScale - 1.4) * 1.4)})`;
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
      // Keep the d3-force engine alive forever so force-graph keeps
      // calling onRenderFramePost (where our synapses + ants are drawn).
      // alphaDecay=0 means the simulation never cools below alphaMin,
      // and very strong velocityDecay (0.97) means nodes barely drift.
      // Result: continuous 60fps repaints, but the layout stays put
      // after the initial settle.
      .cooldownTicks(Infinity)
      .cooldownTime(Infinity)
      .warmupTicks(120)
      .d3AlphaMin(0)
      .d3AlphaDecay(0)
      .d3VelocityDecay(0.97);

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

    const onResize = () => {
      graph.width(containerRef.current?.clientWidth || window.innerWidth);
      graph.height(containerRef.current?.clientHeight || window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    onResize();

    return () => {
      window.removeEventListener('resize', onResize);
      graph._destructor?.();
    };
  }, []);

  // Index for O(1) lookup inside render callbacks
  const idIndex = useRef<Map<string, CodeNode>>(new Map());
  const searchMatchesRef = useRef<Set<string>>(new Set());
  const neighboursRef = useRef<Map<string, string[]>>(new Map());

  // Push data into the graph — guard against re-running on the same
  // payload so the user's zoom level is never reset mid-demo.
  const loadedBuiltAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (!graphRef.current || !data) return;
    if (loadedBuiltAtRef.current === data.builtAt) return;
    loadedBuiltAtRef.current = data.builtAt;
    // Augment nodes with color + radius
    idIndex.current.clear();
    neighboursRef.current.clear();
    for (const n of data.nodes) {
      n.__color = colorByCommunity.get(n.community) || '#9aa5ce';
      n.__r = 1 + Math.sqrt((n.degree || 0)) * 0.9 + Math.log10(Math.max(10, n.size)) * 0.4;
      idIndex.current.set(n.id, n);
    }
    // Build adjacency list from import edges → drives the synapses
    // AND the telemetry pop-out's connections list.
    for (const e of data.edges) {
      const sId = typeof e.source === 'string' ? e.source : (e.source as CodeNode).id;
      const tId = typeof e.target === 'string' ? e.target : (e.target as CodeNode).id;
      const sArr = neighboursRef.current.get(sId) || [];
      if (!sArr.includes(tId)) sArr.push(tId);
      neighboursRef.current.set(sId, sArr);
      const tArr = neighboursRef.current.get(tId) || [];
      if (!tArr.includes(sId)) tArr.push(sId);
      neighboursRef.current.set(tId, tArr);
    }
    graphRef.current.graphData({ nodes: data.nodes, links: data.edges });
    // ONE-TIME initial fit. Subsequent renders preserve the user's zoom.
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
          ) : (() => {
            const neighbourIds = neighboursRef.current.get(selected.id) || [];
            const neighbours = neighbourIds
              .map((id) => idIndex.current.get(id))
              .filter((n): n is CodeNode => !!n);
            const communityLabel = data?.communities.find((c) => c.id === selected.community)?.label || selected.community;
            const explanation = describeNode(selected, communityLabel, neighbours.length);
            return (
              <div className="cg-node-info">
                <div className="cg-node-label" style={{ color: selected.__color }}>{selected.label}</div>
                <div className="cg-node-meta">{selected.id}</div>
                <div className="cg-node-meta">
                  <span className="cg-comm-dot" style={{ background: selected.__color, marginRight: 6 }} />
                  {communityLabel}
                </div>
                <div className="cg-node-meta">{selected.degree || 0} edges · {selected.size} loc</div>
                <div className="cg-node-explain">{explanation}</div>
                <div className="cg-node-conns-title">CONNECTED TO ({neighbours.length})</div>
                {neighbours.length === 0 ? (
                  <div className="cg-muted" style={{ fontSize: 11 }}>No imports in or out (utility / leaf module).</div>
                ) : (
                  <div className="cg-conns">
                    {neighbours.slice(0, 24).map((n) => (
                      <button
                        key={n.id}
                        className="cg-conn-row"
                        title={n.id}
                        onClick={() => {
                          setSelected(n);
                          if (n.x != null && n.y != null) {
                            graphRef.current?.centerAt(n.x, n.y, 600);
                          }
                        }}
                      >
                        <span className="cg-comm-dot" style={{ background: n.__color }} />
                        <span className="cg-conn-label">{n.label}</span>
                      </button>
                    ))}
                    {neighbours.length > 24 && (
                      <div className="cg-muted" style={{ fontSize: 11, marginTop: 4 }}>+{neighbours.length - 24} more…</div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
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

/**
 * Build a short human-readable explanation for a node based on its
 * file path, community and degree. Heuristic — no source-reading.
 */
function describeNode(node: CodeNode, communityLabel: string, degree: number): string {
  const id = node.id.toLowerCase();
  const label = node.label.toLowerCase();
  const role: string[] = [];
  if (label.endsWith('.test.ts') || label.endsWith('.test.tsx')) role.push('Test suite');
  else if (label === 'index.ts' || label === 'agent.ts') role.push('Entrypoint / orchestrator');
  else if (id.includes('/tools/')) role.push('Agent tool definition');
  else if (id.includes('/orchestrator/')) role.push('Multi-step orchestrator');
  else if (id.includes('/intelligence/')) role.push('Reasoning / intelligence module');
  else if (id.includes('/memory/')) role.push('Memory / persistence layer');
  else if (id.includes('/proactive/')) role.push('Proactive trigger');
  else if (id.includes('/reports/')) role.push('Report generator');
  else if (id.includes('/voice/')) role.push('Voice IO module');
  else if (id.includes('/meetings/')) role.push('Meeting handler');
  else if (id.includes('/scheduler/')) role.push('Scheduling module');
  else if (id.includes('/workqueue/')) role.push('Work-queue handler');
  else if (id.includes('/autonomous/')) role.push('Autonomous loop');
  else if (label.includes('logger')) role.push('Logging utility');
  else if (label.includes('cache')) role.push('Cache layer');
  else if (label.includes('auth')) role.push('Auth handler');
  else if (label.includes('telemetry')) role.push('Telemetry sink');
  else if (label.includes('retry')) role.push('Retry helper');
  else if (label.includes('analytics')) role.push('Analytics helper');
  else role.push(`${communityLabel} module`);

  const conn = degree === 0
    ? 'Standalone — no other source file imports it (utility or leaf).'
    : degree === 1
      ? 'Connects to 1 other module.'
      : `Connects to ${degree} other modules.`;
  return `${role[0]}. ${conn}`;
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
 * Draw a single synapse: a static thin line + 2-3 "ants" (small dots)
 * walking from a → b along it. The line itself doesn't move-with-the-nodes
 * because we never store control points; we just draw a straight chord
 * each frame. The motion you see is the ants, not the curve.
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

  // Lifecycle: fade in (0–500ms), hold, fade out (last 30%).
  const lifeProgress = age / SYNAPSE_TTL_MS;
  const fadeIn = Math.min(1, age / 500);
  const fadeOut = Math.max(0, 1 - Math.max(0, lifeProgress - 0.7) / 0.3);
  const baseAlpha = fadeIn * fadeOut;
  if (baseAlpha <= 0.02) return;

  // Faint trail line — very subtle so the ants are the focal point.
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = hexToRgba(s.color, baseAlpha * 0.18);
  ctx.lineWidth = Math.max(0.4, 0.8 / globalScale);
  ctx.lineCap = 'round';
  ctx.stroke();

  // 3 ants walking the line at offset phases — gives a "stream" feel.
  const antR = Math.max(1.2, 2.4 / globalScale);
  const numAnts = 3;
  for (let k = 0; k < numAnts; k++) {
    const phase = k / numAnts;
    const tRaw = (age / s.travelMs + phase) % 1;
    // Ease in/out so ants briefly slow at endpoints — feels biological
    const t = tRaw < 0.5
      ? 2 * tRaw * tRaw
      : 1 - Math.pow(-2 * tRaw + 2, 2) / 2;

    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;

    // Soft outer halo
    ctx.beginPath();
    ctx.arc(px, py, antR * 4, 0, 2 * Math.PI);
    ctx.fillStyle = hexToRgba(s.color, baseAlpha * 0.28);
    ctx.fill();

    // Mid glow
    ctx.beginPath();
    ctx.arc(px, py, antR * 2, 0, 2 * Math.PI);
    ctx.fillStyle = hexToRgba(s.color, baseAlpha * 0.55);
    ctx.fill();

    // White-hot ant body
    ctx.beginPath();
    ctx.arc(px, py, antR, 0, 2 * Math.PI);
    ctx.fillStyle = hexToRgba('#ffffff', baseAlpha * 0.95);
    ctx.fill();
  }
}
