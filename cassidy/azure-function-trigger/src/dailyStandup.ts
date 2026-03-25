import { app, InvocationContext, Timer } from '@azure/functions';
import axios from 'axios';
import 'dotenv/config';

const CASSIDY_AGENT_URL = process.env.CASSIDY_AGENT_URL ?? '';
const SCHEDULED_SECRET = process.env.SCHEDULED_SECRET ?? '';

// ---------------------------------------------------------------------------
// Daily Operations Standup
// Mon–Fri at 22:00 UTC = 09:00 AEST (UTC+11) / 08:00 AEST (UTC+10 standard)
// ---------------------------------------------------------------------------

export async function dailyStandup(myTimer: Timer, context: InvocationContext): Promise<void> {
  context.log('dailyStandup trigger fired — initiating daily operations standup for Cassidy');

  if (!CASSIDY_AGENT_URL) {
    context.error('CASSIDY_AGENT_URL environment variable is not set');
    return;
  }

  if (!SCHEDULED_SECRET) {
    context.error('SCHEDULED_SECRET environment variable is not set');
    return;
  }

  try {
    const response = await axios.post(
      `${CASSIDY_AGENT_URL}/api/scheduled`,
      {
        triggerType: 'dailyStandup',
        scheduledFor: new Date().toISOString(),
        description: 'Daily operations standup — overdue tasks, stalled approvals, team workload summary',
      },
      {
        headers: {
          'x-scheduled-secret': SCHEDULED_SECRET,
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      }
    );

    context.log(`dailyStandup completed successfully. Status: ${response.status}`);
  } catch (err) {
    context.error('dailyStandup failed to reach Cassidy agent', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Weekly Project Summary
// Sundays at 22:00 UTC = Monday 09:00 AEST — full project status report
// ---------------------------------------------------------------------------

export async function weeklyProjectSummary(myTimer: Timer, context: InvocationContext): Promise<void> {
  context.log('weeklyProjectSummary trigger fired — initiating weekly project review for Cassidy');

  if (!CASSIDY_AGENT_URL) {
    context.error('CASSIDY_AGENT_URL environment variable is not set');
    return;
  }

  try {
    const response = await axios.post(
      `${CASSIDY_AGENT_URL}/api/scheduled`,
      {
        triggerType: 'weeklyProjectSummary',
        scheduledFor: new Date().toISOString(),
        description: 'Weekly project status review — all active projects, capacity report, week-ahead priorities',
      },
      {
        headers: {
          'x-scheduled-secret': SCHEDULED_SECRET,
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      }
    );

    context.log(`weeklyProjectSummary completed successfully. Status: ${response.status}`);
  } catch (err) {
    context.error('weeklyProjectSummary failed to reach Cassidy agent', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Function registrations
// ---------------------------------------------------------------------------

app.timer('dailyStandup', {
  // Mon–Fri 22:00 UTC = 09:00 AEST (UTC+11)
  schedule: '0 0 22 * * 1-5',
  handler: dailyStandup,
});

app.timer('weeklyProjectSummary', {
  // Every Sunday 22:00 UTC = Monday 09:00 AEST
  schedule: '0 0 22 * * 0',
  handler: weeklyProjectSummary,
});
