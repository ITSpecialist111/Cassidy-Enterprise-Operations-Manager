// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, it, expect, vi } from 'vitest';

// Stub the heavy dependencies of corpgenIntegration so we exercise wiring
// only — no Azure / OpenAI / MCP traffic.
vi.mock('./corpgen', async () => {
  const actual = await vi.importActual<typeof import('./corpgen')>('./corpgen');
  return {
    ...actual,
    runWorkday: vi.fn(async () => ({
      employeeId: 'cassidy',
      date: '2026-04-20',
      cyclesRun: 1,
      tasksCompleted: 1,
      tasksSkipped: 0,
      tasksFailed: 0,
      toolCallsUsed: 3,
      completionRate: 1,
      stopReason: 'plan_complete' as const,
      reflection: 'shipped one thing',
      startedAt: '2026-04-20T00:00:00Z',
      endedAt: '2026-04-20T00:00:01Z',
    })),
  };
});

vi.mock('./tools/mcpToolSetup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/mcpToolSetup')>();
  return {
    ...actual,
    getLiveMcpToolDefinitions: vi.fn(async () => []),
  };
});

vi.mock('./logger', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
}));

import { getAllTools, executeTool } from './tools/index';
import { runWorkdayForCassidy, summariseDayForTeams, buildCassidyExecutor } from './corpgenIntegration';

describe('CorpGen wiring', () => {
  it('exposes cg_run_workday in getAllTools()', () => {
    const tools = getAllTools();
    const names = tools.map((t) => (t.type === 'function' ? t.function.name : ''));
    expect(names).toContain('cg_run_workday');
  });

  it('cg_run_workday tool definition has the documented optional params', () => {
    const tools = getAllTools();
    const cg = tools.find((t) => t.type === 'function' && t.function.name === 'cg_run_workday');
    expect(cg).toBeDefined();
    if (cg?.type !== 'function') throw new Error('expected function tool');
    const params = cg.function.parameters as { properties?: Record<string, unknown>; required?: unknown[] };
    expect(params.properties).toHaveProperty('maxCycles');
    expect(params.properties).toHaveProperty('maxWallclockMs');
    expect(params.properties).toHaveProperty('maxToolCalls');
    expect(params.properties).toHaveProperty('employeeId');
    expect(params.required).toEqual([]);
  });

  it('runWorkdayForCassidy returns a DayRunResult with the new fields', async () => {
    const result = await runWorkdayForCassidy({ maxCycles: 1 });
    expect(result.cyclesRun).toBe(1);
    expect(result.completionRate).toBe(1);
    expect(result.stopReason).toBe('plan_complete');
    expect(typeof result.toolCallsUsed).toBe('number');
  });

  it('summariseDayForTeams produces a markdown summary', () => {
    const md = summariseDayForTeams({
      employeeId: 'cassidy',
      date: '2026-04-20',
      cyclesRun: 2,
      tasksCompleted: 3,
      tasksSkipped: 1,
      tasksFailed: 0,
      toolCallsUsed: 12,
      completionRate: 0.75,
      stopReason: 'plan_complete',
      reflection: 'good day',
      startedAt: '',
      endedAt: '',
    });
    expect(md).toContain('CorpGen workday — 2026-04-20');
    expect(md).toContain('completion rate: 75%');
    expect(md).toContain('stop reason: plan_complete');
    expect(md).toContain('good day');
  });

  it('executeTool kicks off cg_run_workday in the background and returns a job id', async () => {
    const json = await executeTool('cg_run_workday', { maxCycles: 1 });
    const parsed = JSON.parse(json) as { jobId: string; status: string; message: string };
    expect(parsed.jobId).toMatch(/[0-9a-f-]{8,}/);
    expect(['queued', 'running', 'succeeded']).toContain(parsed.status);
    expect(parsed.message).toContain('CorpGen workday');
  });

  it('buildCassidyExecutor merges static + live MCP tools without duplicates', async () => {
    const ex = await buildCassidyExecutor();
    const tools = ex.hostTools();
    const names = tools.map((t) => (t.type === 'function' ? t.function.name : ''));
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
    expect(names).toContain('cg_run_workday'); // static defs included
  });
});
