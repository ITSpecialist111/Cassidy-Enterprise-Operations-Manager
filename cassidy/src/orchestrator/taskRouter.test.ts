import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                agentId: 'finance-bot',
                confidence: 85,
                reason: 'Finance topic detected',
              }),
            },
          }],
        })),
      },
    },
  })),
}));

vi.mock('./agentRegistry', () => ({
  listAgents: vi.fn(async () => [
    {
      partitionKey: 'agents',
      rowKey: 'finance-bot',
      displayName: 'Finance Bot',
      description: 'Financial data and budgets',
      expertise: JSON.stringify(['finance', 'budget', 'costs']),
      endpoint: 'https://fin.test/api/agent-messages',
      appId: 'app-1',
      status: 'online',
      successRate: 95,
      totalInvocations: 10,
      averageResponseMs: 200,
      lastHealthCheck: new Date().toISOString(),
    },
    {
      partitionKey: 'agents',
      rowKey: 'hr-bot',
      displayName: 'HR Bot',
      description: 'People data and leave management',
      expertise: JSON.stringify(['hr', 'people', 'leave']),
      endpoint: 'https://hr.test/api/agent-messages',
      appId: 'app-2',
      status: 'online',
      successRate: 90,
      totalInvocations: 5,
      averageResponseMs: 300,
      lastHealthCheck: new Date().toISOString(),
    },
  ]),
  findAgentByExpertise: vi.fn(async (area: string) => {
    if (area === 'budget' || area === 'finance')
      return { rowKey: 'finance-bot', displayName: 'Finance Bot', status: 'online', successRate: 95 };
    if (area === 'hr' || area === 'people' || area === 'leave')
      return { rowKey: 'hr-bot', displayName: 'HR Bot', status: 'online', successRate: 90 };
    return null;
  }),
  invokeAgent: vi.fn(async (agentId: string) => ({
    success: true,
    agentId,
    agentName: agentId === 'finance-bot' ? 'Finance Bot' : 'HR Bot',
    response: 'Agent response here',
    durationMs: 150,
  })),
}));

import { askAgent, routeToMultipleAgents } from './taskRouter';
import { invokeAgent, findAgentByExpertise } from './agentRegistry';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('taskRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('askAgent', () => {
    it('routes directly when agentId is provided', async () => {
      const result = await askAgent('What is the budget?', 'finance-bot');
      expect(invokeAgent).toHaveBeenCalledWith('finance-bot', 'What is the budget?');
      expect(result.success).toBe(true);
    });

    it('auto-routes by expertise when no agentId', async () => {
      const result = await askAgent('What is the current budget status?');
      expect(result.success).toBe(true);
    });

    it('returns error when no suitable agent found', async () => {
      (findAgentByExpertise as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Use a query with no matching keywords to force GPT-5 path
      const { getSharedOpenAI } = await import('../auth');
      (getSharedOpenAI as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{
                message: { content: JSON.stringify({ agentId: null, confidence: 0, reason: 'no match' }) },
              }],
            })),
          },
        },
      });

      const result = await askAgent('random unrelated question about nothing');
      expect(result.success).toBe(false);
    });
  });

  describe('routeToMultipleAgents', () => {
    it('invokes specified target agents', async () => {
      const result = await routeToMultipleAgents('Q1 budget and headcount', ['finance-bot', 'hr-bot']);
      expect(result.results.length).toBe(2);
      expect(result.aggregatedResponse).toBeTruthy();
    });

    it('returns aggregated response from multiple agents', async () => {
      const result = await routeToMultipleAgents('test query', ['finance-bot']);
      expect(result.aggregatedResponse).toContain('Finance Bot');
    });

    it('handles agent failures gracefully', async () => {
      (invokeAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        agentId: 'finance-bot',
        agentName: 'Finance Bot',
        durationMs: 0,
        error: 'Connection refused',
      });

      const result = await routeToMultipleAgents('test', ['finance-bot']);
      // aggregated response mentions failure
      expect(result.aggregatedResponse).toMatch(/unavailable|could not provide|Connection refused/i);
    });
  });
});
