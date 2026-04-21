import { useEffect, useRef, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ForceGraph3D from '3d-force-graph';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MindmapNode {
  id: string;
  label: string;
  type: 'core' | 'memory' | 'thought' | 'tool' | 'agent' | 'task' | 'objective' | 'reflection' | 'user';
  group: string;
  importance: number; // 1-10
  detail?: string;
  ts?: string;
  status?: string;
}

interface MindmapLink {
  source: string;
  target: string;
  type: 'memory_recall' | 'tool_use' | 'thought_chain' | 'agent_link' | 'task_dep' | 'objective' | 'core';
  strength: number; // 0-1
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

// ---------------------------------------------------------------------------
// Visual Config
// ---------------------------------------------------------------------------

const NODE_COLORS: Record<string, string> = {
  core:       '#4ea1ff', // accent blue — Cassidy's core
  memory:     '#00ffcc', // cyan-green
  thought:    '#bf00ff', // electric purple
  tool:       '#00ff66', // matrix green
  agent:      '#ff6600', // amber
  task:       '#ff3366', // hot pink
  objective:  '#ffcc00', // gold
  reflection: '#9966ff', // soft purple
  user:       '#ffffff', // white
};

const NODE_SHAPES: Record<string, number> = {
  core: 0,       // sphere
  memory: 1,     // diamond (octahedron)
  thought: 0,    // sphere
  tool: 2,       // box
  agent: 3,      // dodecahedron
  task: 2,       // box
  objective: 3,  // dodecahedron
  reflection: 0, // sphere
  user: 0,       // sphere
};

const LINK_COLORS: Record<string, string> = {
  memory_recall: 'rgba(0,255,204,0.15)',
  tool_use:      'rgba(0,255,102,0.15)',
  thought_chain: 'rgba(191,0,255,0.2)',
  agent_link:    'rgba(255,102,0,0.15)',
  task_dep:      'rgba(255,51,102,0.12)',
  objective:     'rgba(255,204,0,0.12)',
  core:          'rgba(78,161,255,0.25)',
};

const PARTICLE_COLORS: Record<string, string> = {
  memory_recall: '#00ffcc',
  tool_use:      '#00ff66',
  thought_chain: '#bf00ff',
  agent_link:    '#ff6600',
  task_dep:      '#ff3366',
  objective:     '#ffcc00',
  core:          '#4ea1ff',
};

// ---------------------------------------------------------------------------
// Geometry cache
// ---------------------------------------------------------------------------

function makeGeometry(shape: number, size: number): THREE.BufferGeometry {
  switch (shape) {
    case 1: return new THREE.OctahedronGeometry(size);
    case 2: return new THREE.BoxGeometry(size * 1.3, size * 1.3, size * 1.3);
    case 3: return new THREE.DodecahedronGeometry(size);
    default: return new THREE.SphereGeometry(size, 16, 12);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new Error('UNAUTH');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

interface Props {
  /** Callback when a node is clicked — opens detail panel. */
  onNodeClick?: (node: MindmapNode | null) => void;
}

export function NeuralCore({ onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const [selectedNode, setSelectedNode] = useState<MindmapNode | null>(null);
  const [bloomStrength, setBloomStrength] = useState(2.5);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);

  const { data, error } = useQuery({
    queryKey: ['mindmap'],
    queryFn: () => fetchJson<MindmapResponse>('/api/dashboard/mindmap'),
    refetchInterval: 8_000,
  });

  // Create graph once
  useEffect(() => {
    if (!containerRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph: ForceGraph3DInstance = (ForceGraph3D as any)(containerRef.current)
      .backgroundColor('#000003')
      .showNavInfo(false)
      .nodeLabel((n: any) => `<div style="background:#11151cee;color:#e6edf3;padding:8px 12px;border-radius:6px;border:1px solid #232a36;font-size:12px;max-width:260px">
        <strong style="color:${NODE_COLORS[n.type] || '#4ea1ff'}">${n.label}</strong>
        <div style="color:#8b95a7;margin-top:4px;font-size:11px">${n.type}${n.detail ? ' — ' + n.detail.slice(0, 120) : ''}</div>
      </div>`)
      .nodeThreeObject((n: any) => {
        const size = 2 + (n.importance || 3) * 0.8;
        const shape = NODE_SHAPES[n.type] ?? 0;
        const geo = makeGeometry(shape, size);
        const color = NODE_COLORS[n.type] || '#4ea1ff';
        const mat = new THREE.MeshPhongMaterial({
          color: new THREE.Color(color),
          emissive: new THREE.Color(color),
          emissiveIntensity: n.type === 'core' ? 0.9 : 0.5,
          transparent: true,
          opacity: 0.92,
        });
        const mesh = new THREE.Mesh(geo, mat);

        // Pulsing ring for active/core nodes
        if (n.type === 'core' || n.status === 'in_progress') {
          const ringGeo = new THREE.RingGeometry(size * 1.4, size * 1.6, 32);
          const ringMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
          });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          mesh.add(ring);
        }

        return mesh;
      })
      .linkColor((l: any) => LINK_COLORS[l.type] || 'rgba(100,150,255,0.1)')
      .linkWidth((l: any) => 0.3 + (l.strength || 0.3) * 1.5)
      .linkOpacity(0.6)
      .linkDirectionalParticles((l: any) => Math.max(1, Math.round((l.strength || 0.3) * 5)))
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleWidth(1.8)
      .linkDirectionalParticleColor((l: any) => PARTICLE_COLORS[l.type] || '#00ffff')
      .linkCurvature(0.15)
      .onNodeClick((n: any) => {
        setSelectedNode(n);
        onNodeClick?.(n);
        // Fly to node
        const dist = 80;
        const pos = n;
        graph.cameraPosition(
          { x: pos.x + dist, y: pos.y + dist / 2, z: pos.z + dist },
          { x: pos.x, y: pos.y, z: pos.z },
          1200,
        );
      })
      .onBackgroundClick(() => {
        setSelectedNode(null);
        onNodeClick?.(null);
      })
      .d3AlphaDecay(0.01)
      .d3VelocityDecay(0.15)
      .warmupTicks(80)
      .cooldownTime(3000);

    // Forces
    graph.d3Force('charge')?.strength(-120);
    graph.d3Force('link')?.distance((l: any) => 40 + (1 - (l.strength || 0.5)) * 60);

    // Add bloom post-processing
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      2.5, // strength
      1,   // radius
      0,   // threshold
    );
    bloomPassRef.current = bloomPass;
    graph.postProcessingComposer().addPass(bloomPass);

    // Auto-orbit when idle
    let angle = 0;
    const orbit = () => {
      angle += 0.001;
      graph.cameraPosition({
        x: Math.sin(angle) * 300,
        z: Math.cos(angle) * 300,
      });
    };
    const orbitTimer = setInterval(orbit, 50);

    // Ambient and directional lights
    const scene = graph.scene();
    scene.add(new THREE.AmbientLight(0x222233, 1.5));
    const dirLight = new THREE.DirectionalLight(0x4ea1ff, 0.6);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

    graphRef.current = graph;

    // Resize handler
    const onResize = () => {
      graph.width(containerRef.current?.clientWidth || window.innerWidth);
      graph.height(containerRef.current?.clientHeight || window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    onResize();

    return () => {
      clearInterval(orbitTimer);
      window.removeEventListener('resize', onResize);
      graph._destructor?.();
    };
  }, []);

  // Update graph data when API responds
  useEffect(() => {
    if (!graphRef.current || !data) return;
    graphRef.current.graphData({
      nodes: data.nodes,
      links: data.links,
    });
  }, [data]);

  // Bloom strength slider
  useEffect(() => {
    if (bloomPassRef.current) {
      bloomPassRef.current.strength = bloomStrength;
    }
  }, [bloomStrength]);

  const handleReset = useCallback(() => {
    graphRef.current?.cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z: 0 }, 1500);
    setSelectedNode(null);
    onNodeClick?.(null);
  }, [onNodeClick]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 500 }}>
      {/* KPI bar */}
      {data?.stats && (
        <div className="neural-kpi-bar">
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: '#00ffcc' }}>{data.stats.totalMemories}</span><span className="neural-kpi-lbl">Memories</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: '#bf00ff' }}>{data.stats.activeThoughts}</span><span className="neural-kpi-lbl">Thoughts</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: '#00ff66' }}>{data.stats.toolsUsed}</span><span className="neural-kpi-lbl">Tools</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: '#ff6600' }}>{data.stats.agentsOnline}</span><span className="neural-kpi-lbl">Agents</span></div>
          <div className="neural-kpi"><span className="neural-kpi-val" style={{ color: '#ff3366' }}>{data.stats.tasksToday}</span><span className="neural-kpi-lbl">Tasks</span></div>
        </div>
      )}

      {/* Controls overlay */}
      <div className="neural-controls">
        <button className="neural-btn" onClick={handleReset} title="Reset camera">Reset</button>
        <label className="neural-slider-wrap" title="Bloom intensity">
          <span style={{ fontSize: 11, color: '#8b95a7' }}>Glow</span>
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={bloomStrength}
            onChange={(e) => setBloomStrength(parseFloat(e.target.value))}
            className="neural-slider"
          />
        </label>
      </div>

      {/* Legend */}
      <div className="neural-legend">
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <div key={type} className="neural-legend-item">
            <span className="neural-legend-dot" style={{ background: color }} />
            <span>{type}</span>
          </div>
        ))}
      </div>

      {/* Selected node detail */}
      {selectedNode && (
        <div className="neural-detail-panel">
          <div className="neural-detail-header">
            <span className="neural-detail-dot" style={{ background: NODE_COLORS[selectedNode.type] }} />
            <strong>{selectedNode.label}</strong>
            <button className="neural-detail-close" onClick={() => { setSelectedNode(null); onNodeClick?.(null); }}>x</button>
          </div>
          <div className="neural-detail-type">{selectedNode.type} — importance {selectedNode.importance}/10</div>
          {selectedNode.detail && <div className="neural-detail-body">{selectedNode.detail}</div>}
          {selectedNode.ts && <div className="neural-detail-ts">{new Date(selectedNode.ts).toLocaleString()}</div>}
          {selectedNode.status && <div className="neural-detail-status">Status: {selectedNode.status}</div>}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div style={{ position: 'absolute', top: 60, left: 20, color: '#f85149', fontSize: 13 }}>
          Failed to load mindmap: {(error as Error).message}
        </div>
      )}

      {/* 3D canvas container */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
