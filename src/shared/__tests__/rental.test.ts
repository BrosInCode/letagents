import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidRentalSessionTransition,
  isTerminalRentalSessionStatus,
  isValidRepoScope,
  isValidCUBudget,
  isValidListingDisplayName,
  isValidConcurrentLimit,
  isValidSessionDuration,
  normalizeRentalListingStatus,
  normalizeRentalSessionStatus,
  normalizeRentalOutputType,
  normalizeRentalIdeLabel,
  validateCreateListing,
  validateCreateSession,
  RENTAL_SESSION_TRANSITIONS,
  MIN_CU_BUDGET,
  MAX_CU_BUDGET,
  MIN_SESSION_DURATION_MINUTES,
  MAX_SESSION_DURATION_MINUTES,
} from "../rental.js";

import {
  computeCUMeterState,
  processHeartbeat,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_DEAD_MS,
  CU_WARNING_THRESHOLD,
} from "../rental-metering.js";

import { KNOWN_MODELS } from "../compute-units.js";

// ─── State Machine Tests ────────────────────────────────────

test("session transition: requested → accepted is valid", () => {
  assert.equal(isValidRentalSessionTransition("requested", "accepted"), true);
});

test("session transition: requested → cancelled is valid", () => {
  assert.equal(isValidRentalSessionTransition("requested", "cancelled"), true);
});

test("session transition: requested → active is BLOCKED (must go through accepted)", () => {
  assert.equal(isValidRentalSessionTransition("requested", "active"), false);
});

test("session transition: accepted → active is valid", () => {
  assert.equal(isValidRentalSessionTransition("accepted", "active"), true);
});

test("session transition: active → completed is valid", () => {
  assert.equal(isValidRentalSessionTransition("active", "completed"), true);
});

test("session transition: active → paused is valid", () => {
  assert.equal(isValidRentalSessionTransition("active", "paused"), true);
});

test("session transition: active → expired is valid", () => {
  assert.equal(isValidRentalSessionTransition("active", "expired"), true);
});

test("session transition: active → disputed is valid", () => {
  assert.equal(isValidRentalSessionTransition("active", "disputed"), true);
});

test("session transition: paused → active is valid (resume)", () => {
  assert.equal(isValidRentalSessionTransition("paused", "active"), true);
});

test("session transition: completed → anything is blocked (terminal)", () => {
  const targets = Object.keys(RENTAL_SESSION_TRANSITIONS) as Array<keyof typeof RENTAL_SESSION_TRANSITIONS>;
  for (const to of targets) {
    assert.equal(
      isValidRentalSessionTransition("completed", to),
      false,
      `completed → ${to} should be blocked`
    );
  }
});

test("session transition: expired → anything is blocked (terminal)", () => {
  const targets = Object.keys(RENTAL_SESSION_TRANSITIONS) as Array<keyof typeof RENTAL_SESSION_TRANSITIONS>;
  for (const to of targets) {
    assert.equal(
      isValidRentalSessionTransition("expired", to),
      false,
      `expired → ${to} should be blocked`
    );
  }
});

test("session transition: cancelled → anything is blocked (terminal)", () => {
  const targets = Object.keys(RENTAL_SESSION_TRANSITIONS) as Array<keyof typeof RENTAL_SESSION_TRANSITIONS>;
  for (const to of targets) {
    assert.equal(
      isValidRentalSessionTransition("cancelled", to),
      false,
      `cancelled → ${to} should be blocked`
    );
  }
});

test("isTerminalRentalSessionStatus identifies terminal states", () => {
  assert.equal(isTerminalRentalSessionStatus("completed"), true);
  assert.equal(isTerminalRentalSessionStatus("cancelled"), true);
  assert.equal(isTerminalRentalSessionStatus("expired"), true);
  assert.equal(isTerminalRentalSessionStatus("active"), false);
  assert.equal(isTerminalRentalSessionStatus("requested"), false);
});

// ─── Repo Scope Validation ─────────────────────────────────

test("isValidRepoScope accepts owner/repo", () => {
  assert.equal(isValidRepoScope("kdnotfound/myproject"), true);
});

test("isValidRepoScope accepts dots and hyphens", () => {
  assert.equal(isValidRepoScope("my-org/my.project"), true);
});

test("isValidRepoScope rejects empty string", () => {
  assert.equal(isValidRepoScope(""), false);
});

test("isValidRepoScope rejects whitespace only", () => {
  assert.equal(isValidRepoScope("   "), false);
});

test("isValidRepoScope rejects no slash", () => {
  assert.equal(isValidRepoScope("justarepo"), false);
});

test("isValidRepoScope rejects path traversal", () => {
  assert.equal(isValidRepoScope("../../etc/passwd"), false);
});

test("isValidRepoScope rejects multiple slashes", () => {
  assert.equal(isValidRepoScope("owner/repo/extra"), false);
});

test("isValidRepoScope rejects special characters", () => {
  assert.equal(isValidRepoScope("owner/repo; rm -rf /"), false);
});

// ─── CU Budget Validation ───────────────────────────────────

test("isValidCUBudget accepts minimum", () => {
  assert.equal(isValidCUBudget(MIN_CU_BUDGET), true);
});

test("isValidCUBudget accepts maximum", () => {
  assert.equal(isValidCUBudget(MAX_CU_BUDGET), true);
});

test("isValidCUBudget rejects below minimum", () => {
  assert.equal(isValidCUBudget(999), false);
});

test("isValidCUBudget rejects above maximum", () => {
  assert.equal(isValidCUBudget(MAX_CU_BUDGET + 1), false);
});

test("isValidCUBudget rejects non-integer", () => {
  assert.equal(isValidCUBudget(1500.5), false);
});

// ─── Display Name Validation ────────────────────────────────

test("isValidListingDisplayName accepts 2-100 chars", () => {
  assert.equal(isValidListingDisplayName("My Agent"), true);
});

test("isValidListingDisplayName rejects 1 char", () => {
  assert.equal(isValidListingDisplayName("A"), false);
});

test("isValidListingDisplayName rejects empty", () => {
  assert.equal(isValidListingDisplayName(""), false);
});

test("isValidListingDisplayName rejects whitespace-only", () => {
  assert.equal(isValidListingDisplayName("   "), false);
});

// ─── Normalizers ────────────────────────────────────────────

test("normalizeRentalListingStatus accepts known statuses", () => {
  assert.equal(normalizeRentalListingStatus("active"), "active");
  assert.equal(normalizeRentalListingStatus(" PAUSED "), "paused");
});

test("normalizeRentalListingStatus rejects unknown", () => {
  assert.equal(normalizeRentalListingStatus("deleted"), null);
});

test("normalizeRentalSessionStatus accepts known statuses", () => {
  assert.equal(normalizeRentalSessionStatus("requested"), "requested");
  assert.equal(normalizeRentalSessionStatus("ACTIVE"), "active");
});

test("normalizeRentalOutputType accepts known types", () => {
  assert.equal(normalizeRentalOutputType("draft_pr"), "draft_pr");
  assert.equal(normalizeRentalOutputType("RESEARCH_NOTE"), "research_note");
});

test("normalizeRentalOutputType rejects unknown", () => {
  assert.equal(normalizeRentalOutputType("execute_code"), null);
});

test("normalizeRentalIdeLabel accepts known IDEs", () => {
  assert.equal(normalizeRentalIdeLabel("antigravity"), "antigravity");
  assert.equal(normalizeRentalIdeLabel("CURSOR"), "cursor");
  assert.equal(normalizeRentalIdeLabel("codex"), "codex");
});

test("normalizeRentalIdeLabel rejects unknown", () => {
  assert.equal(normalizeRentalIdeLabel("vim"), null);
});

// ─── Listing Validation ─────────────────────────────────────

test("validateCreateListing returns no errors for valid input", () => {
  const errors = validateCreateListing(
    {
      agent_display_name: "My Antigravity Opus 4.6",
      agent_model: "claude-opus-4-6",
      agent_ide: "antigravity",
      cu_budget_total: 50000,
      cu_budget_per_session: 10000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr", "research_note"],
      price_per_1k_cu: 0,
    },
    KNOWN_MODELS
  );
  assert.equal(errors.length, 0);
});

test("validateCreateListing rejects paid listings in v1", () => {
  const errors = validateCreateListing(
    {
      agent_display_name: "My Agent",
      agent_model: "claude-opus-4-6",
      agent_ide: "antigravity",
      cu_budget_total: 50000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr"],
      price_per_1k_cu: 100,
    },
    KNOWN_MODELS
  );
  const priceError = errors.find((e) => e.field === "price_per_1k_cu");
  assert.ok(priceError, "Should reject non-zero price");
});

test("validateCreateListing rejects unknown model", () => {
  const errors = validateCreateListing(
    {
      agent_display_name: "My Agent",
      agent_model: "gpt-3",
      agent_ide: "antigravity",
      cu_budget_total: 50000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr"],
      price_per_1k_cu: 0,
    },
    KNOWN_MODELS
  );
  assert.ok(errors.find((e) => e.field === "agent_model"));
});

test("validateCreateListing rejects per_session > total budget", () => {
  const errors = validateCreateListing(
    {
      agent_display_name: "My Agent",
      agent_model: "claude-opus-4-6",
      agent_ide: "antigravity",
      cu_budget_total: 5000,
      cu_budget_per_session: 10000,
      max_concurrent_sessions: 1,
      supported_output_types: ["draft_pr"],
      price_per_1k_cu: 0,
    },
    KNOWN_MODELS
  );
  assert.ok(errors.find((e) => e.field === "cu_budget_per_session"));
});

// ─── Session Validation ─────────────────────────────────────

test("validateCreateSession returns no errors for valid input", () => {
  const errors = validateCreateSession({
    listing_id: "lst_abc123",
    task_title: "Fix auth bug",
    task_description: "The useAuth composable has a race condition on mount",
    repo_scope: "kdnotfound/myproject",
    target_branch: "fix/auth",
    expected_outcome: "draft_pr",
  });
  assert.equal(errors.length, 0);
});

test("validateCreateSession rejects invalid repo scope", () => {
  const errors = validateCreateSession({
    listing_id: "lst_abc123",
    task_title: "Fix bug",
    task_description: "Some description here for the task",
    repo_scope: "../../etc/passwd",
    target_branch: "main",
    expected_outcome: "draft_pr",
  });
  assert.ok(errors.find((e) => e.field === "repo_scope"));
});

test("validateCreateSession rejects short task title", () => {
  const errors = validateCreateSession({
    listing_id: "lst_abc123",
    task_title: "X",
    task_description: "Some description here for the task",
    repo_scope: "owner/repo",
    target_branch: "main",
    expected_outcome: "draft_pr",
  });
  assert.ok(errors.find((e) => e.field === "task_title"));
});

test("validateCreateSession rejects invalid outcome", () => {
  const errors = validateCreateSession({
    listing_id: "lst_abc123",
    task_title: "Fix bug",
    task_description: "Some description here for the task",
    repo_scope: "owner/repo",
    target_branch: "main",
    expected_outcome: "deploy_production" as any,
  });
  assert.ok(errors.find((e) => e.field === "expected_outcome"));
});

// ─── CU Metering ────────────────────────────────────────────

test("computeCUMeterState returns correct budget state", () => {
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 7000 },
    Date.now(),
    Date.now()
  );
  assert.equal(state.cu_remaining, 3000);
  assert.equal(state.budget_exhausted, false);
  assert.equal(state.budget_warning, false);
});

test("computeCUMeterState triggers warning at 80%", () => {
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 8500 },
    Date.now(),
    Date.now()
  );
  assert.equal(state.budget_warning, true);
  assert.equal(state.budget_exhausted, false);
});

test("computeCUMeterState triggers exhausted at 100%", () => {
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 10000 },
    Date.now(),
    Date.now()
  );
  assert.equal(state.budget_exhausted, true);
  assert.equal(state.cu_remaining, 0);
});

test("computeCUMeterState detects stale heartbeat", () => {
  const now = Date.now();
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 1000 },
    now - HEARTBEAT_STALE_MS - 1000, // 6 minutes ago
    now
  );
  assert.equal(state.heartbeat_stale, true);
  assert.equal(state.heartbeat_dead, false);
});

test("computeCUMeterState detects dead heartbeat", () => {
  const now = Date.now();
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 1000 },
    now - HEARTBEAT_DEAD_MS - 1000, // 16 minutes ago
    now
  );
  assert.equal(state.heartbeat_stale, true);
  assert.equal(state.heartbeat_dead, true);
});

test("computeCUMeterState does not false-positive on fresh heartbeat", () => {
  const now = Date.now();
  const state = computeCUMeterState(
    { cu_budget: 10000, cu_used: 1000 },
    now - 30_000, // 30 seconds ago
    now
  );
  assert.equal(state.heartbeat_stale, false);
  assert.equal(state.heartbeat_dead, false);
});

test("processHeartbeat converts tokens to CU and updates totals", () => {
  const result = processHeartbeat(
    "claude-opus-4-6",
    100, // input tokens
    50,  // output tokens
    0,   // current CU used
    50000 // budget
  );
  // 100*15 + 50*15 = 2250 CU
  assert.equal(result.cu_delta, 2250);
  assert.equal(result.cu_used_total, 2250);
  assert.equal(result.cu_remaining, 50000 - 2250);
  assert.equal(result.budget_exhausted, false);
});

test("processHeartbeat detects budget exhaustion", () => {
  const result = processHeartbeat(
    "claude-opus-4-6",
    1000,
    1000,
    28000, // already used 28000
    30000  // budget is 30000
  );
  // Delta = 1000*15 + 1000*15 = 30000 CU (way over budget)
  assert.equal(result.budget_exhausted, true);
  assert.equal(result.cu_remaining, 0);
});

test("processHeartbeat triggers warning near budget", () => {
  const result = processHeartbeat(
    "claude-haiku-3-5",
    100,
    100,
    7800, // 78% used
    10000
  );
  // Delta = 100+100 = 200 CU → total = 8000 → 80% → warning
  assert.equal(result.cu_used_total, 8000);
  assert.equal(result.budget_warning, true);
  assert.equal(result.budget_exhausted, false);
});
