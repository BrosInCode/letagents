/**
 * Pure projection from a `rental_sessions` row to the desktop
 * `DesktopRentalUsageSnapshot` shape (p2.11a).
 *
 * Lives in its own module so the test suite can exercise the
 * projection without the DB import surface. The route handler in
 * `rental-renter.ts` calls `getSessionById` (auth-gated) and feeds
 * the row through {@link projectSessionUsage}.
 *
 * Spec references:
 *   - §6 (Quota + LRT budget) — `lrt_*`, `budget_stop_threshold`
 *   - §7 (Renter session) — `time_limit_minutes`, `started_at`
 *   - §18.3 (Liveness) — `ended_at` (graceful) vs derived deadline
 *   - §19.2 (D3) — `native_quota_latest_snapshot` jsonb shape
 */

import type { rental_sessions } from "../db/schema.js";

type SessionRow = typeof rental_sessions.$inferSelect;

/**
 * Wire shape for `GET /api/rental/sessions/:id/usage`.
 *
 * Mirrors `DesktopRentalUsageSnapshot` so the desktop's
 * `mapApiUsageSnapshot` only needs to swap snake_case → camelCase.
 * Kept in snake_case here to match the rest of the rental REST
 * surface; the desktop mapper handles the case conversion.
 */
export interface ApiSessionUsageSnapshot {
  session_id: string;
  lrt_limit: number | null;
  lrt_reserved: number;
  lrt_used: number;
  lrt_remaining: number | null;
  budget_stop_threshold: number | null;
  time_limit_minutes: number | null;
  started_at: string | null;
  ends_at: string | null;
  quota_snapshot: Record<string, unknown> | null;
  updated_at: string | null;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function numericOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compute the deadline implied by `started_at + time_limit_minutes`.
 * Returns null if either input is missing. The `ended_at` column
 * trumps this projection: a graceful end sets the row's `ended_at`
 * and `endsAt` should reflect that instead of the time-budget
 * deadline.
 */
export function computeEndsAt(
  startedAt: Date | string | null | undefined,
  endedAt: Date | string | null | undefined,
  timeLimitMinutes: number | null | undefined,
): string | null {
  const ended = isoOrNull(endedAt);
  if (ended) return ended;
  const started = isoOrNull(startedAt);
  if (!started) return null;
  if (timeLimitMinutes === null || timeLimitMinutes === undefined) return null;
  const startedMs = Date.parse(started);
  if (!Number.isFinite(startedMs)) return null;
  const deadlineMs = startedMs + timeLimitMinutes * 60_000;
  return new Date(deadlineMs).toISOString();
}

/**
 * Compute `lrt_remaining = lrt_limit - (lrt_used + lrt_reserved)`,
 * clamped at 0. Returns null when no limit is set (unbounded budget).
 */
export function computeLrtRemaining(
  lrtLimit: number | null,
  lrtUsed: number,
  lrtReserved: number,
): number | null {
  if (lrtLimit === null) return null;
  return Math.max(0, lrtLimit - lrtUsed - lrtReserved);
}

/**
 * Project a `rental_sessions` row into the usage snapshot wire shape.
 *
 * Pure / synchronous / no DB or network reads. All inputs come from
 * the row passed in. The route handler is responsible for auth
 * gating before calling this projector.
 */
export function projectSessionUsage(session: SessionRow): ApiSessionUsageSnapshot {
  const quotaSnapshot =
    session.native_quota_latest_snapshot &&
    typeof session.native_quota_latest_snapshot === "object" &&
    !Array.isArray(session.native_quota_latest_snapshot)
      ? (session.native_quota_latest_snapshot as Record<string, unknown>)
      : null;

  const lrtLimit = session.lrt_limit ?? null;
  const lrtReserved = session.lrt_reserved ?? 0;
  const lrtUsed = session.lrt_used ?? 0;

  return {
    session_id: session.id,
    lrt_limit: lrtLimit,
    lrt_reserved: lrtReserved,
    lrt_used: lrtUsed,
    lrt_remaining: computeLrtRemaining(lrtLimit, lrtUsed, lrtReserved),
    budget_stop_threshold: numericOrNull(session.budget_stop_threshold),
    time_limit_minutes: session.time_limit_minutes ?? null,
    started_at: isoOrNull(session.started_at),
    ends_at: computeEndsAt(
      session.started_at,
      session.ended_at,
      session.time_limit_minutes,
    ),
    quota_snapshot: quotaSnapshot,
    updated_at: isoOrNull(session.updated_at),
  };
}
