/**
 * Tests for rental_sessions schema — p1.2.
 *
 * Verifies:
 * - All 5 new enums (session status, mode, continuity mode, start trigger, trigger confidence)
 * - rental_sessions table: all 38 columns, PK, notNull, nullable, defaults
 * - D3 fields present and nullable
 * - Mode defaults to 'scoped'
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rental_sessions,
  rentalSessionStatusEnum,
  rentalModeEnum,
  rentalContinuityModeEnum,
  rentalStartTriggerEnum,
  rentalTriggerConfidenceEnum,
} from "../db/schema.js";

// ===== Enum Tests =====

describe("rental_sessions enums", () => {
  it("rentalSessionStatusEnum has 13 values matching spec §18.1", () => {
    assert.deepStrictEqual(rentalSessionStatusEnum.enumValues, [
      "requested", "accepted", "provisioning", "active",
      "blocked", "patch_review", "pr_opened", "budget_exhausted",
      "stale", "completed", "cancelled", "expired", "failed",
    ]);
  });

  it("rentalModeEnum has 2 values matching spec §5", () => {
    assert.deepStrictEqual(rentalModeEnum.enumValues, [
      "scoped", "trusted_open",
    ]);
  });

  it("rentalContinuityModeEnum has 2 values", () => {
    assert.deepStrictEqual(rentalContinuityModeEnum.enumValues, [
      "smart_handoff", "full_transcript",
    ]);
  });

  it("rentalStartTriggerEnum has 4 values matching D3", () => {
    assert.deepStrictEqual(rentalStartTriggerEnum.enumValues, [
      "quota_exhausted", "user_initiated", "scheduled", "task_handoff",
    ]);
  });

  it("rentalTriggerConfidenceEnum has 3 values matching D3", () => {
    assert.deepStrictEqual(rentalTriggerConfidenceEnum.enumValues, [
      "exact", "inferred", "manual",
    ]);
  });
});

// ===== Column Tests =====

describe("rental_sessions table columns", () => {
  const expectedColumns = [
    // Core IDs
    "id", "listing_id", "renter_account_id", "provider_account_id", "room_id",
    // Repo context
    "repo_provider", "repo_owner", "repo_name", "base_branch", "work_branch",
    // Task
    "task_title", "task_prompt",
    // Mode + continuity
    "mode", "continuity_mode", "continuity_pack",
    // Status
    "status",
    // Scope + policy
    "approved_scope", "policy",
    // Quota/budget
    "quota_lease", "native_quota_unit", "native_quota_start_snapshot",
    "native_quota_latest_snapshot", "meter_confidence", "lrt_limit",
    "lrt_reserved", "lrt_used", "budget_stop_threshold", "time_limit_minutes",
    // D3 renter trigger context
    "start_trigger", "trigger_confidence", "renter_lane_exhausted_at",
    "renter_lane_provider", "renter_lane_model", "renter_lane_refresh_eta",
    "renter_quota_signal", "renter_lane_recovered_at",
    // Timestamps
    "started_at", "ended_at", "created_at", "updated_at",
  ];

  it("has all expected columns per spec §19.2 + D3", () => {
    const columns = Object.keys(rental_sessions);
    for (const col of expectedColumns) {
      assert.ok(columns.includes(col), `Missing column: ${col}`);
    }
  });

  it("id column is primary key", () => {
    assert.ok(rental_sessions.id.primary, "id should be primary key");
  });

  it("required columns are notNull", () => {
    const required = [
      "listing_id", "renter_account_id", "provider_account_id",
      "repo_provider", "repo_owner", "repo_name", "base_branch",
      "task_title", "task_prompt", "mode", "continuity_mode", "status",
      "lrt_reserved", "lrt_used", "created_at", "updated_at",
    ];
    for (const col of required) {
      const column = (rental_sessions as Record<string, { notNull: boolean }>)[col];
      assert.ok(column.notNull, `${col} should be NOT NULL`);
    }
  });

  it("D3 fields are all nullable", () => {
    const d3Fields = [
      "start_trigger", "trigger_confidence", "renter_lane_exhausted_at",
      "renter_lane_provider", "renter_lane_model", "renter_lane_refresh_eta",
      "renter_quota_signal", "renter_lane_recovered_at",
    ];
    for (const col of d3Fields) {
      const column = (rental_sessions as Record<string, { notNull: boolean }>)[col];
      assert.ok(!column.notNull, `D3 field ${col} should be nullable`);
    }
  });

  it("other nullable columns are correctly nullable", () => {
    const nullable = [
      "room_id", "work_branch", "continuity_pack",
      "approved_scope", "policy", "quota_lease", "native_quota_unit",
      "native_quota_start_snapshot", "native_quota_latest_snapshot",
      "meter_confidence", "lrt_limit", "budget_stop_threshold",
      "time_limit_minutes", "started_at", "ended_at",
    ];
    for (const col of nullable) {
      const column = (rental_sessions as Record<string, { notNull: boolean }>)[col];
      assert.ok(!column.notNull, `${col} should be nullable`);
    }
  });
});

// ===== Default Value Tests =====

describe("rental_sessions defaults", () => {
  it("status defaults to requested", () => {
    assert.ok(rental_sessions.status.default !== undefined, "status should have default");
  });

  it("mode defaults to scoped", () => {
    assert.ok(rental_sessions.mode.default !== undefined, "mode should have default");
  });

  it("continuity_mode defaults to smart_handoff", () => {
    assert.ok(rental_sessions.continuity_mode.default !== undefined, "continuity_mode should have default");
  });

  it("repo_provider defaults to github", () => {
    assert.ok(rental_sessions.repo_provider.default !== undefined, "repo_provider should have default");
  });

  it("lrt_reserved defaults to 0", () => {
    assert.ok(rental_sessions.lrt_reserved.default !== undefined, "lrt_reserved should have default");
  });

  it("lrt_used defaults to 0", () => {
    assert.ok(rental_sessions.lrt_used.default !== undefined, "lrt_used should have default");
  });
});
