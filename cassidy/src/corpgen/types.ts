// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CorpGen — Shared Types
// ---------------------------------------------------------------------------
// Type definitions for the CorpGen architecture: a Multi-Objective
// Multi-Horizon Agent (MOMA) layered on top of Cassidy. Mirrors the
// data structures in:
//   Jaye et al., "CorpGen: Simulating Corporate Environments with
//   Autonomous Digital Employees in Multi-Horizon Task Environments"
//   (Microsoft Research, Feb 2026, arXiv:2602.14229).
//
// Three temporal scales of plans (Strategic / Tactical / Operational),
// three tiers of memory (Working / Structured LTM / Semantic),
// trajectory records for experiential learning, and the per-cycle
// ReAct context that flows through Algorithm 1.
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

/** ISO date (YYYY-MM-DD). */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Digital Employee Identity
// ---------------------------------------------------------------------------

/** Persistent identity that survives context resets and day boundaries. */
export interface DigitalEmployeeIdentity {
  /** Stable id, e.g. AAD object id of the human owner or a synthetic id. */
  employeeId: string;
  /** Display name (e.g. "Cassidy"). */
  displayName: string;
  /** Job title (e.g. "Operations Manager"). */
  role: string;
  /** Department / team. */
  department?: string;
  /** Free-text persona — character, tone, working style. */
  persona: string;
  /** Strategic focus areas (3-7 short phrases). */
  responsibilities: string[];
  /** Tools/applications the employee is fluent in. */
  toolset: string[];
  /** Working schedule — see {@link WorkSchedule}. */
  schedule: WorkSchedule;
  /** Optional manager / escalation contact. */
  managerEmail?: string;
}

/** A realistic 8-18h workday with ±10 min variance for behavioural realism. */
export interface WorkSchedule {
  /** Local start hour (0-23). Default 9. */
  startHour: number;
  /** Local end hour (0-23). Default 17. */
  endHour: number;
  /** ±minutes of jitter applied per day. Default 10. */
  varianceMinutes: number;
  /** Minimum interval between cycle starts (ms). Default 5 min. */
  minCycleIntervalMs: number;
  /** IANA timezone, e.g. "Europe/London". */
  timezone: string;
}

// ---------------------------------------------------------------------------
// Hierarchical Plans (Strategic → Tactical → Operational)
// ---------------------------------------------------------------------------

export type PlanStatus = 'active' | 'completed' | 'superseded';
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'skipped';

/** Strategic objective with monthly horizon. */
export interface MonthlyPlan {
  planId: string;
  employeeId: string;
  /** YYYY-MM. */
  month: string;
  objectives: StrategicObjective[];
  status: PlanStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface StrategicObjective {
  objectiveId: string;
  title: string;
  description: string;
  /** Concrete deliverables with target weeks. */
  milestones: Milestone[];
  /** 1 (highest) - 5 (lowest). */
  priority: number;
  status: TaskStatus;
}

export interface Milestone {
  milestoneId: string;
  description: string;
  targetWeek: number; // 1..5
  status: TaskStatus;
}

/** Tactical plan — derived daily from the strategic plan. */
export interface DailyPlan {
  planId: string;
  employeeId: string;
  date: IsoDate;
  /** 6-12 actionable tasks. */
  tasks: DailyTask[];
  status: PlanStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface DailyTask {
  taskId: string;
  /** Human-readable description. */
  description: string;
  /** Target application (Mail, Calendar, Planner, Teams, Word, Excel, ...). */
  app: string;
  /** 1 (highest) - 5 (lowest). */
  priority: number;
  /** Other taskIds this task waits on (DAG edges). */
  dependsOn: string[];
  /** Linked monthly objective, if any. */
  objectiveId?: string;
  status: TaskStatus;
  /** Per-task retry counter. */
  attempts: number;
  /** Last failure or skip reason. */
  lastError?: string;
  /** Free-form structured result captured on completion. */
  result?: string;
}

// ---------------------------------------------------------------------------
// Tiered Memory
// ---------------------------------------------------------------------------

export type MemoryTier = 'working' | 'structured' | 'semantic';

/** Single record in structured long-term memory. */
export interface StructuredMemoryRecord {
  recordId: string;
  employeeId: string;
  /** plan_update | task_state_change | reflection | summary | tool_result | failure */
  kind: StructuredMemoryKind;
  /** Optional taskId scope to enable task-isolated retrieval. */
  taskId?: string;
  /** Compact body — JSON or free text. */
  body: string;
  /** 1-10 importance (>=7 retained verbatim during compression). */
  importance: number;
  /** ISO created. */
  createdAt: IsoDateTime;
}

export type StructuredMemoryKind =
  | 'plan_update'
  | 'task_state_change'
  | 'reflection'
  | 'summary'
  | 'tool_result'
  | 'failure';

// ---------------------------------------------------------------------------
// Execution Cycle (ReAct)
// ---------------------------------------------------------------------------

/** Working memory for a single execution cycle — reset each cycle. */
export interface CycleContext {
  cycleId: string;
  employeeId: string;
  /** The selected task for this cycle. */
  task: DailyTask;
  /** Retrieved structured + semantic context injected at cycle start. */
  retrieved: RetrievedContext;
  /** ReAct turn log (alternating reasoning + actions). */
  turns: ReActTurn[];
  /** Cycle start (ISO). */
  startedAt: IsoDateTime;
  /** Token-count estimate of working memory (rough). */
  estimatedTokens: number;
}

export interface RetrievedContext {
  structured: StructuredMemoryRecord[];
  semantic: SemanticHit[];
  experiential: TrajectoryDemo[];
}

export interface SemanticHit {
  content: string;
  score: number;
  source: string;
}

export interface ReActTurn {
  turnIndex: number;
  /** "thought" | "action" | "observation" */
  kind: 'thought' | 'action' | 'observation';
  /** Tool name when kind === 'action'. */
  tool?: string;
  /** Compact text body — observations may be summarised. */
  text: string;
  /** Was this turn classified as critical (preserved verbatim)? */
  critical: boolean;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Experiential Learning
// ---------------------------------------------------------------------------

export interface TrajectoryDemo {
  demoId: string;
  /** Application this demo is scoped to (used to filter retrieval). */
  app: string;
  /** Short canonical task description used for similarity search. */
  taskSummary: string;
  /** Structured action sequence (JSON). */
  actions: string;
  /** Optional embedding vector (cosine similarity). */
  embedding?: number[];
  /** Times this demo has been re-used. */
  reuseCount: number;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Day-level result (Algorithm 1 output)
// ---------------------------------------------------------------------------

export interface DayRunResult {
  employeeId: string;
  date: IsoDate;
  cyclesRun: number;
  tasksCompleted: number;
  tasksSkipped: number;
  tasksFailed: number;
  /** Total tool calls executed across all cycles. */
  toolCallsUsed: number;
  /**
   * Paper-aligned (§3.4.4) completion rate: done / total. Skipped tasks
   * count as failures and do NOT inflate the success rate.
   */
  completionRate: number;
  /** Why the day ended: 'plan_complete' | 'schedule_end' | 'cycle_cap' | 'wallclock_cap' | 'tool_call_cap' */
  stopReason: DayStopReason;
  reflection: string;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime;
}

export type DayStopReason =
  | 'plan_complete'
  | 'schedule_end'
  | 'cycle_cap'
  | 'wallclock_cap'
  | 'tool_call_cap';

// ---------------------------------------------------------------------------
// Artifact-based judging (CorpGen §5.3)
// ---------------------------------------------------------------------------

/** A produced artifact (e.g. a Mail draft, a Planner task, an Excel file). */
export interface TaskArtifact {
  /** Stable kind hint used by judges to pick a verifier. */
  kind: string;
  /** Source app this artifact came from. */
  app: string;
  /** Free-form payload (URL, JSON, text, etc.). */
  payload: string;
  /** ISO when the artifact was captured. */
  capturedAt: IsoDateTime;
}

export interface ArtifactJudgement {
  taskId: string;
  /** Pass / fail per the artifact verifier. */
  passed: boolean;
  /** 0..1 confidence. */
  confidence: number;
  /** Short rationale citing the artifact contents. */
  rationale: string;
  /** Number of artifacts considered. */
  artifactsConsidered: number;
}
