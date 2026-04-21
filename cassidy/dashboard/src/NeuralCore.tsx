import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import ForceGraph from 'force-graph';

// ---------------------------------------------------------------------------
// Obsidian-style 2D knowledge-graph view of Cassidy's mind.
// Calm flat aesthetic inspired by Karpathy's LLM Wiki + Obsidian Graph View.
// ---------------------------------------------------------------------------

interface MindmapNode {
  id: string;
  label: string;
  type: 'core' | 'memory' | 'thought' | 'tool' | 'agent' | 'task' | 'objective' | 'reflection' | 'user';
  group: string;
  importance: number;
  detail?: string;
  ts?: string;
  status?: string;
  __degree?: number;
  __neighbors?: Set<string>;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface MindmapLink {
  source: string | MindmapNode;
  target: string | MindmapNode;
  type: 'memory_recall' | 'tool_use' | 'thought_chain' | 'agent_link' | 'task_dep' | 'objective' | 'core';
  strength: number;
  label?: string;
}

interface MindmapResponse {
  nodes: MindmapNode[];
  links: MindmapLink[];
  stats: {
    totalMemories: number;
    activeThoughts: number;
    toolsUsed: number;
    agentsOnline: number;
    tasksToday: number;
  };
}

const NODE_COLORS: Record<string, string> = {
  core:       '#7aa2f7',
  memory:     '#9ece6a',
  thought:    '#bb9af7',
  tool:       '#7dcfff',
  agent:      '#e0af68',
  task:       '#f7768e',
  objective:  '#e0af68',
  reflection: '#bb9af7',
  user:       '#c0caf5',
};

const BG = '#1a1b26';
const EDGE_COLOR = 'rgba(192, 202, 245, 0.12)';
const EDGE_HIGHLIGHT = 'rgba(192, 202, 245, 0.55)';
const LABEL_COLOR = '#a9b1d6';
const LABEL_HIGHLIGHT = '#ffffff';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new Error('UNAUTH');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

interface Props {
  onNodeClick?: (node: MindmapNode | null) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FG = any;

export function NeuralCore({ onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<FG | null>(null);
  const hoverNodeRef = useRef<MindmapNode | null>(null);
  const highlightNodesRef = useRef<Set<string>>(new Set());
  const highlightLinksRef = useRef<Set<MindmapLink>>(new Set());
  const orphanIdsRef = useRef<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<MindmapNode | null>(null);

  const { data, error } = useQuery({
    queryKey: ['mindmap'],
    queryFn: () => fetchJson<MindmapResponse>('/api/dashboard/mindmap'),
    refetchInterval: 8_000,
  });

  const enriched = useMemo(() => {
    if (!data) return null;
    const nodesById = new Map<string, MindmapNode>();
    data.nodes.forEach((n) => {
      n.__degree = 0;
      n.__neighbors = new Set();
      nodesById.set(n.id, n);
    });
    data.links.forEach((l) => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      const s = nodesById.get(sId);
      const t = nodesById.get(tId);
      if (s) { s.__degree = (s.__degree || 0) + 1; s.__neighbors!.add(tId); }
      if (t) { t.__degree = (t.__degree || 0) + 1; t.__neighbors!.add(sId); }
    });

    // Identify orphans = nodes that only touch a single hub (or nothing).
    // Render them as a starfield ring around the dense core to evoke
    // "free-floating thoughts" / single-cell organism cluster.
    const orphans: MindmapNode[] = [];
    data.nodes.forEach((n) => {
      const deg = n.__degree || 0;
      const onlyHubLink = deg === 1 && [...(n.__neighbors || [])].every((id) => id.startsWith('hub-') || id === 'cassidy-core');
      if (deg === 0 || (onlyHubLink && (n.type === 'thought' || n.type === 'memory' || n.type === 'tool'))) {
        // demote weakly-attached small nodes to the orphan ring
        if ((n.importance || 0) <= 3) orphans.push(n);
      }
    });
    const orphanIds = new Set(orphans.map((o) => o.id));

    // Pre-position orphans on a ring so the simulation keeps them out there.
    const ringRadius = 600 + Math.sqrt(data.nodes.length) * 14;
    orphans.forEach((n, i) => {
      const angle = (i / Math.max(1, orphans.length)) * Math.PI * 2;
      n.x = Math.cos(angle) * ringRadius;
      n.y = Math.sin(angle) * ringRadius;
    });

    return { nodes: data.nodes, links: data.links, orphanIds };
  }, [data]);

  useEffect(() => {
    if (!containerRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = ForceGraph as unknown as new (el: HTMLElement) => any;
    const graph: FG = new Ctor(containerRef.current);

    graph
      .backgroundColor(BG)
      .nodeRelSize(3)
      .nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .linkColor(() => EDGE_COLOR)
      .linkWidth((l: MindmapLink) => (highlightLinksRef.current.has(l) ? 1.4 : 0.45))
      .linkDirectionalParticles((l: MindmapLink) => (highlightLinksRef.current.has(l) ? 2 : 0))
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleColor(() => EDGE_HIGHLIGHT)
      .nodeCanvasObject((node: MindmapNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const isHover = hoverNodeRef.current?.id === node.id;
        const isNeighbour = highlightNodesRef.current.has(node.id);
        const dimmed = !!hoverNodeRef.current && !isHover && !isNeighbour;
        const isOrphan = orphanIdsRef.current.has(node.id);

        const degree = node.__degree || 0;
        const baseR = isOrphan ? 1.4 : 2 + Math.sqrt(degree) * 1.3;
        const r = isHover ? baseR * 1.5 : baseR;

        const color = NODE_COLORS[node.type] || '#9aa5ce';

        if (isHover || isNeighbour) {
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r * 2.4, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(color, isHover ? 0.2 : 0.1);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
        const baseAlpha = isOrphan ? 0.55 : 1;
        ctx.fillStyle = dimmed
          ? hexToRgba(color, 0.22)
          : (isOrphan ? hexToRgba(color, baseAlpha) : color);
        ctx.fill();

        if (!isOrphan) {
          ctx.lineWidth = 1 / globalScale;
          ctx.strokeStyle = dimmed ? 'rgba(0,0,0,0.2)' : 'rgba(26,27,38,0.9)';
          ctx.stroke();
        }

        const isHub = node.id.startsWith('hub-') || node.id === 'cassidy-core';
        const showLabel = isHub || globalScale >= 1.6 || isHover || isNeighbour;
        if (showLabel) {
          const fontSize = Math.max(2.5, (isHub ? 13 : 10) / globalScale);
          ctx.font = `${isHub ? '600 ' : ''}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = isHover ? LABEL_HIGHLIGHT : LABEL_COLOR;
          if (dimmed) ctx.fillStyle = 'rgba(169,177,214,0.3)';
          const label = node.label.length > 32 ? node.label.slice(0, 30) + '\u2026' : node.label;
          ctx.fillText(label, node.x!, node.y! + r + 2);
        }
      })
      .nodePointerAreaPaint((node: MindmapNode, color: string, ctx: CanvasRenderingContext2D) => {
        const degree = node.__degree || 0;
        const r = (2 + Math.sqrt(degree) * 1.3) * 1.6;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, Math.max(3, r), 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeHover((node: MindmapNode | null) => {
        hoverNodeRef.current = node;
        highlightNodesRef.current.clear();
        highlightLinksRef.current.clear();
        if (node) {
          highlightNodesRef.current.add(node.id);
          node.__neighbors?.forEach((id) => highlightNodesRef.current.add(id));
          const g = graphRef.current;
          if (g) {
            const links = (g.graphData() as { links: MindmapLink[] }).links;
            links.forEach((l) => {
              const sId = typeof l.source === 'string' ? l.source : (l.source as MindmapNode).id;
              const tId = typeof l.target === 'string' ? l.target : (l.target as MindmapNode).id;
              if (sId === node.id || tId === node.id) highlightLinksRef.current.add(l);
            });
          }
        }
        if (containerRef.current) {
          containerRef.current.style.cursor = node ? 'pointer' : 'default';
        }
      })
      .onNodeClick((node: MindmapNode) => {
        setSelectedNode(node);
        onNodeClick?.(node);
        graphRef.current?.centerAt(node.x, node.y, 800);
        graphRef.current?.zoom(2.2, 800);
      })
      .onBackgroundClick(() => {
        setSelectedNode(null);
        onNodeClick?.(null);
      })
      .cooldownTicks(180)
      .d3AlphaDecay(0.012)
      .d3VelocityDecay(0.32);

    // Tight clustering — short links, gentle repulsion → dense organic blob.
    graph.d3Force('charge')?.strength(-55).distanceMax(280);
    graph.d3Force('link')?.distance((l: MindmapLink) => {
      const sId = typeof l.source === 'string' ? l.source : (l.source as MindmapNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as MindmapNode).id;
      // Hub spokes a bit longer; intra-cluster links short for the brain look.
      return (sId.startsWith('hub-') || tId.startsWith('hub-')) ? 50 : 22;
    }).strength(0.6);
    graph.d3Force('center')?.strength(0.04);

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
  }, [onNodeClick]);

  useEffect(() => {
    if (!graphRef.current || !enriched) return;
    orphanIdsRef.current = enriched.orphanIds;
    graphRef.current.graphData({ nodes: enriched.nodes, links: enriched.links });
  }, [enriched]);

  const handleReset = useCallback(() => {
    graphRef.current?.zoomToFit(800, 60);
    setSelectedNode(null);
    onNodeClick?.(null);
  }, [onNodeClick]);

  const typeCounts = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    data.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    return counts;
  }, [data]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 500, background: BG }}>
      {data?.stats && (
        <div className="neural-kpi-bar">
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: NODE_COLORS.memory }}>{data.stats.totalMemories}</span><span className="neural-kpi-lbl">Memories</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: NODE_COLORS.thought }}>{data.stats.activeThoughts}</span><span className="neural-kpi-lbl">Thoughts</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: NODE_COLORS.tool }}>{data.stats.toolsUsed}</span><span className="neural-kpi-lbl">Tools</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: NODE_COLORS.agent }}>{data.stats.agentsOnline}</span><span className="neural-kpi-lbl">Agents</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: NODE_COLORS.task }}>{data.stats.tasksToday}</span><span className="neural-kpi-lbl">Tasks</span></div>
        </div>
      )}

      <div className="neural-controls">
        <button className="neural-btn" onClick={handleReset} title="Fit graph to view">Fit</button>
      </div>

      <div className="neural-legend">
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <div key={type} className="neural-legend-item">
            <span className="neural-legend-dot" style={{ background: color }} />
            <span>{type}{typeCounts[type] ? ` (${typeCounts[type]})` : ''}</span>
          </div>
        ))}
      </div>

      {selectedNode && (
        <div className="neural-detail-panel">
          <div className="neural-detail-header">
            <span className="neural-detail-dot" style={{ background: NODE_COLORS[selectedNode.type] }} />
            <strong>{selectedNode.label}</strong>
            <button className="neural-detail-close" onClick={() => { setSelectedNode(null); onNodeClick?.(null); }}>x</button>
          </div>
          <div className="neural-detail-type">
            {selectedNode.type} &mdash; importance {selectedNode.importance}/10
            {selectedNode.__degree !== undefined ? ` \u2014 ${selectedNode.__degree} links` : ''}
          </div>
          {selectedNode.detail && <div className="neural-detail-body">{selectedNode.detail}</div>}
          {selectedNode.ts && <div className="neural-detail-ts">{new Date(selectedNode.ts).toLocaleString()}</div>}
          {selectedNode.status && <div className="neural-detail-status">Status: {selectedNode.status}</div>}
        </div>
      )}

      {error && (
        <div style={{ position: 'absolute', top: 60, left: 20, color: '#f7768e', fontSize: 13 }}>
          Failed to load mindmap: {(error as Error).message}
        </div>
      )}

      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

function hexToRgba(hex: string, a: number): string {
  const m = hex.replace('#', '');
  const bigint = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
