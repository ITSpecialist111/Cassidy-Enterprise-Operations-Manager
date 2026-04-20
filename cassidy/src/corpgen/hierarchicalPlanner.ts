// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Hierarchical Planner (CorpGen §3.4.1)
// ---------------------------------------------------------------------------
// Three temporal scales of planning, addressing the "reprioritisation
// overhead" failure mode by amortising O(N) per-cycle decisions into a
// pre-decided plan that is updated only on event boundaries:
//
//   Strategic  (Monthly)   — derived from identity & responsibilities
//      ↓ decompose
//   Tactical   (Daily)     — 6-12 actionable tasks for one workday
//      ↓ select
//   Operational (Per-cycle) — the next task to execute (DAG-aware)
//
// Plan updates fire when an execution cycle reports a state change
// (task done / failed / blocked) or when "observed environment state"
// drifts from the plan (e.g. a new high-priority task arrived in mail).
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { upsertEntity, getEntity, listEntities, type TableEntity } from '../memory/tableStorage';
import { logger } from '../logger';
import type {
  DigitalEmployeeIdentity,
  MonthlyPlan,
  DailyPlan,
  DailyTask,
  StrategicObjective,
  IsoDate,
  TaskStatus,
} from './types';

const TABLE_MONTHLY = 'CorpGenMonthlyPlans';
const TABLE_DAILY = 'CorpGenDailyPlans';

interface MonthlyRow extends TableEntity { body: string; updatedAt: string }
interface DailyRow   extends TableEntity { body: string; updatedAt: string }

// ---------------------------------------------------------------------------
// Strategic (monthly) plan
// ---------------------------------------------------------------------------

const STRATEGIC_PROMPT = `You are an autonomous digital employee generating a MONTHLY strategic plan.
Given the employee's identity and responsibilities, produce 3-5 strategic objectives for the month.
Each objective must include 2-4 milestones spread across weeks 1-4.

Return ONLY a JSON array, no markdown:
[
  {
    "title": "...",
    "description": "...",
    "priority": 1,
    "milestones": [
      { "description": "...", "targetWeek": 1 },
      { "description": "...", "targetWeek": 3 }
    ]
  }
]`;

export async function generateMonthlyPlan(
  identity: DigitalEmployeeIdentity,
  month: string = new Date().toISOString().slice(0, 7),
): Promise<MonthlyPlan> {
  const existing = await loadMonthlyPlan(identity.employeeId, month);
  if (existing && existing.status === 'active') return existing;

  const openai = getSharedOpenAI();
  const userPrompt = [
    `Identity: ${identity.displayName} — ${identity.role}`,
    `Persona: ${identity.persona}`,
    `Responsibilities:\n${identity.responsibilities.map((r) => `- ${r}`).join('\n')}`,
    `Month: ${month}`,
  ].join('\n\n');

  let objectives: StrategicObjective[] = [];
  try {
    const response = await openai.chat.completions.create({
      model: appConfig.openAiDeployment,
      messages: [
        { role: 'system', content: STRATEGIC_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content ?? '[]';
    objectives = parseObjectives(raw);
  } catch (err) {
    logger.warn('[CorpGen] Monthly plan generation failed; using empty plan', {
      module: 'corpgen.planner',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const plan: MonthlyPlan = {
    planId: ulid(),
    employeeId: identity.employeeId,
    month,
    objectives,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveMonthlyPlan(plan);
  return plan;
}

function parseObjectives(raw: string): StrategicObjective[] {
  try {
    // Accept either a bare array or { objectives: [...] }
    const trimmed = raw.trim();
    const parsed: unknown = trimmed.startsWith('[') ? JSON.parse(trimmed) : JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { objectives?: unknown }).objectives)
        ? (parsed as { objectives: unknown[] }).objectives
        : [];
    return (arr as Array<{
      title?: string;
      description?: string;
      priority?: number;
      milestones?: Array<{ description?: string; targetWeek?: number }>;
    }>).map((o) => ({
      objectiveId: ulid(),
      title: String(o.title ?? 'Untitled objective'),
      description: String(o.description ?? ''),
      priority: Number(o.priority ?? 3),
      status: 'pending' as TaskStatus,
      milestones: (o.milestones ?? []).map((m) => ({
        milestoneId: ulid(),
        description: String(m.description ?? ''),
        targetWeek: Math.max(1, Math.min(5, Number(m.targetWeek ?? 1))),
        status: 'pending' as TaskStatus,
      })),
    }));
  } catch {
    return [];
  }
}

export async function saveMonthlyPlan(plan: MonthlyPlan): Promise<void> {
  const row: MonthlyRow = {
    partitionKey: plan.employeeId,
    rowKey: plan.month,
    body: JSON.stringify(plan),
    updatedAt: new Date().toISOString(),
  };
  await upsertEntity(TABLE_MONTHLY, row);
}

export async function loadMonthlyPlan(employeeId: string, month: string): Promise<MonthlyPlan | null> {
  const row = await getEntity<MonthlyRow>(TABLE_MONTHLY, employeeId, month);
  if (!row) return null;
  try { return JSON.parse(row.body) as MonthlyPlan; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Tactical (daily) plan
// ---------------------------------------------------------------------------

const DAILY_PROMPT = `You are an autonomous digital employee generating today's TACTICAL plan.
You will be given:
- the employee's identity
- the active monthly strategic objectives
- recent context summary

Produce 6-12 concrete, actionable tasks for the day. Each task must:
- map to a single application from the toolset (Mail, Calendar, Planner, Teams, Word, Excel, PowerPoint, SharePoint)
- have priority 1 (highest) - 5 (lowest)
- list dependsOn taskIds (for tasks that must run later in the day)
- optionally link back to a monthly objectiveId

Return ONLY a JSON array:
[
  {
    "taskId": "t1",
    "description": "...",
    "app": "Mail",
    "priority": 1,
    "dependsOn": [],
    "objectiveId": "..."
  }
]`;

export interface DailyPlanInput {
  identity: DigitalEmployeeIdentity;
  monthly: MonthlyPlan;
  contextSummary?: string;
  date?: IsoDate;
}

export async function generateDailyPlan(input: DailyPlanInput): Promise<DailyPlan> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const existing = await loadDailyPlan(input.identity.employeeId, date);
  if (existing && existing.status === 'active') return existing;

  const openai = getSharedOpenAI();
  const userPrompt = [
    `Identity: ${input.identity.displayName} — ${input.identity.role}`,
    `Toolset: ${input.identity.toolset.join(', ')}`,
    `Date: ${date}`,
    `Monthly objectives:`,
    ...input.monthly.objectives.map(
      (o) => `- [${o.objectiveId}] (P${o.priority}) ${o.title}: ${o.description}`,
    ),
    input.contextSummary ? `Recent context:\n${input.contextSummary}` : '',
  ].filter(Boolean).join('\n\n');

  let tasks: DailyTask[] = [];
  try {
    const response = await openai.chat.completions.create({
      model: appConfig.openAiDeployment,
      messages: [
        { role: 'system', content: DAILY_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });
    tasks = parseTasks(response.choices[0]?.message?.content ?? '[]');
  } catch (err) {
    logger.warn('[CorpGen] Daily plan generation failed; using empty plan', {
      module: 'corpgen.planner',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const plan: DailyPlan = {
    planId: ulid(),
    employeeId: input.identity.employeeId,
    date,
    tasks,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveDailyPlan(plan);
  return plan;
}

function parseTasks(raw: string): DailyTask[] {
  try {
    const trimmed = raw.trim();
    const parsed: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { tasks?: unknown }).tasks)
        ? (parsed as { tasks: unknown[] }).tasks
        : [];
    return (arr as Array<{
      taskId?: string;
      description?: string;
      app?: string;
      priority?: number;
      dependsOn?: string[];
      objectiveId?: string;
    }>).map((t, i) => ({
      taskId: String(t.taskId ?? `t${i + 1}`),
      description: String(t.description ?? ''),
      app: String(t.app ?? 'Mail'),
      priority: Math.max(1, Math.min(5, Number(t.priority ?? 3))),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      objectiveId: t.objectiveId ? String(t.objectiveId) : undefined,
      status: 'pending' as TaskStatus,
      attempts: 0,
    }));
  } catch {
    return [];
  }
}

export async function saveDailyPlan(plan: DailyPlan): Promise<void> {
  const row: DailyRow = {
    partitionKey: plan.employeeId,
    rowKey: plan.date,
    body: JSON.stringify(plan),
    updatedAt: new Date().toISOString(),
  };
  await upsertEntity(TABLE_DAILY, row);
}

export async function loadDailyPlan(employeeId: string, date: IsoDate): Promise<DailyPlan | null> {
  const row = await getEntity<DailyRow>(TABLE_DAILY, employeeId, date);
  if (!row) return null;
  try { return JSON.parse(row.body) as DailyPlan; } catch { return null; }
}

export async function listDailyPlans(employeeId: string): Promise<DailyPlan[]> {
  const rows = await listEntities<DailyRow>(TABLE_DAILY, employeeId);
  return rows
    .map((r) => { try { return JSON.parse(r.body) as DailyPlan; } catch { return null; } })
    .filter((p): p is DailyPlan => p !== null);
}

// ---------------------------------------------------------------------------
// Operational selection (per-cycle)
// ---------------------------------------------------------------------------

/**
 * Select the next task to run from a daily plan.
 * Implements DAG-aware topological selection with priority tie-breaking:
 *   1. Skip tasks that aren't 'pending' or 'blocked'.
 *   2. Skip tasks whose dependencies aren't all 'done'.
 *   3. Prefer lowest-priority-number (highest priority).
 *   4. Tie-break by least-attempts-so-far (avoid repeated thrashing).
 */
export function selectNextTask(plan: DailyPlan): DailyTask | null {
  const byId = new Map(plan.tasks.map((t) => [t.taskId, t] as const));
  const ready = plan.tasks.filter((t) => {
    if (t.status !== 'pending' && t.status !== 'blocked') return false;
    return t.dependsOn.every((d) => byId.get(d)?.status === 'done');
  });
  if (ready.length === 0) return null;
  ready.sort((a, b) => a.priority - b.priority || a.attempts - b.attempts);
  return ready[0];
}

/** Mutate a task's status + attempts in-memory. Caller persists the plan. */
export function updateTaskStatus(
  plan: DailyPlan,
  taskId: string,
  status: TaskStatus,
  patch?: Partial<Pick<DailyTask, 'lastError' | 'result'>>,
): DailyPlan {
  const next = { ...plan, tasks: plan.tasks.map((t) => ({ ...t })) };
  const t = next.tasks.find((x) => x.taskId === taskId);
  if (!t) return next;
  t.status = status;
  if (status === 'in_progress' || status === 'failed') t.attempts += 1;
  if (patch?.lastError !== undefined) t.lastError = patch.lastError;
  if (patch?.result !== undefined) t.result = patch.result;
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Are all tasks terminal (done | failed | skipped)? */
export function isPlanComplete(plan: DailyPlan): boolean {
  return plan.tasks.every(
    (t) => t.status === 'done' || t.status === 'failed' || t.status === 'skipped',
  );
}

// ---------------------------------------------------------------------------
// Upward propagation (§3.4.1 — "task completion triggers daily progress
// updates and milestone tracking, while blockers cause priority adjustments
// and potential escalation to monthly plan revision")
// ---------------------------------------------------------------------------

export interface PropagationOutcome {
  /** Milestones whose status changed during this propagation. */
  milestonesUpdated: string[];
  /** Objectives whose status changed. */
  objectivesUpdated: string[];
  /** Blocked tasks that triggered priority bumps. */
  priorityBumps: string[];
  /** Did the monthly plan persist a change? */
  monthlyPersisted: boolean;
}

/**
 * Propagate a task state change upward:
 *   1. If the task links to a monthly objectiveId, advance milestone status
 *      based on the share of objective-linked tasks completed today.
 *   2. If the task is blocked or failed, bump the priority of every task
 *      that depends on it (so reprioritisation actually happens).
 *   3. Persist the monthly plan only if anything changed.
 *
 * Pure-ish: it persists side-effects but returns a summary so callers can
 * record structured-memory entries describing the propagation.
 */
export async function propagateTaskChange(input: {
  employeeId: string;
  daily: DailyPlan;
  taskId: string;
}): Promise<{ daily: DailyPlan; outcome: PropagationOutcome }> {
  const outcome: PropagationOutcome = {
    milestonesUpdated: [],
    objectivesUpdated: [],
    priorityBumps: [],
    monthlyPersisted: false,
  };

  const task = input.daily.tasks.find((t) => t.taskId === input.taskId);
  if (!task) return { daily: input.daily, outcome };

  // ── 1. Bump priority of dependents on blockers / failures ───────────────
  let daily = input.daily;
  if (task.status === 'blocked' || task.status === 'failed') {
    const dependents = daily.tasks.filter((t) => t.dependsOn.includes(task.taskId));
    if (dependents.length > 0) {
      daily = {
        ...daily,
        tasks: daily.tasks.map((t) => {
          if (!t.dependsOn.includes(task.taskId)) return t;
          if (t.status !== 'pending' && t.status !== 'blocked') return t;
          // Lower number = higher priority. Don't go below 1.
          const bumped = Math.max(1, t.priority - 1);
          if (bumped !== t.priority) outcome.priorityBumps.push(t.taskId);
          return { ...t, priority: bumped };
        }),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  // ── 2. Milestone / objective propagation ────────────────────────────────
  if (!task.objectiveId || task.status !== 'done') {
    return { daily, outcome };
  }
  const month = daily.date.slice(0, 7);
  const monthly = await loadMonthlyPlan(input.employeeId, month);
  if (!monthly) return { daily, outcome };

  const objective = monthly.objectives.find((o) => o.objectiveId === task.objectiveId);
  if (!objective) return { daily, outcome };

  // Tasks linked to this objective today
  const linked = daily.tasks.filter((t) => t.objectiveId === objective.objectiveId);
  const linkedDone = linked.filter((t) => t.status === 'done').length;
  const linkedTotal = linked.length;
  const ratio = linkedTotal === 0 ? 0 : linkedDone / linkedTotal;

  // Advance the earliest non-terminal milestone proportionally.
  // ratio >= 0.5 → next pending milestone -> in_progress
  // ratio === 1.0 → mark earliest pending/in_progress as done
  let changed = false;
  if (ratio >= 1.0) {
    const next = objective.milestones.find((m) => m.status !== 'done' && m.status !== 'failed' && m.status !== 'skipped');
    if (next) {
      next.status = 'done';
      outcome.milestonesUpdated.push(next.milestoneId);
      changed = true;
    }
  } else if (ratio >= 0.5) {
    const next = objective.milestones.find((m) => m.status === 'pending');
    if (next) {
      next.status = 'in_progress';
      outcome.milestonesUpdated.push(next.milestoneId);
      changed = true;
    }
  }

  // If all milestones done → objective done.
  if (objective.milestones.length > 0 && objective.milestones.every((m) => m.status === 'done')) {
    if (objective.status !== 'done') {
      objective.status = 'done';
      outcome.objectivesUpdated.push(objective.objectiveId);
      changed = true;
    }
  } else if (changed && objective.status === 'pending') {
    objective.status = 'in_progress';
    outcome.objectivesUpdated.push(objective.objectiveId);
  }

  if (changed) {
    monthly.updatedAt = new Date().toISOString();
    await saveMonthlyPlan(monthly);
    outcome.monthlyPersisted = true;
  }

  return { daily, outcome };
}
