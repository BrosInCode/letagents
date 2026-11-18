import { RATE_CLASSES, type RateClass } from "../../../shared/api/core.mjs";

export type ApiRateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface ApiRateLimiter {
  /** Counts one call by this caller in this class. */
  take(callerKey: string, rateClass: RateClass): ApiRateDecision;
  readonly size: number;
}

export interface ApiRateLimiterOptions {
  classes?: Readonly<Record<RateClass, { readonly limit: number; readonly windowMs: number }>>;
  now?: () => number;
  /** Buckets held at most; a new caller beyond it drops the least recently started window. */
  maxEntries?: number;
}

/**
 * A fixed window per (caller, rate class), in memory in one process. The Map
 * keeps buckets in the order their windows started, so the first entry is the
 * one to drop when full: no scan, and memory stays bounded however many
 * one-off callers arrive.
 */
export function createApiRateLimiter(options: ApiRateLimiterOptions = {}): ApiRateLimiter {
  const classes = options.classes ?? RATE_CLASSES;
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? 10_000);
  const buckets = new Map<string, { count: number; windowStart: number }>();

  return {
    take(callerKey, rateClass) {
      const { limit, windowMs } = classes[rateClass];
      const key = `${rateClass}\u0000${callerKey}`;
      const t = now();
      const bucket = buckets.get(key);
      if (bucket && t - bucket.windowStart < windowMs) {
        if (bucket.count >= limit) return { allowed: false, retryAfterMs: Math.max(0, bucket.windowStart + windowMs - t) };
        bucket.count += 1;
        return { allowed: true };
      }
      // A new window moves the bucket to the end of the Map.
      buckets.delete(key);
      if (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value!);
      buckets.set(key, { count: 1, windowStart: t });
      return { allowed: true };
    },
    get size() {
      return buckets.size;
    },
  };
}
