import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock featureConfig — no Graph credentials configured → demo mode
vi.mock('../featureConfig', () => ({
  config: {
    plannerGroupId: '',
    plannerPlanId: '',
    openAiEndpoint: '',
    openAiDeployment: 'gpt-5',
    baseUrl: 'https://test.example.com',
    storageAccount: '',
  },
  features: { openAiConfigured: false, isDevelopment: true },
}));

// Mock auth so nothing tries real Azure auth
vi.mock('../auth', () => ({
  getGraphToken: vi.fn(async () => 'mock-token'),
  getSharedOpenAI: vi.fn(() => ({})),
}));

import {
  getOverdueTasks,
  getTeamWorkload,
  getPendingApprovals,
  prioritizeBacklog,
  generateStandupReport,
  generateProjectStatusReport,
  OPERATIONS_TOOL_DEFINITIONS,
} from './operationsTools';

describe('operationsTools (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  describe('OPERATIONS_TOOL_DEFINITIONS', () => {
    it('exports a non-empty array of tool definitions', () => {
      expect(Array.isArray(OPERATIONS_TOOL_DEFINITIONS)).toBe(true);
      expect(OPERATIONS_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    });

    it('each tool has type "function" with name and parameters', () => {
      for (const tool of OPERATIONS_TOOL_DEFINITIONS) {
        expect(tool.type).toBe('function');
        expect(tool.function.name).toBeTruthy();
        expect(tool.function.parameters).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getOverdueTasks
  // ---------------------------------------------------------------------------

  describe('getOverdueTasks', () => {
    it('returns demo source when Graph not configured', async () => {
      const result = await getOverdueTasks({});
      expect(result.source).toBe('demo');
      expect(result.notice).toBeTruthy();
    });

    it('returns tasks with correct shape', async () => {
      const result = await getOverdueTasks({});
      expect(typeof result.total).toBe('number');
      expect(Array.isArray(result.tasks)).toBe(true);
      expect(typeof result.blockedCount).toBe('number');
      expect(typeof result.criticalCount).toBe('number');
      for (const t of result.tasks) {
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('title');
        expect(t).toHaveProperty('dueDate');
        expect(t).toHaveProperty('owner');
        expect(t).toHaveProperty('project');
        expect(t).toHaveProperty('status');
      }
    });

    it('filters by project', async () => {
      const result = await getOverdueTasks({ project: 'IT Procurement' });
      for (const t of result.tasks) {
        expect(t.project.toLowerCase()).toContain('it procurement');
      }
    });

    it('filters by assignee', async () => {
      const result = await getOverdueTasks({ assignee: 'Alex' });
      for (const t of result.tasks) {
        expect(t.owner.toLowerCase()).toContain('alex');
      }
    });

    it('includes at-risk tasks when flag is set', async () => {
      const withRisk = await getOverdueTasks({ include_at_risk: true });
      const withoutRisk = await getOverdueTasks({ include_at_risk: false });
      // With at-risk should include more or equal tasks
      expect(withRisk.total).toBeGreaterThanOrEqual(withoutRisk.total);
    });
  });

  // ---------------------------------------------------------------------------
  // getTeamWorkload
  // ---------------------------------------------------------------------------

  describe('getTeamWorkload', () => {
    it('returns demo source when Graph not configured', async () => {
      const result = await getTeamWorkload({});
      expect(result.source).toBe('demo');
      expect(result.notice).toBeTruthy();
    });

    it('returns correct team structure', async () => {
      const result = await getTeamWorkload({});
      expect(typeof result.team).toBe('string');
      expect(Array.isArray(result.members)).toBe(true);
      expect(result.members.length).toBeGreaterThan(0);
      for (const m of result.members) {
        expect(m).toHaveProperty('name');
        expect(m).toHaveProperty('role');
        expect(m).toHaveProperty('activeTasks');
        expect(m).toHaveProperty('overdueCount');
        expect(m).toHaveProperty('capacity');
        expect(m).toHaveProperty('capacityEmoji');
        expect(['normal', 'near_limit', 'over_limit']).toContain(m.capacity);
      }
    });

    it('aggregates totals correctly', async () => {
      const result = await getTeamWorkload({});
      const sumActive = result.members.reduce((s, m) => s + m.activeTasks, 0);
      const sumOverdue = result.members.reduce((s, m) => s + m.overdueCount, 0);
      expect(result.totalActiveTasks).toBe(sumActive);
      expect(result.totalOverdue).toBe(sumOverdue);
    });

    it('accepts team_name parameter', async () => {
      const result = await getTeamWorkload({ team_name: 'Engineering' });
      expect(result.team).toBe('Engineering');
    });
  });

  // ---------------------------------------------------------------------------
  // getPendingApprovals
  // ---------------------------------------------------------------------------

  describe('getPendingApprovals', () => {
    it('returns demo source when Graph not configured', async () => {
      const result = await getPendingApprovals({});
      expect(result.source).toBe('demo');
      expect(result.notice).toBeTruthy();
    });

    it('returns approvals with correct shape', async () => {
      const result = await getPendingApprovals({});
      expect(typeof result.total).toBe('number');
      expect(Array.isArray(result.approvals)).toBe(true);
      for (const a of result.approvals) {
        expect(a).toHaveProperty('id');
        expect(a).toHaveProperty('title');
        expect(a).toHaveProperty('requestor');
        expect(a).toHaveProperty('approver');
        expect(a).toHaveProperty('submittedDaysAgo');
        expect(a).toHaveProperty('urgency');
        expect(a).toHaveProperty('urgencyEmoji');
        expect(typeof a.isOverdue).toBe('boolean');
      }
    });

    it('filters by older_than_days', async () => {
      const all = await getPendingApprovals({});
      const old = await getPendingApprovals({ older_than_days: 4 });
      expect(old.total).toBeLessThanOrEqual(all.total);
      for (const a of old.approvals) {
        expect(a.submittedDaysAgo).toBeGreaterThanOrEqual(4);
      }
    });

    it('filters by approver', async () => {
      const result = await getPendingApprovals({ approver: 'Sarah' });
      for (const a of result.approvals) {
        expect(a.approver.toLowerCase()).toContain('sarah');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // prioritizeBacklog
  // ---------------------------------------------------------------------------

  describe('prioritizeBacklog', () => {
    it('scores and sorts tasks by priority', () => {
      const result = prioritizeBacklog({
        tasks: [
          { id: '1', title: 'Low priority', due_date: '2027-01-01' },
          { id: '2', title: 'Overdue and blocked', due_date: '2020-01-01', blocked: true },
          { id: '3', title: 'Due today', due_date: new Date().toISOString().slice(0, 10) },
        ],
      });

      expect(result.prioritized.length).toBe(3);
      // Overdue+blocked should be first
      expect(result.prioritized[0].id).toBe('2');
      expect(result.prioritized[0].priorityLabel).toBe('critical');
    });

    it('handles empty task list', () => {
      const result = prioritizeBacklog({ tasks: [] });
      expect(result.prioritized).toEqual([]);
      expect(result.summary).toContain('0 tasks');
    });

    it('applies priority level correctly', () => {
      const result = prioritizeBacklog({
        tasks: [{ id: '1', title: 'Critical priority', priority: 'critical', due_date: '2020-01-01' }],
      });
      expect(result.prioritized[0].priorityLabel).toBe('critical');
      expect(result.prioritized[0].priorityScore).toBeGreaterThan(100);
    });
  });

  // ---------------------------------------------------------------------------
  // generateStandupReport
  // ---------------------------------------------------------------------------

  describe('generateStandupReport', () => {
    it('returns a formatted markdown string', async () => {
      const report = await generateStandupReport({ date: '2026-03-25', include_blockers: true });
      expect(typeof report).toBe('string');
      expect(report).toContain('Daily Operations Standup');
      expect(report).toContain('2026-03-25');
    });

    it('includes DEMO DATA notice in demo mode', async () => {
      const report = await generateStandupReport({ date: '2026-03-25', include_blockers: false });
      expect(report.toLowerCase()).toContain('demo');
    });

    it('includes blockers section when requested', async () => {
      const report = await generateStandupReport({ date: '2026-03-25', include_blockers: true });
      expect(report).toContain('Blocked');
    });
  });

  // ---------------------------------------------------------------------------
  // generateProjectStatusReport
  // ---------------------------------------------------------------------------

  describe('generateProjectStatusReport', () => {
    it('returns a formatted markdown string', async () => {
      const report = await generateProjectStatusReport({ project_name: 'IT Procurement', period: '2026-03' });
      expect(typeof report).toBe('string');
      expect(report).toContain('IT Procurement');
    });

    it('indicates demo mode', async () => {
      const report = await generateProjectStatusReport({ project_name: 'IT Procurement', period: '2026-03' });
      expect(report.toLowerCase()).toContain('demo');
    });
  });
});
