// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Meeting Context — maintains a sliding window of meeting state:
// transcript segments, participants, topics, and action items.
// Stored in-memory (meetings are ephemeral) with Table Storage backup.
// ---------------------------------------------------------------------------

import { upsertEntity, getEntity } from '../memory/tableStorage';

const TABLE = 'CassidyMeetingSessions';
const PARTITION = 'meetings';
const MAX_TRANSCRIPT_BUFFER = Number(process.env.MEETING_TRANSCRIPT_BUFFER_SIZE) || 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptSegment {
  speaker: string;
  text: string;
  timestamp: string;    // ISO timestamp
  sequenceNumber: number;
}

export interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
  detectedAt: string;
  source: string;       // speaker who raised it
}

export interface MeetingSession {
  meetingId: string;
  organizerName?: string;
  organizerEmail?: string;
  chatId?: string;          // meeting chat thread ID for posting responses
  participants: string[];
  startTime: string;
  transcriptBuffer: TranscriptSegment[];
  detectedTopics: string[];
  actionItems: ActionItem[];
  cassidyResponseCount: number;
  isActive: boolean;
}

// In-memory store of active meeting sessions
const activeSessions = new Map<string, MeetingSession>();

// Reap stale sessions that were never explicitly ended (6-hour TTL)
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [meetingId, session] of activeSessions) {
    if (now - new Date(session.startTime).getTime() > SESSION_TTL_MS) {
      console.warn(`[MeetingContext] Reaping stale session: ${meetingId}`);
      session.isActive = false;
      activeSessions.delete(meetingId);
      persistSession(session).catch(() => {});
    }
  }
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function startMeetingSession(params: {
  meetingId: string;
  organizerName?: string;
  organizerEmail?: string;
  chatId?: string;
  participants?: string[];
}): MeetingSession {
  const session: MeetingSession = {
    meetingId: params.meetingId,
    organizerName: params.organizerName,
    organizerEmail: params.organizerEmail,
    chatId: params.chatId,
    participants: params.participants ?? [],
    startTime: new Date().toISOString(),
    transcriptBuffer: [],
    detectedTopics: [],
    actionItems: [],
    cassidyResponseCount: 0,
    isActive: true,
  };

  activeSessions.set(params.meetingId, session);
  console.log(`[MeetingContext] Session started: ${params.meetingId} (${session.participants.length} participants)`);
  return session;
}

export function endMeetingSession(meetingId: string): MeetingSession | null {
  const session = activeSessions.get(meetingId);
  if (!session) return null;

  session.isActive = false;
  activeSessions.delete(meetingId);

  // Persist to Table Storage for post-meeting analysis
  persistSession(session).catch(err =>
    console.error(`[MeetingContext] Failed to persist session ${meetingId}:`, err)
  );

  console.log(`[MeetingContext] Session ended: ${meetingId} (${session.cassidyResponseCount} responses, ${session.actionItems.length} action items)`);
  return session;
}

export function getMeetingSession(meetingId: string): MeetingSession | null {
  return activeSessions.get(meetingId) ?? null;
}

export function getActiveMeetings(): MeetingSession[] {
  return Array.from(activeSessions.values()).filter(s => s.isActive);
}

// ---------------------------------------------------------------------------
// Transcript management
// ---------------------------------------------------------------------------

export function addTranscriptSegment(meetingId: string, segment: TranscriptSegment): void {
  const session = activeSessions.get(meetingId);
  if (!session) return;

  session.transcriptBuffer.push(segment);

  // Maintain sliding window
  if (session.transcriptBuffer.length > MAX_TRANSCRIPT_BUFFER) {
    session.transcriptBuffer = session.transcriptBuffer.slice(-MAX_TRANSCRIPT_BUFFER);
  }

  // Track participants
  if (segment.speaker && !session.participants.includes(segment.speaker)) {
    session.participants.push(segment.speaker);
  }
}

export function getRecentTranscript(meetingId: string, lineCount?: number): TranscriptSegment[] {
  const session = activeSessions.get(meetingId);
  if (!session) return [];
  const count = lineCount ?? 20;
  return session.transcriptBuffer.slice(-count);
}

export function getTranscriptAsText(meetingId: string, lineCount?: number): string {
  const segments = getRecentTranscript(meetingId, lineCount);
  return segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// Action item tracking
// ---------------------------------------------------------------------------

export function addActionItem(meetingId: string, item: ActionItem): void {
  const session = activeSessions.get(meetingId);
  if (!session) return;
  session.actionItems.push(item);
}

export function getActionItems(meetingId: string): ActionItem[] {
  const session = activeSessions.get(meetingId);
  return session?.actionItems ?? [];
}

// ---------------------------------------------------------------------------
// Topic tracking
// ---------------------------------------------------------------------------

export function addTopic(meetingId: string, topic: string): void {
  const session = activeSessions.get(meetingId);
  if (!session) return;
  if (!session.detectedTopics.includes(topic)) {
    session.detectedTopics.push(topic);
  }
}

// ---------------------------------------------------------------------------
// Meeting summary generation (for post-meeting or in-meeting queries)
// ---------------------------------------------------------------------------

export function getMeetingSummary(meetingId: string): {
  meetingId: string;
  duration: string;
  participantCount: number;
  participants: string[];
  transcriptLineCount: number;
  topics: string[];
  actionItems: ActionItem[];
  cassidyResponses: number;
  recentContext: string;
} | null {
  const session = activeSessions.get(meetingId);
  if (!session) return null;

  const startTime = new Date(session.startTime);
  const now = new Date();
  const durationMinutes = Math.floor((now.getTime() - startTime.getTime()) / (1000 * 60));
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;

  return {
    meetingId,
    duration: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
    participantCount: session.participants.length,
    participants: session.participants,
    transcriptLineCount: session.transcriptBuffer.length,
    topics: session.detectedTopics,
    actionItems: session.actionItems,
    cassidyResponses: session.cassidyResponseCount,
    recentContext: getTranscriptAsText(meetingId, 10),
  };
}

// ---------------------------------------------------------------------------
// Cassidy response tracking
// ---------------------------------------------------------------------------

export function recordCassidyResponse(meetingId: string): void {
  const session = activeSessions.get(meetingId);
  if (session) session.cassidyResponseCount++;
}

// ---------------------------------------------------------------------------
// Persistence (Table Storage backup for post-meeting analysis)
// ---------------------------------------------------------------------------

async function persistSession(session: MeetingSession): Promise<void> {
  const rowKey = session.meetingId.replace(/[/\\#?]/g, '_').slice(0, 200);
  await upsertEntity(TABLE, {
    partitionKey: PARTITION,
    rowKey,
    meetingId: session.meetingId,
    organizerName: session.organizerName ?? '',
    participants: JSON.stringify(session.participants),
    startTime: session.startTime,
    endTime: new Date().toISOString(),
    topics: JSON.stringify(session.detectedTopics),
    actionItems: JSON.stringify(session.actionItems),
    cassidyResponseCount: session.cassidyResponseCount,
    transcriptLineCount: session.transcriptBuffer.length,
    // Don't persist full transcript (could be large/sensitive)
  });
}

export async function getPersistedSession(meetingId: string): Promise<Record<string, unknown> | null> {
  const rowKey = meetingId.replace(/[/\\#?]/g, '_').slice(0, 200);
  return getEntity<Record<string, unknown> & { partitionKey: string; rowKey: string }>(TABLE, PARTITION, rowKey);
}
