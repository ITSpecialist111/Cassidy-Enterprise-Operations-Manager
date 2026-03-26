// ---------------------------------------------------------------------------
// Tests — Per-User Rate Limiter
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from './rateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000, maxUsers: 10 });
  });

  it('allows requests under the limit', () => {
    expect(limiter.check('user1').allowed).toBe(true);
    expect(limiter.check('user1').allowed).toBe(true);
    expect(limiter.check('user1').allowed).toBe(true);
  });

  it('blocks requests over the limit', () => {
    limiter.check('user1');
    limiter.check('user1');
    limiter.check('user1');
    const result = limiter.check('user1');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('tracks users independently', () => {
    limiter.check('user1');
    limiter.check('user1');
    limiter.check('user1');
    // user2 should still have full quota
    expect(limiter.check('user2').allowed).toBe(true);
  });

  it('returns correct remaining count', () => {
    expect(limiter.getRemaining('user1')).toBe(3);
    limiter.check('user1');
    expect(limiter.getRemaining('user1')).toBe(2);
    limiter.check('user1');
    expect(limiter.getRemaining('user1')).toBe(1);
    limiter.check('user1');
    expect(limiter.getRemaining('user1')).toBe(0);
  });

  it('reports tracked user count', () => {
    limiter.check('user1');
    limiter.check('user2');
    expect(limiter.getTrackedUsers()).toBe(2);
  });

  it('evicts oldest user when maxUsers exceeded', () => {
    // Fill up to maxUsers
    for (let i = 0; i < 10; i++) {
      limiter.check(`user${i}`);
    }
    expect(limiter.getTrackedUsers()).toBe(10);

    // Adding one more should evict the oldest
    limiter.check('new-user');
    expect(limiter.getTrackedUsers()).toBe(10); // still 10 after eviction
  });

  it('resets all tracking data', () => {
    limiter.check('user1');
    limiter.check('user2');
    limiter.reset();
    expect(limiter.getTrackedUsers()).toBe(0);
    expect(limiter.getRemaining('user1')).toBe(3);
  });

  it('allows requests again after window expires', async () => {
    const shortLimiter = new RateLimiter({ maxRequests: 1, windowMs: 50 });
    shortLimiter.check('user1');
    expect(shortLimiter.check('user1').allowed).toBe(false);

    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(shortLimiter.check('user1').allowed).toBe(true);
  });

  it('retryAfterMs is within window range', () => {
    limiter.check('user1');
    limiter.check('user1');
    limiter.check('user1');
    const result = limiter.check('user1');
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
    }
  });

  it('handles new user with full remaining', () => {
    expect(limiter.getRemaining('never-seen')).toBe(3);
  });
});
