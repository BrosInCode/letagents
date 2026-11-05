export type ListingsRateLimiter = (renterKey: string) => boolean;

/** The in-memory limiter also tells how many buckets it holds (tests and diagnostics). */
export interface InMemoryListingsRateLimiter extends ListingsRateLimiter {
  readonly size: number;
}

// ===== Rate limiter (token-bucket-ish, in-memory) =====

export interface ListingsRateLimiterOptions {
  /** Max queries per window. Defaults to 30. */
  capacity?: number;
  /** Window length in ms. Defaults to 60_000 (1 minute). */
  windowMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Buckets held before expired ones are swept. A key not seen before, arriving
   * when this many buckets are held, first drops every bucket whose window has
   * passed, so a long-lived process with many one-off keys (credentials,
   * addresses, client IPs) does not grow without bound. Live buckets are never
   * dropped, so no answer changes. Defaults to 10_000.
   */
  maxEntries?: number;
}

interface BucketState {
  count: number;
  windowStart: number;
}

/**
 * Per-renter token bucket. Caps `capacity` requests per `windowMs`.
 * Pure in-memory; one process. Good enough for V1 anti-enumeration.
 * Production hardening (Redis/distributed) lands in pc.4.
 */
export function buildInMemoryListingsRateLimiter(
  options: ListingsRateLimiterOptions = {}
): InMemoryListingsRateLimiter {
  const capacity = options.capacity ?? 30;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const buckets = new Map<string, BucketState>();

  const sweepExpired = (t: number): void => {
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= windowMs) buckets.delete(key);
    }
  };

  const allow = (renterKey: string): boolean => {
    const t = now();
    const bucket = buckets.get(renterKey);
    if (!bucket || t - bucket.windowStart >= windowMs) {
      // An expired bucket is reset in place; a new key may first make room.
      if (!bucket && buckets.size >= maxEntries) sweepExpired(t);
      buckets.set(renterKey, { count: 1, windowStart: t });
      return true;
    }
    if (bucket.count >= capacity) {
      return false;
    }
    bucket.count += 1;
    return true;
  };
  return Object.defineProperty(allow, "size", { get: () => buckets.size, enumerable: true }) as InMemoryListingsRateLimiter;
}
