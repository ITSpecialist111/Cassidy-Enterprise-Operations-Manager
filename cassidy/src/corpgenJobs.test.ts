// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  startJob,
  getJob,
  listJobs,
  summariseJob,
  _resetJobsForTest,
} from './corpgenJobs';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function awaitTerminal(id: string, timeoutMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = getJob(id);
    if (j && (j.status === 'succeeded' || j.status === 'failed')) return;
    await wait(10);
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs}ms`);
}

describe('CorpGen job runner', () => {
  beforeEach(() => _resetJobsForTest());

  it('runs a worker async and records success', async () => {
    const job = startJob('multi-day', { foo: 1 }, async (onProgress) => {
      onProgress({ current: 1, total: 2 });
      await wait(20);
      onProgress({ current: 2, total: 2 });
      return [{ completionRate: 0.5, toolCallsUsed: 3 }] as never;
    });
    expect(['queued', 'running']).toContain(job.status);
    expect(job.id).toMatch(/[0-9a-f-]{36}/i);

    await awaitTerminal(job.id);
    const finished = getJob(job.id)!;
    expect(finished.status).toBe('succeeded');
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    expect(finished.progress).toEqual({ current: 2, total: 2 });
  });

  it('records failure when worker throws', async () => {
    const job = startJob('organization', {}, async () => {
      throw new Error('boom');
    });
    await awaitTerminal(job.id);
    const finished = getJob(job.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('boom');
  });

  it('summariseJob shapes multi-day result', async () => {
    const job = startJob('multi-day', {}, async () => [
      { completionRate: 1.0, toolCallsUsed: 4 } as never,
      { completionRate: 0.5, toolCallsUsed: 2 } as never,
    ]);
    await awaitTerminal(job.id);
    const sum = summariseJob(getJob(job.id)!) as Record<string, unknown>;
    expect(sum.status).toBe('succeeded');
    const s = sum.summary as { days: number; avgCompletionRate: number; totalToolCalls: number };
    expect(s.days).toBe(2);
    expect(s.avgCompletionRate).toBeCloseTo(0.75, 5);
    expect(s.totalToolCalls).toBe(6);
  });

  it('summariseJob shapes organization result', async () => {
    const job = startJob('organization', {}, async () => [
      { employeeId: 'a', results: [{} as never, {} as never] },
      { employeeId: 'b', results: [{} as never] },
    ]);
    await awaitTerminal(job.id);
    const sum = summariseJob(getJob(job.id)!) as Record<string, unknown>;
    const s = sum.summary as { members: number; totalDays: number };
    expect(s.members).toBe(2);
    expect(s.totalDays).toBe(3);
  });

  it('listJobs returns most recent first', async () => {
    const a = startJob('multi-day', {}, async () => 'a' as never);
    await wait(5);
    const b = startJob('organization', {}, async () => 'b' as never);
    await awaitTerminal(a.id);
    await awaitTerminal(b.id);
    const ids = listJobs().map((j) => j.id);
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(a.id);
  });

  it('getJob returns undefined for unknown id', () => {
    expect(getJob('nope')).toBeUndefined();
  });
});
