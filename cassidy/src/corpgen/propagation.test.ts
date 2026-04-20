// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace Azure storage with an in-memory fake so the test is hermetic.
const monthlyStore = new Map<string, unknown>();
vi.mock('../memory/tableStorage', () => ({
  upsertEntity: vi.fn(async (_table: string, e: { partitionKey: string; rowKey: string; data?: string }) => {
    monthlyStore.set(`${e.partitionKey}|${e.rowKey}`, e);
  }),
  getEntity: vi.fn(async (_t: string, pk: string, rk: string) => monthlyStore.get(`${pk}|${rk}`) ?? null),
  listEntities: vi.fn(async () => []),
}));
vi.mock('../auth', () => ({
  getSharedOpenAI: () => ({ chat: { completions: { create: vi.fn() } } }),
}));
vi.mock('../featureConfig', () => ({ config: { openAiDeployment: 'gpt-test' } }));
vi.mock('../logger', () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
}));

import { propagateTaskChange, saveMonthlyPlan } from './hierarchicalPlanner';
import type { DailyPlan, MonthlyPlan } from './types';

function dailyWith(tasks: DailyPlan['tasks']): DailyPlan {
  return {
    planId: 'p',
    employeeId: 'e1',
    date: '2026-04-20',
    tasks,
    status: 'active',
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
  };
}

function monthlyWith(): MonthlyPlan {
  return {
    planId: 'm',
    employeeId: 'e1',
    month: '2026-04',
    status: 'active',
    objectives: [
      {
        objectiveId: 'obj-1',
        title: 'Ship X',
        description: 'Ship feature X',
        priority: 2,
        status: 'pending',
        milestones: [
          { milestoneId: 'ms-1', description: 'Design', targetWeek: 1, status: 'pending' },
          { milestoneId: 'ms-2', description: 'Build', targetWeek: 2, status: 'pending' },
        ],
      },
    ],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  };
}

beforeEach(() => monthlyStore.clear());

describe('propagateTaskChange', () => {
  it('bumps priorities of dependents on a blocked task', async () => {
    const d = dailyWith([
      { taskId: 'a', description: '', app: 'Mail', priority: 3, dependsOn: [], status: 'blocked', attempts: 0 },
      { taskId: 'b', description: '', app: 'Mail', priority: 3, dependsOn: ['a'], status: 'pending', attempts: 0 },
      { taskId: 'c', description: '', app: 'Mail', priority: 3, dependsOn: ['a'], status: 'pending', attempts: 0 },
    ]);
    const { daily, outcome } = await propagateTaskChange({ employeeId: 'e1', daily: d, taskId: 'a' });
    expect(outcome.priorityBumps.sort()).toEqual(['b', 'c']);
    expect(daily.tasks.find((t) => t.taskId === 'b')?.priority).toBe(2);
  });

  it('advances a milestone to in_progress at >=50% completion', async () => {
    await saveMonthlyPlan(monthlyWith());
    const d = dailyWith([
      { taskId: 't1', description: '', app: 'Mail', priority: 3, dependsOn: [], status: 'done', attempts: 0, objectiveId: 'obj-1' },
      { taskId: 't2', description: '', app: 'Mail', priority: 3, dependsOn: [], status: 'pending', attempts: 0, objectiveId: 'obj-1' },
    ]);
    const { outcome } = await propagateTaskChange({ employeeId: 'e1', daily: d, taskId: 't1' });
    expect(outcome.milestonesUpdated).toEqual(['ms-1']);
    expect(outcome.monthlyPersisted).toBe(true);
  });

  it('marks objective done when all linked tasks complete', async () => {
    const m = monthlyWith();
    m.objectives[0].milestones[0].status = 'done';
    await saveMonthlyPlan(m);
    const d = dailyWith([
      { taskId: 't1', description: '', app: 'Mail', priority: 3, dependsOn: [], status: 'done', attempts: 0, objectiveId: 'obj-1' },
      { taskId: 't2', description: '', app: 'Mail', priority: 3, dependsOn: [], status: 'done', attempts: 0, objectiveId: 'obj-1' },
    ]);
    const { outcome } = await propagateTaskChange({ employeeId: 'e1', daily: d, taskId: 't2' });
    expect(outcome.milestonesUpdated).toContain('ms-2');
    expect(outcome.objectivesUpdated).toContain('obj-1');
  });

  it('returns empty outcome when task not in plan', async () => {
    const d = dailyWith([]);
    const { outcome } = await propagateTaskChange({ employeeId: 'e1', daily: d, taskId: 'missing' });
    expect(outcome.milestonesUpdated).toEqual([]);
    expect(outcome.objectivesUpdated).toEqual([]);
    expect(outcome.priorityBumps).toEqual([]);
  });
});
