// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Agent Harness — reusable agentic execution engine
// ---------------------------------------------------------------------------
// A single, configurable execution engine that powers every agent in the
// CorpGen stack: the main ReAct loop (digitalEmployee.ts), the Research
// sub-agent, the Computer-Use sub-agent, and any future agents.
//
// Inspired by Claude Agent SDK patterns:
//   - Agents are declarative definitions (AgentDefinition), not classes
//   - Context is isolated per invocation (separate message arrays)
//   - Lifecycle hooks for observability (onToolCall, onToolResult, etc.)
//   - Per-task tool filtering reduces noise for the LLM (CorpGen Gap #3)
//   - Budget tracking shared with the day runner
//
// The harness does NOT own tool dispatch — it delegates to a caller-provided
// `dispatchTool(name, args)` function, preserving the existing three-tier
// routing (cognitive → subagent → host MCP) in digitalEmployee.ts.
// ---------------------------------------------------------------------------

import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { logger } from '../logger';
import { compressIfNeeded, estimateTokens } from './adaptiveSummarizer';
import { COGNITIVE_TOOL_DEFS } from './cognitiveTools';
import { SUBAGENT_TOOL_DEFS } from './subAgents';
import type {
  AgentDefinition,
  AgentPromptContext,
  HarnessRunConfig,
  HarnessBudget,
  HarnessOutcome,
  ReActTurn,
} from './types';

// ---------------------------------------------------------------------------
// App → MCP server-prefix mapping (per-task tool filtering)
// ---------------------------------------------------------------------------
// Names match the CONFIGURED_SERVERS in tools/mcpToolSetup.ts. MCP tools
// follow the convention `mcp_ServerName_toolName`.

const APP_TO_MCP_PREFIX: Record<string, string[]> = {
  Mail:       ['mcp_MailTools_'],
  Calendar:   ['mcp_CalendarTools_'],
  Teams:      ['mcp_TeamsServer_'],
  Planner:    ['mcp_PlannerServer_'],
  SharePoint: ['mcp_SharePointServer_', 'mcp_SharePointListsTools_'],
  OneDrive:   ['mcp_OneDriveServer_'],
};

/** Static Cassidy tool names associated with each app (wrappers in mcpToolSetup). */
const APP_TO_STATIC: Record<string, string[]> = {
  Mail:       ['sendEmail', 'findUser'],
  Calendar:   ['scheduleCalendarEvent', 'findUser'],
  Teams:      ['sendTeamsMessage', 'findUser'],
  Planner:    ['createPlannerTask', 'updatePlannerTask'],
  SharePoint: ['readSharePointList'],
};

// Lazy-initialized to avoid circular dependency issues (subAgents imports agentHarness)
let _cognitiveNames: Set<string> | null = null;
let _subagentNames: Set<string> | null = null;

function getCognitiveNames(): Set<string> {
  if (!_cognitiveNames) _cognitiveNames = new Set(COGNITIVE_TOOL_DEFS.map(fn).filter(Boolean));
  return _cognitiveNames;
}
function getSubagentNames(): Set<string> {
  if (!_subagentNames) _subagentNames = new Set(SUBAGENT_TOOL_DEFS.map(fn).filter(Boolean));
  return _subagentNames;
}

function fn(t: ChatCompletionTool): string {
  return t.type === 'function' ? t.function.name : '';
}

// ---------------------------------------------------------------------------
// Tool assembly with app-based filtering
// ---------------------------------------------------------------------------

const MAX_TOOLS = 128;

export function assembleToolList(
  allTools: ChatCompletionTool[],
  agent: AgentDefinition,
  appHint?: string,
): ChatCompletionTool[] {
  // Step 1: apply allowlist if present
  let eligible = agent.toolAllowlist
    ? allTools.filter((t) => t.type === 'function' && agent.toolAllowlist!.has(t.function.name))
    : allTools;

  // Step 2: no app hint → just cap and return
  if (!appHint) return eligible.slice(0, MAX_TOOLS);

  // Step 3: partition into app-relevant vs other
  const prefixes = APP_TO_MCP_PREFIX[appHint] ?? [];
  const staticNames = new Set(APP_TO_STATIC[appHint] ?? []);

  const appRelevant: ChatCompletionTool[] = [];
  const other: ChatCompletionTool[] = [];

  for (const tool of eligible) {
    if (tool.type !== 'function') { other.push(tool); continue; }
    const name = tool.function.name;

    // Cognitive + subagent tools always promoted
    if (getCognitiveNames().has(name) || getSubagentNames().has(name)) {
      appRelevant.push(tool);
      continue;
    }
    // MCP tools matching the app's server prefix
    if (prefixes.some((p) => name.startsWith(p))) {
      appRelevant.push(tool);
      continue;
    }
    // Static tools mapped to this app
    if (staticNames.has(name)) {
      appRelevant.push(tool);
      continue;
    }

    other.push(tool);
  }

  // App-relevant first, then fill remainder
  const result = [...appRelevant];
  const remaining = MAX_TOOLS - result.length;
  if (remaining > 0) result.push(...other.slice(0, remaining));
  return result;
}

// ---------------------------------------------------------------------------
// Core execution function
// ---------------------------------------------------------------------------

/**
 * Run an agent to completion within an isolated context. Returns a structured
 * outcome with success/failure, result text, iteration count, and tool-call
 * accounting.
 *
 * The caller provides:
 *   - An {@link AgentDefinition} that configures the agent's behaviour
 *   - A tool list and optional app hint for filtering
 *   - A `dispatchTool` function for three-tier routing
 *   - Optional budget, hooks, and summarization config
 */
export async function runAgent(config: HarnessRunConfig): Promise<HarnessOutcome> {
  const { agent, budget, hooks } = config;
  const openai = getSharedOpenAI();

  // ── Build system prompt ──────────────────────────────────────────────────
  const systemPrompt = typeof agent.systemPrompt === 'function'
    ? agent.systemPrompt(config.promptContext ?? { extra: {} })
    : agent.systemPrompt;

  // ── Assemble tool list with app filtering ────────────────────────────────
  const tools = assembleToolList(config.tools, agent, config.appHint);

  // ── Isolated message array ───────────────────────────────────────────────
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...config.userMessages,
  ];

  // ── Turn log for adaptive summarisation ──────────────────────────────────
  const turns: ReActTurn[] = [];
  let tokenEstimate = 0;
  let totalToolCalls = 0;

  // ── Iteration loop ───────────────────────────────────────────────────────
  for (let i = 0; i < agent.maxIterations; i++) {
    // Budget checks
    if (budget) {
      if (Date.now() - budget.startMs >= budget.maxWallclockMs) {
        return finish({ ok: false, error: 'wallclock cap reached', budgetExhausted: true, iterations: i, toolCallsUsed: totalToolCalls }, hooks);
      }
      if (budget.toolCallsUsed >= budget.maxToolCalls) {
        return finish({ ok: false, error: 'tool-call cap reached', budgetExhausted: true, iterations: i, toolCallsUsed: totalToolCalls }, hooks);
      }
    }

    await hooks?.onIteration?.(i, tokenEstimate);

    // Determine response format for this iteration
    const fmt = agent.responseFormatFn
      ? agent.responseFormatFn(i, agent.maxIterations)
      : agent.responseFormat;

    // LLM call
    let response;
    try {
      response = await openai.chat.completions.create({
        model: appConfig.openAiDeployment,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: agent.toolChoice ?? 'auto' } : {}),
        ...(fmt === 'json_object' ? { response_format: { type: 'json_object' as const } } : {}),
      });
    } catch (err) {
      return finish({ ok: false, error: err instanceof Error ? err.message : String(err), iterations: i + 1, toolCallsUsed: totalToolCalls }, hooks);
    }

    const msg = response.choices[0]?.message;
    if (!msg) {
      return finish({ ok: false, error: 'empty response', iterations: i + 1, toolCallsUsed: totalToolCalls }, hooks);
    }

    // Track assistant content as a turn
    if (msg.content) {
      turns.push({
        turnIndex: turns.length,
        kind: 'thought',
        text: msg.content,
        critical: false,
        createdAt: new Date().toISOString(),
      });
      tokenEstimate += estimateTokens(msg.content);
    }

    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: msg.tool_calls,
    } as ChatCompletionMessageParam);

    // Terminal: no tool calls → return the assistant's final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // For toolChoice='none' agents with continuation, inject continuation
      // and keep going unless this is the last iteration.
      if (agent.continuationPrompt && agent.toolChoice === 'none' && i < agent.maxIterations - 1) {
        messages.push({ role: 'user', content: agent.continuationPrompt });
        continue;
      }
      return finish({ ok: true, result: msg.content ?? '', iterations: i + 1, toolCallsUsed: totalToolCalls }, hooks);
    }

    // Execute tool calls
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; }
      catch { /* keep empty */ }

      await hooks?.onToolCall?.(name, args);

      turns.push({
        turnIndex: turns.length,
        kind: 'action',
        tool: name,
        text: `${name}(${call.function.arguments?.slice(0, 200) ?? ''})`,
        critical: true,
        createdAt: new Date().toISOString(),
      });

      let toolResult: unknown;
      let toolError: string | undefined;
      const toolStart = Date.now();

      try {
        toolResult = await config.dispatchTool(name, args);
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err);
      }

      totalToolCalls++;
      if (budget) budget.toolCallsUsed++;

      const durationMs = Date.now() - toolStart;
      await hooks?.onToolResult?.(name, toolResult, toolError, durationMs);

      const observationText = toolError
        ? `ERROR: ${toolError}`
        : safeStringify(toolResult);

      turns.push({
        turnIndex: turns.length,
        kind: 'observation',
        tool: name,
        text: observationText.slice(0, 4000),
        critical: Boolean(toolError),
        createdAt: new Date().toISOString(),
      });
      tokenEstimate += estimateTokens(observationText.slice(0, 4000));

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: observationText.slice(0, 4000),
      } as ChatCompletionMessageParam);
    }

    // Adaptive summarisation between iterations
    if (config.summarization) {
      const compressed = await compressIfNeeded(
        config.summarization.employeeId,
        config.summarization.taskId,
        turns,
      );
      if (compressed.compressed) {
        const tokensBefore = tokenEstimate;
        turns.length = 0;
        turns.push(...compressed.turns);
        tokenEstimate = compressed.tokensAfter;
        replaceHistoryWithSummary(messages, compressed.turns);
        await hooks?.onSummarize?.(tokensBefore, tokenEstimate);
      }
    }
  }

  return finish({ ok: false, error: 'max ReAct iterations exhausted', iterations: agent.maxIterations, toolCallsUsed: totalToolCalls }, hooks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function finish(outcome: HarnessOutcome, hooks?: HarnessRunConfig['hooks']): Promise<HarnessOutcome> {
  await hooks?.onComplete?.(outcome);
  return outcome;
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * After compression, prune the OpenAI message history to:
 *   [system, user-task, assistant-summary]
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
