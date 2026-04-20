// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Digital Employee Runner — Algorithm 1 (CorpGen §3.4.4)
// ---------------------------------------------------------------------------
// Implements the full workday loop from the paper:
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ Day Init                                                         │
//   │   ├─ apply ±10 min jitter to start/end                           │
//   │   ├─ ensure monthly plan exists (else generate)                  │
//   │   ├─ ensure today's daily plan exists (else generate)            │
//   │   └─ load identity into stable system prompt                     │
//   ├──────────────────────────────────────────────────────────────────┤
//   │ Execution Cycles  (loop while now < t_end)                       │
//   │   ├─ select next task (DAG-aware, priority-ordered)              │
//   │   ├─ retrieve tiered context (structured + semantic + experiential)
//   │   ├─ ReAct loop (think → act → observe), capped at 30 iters      │
//   │   │     - on overflow → adaptive summarisation                   │
//   │   │     - on tool error → up to 3 retries, then SKIP             │
//   │   ├─ persist plan_update / task_state_change / failure records   │
//   │   ├─ on success: capture trajectory for experiential learning    │
//   │   └─ wait until min cycle interval has elapsed (5 min default)   │
//   ├──────────────────────────────────────────────────────────────────┤
//   │ Day End                                                          │
//   │   ├─ generate reflection over the day's outcomes                 │
//   │   └─ consolidate into structured long-term memory                │
//   └──────────────────────────────────────────────────────────────────┘
//
// Tools available to the agent are the union of:
//   - Cassidy's existing live MCP tools + native handlers
//   - The CorpGen cognitive tools (cg_*)
//   - The CorpGen sub-agent tools (cg_research, cg_computer_use)
//
// To keep this file infrastructure-agnostic the runner accepts a
// {ToolExecutor} adapter so it can be wired to either the existing
// agent.ts dispatcher or a unit-test stub.
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { logger } from '../logger';
import { recordEvent } from '../agentEvents';
import {
  defaultCassidyIdentity,
  loadIdentity,
  saveIdentity,
  jitteredWorkday,
  identitySystemBlock,
} from './identity';
import {
  generateMonthlyPlan,
  generateDailyPlan,
  loadDailyPlan,
  saveDailyPlan,
  selectNextTask,
  updateTaskStatus,
  isPlanComplete,
  propagateTaskChange,
} from './hierarchicalPlanner';
import {
  recordStructured,
  retrieveForCycle,
  renderRetrievedContext,
  workingReset,
} from './tieredMemory';
import {
  compressIfNeeded,
  classifyTurn,
  estimateTokens,
} from './adaptiveSummarizer';
import {
  retrieveSimilarTrajectories,
  captureSuccessfulTrajectory,
  markDemoReused,
} from './experientialLearning';
import { COGNITIVE_TOOL_DEFS, COGNITIVE_HANDLERS } from './cognitiveTools';
import { SUBAGENT_TOOL_DEFS, SUBAGENT_HANDLERS } from './subAgents';
import type {
  DigitalEmployeeIdentity,
  DailyPlan,
  DailyTask,
  CycleContext,
  ReActTurn,
  RetrievedContext,
  DayRunResult,
  DayStopReason,
  TrajectoryDemo,
} from './types';

// ---------------------------------------------------------------------------
// Constants from the paper
// ---------------------------------------------------------------------------

const MAX_TASK_ATTEMPTS = 3;          // §3.4.4 retry-and-skip
const MAX_REACT_ITERATIONS = 30;      // §3.4.4 each attempt capped at 30
/** §4.1 "Each experiment is capped at 6 hours runtime". */
const DEFAULT_MAX_WALLCLOCK_MS = 6 * 60 * 60 * 1000;
/** §4.1 "with a theoretical limit of 25,000 tool calls". */
const DEFAULT_MAX_TOOL_CALLS = 25_000;

function toolName(t: ChatCompletionTool): string {
  return t.type === 'function' ? t.function.name : '';
}
const COGNITIVE_TOOL_NAMES = new Set(COGNITIVE_TOOL_DEFS.map(toolName).filter(Boolean));
const SUBAGENT_TOOL_NAMES = new Set(SUBAGENT_TOOL_DEFS.map(toolName).filter(Boolean));

// ---------------------------------------------------------------------------
// External adapter — lets the runner stay infrastructure-agnostic
// ---------------------------------------------------------------------------

export interface ToolExecutor {
  /** Definitions for tools that are NOT cognitive/sub-agent built-ins. */
  hostTools(): ChatCompletionTool[];
  /** Execute a host tool by name. Cognitive/sub-agent tools are handled internally. */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface RunOptions {
  identity?: DigitalEmployeeIdentity;
  /** Override "now" for tests / scheduled runs. */
  now?: Date;
  /** Skip the time-of-day check (run immediately, ignore schedule). */
  ignoreSchedule?: boolean;
  /** Hard cap on cycles per day (safety). Default 200. */
  maxCycles?: number;
  /**
   * Wall-clock cap (ms) per workday. Default 6 h, matching paper §4.1.
   * The day stops once exceeded even if more tasks remain.
   */
  maxWallclockMs?: number;
  /**
   * Total tool-call cap per workday. Default 25 000, matching paper §4.1.
   * Counts every host/cognitive/sub-agent tool invocation.
   */
  maxToolCalls?: number;
  /** Override min cycle interval (ms). Default = identity.schedule.minCycleIntervalMs. */
  minCycleIntervalMs?: number;
  /** Tool executor adapter (live MCP, native tools, or stub). */
  executor: ToolExecutor;
}

/**
 * Tracks per-workday accounting that the runner threads through every cycle.
 * Lives only for the duration of a single {@link runWorkday} call.
 */
interface DayBudget {
  /** Wall-clock start (Date.now()). */
  startMs: number;
  /** Wall-clock cap. */
  maxWallclockMs: number;
  /** Total tool calls allowed. */
  maxToolCalls: number;
  /** Tool calls consumed so far. */
  toolCallsUsed: number;
}

// ---------------------------------------------------------------------------
// Public entry point — run one full workday
// ---------------------------------------------------------------------------

export async function runWorkday(opts: RunOptions): Promise<DayRunResult> {
  const now = opts.now ?? new Date();
  const identity = await ensureIdentity(opts.identity ?? defaultCassidyIdentity());
  const today = now.toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();

  // ── Day Init ────────────────────────────────────────────────────────────
  const { start: tStart, end: tEnd } = jitteredWorkday(identity, now);
  const monthly = await generateMonthlyPlan(identity, now.toISOString().slice(0, 7));
  let plan: DailyPlan = await loadDailyPlan(identity.employeeId, today)
    ?? await generateDailyPlan({ identity, monthly, date: today });

  await recordStructured({
    employeeId: identity.employeeId,
    kind: 'plan_update',
    body: JSON.stringify({ event: 'day_init', tasks: plan.tasks.length, tStart, tEnd }),
    importance: 7,
  });
  recordEvent({ kind: 'corpgen.day', label: `Day start — ${identity.employeeId} (${plan.tasks.length} tasks)`, status: 'started', correlationId: identity.employeeId, data: { date: today, tasks: plan.tasks.length, role: identity.role } });

  // ── Budget bookkeeping (paper §4.1) ─────────────────────────────────────
  const budget: DayBudget = {
    startMs: Date.now(),
    maxWallclockMs: opts.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS,
    maxToolCalls: opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    toolCallsUsed: 0,
  };

  // ── Execution Cycles ────────────────────────────────────────────────────
  const minInterval = opts.minCycleIntervalMs ?? identity.schedule.minCycleIntervalMs;
  const maxCycles = opts.maxCycles ?? 200;
  let cyclesRun = 0;
  let lastCycleStart = 0;
  let stopReason: DayStopReason;

  while (true) {
    if (cyclesRun >= maxCycles) { stopReason = 'cycle_cap'; break; }
    if (Date.now() - budget.startMs >= budget.maxWallclockMs) { stopReason = 'wallclock_cap'; break; }
    if (budget.toolCallsUsed >= budget.maxToolCalls) { stopReason = 'tool_call_cap'; break; }

    const tNow = Date.now();
    if (!opts.ignoreSchedule && tNow > tEnd.getTime()) { stopReason = 'schedule_end'; break; }
    if (isPlanComplete(plan)) { stopReason = 'plan_complete'; break; }

    // Min interval between cycle starts
    const sinceLast = tNow - lastCycleStart;
    if (lastCycleStart > 0 && sinceLast < minInterval) {
      await sleep(minInterval - sinceLast);
    }
    lastCycleStart = Date.now();

    const task = selectNextTask(plan);
    if (!task) {
      // Nothing ready (all blocked) — short sleep then re-evaluate
      await sleep(Math.min(minInterval, 30_000));
      continue;
    }

    plan = await runCycle({ identity, plan, task, executor: opts.executor, budget });
    await saveDailyPlan(plan);
    cyclesRun++;
    recordEvent({ kind: 'corpgen.cycle', label: `${identity.employeeId} cycle ${cyclesRun} \u2014 ${task.description.slice(0, 60)}`, correlationId: identity.employeeId, data: { task: task.taskId, app: task.app, toolCallsUsed: budget.toolCallsUsed } });
  }

  // ── Day End ─────────────────────────────────────────────────────────────
  const tasksCompleted = plan.tasks.filter((t) => t.status === 'done').length;
  const tasksSkipped = plan.tasks.filter((t) => t.status === 'skipped').length;
  const tasksFailed = plan.tasks.filter((t) => t.status === 'failed').length;
  // Per §3.4.4, skipped tasks count as failures for completion-rate purposes.
  const totalTasks = plan.tasks.length;
  const completionRate = totalTasks === 0 ? 0 : tasksCompleted / totalTasks;
  const reflection = await generateReflection({ identity, plan });

  await recordStructured({
    employeeId: identity.employeeId,
    kind: 'reflection',
    body: reflection,
    importance: 9,
  });
  recordEvent({
    kind: 'corpgen.day',
    label: `Day end \u2014 ${identity.employeeId} (${tasksCompleted}/${totalTasks} done, ${(completionRate * 100).toFixed(0)}%)`,
    status: tasksFailed === 0 ? 'ok' : 'partial',
    durationMs: Date.now() - new Date(startedAt).getTime(),
    correlationId: identity.employeeId,
    data: { stopReason, cyclesRun, tasksCompleted, tasksFailed, tasksSkipped, toolCallsUsed: budget.toolCallsUsed, reflection: reflection.slice(0, 200) },
  });

  return {
    employeeId: identity.employeeId,
    date: today,
    cyclesRun,
    tasksCompleted,
    tasksSkipped,
    tasksFailed,
    toolCallsUsed: budget.toolCallsUsed,
    completionRate,
    stopReason,
    reflection,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

async function ensureIdentity(id: DigitalEmployeeIdentity): Promise<DigitalEmployeeIdentity> {
  const existing = await loadIdentity(id.employeeId);
  if (existing) return existing;
  await saveIdentity(id);
  return id;
}

// ---------------------------------------------------------------------------
// Single execution cycle (one selected task → up to 3 attempts × 30 iters)
// ---------------------------------------------------------------------------

interface CycleInput {
  identity: DigitalEmployeeIdentity;
  plan: DailyPlan;
  task: DailyTask;
  executor: ToolExecutor;
  budget: DayBudget;
}

async function runCycle(input: CycleInput): Promise<DailyPlan> {
  const { identity, task, executor, budget } = input;
  let plan = updateTaskStatus(input.plan, task.taskId, 'in_progress');

  // ── Retrieve tiered context (cycle-start injection) ─────────────────────
  const baseRetrieved = await retrieveForCycle({
    employeeId: identity.employeeId,
    taskId: task.taskId,
    query: task.description,
  });
  const experiential = await retrieveSimilarTrajectories({
    app: task.app,
    taskSummary: task.description,
    topK: 2,
  });
  for (const d of experiential) await markDemoReused(d).catch(() => undefined);

  const retrieved: RetrievedContext = { ...baseRetrieved, experiential };

  // ── ReAct attempt loop (up to 3 attempts) ───────────────────────────────
  let success = false;
  let lastError: string | undefined;
  let result: string | undefined;

  for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt++) {
    const cycle: CycleContext = {
      cycleId: ulid(),
      employeeId: identity.employeeId,
      task,
      retrieved,
      turns: [],
      startedAt: new Date().toISOString(),
      estimatedTokens: 0,
    };

    try {
      const outcome = await runReactLoop({
        cycle,
        identity,
        executor,
        budget,
        demos: experiential,
      });
      if (outcome.ok) {
        success = true;
        result = outcome.result;
        break;
      } else {
        lastError = outcome.error ?? 'unknown';
        await recordStructured({
          employeeId: identity.employeeId,
          kind: 'failure',
          taskId: task.taskId,
          body: JSON.stringify({ attempt, error: lastError }),
          importance: 8,
        });
        if (outcome.budgetExhausted) break; // no more attempts if we're out of budget
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[CorpGen] Cycle attempt threw', {
        module: 'corpgen.runner',
        error: lastError,
      });
    } finally {
      workingReset(cycle.cycleId);
    }
  }

  // ── Update plan + persist outcomes ──────────────────────────────────────
  if (success) {
    plan = updateTaskStatus(plan, task.taskId, 'done', { result });
    await recordStructured({
      employeeId: identity.employeeId,
      kind: 'task_state_change',
      taskId: task.taskId,
      body: JSON.stringify({ status: 'done', result: result ?? '' }),
      importance: 6,
    });
    // Capture canonical trajectory for experiential learning
    captureSuccessfulTrajectory({
      app: task.app,
      taskSummary: task.description,
      actions: result ?? '',
    }).catch(() => undefined);
  } else {
    plan = updateTaskStatus(plan, task.taskId, 'skipped', { lastError });
    await recordStructured({
      employeeId: identity.employeeId,
      kind: 'task_state_change',
      taskId: task.taskId,
      body: JSON.stringify({ status: 'skipped', lastError }),
      importance: 7,
    });
  }

  // ── Upward propagation (§3.4.1) ─────────────────────────────────────────
  const prop = await propagateTaskChange({
    employeeId: identity.employeeId,
    daily: plan,
    taskId: task.taskId,
  });
  plan = prop.daily;
  if (prop.outcome.milestonesUpdated.length > 0
      || prop.outcome.objectivesUpdated.length > 0
      || prop.outcome.priorityBumps.length > 0) {
    await recordStructured({
      employeeId: identity.employeeId,
      kind: 'plan_update',
      taskId: task.taskId,
      body: JSON.stringify({ event: 'propagation', outcome: prop.outcome }),
      importance: 7,
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// ReAct loop (single attempt)
// ---------------------------------------------------------------------------

interface ReactInput {
  cycle: CycleContext;
  identity: DigitalEmployeeIdentity;
  executor: ToolExecutor;
  budget: DayBudget;
  demos: TrajectoryDemo[];
}

interface ReactOutcome { ok: boolean; result?: string; error?: string; budgetExhausted?: boolean }

async function runReactLoop(input: ReactInput): Promise<ReactOutcome> {
  const { cycle, identity, executor, budget, demos } = input;
  const openai = getSharedOpenAI();

  const tools: ChatCompletionTool[] = [
    ...COGNITIVE_TOOL_DEFS,
    ...SUBAGENT_TOOL_DEFS,
    ...executor.hostTools(),
  ];

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(identity, cycle) },
    { role: 'user', content: buildTaskPrompt(cycle.task) },
  ];

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    if (Date.now() - budget.startMs >= budget.maxWallclockMs) {
      return { ok: false, error: 'wallclock cap reached', budgetExhausted: true };
    }
    if (budget.toolCallsUsed >= budget.maxToolCalls) {
      return { ok: false, error: 'tool-call cap reached', budgetExhausted: true };
    }
    let response;
    try {
      response = await openai.chat.completions.create({
        model: appConfig.openAiDeployment,
        messages,
        tools,
        tool_choice: 'auto',
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const msg = response.choices[0]?.message;
    if (!msg) return { ok: false, error: 'empty response' };

    // Append assistant turn
    if (msg.content) {
      pushTurn(cycle, {
        kind: 'thought',
        text: msg.content,
        critical: classifyTurn({ kind: 'thought', text: msg.content }),
      });
      recordEvent({ kind: 'llm.thought', label: msg.content.slice(0, 120), correlationId: identity.employeeId, data: { task: cycle.task.taskId, full: msg.content.slice(0, 600) } });
    }
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: msg.tool_calls,
    } as ChatCompletionMessageParam);

    // Terminal: assistant produced final answer with no tool calls
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { ok: true, result: msg.content ?? '' };
    }

    // Execute every tool call
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; }
      catch { /* keep empty */ }

      // Inject experiential demos when invoking the computer-use sub-agent
      // for the same app as the active task (paper §3.6 routing insight).
      if (name === 'cg_computer_use'
          && demos.length > 0
          && (typeof args.app !== 'string' || args.app === cycle.task.app)) {
        args = { ...args, demos };
      }

      pushTurn(cycle, {
        kind: 'action',
        tool: name,
        text: `${name}(${call.function.arguments?.slice(0, 200) ?? ''})`,
        critical: true,
      });

      let toolResult: unknown;
      let toolError: string | undefined;
      const toolStart = Date.now();
      recordEvent({ kind: 'corpgen.tool', label: `${identity.employeeId} ▸ ${name}`, status: 'started', correlationId: identity.employeeId, data: { task: cycle.task.taskId, args: Object.keys(args).join(',') } });
      try {
        toolResult = await dispatchTool(name, args, executor);
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err);
      }
      budget.toolCallsUsed++;
      recordEvent({ kind: 'corpgen.tool', label: `${identity.employeeId} ▸ ${name}`, status: toolError ? 'error' : 'ok', durationMs: Date.now() - toolStart, correlationId: identity.employeeId, data: toolError ? { error: toolError } : { ok: true } });

      const observationText = toolError
        ? `ERROR: ${toolError}`
        : safeStringify(toolResult);

      pushTurn(cycle, {
        kind: 'observation',
        tool: name,
        text: observationText.slice(0, 4000),
        critical: classifyTurn({
          kind: 'observation',
          tool: name,
          text: observationText,
          isFailure: Boolean(toolError),
        }),
      });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: observationText.slice(0, 4000),
      } as ChatCompletionMessageParam);
    }

    // Adaptive summarisation between iterations
    cycle.estimatedTokens = cycle.turns.reduce((acc, t) => acc + estimateTokens(t.text), 0);
    const compressed = await compressIfNeeded(
      identity.employeeId,
      cycle.task.taskId,
      cycle.turns,
    );
    if (compressed.compressed) {
      cycle.turns = compressed.turns;
      cycle.estimatedTokens = compressed.tokensAfter;
      // Replace the message history with a fresh, compressed view
      replaceHistoryWithSummary(messages, compressed.turns);
    }
  }

  return { ok: false, error: 'max ReAct iterations exhausted' };
}

function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  executor: ToolExecutor,
): Promise<unknown> {
  if (COGNITIVE_TOOL_NAMES.has(name)) {
    const handler = COGNITIVE_HANDLERS[name];
    return handler(args);
  }
  if (SUBAGENT_TOOL_NAMES.has(name)) {
    const handler = SUBAGENT_HANDLERS[name];
    return handler(args);
  }
  return executor.execute(name, args);
}

function pushTurn(cycle: CycleContext, partial: Omit<ReActTurn, 'turnIndex' | 'createdAt'>): void {
  cycle.turns.push({
    ...partial,
    turnIndex: cycle.turns.length,
    createdAt: new Date().toISOString(),
  });
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * After compression, prune the OpenAI message history down to:
 *   [system, user-task, assistant-summary]
 * This is what actually shrinks the prompt sent to the model.
 */
function replaceHistoryWithSummary(
  messages: ChatCompletionMessageParam[],
  turns: ReActTurn[],
): void {
  const system = messages[0];
  const user = messages[1];
  const summaryText = turns.map((t) => `(${t.kind}) ${t.text}`).join('\n');
  messages.length = 0;
  messages.push(system, user);
  messages.push({ role: 'assistant', content: `[compressed context]\n${summaryText}` });
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(identity: DigitalEmployeeIdentity, cycle: CycleContext): string {
  return [
    identitySystemBlock(identity),
    '',
    '# Operating principles (CorpGen)',
    '- You are running ONE execution cycle for ONE selected task. Do not work on other tasks.',
    '- Use cognitive tools (cg_*) to plan, track, and reflect with explicit structure.',
    '- Delegate research and GUI-style intents to sub-agents (cg_research, cg_computer_use) so',
    '  their reasoning does NOT pollute your working context.',
    '- Update plan state (cg_update_plan) the moment a task transitions.',
    '- When a task is genuinely infeasible after good-faith attempts, stop and let the runner skip.',
    '',
    renderRetrievedContext(cycle.retrieved),
  ].join('\n');
}

function buildTaskPrompt(task: DailyTask): string {
  return [
    `# Selected task`,
    `Task id: ${task.taskId}`,
    `App: ${task.app}`,
    `Priority: ${task.priority}`,
    `Description: ${task.description}`,
    task.lastError ? `Previous error: ${task.lastError}` : '',
    '',
    'Execute. End with a final assistant message (no tool calls) summarising the outcome in <=200 words.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// End-of-day reflection
// ---------------------------------------------------------------------------

const REFLECTION_PROMPT = `You are an autonomous digital employee writing your end-of-day reflection.
Given today's daily plan and outcomes, write 4-8 short bullets capturing:
- what shipped
- what stalled and why
- patterns worth reusing
- adjustments to propose for tomorrow

Plain text. No markdown headers. No filler.`;

async function generateReflection(input: { identity: DigitalEmployeeIdentity; plan: DailyPlan }): Promise<string> {
  try {
    const openai = getSharedOpenAI();
    const r = await openai.chat.completions.create({
      model: appConfig.openAiDeployment,
      messages: [
        { role: 'system', content: REFLECTION_PROMPT },
        { role: 'user', content: JSON.stringify({
          date: input.plan.date,
          tasks: input.plan.tasks.map((t) => ({
            taskId: t.taskId,
            app: t.app,
            priority: t.priority,
            status: t.status,
            attempts: t.attempts,
            lastError: t.lastError,
          })),
        })},
      ],
    });
    return r.choices[0]?.message?.content?.trim() ?? '(no reflection)';
  } catch (err) {
    return `(reflection unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ---------------------------------------------------------------------------
// Tiny helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Multi-day + organization runners (CorpGen §3.7 emergent collaboration)
// ---------------------------------------------------------------------------

export interface MultiDayOptions extends Omit<RunOptions, 'now'> {
  /** Number of consecutive workdays to simulate. */
  days: number;
  /**
   * Optional clock advance per day (ms). When provided, each iteration uses
   * a synthetic `now` advanced by this much from the previous one — useful
   * for back-tests / simulations. Default: real wall clock per call.
   */
  dayStepMs?: number;
  /** Synthetic starting "now" for the multi-day run. */
  startNow?: Date;
  /** Pause between days (ms). Default 0. */
  delayBetweenDaysMs?: number;
}

/**
 * Run the same digital employee for N consecutive workdays. Identity and
 * tiered memory persist naturally across days via Azure Table Storage.
 */
export async function runMultiDay(opts: MultiDayOptions): Promise<DayRunResult[]> {
  const results: DayRunResult[] = [];
  let now = opts.startNow;
  for (let i = 0; i < opts.days; i++) {
    const dayResult = await runWorkday({
      identity: opts.identity,
      now,
      ignoreSchedule: opts.ignoreSchedule,
      maxCycles: opts.maxCycles,
      maxWallclockMs: opts.maxWallclockMs,
      maxToolCalls: opts.maxToolCalls,
      minCycleIntervalMs: opts.minCycleIntervalMs,
      executor: opts.executor,
    });
    results.push(dayResult);
    if (opts.dayStepMs && now) {
      now = new Date(now.getTime() + opts.dayStepMs);
    }
    if (opts.delayBetweenDaysMs && i < opts.days - 1) {
      await sleep(opts.delayBetweenDaysMs);
    }
  }
  return results;
}

export interface OrganizationMember {
  identity: DigitalEmployeeIdentity;
  /** Per-employee tool executor (typically a per-user OBO-bound MCP gateway). */
  executor: ToolExecutor;
  /** Optional per-employee budget overrides. */
  maxWallclockMs?: number;
  maxToolCalls?: number;
  maxCycles?: number;
  minCycleIntervalMs?: number;
  ignoreSchedule?: boolean;
}

export interface OrganizationOptions {
  members: OrganizationMember[];
  days: number;
  /** Run members concurrently (default true) — they coordinate via Mail/Teams. */
  concurrent?: boolean;
  startNow?: Date;
  dayStepMs?: number;
}

export interface OrganizationResult {
  employeeId: string;
  results: DayRunResult[];
}

/**
 * Run a multi-employee organization for N workdays. Per CorpGen §3.7, no
 * shared internal state is required — coordination emerges through the
 * shared communication channels (Mail/Teams via MCP). When `concurrent`
 * is true (default), all employees run in parallel each "day batch"; when
 * false they run sequentially (useful for deterministic tests).
 */
export async function runOrganization(opts: OrganizationOptions): Promise<OrganizationResult[]> {
  const concurrent = opts.concurrent ?? true;
  const runMember = (m: OrganizationMember): Promise<OrganizationResult> => runMultiDay({
    identity: m.identity,
    executor: m.executor,
    days: opts.days,
    startNow: opts.startNow,
    dayStepMs: opts.dayStepMs,
    maxWallclockMs: m.maxWallclockMs,
    maxToolCalls: m.maxToolCalls,
    maxCycles: m.maxCycles,
    minCycleIntervalMs: m.minCycleIntervalMs,
    ignoreSchedule: m.ignoreSchedule,
  }).then((results) => ({ employeeId: m.identity.employeeId, results }));

  if (concurrent) {
    return Promise.all(opts.members.map(runMember));
  }
  const out: OrganizationResult[] = [];
  for (const m of opts.members) {
    out.push(await runMember(m));
  }
  return out;
}
