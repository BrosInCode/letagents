import type {
  DesktopRentalIdeKind,
  DesktopRentalPolicy,
  DesktopRentalQuotaLease,
  DesktopRentalScope,
  DesktopRentalSession,
} from "../../ipc-types.js";

import {
  CONTINUITY_INGEST_DEPTHS,
  CONTINUITY_MODES,
  METER_CONFIDENCES,
  MODES,
  NATIVE_UNITS,
  SESSION_STATUSES,
  START_TRIGGERS,
  TRIGGER_CONFIDENCES,
} from "./enums.js";
import { mapApiQuotaSnapshot } from "./quota.js";
import {
  coerceFromList,
  coerceFromListOrNull,
  isObject,
  isoOrNull,
  nonNullIso,
  readBool,
  readJsonObject,
  readNumber,
  readString,
  readStringArray,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function mapApiScope(raw: unknown): DesktopRentalScope {
  const obj = isObject(raw) ? raw : {};
  return {
    includePaths: readStringArray(obj, "include_paths", "includePaths"),
    excludePaths: readStringArray(obj, "exclude_paths", "excludePaths"),
    protectedPaths: readStringArray(obj, "protected_paths", "protectedPaths"),
    notes: readString(obj, "notes"),
  };
}
function mapApiPolicy(raw: unknown): DesktopRentalPolicy {
  const obj = isObject(raw) ? raw : {};
  return {
    maxLrt: readNumber(obj, "max_lrt", "maxLrt"),
    maxDurationMinutes: readNumber(
      obj,
      "max_duration_minutes",
      "maxDurationMinutes",
    ),
    maxPatchBytes: readNumber(obj, "max_patch_bytes", "maxPatchBytes"),
    allowCommands: readBool(obj, false, "allow_commands", "allowCommands"),
    allowNetwork: readBool(obj, false, "allow_network", "allowNetwork"),
    requirePatchGate: readBool(
      obj,
      true,
      "require_patch_gate",
      "requirePatchGate",
    ),
  };
}

function mapApiQuotaLease(raw: unknown): DesktopRentalQuotaLease | null {
  if (!isObject(raw)) return null;
  // The server-side lease shape (per p2.9a/b) has `lockedAt`,
  // `lastRefreshedAt`, `lane`, `snapshot`. The desktop's
  // DesktopRentalQuotaLease shape predates that and uses a flatter
  // (id, laneId, lrtLimit, …) layout. Map what we can; expose null
  // for the lifecycle-only fields the desktop UI doesn't render yet.
  return {
    id: readString(raw, "id", "session_id", "sessionId") ?? "lease",
    laneId:
      readString(raw, "lane_id", "laneId")
      ?? (isObject(raw.lane) ? readString(raw.lane, "quota_lane_id", "quotaLaneId") : null),
    lrtLimit: readNumber(raw, "lrt_limit", "lrtLimit"),
    lrtReserved: readNumber(raw, "lrt_reserved", "lrtReserved") ?? 0,
    lrtUsed: readNumber(raw, "lrt_used", "lrtUsed") ?? 0,
    expiresAt: isoOrNull(raw.expires_at ?? raw.expiresAt ?? raw.released_at),
    updatedAt: isoOrNull(
      raw.updated_at
      ?? raw.updatedAt
      ?? raw.last_refreshed_at
      ?? raw.lastRefreshedAt,
    ),
  };
}

export function mapApiSession(raw: unknown): DesktopRentalSession | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    listingId: readString(raw, "listing_id", "listingId") ?? "",
    renterAccountId: readString(raw, "renter_account_id", "renterAccountId"),
    providerAccountId: readString(raw, "provider_account_id", "providerAccountId"),
    roomIdentifier: readString(raw, "room_id", "roomId", "room_identifier"),
    repoProvider: readString(raw, "repo_provider", "repoProvider"),
    repoOwner: readString(raw, "repo_owner", "repoOwner"),
    repoName: readString(raw, "repo_name", "repoName"),
    baseBranch: readString(raw, "base_branch", "baseBranch"),
    workBranch: readString(raw, "work_branch", "workBranch"),
    taskTitle: readString(raw, "task_title", "taskTitle") ?? "",
    taskPrompt: readString(raw, "task_prompt", "taskPrompt") ?? "",
    mode: coerceFromList(raw.mode, MODES, "scoped"),
    continuityMode: coerceFromList(
      raw.continuity_mode ?? raw.continuityMode,
      CONTINUITY_MODES,
      "smart_handoff",
    ),
    continuityIngestDepth: coerceFromList(
      raw.continuity_ingest_depth ?? raw.continuityIngestDepth,
      CONTINUITY_INGEST_DEPTHS,
      "tier_1",
    ),
    continuityPackId:
      readString(raw, "continuity_pack_id", "continuityPackId")
      ?? (isObject(raw.continuity_pack)
        ? readString(raw.continuity_pack, "packId", "pack_id", "id")
        : null),
    status: coerceFromList(raw.status, SESSION_STATUSES, "requested"),
    approvedScope: mapApiScope(raw.approved_scope ?? raw.approvedScope),
    policy: mapApiPolicy(raw.policy),
    quotaLease: mapApiQuotaLease(raw.quota_lease ?? raw.quotaLease),
    nativeQuotaUnit: coerceFromList(
      raw.native_quota_unit ?? raw.nativeQuotaUnit,
      NATIVE_UNITS,
      "unknown",
    ),
    nativeQuotaStartSnapshot: mapApiQuotaSnapshot(
      raw.native_quota_start_snapshot ?? raw.nativeQuotaStartSnapshot,
    ),
    nativeQuotaLatestSnapshot: mapApiQuotaSnapshot(
      raw.native_quota_latest_snapshot ?? raw.nativeQuotaLatestSnapshot,
    ),
    meterConfidence: coerceFromList(
      raw.meter_confidence ?? raw.meterConfidence,
      METER_CONFIDENCES,
      "unknown",
    ),
    lrtLimit: readNumber(raw, "lrt_limit", "lrtLimit"),
    lrtReserved: readNumber(raw, "lrt_reserved", "lrtReserved") ?? 0,
    lrtUsed: readNumber(raw, "lrt_used", "lrtUsed") ?? 0,
    lrtRemaining: readNumber(raw, "lrt_remaining", "lrtRemaining"),
    budgetStopThreshold: readNumber(
      raw,
      "budget_stop_threshold",
      "budgetStopThreshold",
    ),
    timeLimitMinutes: readNumber(
      raw,
      "time_limit_minutes",
      "timeLimitMinutes",
    ),
    startTrigger: coerceFromListOrNull(
      raw.start_trigger ?? raw.startTrigger,
      START_TRIGGERS,
    ),
    triggerConfidence: coerceFromListOrNull(
      raw.trigger_confidence ?? raw.triggerConfidence,
      TRIGGER_CONFIDENCES,
    ),
    renterLaneExhaustedAt: isoOrNull(
      raw.renter_lane_exhausted_at ?? raw.renterLaneExhaustedAt,
    ),
    renterLaneProvider: readString(
      raw,
      "renter_lane_provider",
      "renterLaneProvider",
    ),
    renterLaneModel: readString(raw, "renter_lane_model", "renterLaneModel"),
    renterLaneRefreshEta: isoOrNull(
      raw.renter_lane_refresh_eta ?? raw.renterLaneRefreshEta,
    ),
    renterQuotaSignal: readJsonObject(
      raw,
      "renter_quota_signal",
      "renterQuotaSignal",
    ),
    renterLaneRecoveredAt: isoOrNull(
      raw.renter_lane_recovered_at ?? raw.renterLaneRecoveredAt,
    ),
    startedAt: isoOrNull(raw.started_at ?? raw.startedAt),
    endedAt: isoOrNull(raw.ended_at ?? raw.endedAt),
    createdAt: isoOrNull(raw.created_at ?? raw.createdAt),
    updatedAt: nonNullIso(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}
