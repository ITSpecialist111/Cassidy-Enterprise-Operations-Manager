// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Sub-Agents as Tools (CorpGen §3.4.2)
// ---------------------------------------------------------------------------
// Sub-agents are autonomous reasoning agents wrapped as tools. They run in
// ISOLATED context scopes — the host agent supplies a query, the sub-agent
// performs an internal multi-step ReAct, and only a STRUCTURED result is
// returned. The sub-agent's intermediate reasoning never enters the host's
// context window. This addresses the "cross-task memory interference"
// failure mode by partitioning task-specific state.
//
// Two sub-agents shipped here:
//   1. ResearchAgent  — depth-configurable web/knowledge research (1/2/3
//                       iterations for shallow/medium/deep). Uses the host
//                       LLM but with its own ephemeral message array.
//   2. ComputerUseSubAgent — pluggable CUA hook. By default it returns a
//                       structured "would-perform" plan; production systems
//                       wire this to UFO2 or another CUA per the paper's
//                       §3.4.2 modular design.
// ---------------------------------------------------------------------------

import { ulid } from 'ulid';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { logger } from '../logger';
import type { TrajectoryDemo } from './types';

// ---------------------------------------------------------------------------
// Research Sub-Agent
// ---------------------------------------------------------------------------

export type ResearchDepth = 'shallow' | 'medium' | 'deep';

export interface ResearchRequest {
  query: string;
  depth?: ResearchDepth;
  /** Optional list of preferred sources (URLs / app names). */
  sources?: string[];
}

export interface ResearchReport {
  reportId: string;
  query: string;
  depth: ResearchDepth;
  /** 3-7 bullet findings. */
  findings: string[];
  /** Final synthesised answer. */
  conclusion: string;
  /** Optional citations. */
  citations: string[];
  /** Iterations actually performed. */
  iterations: number;
}

const DEPTH_ITERS: Record<ResearchDepth, number> = { shallow: 1, medium: 2, deep: 3 };

const RESEARCH_SYSTEM = `You are a Research Sub-Agent. You operate in ISOLATION from the host agent.
You will be asked one focused query. Reason in iterations:
  - Iteration 1: list what you know, what you need, and 2-4 candidate angles.
  - Iteration 2 (if depth>=medium): explore the strongest angles and refine.
  - Iteration 3 (if depth=deep): cross-check, surface counter-evidence, conclude.

At the END you MUST return a single JSON object only:
{
  "findings": ["...", "..."],
  "conclusion": "...",
  "citations": ["...", "..."]
}`;

export async function runResearchAgent(req: ResearchRequest): Promise<ResearchReport> {
  const depth: ResearchDepth = req.depth ?? 'medium';
  const iters = DEPTH_ITERS[depth];
  const openai = getSharedOpenAI();

  // Isolated message array — never returned to the host.
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: RESEARCH_SYSTEM },
    { role: 'user', content: `Query: ${req.query}\nDepth: ${depth}\nSources: ${(req.sources ?? []).join(', ') || '(any)'}` },
  ];

  let i = 0;
  let raw = '';
  for (; i < iters; i++) {
    const r = await openai.chat.completions.create({
      model: appConfig.openAiDeployment,
      messages,
      // Force JSON only on the final iteration.
      response_format: i === iters - 1 ? { type: 'json_object' } : undefined,
    });
    const content = r.choices[0]?.message?.content ?? '';
    messages.push({ role: 'assistant', content });
    if (i < iters - 1) {
      messages.push({ role: 'user', content: 'Continue to the next iteration. Refine and converge.' });
    } else {
      raw = content;
    }
  }

  const parsed = safeParseReport(raw);
  return {
    reportId: ulid(),
    query: req.query,
    depth,
    findings: parsed.findings,
    conclusion: parsed.conclusion,
    citations: parsed.citations,
    iterations: i,
  };
}

function safeParseReport(raw: string): { findings: string[]; conclusion: string; citations: string[] } {
  try {
    const obj = JSON.parse(raw) as { findings?: unknown; conclusion?: unknown; citations?: unknown };
    return {
      findings: Array.isArray(obj.findings) ? obj.findings.map(String) : [],
      conclusion: String(obj.conclusion ?? raw.slice(0, 500)),
      citations: Array.isArray(obj.citations) ? obj.citations.map(String) : [],
    };
  } catch {
    return { findings: [], conclusion: raw.slice(0, 500), citations: [] };
  }
}

// ---------------------------------------------------------------------------
// Computer-Use Sub-Agent (pluggable; default = "intent-only" plan)
// ---------------------------------------------------------------------------

export interface CuaRequest {
  app: string;
  intent: string;
  /** Optional structured arguments (e.g. file paths, recipients). */
  args?: Record<string, unknown>;
  /**
   * Top-K experiential demonstrations relevant to this intent. Per CorpGen
   * §3.6 qualitative insight: routing experiential feedback DIRECTLY to the
   * computer-using agent is more effective than routing it through the
   * hierarchical planner. CUA implementations (e.g. UFO2) should use these
   * to bias their action selection.
   */
  demos?: TrajectoryDemo[];
}

export interface CuaResult {
  ok: boolean;
  app: string;
  intent: string;
  /** What the CUA actually did (or would do). */
  steps: string[];
  /** Compact result body. */
  result: string;
  durationMs: number;
}

/** A swappable CUA implementation. Production code should plug UFO2 here. */
export type CuaProvider = (req: CuaRequest) => Promise<CuaResult>;

let _cuaProvider: CuaProvider = defaultIntentPlanner;

export function registerCuaProvider(p: CuaProvider): void { _cuaProvider = p; }

export async function runComputerUseSubAgent(req: CuaRequest): Promise<CuaResult> {
  const start = Date.now();
  try {
    const r = await _cuaProvider(req);
    return { ...r, durationMs: Date.now() - start };
  } catch (err) {
    logger.warn('[CorpGen] CUA sub-agent failed', {
      module: 'corpgen.subagents',
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      app: req.app,
      intent: req.intent,
      steps: [],
      result: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Default CUA: generates a structured intent plan via GPT (NO actual GUI
 * automation). Swap with `registerCuaProvider()` to wire UFO2 or any other
 * computer-use agent. Cassidy's existing MCP tools (Mail/Teams/Planner/
 * Calendar) cover most office-app intents without needing GUI automation.
 */
async function defaultIntentPlanner(req: CuaRequest): Promise<CuaResult> {
  const openai = getSharedOpenAI();
  const demoBlock = (req.demos ?? []).length > 0
    ? `\n\nPrior successful demonstrations for ${req.app} (use as templates):\n${(req.demos ?? [])
        .map((d, i) => `[demo ${i + 1}] ${d.taskSummary}\nactions: ${d.actions.slice(0, 600)}`)
        .join('\n\n')}`
    : '';
  const r = await openai.chat.completions.create({
    model: appConfig.openAiDeployment,
    messages: [
      {
        role: 'system',
        content:
          'You are a computer-use planner. Given an app and an intent, return a JSON object: { "steps": ["..."], "result": "..." }. Do not perform actions; describe them. If prior demonstrations are provided, follow their pattern.' +
          demoBlock,
      },
      { role: 'user', content: JSON.stringify({ app: req.app, intent: req.intent, args: req.args ?? {} }) },
    ],
    response_format: { type: 'json_object' },
  });
  const raw = r.choices[0]?.message?.content ?? '{}';
  let steps: string[] = [];
  let result = '';
  try {
    const parsed = JSON.parse(raw) as { steps?: unknown; result?: unknown };
    steps = Array.isArray(parsed.steps) ? parsed.steps.map(String) : [];
    result = String(parsed.result ?? '');
  } catch { /* fall through */ }
  return { ok: true, app: req.app, intent: req.intent, steps, result, durationMs: 0 };
}

// ---------------------------------------------------------------------------
// OpenAI tool definitions for the host agent
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_DEFS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'cg_research',
      description:
        'Spawn an isolated Research sub-agent. Use for any multi-step investigation that would otherwise pollute your main reasoning context.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['shallow', 'medium', 'deep'] },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cg_computer_use',
      description:
        'Delegate a GUI-style intent (Word, Excel, PowerPoint, etc.) to the Computer-Use sub-agent. Returns a structured result.',
      parameters: {
        type: 'object',
        required: ['app', 'intent'],
        properties: {
          app: { type: 'string' },
          intent: { type: 'string' },
          args: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
];

type Json = Record<string, unknown>;

export const SUBAGENT_HANDLERS: Record<string, (args: Json) => Promise<unknown>> = {
  cg_research: (args) =>
    runResearchAgent({
      query: String(args.query),
      depth: (args.depth as ResearchDepth) ?? 'medium',
      sources: Array.isArray(args.sources) ? (args.sources as unknown[]).map(String) : undefined,
    }),
  cg_computer_use: (args) =>
    runComputerUseSubAgent({
      app: String(args.app),
      intent: String(args.intent),
      args: (args.args as Record<string, unknown>) ?? undefined,
    }),
};
