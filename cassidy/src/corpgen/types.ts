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
  | 'tool_call_cap'
  | 'skipped:weekend'
  | 'skipped:before_hours'
  | 'skipped:after_hours'
  | 'skipped:in_flight';

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

// ---------------------------------------------------------------------------
// Agent Harness — reusable agentic execution engine
// ---------------------------------------------------------------------------

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat';

/**
 * Declarative definition of an agent the harness can execute.
 * Agents are plain objects (not classes) so they can be defined as
 * module-level constants and shared across invocations.
 */
export interface AgentDefinition {
  /** Unique identifier for this agent type (e.g. 'corpgen-react', 'research', 'cua-planner'). */
  agentId: string;
  /** System prompt — either a static string or a builder function. */
  systemPrompt: string | ((ctx: AgentPromptContext) => string);
  /** Max ReAct iterations before the harness stops. */
  maxIterations: number;
  /**
   * Tool allowlist. When present, only tools whose function.name appears in
   * this set are included (subject to the 128-tool cap and app filtering).
   */
  toolAllowlist?: Set<string>;
  /** Static response format for every iteration. */
  responseFormat?: 'text' | 'json_object';
  /** Dynamic per-iteration response format (overrides `responseFormat` when set). */
  responseFormatFn?: (iteration: number, maxIterations: number) => 'text' | 'json_object' | undefined;
  /** Tool-choice override. Default 'auto'. */
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * Continuation user-message injected between non-terminal iterations when
   * `toolChoice === 'none'` (e.g. research sub-agent multi-pass reasoning).
   */
  continuationPrompt?: string;
}

/** Context supplied to a dynamic system-prompt builder. */
export interface AgentPromptContext {
  identity?: DigitalEmployeeIdentity;
  task?: DailyTask;
  retrieved?: RetrievedContext;
  /** Arbitrary key-value bag for agent-specific data. */
  extra: Record<string, unknown>;
}

/** Configuration for a single `runAgent()` invocation. */
export interface HarnessRunConfig {
  /** The agent definition to execute. */
  agent: AgentDefinition;
  /** Initial user message(s) that kick off the loop. */
  userMessages: ChatCompletionMessageParam[];
  /** All candidate tools (before filtering). */
  tools: ChatCompletionTool[];
  /** App hint for per-task tool filtering (CorpGen paper Gap #3). */
  appHint?: string;
  /** Prompt context passed to dynamic system-prompt builders. */
  promptContext?: AgentPromptContext;
  /** Budget tracker — shared with the day runner. */
  budget?: HarnessBudget;
  /** Three-tier tool dispatcher (cognitive → subagent → host). */
  dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Lifecycle hooks. */
  hooks?: HarnessHooks;
  /** When set, enables adaptive summarisation between iterations. */
  summarization?: {
    employeeId: string;
    taskId: string;
  };
}

/** Budget tracker — identical shape to DayBudget. */
export interface HarnessBudget {
  startMs: number;
  maxWallclockMs: number;
  maxToolCalls: number;
  toolCallsUsed: number;
}

/** Lifecycle hooks fired by the harness. All are optional. */
export interface HarnessHooks {
  /** Called before each tool execution. May mutate args. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void | Promise<void>;
  /** Called after each tool execution. */
  onToolResult?: (name: string, result: unknown, error?: string, durationMs?: number) => void | Promise<void>;
  /** Called at the start of each iteration. */
  onIteration?: (iteration: number, tokenEstimate: number) => void | Promise<void>;
  /** Called after adaptive summarisation fires. */
  onSummarize?: (tokensBefore: number, tokensAfter: number) => void | Promise<void>;
  /** Called when the harness completes (success or failure). */
  onComplete?: (outcome: HarnessOutcome) => void | Promise<void>;
}

/** Result of a single `runAgent()` invocation. */
export interface HarnessOutcome {
  ok: boolean;
  result?: string;
  error?: string;
  budgetExhausted?: boolean;
  iterations: number;
  toolCallsUsed: number;
}

// ---------------------------------------------------------------------------
// FAISS Vector Index
// ---------------------------------------------------------------------------

/** Application-partitioned vector index for experiential trajectory retrieval. */
export interface VectorIndex {
  /** Search for top-K nearest neighbors. */
  search(queryVector: number[], topK: number): Promise<Array<{ demoId: string; score: number }>>;
  /** Add a vector to the index. */
  add(demoId: string, vector: number[]): Promise<void>;
  /** Number of vectors currently indexed. */
  size(): number;
}
