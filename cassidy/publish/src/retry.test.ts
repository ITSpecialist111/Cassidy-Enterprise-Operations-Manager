// ---------------------------------------------------------------------------
// Tests — retry utility + circuit breaker
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { withRetry, isTransientError, CircuitBreaker } from './retry';

describe('isTransientError', () => {
  it('returns true for 429 rate limit', () => {
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 503 service unavailable', () => {
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for timeout/abort', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('returns true for throttled', () => {
    expect(isTransientError(new Error('Request throttled by server'))).toBe(true);
  });

  it('returns true for error with status 429', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns false for 404 not found', () => {
    expect(isTransientError(new Error('404 Not Found'))).toBe(false);
  });

  it('returns false for auth errors', () => {
    expect(isTransientError(new Error('AuthorizationFailure'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const err = new Error('503 Service Unavailable');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 })).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('Invalid API key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry callback', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Error));
  });

  it('respects custom retryIf predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('custom error'));
    const retryIf = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { retryIf })).rejects.toThrow('custom error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });

  it('stays closed on success', async () => {
    const cb = new CircuitBreaker('test');
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  it('opens after reaching failure threshold', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 2 });

    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    }

    expect(cb.getState()).toBe('open');
    expect(cb.getFailureCount()).toBe(2);
  });

  it('rejects immediately when open', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 60000 });
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();

    await expect(cb.execute(async () => 'ok')).rejects.toThrow('Circuit breaker "test" is open');
  });

  it('transitions to half-open after reset timeout', async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1100);

    // Next call should go through (half-open)
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');

    vi.useRealTimers();
  });

  it('re-opens if half-open call fails', async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    vi.advanceTimersByTime(1100);

    await expect(cb.execute(async () => { throw new Error('still broken'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    vi.useRealTimers();
  });

  it('reset() restores to closed', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });

  it('respects custom isFailure predicate', async () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      isFailure: (err) => err instanceof Error && err.message.includes('transient'),
    });

    // Non-matching error should not increment failure count
    await expect(cb.execute(async () => { throw new Error('auth error'); })).rejects.toThrow();
    expect(cb.getState()).toBe('closed');

    // Matching error should trigger open
    await expect(cb.execute(async () => { throw new Error('transient failure'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
  });
});
