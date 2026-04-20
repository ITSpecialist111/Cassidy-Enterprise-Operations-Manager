// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CorpGen ↔ Cassidy integration glue
// ---------------------------------------------------------------------------
// Bridges the CorpGen autonomous "digital employee" runtime to Cassidy's
// existing tool surface (static + live MCP) and exposes a single helper
// that both:
//   1. The LLM tool `cg_run_workday` (called from Teams), and
//   2. The HTTP route `/api/corpgen/run` (operator-only)
// invoke. Keeping the bridge in one place ensures the agent and the HTTP
// harness behave identically.
// ---------------------------------------------------------------------------

import type { TurnContext } from '@microsoft/agents-hosting';
import type { ChatCompletionTool } from 'openai/resources/chat';
import {
  runWorkday,
  runMultiDay,
  runOrganization,
  withCommFallback,
  defaultCassidyIdentity,
  type DayRunResult,
  type RunOptions,
  type ToolExecutor,
  type OrganizationResult,
  type DigitalEmployeeIdentity,
} from './corpgen';
import { getAllTools, executeTool } from './tools/index';
import { getLiveMcpToolDefinitions } from './tools/mcpToolSetup';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// ToolExecutor adapter — wraps Cassidy's executeTool() for CorpGen
// ---------------------------------------------------------------------------

/**
 * Build a {@link ToolExecutor} that exposes Cassidy's full tool surface
 * (static defs + live MCP defs) to the CorpGen runner. Tools are dispatched
 * through Cassidy's central `executeTool`, so OBO token enrichment, MCP
 * invocation, and error handling all match the Teams turn behaviour.
 */
export async function buildCassidyExecutor(context?: TurnContext): Promise<ToolExecutor> {
  const staticTools = getAllTools();
  // Filter to function-shape only (CorpGen accepts ChatCompletionTool[]).
  const liveMcp = await getLiveMcpToolDefinitions(context);
  const liveNames = new Set(
    liveMcp.map((t: ChatCompletionTool) => (t.type === 'function' ? t.function.name : '')).filter(Boolean),
  );
  const merged: ChatCompletionTool[] = [
    ...liveMcp,
    ...staticTools.filter((t) =>
      t.type === 'function' ? !liveNames.has(t.function.name) : true,
    ),
  ];

  return {
    hostTools(): ChatCompletionTool[] { return merged; },
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      const json = await executeTool(name, args, context);
      try { return JSON.parse(json); } catch { return json; }
    },
  };
}

// ---------------------------------------------------------------------------
// runWorkdayForCassidy — single entry point used by both LLM tool + HTTP
// ---------------------------------------------------------------------------

export type WorkdayPhase = 'init' | 'cycle' | 'reflect' | 'monthly' | 'manual';

export interface RunWorkdayInput {
  /** Optional override of the digital employee identity (defaults to Cassidy). */
  employeeId?: string;
  /** Cap cycles for safety. Default 10 (well under the paper's 200). */
  maxCycles?: number;
  /** Wall-clock cap (ms). Default 5 minutes for interactive use. */
  maxWallclockMs?: number;
  /** Total tool-call cap. Default 200. */
  maxToolCalls?: number;
  /** Skip schedule check (run immediately). Default true. */
  ignoreSchedule?: boolean;
  /** Wrap the executor with Mail↔Teams fallback. Default true. */
  withFallback?: boolean;
  /** Optional Teams turn context for OBO + live MCP tools. */
  context?: TurnContext;
  /**
   * CorpGen day phase tag — informs telemetry + cap presets.
   * - 'init': Day-Init briefing (~08:50 cron)
   * - 'cycle': through-day execution cycle (~every 20 min cron)
   * - 'reflect': Day-End reflection (~17:30 cron)
   * - 'monthly': monthly objective regen (~1st of month cron)
   * - 'manual': operator/Teams-triggered run (no schedule gating).
   */
  phase?: WorkdayPhase;
  /** Bypass work-hours/weekend gating. Default true for `manual`, false otherwise. */
  force?: boolean;
}

const DEFAULT_INTERACTIVE: Required<Omit<RunWorkdayInput, 'employeeId' | 'context' | 'phase' | 'force'>> = {
  maxCycles: 10,
  maxWallclockMs: 5 * 60_000,
  maxToolCalls: 200,
  ignoreSchedule: true,
  withFallback: true,
};

/** Phase-specific cap presets. Caller can still override. */
function phasePresets(phase: WorkdayPhase): { maxCycles: number; maxWallclockMs: number; maxToolCalls: number } {
  switch (phase) {
    case 'init':    return { maxCycles: 1, maxWallclockMs: 90_000,  maxToolCalls: 30 };
    case 'cycle':   return { maxCycles: 1, maxWallclockMs: 120_000, maxToolCalls: 40 };
    case 'reflect': return { maxCycles: 1, maxWallclockMs: 90_000,  maxToolCalls: 30 };
    case 'monthly': return { maxCycles: 1, maxWallclockMs: 60_000,  maxToolCalls: 20 };
    default:        return { maxCycles: 10, maxWallclockMs: 5 * 60_000, maxToolCalls: 200 };
  }
}

/** Returns null if currently inside work hours, else a 'skipped' result body. */
export function checkWorkHours(
  identity: DigitalEmployeeIdentity,
  now: Date = new Date(),
): { inHours: boolean; reason?: string } {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat — close enough for gating
  if (day === 0 || day === 6) return { inHours: false, reason: 'weekend' };
  // Use UTC hour as a coarse approximation; identity.schedule is local but BST/GMT are within 1h.
  // For Europe/London: 09:00 local ≈ 08:00 UTC summer, 09:00 UTC winter — accept 07–18 UTC.
  const h = now.getUTCHours();
  if (h < Math.max(0, identity.schedule.startHour - 2)) return { inHours: false, reason: 'before_hours' };
  if (h >= identity.schedule.endHour + 1)               return { inHours: false, reason: 'after_hours' };
  return { inHours: true };
}

/**
 * Run one CorpGen workday using Cassidy's tool surface. Safe to invoke from
 * a Teams turn (interactive caps) or from the HTTP harness (operator caps).
 *
 * If `phase` is set and `force` is false (default for non-manual phases),
 * gates the run on work hours / weekday using the identity schedule. Returns
 * a synthetic skipped result rather than throwing so cron callers stay quiet.
 */
export async function runWorkdayForCassidy(input: RunWorkdayInput = {}): Promise<DayRunResult> {
  const phase: WorkdayPhase = input.phase ?? 'manual';
  const force = input.force ?? (phase === 'manual');
  const presets = phasePresets(phase);
  const opts = { ...DEFAULT_INTERACTIVE, ...presets, ...input };
  const identity = defaultCassidyIdentity();
  if (input.employeeId) identity.employeeId = input.employeeId;

  // Work-hours gating for cron-driven phases.
  if (!force) {
    const gate = checkWorkHours(identity);
    if (!gate.inHours) {
      logger.info('CorpGen workday gated by schedule', {
        module: 'corpgen.bridge', phase, reason: gate.reason,
      });
      const today = new Date().toISOString().slice(0, 10);
      return {
        employeeId: identity.employeeId,
        date: today,
        cyclesRun: 0,
        tasksCompleted: 0,
        tasksSkipped: 0,
        tasksFailed: 0,
        toolCallsUsed: 0,
        completionRate: 0,
        stopReason: `skipped:${gate.reason}` as DayRunResult['stopReason'],
        reflection: `Skipped ${phase} run: ${gate.reason}.`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      };
    }
  }

  let executor = await buildCassidyExecutor(input.context);
  if (opts.withFallback) executor = withCommFallback(executor, { employeeId: identity.employeeId });

  const runOpts: RunOptions = {
    identity,
    executor,
    ignoreSchedule: opts.ignoreSchedule,
    maxCycles: opts.maxCycles,
    maxWallclockMs: opts.maxWallclockMs,
    maxToolCalls: opts.maxToolCalls,
  };

  logger.info('CorpGen workday starting', {
    module: 'corpgen.bridge',
    employeeId: identity.employeeId,
    phase,
    maxCycles: opts.maxCycles,
    maxToolCalls: opts.maxToolCalls,
  });
  const result = await runWorkday(runOpts);
  logger.info('CorpGen workday finished', {
    module: 'corpgen.bridge',
    employeeId: identity.employeeId,
    cyclesRun: result.cyclesRun,
    completionRate: result.completionRate,
    stopReason: result.stopReason,
    toolCallsUsed: result.toolCallsUsed,
  });
  return result;
}

/** Compact, Teams-friendly summary of a CorpGen day. */
export function summariseDayForTeams(result: DayRunResult): string {
  const pct = (result.completionRate * 100).toFixed(0);
  return [
    `**CorpGen workday — ${result.date}** (${result.employeeId})`,
    `- cycles: ${result.cyclesRun}`,
    `- tasks done / skipped / failed: ${result.tasksCompleted} / ${result.tasksSkipped} / ${result.tasksFailed}`,
    `- completion rate: ${pct}%`,
    `- tool calls used: ${result.toolCallsUsed}`,
    `- stop reason: ${result.stopReason}`,
    '',
    `**Reflection:**`,
    result.reflection,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// runMultiDayForCassidy — N consecutive days for a single employee
// ---------------------------------------------------------------------------

export interface RunMultiDayInput extends RunWorkdayInput {
  /** Number of consecutive workdays to simulate. */
  days: number;
  /** Optional simulated clock advance per day (ms). */
  dayStepMs?: number;
  /** Optional pause between days (ms). Default 0. */
  delayBetweenDaysMs?: number;
  /** Optional synthetic starting "now". */
  startNow?: Date | string;
}

export async function runMultiDayForCassidy(input: RunMultiDayInput): Promise<DayRunResult[]> {
  const opts = { ...DEFAULT_INTERACTIVE, ...input };
  const identity: DigitalEmployeeIdentity = defaultCassidyIdentity();
  if (input.employeeId) identity.employeeId = input.employeeId;

  let executor = await buildCassidyExecutor(input.context);
  if (opts.withFallback) executor = withCommFallback(executor, { employeeId: identity.employeeId });

  logger.info('CorpGen multi-day starting', {
    module: 'corpgen.bridge',
    employeeId: identity.employeeId,
    days: input.days,
  });
  const results = await runMultiDay({
    identity,
    executor,
    days: input.days,
    dayStepMs: input.dayStepMs,
    delayBetweenDaysMs: input.delayBetweenDaysMs,
    startNow: input.startNow ? new Date(input.startNow) : undefined,
    ignoreSchedule: opts.ignoreSchedule,
    maxCycles: opts.maxCycles,
    maxWallclockMs: opts.maxWallclockMs,
    maxToolCalls: opts.maxToolCalls,
  });
  logger.info('CorpGen multi-day finished', {
    module: 'corpgen.bridge',
    employeeId: identity.employeeId,
    days: results.length,
    avgCompletionRate: results.length
      ? results.reduce((s, r) => s + r.completionRate, 0) / results.length
      : 0,
  });
  return results;
}

/** Aggregate trend summary suitable for an operator response or Teams reply. */
export function summariseMultiDay(results: DayRunResult[]): string {
  if (!results.length) return '_no days run_';
  const avg = (results.reduce((s, r) => s + r.completionRate, 0) / results.length) * 100;
  const best = Math.max(...results.map((r) => r.completionRate)) * 100;
  const worst = Math.min(...results.map((r) => r.completionRate)) * 100;
  const totalTools = results.reduce((s, r) => s + r.toolCallsUsed, 0);
  const lines = [
    `**CorpGen multi-day — ${results.length} days** (${results[0].employeeId})`,
    `- completion rate: avg ${avg.toFixed(0)}%, best ${best.toFixed(0)}%, worst ${worst.toFixed(0)}%`,
    `- total tool calls: ${totalTools}`,
    '',
    '**Per-day:**',
    ...results.map(
      (r, i) =>
        `  d${i + 1} ${r.date} — ${(r.completionRate * 100).toFixed(0)}% (${r.tasksCompleted}/${r.tasksCompleted + r.tasksSkipped + r.tasksFailed}), ${r.cyclesRun}c/${r.toolCallsUsed}t, stop=${r.stopReason}`,
    ),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// runOrganizationForCassidy — multi-employee, multi-day
// ---------------------------------------------------------------------------

export interface OrganizationMemberInput {
  employeeId: string;
  displayName?: string;
  role?: string;
  department?: string;
  responsibilities?: string[];
  toolset?: string[];
}

export interface RunOrganizationInput {
  members: OrganizationMemberInput[];
  days: number;
  concurrent?: boolean;
  startNow?: Date | string;
  dayStepMs?: number;
  maxCycles?: number;
  maxWallclockMs?: number;
  maxToolCalls?: number;
  withFallback?: boolean;
  ignoreSchedule?: boolean;
  context?: TurnContext;
}

export async function runOrganizationForCassidy(
  input: RunOrganizationInput,
): Promise<OrganizationResult[]> {
  const caps = {
    maxCycles: input.maxCycles ?? DEFAULT_INTERACTIVE.maxCycles,
    maxWallclockMs: input.maxWallclockMs ?? DEFAULT_INTERACTIVE.maxWallclockMs,
    maxToolCalls: input.maxToolCalls ?? DEFAULT_INTERACTIVE.maxToolCalls,
    ignoreSchedule: input.ignoreSchedule ?? DEFAULT_INTERACTIVE.ignoreSchedule,
    withFallback: input.withFallback ?? DEFAULT_INTERACTIVE.withFallback,
  };

  const baseExecutor = await buildCassidyExecutor(input.context);

  const members = input.members.map((m) => {
    const id: DigitalEmployeeIdentity = {
      ...defaultCassidyIdentity(m.employeeId),
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.role ? { role: m.role } : {}),
      ...(m.department ? { department: m.department } : {}),
      ...(m.responsibilities ? { responsibilities: m.responsibilities } : {}),
      ...(m.toolset ? { toolset: m.toolset } : {}),
    };
    const exec = caps.withFallback
      ? withCommFallback(baseExecutor, { employeeId: id.employeeId })
      : baseExecutor;
    return {
      identity: id,
      executor: exec,
      maxCycles: caps.maxCycles,
      maxWallclockMs: caps.maxWallclockMs,
      maxToolCalls: caps.maxToolCalls,
      ignoreSchedule: caps.ignoreSchedule,
    };
  });

  logger.info('CorpGen organization starting', {
    module: 'corpgen.bridge',
    members: members.length,
    days: input.days,
    concurrent: input.concurrent ?? true,
  });
  const results = await runOrganization({
    members,
    days: input.days,
    concurrent: input.concurrent,
    startNow: input.startNow ? new Date(input.startNow) : undefined,
    dayStepMs: input.dayStepMs,
  });
  logger.info('CorpGen organization finished', {
    module: 'corpgen.bridge',
    members: results.length,
  });
  return results;
}

export function summariseOrganization(results: OrganizationResult[]): string {
  if (!results.length) return '_no employees ran_';
  const lines: string[] = [`**CorpGen organization — ${results.length} employees**`];
  for (const r of results) {
    if (!r.results.length) {
      lines.push(`- ${r.employeeId}: no days run`);
      continue;
    }
    const avg =
      (r.results.reduce((s, d) => s + d.completionRate, 0) / r.results.length) * 100;
    const tools = r.results.reduce((s, d) => s + d.toolCallsUsed, 0);
    lines.push(
      `- ${r.employeeId}: ${r.results.length}d, avg ${avg.toFixed(0)}% completion, ${tools} tool calls`,
    );
  }
  return lines.join('\n');
}
