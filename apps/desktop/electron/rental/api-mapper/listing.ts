import type {
  DesktopRentalIdeKind,
  DesktopRentalListing,
  DesktopRentalMode,
} from "../../ipc-types.js";

import {
  LISTING_STATUSES,
  METER_CONFIDENCES,
  MODES,
  NATIVE_UNITS,
  VERIFICATION_STATUSES,
} from "./enums.js";
import { mapApiQuotaSnapshot } from "./quota.js";
import {
  coerceFromList,
  isObject,
  isoOrNull,
  nonNullIso,
  readBool,
  readNumber,
  readString,
  readStringArray,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function mapApiListing(raw: unknown): DesktopRentalListing | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    providerAccountId: readString(raw, "provider_account_id", "providerAccountId"),
    providerDisplayName: readString(
      raw,
      "provider_display_name",
      "providerDisplayName",
    ),
    displayName: readString(raw, "display_name", "displayName") ?? "Rental listing",
    status: coerceFromList(raw.status, LISTING_STATUSES, "setup_required"),
    verificationStatus: coerceFromList(
      raw.verification_status ?? raw.verificationStatus,
      VERIFICATION_STATUSES,
      "experimental",
    ),
    readinessBadges: readStringArray(raw, "readiness_badges", "readinessBadges"),
    readiness: null, // Server doesn't currently return the readiness object inline.
    ideKind: (readString(raw, "ide_kind", "ideKind") ?? "unknown") as DesktopRentalIdeKind,
    modelLabel: readString(raw, "model_label", "modelLabel"),
    quotaLaneId: readString(raw, "quota_lane_id", "quotaLaneId"),
    quotaLaneLabel: readString(raw, "quota_lane_label", "quotaLaneLabel"),
    meterConfidence: coerceFromList(
      raw.meter_confidence ?? raw.meterConfidence,
      METER_CONFIDENCES,
      "unknown",
    ),
    nativeQuotaUnit: coerceFromList(
      raw.native_quota_unit ?? raw.nativeQuotaUnit,
      NATIVE_UNITS,
      "unknown",
    ),
    lastNativeQuotaSnapshot: mapApiQuotaSnapshot(
      raw.last_native_quota_snapshot ?? raw.lastNativeQuotaSnapshot,
    ),
    lastLrtEstimate: readNumber(raw, "last_lrt_estimate", "lastLrtEstimate"),
    lastQuotaResetAt: isoOrNull(raw.last_quota_reset_at ?? raw.lastQuotaResetAt),
    verifiedAgentFingerprintId: readString(
      raw,
      "verified_agent_fingerprint_id",
      "verifiedAgentFingerprintId",
    ),
    supportedModes: (readStringArray(
      raw,
      "supported_modes",
      "supportedModes",
    ).filter((m) => (MODES as readonly string[]).includes(m)) as DesktopRentalMode[]),
    maxConcurrentSessions:
      readNumber(raw, "max_concurrent_sessions", "maxConcurrentSessions") ?? 1,
    activeSessionCount:
      readNumber(raw, "active_session_count", "activeSessionCount") ?? 0,
    defaultLrtLimit: readNumber(raw, "default_lrt_limit", "defaultLrtLimit"),
    defaultTimeLimitMinutes: readNumber(
      raw,
      "default_time_limit_minutes",
      "defaultTimeLimitMinutes",
    ),
    manualAcceptRequired: readBool(
      raw,
      true,
      "manual_accept_required",
      "manualAcceptRequired",
    ),
    createdAt: isoOrNull(raw.created_at ?? raw.createdAt),
    updatedAt: nonNullIso(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}
