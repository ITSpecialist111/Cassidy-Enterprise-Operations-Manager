// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Cognitive Tools (CorpGen §3.5)
// ---------------------------------------------------------------------------
// Cognitive tools shape the host agent's reasoning *within* a single context
// by forcing structured outputs. They are NOT autonomous sub-agents (those
// live in subAgents.ts) — they are functions exposed to the LLM that
// require explicit JSON shapes and so promote disciplined reasoning.
//
// Three classes per the paper:
//   1. Planning tools     — generate_plan, update_plan
//   2. Task-tracking tools — track_task, list_open_tasks
//   3. Reflection tools    — reflect, lessons_learned
//
// Returning here as plain async functions + OpenAI ChatCompletionTool
// definitions, ready to merge into the existing `getAllTools()` list in
// cassidy/src/tools/index.ts.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';
import { generateMonthlyPlan, generateDailyPlan, loadDailyPlan, saveDailyPlan, updateTaskStatus, loadMonthlyPlan, propagateTaskChange } from './hierarchicalPlanner';
import { recordStructured, listStructured } from './tieredMemory';
import { loadIdentity, defaultCassidyIdentity } from './identity';
import type { TaskStatus } from './types';

// ---------------------------------------------------------------------------
// OpenAI tool definitions
// ---------------------------------------------------------------------------

export const COGNITIVE_TOOL_DEFS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'cg_generate_plan',
      description:
        'Generate (or refresh) the monthly strategic plan and today\'s tactical plan for the digital employee. Returns the daily plan tasks.',
      parameters: {
        type: 'object',
        properties: {
          employeeId: { type: 'string', description: 'Digital employee id (default: cassidy)' },
          contextSummary: { type: 'string', description: 'Optional recent context to bias today\'s tasks' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cg_update_plan',
      description:
        'Update a task in today\'s daily plan. Use after completing or failing a task, or when reprioritising.',
      parameters: {
        type: 'object',
        required: ['taskId', 'status'],
        properties: {
          employeeId: { type: 'string' },
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'skipped'] },
          result: { type: 'string', description: 'Short structured result captured on completion' },
          lastError: { type: 'string', description: 'Error or skip reason' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cg_track_task',
      description:
        'Append a structured task-state-change record to long-term memory. Use to record every meaningful state transition.',
      parameters: {
        type: 'object',
        required: ['taskId', 'note'],
        properties: {
          employeeId: { type: 'string' },
          taskId: { type: 'string' },
          note: { type: 'string', description: 'Short factual note about the state change' },
          importance: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cg_list_open_tasks',
      description: 'List today\'s open (pending / in_progress / blocked) tasks ordered by priority.',
      parameters: {
        type: 'object',
        properties: { employeeId: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cg_reflect',
      description:
        'End-of-day reflection. Consolidates today\'s outcomes and lessons learned into long-term memory.',
      parameters: {
        type: 'object',
        required: ['summary', 'lessons'],
        properties: {
          employeeId: { type: 'string' },
          summary: { type: 'string', description: 'What happened today' },
          lessons: { type: 'array', items: { type: 'string' }, description: 'Reusable lessons' },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers (called by tool-dispatch in agent.ts via the tools/index.ts wiring)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

async function getEmployeeId(args: Json): Promise<string> {
  const id = typeof args.employeeId === 'string' && args.employeeId ? args.employeeId : 'cassidy';
  return id;
}

async function ensureIdentity(employeeId: string) {
  return (await loadIdentity(employeeId)) ?? defaultCassidyIdentity(employeeId);
}

export async function cg_generate_plan(args: Json): Promise<Json> {
  const employeeId = await getEmployeeId(args);
  const identity = await ensureIdentity(employeeId);
  const monthly = await generateMonthlyPlan(identity);
  const daily = await generateDailyPlan({
    identity,
    monthly,
    contextSummary: typeof args.contextSummary === 'string' ? args.contextSummary : undefined,
  });
  return {
    monthly: { planId: monthly.planId, month: monthly.month, objectives: monthly.objectives.length },
    daily: { planId: daily.planId, date: daily.date, tasks: daily.tasks },
  };
}

export async function cg_update_plan(args: Json): Promise<Json> {
  const employeeId = await getEmployeeId(args);
  const date = new Date().toISOString().slice(0, 10);
  const plan = await loadDailyPlan(employeeId, date);
  if (!plan) return { ok: false, error: `No daily plan for ${date}` };
  const status = String(args.status) as TaskStatus;
  let next = updateTaskStatus(plan, String(args.taskId), status, {
    result: typeof args.result === 'string' ? args.result : undefined,
    lastError: typeof args.lastError === 'string' ? args.lastError : undefined,
  });
  // Upward propagation (§3.4.1) — milestones, objectives, dependent priority bumps
  const prop = await propagateTaskChange({
    employeeId,
    daily: next,
    taskId: String(args.taskId),
  });
  next = prop.daily;
  await saveDailyPlan(next);
  await recordStructured({
    employeeId,
    kind: 'plan_update',
    taskId: String(args.taskId),
    body: JSON.stringify({
      status,
      result: args.result,
      lastError: args.lastError,
      propagation: prop.outcome,
    }),
    importance: status === 'failed' || status === 'blocked' ? 8 : 6,
  });
  return { ok: true, taskId: args.taskId, status, propagation: prop.outcome };
}

export async function cg_track_task(args: Json): Promise<Json> {
  const employeeId = await getEmployeeId(args);
  const rec = await recordStructured({
    employeeId,
    kind: 'task_state_change',
    taskId: String(args.taskId),
    body: String(args.note),
    importance: typeof args.importance === 'number' ? args.importance : 5,
  });
  return { ok: true, recordId: rec.recordId };
}

export async function cg_list_open_tasks(args: Json): Promise<Json> {
  const employeeId = await getEmployeeId(args);
  const date = new Date().toISOString().slice(0, 10);
  const plan = await loadDailyPlan(employeeId, date);
  if (!plan) return { date, tasks: [] };
  const open = plan.tasks
    .filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
    .sort((a, b) => a.priority - b.priority);
  return { date, tasks: open };
}

export async function cg_reflect(args: Json): Promise<Json> {
  const employeeId = await getEmployeeId(args);
  const lessons = Array.isArray(args.lessons) ? (args.lessons as unknown[]).map(String) : [];
  await recordStructured({
    employeeId,
    kind: 'reflection',
    body: JSON.stringify({ summary: String(args.summary), lessons }),
    importance: 8,
  });
  // Also surface a stat the host can show
  const monthly = await loadMonthlyPlan(employeeId, new Date().toISOString().slice(0, 7));
  const recent = await listStructured(employeeId, { limit: 50 });
  return {
    ok: true,
    objectives: monthly?.objectives.length ?? 0,
    recentRecords: recent.length,
    lessonsCaptured: lessons.length,
  };
}

/** Map of cognitive-tool name → handler, ready for the tools/index.ts dispatcher. */
export const COGNITIVE_HANDLERS: Record<string, (args: Json) => Promise<Json>> = {
  cg_generate_plan,
  cg_update_plan,
  cg_track_task,
  cg_list_open_tasks,
  cg_reflect,
};
