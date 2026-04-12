/**
 * Integration tests for the full rental session state machine.
 * Tests all valid transitions and rejects invalid ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidRentalSessionTransition,
  isTerminalRentalSessionStatus,
  validateCreateListing,
  validateCreateSession,
  type RentalSessionStatus,
} from "../../shared/rental.js";
import {
  tokensToComputeUnits,
  KNOWN_MODELS,
} from "../../shared/compute-units.js";
import {
  processHeartbeat,
  computeCUMeterState,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_DEAD_MS,
} from "../../shared/rental-metering.js";

// ─── Full State Machine Path Tests ────────────────────────────

describe("RentalSessionStateMachine: Full Lifecycle Paths", () => {
  it("happy path: requested → accepted → active → completed", () => {
    assert.ok(isValidRentalSessionTransition("requested", "accepted"));
    assert.ok(isValidRentalSessionTransition("accepted", "active"));
    assert.ok(isValidRentalSessionTransition("active", "completed"));
  });

  it("cancellation from any non-terminal state", () => {
    const cancellableStates: RentalSessionStatus[] = ["requested", "accepted", "active", "paused"];
    for (const state of cancellableStates) {
      assert.ok(
        isValidRentalSessionTransition(state, "cancelled"),
        `Should allow ${state} → cancelled`
      );
    }
  });

  it("expiration from active/paused", () => {
    assert.ok(isValidRentalSessionTransition("active", "expired"));
    assert.ok(isValidRentalSessionTransition("paused", "expired"));
    assert.ok(!isValidRentalSessionTransition("requested", "expired"));
    assert.ok(!isValidRentalSessionTransition("accepted", "expired"));
  });

  it("pause/resume cycle", () => {
    assert.ok(isValidRentalSessionTransition("active", "paused"));
    assert.ok(isValidRentalSessionTransition("paused", "active"));
  });

  it("terminal states block all transitions", () => {
    const terminal: RentalSessionStatus[] = ["completed", "cancelled", "expired"];
    const allStatuses: RentalSessionStatus[] = [
      "requested", "accepted", "active", "paused",
      "completed", "cancelled", "expired", "disputed"
    ];
    for (const from of terminal) {
      assert.ok(isTerminalRentalSessionStatus(from), `${from} should be terminal`);
      for (const to of allStatuses) {
        assert.ok(
          !isValidRentalSessionTransition(from, to),
          `Should not allow ${from} → ${to}`
        );
      }
    }
  });

  it("rejects skip transitions", () => {
    assert.ok(!isValidRentalSessionTransition("requested", "active")); // must accept first
    assert.ok(!isValidRentalSessionTransition("requested", "completed")); // must go through active
  });
});

// ─── End-to-end CU Budget Math ─────────────────────────────

describe("End-to-end CU Budget Math", () => {
  it("simulates 3 heartbeats and budget exhaustion with Opus 4.6", () => {
    const model = "claude-opus-4-6";
    const budget = 100_000; // 100K CU budget
    let used = 0;

    // Heartbeat 1: 1000 input + 500 output = 1500 * 15 = 22500 CU
    const hb1 = processHeartbeat(model, 1000, 500, used, budget);
    assert.equal(hb1.cu_delta, 22500);
    used = hb1.cu_used_total;
    assert.equal(used, 22500);
    assert.ok(!hb1.budget_exhausted);
    assert.ok(!hb1.budget_warning);

    // Heartbeat 2: 2000 input + 1000 output = 3000 * 15 = 45000 CU
    const hb2 = processHeartbeat(model, 2000, 1000, used, budget);
    assert.equal(hb2.cu_delta, 45000);
    used = hb2.cu_used_total;
    assert.equal(used, 67500);
    assert.ok(!hb2.budget_exhausted);
    assert.ok(!hb2.budget_warning);

    // Heartbeat 3: 1500 input + 800 output = 2300 * 15 = 34500 CU
    // Total becomes 102000 which exceeds 100K budget
    const hb3 = processHeartbeat(model, 1500, 800, used, budget);
    // processHeartbeat does NOT cap delta — that's the caller's responsibility
    assert.equal(hb3.cu_delta, 34500);
    assert.equal(hb3.cu_used_total, 102000);
    assert.ok(hb3.budget_exhausted);
  });

  it("budget warning triggers at ≥80%", () => {
    const model = "claude-haiku-3-5";
    const budget = 10_000;

    // Use 8100 CU (81% of 10K)
    const hb = processHeartbeat(model, 8100, 0, 0, budget);
    assert.ok(hb.budget_warning, "Should trigger warning at 81%");
  });

  it("handles zero-token heartbeats gracefully", () => {
    const model = "claude-opus-4";
    const result = processHeartbeat(model, 0, 0, 5000, 100_000);
    assert.equal(result.cu_delta, 0);
    assert.equal(result.cu_used_total, 5000);
    assert.ok(!result.budget_exhausted);
  });
});

// ─── CU Meter State Integration ─────────────────────────────

describe("CU Meter State Integration", () => {
  it("fresh session is healthy with correct budget", () => {
    const now = Date.now();
    const state = computeCUMeterState(
      { cu_used: 5000, cu_budget: 100_000 },
      now, // last heartbeat at now
      now  // current time
    );
    assert.equal(state.cu_remaining, 95_000);
    assert.ok(!state.budget_warning);
    assert.ok(!state.budget_exhausted);
    assert.ok(!state.heartbeat_stale);
    assert.ok(!state.heartbeat_dead);
  });

  it("correctly chains heartbeats and detects stale", () => {
    const now = Date.now();
    const staleTime = now - (HEARTBEAT_STALE_MS + 1000);
    const state = computeCUMeterState(
      { cu_used: 80_000, cu_budget: 100_000 },
      staleTime, // last heartbeat was stale
      now
    );
    assert.ok(state.heartbeat_stale);
    assert.ok(state.budget_warning); // 80% used
    assert.ok(!state.heartbeat_dead);
  });
});

// ─── Cross-model CU Rate Verification ───────────────────────

describe("Cross-model CU Rates", () => {
  it("Opus 4.6 costs 15x more than Haiku 3.5 per token", () => {
    const haiku = tokensToComputeUnits("claude-haiku-3-5", 1000, 1000);
    const opus = tokensToComputeUnits("claude-opus-4-6", 1000, 1000);
    assert.equal(opus / haiku, 15);
  });

  it("all KNOWN_MODELS produce non-zero CU", () => {
    for (const model of KNOWN_MODELS) {
      const cu = tokensToComputeUnits(model, 100, 100);
      assert.ok(cu > 0, `${model} should produce positive CU`);
    }
  });
});

// ─── Validation Integration ─────────────────────────────────

describe("Validation Integration", () => {
  it("validateCreateListing accepts valid input", () => {
    const errors = validateCreateListing({
      agent_display_name: "My Agent",
      agent_model: "claude-opus-4-6",
      agent_ide: "antigravity",
      cu_budget_total: 100_000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr"],
      price_per_1k_cu: 0,
    }, KNOWN_MODELS);
    assert.equal(errors.length, 0);
  });

  it("validateCreateListing catches unknown model", () => {
    const errors = validateCreateListing({
      agent_display_name: "My Agent",
      agent_model: "gpt-5-ultra",
      agent_ide: "antigravity",
      cu_budget_total: 100_000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr"],
    }, KNOWN_MODELS);
    assert.ok(errors.some(e => e.field === "agent_model"));
  });

  it("validateCreateSession rejects missing required fields", () => {
    const errors = validateCreateSession({});
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.field === "listing_id"));
    assert.ok(errors.some(e => e.field === "task_title"));
    assert.ok(errors.some(e => e.field === "repo_scope"));
  });

  it("validateCreateSession validates repo_scope format", () => {
    const errors = validateCreateSession({
      listing_id: "lst_abc",
      task_title: "Fix bug",
      task_description: "A detailed bug description here",
      repo_scope: "invalid-no-slash",
      target_branch: "main",
      expected_outcome: "draft_pr",
    });
    assert.ok(errors.some(e => e.field === "repo_scope"));
  });

  it("validateCreateSession accepts valid input", () => {
    const errors = validateCreateSession({
      listing_id: "lst_abc",
      task_title: "Fix auth bug",
      task_description: "The login form sometimes crashes after GitHub OAuth redirect",
      repo_scope: "kdnotfound/myproject",
      target_branch: "fix/auth-redirect",
      expected_outcome: "draft_pr",
    });
    assert.equal(errors.length, 0);
  });
});
