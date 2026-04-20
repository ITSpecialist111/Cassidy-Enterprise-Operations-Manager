// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Communication-Channel Fallback (CorpGen §3.7)
// ---------------------------------------------------------------------------
// Per the paper:
//   "If a communication path breaks, such as an email delivery error,
//    agents reroute messages through alternative channels like Teams to
//    ensure task completion."
//
// Cassidy already exposes both Mail and Teams MCP tools. This wrapper
// detects a delivery-style failure on the primary channel and transparently
// retries on the secondary, recording the fallback as a structured-memory
// event so the agent (and any future emergent-collaboration analysis) can
// see that re-routing happened.
//
// It is implemented as a wrapping ToolExecutor: drop it around your real
// executor and the digital employee gains channel resilience for free.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';
import type { ToolExecutor } from './digitalEmployee';
import { recordStructured } from './tieredMemory';
import { logger } from '../logger';

/** Map of "primary tool" → "secondary tool" that conveys the same intent. */
export interface FallbackMap {
  /** e.g. { sendMail: 'sendTeamsMessage', sendEmail: 'sendTeamsMessage' } */
  [primary: string]: string;
}

/** Default map matching common Cassidy MCP tool names. */
export const DEFAULT_COMM_FALLBACKS: FallbackMap = {
  sendMail: 'sendTeamsMessage',
  sendEmail: 'sendTeamsMessage',
  send_mail: 'send_teams_message',
  // Teams → Mail when Teams is unhealthy
  sendTeamsMessage: 'sendMail',
  send_teams_message: 'send_mail',
};

/** Heuristic: is this error a delivery-style failure worth re-routing? */
function isDeliveryFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /(deliver|undeliverable|recipient|mailbox|smtp|throttl|timeout|503|502|504|network|unreachable|not\s*found.*recipient)/.test(
    msg,
  );
}

/** Translate args from the primary tool's shape to the secondary's shape. */
export type ArgRewriter = (
  primary: string,
  secondary: string,
  args: Record<string, unknown>,
) => Record<string, unknown>;

/** Default rewriter: pass through, but normalise common field names. */
const defaultArgRewriter: ArgRewriter = (_p, _s, args) => {
  const out: Record<string, unknown> = { ...args };
  // Mail → Teams: 'subject' + 'body' ⇒ 'message' (with subject prepended)
  if ('subject' in out || 'body' in out) {
    const subject = String(out.subject ?? '');
    const body = String(out.body ?? '');
    out.message = subject ? `${subject}\n\n${body}` : body;
  }
  // Teams → Mail: 'message' ⇒ 'body'
  if ('message' in out && !('body' in out)) {
    out.body = String(out.message);
  }
  // Recipient normalisation: 'to' / 'recipients' / 'channelId' kept as-is
  return out;
};

export interface FallbackOptions {
  /** Primary → secondary tool map. Defaults to {@link DEFAULT_COMM_FALLBACKS}. */
  fallbacks?: FallbackMap;
  /** Args translator. Defaults to a sensible Mail↔Teams normaliser. */
  rewriter?: ArgRewriter;
  /** Employee id used for structured-memory records. */
  employeeId?: string;
}

/**
 * Wrap a {@link ToolExecutor} with comm-channel fallback. The host-tool list
 * is unchanged; only `execute` gains the retry-on-secondary behaviour.
 */
export function withCommFallback(inner: ToolExecutor, opts: FallbackOptions = {}): ToolExecutor {
  const map = opts.fallbacks ?? DEFAULT_COMM_FALLBACKS;
  const rewrite = opts.rewriter ?? defaultArgRewriter;
  const employeeId = opts.employeeId ?? 'cassidy';

  return {
    hostTools(): ChatCompletionTool[] { return inner.hostTools(); },
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      try {
        return await inner.execute(name, args);
      } catch (err) {
        const secondary = map[name];
        if (!secondary || !isDeliveryFailure(err)) throw err;
        const newArgs = rewrite(name, secondary, args);
        logger.warn('[CorpGen] Comm channel fallback', {
          module: 'corpgen.comm',
          primary: name,
          secondary,
          error: err instanceof Error ? err.message : String(err),
        });
        const result = await inner.execute(secondary, newArgs);
        await recordStructured({
          employeeId,
          kind: 'tool_result',
          body: JSON.stringify({
            event: 'comm_fallback',
            from: name,
            to: secondary,
            originalError: err instanceof Error ? err.message : String(err),
          }),
          importance: 7,
        });
        return result;
      }
    },
  };
}

/** Low-level helper exported for tests. */
export const _internal = { isDeliveryFailure, defaultArgRewriter };
