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

export type JobKind = 'multi-day' | 'organization';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

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

  // Fire-and-forget background execution. Errors are captured into the record.
  void (async () => {
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await worker((p) => {
        record.progress = p;
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
