export type ListingsRateLimiter = (renterKey: string) => boolean;

// ===== Rate limiter (token-bucket-ish, in-memory) =====

export interface ListingsRateLimiterOptions {
  /** Max queries per window. Defaults to 30. */
  capacity?: number;
  /** Window length in ms. Defaults to 60_000 (1 minute). */
  windowMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
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
): ListingsRateLimiter {
  const capacity = options.capacity ?? 30;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, BucketState>();

  return (renterKey: string): boolean => {
    const t = now();
    const bucket = buckets.get(renterKey);
    if (!bucket || t - bucket.windowStart >= windowMs) {
      buckets.set(renterKey, { count: 1, windowStart: t });
      return true;
    }
    if (bucket.count >= capacity) {
      return false;
    }
    bucket.count += 1;
    return true;
  };
}
