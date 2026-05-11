/**
 * Tests for the D4 lane-recovery service (p2.5 server-side slice).
 *
 * Covers:
 *   - happy path: marks recovered + emits lane.recovered exactly once
 *   - LANE_RECOVERY_THRESHOLD gating (positive deltas below threshold ignored)
 *   - idempotency: re-running on an already-recovered session is a no-op
 *   - requires renter_lane_exhausted_at to be set
 *   - provider / model mismatch is rejected
 *   - no prior snapshot → no recovery (need a baseline to compare)
 *   - invalid signals (bad percent, bad date, blank sessionId) are rejected
 *     without side effects
 *   - no room_id → marks recovered but skips event (no room to write to)
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRenterLaneSignal,
  LANE_RECOVERY_REASONS,
  LANE_RECOVERY_THRESHOLD,
  type LaneRecoveryDeps,
  type RentalSessionLaneView,
  type RenterLaneSignal,
  type RenterLaneSnapshotRecord,
} from "../rental/lane-recovery.js";

// ===========================================================================
// Test harness
// ===========================================================================

interface MarkRecoveredCall {
  sessionId: string;
  recoveredAt: Date;
}

interface EmitCall {
  sessionId: string;
  roomId: string;
  source: string;
  payload: Record<string, unknown>;
}

function makeDeps(input: {
  session?: RentalSessionLaneView | null;
  prior?: RenterLaneSnapshotRecord | null;
}): LaneRecoveryDeps & {
  marked: MarkRecoveredCall[];
  emitted: EmitCall[];
} {
  const marked: MarkRecoveredCall[] = [];
  const emitted: EmitCall[] = [];
  return {
    marked,
    emitted,
    async loadSession() {
      return input.session === undefined ? null : input.session;
    },
    async loadPriorSnapshot() {
      return input.prior === undefined ? null : input.prior;
    },
    async markRecovered(sessionId, recoveredAt) {
      marked.push({ sessionId, recoveredAt });
    },
    async emitLaneRecoveredEvent(call) {
      emitted.push(call);
    },
  };
}

function makeSession(
  overrides: Partial<RentalSessionLaneView> = {},
): RentalSessionLaneView {
  return {
    id: "rsess_1",
    room_id: "room_1",
    renter_lane_provider: "antigravity",
    renter_lane_model: "gemini-2.5-pro",
    renter_lane_exhausted_at: new Date("2026-05-11T09:00:00.000Z"),
    renter_lane_recovered_at: null,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<RenterLaneSignal> = {}): RenterLaneSignal {
  return {
    sessionId: "rsess_1",
    provider: "antigravity",
    model: "gemini-2.5-pro",
    percentRemaining: 0.92,
    observedAt: new Date("2026-05-11T18:00:00.000Z"),
    ...overrides,
  };
}

// ===========================================================================
// Happy path
// ===========================================================================

describe("applyRenterLaneSignal — happy path", () => {
  it("marks recovered + emits lane.recovered exactly once when delta ≥ threshold", async () => {
    const deps = makeDeps({
      session: makeSession(),
      prior: {
        percentRemaining: 0.02,
        observedAt: new Date("2026-05-11T09:30:00.000Z"),
      },
    });

    const decision = await applyRenterLaneSignal(makeSignal(), deps);

    assert.equal(decision.recovered, true);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.RECOVERED);
    assert.equal(decision.priorPercentRemaining, 0.02);
    assert.ok(decision.deltaPercent !== null && decision.deltaPercent > LANE_RECOVERY_THRESHOLD);
    assert.equal(deps.marked.length, 1);
    assert.equal(deps.marked[0]?.sessionId, "rsess_1");
    assert.equal(
      deps.marked[0]?.recoveredAt.toISOString(),
      "2026-05-11T18:00:00.000Z",
    );
    assert.equal(deps.emitted.length, 1);
    const ev = deps.emitted[0]!;
    assert.equal(ev.roomId, "room_1");
    assert.equal(ev.source, "system");
    assert.equal(ev.payload.event, "lane.recovered");
    assert.equal(ev.payload.provider, "antigravity");
    assert.equal(ev.payload.model, "gemini-2.5-pro");
    assert.equal(ev.payload.prior_percent_remaining, 0.02);
    assert.equal(ev.payload.new_percent_remaining, 0.92);
    assert.equal(ev.payload.observed_at, "2026-05-11T18:00:00.000Z");
  });

  it("accepts null renter_lane_provider as a wildcard match", async () => {
    const deps = makeDeps({
      session: makeSession({ renter_lane_provider: null }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.recovered, true);
    assert.equal(deps.marked.length, 1);
  });

  it("accepts null incoming model as a wildcard against any recorded model", async () => {
    const deps = makeDeps({
      session: makeSession({ renter_lane_model: "gemini-2.5-flash" }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ model: null }),
      deps,
    );
    assert.equal(decision.recovered, true);
  });
});

// ===========================================================================
// Threshold gating
// ===========================================================================

describe("applyRenterLaneSignal — threshold gating", () => {
  it("rejects a positive delta below LANE_RECOVERY_THRESHOLD", async () => {
    const deps = makeDeps({
      session: makeSession(),
      prior: {
        percentRemaining: 0.6,
        observedAt: new Date("2026-05-11T09:30:00.000Z"),
      },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ percentRemaining: 0.95 }),
      deps,
    );
    assert.equal(decision.recovered, false);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.DELTA_BELOW_THRESHOLD);
    assert.equal(decision.priorPercentRemaining, 0.6);
    assert.ok(decision.deltaPercent !== null && Math.abs(decision.deltaPercent - 0.35) < 1e-9);
    assert.equal(deps.marked.length, 0);
    assert.equal(deps.emitted.length, 0);
  });

  it("rejects a negative delta (lane continuing to drain)", async () => {
    const deps = makeDeps({
      session: makeSession(),
      prior: { percentRemaining: 0.8, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ percentRemaining: 0.2 }),
      deps,
    );
    assert.equal(decision.recovered, false);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.DELTA_BELOW_THRESHOLD);
    assert.equal(deps.marked.length, 0);
  });

  it("accepts a delta exactly at LANE_RECOVERY_THRESHOLD", async () => {
    const deps = makeDeps({
      session: makeSession(),
      prior: { percentRemaining: 0.0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ percentRemaining: LANE_RECOVERY_THRESHOLD }),
      deps,
    );
    assert.equal(decision.recovered, true);
    assert.equal(deps.marked.length, 1);
  });
});

// ===========================================================================
// Required-fields gating
// ===========================================================================

describe("applyRenterLaneSignal — required state", () => {
  it("requires the session to exist", async () => {
    const deps = makeDeps({ session: null, prior: null });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.SESSION_NOT_FOUND);
    assert.equal(deps.marked.length, 0);
    assert.equal(deps.emitted.length, 0);
  });

  it("requires renter_lane_exhausted_at to be set", async () => {
    const deps = makeDeps({
      session: makeSession({ renter_lane_exhausted_at: null }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.LANE_NOT_EXHAUSTED);
    assert.equal(deps.marked.length, 0);
    assert.equal(deps.emitted.length, 0);
  });

  it("requires a prior snapshot to compute delta", async () => {
    const deps = makeDeps({
      session: makeSession(),
      prior: null,
    });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.NO_PRIOR_SNAPSHOT);
    assert.equal(deps.marked.length, 0);
  });
});

// ===========================================================================
// Idempotency
// ===========================================================================

describe("applyRenterLaneSignal — idempotency", () => {
  it("is a no-op when renter_lane_recovered_at is already set", async () => {
    const alreadyRecoveredAt = new Date("2026-05-11T17:00:00.000Z");
    const deps = makeDeps({
      session: makeSession({ renter_lane_recovered_at: alreadyRecoveredAt }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.recovered, false);
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.ALREADY_RECOVERED);
    assert.equal(deps.marked.length, 0);
    assert.equal(deps.emitted.length, 0);
  });
});

// ===========================================================================
// Provider / model match
// ===========================================================================

describe("applyRenterLaneSignal — provider / model match", () => {
  it("rejects mismatched provider", async () => {
    const deps = makeDeps({
      session: makeSession({ renter_lane_provider: "antigravity" }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ provider: "claude_code" }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.PROVIDER_MISMATCH);
    assert.equal(deps.marked.length, 0);
  });

  it("rejects mismatched model when both sides are set", async () => {
    const deps = makeDeps({
      session: makeSession({ renter_lane_model: "gemini-2.5-pro" }),
      prior: { percentRemaining: 0, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(
      makeSignal({ model: "gemini-2.5-flash" }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.MODEL_MISMATCH);
    assert.equal(deps.marked.length, 0);
  });
});

// ===========================================================================
// Signal validation
// ===========================================================================

describe("applyRenterLaneSignal — signal validation", () => {
  it("rejects empty sessionId", async () => {
    const deps = makeDeps({});
    const decision = await applyRenterLaneSignal(
      makeSignal({ sessionId: "" }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.INVALID_SIGNAL);
  });

  it("rejects out-of-range percent_remaining", async () => {
    const deps = makeDeps({ session: makeSession() });
    const decision = await applyRenterLaneSignal(
      makeSignal({ percentRemaining: 1.2 }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.INVALID_SIGNAL);
  });

  it("rejects negative percent_remaining", async () => {
    const deps = makeDeps({ session: makeSession() });
    const decision = await applyRenterLaneSignal(
      makeSignal({ percentRemaining: -0.1 }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.INVALID_SIGNAL);
  });

  it("rejects NaN observedAt", async () => {
    const deps = makeDeps({ session: makeSession() });
    const decision = await applyRenterLaneSignal(
      makeSignal({ observedAt: new Date("nope") }),
      deps,
    );
    assert.equal(decision.reason, LANE_RECOVERY_REASONS.INVALID_SIGNAL);
  });
});

// ===========================================================================
// No-room-id corner case
// ===========================================================================

describe("applyRenterLaneSignal — no room_id", () => {
  it("still marks recovered but skips event emission when room_id is null", async () => {
    const deps = makeDeps({
      session: makeSession({ room_id: null }),
      prior: { percentRemaining: 0.02, observedAt: new Date() },
    });
    const decision = await applyRenterLaneSignal(makeSignal(), deps);
    assert.equal(decision.recovered, true);
    assert.equal(deps.marked.length, 1);
    assert.equal(deps.emitted.length, 0);
  });
});
