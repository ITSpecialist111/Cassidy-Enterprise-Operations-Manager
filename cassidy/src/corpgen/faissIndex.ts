// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// FAISS Vector Index — application-partitioned trajectory retrieval
// ---------------------------------------------------------------------------
// Wraps faiss-node (optionalDependency) to provide fast cosine-similarity
// search for experiential learning trajectories. Each app gets its own
// IndexFlatIP (inner product on L2-normalised vectors ≡ cosine similarity).
//
// Lifecycle:
//   1. Lazy-load: on first getAppIndex(app), load all embeddings from Table
//      Storage and build the FAISS index.
//   2. Incremental add: captureSuccessfulTrajectory() calls add() to append
//      to the live index without a full rebuild.
//   3. Cache with TTL: indices are cached for 10 min, then rebuilt on next
//      access to pick up any out-of-band writes.
//
// Fallback: if faiss-node is not available (native build failure), the
// module returns a FallbackIndex that performs the same in-memory cosine
// scan as the original experientialLearning.ts — no functionality lost.
// ---------------------------------------------------------------------------

import { listEntities, type TableEntity } from '../memory/tableStorage';
import { logger } from '../logger';
import type { VectorIndex } from './types';

const TABLE = 'CorpGenTrajectories';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// ---------------------------------------------------------------------------
// Try to load faiss-node
// ---------------------------------------------------------------------------

// faiss-node is an optionalDependency. Avoid a static type import so the
// build succeeds when the package isn't installed (App Service Linux without
// native build toolchain). At runtime the dynamic import below either
// returns the module or falls through to the in-memory cosine fallback.
interface FaissIndexFlatIPCtor {
  new (dim: number): {
    add(vec: number[]): void;
    search(vec: number[], k: number): { labels: number[]; distances: number[] };
  };
}
type FaissModule = { IndexFlatIP: FaissIndexFlatIPCtor };
let _faiss: FaissModule | null = null;
let _faissAttempted = false;

async function loadFaiss(): Promise<FaissModule | null> {
  if (_faissAttempted) return _faiss;
  _faissAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (Function('return import("faiss-node")') as () => Promise<any>)();
    _faiss = (mod?.default ?? mod) as FaissModule;
    logger.info('[CorpGen] faiss-node loaded successfully', { module: 'corpgen.faiss' });
  } catch {
    logger.info('[CorpGen] faiss-node not available — using fallback cosine scan', { module: 'corpgen.faiss' });
    _faiss = null;
  }
  return _faiss;
}

// ---------------------------------------------------------------------------
// Index cache
// ---------------------------------------------------------------------------

interface CachedEntry {
  index: VectorIndex;
  loadedAt: number;
}

const _cache = new Map<string, CachedEntry>();

/** Get or lazily create the vector index for an app. */
export async function getAppIndex(app: string): Promise<VectorIndex> {
  const cached = _cache.get(app);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.index;
  }
  const index = await buildIndex(app);
  _cache.set(app, { index, loadedAt: Date.now() });
  return index;
}

/** Force-rebuild an app's index from Table Storage. */
export async function rebuildAppIndex(app: string): Promise<void> {
  _cache.delete(app);
  await getAppIndex(app);
}

/** Clear all cached indices (for tests / memory pressure). */
export function clearAllIndices(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// DemoRow — must match experientialLearning.ts
// ---------------------------------------------------------------------------

interface DemoRow extends TableEntity {
  app: string;
  taskSummary: string;
  actions: string;
  embedding: string; // JSON number[]
  reuseCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Build an index from Table Storage rows
// ---------------------------------------------------------------------------

async function buildIndex(app: string): Promise<VectorIndex> {
  const rows = await listEntities<DemoRow>(TABLE, app);
  const withEmbeddings: Array<{ demoId: string; vec: number[] }> = [];

  for (const row of rows) {
    if (!row.embedding) continue;
    try {
      const vec = JSON.parse(row.embedding) as number[];
      if (Array.isArray(vec) && vec.length > 0) {
        withEmbeddings.push({ demoId: row.rowKey, vec });
      }
    } catch { /* skip malformed */ }
  }

  // Determine dimensionality from first vector
  const dim = withEmbeddings.length > 0 ? withEmbeddings[0].vec.length : 0;

  const faiss = await loadFaiss();
  if (faiss && dim > 0) {
    return buildFaissIndex(faiss, dim, withEmbeddings);
  }
  return buildFallbackIndex(withEmbeddings);
}

// ---------------------------------------------------------------------------
// FAISS-backed index
// ---------------------------------------------------------------------------

function buildFaissIndex(
  faiss: FaissModule,
  dim: number,
  rows: Array<{ demoId: string; vec: number[] }>,
): VectorIndex {
  const index = new faiss.IndexFlatIP(dim);
  const idMap: string[] = []; // faiss internal id → demoId

  for (const { demoId, vec } of rows) {
    const normed = l2Normalize(vec);
    index.add(normed);
    idMap.push(demoId);
  }

  return {
    async search(queryVector: number[], topK: number) {
      if (idMap.length === 0) return [];
      const normed = l2Normalize(queryVector);
      const k = Math.min(topK, idMap.length);
      const { labels, distances } = index.search(normed, k);
      const results: Array<{ demoId: string; score: number }> = [];
      for (let i = 0; i < labels.length; i++) {
        const idx = labels[i];
        if (idx < 0 || idx >= idMap.length) continue;
        results.push({ demoId: idMap[idx], score: distances[i] });
      }
      return results;
    },
    async add(demoId: string, vector: number[]) {
      const normed = l2Normalize(vector);
      index.add(normed);
      idMap.push(demoId);
    },
    size() { return idMap.length; },
  };
}

// ---------------------------------------------------------------------------
// Fallback: in-memory cosine scan (no native deps)
// ---------------------------------------------------------------------------

function buildFallbackIndex(
  rows: Array<{ demoId: string; vec: number[] }>,
): VectorIndex {
  const store = [...rows];

  return {
    async search(queryVector: number[], topK: number) {
      if (store.length === 0) return [];
      const scored = store.map(({ demoId, vec }) => ({
        demoId,
        score: cosine(queryVector, vec),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
    async add(demoId: string, vector: number[]) {
      store.push({ demoId, vec: vector });
    },
    size() { return store.length; },
  };
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
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

// Re-export for tests
export const _internal = { l2Normalize, cosine, loadFaiss, buildFallbackIndex };
