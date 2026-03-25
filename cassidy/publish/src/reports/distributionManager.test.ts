import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tableStorage module before importing distributionManager
vi.mock('../memory/tableStorage', () => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    upsertEntity: vi.fn(async (_table: string, entity: Record<string, unknown>) => {
      store.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
    }),
    getEntity: vi.fn(async (_table: string, pk: string, rk: string) => {
      return store.get(`${pk}:${rk}`) ?? null;
    }),
    listEntities: vi.fn(async () => {
      return Array.from(store.values());
    }),
    deleteEntity: vi.fn(async (_table: string, pk: string, rk: string) => {
      store.delete(`${pk}:${rk}`);
    }),
    // Expose store for reset
    __store: store,
  };
});

import {
  createDistributionList,
  getDistributionList,
  updateDistributionList,
  removeDistributionList,
  listDistributionLists,
  addMemberToList,
  removeMemberFromList,
} from '../reports/distributionManager';

// Access the mock store for cleanup
import * as tableStorage from '../memory/tableStorage';
const store = (tableStorage as unknown as { __store: Map<string, Record<string, unknown>> }).__store;

describe('distributionManager', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  describe('createDistributionList', () => {
    it('creates a new list', async () => {
      const result = await createDistributionList('Leadership Team', ['alice@example.com', 'bob@example.com']);
      expect(result.success).toBe(true);
      expect(result.message).toContain('2 member(s)');
    });

    it('rejects duplicate list name', async () => {
      await createDistributionList('Leadership Team', ['alice@example.com']);
      const result = await createDistributionList('Leadership Team', ['bob@example.com']);
      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });
  });

  describe('getDistributionList', () => {
    it('returns members for existing list', async () => {
      await createDistributionList('Engineering', ['dev1@example.com', 'dev2@example.com']);
      const members = await getDistributionList('Engineering');
      expect(members).toEqual(['dev1@example.com', 'dev2@example.com']);
    });

    it('returns null for non-existent list', async () => {
      const members = await getDistributionList('Non-Existent');
      expect(members).toBeNull();
    });

    it('returns null for corrupted JSON members', async () => {
      // Manually insert a corrupted entry
      store.set('lists:corrupted_list', {
        partitionKey: 'lists',
        rowKey: 'corrupted_list',
        name: 'Corrupted List',
        members: '{not valid json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: 'test',
      });
      const members = await getDistributionList('Corrupted List');
      expect(members).toBeNull();
    });
  });

  describe('updateDistributionList', () => {
    it('updates an existing list', async () => {
      await createDistributionList('Team', ['a@example.com']);
      const result = await updateDistributionList('Team', ['a@example.com', 'b@example.com']);
      expect(result.success).toBe(true);
      const members = await getDistributionList('Team');
      expect(members).toEqual(['a@example.com', 'b@example.com']);
    });

    it('fails for non-existent list', async () => {
      const result = await updateDistributionList('No Such List', ['a@example.com']);
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('removeDistributionList', () => {
    it('deletes a list', async () => {
      await createDistributionList('Temp', ['a@example.com']);
      const result = await removeDistributionList('Temp');
      expect(result.success).toBe(true);
      const members = await getDistributionList('Temp');
      expect(members).toBeNull();
    });
  });

  describe('listDistributionLists', () => {
    it('lists all distribution lists', async () => {
      await createDistributionList('Team A', ['a@example.com']);
      await createDistributionList('Team B', ['b1@example.com', 'b2@example.com']);
      const lists = await listDistributionLists();
      expect(lists.length).toBe(2);
      const teamB = lists.find(l => l.name === 'Team B');
      expect(teamB).toBeDefined();
      expect(teamB!.memberCount).toBe(2);
    });

    it('handles corrupted JSON members gracefully', async () => {
      store.set('lists:bad', {
        partitionKey: 'lists',
        rowKey: 'bad',
        name: 'Bad List',
        members: 'not-json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: 'test',
      });
      const lists = await listDistributionLists();
      const bad = lists.find(l => l.name === 'Bad List');
      expect(bad).toBeDefined();
      expect(bad!.members).toEqual([]);
      expect(bad!.memberCount).toBe(0);
    });
  });

  describe('addMemberToList', () => {
    it('adds a member to a list', async () => {
      await createDistributionList('Team', ['a@example.com']);
      const result = await addMemberToList('Team', 'b@example.com');
      expect(result.success).toBe(true);
      const members = await getDistributionList('Team');
      expect(members).toContain('b@example.com');
    });

    it('does not duplicate existing member', async () => {
      await createDistributionList('Team', ['a@example.com']);
      const result = await addMemberToList('Team', 'a@example.com');
      expect(result.success).toBe(true);
      expect(result.message).toContain('already in');
    });

    it('fails for non-existent list', async () => {
      const result = await addMemberToList('Ghost', 'a@example.com');
      expect(result.success).toBe(false);
    });
  });

  describe('removeMemberFromList', () => {
    it('removes a member from a list', async () => {
      await createDistributionList('Team', ['a@example.com', 'b@example.com']);
      const result = await removeMemberFromList('Team', 'a@example.com');
      expect(result.success).toBe(true);
      const members = await getDistributionList('Team');
      expect(members).toEqual(['b@example.com']);
    });

    it('is case-insensitive', async () => {
      await createDistributionList('Team', ['Alice@Example.COM']);
      const result = await removeMemberFromList('Team', 'alice@example.com');
      expect(result.success).toBe(true);
      const members = await getDistributionList('Team');
      expect(members).toEqual([]);
    });

    it('handles removing non-existent member gracefully', async () => {
      await createDistributionList('Team', ['a@example.com']);
      const result = await removeMemberFromList('Team', 'zzz@example.com');
      expect(result.success).toBe(true);
      expect(result.message).toContain('was not in');
    });

    it('fails for non-existent list', async () => {
      const result = await removeMemberFromList('Ghost', 'a@example.com');
      expect(result.success).toBe(false);
    });
  });
});
