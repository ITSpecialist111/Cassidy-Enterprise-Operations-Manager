// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CorpGen autonomous workday scheduler (in-process)
// ---------------------------------------------------------------------------
// Drives Cassidy through CorpGen Algorithm 1 (Day Init / Cycles / Day End)
// without any external trigger. Replaces the unbuilt Azure Function timer
// because the workspace currently runs only the App Service webapp.
//
// All times UTC. Cassidy's identity says 09:00–17:00 Europe/London which is
// 08:00–16:00 UTC during BST (Apr–Oct) and 09:00–17:00 UTC during GMT.
// Schedule below uses windows that cover both, and the bridge's
// checkWorkHours() gating still prevents off-hours work.
// ---------------------------------------------------------------------------

import { logger } from './logger';
import { startJob } from './corpgenJobs';
import { getLocalParts } from './corpgenIntegration';

type Phase = 'init' | 'cycle' | 'reflect' | 'monthly';

const TICK_MS = 60_000; // poll every minute
const TZ = process.env.CORPGEN_WORK_TZ || 'Australia/Sydney';
let timer: ReturnType<typeof setInterval> | null = null;
let lastFired: Map<string, string> = new Map(); // phase -> ISO minute already fired

function localMinuteKey(now: Date, phase: Phase): string {
  const p = getLocalParts(now, TZ);
  return `${phase}:${p.month}-${p.day}T${p.h}:${p.m}`;
}

/** True if `now` matches the cron window for `phase` in Sydney local time. */
function isWindow(now: Date, phase: Phase): boolean {
  const p = getLocalParts(now, TZ);
  const weekday = p.weekday !== 'Sat' && p.weekday !== 'Sun';
  switch (phase) {
    case 'init':
      // 08:50 local, weekdays — Day Init before 09:00 working start
      return weekday && p.h === 8 && p.m === 50;
    case 'cycle':
      // Every 20 min during 09:00–17:00 local (last cycle 17:00), weekdays
      return weekday && p.h >= 9 && p.h <= 17 && (p.m === 0 || p.m === 20 || p.m === 40);
    case 'reflect':
      // 17:20 local — Day End reflection just before close
      return weekday && p.h === 17 && p.m === 20;
    case 'monthly':
      // 1st of month, 08:00 local, weekday
      return weekday && p.day === 1 && p.h === 8 && p.m === 0;
  }
}

async function firePhase(phase: Phase): Promise<void> {
  logger.info('CorpGen scheduler firing', { module: 'corpgen.scheduler', phase });
  try {
    const job = startJob('workday', { phase, source: 'in-process-scheduler' }, async () => {
      const { runWorkdayForCassidy } = await import('./corpgenIntegration');
      return await runWorkdayForCassidy({ phase }) as unknown as Record<string, unknown>;
    });
    logger.info('CorpGen scheduler enqueued', { module: 'corpgen.scheduler', phase, jobId: job.id });
  } catch (err) {
    logger.error('CorpGen scheduler failed to enqueue', {
      module: 'corpgen.scheduler', phase, error: String(err),
    });
  }
}

function tick(): void {
  const now = new Date();
  const phases: Phase[] = ['init', 'cycle', 'reflect', 'monthly'];
  for (const p of phases) {
    if (!isWindow(now, p)) continue;
    const key = localMinuteKey(now, p);
    if (lastFired.get(p) === key) continue; // already fired this minute
    lastFired.set(p, key);
    void firePhase(p);
  }
}

/** Start the in-process CorpGen scheduler. Idempotent. */
export function startCorpGenScheduler(): void {
  if (timer) return;
  if (process.env.CORPGEN_SCHEDULER_ENABLED === 'false') {
    logger.info('CorpGen scheduler disabled by env', { module: 'corpgen.scheduler' });
    return;
  }
  lastFired = new Map();
  timer = setInterval(tick, TICK_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('CorpGen scheduler started', { module: 'corpgen.scheduler', tickMs: TICK_MS });
}

/** Stop the scheduler (graceful shutdown). */
export function stopCorpGenScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('CorpGen scheduler stopped', { module: 'corpgen.scheduler' });
  }
}

/** Test hook: force-fire a phase regardless of schedule. */
export async function fireCorpGenPhaseNow(phase: Phase): Promise<{ jobId: string }> {
  const job = startJob('workday', { phase, source: 'manual-fire' }, async () => {
    const { runWorkdayForCassidy } = await import('./corpgenIntegration');
    return await runWorkdayForCassidy({ phase, force: true }) as unknown as Record<string, unknown>;
  });
  return { jobId: job.id };
}
