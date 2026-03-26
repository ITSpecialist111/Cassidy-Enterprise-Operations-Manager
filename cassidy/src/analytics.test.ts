// ---------------------------------------------------------------------------
// Tests — Conversation Analytics
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordConversationMetric,
  getAnalytics,
  getAllTimeToolUsage,
  resetAnalytics,
  type ConversationMetric,
} from './analytics';

function makeMetric(overrides: Partial<ConversationMetric> = {}): ConversationMetric {
  return {
    timestamp: Date.now(),
    userId: 'user1',
    conversationId: 'conv1',
    durationMs: 500,
    toolsUsed: ['get_planner_tasks'],
    tokensEstimate: 100,
    wasRateLimited: false,
    wasDegraded: false,
    ...overrides,
  };
}

describe('analytics', () => {
  beforeEach(() => {
    resetAnalytics();
  });

  it('records a metric and reflects it in analytics', () => {
    recordConversationMetric(makeMetric());
    const snap = getAnalytics();
    expect(snap.totalConversations).toBe(1);
    expect(snap.avgResponseMs).toBe(500);
  });

  it('calculates average response time', () => {
    recordConversationMetric(makeMetric({ durationMs: 200 }));
    recordConversationMetric(makeMetric({ durationMs: 400 }));
    recordConversationMetric(makeMetric({ durationMs: 600 }));
    const snap = getAnalytics();
    expect(snap.avgResponseMs).toBe(400);
  });

  it('calculates p95 response time', () => {
    for (let i = 1; i <= 20; i++) {
      recordConversationMetric(makeMetric({ durationMs: i * 100 }));
    }
    const snap = getAnalytics();
    expect(snap.p95ResponseMs).toBeGreaterThanOrEqual(1900);
  });

  it('tracks top tools', () => {
    recordConversationMetric(makeMetric({ toolsUsed: ['get_planner_tasks', 'get_calendar_events'] }));
    recordConversationMetric(makeMetric({ toolsUsed: ['get_planner_tasks'] }));
    const snap = getAnalytics();
    expect(snap.topTools[0].tool).toBe('get_planner_tasks');
    expect(snap.topTools[0].count).toBe(2);
  });

  it('tracks top users', () => {
    recordConversationMetric(makeMetric({ userId: 'alice' }));
    recordConversationMetric(makeMetric({ userId: 'alice' }));
    recordConversationMetric(makeMetric({ userId: 'bob' }));
    const snap = getAnalytics();
    expect(snap.topUsers[0].userId).toBe('alice');
    expect(snap.topUsers[0].count).toBe(2);
  });

  it('counts rate-limited conversations', () => {
    recordConversationMetric(makeMetric({ wasRateLimited: true }));
    recordConversationMetric(makeMetric({ wasRateLimited: false }));
    const snap = getAnalytics();
    expect(snap.rateLimitedCount).toBe(1);
  });

  it('counts degraded conversations', () => {
    recordConversationMetric(makeMetric({ wasDegraded: true }));
    const snap = getAnalytics();
    expect(snap.degradedCount).toBe(1);
  });

  it('filters by time window', () => {
    recordConversationMetric(makeMetric({ timestamp: Date.now() - 7_200_000 })); // 2 hours ago
    recordConversationMetric(makeMetric({ timestamp: Date.now() }));
    const snap = getAnalytics(3_600_000); // 1 hour window
    expect(snap.totalConversations).toBe(1);
  });

  it('getAllTimeToolUsage returns cumulative counts', () => {
    recordConversationMetric(makeMetric({ toolsUsed: ['toolA'] }));
    recordConversationMetric(makeMetric({ toolsUsed: ['toolA', 'toolB'] }));
    const usage = getAllTimeToolUsage();
    const toolA = usage.find(u => u.tool === 'toolA');
    expect(toolA?.count).toBe(2);
  });

  it('resetAnalytics clears all data', () => {
    recordConversationMetric(makeMetric());
    resetAnalytics();
    expect(getAnalytics().totalConversations).toBe(0);
    expect(getAllTimeToolUsage()).toHaveLength(0);
  });

  it('calculates conversationsPerHour', () => {
    for (let i = 0; i < 10; i++) {
      recordConversationMetric(makeMetric());
    }
    const snap = getAnalytics(3_600_000);
    expect(snap.conversationsPerHour).toBe(10);
  });

  it('caps stored metrics at MAX_METRICS', () => {
    for (let i = 0; i < 1050; i++) {
      recordConversationMetric(makeMetric({ conversationId: `conv${i}` }));
    }
    // All recent ones should appear in analytics (within window)
    const snap = getAnalytics(Number.MAX_SAFE_INTEGER);
    expect(snap.totalConversations).toBeLessThanOrEqual(1000);
  });
});
