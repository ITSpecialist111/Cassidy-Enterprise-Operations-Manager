// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// User Registry — persistent user profiles and conversation references.
// Replaces the in-memory sessions Map in proactiveNotifier.ts so that
// conversation references survive restarts and Azure App Service scale-out.
// ---------------------------------------------------------------------------

import { TurnContext } from '@microsoft/agents-hosting';
import { ConversationReference } from '@microsoft/agents-activity';
import { upsertEntity, getEntity, listEntities } from '../memory/tableStorage';

const TABLE = 'CassidyUserRegistry';
const PARTITION = 'users';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  morningBrief: boolean;
  overdueAlerts: boolean;
  approvalReminders: boolean;
  meetingPrep: boolean;
  weeklyDigest: boolean;
  quietHoursStart?: string; // "18:00" — no messages after this
  quietHoursEnd?: string;   // "08:00" — no messages before this
}

export interface UserProfile {
  partitionKey: string;
  rowKey: string;             // userId from activity.from.id (Teams 29:...)
  aadObjectId?: string;       // AAD oid — matches Easy Auth principal.oid
  displayName: string;
  email: string;
  timezone: string;
  conversationRef: string;    // JSON-serialised ConversationReference
  preferredChannel: 'teams_chat' | 'email';
  lastInteraction: string;    // ISO timestamp
  firstInteraction: string;   // ISO timestamp
  notificationPrefs: string;  // JSON-serialised NotificationPrefs
  interactionCount: number;
  [key: string]: unknown;
}

const DEFAULT_PREFS: NotificationPrefs = {
  morningBrief: true,
  overdueAlerts: true,
  approvalReminders: true,
  meetingPrep: true,
  weeklyDigest: true,
};

// ---------------------------------------------------------------------------
// Register / update user on every incoming message
// ---------------------------------------------------------------------------

export async function registerUser(context: TurnContext): Promise<void> {
  const activity = context.activity;
  if (!activity?.from?.id || !activity?.conversation?.id) return;

  const userId = sanitiseRowKey(activity.from.id);
  const ref = activity.getConversationReference();
  const aadObjectId = (activity.from as { aadObjectId?: string }).aadObjectId;
  const now = new Date().toISOString();

  const existing = await getEntity<UserProfile>(TABLE, PARTITION, userId);

  if (existing) {
    // Update conversation reference and last interaction (and backfill aadObjectId)
    await upsertEntity(TABLE, {
      ...existing,
      conversationRef: JSON.stringify(ref),
      displayName: activity.from.name ?? existing.displayName,
      aadObjectId: aadObjectId ?? existing.aadObjectId,
      lastInteraction: now,
      interactionCount: (existing.interactionCount ?? 0) + 1,
    });
  } else {
    // First interaction — create full profile
    const profile: UserProfile = {
      partitionKey: PARTITION,
      rowKey: userId,
      aadObjectId,
      displayName: activity.from.name ?? 'Unknown',
      email: '', // Will be populated via Graph findUser on first enrichment
      timezone: process.env.ORG_TIMEZONE ?? 'AEST',
      conversationRef: JSON.stringify(ref),
      preferredChannel: 'teams_chat',
      lastInteraction: now,
      firstInteraction: now,
      notificationPrefs: JSON.stringify(DEFAULT_PREFS),
      interactionCount: 1,
    };
    await upsertEntity(TABLE, profile);
    console.log(`[UserRegistry] New user registered: ${profile.displayName} (${userId}, oid=${aadObjectId ?? 'none'})`);
  }
}

// ---------------------------------------------------------------------------
// Lookup functions
// ---------------------------------------------------------------------------

export async function getUser(userId: string): Promise<UserProfile | null> {
  return getEntity<UserProfile>(TABLE, PARTITION, sanitiseRowKey(userId));
}

export async function getUserByEmail(email: string): Promise<UserProfile | null> {
  // Table Storage doesn't support efficient secondary-key lookups,
  // so we scan all users. Fine for small-to-medium orgs (<1000 users).
  const all = await listEntities<UserProfile>(TABLE, PARTITION);
  return all.find(u => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function getAllActiveUsers(): Promise<UserProfile[]> {
  return listEntities<UserProfile>(TABLE, PARTITION);
}

// ---------------------------------------------------------------------------
// Preference management
// ---------------------------------------------------------------------------

export async function updateUserPrefs(
  userId: string,
  prefs: Partial<NotificationPrefs>,
): Promise<{ success: boolean; message: string }> {
  const user = await getUser(userId);
  if (!user) return { success: false, message: 'User not found in registry.' };

  const currentPrefs: NotificationPrefs = JSON.parse(user.notificationPrefs || '{}');
  const merged = { ...DEFAULT_PREFS, ...currentPrefs, ...prefs };

  await upsertEntity(TABLE, {
    ...user,
    notificationPrefs: JSON.stringify(merged),
  });

  return { success: true, message: `Notification preferences updated.` };
}

export async function updateUserEmail(userId: string, email: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;
  await upsertEntity(TABLE, { ...user, email });
}

export async function updateUserTimezone(userId: string, timezone: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;
  await upsertEntity(TABLE, { ...user, timezone });
}

// ---------------------------------------------------------------------------
// Conversation reference retrieval
// ---------------------------------------------------------------------------

export function getConversationRefFromProfile(profile: UserProfile): ConversationReference | null {
  try {
    return JSON.parse(profile.conversationRef) as ConversationReference;
  } catch {
    return null;
  }
}

export function getNotificationPrefsFromProfile(profile: UserProfile): NotificationPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(profile.notificationPrefs) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function getStoredConversationRef(userId: string): Promise<ConversationReference | null> {
  const user = await getUser(sanitiseRowKey(userId));
  if (!user) return null;
  return getConversationRefFromProfile(user);
}

export async function getAllConversationRefs(): Promise<Map<string, ConversationReference>> {
  const users = await getAllActiveUsers();
  const refs = new Map<string, ConversationReference>();
  for (const u of users) {
    const ref = getConversationRefFromProfile(u);
    if (ref) refs.set(u.rowKey, ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Quiet-hours check
// ---------------------------------------------------------------------------

export function isInQuietHours(prefs: NotificationPrefs, timezone?: string): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;

  // Use the user's timezone to determine current time, falling back to server time
  let currentMinutes: number;
  const tz = timezone || process.env.ORG_TIMEZONE;
  if (tz) {
    try {
      // Try IANA timezone (e.g. "Australia/Sydney")
      const nowInTz = new Date().toLocaleString('en-US', { timeZone: tz });
      const d = new Date(nowInTz);
      currentMinutes = d.getHours() * 60 + d.getMinutes();
    } catch {
      // Non-IANA timezone string (e.g. "AEST") — fall back to UTC offset approach
      const now = new Date();
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }
  } else {
    const now = new Date();
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }

  const [startH, startM] = prefs.quietHoursStart.split(':').map(Number);
  const [endH, endM] = prefs.quietHoursEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range: e.g. 18:00–22:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Cross-midnight: e.g. 22:00–08:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitiseRowKey(key: string): string {
  // Azure Table Storage row keys cannot contain / \ # ?
  return key.replace(/[/\\#?]/g, '_').slice(0, 200);
}
