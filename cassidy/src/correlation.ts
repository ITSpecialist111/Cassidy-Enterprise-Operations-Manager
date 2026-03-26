// ---------------------------------------------------------------------------
// Request Correlation ID — end-to-end distributed tracing per message
// ---------------------------------------------------------------------------
// Generates a unique correlationId for each inbound message and threads it
// through the logger and telemetry for full request tracing.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

const asyncStorage = new AsyncLocalStorage<CorrelationContext>();

export interface CorrelationContext {
  correlationId: string;
  userId?: string;
  conversationId?: string;
}

/** Generate a new correlation ID */
export function generateCorrelationId(): string {
  return randomUUID();
}

/** Run a function within a correlation context */
export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return asyncStorage.run(ctx, fn);
}

/** Get the current correlation context (or undefined if none) */
export function getCorrelationContext(): CorrelationContext | undefined {
  return asyncStorage.getStore();
}

/** Get just the correlation ID from current context */
export function getCorrelationId(): string | undefined {
  return asyncStorage.getStore()?.correlationId;
}
