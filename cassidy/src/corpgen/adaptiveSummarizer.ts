// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Adaptive Summarisation (CorpGen §3.4.4)
// ---------------------------------------------------------------------------
// Bounds the per-cycle context window by classifying each ReAct turn as
// CRITICAL or ROUTINE and compressing only the routine slice when the
// estimated token count crosses a threshold (default 4 000 tokens).
//
//   critical   = tool invocations, task state changes, plan updates,
//                errors / recovery signals, anything tagged critical
//   routine    = intermediate observations, transient reasoning
//
// On overflow:
//   1. Preserve all critical turns verbatim.
//   2. Compress the routine slice into a short structured summary
//      capturing decisions, blockers, and current application state.
//   3. If still over budget, compress further (more aggressive truncation)
//      while keeping all task-level state.
//
// Summaries are written to structured memory (kind = 'summary') so they
// can be re-injected at the start of subsequent cycles.
// ---------------------------------------------------------------------------

import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';
import { logger } from '../logger';
import { recordStructured } from './tieredMemory';
import type { ReActTurn } from './types';

export interface SummariseConfig {
  /** Token budget at which compression triggers. Default 4096. */
  thresholdTokens: number;
  /** Approximate chars-per-token (very rough). Default 4. */
  charsPerToken: number;
  /** Per-call timeout for the summary LLM call (ms). */
  timeoutMs: number;
}

export const DEFAULT_SUMMARISE: SummariseConfig = {
  thresholdTokens: 4096,
  charsPerToken: 4,
  timeoutMs: 15_000,
};

/** Rough token count from char length. */
export function estimateTokens(text: string, cpt = DEFAULT_SUMMARISE.charsPerToken): number {
  return Math.ceil(text.length / cpt);
}

/** Sum of estimated tokens across an array of turns. */
export function turnsTokens(turns: ReActTurn[], cpt = DEFAULT_SUMMARISE.charsPerToken): number {
  return turns.reduce((acc, t) => acc + estimateTokens(t.text, cpt), 0);
}

export interface CompressionResult {
  /** Replacement turn list (critical preserved + 1 summary turn). */
  turns: ReActTurn[];
  /** Was compression actually applied? */
  compressed: boolean;
  /** Tokens before / after estimation. */
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compress a turn log if it exceeds the token threshold. Pure function:
 * returns a new turn list. Critical turns are preserved verbatim; routine
 * turns are folded into a single summary turn (kind='observation', critical=false).
 *
 * If the compression GPT call fails the routine slice is replaced with a
 * deterministic template-based summary so cycles never stall (CorpGen §3.4.4
 * "rare over-compression failures handled by the retry and skip policy").
 */
export async function compressIfNeeded(
  employeeId: string,
  taskId: string,
  turns: ReActTurn[],
  config: Partial<SummariseConfig> = {},
): Promise<CompressionResult> {
  const cfg = { ...DEFAULT_SUMMARISE, ...config };
  const tokensBefore = turnsTokens(turns, cfg.charsPerToken);
  if (tokensBefore < cfg.thresholdTokens) {
    return { turns, compressed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const critical = turns.filter((t) => t.critical);
  const routine = turns.filter((t) => !t.critical);
  if (routine.length === 0) {
    return { turns, compressed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const summaryText = await summariseRoutine(routine, cfg).catch((err) => {
    logger.warn('[CorpGen] LLM summary failed; falling back to template', {
      module: 'corpgen.summary',
      error: err instanceof Error ? err.message : String(err),
    });
    return templateSummary(routine);
  });

  const summaryTurn: ReActTurn = {
    turnIndex: critical.length,
    kind: 'observation',
    text: `[summary of ${routine.length} routine turns]\n${summaryText}`,
    critical: false,
    createdAt: new Date().toISOString(),
  };

  // Persist the summary as a structured-memory record so it can be
  // re-injected at the start of subsequent cycles.
  await recordStructured({
    employeeId,
    kind: 'summary',
    taskId,
    body: summaryText,
    importance: 6,
  });

  const next = [...critical, summaryTurn].map((t, i) => ({ ...t, turnIndex: i }));
  const tokensAfter = turnsTokens(next, cfg.charsPerToken);

  // Second-pass: if still over budget, hard-truncate routine summary to half budget.
  if (tokensAfter >= cfg.thresholdTokens) {
    const halfBudgetChars = Math.floor((cfg.thresholdTokens / 2) * cfg.charsPerToken);
    summaryTurn.text = summaryTurn.text.slice(0, halfBudgetChars);
    return {
      turns: next,
      compressed: true,
      tokensBefore,
      tokensAfter: turnsTokens(next, cfg.charsPerToken),
    };
  }

  return { turns: next, compressed: true, tokensBefore, tokensAfter };
}

const SUMMARY_PROMPT = `You compress an autonomous agent's intermediate reasoning into a SHORT structured summary.
Capture, in <=200 words:
- key DECISIONS made
- BLOCKERS encountered
- CURRENT application state
- any user/system intent that influences the next action

Return plain text (no markdown). Omit polite filler.`;

async function summariseRoutine(routine: ReActTurn[], cfg: SummariseConfig): Promise<string> {
  const transcript = routine
    .map((t) => `(${t.kind}${t.tool ? `:${t.tool}` : ''}) ${t.text}`)
    .join('\n');
  const openai = getSharedOpenAI();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const r = await openai.chat.completions.create({
      model: appConfig.openAiDeployment,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
      ],
    }, { signal: controller.signal });
    return r.choices[0]?.message?.content?.trim() ?? templateSummary(routine);
  } finally {
    clearTimeout(timeout);
  }
}

function templateSummary(routine: ReActTurn[]): string {
  const lastObs = [...routine].reverse().find((t) => t.kind === 'observation');
  const lastAct = [...routine].reverse().find((t) => t.kind === 'action');
  return [
    `Routine turns: ${routine.length}.`,
    lastAct ? `Last action: ${lastAct.tool ?? '?'} — ${lastAct.text.slice(0, 160)}` : '',
    lastObs ? `Last observation: ${lastObs.text.slice(0, 160)}` : '',
  ].filter(Boolean).join(' ');
}

/** Helper: classify a candidate turn as critical based on its kind/tool. */
export function classifyTurn(input: {
  kind: ReActTurn['kind'];
  tool?: string;
  text: string;
  isStateChange?: boolean;
  isFailure?: boolean;
}): boolean {
  if (input.isStateChange || input.isFailure) return true;
  if (input.kind === 'action') return true;            // tool invocations are critical
  if (/error|failed|blocked|escalat/i.test(input.text)) return true;
  return false;
}
