// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Tiered Memory Architecture (CorpGen §3.4.3)
// ---------------------------------------------------------------------------
// Three layers, each addressing a different aspect of the context-saturation
// failure mode:
//
//   Working Memory     — intra-cycle scratchpad (in-process Map, reset
//                        each cycle). Holds the current ReAct turn log.
//   Structured LTM     — typed records (plan_update, task_state_change,
//                        reflection, summary, tool_result, failure).
//                        Persisted to Azure Table Storage.
//   Semantic Memory    — similarity-based recall. We reuse Cassidy's
//                        existing GPT-driven recall() in
//                        memory/longTermMemory.ts (no vector DB required).
//
// At cycle start the agent retrieves a small fixed top-K from each layer
// using a stable priority ordering: (1) recently accessed, (2) marked
// important (importance ≥ 7), (3) semantically relevant.
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import { upsertEntity, listEntities, type TableEntity } from '../memory/tableStorage';
import { recall } from '../memory/longTermMemory';
import { logger } from '../logger';
import type {
  StructuredMemoryRecord,
  StructuredMemoryKind,
  RetrievedContext,
  SemanticHit,
} from './types';

const TABLE_STRUCTURED = 'CorpGenStructuredMemory';

interface StructuredRow extends TableEntity {
  kind: StructuredMemoryKind;
  taskId: string;
  body: string;
  importance: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Working memory (per-cycle, in-process)
// ---------------------------------------------------------------------------

const _working = new Map<string, Map<string, unknown>>();

export function workingGet<T>(cycleId: string, key: string): T | undefined {
  return _working.get(cycleId)?.get(key) as T | undefined;
}

export function workingSet(cycleId: string, key: string, value: unknown): void {
  let bucket = _working.get(cycleId);
  if (!bucket) { bucket = new Map(); _working.set(cycleId, bucket); }
  bucket.set(key, value);
}

/** Drop all working memory for a cycle (call at end of each ReAct cycle). */
export function workingReset(cycleId: string): void {
  _working.delete(cycleId);
}

// ---------------------------------------------------------------------------
// Structured long-term memory
// ---------------------------------------------------------------------------

export async function recordStructured(input: {
  employeeId: string;
  kind: StructuredMemoryKind;
  body: string;
  taskId?: string;
  importance?: number;
}): Promise<StructuredMemoryRecord> {
  const record: StructuredMemoryRecord = {
    recordId: ulid(),
    employeeId: input.employeeId,
    kind: input.kind,
    taskId: input.taskId,
    body: input.body,
    importance: Math.max(1, Math.min(10, input.importance ?? 5)),
    createdAt: new Date().toISOString(),
  };
  const row: StructuredRow = {
    partitionKey: input.employeeId,
    // ULID-prefixed by recency so listEntities returns newest first when reverse-sorted by rowKey
    rowKey: record.recordId,
    kind: record.kind,
    taskId: record.taskId ?? '',
    body: record.body,
    importance: record.importance,
    createdAt: record.createdAt,
  };
  try {
    await upsertEntity(TABLE_STRUCTURED, row);
  } catch (err) {
    logger.warn('[CorpGen] Failed to persist structured memory', {
      module: 'corpgen.memory',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return record;
}

export async function listStructured(
  employeeId: string,
  opts?: { taskId?: string; sinceIso?: string; limit?: number },
): Promise<StructuredMemoryRecord[]> {
  const rows = await listEntities<StructuredRow>(TABLE_STRUCTURED, employeeId);
  let filtered = rows.map(rowToRecord);
  if (opts?.taskId) filtered = filtered.filter((r) => r.taskId === opts.taskId);
  if (opts?.sinceIso) filtered = filtered.filter((r) => r.createdAt >= opts.sinceIso!);
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  if (opts?.limit) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

function rowToRecord(row: StructuredRow): StructuredMemoryRecord {
  return {
    recordId: row.rowKey,
    employeeId: row.partitionKey,
    kind: row.kind,
    taskId: row.taskId || undefined,
    body: row.body,
    importance: row.importance,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Tiered retrieval (cycle-start injection)
// ---------------------------------------------------------------------------

export interface RetrievalConfig {
  /** Max structured records to inject. */
  structuredTopK: number;
  /** Importance threshold below which records are deprioritised. */
  importanceFloor: number;
  /** Max semantic hits via recall(). */
  semanticTopK: number;
  /** Max experiential demos (caller sources these from experientialLearning). */
  experientialTopK: number;
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  structuredTopK: 8,
  importanceFloor: 7,
  semanticTopK: 4,
  experientialTopK: 2,
};

export async function retrieveForCycle(input: {
  employeeId: string;
  taskId: string;
  query: string;
  config?: Partial<RetrievalConfig>;
}): Promise<Pick<RetrievedContext, 'structured' | 'semantic'>> {
  const cfg = { ...DEFAULT_RETRIEVAL, ...input.config };

  // ── Structured: priority order (1) task-scoped recent, (2) high-importance global
  const all = await listStructured(input.employeeId, { limit: 200 });
  const taskScoped = all.filter((r) => r.taskId === input.taskId).slice(0, cfg.structuredTopK);
  const important = all
    .filter((r) => r.importance >= cfg.importanceFloor && r.taskId !== input.taskId)
    .slice(0, Math.max(0, cfg.structuredTopK - taskScoped.length));
  const structured = [...taskScoped, ...important].slice(0, cfg.structuredTopK);

  // ── Semantic: GPT-driven recall over Cassidy's existing long-term memory
  let semantic: SemanticHit[] = [];
  try {
    const hits = await recall(input.query, { maxResults: cfg.semanticTopK });
    semantic = hits.map((h) => ({
      content: h.content,
      // recall() doesn't expose a relevance score; use importance/10 as a proxy
      score: (h.importance ?? 0) / 10,
      source: h.source ?? 'longTermMemory',
    }));
  } catch (err) {
    logger.debug('[CorpGen] Semantic recall failed (non-fatal)', {
      module: 'corpgen.memory',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { structured, semantic };
}

/** Render retrieved context as a compact system-block fragment. */
export function renderRetrievedContext(ctx: RetrievedContext): string {
  const parts: string[] = ['# Retrieved context'];

  if (ctx.structured.length > 0) {
    parts.push('## Structured memory');
    for (const r of ctx.structured) {
      parts.push(`- [${r.kind}${r.taskId ? `:${r.taskId}` : ''}] (i=${r.importance}) ${truncate(r.body, 240)}`);
    }
  }
  if (ctx.semantic.length > 0) {
    parts.push('## Semantic recall');
    for (const h of ctx.semantic) {
      parts.push(`- (${h.score.toFixed(2)}) ${truncate(h.content, 200)}`);
    }
  }
  if (ctx.experiential.length > 0) {
    parts.push('## Past successful patterns (experiential)');
    for (const d of ctx.experiential) {
      parts.push(`- [${d.app}] ${truncate(d.taskSummary, 160)}`);
    }
  }
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
