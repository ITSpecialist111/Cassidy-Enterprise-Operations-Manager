import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStore = new Map<string, Record<string, unknown>>();

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                communicationStyle: 'action-oriented',
                recommendations: ['Be more concise'],
                riskFactors: [],
              }),
            },
          }],
        })),
      },
    },
  })),
}));

vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
    mockStore.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
  }),
  getEntity: vi.fn(async (_t: string, _pk: string, rk: string) => {
    return mockStore.get(`insights:${rk}`) ?? null;
  }),
  listEntities: vi.fn(async () => Array.from(mockStore.values())),
}));

import {
  recordInteraction,
  analyseUserProfile,
  getUserInsight,
  getAllInsights,
  type InteractionSummary,
} from './userProfiler';
import { upsertEntity } from '../memory/tableStorage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInteraction(overrides: Partial<InteractionSummary> = {}): InteractionSummary {
  return {
    timestamp: new Date().toISOString(),
    topic: 'operations',
    toolsUsed: ['getOverdueTasks'],
    sentiment: 'positive',
    responseLength: 'brief',
    dayOfWeek: 1,
    hourOfDay: 9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('userProfiler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
  });

  describe('recordInteraction', () => {
    it('stores an interaction and updates insight', async () => {
      await recordInteraction('user-1', 'Alice', makeInteraction());

      expect(upsertEntity).toHaveBeenCalledWith(
        'CassidyUserInsights',
        expect.objectContaining({
          rowKey: 'user-1',
          displayName: 'Alice',
        }),
      );
    });

    it('appends to existing interaction log', async () => {
      // First interaction
      await recordInteraction('user-1', 'Alice', makeInteraction({ topic: 'budgets' }));
      // Second interaction
      await recordInteraction('user-1', 'Alice', makeInteraction({ topic: 'tasks' }));

      // The second call should have received the existing insight
      const calls = (upsertEntity as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('computes peak hours from interactions', async () => {
      await recordInteraction('user-1', 'Alice', makeInteraction({ hourOfDay: 9 }));
      await recordInteraction('user-1', 'Alice', makeInteraction({ hourOfDay: 9 }));
      await recordInteraction('user-1', 'Alice', makeInteraction({ hourOfDay: 14 }));

      const insight = mockStore.get('insights:user-1');
      expect(insight).toBeTruthy();
      const peakHours = JSON.parse(insight!.peakHours as string);
      expect(peakHours).toContain(9);
    });

    it('computes sentiment trend', async () => {
      // Record mostly negative interactions
      for (let i = 0; i < 10; i++) {
        await recordInteraction('user-1', 'Alice', makeInteraction({ sentiment: 'negative' }));
      }

      const insight = mockStore.get('insights:user-1');
      expect(insight!.sentimentTrend).toBe('declining');
    });

    it('computes common topics', async () => {
      for (let i = 0; i < 5; i++) {
        await recordInteraction('user-1', 'Alice', makeInteraction({ topic: 'budgets' }));
      }
      await recordInteraction('user-1', 'Alice', makeInteraction({ topic: 'tasks' }));

      const insight = mockStore.get('insights:user-1');
      const topics = JSON.parse(insight!.commonTopics as string);
      expect(topics[0]).toBe('budgets');
    });

    it('limits rolling window to 100 interactions', async () => {
      for (let i = 0; i < 110; i++) {
        await recordInteraction('user-1', 'Alice', makeInteraction());
      }

      const insight = mockStore.get('insights:user-1');
      const log = JSON.parse(insight!.rawInteractionLog as string);
      expect(log.length).toBeLessThanOrEqual(100);
    });
  });

  describe('analyseUserProfile', () => {
    it('returns analysis result for user with enough data', async () => {
      // Seed insight with interactions
      const interactions = Array.from({ length: 10 }, () => makeInteraction());
      mockStore.set('insights:user-1', {
        partitionKey: 'insights',
        rowKey: 'user-1',
        displayName: 'Alice',
        communicationStyle: 'brief',
        peakHours: '[9,10]',
        commonTopics: '["operations"]',
        preferredTools: '[]',
        averageResponseTime: 5,
        interactionPatterns: '{}',
        sentimentTrend: 'neutral',
        lastAnalysed: '',
        rawInteractionLog: JSON.stringify(interactions),
      });

      const result = await analyseUserProfile('user-1');
      expect(result).toBeTruthy();
      expect(result!.communicationStyle).toBe('action-oriented');
      expect(Array.isArray(result!.recommendations)).toBe(true);
    });

    it('returns null for user with insufficient data', async () => {
      mockStore.set('insights:user-1', {
        partitionKey: 'insights',
        rowKey: 'user-1',
        displayName: 'Alice',
        rawInteractionLog: JSON.stringify([makeInteraction()]), // Only 1
      });

      const result = await analyseUserProfile('user-1');
      expect(result).toBeNull();
    });

    it('returns null for unknown user', async () => {
      const result = await analyseUserProfile('nobody');
      expect(result).toBeNull();
    });
  });

  describe('getUserInsight', () => {
    it('returns formatted insight data', async () => {
      mockStore.set('insights:user-1', {
        partitionKey: 'insights',
        rowKey: 'user-1',
        displayName: 'Alice',
        communicationStyle: 'detailed',
        peakHours: '[9,10,14]',
        commonTopics: '["operations","budgets"]',
        sentimentTrend: 'positive',
      });

      const insight = await getUserInsight('user-1');
      expect(insight).toBeTruthy();
      expect(insight!.communicationStyle).toBe('detailed');
      expect(insight!.peakHours).toContain(9);
      expect(insight!.commonTopics).toContain('operations');
    });

    it('returns null for unknown user', async () => {
      const insight = await getUserInsight('nobody');
      expect(insight).toBeNull();
    });
  });

  describe('getAllInsights', () => {
    it('returns all stored insights', async () => {
      mockStore.set('insights:u1', { partitionKey: 'insights', rowKey: 'u1' });
      mockStore.set('insights:u2', { partitionKey: 'insights', rowKey: 'u2' });

      const all = await getAllInsights();
      expect(all.length).toBe(2);
    });
  });
});
