// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Presence Watch — autonomous showcase trigger
// ---------------------------------------------------------------------------
// Implements the "Cassidy reaches out first" pattern from the CorpGen paper
// (Microsoft Research, arXiv:2602.14229 §3.4 — Day Init phase, comm-channel
// fallback). Inverts the conventional human → agent flow: Cassidy polls
// Microsoft Graph presence for configured target users, debounces long
// enough to be sure they're settled in, then places an outbound ACS Teams
// call and opens the conversation with a Day-Init style briefing.
//
// Lifecycle per target OID:
//   Offline / Away / DoNotDisturb / Busy →
//     Available / AvailableIdle           ← transition detected
//       wait DEBOUNCE_MS while still Available (default 15 min)
//         → place outbound call once per cooldown window (default 12 h)
//
// Env switches (all optional — feature is OFF unless TARGETS is set):
//   SHOWCASE_PRESENCE_TARGETS   comma-separated AAD OIDs to watch
//   SHOWCASE_PRESENCE_POLL_MS   poll interval (default 60 000)
//   SHOWCASE_PRESENCE_DEBOUNCE_MS   stable-available wait (default 900 000)
//   SHOWCASE_PRESENCE_COOLDOWN_MS   per-target cooldown (default 12 * 3600 000)
//   SHOWCASE_PRESENCE_VOICE     Foundry voice (default 'verse')
// ---------------------------------------------------------------------------

import { credential } from '../agent';
import { logger } from '../logger';
import { recordEvent } from '../agentEvents';
import { initiateOutboundTeamsCall } from '../voice/acsBridge';
import { getOverdueTasks, getPendingApprovals, getTeamWorkload } from '../tools/operationsTools';

type Availability =
  | 'Available' | 'AvailableIdle'
  | 'Away' | 'BeRightBack'
  | 'Busy' | 'BusyIdle'
  | 'DoNotDisturb'
  | 'Offline' | 'PresenceUnknown'
  | 'OutOfOffice';

interface GraphPresence {
  id: string;
  availability: Availability;
  activity: string;
}

interface TargetState {
  oid: string;
  lastAvailability: Availability | null;
  /** ms timestamp when target first transitioned into Available in current streak. */
  availableSince: number | null;
  /** ms timestamp when we last placed a call for this target. */
  lastCallAt: number | null;
}

const POLL_MS = Number(process.env.SHOWCASE_PRESENCE_POLL_MS) || 60_000;
const DEBOUNCE_MS = Number(process.env.SHOWCASE_PRESENCE_DEBOUNCE_MS) || 15 * 60_000;
const COOLDOWN_MS = Number(process.env.SHOWCASE_PRESENCE_COOLDOWN_MS) || 12 * 60 * 60_000;
const VOICE = process.env.SHOWCASE_PRESENCE_VOICE || 'verse';

const _state = new Map<string, TargetState>();
let _timer: ReturnType<typeof setInterval> | null = null;
let _bootTimer: ReturnType<typeof setTimeout> | null = null;

function isOnlineState(a: Availability | null | undefined): boolean {
  return a === 'Available' || a === 'AvailableIdle';
}

function parseTargets(): string[] {
  const raw = process.env.SHOWCASE_PRESENCE_TARGETS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Batch-fetch presence for up to 650 user OIDs via
 * POST /communications/getPresencesByUserId.
 */
async function fetchPresences(oids: string[]): Promise<GraphPresence[]> {
  if (oids.length === 0) return [];
  const tok = await credential.getToken('https://graph.microsoft.com/.default');
  if (!tok?.token) throw new Error('Failed to acquire Graph token for presence');
  const res = await fetch('https://graph.microsoft.com/v1.0/communications/getPresencesByUserId', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: oids }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph presence ${res.status}: ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as { value?: GraphPresence[] };
  return json.value || [];
}

/** Compose a CorpGen Day-Init style briefing as Realtime instructions. */
async function composeBriefingInstructions(): Promise<string> {
  let overdueLine = '';
  let approvalsLine = '';
  let workloadLine = '';
  try {
    const [overdue, approvals, workload] = await Promise.all([
      getOverdueTasks({ include_at_risk: true }).catch(() => null),
      getPendingApprovals({ older_than_days: 0 }).catch(() => null),
      getTeamWorkload({}).catch(() => null),
    ]);
    if (overdue) {
      const top = overdue.tasks?.slice(0, 3).map((t) => `• ${t.title} (${t.owner}, ${t.daysOverdue}d overdue)`).join('\n') || '';
      overdueLine = `Overdue tasks: ${overdue.total} total${overdue.criticalCount ? `, ${overdue.criticalCount} critical` : ''}.${top ? '\n' + top : ''}`;
    }
    if (approvals) {
      approvalsLine = `Pending approvals: ${approvals.total}${approvals.overdueCount ? ` (${approvals.overdueCount} stalled)` : ''}.`;
    }
    if (workload) {
      workloadLine = `Team workload: ${workload.totalActiveTasks} active, ${workload.atCapacityCount} at capacity.`;
    }
  } catch (err) {
    logger.warn('presenceWatch: briefing context unavailable', { module: 'proactive.presence', error: String(err) });
  }

  const contextBlock = [overdueLine, approvalsLine, workloadLine].filter(Boolean).join('\n');

  return [
    'You are Cassidy — an autonomous AI Operations Manager modelled on the Microsoft Research CorpGen paper (arXiv:2602.14229).',
    'You initiated this Teams call yourself, unprompted, after detecting the user just came online. This is the inverse of the usual flow:',
    "the human did NOT call or message you — you reached out to them with today's Day-Init briefing.",
    '',
    'Open the call by:',
    '1. A short, warm greeting (one sentence) that explicitly acknowledges YOU called THEM, not the other way round.',
    '   Example tone: "Morning — Cassidy here. I noticed you just signed in, so I wanted to grab you with today\'s brief before things kick off."',
    '2. A 30–45 second CorpGen Day-Init style briefing of the most important items right now.',
    '3. End by asking what they want to dig into first, or whether to send the full plan to Teams chat.',
    '',
    'Style: friendly, concise, action-oriented colleague. Speak naturally — no bullet readouts, no markdown. ' +
      'Use the briefing data below as ground truth; if a section is empty, simply skip it rather than fabricating items.',
    '',
    "Today's context:",
    contextBlock || '(no live operational data is available right now — apologise briefly and offer to pull a fresh status.)',
    '',
    'If the user goes silent or seems busy, wrap up gracefully and offer to follow up later.',
  ].join('\n');
}

async function placeShowcaseCall(target: TargetState): Promise<void> {
  const instructions = await composeBriefingInstructions();
  try {
    const r = await initiateOutboundTeamsCall({
      teamsUserAadOid: target.oid,
      requestedBy: 'Cassidy (autonomous presence trigger)',
      instructions,
      voice: VOICE,
    });
    target.lastCallAt = Date.now();
    logger.info('presenceWatch: showcase call placed', {
      module: 'proactive.presence',
      target: target.oid,
      callConnectionId: r.callConnectionId,
    });
    recordEvent({
      kind: 'proactive.tick',
      label: '🤖→📞 Cassidy called user autonomously (presence trigger)',
      status: 'ok',
      data: {
        module: 'proactive.presence',
        target: target.oid,
        callConnectionId: r.callConnectionId,
        debounceMs: DEBOUNCE_MS,
      },
    });
  } catch (err) {
    logger.error('presenceWatch: showcase call failed', {
      module: 'proactive.presence',
      target: target.oid,
      error: String(err),
    });
    recordEvent({
      kind: 'proactive.tick',
      label: '❌ Presence-triggered call failed',
      status: 'error',
      data: { module: 'proactive.presence', target: target.oid, error: String(err) },
    });
  }
}

async function tick(): Promise<void> {
  const targets = parseTargets();
  if (targets.length === 0) return;

  // Lazily seed state for newly-added targets.
  for (const oid of targets) {
    if (!_state.has(oid)) {
      _state.set(oid, { oid, lastAvailability: null, availableSince: null, lastCallAt: null });
    }
  }

  let presences: GraphPresence[];
  try {
    presences = await fetchPresences(targets);
  } catch (err) {
    logger.warn('presenceWatch: presence poll failed', { module: 'proactive.presence', error: String(err) });
    return;
  }

  const now = Date.now();
  for (const p of presences) {
    const st = _state.get(p.id);
    if (!st) continue;
    const wasOnline = isOnlineState(st.lastAvailability);
    const isOnline = isOnlineState(p.availability);

    if (isOnline && !wasOnline) {
      // Transition into Available — start the debounce window.
      st.availableSince = now;
      logger.info('presenceWatch: target came online', {
        module: 'proactive.presence',
        target: p.id,
        availability: p.availability,
        debounceMs: DEBOUNCE_MS,
      });
      recordEvent({
        kind: 'proactive.tick',
        label: '👀 Target came online — debouncing for autonomous call',
        status: 'ok',
        data: { module: 'proactive.presence', target: p.id, debounceMs: DEBOUNCE_MS },
      });
    } else if (!isOnline && wasOnline) {
      // Dropped out before debounce elapsed — reset.
      st.availableSince = null;
    }

    st.lastAvailability = p.availability;

    // Trigger condition: been continuously online for at least DEBOUNCE_MS,
    // and not within COOLDOWN_MS of the previous trigger.
    if (
      isOnline &&
      st.availableSince !== null &&
      now - st.availableSince >= DEBOUNCE_MS &&
      (st.lastCallAt === null || now - st.lastCallAt >= COOLDOWN_MS)
    ) {
      // Reset the streak so we don't immediately re-arm during the same online session.
      st.availableSince = now;
      placeShowcaseCall(st).catch((err) =>
        logger.error('presenceWatch: placeShowcaseCall threw', {
          module: 'proactive.presence',
          target: p.id,
          error: String(err),
        }),
      );
    }
  }
}

export function initPresenceWatch(): void {
  const targets = parseTargets();
  if (targets.length === 0) {
    logger.info('presenceWatch: disabled (SHOWCASE_PRESENCE_TARGETS not set)', {
      module: 'proactive.presence',
    });
    return;
  }
  if (_timer) return;
  logger.info('presenceWatch: enabled', {
    module: 'proactive.presence',
    targets,
    pollMs: POLL_MS,
    debounceMs: DEBOUNCE_MS,
    cooldownMs: COOLDOWN_MS,
  });
  _timer = setInterval(() => {
    tick().catch((err) =>
      logger.error('presenceWatch: tick crashed', { module: 'proactive.presence', error: String(err) }),
    );
  }, POLL_MS);
  // First tick after a short delay so the rest of startup settles.
  _bootTimer = setTimeout(() => {
    tick().catch((err) =>
      logger.error('presenceWatch: initial tick crashed', { module: 'proactive.presence', error: String(err) }),
    );
  }, 10_000);
}

export function stopPresenceWatch(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
}

/** Diagnostics snapshot for the dashboard / smoke-test endpoints. */
export function getPresenceWatchSnapshot(): {
  enabled: boolean;
  pollMs: number;
  debounceMs: number;
  cooldownMs: number;
  targets: Array<{
    oid: string;
    lastAvailability: Availability | null;
    onlineForMs: number | null;
    cooldownRemainingMs: number | null;
  }>;
} {
  const now = Date.now();
  return {
    enabled: !!_timer,
    pollMs: POLL_MS,
    debounceMs: DEBOUNCE_MS,
    cooldownMs: COOLDOWN_MS,
    targets: [..._state.values()].map((s) => ({
      oid: s.oid,
      lastAvailability: s.lastAvailability,
      onlineForMs: s.availableSince ? now - s.availableSince : null,
      cooldownRemainingMs: s.lastCallAt ? Math.max(0, COOLDOWN_MS - (now - s.lastCallAt)) : null,
    })),
  };
}
