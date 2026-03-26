// ---------------------------------------------------------------------------
// Tests — Request Correlation ID
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  generateCorrelationId,
  withCorrelation,
  getCorrelationContext,
  getCorrelationId,
} from './correlation';

describe('correlation', () => {
  it('generateCorrelationId returns a UUID string', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });

  it('withCorrelation provides context within callback', () => {
    const ctx = { correlationId: 'test-123', userId: 'user-1' };
    withCorrelation(ctx, () => {
      expect(getCorrelationContext()).toEqual(ctx);
      expect(getCorrelationId()).toBe('test-123');
    });
  });

  it('context is undefined outside withCorrelation', () => {
    expect(getCorrelationContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('nested contexts are isolated', () => {
    withCorrelation({ correlationId: 'outer' }, () => {
      expect(getCorrelationId()).toBe('outer');

      withCorrelation({ correlationId: 'inner' }, () => {
        expect(getCorrelationId()).toBe('inner');
      });

      // outer context restored after inner exits
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('returns the value from the callback', () => {
    const result = withCorrelation({ correlationId: 'ctx1' }, () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from the callback', () => {
    expect(() =>
      withCorrelation({ correlationId: 'err-ctx' }, () => {
        throw new Error('test error');
      }),
    ).toThrow('test error');
  });

  it('context includes conversationId when provided', () => {
    const ctx = { correlationId: 'c1', userId: 'u1', conversationId: 'conv-1' };
    withCorrelation(ctx, () => {
      expect(getCorrelationContext()?.conversationId).toBe('conv-1');
    });
  });

  it('async functions preserve context', async () => {
    await new Promise<void>(resolve => {
      withCorrelation({ correlationId: 'async-test' }, () => {
        setTimeout(() => {
          expect(getCorrelationId()).toBe('async-test');
          resolve();
        }, 10);
      });
    });
  });
});
