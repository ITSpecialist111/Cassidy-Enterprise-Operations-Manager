// ---------------------------------------------------------------------------
// Per-User Rate Limiter — sliding-window in-memory
// ---------------------------------------------------------------------------
// Protects OpenAI quota from spam by limiting messages per user per window.
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Maximum requests allowed per window. Default: 20 */
  maxRequests?: number;
  /** Window size in ms. Default: 60_000 (1 minute) */
  windowMs?: number;
  /** Max number of tracked users (LRU eviction). Default: 5000 */
  maxUsers?: number;
}

interface UserBucket {
  timestamps: number[];
  lastAccess: number;
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxUsers: number;
  private readonly buckets = new Map<string, UserBucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? (Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 20);
    this.windowMs = options.windowMs ?? (Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000);
    this.maxUsers = options.maxUsers ?? 5000;
  }

  /**
   * Check whether a request from `userId` is allowed.
   * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
   */
  check(userId: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      this.evictIfNeeded();
      bucket = { timestamps: [], lastAccess: now };
      this.buckets.set(userId, bucket);
    }

    // Prune timestamps outside the current window
    const cutoff = now - this.windowMs;
    bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);
    bucket.lastAccess = now;

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldest = bucket.timestamps[0];
      const retryAfterMs = oldest + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    bucket.timestamps.push(now);
    return { allowed: true };
  }

  /** Remove the oldest-accessed users when we exceed maxUsers */
  private evictIfNeeded(): void {
    if (this.buckets.size < this.maxUsers) return;

    // Find the least recently accessed user
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess < oldestTime) {
        oldestTime = bucket.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }

  /** Current count of tracked user ids */
  getTrackedUsers(): number { return this.buckets.size; }

  /** Remaining requests for a user in the current window */
  getRemaining(userId: string): number {
    const bucket = this.buckets.get(userId);
    if (!bucket) return this.maxRequests;
    const cutoff = Date.now() - this.windowMs;
    const active = bucket.timestamps.filter(t => t > cutoff).length;
    return Math.max(this.maxRequests - active, 0);
  }

  /** Reset all tracking data */
  reset(): void { this.buckets.clear(); }
}

/** Shared instance used by the agent message handler */
export const userRateLimiter = new RateLimiter();
