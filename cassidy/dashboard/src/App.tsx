import { useQuery } from '@tanstack/react-query';
import { useState, lazy, Suspense } from 'react';

const NeuralCore = lazy(() => import('./NeuralCore').then(m => ({ default: m.NeuralCore })));

interface Snapshot {
  agent: string;
  version: string;
  uptimeHours: number;
  startTime: string;
  features: Record<string, boolean>;
  circuits: Record<string, string>;
  caches: Record<string, number>;
  rateLimiter: { trackedUsers: number };
  webhooks: { activeSubscriptions: number };
  agents: Array<{ id: string; name: string; description?: string; expertise?: string[] }>;
  timestamp: string;
}

interface ActivityEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  module?: string;
  [k: string]: unknown;
}

interface AgentEvent {
  id: string;
  ts: string;
  kind: string;
  label: string;
  durationMs?: number;
  status?: 'ok' | 'error' | 'partial' | 'started';
  data?: Record<string, unknown>;
  correlationId?: string;
}

interface EventStats {
  total: number;
  byKind: Record<string, number>;
  last5min: number;
}

interface Job {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new Error('UNAUTH:' + (body.loginUrl || '/.auth/login/aad'));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function LoginGate({ loginUrl }: { loginUrl: string }) {
  return (
    <div className="login-card">
      <h1>Cassidy Mission Control</h1>
      <p>Sign in with your work account to view live operations.</p>
      <a className="btn-primary" href={loginUrl}>Sign in with Microsoft</a>
    </div>
  );
}

function Header({ snap }: { snap?: Snapshot }) {
  const status = !snap ? 'loading'
    : Object.values(snap.circuits).some((s) => s === 'open') ? 'degraded' : 'healthy';
  const cls = status === 'healthy' ? 'good' : status === 'degraded' ? 'warn' : 'warn';
  return (
    <div className="header">
      <h1>🛰️ Cassidy — Mission Control</h1>
      <span className="sub">v{snap?.version ?? '…'} · uptime {snap?.uptimeHours ?? '…'}h</span>
      <div className="spacer" />
      <span className={`pill ${cls}`}><span className="dot" />{status}</span>
    </div>
  );
}

function LiveOps({ snap }: { snap?: Snapshot }) {
  if (!snap) return <div className="empty">Loading…</div>;
  return (
    <>
      <h2>Live Operations</h2>
      <div className="grid-4">
        <div className="card kpi"><div className="label">Uptime</div><div className="value">{snap.uptimeHours}h</div><div className="sub">since {new Date(snap.startTime).toLocaleString()}</div></div>
        <div className="card kpi"><div className="label">Tracked users</div><div className="value">{snap.rateLimiter.trackedUsers}</div></div>
        <div className="card kpi"><div className="label">Cached memories</div><div className="value">{snap.caches.memories}</div><div className="sub">{snap.caches.userInsights} insights · {snap.caches.toolResults} tool</div></div>
        <div className="card kpi"><div className="label">Webhooks</div><div className="value">{snap.webhooks.activeSubscriptions}</div></div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Circuit breakers</h3>
          {Object.entries(snap.circuits).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{k}</span>
              <span className={`pill ${v === 'closed' ? 'good' : v === 'open' ? 'bad' : 'warn'}`}><span className="dot" />{v}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Features</h3>
          {Object.entries(snap.features).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{k}</span>
              <span className={`pill ${v ? 'good' : 'warn'}`}><span className="dot" />{v ? 'on' : 'off'}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Organisation({ snap }: { snap?: Snapshot }) {
  if (!snap) return <div className="empty">Loading…</div>;
  return (
    <>
      <h2>Registered Agents</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Name</th><th>Expertise</th><th>Description</th></tr></thead>
          <tbody>
            {snap.agents.length === 0 && <tr><td colSpan={3} className="empty">No agents registered.</td></tr>}
            {snap.agents.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="code">{(a.expertise || []).join(', ')}</td>
                <td>{a.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function WorkdayRuns() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => fetchJson<{ jobs: Job[] }>('/api/dashboard/jobs'),
  });
  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="error">{(error as Error).message}</div>;
  const jobs = data?.jobs ?? [];
  return (
    <>
      <h2>CorpGen Runs</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
          <tbody>
            {jobs.length === 0 && <tr><td colSpan={5} className="empty">No runs yet. Trigger one with cg_run_workday.</td></tr>}
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="code">{j.id.slice(0, 8)}</td>
                <td>{j.kind}</td>
                <td><span className={`pill ${j.status === 'succeeded' ? 'good' : j.status === 'failed' ? 'bad' : 'warn'}`}><span className="dot" />{j.status}</span></td>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
                <td>{j.durationMs ? `${(j.durationMs / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ActivityBlade() {
  const { data } = useQuery({
    queryKey: ['blade-events'],
    queryFn: () => fetchJson<{ events: AgentEvent[]; stats: EventStats }>('/api/dashboard/events?limit=40'),
    refetchInterval: 3_000,
  });
  const events = data?.events ?? [];
  return (
    <>
      <h3>Live agent feed</h3>
      <div>
        {events.map((e) => (
          <div key={e.id} className="activity-row" title={e.kind}>
            <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <span style={{ width: 22 }}>{KIND_ICON[e.kind] ?? '•'}</span>
            <span>{e.label}{e.durationMs != null ? ` (${e.durationMs}ms)` : ''}</span>
          </div>
        ))}
        {events.length === 0 && <div className="empty">Waiting for activity…</div>}
      </div>
    </>
  );
}

const KIND_ICON: Record<string, string> = {
  'llm.turn': '🧠',
  'llm.thought': '💭',
  'tool.call': '🔧',
  'tool.result': '✓',
  'agent.message': '👤',
  'agent.reply': '💬',
  'corpgen.cycle': '⟳',
  'corpgen.day': '📅',
  'corpgen.tool': '⚙',
  'proactive.tick': '⏰',
  'autonomous.task': '🤖',
  'mcp.discover': '🔌',
  'webhook.notify': '📡',
};
const KIND_LABEL: Record<string, string> = {
  'llm.turn': 'LLM Turn',
  'llm.thought': 'Thought',
  'tool.call': 'Tool Call',
  'tool.result': 'Tool Result',
  'agent.message': 'User Msg',
  'agent.reply': 'Reply',
  'corpgen.cycle': 'Cycle',
  'corpgen.day': 'Day',
  'corpgen.tool': 'CG Tool',
  'proactive.tick': 'Proactive',
  'autonomous.task': 'Auto Task',
  'mcp.discover': 'MCP',
  'webhook.notify': 'Webhook',
};

function AgentMind() {
  const { data, error } = useQuery({
    queryKey: ['events'],
    queryFn: () => fetchJson<{ events: AgentEvent[]; stats: EventStats }>('/api/dashboard/events?limit=300'),
    refetchInterval: 3_000,
  });
  const [filter, setFilter] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  if (error) return <div className="error">{(error as Error).message}</div>;
  const events = data?.events ?? [];
  const stats = data?.stats;
  const filtered = filter === 'all' ? events : events.filter((e) => e.kind.startsWith(filter));
  const kinds = Array.from(new Set(events.map((e) => e.kind))).sort();

  return (
    <>
      <h2>Agent Mind <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 400 }}>— what Cassidy is doing right now</span></h2>

      {stats && (
        <div className="grid-4" style={{ marginBottom: 16 }}>
          <div className="card kpi"><div className="label">Total events</div><div className="value">{stats.total}</div></div>
          <div className="card kpi"><div className="label">Last 5 min</div><div className="value">{stats.last5min}</div></div>
          <div className="card kpi"><div className="label">Tool calls</div><div className="value">{(stats.byKind['tool.call'] ?? 0) + (stats.byKind['corpgen.tool'] ?? 0)}</div></div>
          <div className="card kpi"><div className="label">LLM turns</div><div className="value">{stats.byKind['llm.turn'] ?? 0}</div></div>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <button className={`pill ${filter === 'all' ? 'good' : ''}`} style={{ marginRight: 6, cursor: 'pointer' }} onClick={() => setFilter('all')}>all ({events.length})</button>
        {kinds.map((k) => (
          <button key={k} className={`pill ${filter === k ? 'good' : ''}`} style={{ marginRight: 6, cursor: 'pointer' }} onClick={() => setFilter(k)}>
            {KIND_ICON[k] ?? '•'} {KIND_LABEL[k] ?? k} ({stats?.byKind[k] ?? 0})
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {filtered.length === 0 && <div className="empty">No events yet — try sending Cassidy a message in Teams or trigger a CorpGen run.</div>}
        {filtered.map((e) => {
          const open = openId === e.id;
          const statusColor = e.status === 'error' ? 'bad' : e.status === 'partial' ? 'warn' : e.status === 'started' ? '' : 'good';
          return (
            <div
              key={e.id}
              onClick={() => setOpenId(open ? null : e.id)}
              style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: open ? 'var(--panel-2)' : 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 22, fontSize: 14 }}>{KIND_ICON[e.kind] ?? '•'}</span>
                <span style={{ width: 96, fontFamily: 'var(--fontMono)', fontSize: 11, color: 'var(--muted)' }}>{new Date(e.ts).toLocaleTimeString()}</span>
                <span style={{ width: 110, fontSize: 11, color: 'var(--muted)' }}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{e.label}</span>
                {e.durationMs != null && <span style={{ fontFamily: 'var(--fontMono)', fontSize: 11, color: 'var(--muted)' }}>{e.durationMs}ms</span>}
                {e.status && <span className={`pill ${statusColor}`} style={{ fontSize: 10, padding: '2px 8px' }}>{e.status}</span>}
              </div>
              {open && (
                <div style={{ marginTop: 8, marginLeft: 32, padding: 10, background: 'var(--bg)', borderRadius: 4, fontFamily: 'var(--fontMono)', fontSize: 11, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {e.correlationId && <div>correlationId: {e.correlationId}</div>}
                  {e.data && <div>{JSON.stringify(e.data, null, 2)}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

type Page = 'live' | 'mind' | 'neural' | 'runs' | 'kanban' | 'org';

export function App() {
  const [page, setPage] = useState<Page>('neural');
  const { data: snap, error } = useQuery({
    queryKey: ['snapshot'],
    queryFn: () => fetchJson<Snapshot>('/api/dashboard/snapshot'),
    retry: false,
  });

  if (error && (error as Error).message.startsWith('UNAUTH:')) {
    const loginUrl = (error as Error).message.split('UNAUTH:')[1];
    return <LoginGate loginUrl={loginUrl} />;
  }

  return (
    <div className="app">
      <Header snap={snap} />
      <div className="body">
        <nav className="nav">
          <button className={page === 'neural' ? 'active' : ''} onClick={() => setPage('neural')}>🔮 Neural Core</button>
          <button className={page === 'live' ? 'active' : ''} onClick={() => setPage('live')}>Live Operations</button>
          <button className={page === 'mind' ? 'active' : ''} onClick={() => setPage('mind')}>🧠 Agent Mind</button>
          <button className={page === 'kanban' ? 'active' : ''} onClick={() => setPage('kanban')}>📋 Today's Plan</button>
          <button className={page === 'runs' ? 'active' : ''} onClick={() => setPage('runs')}>CorpGen Runs</button>
          <button className={page === 'org' ? 'active' : ''} onClick={() => setPage('org')}>Organisation</button>
        </nav>
        <main className={`main${page === 'neural' ? ' neural-page' : ''}`}>
          {page === 'neural' && (
            <>
              <h2>🔮 Neural Core <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 400 }}>— Cassidy's cognitive graph</span></h2>
              <div className="neural-canvas-wrap">
                <Suspense fallback={<div className="empty" style={{ padding: 40, textAlign: 'center' }}>Loading Neural Core…</div>}>
                  <NeuralCore />
                </Suspense>
              </div>
            </>
          )}
          {page === 'live' && <LiveOps snap={snap} />}
          {page === 'mind' && <AgentMind />}
          {page === 'kanban' && <KanbanBoard />}
          {page === 'runs' && <WorkdayRuns />}
          {page === 'org' && <Organisation snap={snap} />}
        </main>
        <aside className="aside">
          <ActivityBlade />
        </aside>
      </div>
    </div>
  );
}

interface KanbanTask {
  taskId: string;
  description: string;
  app: string;
  priority: number;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'skipped';
  dependsOn: string[];
  attempts: number;
  lastError?: string;
}
interface KanbanResponse {
  ok: boolean;
  employeeId: string;
  date: string;
  plan: { tasks: KanbanTask[] } | null;
  columns: {
    pending: KanbanTask[];
    in_progress: KanbanTask[];
    blocked: KanbanTask[];
    done: KanbanTask[];
  } | null;
}

function KanbanBoard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['kanban'],
    queryFn: () => fetchJson<KanbanResponse>('/api/dashboard/kanban'),
    refetchInterval: 15_000,
  });
  if (isLoading) return <div className="empty">Loading today's plan…</div>;
  if (error) return <div className="error">{(error as Error).message}</div>;
  if (!data?.plan || !data.columns) {
    return (
      <>
        <h2>📋 Today's Plan — {data?.date ?? '…'}</h2>
        <div className="empty">No daily plan yet. Cassidy generates one at Day Init (08:50 AEST) or on demand via <code>cg_run_workday</code>.</div>
      </>
    );
  }
  const cols: Array<{ key: keyof typeof data.columns; label: string; tone: string }> = [
    { key: 'pending',     label: 'Backlog',     tone: 'warn' },
    { key: 'in_progress', label: 'In Progress', tone: 'good' },
    { key: 'blocked',     label: 'Blocked',     tone: 'bad' },
    { key: 'done',        label: 'Done',        tone: 'good' },
  ];
  return (
    <>
      <h2>📋 Today's Plan — {data.date} <span className="sub">({data.employeeId})</span></h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {cols.map((c) => {
          const tasks = data.columns![c.key];
          return (
            <div key={c.key} className="card" style={{ padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>{c.label} <span className="sub">({tasks.length})</span></h3>
              {tasks.length === 0 && <div className="empty" style={{ padding: 8 }}>—</div>}
              {tasks.map((t) => (
                <div key={t.taskId} className="card" style={{ padding: 8, marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong style={{ flex: 1 }}>{t.description}</strong>
                    <span className={`pill ${t.priority <= 2 ? 'bad' : t.priority <= 3 ? 'warn' : 'good'}`}>P{t.priority}</span>
                  </div>
                  <div className="sub" style={{ marginTop: 4 }}>
                    {t.app}{t.attempts > 0 ? ` · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` : ''}
                    {t.status === 'failed' || t.status === 'skipped' ? ` · ${t.status}` : ''}
                  </div>
                  {t.lastError && <div className="error" style={{ marginTop: 4, fontSize: 12 }}>{t.lastError}</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
