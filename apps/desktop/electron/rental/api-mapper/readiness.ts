import type {
  DesktopRentalProviderReadiness,
  DesktopRentalProviderReadinessCheck,
} from "../../ipc-types.js";

import {
  PROVIDER_READINESS_CHECK_STATUSES,
  PROVIDER_READINESS_STATUSES,
} from "./enums.js";
import {
  coerceFromList,
  isObject,
  isoOrNull,
  readString,
  readStringArray,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Provider readiness (p2.15)
// ---------------------------------------------------------------------------

function mapApiReadinessCheck(
  raw: unknown,
): DesktopRentalProviderReadinessCheck | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  const label = readString(raw, "label");
  if (!id || !label) return null;
  const status = coerceFromList(
    raw.status,
    PROVIDER_READINESS_CHECK_STATUSES,
    "unknown",
  );
  return {
    id,
    label,
    status,
    detail: readString(raw, "detail"),
  };
}

/**
 * p2.15 — map the server's `ApiProviderReadiness` (snake_case wire
 * shape from `GET /api/rental/provider/readiness`) into the desktop
 * `DesktopRentalProviderReadiness`. Defensive: returns an `unknown`
 * status with empty arrays when the body is malformed.
 */
export function mapApiProviderReadiness(
  raw: unknown,
): DesktopRentalProviderReadiness {
  if (!isObject(raw)) {
    return {
      status: "unknown",
      summary: null,
      blockers: [],
      warnings: [],
      badges: [],
      checks: [],
      lastCheckedAt: null,
    };
  }
  const checksRaw = raw.checks ?? raw.checksList;
  const checks: DesktopRentalProviderReadinessCheck[] = Array.isArray(checksRaw)
    ? checksRaw
        .map(mapApiReadinessCheck)
        .filter((c): c is DesktopRentalProviderReadinessCheck => c !== null)
    : [];
  return {
    status: coerceFromList(raw.status, PROVIDER_READINESS_STATUSES, "unknown"),
    summary: readString(raw, "summary"),
    blockers: readStringArray(raw, "blockers"),
    warnings: readStringArray(raw, "warnings"),
    badges: readStringArray(raw, "badges"),
    checks,
    lastCheckedAt: isoOrNull(raw.last_checked_at ?? raw.lastCheckedAt),
  };
}
