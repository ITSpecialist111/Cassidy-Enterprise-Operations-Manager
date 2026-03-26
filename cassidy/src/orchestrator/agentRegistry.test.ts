import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStore = new Map<string, Record<string, unknown>>();

vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
    mockStore.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
  }),
  getEntity: vi.fn(async (_t: string, _pk: string, rk: string) => {
    return mockStore.get(`agents:${rk}`) ?? null;
  }),
  listEntities: vi.fn(async () => Array.from(mockStore.values())),
  deleteEntity: vi.fn(async (_t: string, _pk: string, rk: string) => {
    mockStore.delete(`agents:${rk}`);
  }),
}));

// Mock global fetch for health checks and A2A invocation
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  findAgentByExpertise,
  healthCheckAgent,
  healthCheckAllAgents,
  invokeAgent,
  seedDefaultAgents,
} from './agentRegistry';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
  });

  describe('registerAgent', () => {
    it('registers a new agent', async () => {
      const result = await registerAgent({
        id: 'finance-bot',
        displayName: 'Morgan — Finance',
        description: 'Financial data and analysis',
        expertise: ['finance', 'budget'],
        endpoint: 'https://agent.example.com/api/agent-messages',
        appId: 'app-123',
      });

      expect(result.success).toBe(true);
      expect(mockStore.has('agents:finance-bot')).toBe(true);
    });

    it('stores expertise as JSON', async () => {
      await registerAgent({
        id: 'test',
        displayName: 'Test',
        description: 'test',
        expertise: ['a', 'b'],
        endpoint: 'https://test',
        appId: '',
      });

      const saved = mockStore.get('agents:test');
      expect(JSON.parse(saved!.expertise as string)).toEqual(['a', 'b']);
    });
  });

  describe('unregisterAgent', () => {
    it('removes agent from store', async () => {
      mockStore.set('agents:test', { partitionKey: 'agents', rowKey: 'test' });
      const result = await unregisterAgent('test');
      expect(result.success).toBe(true);
    });
  });

  describe('getAgent', () => {
    it('retrieves registered agent', async () => {
      mockStore.set('agents:fin', {
        partitionKey: 'agents',
        rowKey: 'fin',
        displayName: 'Finance Bot',
        status: 'online',
      });

      const agent = await getAgent('fin');
      expect(agent).toBeTruthy();
      expect(agent!.displayName).toBe('Finance Bot');
    });

    it('returns null for unregistered agent', async () => {
      const agent = await getAgent('nope');
      expect(agent).toBeNull();
    });
  });

  describe('listAgents', () => {
    it('returns all registered agents', async () => {
      mockStore.set('agents:a', { partitionKey: 'agents', rowKey: 'a' });
      mockStore.set('agents:b', { partitionKey: 'agents', rowKey: 'b' });

      const agents = await listAgents();
      expect(agents.length).toBe(2);
    });
  });

  describe('findAgentByExpertise', () => {
    it('finds agent matching expertise area', async () => {
      mockStore.set('agents:fin', {
        partitionKey: 'agents',
        rowKey: 'fin',
        displayName: 'Finance Bot',
        description: 'Financial data',
        expertise: JSON.stringify(['finance', 'budget', 'costs']),
        status: 'online',
        successRate: 95,
      });
      mockStore.set('agents:hr', {
        partitionKey: 'agents',
        rowKey: 'hr',
        displayName: 'HR Bot',
        description: 'People data',
        expertise: JSON.stringify(['hr', 'people', 'leave']),
        status: 'online',
        successRate: 90,
      });

      const agent = await findAgentByExpertise('budget');
      expect(agent).toBeTruthy();
      expect(agent!.rowKey).toBe('fin');
    });

    it('skips offline agents', async () => {
      mockStore.set('agents:offline', {
        partitionKey: 'agents',
        rowKey: 'offline',
        displayName: 'Offline Bot',
        description: 'test',
        expertise: JSON.stringify(['finance']),
        status: 'offline',
        successRate: 100,
      });

      const agent = await findAgentByExpertise('finance');
      expect(agent).toBeNull();
    });

    it('returns null when no match', async () => {
      const agent = await findAgentByExpertise('quantum');
      expect(agent).toBeNull();
    });
  });

  describe('healthCheckAgent', () => {
    it('returns online for successful health check', async () => {
      mockStore.set('agents:test', {
        partitionKey: 'agents',
        rowKey: 'test',
        displayName: 'Test',
        endpoint: 'https://test.example.com/api/agent-messages',
        status: 'unknown',
        lastHealthCheck: '',
      });

      mockFetch.mockResolvedValueOnce({ ok: true });
      const status = await healthCheckAgent('test');
      expect(status).toBe('online');
    });

    it('returns offline when fetch fails', async () => {
      mockStore.set('agents:test', {
        partitionKey: 'agents',
        rowKey: 'test',
        displayName: 'Test',
        endpoint: 'https://test.example.com/api/agent-messages',
        status: 'online',
        lastHealthCheck: '',
      });

      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const status = await healthCheckAgent('test');
      expect(status).toBe('offline');
    });

    it('returns unknown for non-existent agent', async () => {
      const status = await healthCheckAgent('nope');
      expect(status).toBe('unknown');
    });
  });

  describe('healthCheckAllAgents', () => {
    it('checks all agents and returns results', async () => {
      mockStore.set('agents:a', {
        partitionKey: 'agents',
        rowKey: 'a',
        displayName: 'Agent A',
        endpoint: 'https://a.test/api/agent-messages',
        status: 'online',
        lastHealthCheck: '',
      });

      mockFetch.mockResolvedValueOnce({ ok: true });
      const results = await healthCheckAllAgents();
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('online');
    });
  });

  describe('invokeAgent', () => {
    it('sends query and returns response', async () => {
      mockStore.set('agents:fin', {
        partitionKey: 'agents',
        rowKey: 'fin',
        displayName: 'Finance Bot',
        endpoint: 'https://fin.test/api/agent-messages',
        appId: 'app-1',
        status: 'online',
        totalInvocations: 5,
        successRate: 80,
        averageResponseMs: 200,
        lastHealthCheck: '',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Budget is $50k' }),
      });

      const result = await invokeAgent('fin', 'What is the budget?');
      expect(result.success).toBe(true);
      expect(result.response).toContain('Budget');
      expect(result.agentName).toBe('Finance Bot');
    });

    it('returns error for unknown agent', async () => {
      const result = await invokeAgent('nope', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles API error responses', async () => {
      mockStore.set('agents:err', {
        partitionKey: 'agents',
        rowKey: 'err',
        displayName: 'Error Bot',
        endpoint: 'https://err.test/api/agent-messages',
        appId: '',
        status: 'online',
        totalInvocations: 0,
        successRate: 100,
        averageResponseMs: 0,
        lastHealthCheck: '',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await invokeAgent('err', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });

  describe('seedDefaultAgents', () => {
    it('seeds agents when registry is empty', async () => {
      await seedDefaultAgents();
      // Should have added the default agents (morgan-finance, hr-agent)
      expect(mockStore.size).toBeGreaterThan(0);
    });

    it('does not re-seed when agents already exist', async () => {
      mockStore.set('agents:existing', { partitionKey: 'agents', rowKey: 'existing' });
      await seedDefaultAgents();
      // Should still be just the one we put in
      expect(mockStore.size).toBe(1);
    });
  });
});
