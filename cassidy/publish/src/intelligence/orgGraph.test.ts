import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStore = new Map<string, Record<string, unknown>>();

vi.mock('../auth', () => ({
  getGraphToken: vi.fn(async () => 'mock-token'),
}));

vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
    mockStore.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
  }),
  getEntity: vi.fn(async (_t: string, _pk: string, rk: string) => {
    return mockStore.get(`org:${rk}`) ?? null;
  }),
  listEntities: vi.fn(async () => Array.from(mockStore.values())),
}));

import {
  getOrgNode,
  getManager,
  getDirectReports,
  getTeamInfo,
  getEscalationChain,
  findExpertise,
  getDepartmentSummary,
} from './orgGraph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNode(id: string, name: string, opts: Partial<Record<string, unknown>> = {}) {
  mockStore.set(`org:${id}`, {
    partitionKey: 'org',
    rowKey: id,
    displayName: name,
    email: `${id}@test.com`,
    jobTitle: opts.jobTitle ?? 'Staff',
    department: opts.department ?? 'Engineering',
    managerId: opts.managerId ?? '',
    managerName: opts.managerName ?? '',
    directReports: opts.directReports ?? '[]',
    teamMembers: opts.teamMembers ?? '[]',
    expertise: opts.expertise ?? '[]',
    lastRefreshed: new Date().toISOString(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orgGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.clear();
  });

  describe('getOrgNode', () => {
    it('returns a node by user ID', async () => {
      addNode('alice', 'Alice');
      const node = await getOrgNode('alice');
      expect(node).toBeTruthy();
      expect(node!.displayName).toBe('Alice');
    });

    it('returns null for unknown ID', async () => {
      const node = await getOrgNode('nobody');
      expect(node).toBeNull();
    });
  });

  describe('getManager', () => {
    it('returns the manager node', async () => {
      addNode('alice', 'Alice', { managerId: 'bob' });
      addNode('bob', 'Bob', { jobTitle: 'Director' });

      const mgr = await getManager('alice');
      expect(mgr).toBeTruthy();
      expect(mgr!.displayName).toBe('Bob');
    });

    it('returns null when no manager', async () => {
      addNode('alice', 'Alice');
      const mgr = await getManager('alice');
      expect(mgr).toBeNull();
    });
  });

  describe('getDirectReports', () => {
    it('returns parsed direct reports', async () => {
      addNode('bob', 'Bob', {
        directReports: JSON.stringify([
          { id: 'alice', name: 'Alice', title: 'Engineer' },
          { id: 'carol', name: 'Carol', title: 'Designer' },
        ]),
      });

      const reports = await getDirectReports('bob');
      expect(reports).toHaveLength(2);
      expect(reports[0].name).toBe('Alice');
    });

    it('returns empty for unknown user', async () => {
      const reports = await getDirectReports('nobody');
      expect(reports).toEqual([]);
    });

    it('handles malformed JSON gracefully', async () => {
      addNode('bob', 'Bob', { directReports: 'not-json' });
      const reports = await getDirectReports('bob');
      expect(reports).toEqual([]);
    });
  });

  describe('getTeamInfo', () => {
    it('returns team structure', async () => {
      addNode('mgr', 'Manager', { jobTitle: 'Director', directReports: '[]' });
      addNode('alice', 'Alice', { managerId: 'mgr', department: 'Eng' });
      addNode('bob', 'Bob', { managerId: 'mgr', department: 'Eng' });

      const team = await getTeamInfo('alice');
      expect(team).toBeTruthy();
      expect(team!.department).toBe('Eng');
      // Bob is a peer
      expect(team!.members.some(m => m.name === 'Bob')).toBe(true);
    });

    it('returns null for unknown user', async () => {
      const team = await getTeamInfo('nobody');
      expect(team).toBeNull();
    });
  });

  describe('getEscalationChain', () => {
    it('builds management chain up to maxDepth', async () => {
      addNode('a', 'Engineer', { managerId: 'b' });
      addNode('b', 'Lead', { managerId: 'c', jobTitle: 'Lead' });
      addNode('c', 'Director', { managerId: 'd', jobTitle: 'Director' });
      addNode('d', 'VP', { jobTitle: 'VP' });

      const chain = await getEscalationChain('a');
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(chain[0].name).toBe('Lead');
      expect(chain[1].name).toBe('Director');
      expect(chain[2].name).toBe('VP');
    });

    it('stops when no manager found', async () => {
      addNode('a', 'Engineer');
      const chain = await getEscalationChain('a');
      expect(chain).toEqual([]);
    });
  });

  describe('findExpertise', () => {
    it('finds users by expertise tags', async () => {
      addNode('alice', 'Alice', { expertise: JSON.stringify(['cloud architecture', 'devops']) });
      addNode('bob', 'Bob', { expertise: JSON.stringify(['finance', 'budgeting']) });

      const results = await findExpertise('cloud');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Alice');
    });

    it('matches on job title', async () => {
      addNode('carol', 'Carol', { jobTitle: 'Data Engineer', expertise: '[]' });
      const results = await findExpertise('data');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Carol');
    });

    it('returns empty when no matches', async () => {
      addNode('alice', 'Alice', { expertise: '[]' });
      const results = await findExpertise('quantum computing');
      expect(results).toEqual([]);
    });
  });

  describe('getDepartmentSummary', () => {
    it('groups users by department', async () => {
      addNode('a', 'A', { department: 'Engineering', directReports: '[{"id":"x"}]' });
      addNode('b', 'B', { department: 'Engineering', directReports: '[]' });
      addNode('c', 'C', { department: 'Finance', directReports: '[]' });

      const summary = await getDepartmentSummary();
      const eng = summary.find(d => d.department === 'Engineering');
      expect(eng).toBeTruthy();
      expect(eng!.headcount).toBe(2);
      expect(eng!.managers).toContain('A');
    });
  });
});
