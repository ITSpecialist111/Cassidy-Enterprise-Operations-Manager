import { describe, it, expect, beforeEach } from 'vitest';
import {
  startMeetingSession,
  endMeetingSession,
  getMeetingSession,
  addTranscriptSegment,
  getRecentTranscript,
  getTranscriptAsText,
  addActionItem,
  getActionItems,
  addTopic,
  recordCassidyResponse,
  getMeetingSummary,
  getActiveMeetings,
} from '../meetings/meetingContext';

// We need to clear the sessions between tests.
// endMeetingSession removes and persists — but persistSession calls tableStorage.
// We'll mock tableStorage to avoid actual Azure calls.
import { vi } from 'vitest';
vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn().mockResolvedValue(undefined),
  getEntity: vi.fn().mockResolvedValue(null),
}));

describe('meetingContext', () => {
  const meetingId = 'test-meeting-001';

  beforeEach(() => {
    // Clean up any existing session
    endMeetingSession(meetingId);
  });

  describe('session lifecycle', () => {
    it('starts a new session', () => {
      const session = startMeetingSession({
        meetingId,
        organizerName: 'Graham',
        organizerEmail: 'graham@example.com',
        chatId: 'chat-123',
      });
      expect(session.meetingId).toBe(meetingId);
      expect(session.organizerName).toBe('Graham');
      expect(session.isActive).toBe(true);
      expect(session.transcriptBuffer).toEqual([]);
      expect(session.actionItems).toEqual([]);
    });

    it('retrieves an active session', () => {
      startMeetingSession({ meetingId });
      const session = getMeetingSession(meetingId);
      expect(session).not.toBeNull();
      expect(session!.meetingId).toBe(meetingId);
    });

    it('returns null for non-existent session', () => {
      expect(getMeetingSession('non-existent')).toBeNull();
    });

    it('ends a session and removes it from active map', () => {
      startMeetingSession({ meetingId });
      const ended = endMeetingSession(meetingId);
      expect(ended).not.toBeNull();
      expect(ended!.isActive).toBe(false);
      expect(getMeetingSession(meetingId)).toBeNull();
    });

    it('returns null when ending non-existent session', () => {
      expect(endMeetingSession('non-existent')).toBeNull();
    });

    it('lists active meetings', () => {
      startMeetingSession({ meetingId: 'meeting-a' });
      startMeetingSession({ meetingId: 'meeting-b' });
      const active = getActiveMeetings();
      expect(active.length).toBeGreaterThanOrEqual(2);
      // clean up
      endMeetingSession('meeting-a');
      endMeetingSession('meeting-b');
    });
  });

  describe('transcript management', () => {
    beforeEach(() => {
      startMeetingSession({ meetingId });
    });

    it('adds transcript segments', () => {
      addTranscriptSegment(meetingId, {
        speaker: 'Graham',
        text: 'Let\'s discuss the budget',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      const segments = getRecentTranscript(meetingId);
      expect(segments).toHaveLength(1);
      expect(segments[0].speaker).toBe('Graham');
    });

    it('respects sliding window (MAX_TRANSCRIPT_BUFFER)', () => {
      // Default is 50 segments — add 55
      for (let i = 0; i < 55; i++) {
        addTranscriptSegment(meetingId, {
          speaker: `Speaker${i}`,
          text: `Message ${i}`,
          timestamp: new Date().toISOString(),
          sequenceNumber: i,
        });
      }
      const segments = getRecentTranscript(meetingId, 100);
      expect(segments.length).toBeLessThanOrEqual(50);
      // First segment should be #5 (0-4 were evicted)
      expect(segments[0].text).toBe('Message 5');
    });

    it('tracks participants from transcript', () => {
      addTranscriptSegment(meetingId, {
        speaker: 'Alice',
        text: 'Hello everyone',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      addTranscriptSegment(meetingId, {
        speaker: 'Bob',
        text: 'Hi Alice',
        timestamp: new Date().toISOString(),
        sequenceNumber: 2,
      });
      const session = getMeetingSession(meetingId);
      expect(session!.participants).toContain('Alice');
      expect(session!.participants).toContain('Bob');
    });

    it('does not duplicate participants', () => {
      addTranscriptSegment(meetingId, {
        speaker: 'Alice',
        text: 'First message',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      addTranscriptSegment(meetingId, {
        speaker: 'Alice',
        text: 'Second message',
        timestamp: new Date().toISOString(),
        sequenceNumber: 2,
      });
      const session = getMeetingSession(meetingId);
      expect(session!.participants.filter(p => p === 'Alice')).toHaveLength(1);
    });

    it('formats transcript as text', () => {
      addTranscriptSegment(meetingId, {
        speaker: 'Graham',
        text: 'How are we on the budget?',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      addTranscriptSegment(meetingId, {
        speaker: 'Alice',
        text: 'We are on track',
        timestamp: new Date().toISOString(),
        sequenceNumber: 2,
      });
      const text = getTranscriptAsText(meetingId, 10);
      expect(text).toContain('Graham: How are we on the budget?');
      expect(text).toContain('Alice: We are on track');
    });

    it('getRecentTranscript limits to lineCount', () => {
      for (let i = 0; i < 10; i++) {
        addTranscriptSegment(meetingId, {
          speaker: 'Speaker',
          text: `Message ${i}`,
          timestamp: new Date().toISOString(),
          sequenceNumber: i,
        });
      }
      const segments = getRecentTranscript(meetingId, 3);
      expect(segments).toHaveLength(3);
      expect(segments[0].text).toBe('Message 7');
    });

    it('ignores segments for non-existent session', () => {
      addTranscriptSegment('no-such-meeting', {
        speaker: 'Nobody',
        text: 'Nothing',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      expect(getRecentTranscript('no-such-meeting')).toEqual([]);
    });
  });

  describe('action items', () => {
    beforeEach(() => {
      startMeetingSession({ meetingId });
    });

    it('adds and retrieves action items', () => {
      addActionItem(meetingId, {
        description: 'Follow up on budget proposal',
        source: 'Graham',
        detectedAt: new Date().toISOString(),
      });
      const items = getActionItems(meetingId);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Follow up on budget proposal');
    });

    it('returns empty array for non-existent session', () => {
      expect(getActionItems('nonexistent')).toEqual([]);
    });
  });

  describe('topics', () => {
    beforeEach(() => {
      startMeetingSession({ meetingId });
    });

    it('adds topics', () => {
      addTopic(meetingId, 'Budget Review');
      const session = getMeetingSession(meetingId);
      expect(session!.detectedTopics).toContain('Budget Review');
    });

    it('deduplicates topics', () => {
      addTopic(meetingId, 'Budget Review');
      addTopic(meetingId, 'Budget Review');
      const session = getMeetingSession(meetingId);
      expect(session!.detectedTopics.filter(t => t === 'Budget Review')).toHaveLength(1);
    });
  });

  describe('cassidy response tracking', () => {
    it('increments response count', () => {
      startMeetingSession({ meetingId });
      recordCassidyResponse(meetingId);
      recordCassidyResponse(meetingId);
      const session = getMeetingSession(meetingId);
      expect(session!.cassidyResponseCount).toBe(2);
    });
  });

  describe('meeting summary', () => {
    it('returns null for non-existent session', () => {
      expect(getMeetingSummary('nonexistent')).toBeNull();
    });

    it('generates a summary with correct fields', () => {
      startMeetingSession({ meetingId });
      addTranscriptSegment(meetingId, {
        speaker: 'Graham',
        text: 'Test message',
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      });
      addTopic(meetingId, 'Testing');
      addActionItem(meetingId, {
        description: 'Write tests',
        source: 'Graham',
        detectedAt: new Date().toISOString(),
      });
      recordCassidyResponse(meetingId);

      const summary = getMeetingSummary(meetingId);
      expect(summary).not.toBeNull();
      expect(summary!.meetingId).toBe(meetingId);
      expect(summary!.participantCount).toBeGreaterThanOrEqual(1);
      expect(summary!.transcriptLineCount).toBe(1);
      expect(summary!.topics).toContain('Testing');
      expect(summary!.actionItems).toHaveLength(1);
      expect(summary!.cassidyResponses).toBe(1);
      expect(summary!.duration).toMatch(/\d+m/);
    });
  });
});
