/**
 * Simple in-memory rate limiter for rental API endpoints.
 *
 * Uses a sliding window counter per IP/account. Designed for
 * single-instance deployments. For multi-instance, swap to Redis.
 */

import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000).unref();

/**
 * Create a rate limiter middleware.
 *
 * @param windowMs - Time window in milliseconds.
 * @param maxRequests - Max requests per window per key.
 * @param keyFn - Function to extract the rate limit key from the request.
 */
export function rateLimit(options: {
  windowMs: number;
  maxRequests: number;
  keyFn?: (req: Request) => string;
}) {
  const { windowMs, maxRequests, keyFn } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn
      ? keyFn(req)
      : (req as any).sessionAccount?.account_id ||
        req.ip ||
        req.headers["x-forwarded-for"] ||
        "unknown";

    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      // New window
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", maxRequests - 1);
      return next();
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfterMs = entry.resetAt - now;
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", 0);
      return res.status(429).json({
        error: "Too many requests",
        retry_after_seconds: Math.ceil(retryAfterMs / 1000),
      });
    }

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", maxRequests - entry.count);
    next();
  };
}

// ─── Pre-built limiters for rental endpoints ────────────────

/** Listing creation: 5 per minute per account */
export const listingCreateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 5,
});

/** Session creation: 10 per minute per account */
export const sessionCreateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 10,
});

/** Heartbeat: 120 per minute per account (2/sec) */
export const heartbeatLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 120,
});

/** Generic read: 60 per minute per IP */
export const readLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 60,
  keyFn: (req) => req.ip || "unknown",
});
