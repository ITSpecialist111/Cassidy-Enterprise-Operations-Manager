import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: JSON.stringify({ predictions: [] }) } }],
        })),
      },
    },
  })),
}));

const mockStore = new Map<string, Record<string, unknown>>();

vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
    mockStore.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
  }),
  getEntity: vi.fn(async (_t: string, _pk: string, rk: string) => {
    return mockStore.get(`predictions:${rk}`) ?? null;
  }),
  listEntities: vi.fn(async () => Array.from(mockStore.values())),
  deleteEntity: vi.fn(async () => {}),
}));

vi.mock('../tools/operationsTools', () => ({
  getOverdueTasks: vi.fn(async () => ({
    total: 3,
    criticalCount: 1,
    overdueCount: 2,
    atRiskCount: 1,
    source: 'demo',
    tasks: [
      { id: '1', title: 'Task A', owner: 'Alice', daysOverdue: 5, project: 'Proj-1', priority: 'high' },
      { id: '2', title: 'Task B', owner: 'Bob', daysOverdue: 2, project: 'Proj-2', priority: 'medium' },
      { id: '3', title: 'Task C', owner: 'Alice', daysOverdue: 1, project: 'Proj-1', priority: 'low' },
    ],
  })),
  getTeamWorkload: vi.fn(async () => ({
    source: 'demo',
    total_members: 3,
    members: [
      { name: 'Alice', activeTasks: 8, completedThisWeek: 3, capacity: 'overloaded' },
      { name: 'Bob', activeTasks: 4, completedThisWeek: 5, capacity: 'normal' },
      { name: 'Carol', activeTasks: 2, completedThisWeek: 2, capacity: 'available' },
    ],
  })),
  getPendingApprovals: vi.fn(async () => ({
    total: 2,
    overdueCount: 1,
    highUrgencyCount: 1,
    source: 'demo',
    approvals: [],
  })),
}));

import {
  runPredictionCycle,
  getActivePredictions,
  acknowledgePrediction,
  resolvePrediction,
  getOperationalRiskScore,
} from './predictiveEngine';
import { upsertEntity } from '../memory/tableStorage';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('predictiveEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
  });

  describe('runPredictionCycle', () => {
    it('returns an array', async () => {
      const result = await runPredictionCycle();
      expect(Array.isArray(result)).toBe(true);
    });

    it('calls operationsTools to gather state', async () => {
      const { getOverdueTasks } = await import('../tools/operationsTools');
      const { getTeamWorkload } = await import('../tools/operationsTools');
      const { getPendingApprovals } = await import('../tools/operationsTools');

      await runPredictionCycle();

      expect(getOverdueTasks).toHaveBeenCalled();
      expect(getTeamWorkload).toHaveBeenCalled();
      expect(getPendingApprovals).toHaveBeenCalled();
    });

    it('stores predictions when GPT-5 returns them', async () => {
      const { getSharedOpenAI } = await import('../auth');
      (getSharedOpenAI as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    predictions: [{
                      type: 'task_delay',
                      severity: 'warning',
                      title: 'Project Alpha at risk',
                      description: 'Task backlog growing',
                      affectedUsers: ['alice'],
                      affectedProjects: ['Proj-1'],
                      confidence: 72,
                      predictedDate: '2025-07-10',
                      recommendation: 'Redistribute tasks',
                    }],
                  }),
                },
              }],
            })),
          },
        },
      });

      const predictions = await runPredictionCycle();
      expect(predictions.length).toBe(1);
      expect(predictions[0].type).toBe('task_delay');
      expect(predictions[0].severity).toBe('warning');
      expect(predictions[0].status).toBe('active');
      expect(upsertEntity).toHaveBeenCalled();
    });

    it('handles GPT-5 errors gracefully', async () => {
      const { getSharedOpenAI } = await import('../auth');
      (getSharedOpenAI as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        chat: {
          completions: {
            create: vi.fn(async () => { throw new Error('API error'); }),
          },
        },
      });

      const result = await runPredictionCycle();
      // Should not throw — returns empty array
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getActivePredictions', () => {
    it('returns only active predictions', async () => {
      mockStore.set('predictions:p1', {
        partitionKey: 'predictions',
        rowKey: 'p1',
        status: 'active',
        type: 'task_delay',
        severity: 'warning',
        title: 'Test',
        description: '',
        createdAt: new Date().toISOString(),
      });
      mockStore.set('predictions:p2', {
        partitionKey: 'predictions',
        rowKey: 'p2',
        status: 'acknowledged',
        type: 'capacity_crunch',
        severity: 'info',
        title: 'Old',
        description: '',
        createdAt: new Date().toISOString(),
      });

      const active = await getActivePredictions();
      expect(active.length).toBe(1);
      expect(active[0].rowKey).toBe('p1');
    });

    it('returns empty array when no predictions exist', async () => {
      const active = await getActivePredictions();
      expect(active).toEqual([]);
    });
  });

  describe('acknowledgePrediction', () => {
    it('updates status to acknowledged', async () => {
      mockStore.set('predictions:p1', {
        partitionKey: 'predictions',
        rowKey: 'p1',
        status: 'active',
        type: 'task_delay',
        severity: 'warning',
        title: 'Test',
      });

      const result = await acknowledgePrediction('p1');
      expect(result.success).toBe(true);
      expect(upsertEntity).toHaveBeenCalledWith('CassidyPredictions', expect.objectContaining({ status: 'acknowledged' }));
    });

    it('returns failure for non-existent prediction', async () => {
      const result = await acknowledgePrediction('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('resolvePrediction', () => {
    it('updates status to resolved with timestamp', async () => {
      mockStore.set('predictions:p1', {
        partitionKey: 'predictions',
        rowKey: 'p1',
        status: 'active',
        type: 'task_delay',
        severity: 'warning',
        title: 'Test',
      });

      const result = await resolvePrediction('p1');
      expect(result.success).toBe(true);
      expect(upsertEntity).toHaveBeenCalledWith(
        'CassidyPredictions',
        expect.objectContaining({ status: 'resolved', resolvedAt: expect.any(String) }),
      );
    });

    it('returns failure for non-existent prediction', async () => {
      const result = await resolvePrediction('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('getOperationalRiskScore', () => {
    it('returns score, level, and factors', async () => {
      const result = await getOperationalRiskScore();
      expect(typeof result.score).toBe('number');
      expect(['green', 'yellow', 'orange', 'red']).toContain(result.level);
      expect(Array.isArray(result.factors)).toBe(true);
    });

    it('includes overloaded team member factor', async () => {
      // Default mocks have Alice as "overloaded"
      const result = await getOperationalRiskScore();
      expect(result.factors).toContain('Team members at capacity');
    });

    it('score is between 0 and 100', async () => {
      const result = await getOperationalRiskScore();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });
});
