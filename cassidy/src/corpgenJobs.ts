// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CorpGen async job runner
// ---------------------------------------------------------------------------
// App Service Linux caps HTTP responses at ~230s. Long benchmark sweeps
// (multi-day / organization) run in the background here and expose a
// poll-friendly status API.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import type { DayRunResult } from './corpgen';
import type { OrganizationResult } from './corpgen';
import { upsertEntity, listEntities, type TableEntity } from './memory/tableStorage';

export type JobKind = 'workday' | 'multi-day' | 'organization';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

const JOBS_TABLE = 'CassidyCorpGenJobs';
const JOBS_PARTITION = 'jobs';

export interface JobRecord<TResult = unknown> {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  request: Record<string, unknown>;
  result?: TResult;
  error?: string;
  /** Cheap progress hook updated by the runner (e.g. days completed). */
  progress?: { current: number; total: number; note?: string };
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_JOBS = 200;
const _jobs = new Map<string, JobRecord>();

function gc(): void {
  if (_jobs.size <= MAX_JOBS) return;
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of _jobs) {
    const finished = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
    if (finished && finished < cutoff) _jobs.delete(id);
  }
  if (_jobs.size > MAX_JOBS) {
    const sorted = [...(_jobs.entries())].sort(
      (a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime(),
    );
    for (let i = 0; i < sorted.length - MAX_JOBS; i++) _jobs.delete(sorted[i][0]);
  }
}

export function getJob(id: string): JobRecord | undefined {
  return _jobs.get(id);
}

export function listJobs(): JobRecord[] {
  return [...(_jobs.values())].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function _resetJobsForTest(): void {
  _jobs.clear();
  _hydrated = false;
}

// ---------------------------------------------------------------------------
// Persistence — survives webapp restarts so the dashboard CorpGen Runs table
// is not wiped on every deploy.
// ---------------------------------------------------------------------------

interface JobEntity extends TableEntity {
  partitionKey: string;
  rowKey: string;
  kind: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  requestJson: string;
  resultJson?: string;
  error?: string;
  progressJson?: string;
}

function toEntity(job: JobRecord): JobEntity {
  return {
    partitionKey: JOBS_PARTITION,
    rowKey: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    requestJson: JSON.stringify(job.request ?? {}),
    resultJson: job.result !== undefined ? JSON.stringify(job.result) : undefined,
    error: job.error,
    progressJson: job.progress ? JSON.stringify(job.progress) : undefined,
  };
}

function fromEntity(e: JobEntity): JobRecord {
  let request: Record<string, unknown> = {};
  try { request = JSON.parse(e.requestJson || '{}'); } catch { /* ignore */ }
  let result: unknown;
  if (e.resultJson) { try { result = JSON.parse(e.resultJson); } catch { /* ignore */ } }
  let progress: JobRecord['progress'];
  if (e.progressJson) { try { progress = JSON.parse(e.progressJson); } catch { /* ignore */ } }
  return {
    id: e.rowKey,
    kind: e.kind as JobKind,
    status: e.status as JobStatus,
    createdAt: e.createdAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    durationMs: e.durationMs,
    request,
    result,
    error: e.error,
    progress,
  };
}

function persist(job: JobRecord): void {
  void upsertEntity(JOBS_TABLE, toEntity(job)).catch((err) => {
    logger.warn('CorpGen job persist failed', {
      module: 'corpgen.jobs',
      id: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

let _hydrated = false;
export async function hydrateJobs(): Promise<number> {
  if (_hydrated) return _jobs.size;
  _hydrated = true;
  try {
    const rows = await listEntities<JobEntity>(JOBS_TABLE, JOBS_PARTITION);
    for (const row of rows) {
      const job = fromEntity(row);
      // Re-runs are not resumed; mark stragglers as failed so they don't appear stuck.
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.error = job.error ?? 'Process restarted before job completed';
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
      }
      _jobs.set(job.id, job);
    }
    logger.info('CorpGen jobs hydrated', { module: 'corpgen.jobs', count: rows.length });
    return rows.length;
  } catch (err) {
    logger.warn('CorpGen jobs hydrate failed', {
      module: 'corpgen.jobs',
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Create a job, kick off the worker async, and return the JobRecord. The
 * worker receives an `onProgress` callback to update the progress field.
 */
export function startJob<TResult>(
  kind: JobKind,
  request: Record<string, unknown>,
  worker: (onProgress: (p: JobRecord['progress']) => void) => Promise<TResult>,
): JobRecord<TResult> {
  gc();
  const id = randomUUID();
  const record: JobRecord<TResult> = {
    id,
    kind,
    status: 'queued',
    createdAt: new Date().toISOString(),
    request,
  };
  _jobs.set(id, record as JobRecord);
  persist(record as JobRecord);

  // Fire-and-forget background execution. Errors are captured into the record.
  void (async () => {
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    persist(record as JobRecord);
    const t0 = Date.now();
    try {
      const result = await worker((p) => {
        record.progress = p;
        persist(record as JobRecord);
      });
      record.result = result;
      record.status = 'succeeded';
    } catch (err: unknown) {
      record.error = err instanceof Error ? err.message : String(err);
      record.status = 'failed';
      logger.error('CorpGen job failed', { module: 'corpgen.jobs', id, kind, error: record.error });
    } finally {
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.now() - t0;
      persist(record as JobRecord);
      logger.info('CorpGen job finished', {
        module: 'corpgen.jobs',
        id,
        kind,
        status: record.status,
        durationMs: record.durationMs,
      });
    }
  })();

  return record;
}

/** Public summary view used by the HTTP status endpoint. */
export function summariseJob(job: JobRecord): Record<string, unknown> {
  const base = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    progress: job.progress,
    request: job.request,
  };
  if (job.status === 'failed') return { ...base, error: job.error };
  if (job.status !== 'succeeded') return base;

  // Light-touch shape sniffing so the GET response is useful without forcing
  // the caller to know the exact result type.
  if (job.kind === 'workday' && job.result && typeof job.result === 'object') {
    const day = job.result as DayRunResult;
    return {
      ...base,
      summary: {
        cyclesRun: day.cyclesRun,
        completionRate: day.completionRate,
        toolCallsUsed: day.toolCallsUsed,
        stopReason: day.stopReason,
      },
      result: day,
    };
  }
  if (job.kind === 'multi-day' && Array.isArray(job.result)) {
    const days = job.result as DayRunResult[];
    const avg =
      days.length > 0 ? days.reduce((s, r) => s + r.completionRate, 0) / days.length : 0;
    return {
      ...base,
      summary: {
        days: days.length,
        avgCompletionRate: avg,
        totalToolCalls: days.reduce((s, r) => s + r.toolCallsUsed, 0),
      },
      result: days,
    };
  }
  if (job.kind === 'organization' && Array.isArray(job.result)) {
    const org = job.result as OrganizationResult[];
    return {
      ...base,
      summary: {
        members: org.length,
        totalDays: org.reduce((s, r) => s + r.results.length, 0),
      },
      result: org,
    };
  }
  return { ...base, result: job.result };
}
