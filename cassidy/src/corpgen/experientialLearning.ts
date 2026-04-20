// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Experiential Learning (CorpGen §3.6)
// ---------------------------------------------------------------------------
// Lightweight reuse of verified demonstrations — NO parameter updates, NO
// policy optimisation. When a task succeeds, we distill it into a minimal
// canonical trajectory (context + actions), embed it via Azure OpenAI
// embeddings, and store it. At execution time we retrieve the top-K
// similar demos (filtered by application) and inject them as few-shot
// examples to bias action selection.
//
// We use Azure Table Storage as the vector index (cosine similarity on
// in-memory load). For production scale this can be swapped for FAISS
// or Azure AI Search vector store without changing the public API.
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import { upsertEntity, listEntities, type TableEntity } from '../memory/tableStorage';
import { getSharedOpenAI } from '../auth';
import { logger } from '../logger';
import type { TrajectoryDemo } from './types';

const TABLE = 'CorpGenTrajectories';
/** Azure OpenAI embedding deployment name. Override via env. */
const EMBED_MODEL = process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT ?? 'text-embedding-3-small';

interface DemoRow extends TableEntity {
  app: string;
  taskSummary: string;
  actions: string;
  embedding: string; // JSON number[]
  reuseCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[] | null> {
  try {
    const openai = getSharedOpenAI();
    const r = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
    return r.data[0]?.embedding ?? null;
  } catch (err) {
    logger.debug('[CorpGen] Embedding failed (non-fatal)', {
      module: 'corpgen.exp',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Capture — call after a task succeeds
// ---------------------------------------------------------------------------

export async function captureSuccessfulTrajectory(input: {
  app: string;
  taskSummary: string;
  /** Structured action sequence (JSON-serialisable). */
  actions: unknown;
}): Promise<TrajectoryDemo> {
  const emb = await embed(`${input.app}\n${input.taskSummary}`);
  const demo: TrajectoryDemo = {
    demoId: ulid(),
    app: input.app,
    taskSummary: input.taskSummary,
    actions: typeof input.actions === 'string' ? input.actions : JSON.stringify(input.actions),
    embedding: emb ?? undefined,
    reuseCount: 0,
    createdAt: new Date().toISOString(),
  };
  const row: DemoRow = {
    partitionKey: input.app,
    rowKey: demo.demoId,
    app: demo.app,
    taskSummary: demo.taskSummary,
    actions: demo.actions,
    embedding: emb ? JSON.stringify(emb) : '',
    reuseCount: 0,
    createdAt: demo.createdAt,
  };
  try { await upsertEntity(TABLE, row); }
  catch (err) {
    logger.warn('[CorpGen] Failed to persist trajectory', {
      module: 'corpgen.exp',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return demo;
}

// ---------------------------------------------------------------------------
// Retrieval — application-aware top-K
// ---------------------------------------------------------------------------

/**
 * Retrieve top-K similar demonstrations for an app. Application filtering
 * is mandatory per the paper to prevent misleading cross-app retrievals.
 * Falls back to lexical Jaccard scoring when no embedding is available.
 */
export async function retrieveSimilarTrajectories(input: {
  app: string;
  taskSummary: string;
  topK?: number;
}): Promise<TrajectoryDemo[]> {
  const topK = input.topK ?? 2;
  const candidates = await listEntities<DemoRow>(TABLE, input.app);
  if (candidates.length === 0) return [];

  const queryEmb = await embed(`${input.app}\n${input.taskSummary}`);

  const scored = candidates.map((row) => {
    let score = 0;
    if (queryEmb && row.embedding) {
      try {
        const e = JSON.parse(row.embedding) as number[];
        score = cosine(queryEmb, e);
      } catch { /* fall through to lexical */ }
    }
    if (score === 0) score = jaccard(input.taskSummary, row.taskSummary);
    return { row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ row }) => rowToDemo(row));
}

function rowToDemo(row: DemoRow): TrajectoryDemo {
  let embedding: number[] | undefined;
  if (row.embedding) {
    try { embedding = JSON.parse(row.embedding) as number[]; } catch { /* ignore */ }
  }
  return {
    demoId: row.rowKey,
    app: row.app,
    taskSummary: row.taskSummary,
    actions: row.actions,
    embedding,
    reuseCount: row.reuseCount,
    createdAt: row.createdAt,
  };
}

function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Increment reuseCount when a demo gets injected into a cycle. */
export async function markDemoReused(demo: TrajectoryDemo): Promise<void> {
  const row: DemoRow = {
    partitionKey: demo.app,
    rowKey: demo.demoId,
    app: demo.app,
    taskSummary: demo.taskSummary,
    actions: demo.actions,
    embedding: demo.embedding ? JSON.stringify(demo.embedding) : '',
    reuseCount: demo.reuseCount + 1,
    createdAt: demo.createdAt,
  };
  try { await upsertEntity(TABLE, row); } catch { /* best-effort */ }
}

// Re-export helpers for tests
export const _internal = { cosine, jaccard };
