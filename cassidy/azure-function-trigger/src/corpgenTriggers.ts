import { app, InvocationContext, Timer } from '@azure/functions';
import axios from 'axios';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// CorpGen autonomous workday triggers
// ---------------------------------------------------------------------------
// Four cron-driven phases that drive Cassidy's day end-to-end without manual
// intervention, mapped to CorpGen Algorithm 1 (Day Init / Cycles / Day End)
// plus a monthly objective regen. Each posts to /api/corpgen/run with a
// `phase` tag so the bridge can apply phase-appropriate caps and telemetry.
//
// Times are UTC. Cassidy's identity schedule is 09:00–17:00 Europe/London,
// which is 08:00–16:00 UTC during BST (Apr–Oct) and 09:00–17:00 UTC GMT.
// We pick UTC slots that fall inside the bridge's 07–18 UTC gating window
// year-round.
// ---------------------------------------------------------------------------

const CASSIDY_AGENT_URL = process.env.CASSIDY_AGENT_URL ?? '';
const SCHEDULED_SECRET = process.env.SCHEDULED_SECRET ?? '';

async function fireCorpGenPhase(
  phase: 'init' | 'cycle' | 'reflect' | 'monthly',
  context: InvocationContext,
): Promise<void> {
  context.log(`corpgen phase=${phase} trigger fired`);
  if (!CASSIDY_AGENT_URL || !SCHEDULED_SECRET) {
    context.error('CASSIDY_AGENT_URL or SCHEDULED_SECRET not set');
    return;
  }
  try {
    const response = await axios.post(
      `${CASSIDY_AGENT_URL}/api/corpgen/run`,
      { phase, async: true },
      {
        headers: {
          'x-scheduled-secret': SCHEDULED_SECRET,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );
    context.log(`corpgen phase=${phase} enqueued status=${response.status} body=${JSON.stringify(response.data)}`);
  } catch (err) {
    context.error(`corpgen phase=${phase} failed`, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Day Init — Mon–Fri 08:50 UTC (≈ 09:50 BST / 08:50 GMT)
// ---------------------------------------------------------------------------
export async function corpgenInit(_t: Timer, context: InvocationContext): Promise<void> {
  await fireCorpGenPhase('init', context);
}

// ---------------------------------------------------------------------------
// Through-day execution cycles — Mon–Fri every 20 min, 09:00–16:40 UTC
// ---------------------------------------------------------------------------
export async function corpgenCycle(_t: Timer, context: InvocationContext): Promise<void> {
  await fireCorpGenPhase('cycle', context);
}

// ---------------------------------------------------------------------------
// Day End reflection — Mon–Fri 16:30 UTC (≈ 17:30 BST / 16:30 GMT)
// ---------------------------------------------------------------------------
export async function corpgenReflect(_t: Timer, context: InvocationContext): Promise<void> {
  await fireCorpGenPhase('reflect', context);
}

// ---------------------------------------------------------------------------
// Monthly objective regen — first Monday of each month 08:00 UTC
// ---------------------------------------------------------------------------
export async function corpgenMonthly(_t: Timer, context: InvocationContext): Promise<void> {
  await fireCorpGenPhase('monthly', context);
}

app.timer('corpgenInit',    { schedule: '0 50 8 * * 1-5',          handler: corpgenInit });
app.timer('corpgenCycle',   { schedule: '0 0,20,40 9-16 * * 1-5',  handler: corpgenCycle });
app.timer('corpgenReflect', { schedule: '0 30 16 * * 1-5',         handler: corpgenReflect });
app.timer('corpgenMonthly', { schedule: '0 0 8 1 * *',             handler: corpgenMonthly });
