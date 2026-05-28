import { pgEnum } from "drizzle-orm/pg-core";

export const rentalVisibilityEnum = pgEnum("rental_visibility", [
  "rental_visible",
  "renter_only",
  "provider_only",
  "internal",
]);

export const rentalListingStatusEnum = pgEnum("rental_listing_status", [
  "active",
  "paused",
  "disabled",
  "setup_required",
]);

export const rentalVerificationStatusEnum = pgEnum("rental_verification_status", [
  "verified",
  "partially_verified",
  "experimental",
  "unreachable",
]);

export const rentalMeterConfidenceEnum = pgEnum("rental_meter_confidence", [
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
]);

export const rentalNativeQuotaUnitEnum = pgEnum("rental_native_quota_unit", [
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
]);

export const rentalSessionStatusEnum = pgEnum("rental_session_status", [
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
]);

export const rentalModeEnum = pgEnum("rental_mode", [
  "scoped",
  "trusted_open",
]);

export const rentalContinuityModeEnum = pgEnum("rental_continuity_mode", [
  "smart_handoff",
  "full_transcript",
]);

export const rentalStartTriggerEnum = pgEnum("rental_start_trigger", [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
]);

export const rentalTriggerConfidenceEnum = pgEnum("rental_trigger_confidence", [
  "exact",
  "inferred",
  "manual",
]);

export const rentalActivitySourceEnum = pgEnum("rental_activity_source", [
  "agent",
  "tool",
  "patch_gate",
  "system",
  "renter",
  "provider",
]);

/**
 * Source of a `rental_usage_meters` row per spec §19.6:
 *   adapter       — desktop-side meter adapter snapshot
 *   tool          — MCP `rental_report_usage` call
 *   self_reported — rented agent's own usage claim
 *   system        — server-side bookkeeping
 */
export const rentalUsageMeterSourceEnum = pgEnum("rental_usage_meter_source", [
  "adapter",
  "tool",
  "self_reported",
  "system",
]);

export const rentalPatchProposalSourceEnum = pgEnum("rental_patch_proposal_source", [
  "signed_change_journal",
  "explicit_patch",
  "raw_diff",
]);

export const rentalPatchGateStatusEnum = pgEnum("rental_patch_gate_status", [
  "pending",
  "passed",
  "passed_with_warnings",
  "needs_renter_approval",
  "rejected",
  "needs_revision",
  "timed_out",
]);

export const rentalWorkspaceRetentionStatusEnum = pgEnum(
  "rental_workspace_retention_status",
  ["active", "archived", "expired", "deleted"],
);

export const rentalExposureTypeEnum = pgEnum("rental_exposure_type", [
  "file",
  "search_result",
  "directory_listing",
  "command_output",
]);

export const rentalSecretScanStatusEnum = pgEnum("rental_secret_scan_status", [
  "passed",
  "redacted",
  "blocked",
]);
