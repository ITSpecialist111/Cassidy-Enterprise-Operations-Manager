import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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
    queryKey: ['activity'],
    queryFn: () => fetchJson<{ entries: ActivityEntry[] }>('/api/dashboard/activity?limit=80'),
  });
  return (
    <>
      <h3>Live activity</h3>
      <div>
        {(data?.entries ?? []).map((e, i) => (
          <div key={i} className="activity-row">
            <span className="ts">{new Date(e.timestamp).toLocaleTimeString()}</span>
            <span className={`lvl lvl-${e.level}`}>{e.level}</span>
            <span title={e.module}>{e.message}</span>
          </div>
        ))}
        {!data?.entries?.length && <div className="empty">Waiting for events…</div>}
      </div>
    </>
  );
}

type Page = 'live' | 'runs' | 'org';

export function App() {
  const [page, setPage] = useState<Page>('live');
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
          <button className={page === 'live' ? 'active' : ''} onClick={() => setPage('live')}>Live Operations</button>
          <button className={page === 'runs' ? 'active' : ''} onClick={() => setPage('runs')}>CorpGen Runs</button>
          <button className={page === 'org' ? 'active' : ''} onClick={() => setPage('org')}>Organisation</button>
        </nav>
        <main className="main">
          {page === 'live' && <LiveOps snap={snap} />}
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
