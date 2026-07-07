import type {
  NativeQuotaSnapshot,
  QuotaConfidence,
  QuotaUnit,
} from "../../../shared/rental/meter-types.js";
import {
  acquireLease,
  defaultQuotaLeaseOrchestratorDeps,
  releaseSessionLease,
  type AcquireLeaseFailure,
  type QuotaLeaseOrchestratorDeps,
} from "../quota-lease-orchestrator.js";
import { laneCapacity } from "../quota-lease.js";
import type {
  QuotaLane,
  QuotaLease,
  QuotaLeaseSnapshot,
} from "../quota-lease.js";
import type {
  RentalListingRow,
  RentalSessionRow,
} from "./types.js";

const QUOTA_CONFIDENCE_VALUES = new Set<QuotaConfidence>([
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
]);

const QUOTA_UNIT_VALUES = new Set<QuotaUnit>([
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
]);

type SessionLeaseInput = Pick<RentalSessionRow, "id" | "room_id">;

type ListingLeaseInput = Pick<
  RentalListingRow,
  | "provider_account_id"
  | "ide_kind"
  | "model_label"
  | "quota_lane_id"
  | "native_quota_unit"
  | "last_native_quota_snapshot"
  | "last_quota_reset_at"
  | "meter_confidence"
  | "max_concurrent_sessions"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function confidenceOrUnknown(value: unknown): QuotaConfidence {
  return typeof value === "string" && QUOTA_CONFIDENCE_VALUES.has(value as QuotaConfidence)
    ? value as QuotaConfidence
    : "unknown";
}

function unitOrUnknown(value: unknown): QuotaUnit {
  return typeof value === "string" && QUOTA_UNIT_VALUES.has(value as QuotaUnit)
    ? value as QuotaUnit
    : "unknown";
}

export function buildQuotaLeaseInput(
  session: SessionLeaseInput,
  listing: ListingLeaseInput,
  nowIso: string = new Date().toISOString(),
): {
  sessionId: string;
  roomId: string | null;
  lane: QuotaLane;
  snapshot: QuotaLeaseSnapshot;
  laneCapacity: number;
} {
  const rawSnapshot = isRecord(listing.last_native_quota_snapshot)
    ? listing.last_native_quota_snapshot as Partial<NativeQuotaSnapshot>
    : null;
  const rawResetAt = stringOrNull(rawSnapshot?.nativeResetAt)
    ?? listing.last_quota_reset_at?.toISOString()
    ?? null;
  const confidence = confidenceOrUnknown(
    rawSnapshot?.confidence ?? listing.meter_confidence,
  );

  return {
    sessionId: session.id,
    roomId: session.room_id,
    lane: {
      provider: listing.ide_kind,
      model: listing.model_label ?? null,
      quotaLaneId: listing.quota_lane_id ?? null,
      // Scope the lane to its owner: different providers listing the
      // same ide_kind/model draw on independent quotas and must not
      // contend for one global lane.
      providerAccountId: listing.provider_account_id ?? null,
    },
    snapshot: {
      nativeUnit: unitOrUnknown(rawSnapshot?.nativeUnit ?? listing.native_quota_unit),
      nativeRemaining: finiteNumberOrNull(rawSnapshot?.nativeRemaining),
      nativeResetAt: rawResetAt,
      confidence,
      observedAt: stringOrNull(rawSnapshot?.observedAt) ?? nowIso,
    },
    // Capacity is unlocked only when BOTH the vetted listing enum
    // column and the (provider-attested) snapshot confidence are exact
    // — the snapshot alone cannot raise concurrency.
    laneCapacity: laneCapacity(
      listing.max_concurrent_sessions,
      confidenceOrUnknown(listing.meter_confidence),
      confidence,
    ),
  };
}

export function quotaLeaseError(result: AcquireLeaseFailure): Error {
  const conflict = result.conflictingSessionId
    ? ` held_by=${result.conflictingSessionId}`
    : "";
  return new Error(`quota_lease_${result.reason}${conflict}`);
}

export async function acquireQuotaLeaseForSession(
  session: SessionLeaseInput,
  listing: ListingLeaseInput,
  deps: QuotaLeaseOrchestratorDeps = defaultQuotaLeaseOrchestratorDeps,
): Promise<QuotaLease> {
  const result = await acquireLease(buildQuotaLeaseInput(session, listing, deps.now()), deps);
  if (!result.ok) {
    throw quotaLeaseError(result);
  }
  return result.lease;
}

export async function releaseQuotaLeaseForSession(
  session: SessionLeaseInput,
  reason: string,
  deps: QuotaLeaseOrchestratorDeps = defaultQuotaLeaseOrchestratorDeps,
): Promise<void> {
  await releaseSessionLease({
    sessionId: session.id,
    roomId: session.room_id,
    reason,
  }, deps);
}
