// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { selectNextTask, updateTaskStatus, isPlanComplete } from './hierarchicalPlanner';
import type { DailyPlan, DailyTask } from './types';

function task(overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    taskId: overrides.taskId ?? 't1',
    description: 'a',
    app: 'Mail',
    priority: 3,
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

function plan(tasks: DailyTask[]): DailyPlan {
  return {
    planId: 'p1',
    employeeId: 'e1',
    date: '2026-04-20',
    tasks,
    status: 'active',
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
  };
}

describe('hierarchicalPlanner.selectNextTask', () => {
  it('returns the highest-priority ready task', () => {
    const p = plan([
      task({ taskId: 'a', priority: 3 }),
      task({ taskId: 'b', priority: 1 }),
      task({ taskId: 'c', priority: 2 }),
    ]);
    expect(selectNextTask(p)?.taskId).toBe('b');
  });

  it('respects DAG dependencies', () => {
    const p = plan([
      task({ taskId: 'a', priority: 1, status: 'pending' }),
      task({ taskId: 'b', priority: 1, dependsOn: ['a'] }),
    ]);
    expect(selectNextTask(p)?.taskId).toBe('a');
    const p2 = plan([
      task({ taskId: 'a', priority: 1, status: 'done' }),
      task({ taskId: 'b', priority: 1, dependsOn: ['a'] }),
    ]);
    expect(selectNextTask(p2)?.taskId).toBe('b');
  });

  it('skips terminal tasks', () => {
    const p = plan([
      task({ taskId: 'a', priority: 1, status: 'done' }),
      task({ taskId: 'b', priority: 1, status: 'failed' }),
      task({ taskId: 'c', priority: 1, status: 'skipped' }),
      task({ taskId: 'd', priority: 1, status: 'pending' }),
    ]);
    expect(selectNextTask(p)?.taskId).toBe('d');
  });

  it('returns null when nothing is ready', () => {
    const p = plan([
      task({ taskId: 'a', status: 'done' }),
      task({ taskId: 'b', status: 'pending', dependsOn: ['c'] }),
    ]);
    expect(selectNextTask(p)).toBeNull();
  });

  it('tie-breaks on attempts (least-attempted wins)', () => {
    const p = plan([
      task({ taskId: 'a', priority: 1, attempts: 2 }),
      task({ taskId: 'b', priority: 1, attempts: 0 }),
    ]);
    expect(selectNextTask(p)?.taskId).toBe('b');
  });
});

describe('hierarchicalPlanner.updateTaskStatus', () => {
  it('increments attempts on in_progress and failed', () => {
    const p = plan([task({ taskId: 'a', attempts: 0 })]);
    const p2 = updateTaskStatus(p, 'a', 'in_progress');
    expect(p2.tasks[0].attempts).toBe(1);
    const p3 = updateTaskStatus(p2, 'a', 'failed');
    expect(p3.tasks[0].attempts).toBe(2);
  });

  it('records lastError + result patches', () => {
    const p = plan([task({ taskId: 'a' })]);
    const p2 = updateTaskStatus(p, 'a', 'done', { result: 'ok' });
    expect(p2.tasks[0].result).toBe('ok');
    const p3 = updateTaskStatus(p2, 'a', 'failed', { lastError: 'boom' });
    expect(p3.tasks[0].lastError).toBe('boom');
  });

  it('does not mutate the input plan', () => {
    const p = plan([task({ taskId: 'a' })]);
    updateTaskStatus(p, 'a', 'done');
    expect(p.tasks[0].status).toBe('pending');
  });
});

describe('hierarchicalPlanner.isPlanComplete', () => {
  it('true only when every task is terminal', () => {
    expect(isPlanComplete(plan([task({ status: 'done' })]))).toBe(true);
    expect(isPlanComplete(plan([
      task({ taskId: 'a', status: 'done' }),
      task({ taskId: 'b', status: 'skipped' }),
      task({ taskId: 'c', status: 'failed' }),
    ]))).toBe(true);
    expect(isPlanComplete(plan([
      task({ taskId: 'a', status: 'done' }),
      task({ taskId: 'b', status: 'pending' }),
    ]))).toBe(false);
  });
});
