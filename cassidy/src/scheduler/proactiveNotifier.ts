// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Proactive Notifier — legacy interval-based alerts.
// Kept for backward compatibility ("start notifications" / "stop notifications").
// The new Proactive Engine (src/proactive/) handles intelligent outreach.
// ---------------------------------------------------------------------------

import { TurnContext, CloudAdapter } from '@microsoft/agents-hosting';
import { ConversationReference } from '@microsoft/agents-activity';
import { getOverdueTasks, getPendingApprovals } from '../tools/operationsTools';
import {
  registerUser,
  getStoredConversationRef,
  getAllConversationRefs,
} from '../proactive/userRegistry';

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface NotifierSession {
  conversationId: string;
  intervalId: ReturnType<typeof setInterval> | null;
  enabled: boolean;
  alertsSent: number;
  startedAt: Date | null;
}

const sessions = new Map<string, NotifierSession>();

let _adapter: CloudAdapter | null = null;
let _botAppId: string = '';

export function setAdapter(adapter: CloudAdapter): void {
  _adapter = adapter;
  _botAppId = process.env.MicrosoftAppId ?? '';
}

// ---------------------------------------------------------------------------
// Conversation reference capture — now delegates to persistent userRegistry
// ---------------------------------------------------------------------------

export function captureConversationReference(context: TurnContext): void {
  // Delegate to the persistent user registry
  registerUser(context).catch(err =>
    console.error('[ProactiveNotifier] User registration failed:', err)
  );

  // Also maintain local session for interval-based notifications
  const convId = context.activity?.conversation?.id;
  if (!convId) return;

  if (!sessions.has(convId)) {
    sessions.set(convId, {
      conversationId: convId,
      intervalId: null,
      enabled: false,
      alertsSent: 0,
      startedAt: null,
    });
  }
}

export async function getConversationReference(convId: string): Promise<ConversationReference | undefined> {
  // Try persistent registry first, fall back to userId-based lookup
  const userId = convId; // In 1:1 chats, convId often contains the userId
  const ref = await getStoredConversationRef(userId);
  return ref ?? undefined;
}

export async function getAllConversationReferences(): Promise<Map<string, ConversationReference>> {
  return getAllConversationRefs();
}

// ---------------------------------------------------------------------------
// Detect notification commands in user messages
// ---------------------------------------------------------------------------

export function detectNotificationCommand(
  text: string,
): 'start' | 'stop' | 'status' | null {
  const lower = text.toLowerCase();
  if (/\b(start|enable|turn on|activate)\s+(notif|alert|monitor|watch)/i.test(lower)) return 'start';
  if (/\b(stop|disable|turn off|deactivate)\s+(notif|alert|monitor|watch)/i.test(lower)) return 'stop';
  if (/\b(notif|alert|monitor)\s+(status|on|off|active|enabled)/i.test(lower)) return 'status';
  return null;
}

// ---------------------------------------------------------------------------
// Start / stop notifications (legacy interval-based)
// ---------------------------------------------------------------------------

export function startNotifications(convId: string): { success: boolean; message: string } {
  let session = sessions.get(convId);
  if (!session) {
    session = {
      conversationId: convId,
      intervalId: null,
      enabled: false,
      alertsSent: 0,
      startedAt: null,
    };
    sessions.set(convId, session);
  }
  if (session.enabled) return { success: true, message: '🔔 Proactive notifications are already active.' };

  session.enabled = true;
  session.startedAt = new Date();
  session.alertsSent = 0;

  session.intervalId = setInterval(() => {
    sendProactiveAlert(convId).catch((err: unknown) =>
      console.error('[Cassidy] Proactive alert error:', err)
    );
  }, INTERVAL_MS);

  return {
    success: true,
    message: `🔔 **Proactive notifications activated.** I'll alert you every 30 minutes if there are overdue tasks or stalled approvals.\n\n` +
      `_Tip: I also send intelligent proactive messages automatically — say **"configure notifications"** to customise._`,
  };
}

export function stopNotifications(convId: string): { success: boolean; message: string } {
  const session = sessions.get(convId);
  if (!session?.enabled) return { success: true, message: '🔕 Notifications are already off.' };

  if (session.intervalId) {
    clearInterval(session.intervalId);
    session.intervalId = null;
  }
  session.enabled = false;

  const msg = `🔕 **Interval notifications stopped.** I sent ${session.alertsSent} alert(s) since ${session.startedAt?.toLocaleTimeString() ?? 'start'}.\n\n` +
    `_Note: I'll still reach out proactively about critical issues. Say **"configure notifications"** to adjust._`;

  // Clean up session entry — no longer needed once stopped
  sessions.delete(convId);

  return { success: true, message: msg };
}

export function getNotificationStatus(convId: string): {
  enabled: boolean;
  alertsSent: number;
  startedAt: Date | null;
} {
  const session = sessions.get(convId);
  return {
    enabled: session?.enabled ?? false,
    alertsSent: session?.alertsSent ?? 0,
    startedAt: session?.startedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Send a proactive alert for overdue items (legacy interval-based)
// ---------------------------------------------------------------------------

async function sendProactiveAlert(convId: string): Promise<void> {
  const session = sessions.get(convId);
  if (!session?.enabled || !_adapter) return;

  // Get conversation ref from persistent registry
  const ref = await getConversationReference(convId);
  if (!ref) return;

  const overdue = getOverdueTasks({ include_at_risk: false });
  const approvals = getPendingApprovals({ older_than_days: 2 });

  if (overdue.total === 0 && approvals.overdueCount === 0) {
    const quietMsg = `✅ **Ops check (${new Date().toLocaleTimeString()}):** All tasks on track, no stalled approvals.`;
    await sendToConversation(ref, quietMsg);
  } else {
    const lines: string[] = [`🔔 **Ops Alert — ${new Date().toLocaleTimeString()}**`, ''];

    if (overdue.total > 0) {
      lines.push(`🔴 **${overdue.total} overdue task(s):**`);
      overdue.tasks.slice(0, 3).forEach(t => {
        lines.push(`  - **${t.title}** · ${t.owner} · ${t.daysOverdue}d overdue${t.blocked ? ' 🔵 BLOCKED' : ''}`);
      });
      if (overdue.total > 3) lines.push(`  _(+${overdue.total - 3} more)_`);
      lines.push('');
    }

    if (approvals.overdueCount > 0) {
      lines.push(`🟡 **${approvals.overdueCount} stalled approval(s):**`);
      approvals.approvals.filter(a => a.isOverdue).forEach(a => {
        lines.push(`  - **${a.title}** · Approver: ${a.approver} · ${a.submittedDaysAgo}d pending`);
      });
      lines.push('');
    }

    lines.push('_Reply "stop notifications" to disable these alerts._');
    await sendToConversation(ref, lines.join('\n'));
  }

  session.alertsSent++;
}

async function sendToConversation(ref: ConversationReference, text: string): Promise<void> {
  if (!_adapter) return;
  await _adapter.continueConversation(_botAppId, ref, async (context: TurnContext) => {
    await context.sendActivity(text);
  });
}
