// ---------------------------------------------------------------------------
// Retry Utility — exponential backoff with jitter for transient failures
// ---------------------------------------------------------------------------
// Used for external calls (OpenAI, Graph API, MCP) to handle 429/503/timeout.
// ---------------------------------------------------------------------------



export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30000 */
  maxDelayMs?: number;
  /** Which errors to retry on. Default: retries transient errors only */
  retryIf?: (error: unknown) => boolean;
  /** Called before each retry with attempt number and delay */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Returns true for errors that are typically transient and safe to retry:
 * - HTTP 429 (rate limit), 500, 502, 503, 504
 * - Network timeouts / AbortError
 * - ECONNRESET, ETIMEDOUT, ENOTFOUND (DNS)
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  const name = error.name;

  // AbortError / timeout
  if (name === 'AbortError' || msg.includes('abort') || msg.includes('timeout')) return true;

  // Network errors
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound') ||
      msg.includes('socket hang up') || msg.includes('network')) return true;

  // HTTP status codes embedded in error messages (common in SDKs)
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('internal server error') || msg.includes('service unavailable') ||
      msg.includes('bad gateway') || msg.includes('gateway timeout')) return true;

  // Azure-specific transient errors
  if (msg.includes('throttled') || msg.includes('too many requests')) return true;

  // Check for status property on error objects (e.g. OpenAI SDK errors)
  const status = (error as { status?: number }).status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;

  return false;
}

/**
 * Calculate delay with exponential backoff + jitter.
 * delay = min(baseDelay * 2^attempt + random_jitter, maxDelay)
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs * 0.5;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Execute an async function with retry logic and exponential backoff.
 *
 * @example
 * const result = await withRetry(() => openai.chat.completions.create(params), {
 *   maxAttempts: 3,
 *   onRetry: (attempt, delay) => console.log(`Retry ${attempt} in ${delay}ms`),
 * });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    retryIf = isTransientError,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt or non-transient errors
      if (attempt >= maxAttempts - 1 || !retryIf(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(attempt + 1, delay, error);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should not reach here, but satisfy TypeScript
  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit Breaker — stops calling a failing service to let it recover
// ---------------------------------------------------------------------------

type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Time in ms to wait before trying again (half-open). Default: 60000 */
  resetTimeoutMs?: number;
  /** Which errors count as failures. Default: all errors */
  isFailure?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(private readonly name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    this.isFailure = options.isFailure ?? (() => true);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error(`Circuit breaker "${this.name}" is open — service unavailable`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      console.warn(`[CircuitBreaker] "${this.name}" opened after ${this.failureCount} consecutive failures`);
    }
  }

  getState(): CircuitState { return this.state; }
  getFailureCount(): number { return this.failureCount; }
  reset(): void { this.state = 'closed'; this.failureCount = 0; }
}

// ---------------------------------------------------------------------------
// Pre-configured circuit breakers for external services
// ---------------------------------------------------------------------------

export const openAiCircuit = new CircuitBreaker('OpenAI', {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  isFailure: isTransientError,
});

export const graphCircuit = new CircuitBreaker('MicrosoftGraph', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  isFailure: isTransientError,
});

export const mcpCircuit = new CircuitBreaker('MCP', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  isFailure: isTransientError,
});
