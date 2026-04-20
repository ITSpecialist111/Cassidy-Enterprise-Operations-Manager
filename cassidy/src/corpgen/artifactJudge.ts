// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Artifact-Based Judging (CorpGen §5.3)
// ---------------------------------------------------------------------------
// The paper's largest methodological finding: artifact-based judging agreed
// with human labels ~90% of the time, while trace/screenshot-based judging
// agreed only ~40%. This module provides a small artifact verifier that
// inspects produced outputs (Mail draft URLs, Planner task ids, file
// payloads, etc.) rather than relying on the model's self-reported "done".
//
// The pipeline is:
//   1. Cycles emit zero or more {@link TaskArtifact} entries via
//      {@link recordArtifact}.
//   2. After a workday, {@link judgeDay} iterates the day's tasks and
//      asks an LLM judge to evaluate task completion using the artifacts
//      alone (no trace, no screenshots).
//   3. The result is a per-task {@link ArtifactJudgement} plus a day-level
//      pass rate that can be reported alongside the agent's self-claim.
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import { upsertEntity, listEntities, type TableEntity } from '../memory/tableStorage';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { logger } from '../logger';
import type {
  ArtifactJudgement,
  DailyPlan,
  TaskArtifact,
} from './types';

const TABLE = 'CorpGenArtifacts';

interface ArtifactRow extends TableEntity {
  taskId: string;
  date: string;
  kind: string;
  app: string;
  payload: string;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Persist an artifact produced while completing a task. */
export async function recordArtifact(input: {
  employeeId: string;
  date: string;
  taskId: string;
  artifact: Omit<TaskArtifact, 'capturedAt'> & { capturedAt?: string };
}): Promise<void> {
  const row: ArtifactRow = {
    partitionKey: `${input.employeeId}:${input.date}`,
    rowKey: `${input.taskId}:${ulid()}`,
    taskId: input.taskId,
    date: input.date,
    kind: input.artifact.kind,
    app: input.artifact.app,
    payload: input.artifact.payload,
    capturedAt: input.artifact.capturedAt ?? new Date().toISOString(),
  };
  try {
    await upsertEntity(TABLE, row);
  } catch (err) {
    logger.warn('[CorpGen] Failed to persist artifact', {
      module: 'corpgen.judge',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** List artifacts for a given (employee, date), optionally filtered by task. */
export async function listArtifacts(
  employeeId: string,
  date: string,
  taskId?: string,
): Promise<TaskArtifact[]> {
  const rows = await listEntities<ArtifactRow>(TABLE, `${employeeId}:${date}`);
  const filtered = taskId ? rows.filter((r) => r.taskId === taskId) : rows;
  return filtered.map((r) => ({
    kind: r.kind,
    app: r.app,
    payload: r.payload,
    capturedAt: r.capturedAt,
  }));
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

const JUDGE_PROMPT = `You are an ARTIFACT-BASED judge for an autonomous digital employee.
You evaluate whether a task was actually completed, using ONLY the produced artifacts.
Do NOT rely on the agent's self-description. If the artifacts do not demonstrate
task completion, mark passed=false even if the agent claimed success.

Return ONLY a JSON object:
{ "passed": boolean, "confidence": 0..1, "rationale": "<=2 sentences citing the artifacts" }`;

export interface JudgeOptions {
  /** Override the model deployment used for judging. */
  deployment?: string;
  /** Treat tasks with zero artifacts as a pass? Default false (paper-aligned). */
  passWhenNoArtifacts?: boolean;
}

/** Judge one task using its artifacts. */
export async function judgeTask(input: {
  employeeId: string;
  date: string;
  taskId: string;
  taskDescription: string;
  options?: JudgeOptions;
}): Promise<ArtifactJudgement> {
  const artifacts = await listArtifacts(input.employeeId, input.date, input.taskId);
  if (artifacts.length === 0) {
    return {
      taskId: input.taskId,
      passed: input.options?.passWhenNoArtifacts ?? false,
      confidence: input.options?.passWhenNoArtifacts ? 0.3 : 0.9,
      rationale: 'No artifacts produced.',
      artifactsConsidered: 0,
    };
  }

  const deployment = input.options?.deployment ?? appConfig.openAiDeployment;
  const openai = getSharedOpenAI();
  try {
    const r = await openai.chat.completions.create({
      model: deployment,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            task: input.taskDescription,
            artifacts: artifacts.map((a) => ({
              kind: a.kind,
              app: a.app,
              payload: a.payload.slice(0, 4000),
              capturedAt: a.capturedAt,
            })),
          }),
        },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = r.choices[0]?.message?.content ?? '{}';
    return parseJudgement(input.taskId, raw, artifacts.length);
  } catch (err) {
    logger.warn('[CorpGen] Artifact judge LLM call failed', {
      module: 'corpgen.judge',
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      taskId: input.taskId,
      passed: false,
      confidence: 0,
      rationale: 'Judge unavailable.',
      artifactsConsidered: artifacts.length,
    };
  }
}

function parseJudgement(taskId: string, raw: string, count: number): ArtifactJudgement {
  try {
    const obj = JSON.parse(raw) as { passed?: unknown; confidence?: unknown; rationale?: unknown };
    return {
      taskId,
      passed: Boolean(obj.passed),
      confidence: clamp01(Number(obj.confidence ?? 0)),
      rationale: String(obj.rationale ?? ''),
      artifactsConsidered: count,
    };
  } catch {
    return {
      taskId,
      passed: false,
      confidence: 0,
      rationale: 'Unparseable judge response.',
      artifactsConsidered: count,
    };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export interface DayJudgement {
  employeeId: string;
  date: string;
  total: number;
  passed: number;
  /** passed / total — paper-aligned ground-truth-style metric. */
  passRate: number;
  perTask: ArtifactJudgement[];
}

/**
 * Judge every task in a daily plan using only its artifacts.
 * Returns per-task and aggregate results suitable for logging side-by-side
 * with the agent's self-reported {@link DayRunResult}.
 */
export async function judgeDay(input: {
  employeeId: string;
  plan: DailyPlan;
  options?: JudgeOptions;
}): Promise<DayJudgement> {
  const perTask: ArtifactJudgement[] = [];
  for (const t of input.plan.tasks) {
    const j = await judgeTask({
      employeeId: input.employeeId,
      date: input.plan.date,
      taskId: t.taskId,
      taskDescription: t.description,
      options: input.options,
    });
    perTask.push(j);
  }
  const passed = perTask.filter((j) => j.passed).length;
  const total = perTask.length;
  return {
    employeeId: input.employeeId,
    date: input.plan.date,
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    perTask,
  };
}
