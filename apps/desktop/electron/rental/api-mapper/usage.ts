import type { DesktopRentalUsageSnapshot } from "../../ipc-types.js";

import { mapApiQuotaSnapshot } from "./quota.js";
import { isObject, isoOrNull, readNumber, readString } from "./primitives.js";

// ---------------------------------------------------------------------------
// UsageSnapshot (GET /api/rental/sessions/:id/usage — p2.11a)
// ---------------------------------------------------------------------------

/**
 * Map the snake_case `ApiSessionUsageSnapshot` (from p2.11a server
 * route) into the camelCase `DesktopRentalUsageSnapshot` the
 * renderer consumes. Defensive over missing fields; the route
 * already projects defaults, but the mapper still treats every
 * value as optional so a half-shaped server response never throws.
 *
 * `sessionId` is required (the snapshot is meaningless without it)
 * — the caller's session id is used as the fallback when the server
 * omits it.
 */
export function mapApiUsageSnapshot(
  raw: unknown,
  fallbackSessionId: string,
): DesktopRentalUsageSnapshot {
  const obj = isObject(raw) ? raw : {};
  return {
    sessionId:
      readString(obj, "session_id", "sessionId") ?? fallbackSessionId,
    lrtLimit: readNumber(obj, "lrt_limit", "lrtLimit"),
    lrtReserved: readNumber(obj, "lrt_reserved", "lrtReserved") ?? 0,
    lrtUsed: readNumber(obj, "lrt_used", "lrtUsed") ?? 0,
    lrtRemaining: readNumber(obj, "lrt_remaining", "lrtRemaining"),
    budgetStopThreshold: readNumber(
      obj,
      "budget_stop_threshold",
      "budgetStopThreshold",
    ),
    timeLimitMinutes: readNumber(obj, "time_limit_minutes", "timeLimitMinutes"),
    startedAt: isoOrNull(obj.started_at ?? obj.startedAt),
    endsAt: isoOrNull(obj.ends_at ?? obj.endsAt),
    quotaSnapshot: mapApiQuotaSnapshot(obj.quota_snapshot ?? obj.quotaSnapshot),
    updatedAt: isoOrNull(obj.updated_at ?? obj.updatedAt),
  };
}
