import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — replace @azure/data-tables with class-based constructors
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, Record<string, unknown>>();

vi.mock('@azure/data-tables', () => {
  class MT {
    private table: string;
    constructor(_endpoint: string, tableName: string) { this.table = tableName; }
    async upsertEntity(entity: Record<string, unknown>) {
      memoryStore.set(`${this.table}:${entity.partitionKey}:${entity.rowKey}`, entity);
    }
    async getEntity(pk: string, rk: string) {
      const entity = memoryStore.get(`${this.table}:${pk}:${rk}`);
      if (!entity) throw new Error('ResourceNotFound');
      return entity;
    }
    async deleteEntity() { /* no-op */ }
    *listEntities() {
      for (const [key, entity] of memoryStore.entries()) {
        if (key.startsWith(`${this.table}:`)) yield entity;
      }
    }
  }
  class MSC { async createTable() {} }
  return {
    TableClient: MT,
    TableServiceClient: MSC,
    odata: (strings: TemplateStringsArray, ...values: unknown[]) => {
      let r = '';
      strings.forEach((s, i) => { r += s; if (i < values.length) r += `'${values[i]}'`; });
      return r;
    },
  };
});

vi.mock('../auth', () => ({
  sharedCredential: {},
}));

import { upsertEntity, getEntity, listEntities, deleteEntity } from './tableStorage';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tableStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryStore.clear();
  });

  describe('upsertEntity', () => {
    it('stores an entity without throwing', async () => {
      await expect(
        upsertEntity('TestTable', { partitionKey: 'pk', rowKey: 'rk', value: 42 }),
      ).resolves.not.toThrow();
    });
  });

  describe('getEntity', () => {
    it('returns null for missing entity (ResourceNotFound)', async () => {
      const result = await getEntity('TestTable', 'pk', 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns an entity after upsert', async () => {
      await upsertEntity('TestTable', { partitionKey: 'pk', rowKey: 'rk1', name: 'Alice' });
      const result = await getEntity<{ partitionKey: string; rowKey: string; name: string }>('TestTable', 'pk', 'rk1');
      expect(result).toBeTruthy();
      expect(result!.name).toBe('Alice');
    });
  });

  describe('listEntities', () => {
    it('returns array of entities', async () => {
      await upsertEntity('ListTable', { partitionKey: 'pk', rowKey: 'a' });
      const result = await listEntities('ListTable', 'pk');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('deleteEntity', () => {
    it('does not throw for missing entity', async () => {
      await expect(deleteEntity('TestTable', 'pk', 'rk')).resolves.not.toThrow();
    });
  });
});
