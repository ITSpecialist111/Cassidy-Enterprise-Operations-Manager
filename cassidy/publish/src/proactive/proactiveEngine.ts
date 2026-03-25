// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Proactive Engine — the brain that decides when, what, and to whom
// Cassidy should proactively reach out. Replaces dumb interval timers
// with intelligent, event-driven outreach using GPT-5 composed messages.
// ---------------------------------------------------------------------------

import { CloudAdapter, TurnContext } from '@microsoft/agents-hosting';
import { ConversationReference } from '@microsoft/agents-activity';
import { getSharedOpenAI } from '../auth';
import {
  getAllActiveUsers,
  getConversationRefFromProfile,
  getNotificationPrefsFromProfile,
  isInQuietHours,
  UserProfile,
} from './userRegistry';
import { getAllTriggers, TriggerCondition, OutreachAction } from './eventTriggers';
import { runPredictionCycle } from '../intelligence/predictiveEngine';
import { refreshOrgGraph } from '../intelligence/orgGraph';
import { initiateCall, getCallByUserId } from '../voice/callManager';
import { shouldEscalateToVoice } from '../voice/voiceAgent';

const POLL_INTERVAL_MS = Number(process.env.PROACTIVE_ENGINE_INTERVAL_MS) || 5 * 60 * 1000; // 5 minutes
const COOLDOWN_MINUTES = Number(process.env.PROACTIVE_COOLDOWN_MINUTES) || 60;
const PREDICTION_CYCLE_INTERVAL = 6; // Run predictions every 6th loop (~30 min)
const ORG_REFRESH_INTERVAL = 72;      // Refresh org graph every 72nd loop (~6 hours)
let _loopCount = 0;

let _adapter: CloudAdapter | null = null;
let _botAppId = '';
let _loopTimer: ReturnType<typeof setInterval> | null = null;
let _bootTimer: ReturnType<typeof setTimeout> | null = null;

// Track when each trigger last fired for each user (prevents spamming)
const _cooldowns = new Map<string, Date>(); // key: `${userId}:${triggerId}`

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function initProactiveEngine(adapter: CloudAdapter): void {
  _adapter = adapter;
  _botAppId = process.env.MicrosoftAppId ?? '';
  _loopTimer = setInterval(runProactiveLoop, POLL_INTERVAL_MS);
  console.log(`[ProactiveEngine] Started — evaluating triggers every ${POLL_INTERVAL_MS / 1000}s`);
  // First evaluation after 30s boot delay
  _bootTimer = setTimeout(runProactiveLoop, 30_000);
}

export function stopProactiveEngine(): void {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  console.log('[ProactiveEngine] Stopped');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runProactiveLoop(): Promise<void> {
  try {
    _loopCount++;

    // Evict stale cooldown entries (2x cooldown period — no longer needed)
    const maxCooldownMs = COOLDOWN_MINUTES * 60 * 1000 * 2;
    for (const [key, date] of _cooldowns) {
      if (Date.now() - date.getTime() > maxCooldownMs) {
        _cooldowns.delete(key);
      }
    }

    // Run prediction cycle periodically (~every 30 min)
    if (_loopCount % PREDICTION_CYCLE_INTERVAL === 0) {
      runPredictionCycle().catch(err =>
        console.error('[ProactiveEngine] Prediction cycle failed:', err)
      );
    }

    // Refresh org graph periodically (~every 6 hours)
    if (_loopCount % ORG_REFRESH_INTERVAL === 0) {
      refreshOrgGraph().catch(err =>
        console.error('[ProactiveEngine] Org graph refresh failed:', err)
      );
    }

    const actions = await evaluateAllTriggers();
    if (actions.length === 0) return;

    console.log(`[ProactiveEngine] ${actions.length} outreach action(s) to execute`);
    for (const action of actions) {
      await executeOutreach(action).catch(err =>
        console.error(`[ProactiveEngine] Outreach failed for ${action.targetUserId}:`, err)
      );
    }
  } catch (err) {
    console.error('[ProactiveEngine] Loop error:', err);
  }
}

// ---------------------------------------------------------------------------
// Evaluate all triggers against all active users
// ---------------------------------------------------------------------------

export async function evaluateAllTriggers(): Promise<OutreachAction[]> {
  const users = await getAllActiveUsers();
  if (users.length === 0) return [];

  const triggers = getAllTriggers();
  const actions: OutreachAction[] = [];

  for (const trigger of triggers) {
    // Check global trigger cooldown
    if (trigger.lastFired && minutesSince(trigger.lastFired) < trigger.cooldownMinutes) {
      continue;
    }

    try {
      const triggerActions = await trigger.evaluate(users);
      for (const action of triggerActions) {
        // Check per-user cooldown for this trigger
        const cooldownKey = `${action.targetUserId}:${trigger.id}`;
        const lastFired = _cooldowns.get(cooldownKey);
        if (lastFired && minutesSince(lastFired) < COOLDOWN_MINUTES) {
          continue;
        }

        // Check quiet hours for the target user
        const user = users.find(u => u.rowKey === action.targetUserId);
        if (user) {
          const prefs = getNotificationPrefsFromProfile(user);
          if (isInQuietHours(prefs, user.timezone) && action.urgency !== 'critical') {
            continue; // respect quiet hours unless critical
          }
        }

        actions.push(action);
      }

      if (triggerActions.length > 0) {
        trigger.lastFired = new Date();
      }
    } catch (err) {
      console.error(`[ProactiveEngine] Trigger "${trigger.id}" failed:`, err);
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Execute a single outreach action — compose message via GPT-5 and send
// ---------------------------------------------------------------------------

export async function executeOutreach(action: OutreachAction): Promise<void> {
  if (!_adapter) {
    console.warn('[ProactiveEngine] No adapter — cannot send proactive message');
    return;
  }

  // Get the user's conversation reference
  const users = await getAllActiveUsers();
  const user = users.find(u => u.rowKey === action.targetUserId);
  if (!user) {
    console.warn(`[ProactiveEngine] No user profile for ${action.targetUserId}`);
    return;
  }

  const ref = getConversationRefFromProfile(user);
  if (!ref) {
    console.warn(`[ProactiveEngine] No conversation ref for ${action.targetUserId}`);
    return;
  }

  // Compose a natural, conversational message using GPT-5
  const message = await composeProactiveMessage(action, user);

  // Send via Teams
  if (action.channel === 'teams_chat' || action.channel === 'both') {
    await sendToConversation(ref, message);
  }

  // Voice escalation — for critical/high urgency, check if a previous outreach
  // was sent and enough time has passed without response
  if ((action.urgency === 'critical' || action.urgency === 'high') && !getCallByUserId(action.targetUserId)) {
    const prevCooldownKey = `${action.targetUserId}:${action.triggerName}`;
    const prevFired = _cooldowns.get(prevCooldownKey);
    if (prevFired) {
      const minutesSincePrev = minutesSince(prevFired);
      if (shouldEscalateToVoice(action.urgency, minutesSincePrev)) {
        console.log(`[ProactiveEngine] Escalating to voice call for ${user.displayName} (${action.urgency}, no response for ${Math.round(minutesSincePrev)}m)`);
        await initiateCall({
          targetUserId: action.targetUserId,
          targetDisplayName: user.displayName,
          reason: action.reason ?? action.triggerName,
          context: action.context,
        }).catch(err => console.error(`[ProactiveEngine] Voice escalation failed:`, err));
      }
    }
  }

  // Record cooldown
  const cooldownKey = `${action.targetUserId}:${action.triggerName}`;
  _cooldowns.set(cooldownKey, new Date());

  console.log(`[ProactiveEngine] Sent ${action.urgency} outreach to ${user.displayName} (trigger: ${action.triggerName})`);
}

// ---------------------------------------------------------------------------
// Compose natural message using GPT-5
// ---------------------------------------------------------------------------

export async function composeProactiveMessage(
  action: OutreachAction,
  user: UserProfile,
): Promise<string> {
  const openai = getSharedOpenAI();

  const contextSummary = Object.entries(action.context)
    .map(([key, val]) => `${key}: ${JSON.stringify(val)}`)
    .join('\n');

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
    messages: [
      {
        role: 'system',
        content: `You are Cassidy, an AI Operations Manager reaching out proactively to a colleague.
Write a brief, natural Teams message (3-6 sentences max) to ${user.displayName}.
Tone: friendly, professional, action-oriented — like a helpful colleague, not a system notification.
Urgency level: ${action.urgency}.

Rules:
- Start with a greeting if this is a morning briefing, otherwise get straight to the point.
- Always offer a specific next action: "Want me to chase this?" or "Should I escalate?"
- Use bold (**text**) for important names, dates, and numbers.
- Do NOT use markdown tables. Use bullet points if listing more than 2 items.
- Keep it conversational — this is a Teams chat, not an email.
- End with a clear question or offer to act.`,
      },
      {
        role: 'user',
        content: `Compose a proactive outreach message based on this trigger:\n\nTrigger: ${action.triggerName}\nReason: ${action.reason ?? 'scheduled check'}\n\nContext data:\n${contextSummary}`,
      },
    ],
    max_completion_tokens: 500,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (content) return content;

  // Fallback if GPT-5 fails
  return `Hey ${user.displayName}, I flagged something that needs your attention. ${action.reason ?? 'Check your dashboard for details.'}`;
}

// ---------------------------------------------------------------------------
// Send to Teams conversation
// ---------------------------------------------------------------------------

async function sendToConversation(ref: ConversationReference, text: string): Promise<void> {
  if (!_adapter) return;
  await _adapter.continueConversation(_botAppId, ref, async (context: TurnContext) => {
    await context.sendActivity(text);
  });
}

// ---------------------------------------------------------------------------
// Manual trigger — called by /api/proactive-trigger endpoint
// ---------------------------------------------------------------------------

export async function triggerSpecific(triggerType: string): Promise<{ triggered: number; errors: string[] }> {
  const triggers = getAllTriggers();
  const target = triggers.find(t => t.id === triggerType);
  if (!target) {
    return { triggered: 0, errors: [`Unknown trigger type: ${triggerType}`] };
  }

  const users = await getAllActiveUsers();
  const errors: string[] = [];
  let triggered = 0;

  try {
    const actions = await target.evaluate(users);
    for (const action of actions) {
      try {
        await executeOutreach(action);
        triggered++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    target.lastFired = new Date();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { triggered, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60);
}
