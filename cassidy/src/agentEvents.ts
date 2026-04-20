// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Live telemetry event ring buffer
// ---------------------------------------------------------------------------
// A typed, in-memory feed of "what is the agent doing right now" events,
// surfaced by the Mission Control dashboard. Distinct from the structured
// `logger` ring (which captures every log line). These events are higher
// signal: tool calls, LLM turns, agent thoughts, autonomous cycles, etc.
// ---------------------------------------------------------------------------

export type AgentEventKind =
  | 'llm.turn'           // LLM completion finished (model, tokens, latency)
  | 'llm.thought'        // Assistant text response (the "thinking" the user would see)
  | 'tool.call'          // Tool invocation about to start
  | 'tool.result'        // Tool invocation finished (status, duration)
  | 'agent.message'      // Inbound user message
  | 'agent.reply'        // Outbound assistant message sent to the channel
  | 'corpgen.cycle'      // CorpGen plan-act-reflect cycle boundary
  | 'corpgen.day'        // CorpGen day boundary (start/end)
  | 'corpgen.tool'       // CorpGen tool execution
  | 'proactive.tick'     // Proactive engine fired
  | 'autonomous.task'    // Autonomous loop subtask
  | 'mcp.discover'       // MCP server discovery / tool load
  | 'webhook.notify';    // Inbound webhook

export interface AgentEvent {
  id: string;
  ts: string;            // ISO timestamp
  kind: AgentEventKind;
  /** Short human-readable label (e.g. "Cassidy ▸ get_user_info"). */
  label: string;
  /** Optional duration in ms (for completion events). */
  durationMs?: number;
  /** Optional status — "ok" / "error" / "partial". */
  status?: 'ok' | 'error' | 'partial' | 'started';
  /** Optional structured payload (truncated). */
  data?: Record<string, unknown>;
  /** Correlation key (userId, conversationId, jobId, ...). */
  correlationId?: string;
}

const RING_SIZE = 1000;
const _ring: AgentEvent[] = [];
let _seq = 0;

function nextId(): string {
  _seq = (_seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/** Truncate large values so the ring stays small and JSON-friendly. */
function safeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v == null) { out[k] = v; continue; }
    if (typeof v === 'string') {
      out[k] = v.length > 600 ? v.slice(0, 600) + '…' : v;
    } else if (typeof v === 'object') {
      try {
        const j = JSON.stringify(v);
        out[k] = j.length > 600 ? j.slice(0, 600) + '…' : v;
      } catch { out[k] = '[unserialisable]'; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Push a new event. Safe to call from anywhere — never throws. */
export function recordEvent(ev: Omit<AgentEvent, 'id' | 'ts'> & { ts?: string }): void {
  try {
    const full: AgentEvent = {
      id: nextId(),
      ts: ev.ts ?? new Date().toISOString(),
      kind: ev.kind,
      label: ev.label,
      durationMs: ev.durationMs,
      status: ev.status,
      correlationId: ev.correlationId,
      data: safeData(ev.data),
    };
    _ring.push(full);
    if (_ring.length > RING_SIZE) _ring.shift();
  } catch { /* swallow — telemetry must never break the agent */ }
}

/** Read recent events (newest first), with optional filtering. */
export function getRecentEvents(opts: {
  limit?: number;
  kinds?: AgentEventKind[];
  sinceId?: string;
} = {}): AgentEvent[] {
  const limit = Math.min(opts.limit ?? 200, RING_SIZE);
  let out = _ring.slice().reverse();
  if (opts.sinceId) {
    const idx = out.findIndex((e) => e.id === opts.sinceId);
    if (idx >= 0) out = out.slice(0, idx);
  }
  if (opts.kinds?.length) {
    const set = new Set(opts.kinds);
    out = out.filter((e) => set.has(e.kind));
  }
  return out.slice(0, limit);
}

/** Aggregate counts for KPI tiles. */
export function getEventStats(): {
  total: number;
  byKind: Record<string, number>;
  last5min: number;
} {
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const byKind: Record<string, number> = {};
  let last5 = 0;
  for (const e of _ring) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (new Date(e.ts).getTime() >= fiveMinAgo) last5++;
  }
  return { total: _ring.length, byKind, last5min: last5 };
}

export function _resetEventsForTest(): void {
  _ring.length = 0;
  _seq = 0;
}
