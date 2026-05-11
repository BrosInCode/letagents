/**
 * Tests for the Budget Sentinel decision logic (p2.8 server-side slice).
 *
 * Covers:
 *   - effectiveLrtCeiling math (§17.13 + per-session override)
 *   - resolveStopThresholdFraction (override / confidence default / unknown)
 *   - isMeterStale / staleAgeMs (staleMs window)
 *   - authorize:
 *       • happy path (allowed, ceiling math correct)
 *       • step_cost_invalid (negative / NaN)
 *       • budget_exhausted (status flag)
 *       • no_lrt_limit (lrtLimit null/0)
 *       • ceiling_exceeded (would push past ceiling)
 *       • meter_stale_conservative (refuses past stale fraction)
 *       • fresh meter does not trigger conservative gating
 *   - applyReservation (bumps reserved, clamps negatives)
 *   - applyReconciliation:
 *       • subtracts reserved, adds used
 *       • becameExhausted toggle when used >= ceiling
 *       • no transition when already exhausted
 *       • clamps reservedDelta to current lrtReserved
 *
 * Pure decision logic — no DB, no HTTP, no clock dependency
 * (callers pass `nowMs` explicitly so tests stay deterministic).
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyReconciliation,
  applyReservation,
  authorize,
  BUDGET_SENTINEL_REASONS,
  effectiveLrtCeiling,
  isMeterStale,
  resolveStopThresholdFraction,
  staleAgeMs,
  type BudgetSentinelState,
} from "../rental/budget-sentinel.js";

// ---------------------------------------------------------------------------
// State builder
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<BudgetSentinelState> = {},
): BudgetSentinelState {
  return {
    sessionId: "rsess_1",
    status: "active",
    lrtLimit: 100_000,
    budgetStopThreshold: null,
    lrtReserved: 0,
    lrtUsed: 0,
    meterConfidence: "estimated",
    lastMeterAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

const REFERENCE_NOW = Date.parse("2026-05-11T10:00:05.000Z");

// ---------------------------------------------------------------------------
// resolveStopThresholdFraction
// ---------------------------------------------------------------------------

describe("resolveStopThresholdFraction", () => {
  it("returns the §17.13 default for each confidence value", () => {
    assert.equal(
      resolveStopThresholdFraction(
        makeState({ meterConfidence: "official_exact" }),
      ),
      0.98,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({ meterConfidence: "local_exact" }),
      ),
      0.98,
    );
    assert.equal(
      resolveStopThresholdFraction(makeState({ meterConfidence: "derived" })),
      0.95,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({ meterConfidence: "calibrated" }),
      ),
      0.92,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({ meterConfidence: "estimated" }),
      ),
      0.87,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({ meterConfidence: "weak_estimate" }),
      ),
      0.8,
    );
    assert.equal(
      resolveStopThresholdFraction(makeState({ meterConfidence: "unknown" })),
      0.75,
    );
  });

  it("falls back to unknown when meterConfidence is null", () => {
    assert.equal(
      resolveStopThresholdFraction(makeState({ meterConfidence: null })),
      0.75,
    );
  });

  it("uses the per-session budget_stop_threshold when present", () => {
    assert.equal(
      resolveStopThresholdFraction(
        makeState({
          meterConfidence: "local_exact",
          budgetStopThreshold: 0.5,
        }),
      ),
      0.5,
      "override beats the local_exact default of 0.98",
    );
  });

  it("ignores nonsensical override values (≤0, >1, NaN)", () => {
    assert.equal(
      resolveStopThresholdFraction(
        makeState({
          meterConfidence: "local_exact",
          budgetStopThreshold: 0,
        }),
      ),
      0.98,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({
          meterConfidence: "local_exact",
          budgetStopThreshold: 1.5,
        }),
      ),
      0.98,
    );
    assert.equal(
      resolveStopThresholdFraction(
        makeState({
          meterConfidence: "local_exact",
          budgetStopThreshold: NaN,
        }),
      ),
      0.98,
    );
  });
});

// ---------------------------------------------------------------------------
// effectiveLrtCeiling
// ---------------------------------------------------------------------------

describe("effectiveLrtCeiling", () => {
  it("returns floor(limit × confidence_fraction)", () => {
    assert.equal(
      effectiveLrtCeiling(
        makeState({ lrtLimit: 100_000, meterConfidence: "estimated" }),
      ),
      87_000,
    );
    assert.equal(
      effectiveLrtCeiling(
        makeState({ lrtLimit: 100_000, meterConfidence: "local_exact" }),
      ),
      98_000,
    );
  });

  it("applies budgetStopThreshold override when set", () => {
    assert.equal(
      effectiveLrtCeiling(
        makeState({ lrtLimit: 100_000, budgetStopThreshold: 0.5 }),
      ),
      50_000,
    );
  });

  it("returns 0 when lrtLimit is null / 0 / negative / NaN", () => {
    for (const lrtLimit of [null, 0, -10, NaN] as const) {
      assert.equal(
        effectiveLrtCeiling(makeState({ lrtLimit: lrtLimit as number | null })),
        0,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// isMeterStale / staleAgeMs
// ---------------------------------------------------------------------------

describe("meter staleness", () => {
  it("treats lastMeterAt == null as stale", () => {
    assert.equal(
      isMeterStale(makeState({ lastMeterAt: null }), REFERENCE_NOW),
      true,
    );
  });

  it("staleAgeMs returns -1 (finite sentinel) when lastMeterAt is missing/invalid", () => {
    // Important: must be finite so the value survives JSON
    // serialization through API routes without becoming `null`
    // (which is reserved for the "fresh meter" case).
    assert.equal(
      staleAgeMs(makeState({ lastMeterAt: null }), REFERENCE_NOW),
      -1,
    );
    assert.equal(
      staleAgeMs(makeState({ lastMeterAt: "not-a-date" }), REFERENCE_NOW),
      -1,
    );
    // null = fresh, -1 = unknown, finite = age. Distinguishable.
    const fresh = staleAgeMs(
      makeState({
        lastMeterAt: new Date(REFERENCE_NOW - 1_000).toISOString(),
      }),
      REFERENCE_NOW,
    );
    assert.equal(fresh, null);
  });

  it("returns false within the default 30s window", () => {
    const lastMeterAt = new Date(REFERENCE_NOW - 10_000).toISOString();
    assert.equal(
      isMeterStale(makeState({ lastMeterAt }), REFERENCE_NOW),
      false,
    );
    assert.equal(
      staleAgeMs(makeState({ lastMeterAt }), REFERENCE_NOW),
      null,
    );
  });

  it("returns true past the configured staleMs window", () => {
    const lastMeterAt = new Date(REFERENCE_NOW - 60_000).toISOString();
    assert.equal(
      isMeterStale(makeState({ lastMeterAt }), REFERENCE_NOW),
      true,
    );
    assert.equal(
      staleAgeMs(makeState({ lastMeterAt }), REFERENCE_NOW),
      60_000,
    );
  });

  it("respects a custom staleMs override", () => {
    const lastMeterAt = new Date(REFERENCE_NOW - 5_000).toISOString();
    assert.equal(
      isMeterStale(makeState({ lastMeterAt }), REFERENCE_NOW, {
        staleMs: 1_000,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

describe("authorize", () => {
  const inWindow = () => REFERENCE_NOW;

  it("allows a fresh-meter step inside the ceiling", () => {
    const decision = authorize(1_000, makeState(), {}, inWindow());
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, BUDGET_SENTINEL_REASONS.AUTHORIZED);
    assert.equal(decision.effectiveCeiling, 87_000);
    assert.equal(decision.reservedAfter, 1_000);
    assert.equal(decision.remaining, 87_000);
    assert.equal(decision.meterStale, false);
  });

  it("returns step_cost_invalid for negative or NaN cost", () => {
    assert.equal(
      authorize(-1, makeState(), {}, inWindow()).reason,
      BUDGET_SENTINEL_REASONS.STEP_COST_INVALID,
    );
    assert.equal(
      authorize(NaN, makeState(), {}, inWindow()).reason,
      BUDGET_SENTINEL_REASONS.STEP_COST_INVALID,
    );
  });

  it("denies with budget_exhausted when status flag is set", () => {
    const decision = authorize(
      0,
      makeState({ status: "budget_exhausted" }),
      {},
      inWindow(),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, BUDGET_SENTINEL_REASONS.BUDGET_EXHAUSTED);
  });

  it("denies with no_lrt_limit when no budget is configured", () => {
    const decision = authorize(
      1,
      makeState({ lrtLimit: null }),
      {},
      inWindow(),
    );
    assert.equal(decision.reason, BUDGET_SENTINEL_REASONS.NO_LRT_LIMIT);
  });

  it("denies with ceiling_exceeded when the step would push past the ceiling", () => {
    const decision = authorize(
      50_000,
      makeState({ lrtUsed: 40_000, lrtReserved: 0 }),
      {},
      inWindow(),
    );
    // Ceiling = 87_000, used = 40_000, step = 50_000 → 90_000 > 87_000.
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, BUDGET_SENTINEL_REASONS.CEILING_EXCEEDED);
  });

  it("denies with meter_stale_conservative past the stale fraction", () => {
    // staleMs default 30s; the snapshot is 60s old, so stale.
    // Conservative ceiling = 0.5 × 87_000 = 43_500.
    // Used 40_000 + step 10_000 = 50_000 > 43_500 → refuse.
    const lastMeterAt = new Date(REFERENCE_NOW - 60_000).toISOString();
    const decision = authorize(
      10_000,
      makeState({ lrtUsed: 40_000, lastMeterAt }),
      {},
      inWindow(),
    );
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.reason,
      BUDGET_SENTINEL_REASONS.METER_STALE_CONSERVATIVE,
    );
    assert.equal(decision.meterStale, true);
    assert.ok(decision.staleSinceMs !== null && decision.staleSinceMs >= 60_000);
  });

  it("allows a small step under the stale fraction even while meter is stale", () => {
    const lastMeterAt = new Date(REFERENCE_NOW - 60_000).toISOString();
    const decision = authorize(
      1_000,
      makeState({ lrtUsed: 10_000, lastMeterAt }),
      {},
      inWindow(),
    );
    // Conservative ceiling = 43_500, used 10_000 + step 1_000 = 11_000 ≤ 43_500.
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, BUDGET_SENTINEL_REASONS.AUTHORIZED);
    assert.equal(decision.meterStale, true);
  });
});

// ---------------------------------------------------------------------------
// applyReservation
// ---------------------------------------------------------------------------

describe("applyReservation", () => {
  it("bumps lrtReserved by the step cost", () => {
    const state = makeState({ lrtReserved: 0 });
    const result = applyReservation(2_500, state);
    assert.equal(result.state.lrtReserved, 2_500);
    assert.equal(result.reservedDelta, 2_500);
  });

  it("clamps negative / NaN to zero", () => {
    const state = makeState({ lrtReserved: 100 });
    assert.equal(applyReservation(-5, state).state.lrtReserved, 100);
    assert.equal(applyReservation(NaN, state).state.lrtReserved, 100);
  });

  it("does not mutate the input state", () => {
    const state = makeState({ lrtReserved: 100 });
    applyReservation(50, state);
    assert.equal(state.lrtReserved, 100, "input state unchanged");
  });
});

// ---------------------------------------------------------------------------
// applyReconciliation
// ---------------------------------------------------------------------------

describe("applyReconciliation", () => {
  it("releases reserved and bumps used", () => {
    const state = makeState({ lrtReserved: 1_000, lrtUsed: 5_000 });
    const result = applyReconciliation(900, 1_000, state);
    assert.equal(result.state.lrtReserved, 0);
    assert.equal(result.state.lrtUsed, 5_900);
    assert.equal(result.reservedDelta, 1_000);
    assert.equal(result.usedDelta, 900);
    assert.equal(result.becameExhausted, false);
  });

  it("transitions status → budget_exhausted when used crosses the ceiling", () => {
    // Ceiling at estimated confidence = 0.87 × 100_000 = 87_000.
    const state = makeState({
      lrtUsed: 86_000,
      lrtReserved: 1_500,
    });
    const result = applyReconciliation(1_500, 1_500, state);
    assert.equal(result.state.lrtUsed, 87_500);
    assert.equal(result.state.status, "budget_exhausted");
    assert.equal(result.becameExhausted, true);
  });

  it("transitions status → budget_exhausted when used + still-reserved crosses the ceiling", () => {
    // LivelyPeak's #379 finding: a multi-step reservation that
    // overruns its actuals leaves `used + reserved > ceiling` even
    // though `used` alone is still under. We must transition on
    // total committed, not just on used.
    //
    // Ceiling = 87_000.
    // Pre-state: used=50_000, reserved=40_000 (total 90_000 already
    // over ceiling — but the previous step was authorize'd before
    // a different reservation expanded the total). We reconcile a
    // small actual that releases only some of the placeholder.
    const state = makeState({
      lrtUsed: 50_000,
      lrtReserved: 40_000,
    });
    const result = applyReconciliation(/* actual */ 1_000, /* releasing */ 500, state);
    assert.equal(result.state.lrtUsed, 51_000);
    assert.equal(result.state.lrtReserved, 39_500);
    // used alone (51_000) is still under the 87_000 ceiling, but
    // used + reserved = 90_500 ≥ 87_000 — we MUST transition.
    assert.equal(result.state.status, "budget_exhausted");
    assert.equal(result.becameExhausted, true);
  });

  it("does NOT transition when used + reserved stays under the ceiling", () => {
    const state = makeState({ lrtUsed: 10_000, lrtReserved: 5_000 });
    const result = applyReconciliation(2_000, 1_500, state);
    // total = 12_000 + 3_500 = 15_500 ≪ 87_000.
    assert.equal(result.state.status, "active");
    assert.equal(result.becameExhausted, false);
  });

  it("does NOT re-flag becameExhausted when status is already exhausted", () => {
    const state = makeState({
      status: "budget_exhausted",
      lrtUsed: 90_000,
      lrtReserved: 500,
    });
    const result = applyReconciliation(500, 500, state);
    assert.equal(result.state.status, "budget_exhausted");
    assert.equal(result.becameExhausted, false);
  });

  it("clamps reservedDelta to current lrtReserved (no negative reserved)", () => {
    const state = makeState({ lrtReserved: 100, lrtUsed: 0 });
    const result = applyReconciliation(50, 500, state);
    assert.equal(result.state.lrtReserved, 0);
    assert.equal(result.reservedDelta, 100);
  });

  it("clamps non-finite / negative deltas to zero", () => {
    const state = makeState({ lrtReserved: 100, lrtUsed: 50 });
    const result = applyReconciliation(-50, NaN, state);
    assert.equal(result.state.lrtUsed, 50);
    assert.equal(result.state.lrtReserved, 100);
    assert.equal(result.reservedDelta, 0);
    assert.equal(result.usedDelta, 0);
  });
});
