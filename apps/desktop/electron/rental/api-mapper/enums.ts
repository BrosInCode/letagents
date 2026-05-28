import type {
  DesktopRentalActivitySource,
  DesktopRentalActivityVisibility,
  DesktopRentalContinuityIngestDepth,
  DesktopRentalContinuityMode,
  DesktopRentalListingStatus,
  DesktopRentalMeterConfidence,
  DesktopRentalMode,
  DesktopRentalNativeQuotaUnit,
  DesktopRentalPatchCheckResult,
  DesktopRentalPatchGateStatus,
  DesktopRentalPatchSource,
  DesktopRentalProviderReadinessCheck,
  DesktopRentalReadinessStatus,
  DesktopRentalSessionStatus,
  DesktopRentalStartTrigger,
  DesktopRentalTriggerConfidence,
  DesktopRentalVerificationStatus,
} from "../../ipc-types.js";

// ---------------------------------------------------------------------------
// Enum coercion
// ---------------------------------------------------------------------------

export const LISTING_STATUSES: readonly DesktopRentalListingStatus[] = [
  "active",
  "paused",
  "disabled",
  "setup_required",
];

export const VERIFICATION_STATUSES: readonly DesktopRentalVerificationStatus[] = [
  "verified",
  "partially_verified",
  "experimental",
  "unreachable",
];

export const METER_CONFIDENCES: readonly DesktopRentalMeterConfidence[] = [
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
];

export const NATIVE_UNITS: readonly DesktopRentalNativeQuotaUnit[] = [
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
];

export const SESSION_STATUSES: readonly DesktopRentalSessionStatus[] = [
  "requested",
  "accepted",
  "provisioning",
  "active",
  "blocked",
  "patch_review",
  "pr_opened",
  "budget_exhausted",
  "stale",
  "completed",
  "cancelled",
  "expired",
  "failed",
];

export const MODES: readonly DesktopRentalMode[] = ["scoped", "trusted_open"];
export const CONTINUITY_MODES: readonly DesktopRentalContinuityMode[] = [
  "smart_handoff",
  "full_transcript",
];
export const CONTINUITY_INGEST_DEPTHS: readonly DesktopRentalContinuityIngestDepth[] = [
  "tier_1",
  "tier_2",
];
export const START_TRIGGERS: readonly DesktopRentalStartTrigger[] = [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
];
export const TRIGGER_CONFIDENCES: readonly DesktopRentalTriggerConfidence[] = [
  "exact",
  "inferred",
  "manual",
];
export const ACTIVITY_SOURCES: readonly DesktopRentalActivitySource[] = [
  "agent",
  "tool",
  "patch_gate",
  "system",
  "renter",
  "provider",
];
export const ACTIVITY_VISIBILITIES: readonly DesktopRentalActivityVisibility[] = [
  "renter",
  "provider",
  "both",
  "internal",
  "rental_visible",
];
export const PATCH_SOURCES: readonly DesktopRentalPatchSource[] = [
  "signed_change_journal",
  "explicit_patch",
  "raw_diff",
];
export const PATCH_GATE_STATUSES: readonly DesktopRentalPatchGateStatus[] = [
  "pending",
  "passed",
  "passed_with_warnings",
  "needs_renter_approval",
  "rejected",
  "needs_revision",
  "timed_out",
];
export const PATCH_CHECK_STATUSES: readonly DesktopRentalPatchCheckResult["status"][] = [
  "pending",
  "running",
  "passed",
  "warning",
  "failed",
  "skipped",
];

export const PROVIDER_READINESS_STATUSES: readonly DesktopRentalReadinessStatus[] = [
  "ready",
  "degraded",
  "blocked",
  "unknown",
];

export const PROVIDER_READINESS_CHECK_STATUSES: readonly DesktopRentalProviderReadinessCheck["status"][] = [
  "passed",
  "warning",
  "failed",
  "unknown",
];
