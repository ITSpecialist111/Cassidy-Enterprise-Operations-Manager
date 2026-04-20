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

type Phase = 'init' | 'cycle' | 'reflect' | 'monthly';

const TICK_MS = 60_000; // poll every minute
let timer: ReturnType<typeof setInterval> | null = null;
let lastFired: Map<string, string> = new Map(); // phase -> ISO minute already fired

function utcMinuteKey(now: Date, phase: Phase): string {
  return `${phase}:${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${now.getUTCHours()}:${now.getUTCMinutes()}`;
}

/** True if `now` matches the cron window for `phase`. */
function isWindow(now: Date, phase: Phase): boolean {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  switch (phase) {
    case 'init':
      // Mon–Fri 08:50 UTC
      return weekday && h === 8 && m === 50;
    case 'cycle':
      // Mon–Fri 09:00–16:40 UTC at minutes 0 / 20 / 40
      return weekday && h >= 9 && h <= 16 && (m === 0 || m === 20 || m === 40);
    case 'reflect':
      // Mon–Fri 16:30 UTC
      return weekday && h === 16 && m === 30;
    case 'monthly':
      // First day of month, 08:00 UTC, weekday only
      return weekday && now.getUTCDate() === 1 && h === 8 && m === 0;
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
    const key = utcMinuteKey(now, p);
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
