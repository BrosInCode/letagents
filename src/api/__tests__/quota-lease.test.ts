/**
 * Tests for the Quota Lease decision logic (p2.9 server-side slice).
 *
 * Covers:
 *   - laneKey / laneKeyOf canonicalization
 *   - createLease initializes lockedAt + lastRefreshedAt, snapshot copied
 *   - canCreateLease: available / lane_locked / same_session / invalid_lane
 *     and ignores released leases
 *   - refreshLease updates lastRefreshedAt + snapshot, immutable on input
 *   - releaseLease: idempotent (changed=false on re-release)
 *   - materiallyChanged for each of the 6 §7.5 trigger reasons +
 *     the all-clear case
 *
 * Pure decision logic — no DB, no clock dependency (callers
 * pass `nowIso` explicitly so the assertions stay deterministic).
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canCreateLease,
  createLease,
  laneKey,
  laneKeyOf,
  materiallyChanged,
  QUOTA_LEASE_REASONS,
  refreshLease,
  releaseLease,
  type QuotaLane,
  type QuotaLease,
  type QuotaLeaseSnapshot,
} from "../rental/quota-lease.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-11T10:00:00.000Z";

function makeSnapshot(
  overrides: Partial<QuotaLeaseSnapshot> = {},
): QuotaLeaseSnapshot {
  return {
    nativeUnit: "tokens",
    nativeRemaining: 100_000,
    nativeResetAt: null,
    confidence: "local_exact",
    observedAt: NOW,
    ...overrides,
  };
}

function makeLease(
  overrides: Partial<QuotaLease> = {},
): QuotaLease {
  const base: QuotaLease = {
    sessionId: "rsess_1",
    lane: { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: "lane-a" },
    lockedAt: NOW,
    lastRefreshedAt: NOW,
    releasedAt: null,
    releaseReason: null,
    snapshot: makeSnapshot(),
  };
  return {
    ...base,
    ...overrides,
    lane: { ...base.lane, ...(overrides.lane ?? {}) },
    snapshot: { ...base.snapshot, ...(overrides.snapshot ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// laneKey
// ---------------------------------------------------------------------------

describe("laneKey", () => {
  it("joins provider + model with a stable separator", () => {
    assert.equal(laneKey("antigravity", "gemini-2.5-pro"), "antigravity::gemini-2.5-pro");
    assert.equal(laneKey("claude_code", null), "claude_code::");
    assert.equal(laneKeyOf({ provider: "cursor", model: null, quotaLaneId: null }), "cursor::");
  });

  it("treats null and undefined model identically (canonical empty string)", () => {
    assert.equal(laneKey("p", null), laneKey("p", null));
    assert.equal(laneKey("p", null), "p::");
  });
});

// ---------------------------------------------------------------------------
// createLease
// ---------------------------------------------------------------------------

describe("createLease", () => {
  it("initializes lockedAt + lastRefreshedAt + snapshot from input", () => {
    const lease = createLease({
      sessionId: "rsess_1",
      lane: { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null },
      snapshot: makeSnapshot({ nativeRemaining: 50_000 }),
      nowIso: NOW,
    });
    assert.equal(lease.sessionId, "rsess_1");
    assert.equal(lease.lockedAt, NOW);
    assert.equal(lease.lastRefreshedAt, NOW);
    assert.equal(lease.releasedAt, null);
    assert.equal(lease.releaseReason, null);
    assert.equal(lease.snapshot.nativeRemaining, 50_000);
  });

  it("copies the lane + snapshot (input mutation safety)", () => {
    const lane = { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null };
    const snapshot = makeSnapshot();
    const lease = createLease({ sessionId: "rsess_1", lane, snapshot, nowIso: NOW });
    lane.provider = "mutated";
    snapshot.nativeRemaining = 1;
    assert.equal(lease.lane.provider, "antigravity");
    assert.equal(lease.snapshot.nativeRemaining, 100_000);
  });
});

// ---------------------------------------------------------------------------
// canCreateLease
// ---------------------------------------------------------------------------

describe("canCreateLease", () => {
  it("returns available when no active leases hold the lane", () => {
    const decision = canCreateLease(
      [],
      { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null },
      "rsess_new",
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.AVAILABLE);
    assert.equal(decision.heldBy, null);
  });

  it("locks the lane when another session holds an active lease on the same provider+model", () => {
    const active = [makeLease({ sessionId: "rsess_other" })];
    const decision = canCreateLease(
      active,
      { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null },
      "rsess_new",
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.LANE_LOCKED);
    assert.equal(decision.heldBy, "rsess_other");
  });

  it("allows a different lane even when something else is locked", () => {
    const active = [makeLease({ sessionId: "rsess_other" })];
    const decision = canCreateLease(
      active,
      { provider: "antigravity", model: "gemini-2.5-flash", quotaLaneId: null },
      "rsess_new",
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.AVAILABLE);
  });

  it("returns same_session re-entry when the lease is already held by this session", () => {
    const active = [makeLease({ sessionId: "rsess_1" })];
    const decision = canCreateLease(
      active,
      { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null },
      "rsess_1",
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.SAME_SESSION);
    assert.equal(decision.heldBy, "rsess_1");
  });

  it("ignores released leases when scanning for locks", () => {
    const active = [
      makeLease({ sessionId: "rsess_old", releasedAt: NOW, releaseReason: "completed" }),
    ];
    const decision = canCreateLease(
      active,
      { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: null },
      "rsess_new",
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.AVAILABLE);
  });

  it("rejects invalid lanes (blank provider)", () => {
    const decision = canCreateLease(
      [],
      { provider: "", model: null, quotaLaneId: null },
      "rsess_new",
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, QUOTA_LEASE_REASONS.INVALID_LANE);
  });
});

// ---------------------------------------------------------------------------
// refreshLease
// ---------------------------------------------------------------------------

describe("refreshLease", () => {
  it("bumps lastRefreshedAt + replaces snapshot, keeps lockedAt", () => {
    const lease = makeLease({ lockedAt: NOW, lastRefreshedAt: NOW });
    const later = "2026-05-11T10:30:00.000Z";
    const refreshed = refreshLease(
      lease,
      makeSnapshot({ nativeRemaining: 90_000, observedAt: later }),
      later,
    );
    assert.equal(refreshed.lockedAt, NOW);
    assert.equal(refreshed.lastRefreshedAt, later);
    assert.equal(refreshed.snapshot.nativeRemaining, 90_000);
    assert.equal(refreshed.snapshot.observedAt, later);
  });

  it("does not mutate the input lease", () => {
    const lease = makeLease();
    const original = JSON.parse(JSON.stringify(lease));
    refreshLease(
      lease,
      makeSnapshot({ nativeRemaining: 1 }),
      "2026-05-11T11:00:00.000Z",
    );
    assert.deepEqual(lease, original);
  });
});

// ---------------------------------------------------------------------------
// releaseLease
// ---------------------------------------------------------------------------

describe("releaseLease", () => {
  it("sets releasedAt + reason on first release", () => {
    const lease = makeLease();
    const later = "2026-05-11T12:00:00.000Z";
    const { lease: released, changed } = releaseLease(lease, "completed", later);
    assert.equal(changed, true);
    assert.equal(released.releasedAt, later);
    assert.equal(released.releaseReason, "completed");
  });

  it("is idempotent: re-release returns changed=false and keeps the original timestamp", () => {
    const released = makeLease({
      releasedAt: "2026-05-11T12:00:00.000Z",
      releaseReason: "completed",
    });
    const result = releaseLease(released, "cancelled", "2026-05-11T13:00:00.000Z");
    assert.equal(result.changed, false);
    assert.equal(result.lease.releasedAt, "2026-05-11T12:00:00.000Z");
    assert.equal(result.lease.releaseReason, "completed");
  });
});

// ---------------------------------------------------------------------------
// materiallyChanged (§7.5)
// ---------------------------------------------------------------------------

describe("materiallyChanged", () => {
  it("returns no change when both leases are equivalent", () => {
    const prev = makeLease();
    const next = makeLease();
    const result = materiallyChanged(prev, next);
    assert.equal(result.changed, false);
    assert.deepEqual(result.reasons, []);
  });

  it("flags provider_changed", () => {
    const prev = makeLease();
    const next = makeLease({ lane: { provider: "claude_code", model: "gemini-2.5-pro", quotaLaneId: "lane-a" } });
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("provider_changed"));
  });

  it("flags model_changed", () => {
    const prev = makeLease();
    const next = makeLease({ lane: { provider: "antigravity", model: "gemini-2.5-flash", quotaLaneId: "lane-a" } });
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("model_changed"));
  });

  it("flags quota_lane_id_changed", () => {
    const prev = makeLease();
    const next = makeLease({ lane: { provider: "antigravity", model: "gemini-2.5-pro", quotaLaneId: "lane-b" } });
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("quota_lane_id_changed"));
  });

  it("flags confidence_downgraded for ≥2 ladder steps", () => {
    const prev = makeLease({ snapshot: makeSnapshot({ confidence: "local_exact" }) });
    const next = makeLease({ snapshot: makeSnapshot({ confidence: "estimated" }) });
    // local_exact (idx 5) → estimated (idx 2) = 3 step drop
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("confidence_downgraded"));
  });

  it("does NOT flag confidence_downgraded for a single-step drop", () => {
    const prev = makeLease({ snapshot: makeSnapshot({ confidence: "local_exact" }) });
    const next = makeLease({ snapshot: makeSnapshot({ confidence: "derived" }) });
    // local_exact (5) → derived (4) = 1 step
    const result = materiallyChanged(prev, next);
    assert.ok(!result.reasons.includes("confidence_downgraded"));
  });

  it("flags native_remaining_dropped when remaining halves on the same unit", () => {
    const prev = makeLease({ snapshot: makeSnapshot({ nativeRemaining: 100_000 }) });
    const next = makeLease({ snapshot: makeSnapshot({ nativeRemaining: 40_000 }) });
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("native_remaining_dropped"));
  });

  it("does NOT flag native_remaining_dropped when units differ", () => {
    const prev = makeLease({
      snapshot: makeSnapshot({ nativeUnit: "tokens", nativeRemaining: 100_000 }),
    });
    const next = makeLease({
      snapshot: makeSnapshot({ nativeUnit: "percent_window", nativeRemaining: 0.4 }),
    });
    const result = materiallyChanged(prev, next);
    assert.ok(!result.reasons.includes("native_remaining_dropped"));
  });

  it("flags native_reset_at_changed when reset moved", () => {
    const prev = makeLease({
      snapshot: makeSnapshot({ nativeResetAt: "2026-05-11T18:00:00.000Z" }),
    });
    const next = makeLease({
      snapshot: makeSnapshot({ nativeResetAt: "2026-05-12T18:00:00.000Z" }),
    });
    const result = materiallyChanged(prev, next);
    assert.ok(result.reasons.includes("native_reset_at_changed"));
  });

  it("does NOT flag native_reset_at_changed when both sides are null", () => {
    const prev = makeLease({ snapshot: makeSnapshot({ nativeResetAt: null }) });
    const next = makeLease({ snapshot: makeSnapshot({ nativeResetAt: null }) });
    const result = materiallyChanged(prev, next);
    assert.ok(!result.reasons.includes("native_reset_at_changed"));
  });

  it("collects multiple reasons when multiple changes happen at once", () => {
    const prev = makeLease({
      snapshot: makeSnapshot({ confidence: "local_exact", nativeRemaining: 100_000 }),
    });
    const next = makeLease({
      lane: { provider: "antigravity", model: "gemini-2.5-flash", quotaLaneId: "lane-b" },
      snapshot: makeSnapshot({
        confidence: "estimated",
        nativeRemaining: 10_000,
        nativeResetAt: "2026-05-12T00:00:00.000Z",
      }),
    });
    const result = materiallyChanged(prev, next);
    assert.equal(result.changed, true);
    assert.ok(result.reasons.includes("model_changed"));
    assert.ok(result.reasons.includes("quota_lane_id_changed"));
    assert.ok(result.reasons.includes("confidence_downgraded"));
    assert.ok(result.reasons.includes("native_remaining_dropped"));
    assert.ok(result.reasons.includes("native_reset_at_changed"));
  });
});
