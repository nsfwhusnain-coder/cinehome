/**
 * Generic in-memory fixed-window rate limiter (KD-sec fix #4).
 *
 * Mirrors the pattern already used for login/register in
 * `src/lib/login-rate-limit.ts` — a plain module-level `Map`, suitable for a
 * single-container household deployment. State resets on process restart;
 * that's an accepted trade-off for this deployment model (documented on the
 * existing limiter too), not something this module needs to solve.
 *
 * Use one `RateLimiter` instance per "thing you want to bound" (e.g. one for
 * full/uncached playback resolves, a separate tighter one for admin-only
 * force-refreshes) rather than a single shared instance for everything, so
 * limits don't bleed into each other.
 */

export interface RateLimiterOptions {
  /** Max requests allowed per key inside one window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Upper bound on tracked keys before pruning the oldest (memory/abuse safety). */
  maxEntries?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window if allowed; 0 if not. */
  remaining: number;
  /** Ms until the current window resets (0 when allowed with room to spare). */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const PRUNE_INTERVAL_MS = 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private lastPruneAt = 0;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private isExpired(bucket: Bucket, now: number): boolean {
    return now - bucket.windowStartedAt >= this.windowMs;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;

    for (const [key, bucket] of this.buckets) {
      if (this.isExpired(bucket, now)) this.buckets.delete(key);
    }
    if (this.buckets.size <= this.maxEntries) return;

    // Drop oldest windows first when over cap (probe / abuse safety).
    const entries = Array.from(this.buckets.entries()).sort(
      (a, b) => a[1].windowStartedAt - b[1].windowStartedAt
    );
    const toDrop = this.buckets.size - this.maxEntries;
    for (let i = 0; i < toDrop; i++) {
      const key = entries[i]?.[0];
      if (key !== undefined) this.buckets.delete(key);
    }
  }

  /** Checks quota for `key` and, if allowed, consumes one unit. */
  consume(key: string, now: number = Date.now()): RateLimitResult {
    this.maybePrune(now);

    const existing = this.buckets.get(key);
    const bucket: Bucket =
      !existing || this.isExpired(existing, now)
        ? { count: 0, windowStartedAt: now }
        : existing;

    if (bucket.count >= this.limit) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, this.windowMs - (now - bucket.windowStartedAt)),
      };
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterMs: 0,
    };
  }

  /** Read-only check — does not consume quota. Useful for pre-flight UI checks. */
  peek(key: string, now: number = Date.now()): RateLimitResult {
    const existing = this.buckets.get(key);
    if (!existing || this.isExpired(existing, now)) {
      return { allowed: true, remaining: this.limit, retryAfterMs: 0 };
    }
    if (existing.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, this.windowMs - (now - existing.windowStartedAt)),
      };
    }
    return { allowed: true, remaining: this.limit - existing.count, retryAfterMs: 0 };
  }

  /** Clears quota usage for one key (e.g. after a legitimate success). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Test/diagnostic helper — number of currently tracked keys. */
  size(): number {
    return this.buckets.size;
  }
}
