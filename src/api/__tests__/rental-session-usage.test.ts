import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeEndsAt,
  computeLrtRemaining,
  projectSessionUsage,
} from "../rental/session-usage.js";
import type { rental_sessions } from "../db/schema.js";

type SessionRow = typeof rental_sessions.$inferSelect;

function baseSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "rsess_42",
    listing_id: "listing_1",
    renter_account_id: "acct_renter",
    provider_account_id: "acct_provider",
    room_id: "room_1",
    repo_provider: "github",
    repo_owner: "owner",
    repo_name: "repo",
    base_branch: "main",
    work_branch: null,
    task_title: "task",
    task_prompt: "do the thing",
    mode: "scoped",
    continuity_mode: "smart_handoff",
    continuity_pack: null,
    status: "active",
    approved_scope: null,
    policy: null,
    quota_lease: null,
    native_quota_unit: null,
    native_quota_start_snapshot: null,
    native_quota_latest_snapshot: null,
    meter_confidence: null,
    lrt_limit: 10_000,
    lrt_reserved: 0,
    lrt_used: 2_500,
    budget_stop_threshold: "0.95" as unknown as string | null,
    time_limit_minutes: 60,
    start_trigger: null,
    trigger_confidence: null,
    renter_lane_exhausted_at: null,
    renter_lane_provider: null,
    renter_lane_model: null,
    renter_lane_refresh_eta: null,
    renter_quota_signal: null,
    renter_lane_recovered_at: null,
    heartbeat_count: 0,
    last_heartbeat_at: null,
    started_at: new Date("2026-05-12T10:00:00.000Z"),
    ended_at: null,
    created_at: new Date("2026-05-12T09:00:00.000Z"),
    updated_at: new Date("2026-05-12T10:30:00.000Z"),
    ...overrides,
  } as SessionRow;
}

// ---------------------------------------------------------------------------
// computeLrtRemaining
// ---------------------------------------------------------------------------

test("computeLrtRemaining returns null when limit is null (unbounded)", () => {
  assert.equal(computeLrtRemaining(null, 1000, 0), null);
});

test("computeLrtRemaining subtracts used and reserved from limit", () => {
  assert.equal(computeLrtRemaining(10_000, 2_500, 500), 7_000);
});

test("computeLrtRemaining clamps at zero on overspend", () => {
  assert.equal(computeLrtRemaining(10_000, 9_000, 2_000), 0);
});

test("computeLrtRemaining ignores no reservations cleanly", () => {
  assert.equal(computeLrtRemaining(10_000, 0, 0), 10_000);
});

// ---------------------------------------------------------------------------
// computeEndsAt
// ---------------------------------------------------------------------------

test("computeEndsAt prefers ended_at when present", () => {
  const ended = computeEndsAt(
    new Date("2026-05-12T10:00:00.000Z"),
    new Date("2026-05-12T10:25:00.000Z"),
    60,
  );
  assert.equal(ended, "2026-05-12T10:25:00.000Z");
});

test("computeEndsAt projects started_at + time_limit_minutes when not ended", () => {
  const ends = computeEndsAt(
    new Date("2026-05-12T10:00:00.000Z"),
    null,
    60,
  );
  assert.equal(ends, "2026-05-12T11:00:00.000Z");
});

test("computeEndsAt returns null when started_at is null", () => {
  assert.equal(computeEndsAt(null, null, 60), null);
});

test("computeEndsAt returns null when time_limit_minutes is null", () => {
  assert.equal(
    computeEndsAt(new Date("2026-05-12T10:00:00.000Z"), null, null),
    null,
  );
});

test("computeEndsAt accepts ISO string inputs", () => {
  const ends = computeEndsAt("2026-05-12T10:00:00.000Z", null, 30);
  assert.equal(ends, "2026-05-12T10:30:00.000Z");
});

// ---------------------------------------------------------------------------
// projectSessionUsage
// ---------------------------------------------------------------------------

test("projectSessionUsage projects a normal active session", () => {
  const snapshot = projectSessionUsage(baseSession());
  assert.equal(snapshot.session_id, "rsess_42");
  assert.equal(snapshot.lrt_limit, 10_000);
  assert.equal(snapshot.lrt_reserved, 0);
  assert.equal(snapshot.lrt_used, 2_500);
  assert.equal(snapshot.lrt_remaining, 7_500);
  assert.equal(snapshot.budget_stop_threshold, 0.95);
  assert.equal(snapshot.time_limit_minutes, 60);
  assert.equal(snapshot.started_at, "2026-05-12T10:00:00.000Z");
  assert.equal(snapshot.ends_at, "2026-05-12T11:00:00.000Z");
  assert.equal(snapshot.quota_snapshot, null);
  assert.equal(snapshot.updated_at, "2026-05-12T10:30:00.000Z");
});

test("projectSessionUsage handles unbounded lrt_limit", () => {
  const snapshot = projectSessionUsage(
    baseSession({ lrt_limit: null, lrt_used: 5000, lrt_reserved: 100 }),
  );
  assert.equal(snapshot.lrt_limit, null);
  assert.equal(snapshot.lrt_remaining, null);
});

test("projectSessionUsage exposes the latest native quota snapshot when present", () => {
  const snapshot = projectSessionUsage(
    baseSession({
      native_quota_latest_snapshot: {
        provider: "antigravity",
        nativeUnit: "percent_window",
        nativeRemaining: 0.2,
      },
    }),
  );
  assert.deepEqual(snapshot.quota_snapshot, {
    provider: "antigravity",
    nativeUnit: "percent_window",
    nativeRemaining: 0.2,
  });
});

test("projectSessionUsage rejects non-object quota snapshot values", () => {
  const snapshot = projectSessionUsage(
    baseSession({
      native_quota_latest_snapshot: ["not", "an", "object"] as unknown as Record<
        string,
        unknown
      >,
    }),
  );
  assert.equal(snapshot.quota_snapshot, null);
});

test("projectSessionUsage prefers ended_at over the projected deadline", () => {
  const snapshot = projectSessionUsage(
    baseSession({
      started_at: new Date("2026-05-12T10:00:00.000Z"),
      ended_at: new Date("2026-05-12T10:20:00.000Z"),
      time_limit_minutes: 60,
    }),
  );
  assert.equal(snapshot.ends_at, "2026-05-12T10:20:00.000Z");
});

test("projectSessionUsage returns null timestamps when not yet started", () => {
  const snapshot = projectSessionUsage(
    baseSession({ started_at: null, ended_at: null }),
  );
  assert.equal(snapshot.started_at, null);
  assert.equal(snapshot.ends_at, null);
});

test("projectSessionUsage clamps remaining at zero on overspend", () => {
  const snapshot = projectSessionUsage(
    baseSession({ lrt_limit: 100, lrt_used: 90, lrt_reserved: 50 }),
  );
  assert.equal(snapshot.lrt_remaining, 0);
});

test("projectSessionUsage exposes default zero reserved/used on fresh rows", () => {
  const snapshot = projectSessionUsage(
    baseSession({ lrt_used: 0, lrt_reserved: 0 }),
  );
  assert.equal(snapshot.lrt_reserved, 0);
  assert.equal(snapshot.lrt_used, 0);
  assert.equal(snapshot.lrt_remaining, 10_000);
});

test("projectSessionUsage handles missing budget_stop_threshold", () => {
  const snapshot = projectSessionUsage(
    baseSession({ budget_stop_threshold: null }),
  );
  assert.equal(snapshot.budget_stop_threshold, null);
});
