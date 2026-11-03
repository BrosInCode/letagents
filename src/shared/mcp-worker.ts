/**
 * How often a worker's `last_used_at` is written while room tools run as it.
 * It orders which handles a remote credential keeps, so recency reads the
 * stored time plus this interval.
 */
export const WORKER_USE_RECORD_INTERVAL_MS = 60_000;

/** Durable worker identity is separate from the random MCP process identity. */
export function isMcpWorkerId(value: unknown): value is string {
  return typeof value === "string" && /^worker_[a-f0-9]{32}$/.test(value);
}

export function isMcpConnectionToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
