import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockCreate = vi.fn(async () => ({
  choices: [{ message: { content: 'Hey Alice, you have 3 overdue tasks. Want me to chase them?' } }],
}));

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

vi.mock('./userRegistry', () => ({
  getAllActiveUsers: vi.fn(async () => [
    {
      partitionKey: 'users',
      rowKey: 'user-1',
      displayName: 'Alice Smith',
      conversationRef: JSON.stringify({ conversation: { id: 'conv-1' } }),
      notificationPrefs: JSON.stringify({ quietStart: 22, quietEnd: 7, channels: ['teams_chat'] }),
      timezone: 'Australia/Sydney',
    },
    {
      partitionKey: 'users',
      rowKey: 'user-2',
      displayName: 'Bob Jones',
      conversationRef: JSON.stringify({ conversation: { id: 'conv-2' } }),
      notificationPrefs: JSON.stringify({}),
      timezone: 'UTC',
    },
  ]),
  getConversationRefFromProfile: vi.fn((user: any) => {
    try { return JSON.parse(user.conversationRef); } catch { return null; }
  }),
  getNotificationPrefsFromProfile: vi.fn(() => ({
    quietStart: 22,
    quietEnd: 7,
    channels: ['teams_chat'],
  })),
  isInQuietHours: vi.fn(() => false),
}));

vi.mock('./eventTriggers', () => ({
  getAllTriggers: vi.fn(() => [
    {
      id: 'overdue_tasks',
      name: 'Overdue Tasks',
      cooldownMinutes: 60,
      lastFired: null,
      evaluate: vi.fn(async (users: any[]) => users.map((u: any) => ({
        targetUserId: u.rowKey,
        triggerName: 'overdue_tasks',
        urgency: 'medium' as const,
        channel: 'teams_chat' as const,
        reason: '3 tasks overdue',
        context: { overdueCount: 3 },
      }))),
    },
    {
      id: 'morning_brief',
      name: 'Morning Briefing',
      cooldownMinutes: 720,
      lastFired: null,
      evaluate: vi.fn(async () => []),
    },
  ]),
}));

vi.mock('../voice/callManager', () => ({
  initiateCall: vi.fn(async () => ({ success: true, callId: 'call-1' })),
  getCallByUserId: vi.fn(() => null),
}));

vi.mock('../voice/voiceAgent', () => ({
  shouldEscalateToVoice: vi.fn(() => false),
}));

import { evaluateAllTriggers, composeProactiveMessage } from './proactiveEngine';

describe('proactiveEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('evaluateAllTriggers', () => {
    it('returns outreach actions from active triggers', async () => {
      const actions = await evaluateAllTriggers();
      // overdue_tasks returns 2 actions (one per user), morning_brief returns 0
      expect(actions.length).toBe(2);
      expect(actions[0].triggerName).toBe('overdue_tasks');
      expect(actions[0].urgency).toBe('medium');
    });

    it('includes context data in actions', async () => {
      const actions = await evaluateAllTriggers();
      expect(actions[0].context.overdueCount).toBe(3);
    });
  });

  describe('composeProactiveMessage', () => {
    it('generates a natural language message', async () => {
      const user = {
        partitionKey: 'users',
        rowKey: 'user-1',
        displayName: 'Alice Smith',
        email: 'alice@example.com',
        conversationRef: '{}',
        notificationPrefs: '{}',
        timezone: 'UTC',
        preferredChannel: 'teams_chat' as const,
        lastInteraction: new Date().toISOString(),
        firstInteraction: new Date().toISOString(),
        interactionCount: 5,
      };
      const action = {
        targetUserId: 'user-1',
        triggerName: 'overdue_tasks',
        urgency: 'medium' as const,
        channel: 'teams_chat' as const,
        reason: '3 tasks overdue',
        context: { overdueCount: 3 },
      };

      const message = await composeProactiveMessage(action, user);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    });
  });
});
