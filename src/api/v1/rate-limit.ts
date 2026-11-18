import { RATE_CLASSES, type RateClass } from "../../../shared/api/core.mjs";

export type ApiRateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface ApiRateLimiter {
  /** Counts one call by this actor in this class. */
  take(actorKey: string, rateClass: RateClass): ApiRateDecision;
  readonly size: number;
}

export interface ApiRateLimiterOptions {
  classes?: Readonly<Record<RateClass, { readonly limit: number; readonly windowMs: number }>>;
  now?: () => number;
  /** Buckets held before expired ones are swept, so one-off actors do not grow memory without bound. */
  maxEntries?: number;
}

/**
 * A fixed window per (actor, rate class), in memory in one process, like the
 * renter listings limiter (routes/rental/renter/rate-limiter.ts), but it also
 * says when the window reopens, for `retryAfterMs`.
 */
export function createApiRateLimiter(options: ApiRateLimiterOptions = {}): ApiRateLimiter {
  const classes = options.classes ?? RATE_CLASSES;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const buckets = new Map<string, { count: number; windowStart: number; windowMs: number }>();

  const sweepExpired = (t: number) => {
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= bucket.windowMs) buckets.delete(key);
    }
  };

  return {
    take(actorKey, rateClass) {
      const { limit, windowMs } = classes[rateClass];
      const key = `${rateClass}\u0000${actorKey}`;
      const t = now();
      const bucket = buckets.get(key);
      if (!bucket || t - bucket.windowStart >= windowMs) {
        if (!bucket && buckets.size >= maxEntries) sweepExpired(t);
        buckets.set(key, { count: 1, windowStart: t, windowMs });
        return { allowed: true };
      }
      if (bucket.count >= limit) return { allowed: false, retryAfterMs: Math.max(0, bucket.windowStart + windowMs - t) };
      bucket.count += 1;
      return { allowed: true };
    },
    get size() {
      return buckets.size;
    },
  };
}
