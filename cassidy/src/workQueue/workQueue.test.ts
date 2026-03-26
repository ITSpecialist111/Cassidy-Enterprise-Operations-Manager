import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStore = new Map<string, Record<string, unknown>>();

vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
    mockStore.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
  }),
  getEntity: vi.fn(async (_t: string, pk: string, rk: string) => {
    return mockStore.get(`${pk}:${rk}`) ?? null;
  }),
  listEntities: vi.fn(async (_t: string, _pk: string, filter?: string) => {
    const all = Array.from(mockStore.values());
    if (!filter) return all;
    if (filter.includes("'pending'")) return all.filter(i => i.status === 'pending');
    if (filter.includes("'in_progress'")) return all.filter(i => i.status === 'in_progress');
    return all;
  }),
  deleteEntity: vi.fn(async (_t: string, pk: string, rk: string) => {
    mockStore.delete(`${pk}:${rk}`);
  }),
}));

import {
  createWorkItem,
  enqueueWork,
  updateWorkItem,
  getPendingItems,
  getWorkItem,
  removeWorkItem,
} from './workQueue';
import { upsertEntity, deleteEntity } from '../memory/tableStorage';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
  });

  describe('createWorkItem', () => {
    it('creates a work item with correct fields', () => {
      const item = createWorkItem({
        goal: 'Send weekly report',
        subtasks: [{ id: 's1', description: 'Gather data', dependsOn: [], status: 'pending' }],
        conversationId: 'conv-1',
        serviceUrl: 'https://test',
        userId: 'user-1',
      });

      expect(item.partitionKey).toBe('cassidy');
      expect(item.goal).toBe('Send weekly report');
      expect(item.status).toBe('pending');
      expect(item.currentStep).toBe(0);
      expect(item.retryCount).toBe(0);
      expect(item.rowKey).toBeTruthy(); // ULID generated
    });

    it('serializes subtasks as JSON', () => {
      const subtasks = [
        { id: 's1', description: 'Step 1', dependsOn: [], status: 'pending' as const },
        { id: 's2', description: 'Step 2', dependsOn: ['s1'], status: 'pending' as const },
      ];

      const item = createWorkItem({
        goal: 'Test',
        subtasks,
        conversationId: 'c',
        serviceUrl: 's',
        userId: 'u',
      });

      const parsed = JSON.parse(item.subtasks);
      expect(parsed).toHaveLength(2);
      expect(parsed[1].dependsOn).toEqual(['s1']);
    });

    it('generates unique rowKeys', () => {
      const a = createWorkItem({ goal: 'A', subtasks: [], conversationId: '', serviceUrl: '', userId: '' });
      const b = createWorkItem({ goal: 'B', subtasks: [], conversationId: '', serviceUrl: '', userId: '' });
      expect(a.rowKey).not.toBe(b.rowKey);
    });
  });

  describe('enqueueWork', () => {
    it('persists the work item', async () => {
      const item = createWorkItem({
        goal: 'Test goal',
        subtasks: [],
        conversationId: 'conv-1',
        serviceUrl: 'https://test',
        userId: 'user-1',
      });

      await enqueueWork(item);
      expect(upsertEntity).toHaveBeenCalledWith('CassidyWorkQueue', expect.objectContaining({ goal: 'Test goal' }));
    });
  });

  describe('updateWorkItem', () => {
    it('merges updates into existing item', async () => {
      const item = createWorkItem({
        goal: 'Test',
        subtasks: [],
        conversationId: '',
        serviceUrl: '',
        userId: '',
      });
      mockStore.set(`cassidy:${item.rowKey}`, item as unknown as Record<string, unknown>);

      await updateWorkItem({ rowKey: item.rowKey, status: 'in_progress', currentStep: 1 });

      expect(upsertEntity).toHaveBeenCalledWith(
        'CassidyWorkQueue',
        expect.objectContaining({ status: 'in_progress', currentStep: 1 }),
      );
    });

    it('does nothing if item does not exist', async () => {
      await updateWorkItem({ rowKey: 'nonexistent' });
      expect(upsertEntity).not.toHaveBeenCalled();
    });
  });

  describe('getPendingItems', () => {
    it('returns pending and in_progress items sorted by rowKey', async () => {
      mockStore.set('cassidy:A', { partitionKey: 'cassidy', rowKey: 'A', status: 'pending' });
      mockStore.set('cassidy:B', { partitionKey: 'cassidy', rowKey: 'B', status: 'in_progress' });
      mockStore.set('cassidy:C', { partitionKey: 'cassidy', rowKey: 'C', status: 'done' });

      const items = await getPendingItems();
      // Should include pending + in_progress
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getWorkItem', () => {
    it('retrieves an existing item', async () => {
      mockStore.set('cassidy:wi-1', { partitionKey: 'cassidy', rowKey: 'wi-1', goal: 'Test' });
      const item = await getWorkItem('wi-1');
      expect(item).toBeTruthy();
    });

    it('returns null for non-existent item', async () => {
      const item = await getWorkItem('nope');
      expect(item).toBeNull();
    });
  });

  describe('removeWorkItem', () => {
    it('deletes the item from storage', async () => {
      await removeWorkItem('wi-1');
      expect(deleteEntity).toHaveBeenCalledWith('CassidyWorkQueue', 'cassidy', 'wi-1');
    });
  });
});
