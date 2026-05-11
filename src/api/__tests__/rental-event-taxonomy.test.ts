/**
 * Tests for the §9.4 event taxonomy — p1.2b.
 *
 * Verifies:
 * - All 44 event types exist in the taxonomy
 * - Type-level exhaustiveness (ALL_ACTIVITY_EVENT_TYPES covers the union)
 * - Auto-verified vs unverified classification
 * - Visibility defaults per event type
 * - agent.note is the only unverified event
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_ACTIVITY_EVENT_TYPES,
  AUTO_VERIFIED_EVENT_TYPES,
  UNVERIFIED_EVENT_TYPES,
  getDefaultVisibility,
  AGENT_HEARTBEAT,
  AGENT_NOTE,
  SESSION_STARTED,
  SESSION_SILENCE_NUDGE_SENT,
  BUDGET_METER_STALE,
  BUDGET_METER_RECOVERED,
  BUDGET_EXTERNAL_USAGE_SUSPECTED,
  BUDGET_EXTENSION_REQUESTED,
  COMMAND_RUN,
  PATCH_GATE_TIMED_OUT,
  type RentalActivityEventType,
} from "../rental/activity-event-types.js";

describe("§9.4 event taxonomy completeness", () => {
  it("has exactly 48 event types (43 from spec §9.4 + 2 D4 lane events + 3 budget extension events)", () => {
    // D4 amendment (renter quota lane lifecycle) added:
    //   lane.exhausted  — detected when the renter's IDE quota dies
    //   lane.recovered  — detected when the renter's lane refreshes
    assert.strictEqual(ALL_ACTIVITY_EVENT_TYPES.length, 48);
  });

  it("all event types are unique", () => {
    const uniqueSet = new Set(ALL_ACTIVITY_EVENT_TYPES);
    assert.strictEqual(uniqueSet.size, ALL_ACTIVITY_EVENT_TYPES.length);
  });

  it("includes all spec §9.4 event types", () => {
    const specEvents = [
      "session.started", "session.accepted",
      "agent.joined", "agent.heartbeat", "agent.note",
      "budget.lease_started", "budget.reserved", "budget.reconciled",
      "budget.warning", "budget.exhausted",
      "context.scope_set", "context.file_exposed", "context.file_blocked",
      "context.secret_redacted",
      "search.run",
      "command.requested", "command.allowed", "command.blocked",
      "command.run", "command.output", "command.timed_out",
      "edit.proposed",
      "patch.proposed",
      "patch_gate.started", "patch_gate.scope_passed",
      "patch_gate.secret_passed", "patch_gate.risk_flagged",
      "patch_gate.tests_started", "patch_gate.tests_passed",
      "patch_gate.tests_failed", "patch_gate.timed_out",
      "session.blocked", "session.completed", "session.cancelled",
      "session.silence_nudge_sent", "session.lease_created",
      "session.teardown_completed",
      "budget.meter_stale", "budget.meter_recovered",
      "budget.external_usage_suspected",
      "budget.extension_requested", "budget.extension_approved",
      "budget.extension_denied",
      "context.scope_denied", "context.base_branch_changed",
      "patch_gate.apply_failed",
      // D4 amendment — renter quota lane lifecycle
      "lane.exhausted", "lane.recovered",
    ];
    const typeSet = new Set<string>(ALL_ACTIVITY_EVENT_TYPES);
    for (const event of specEvents) {
      assert.ok(typeSet.has(event), `Missing event: ${event}`);
    }
  });

  it("type-level exhaustiveness — array matches union", () => {
    // This is a compile-time check: if ALL_ACTIVITY_EVENT_TYPES
    // is typed as readonly RentalActivityEventType[], TypeScript
    // ensures each element is a valid union member.
    // At runtime, we verify the count matches.
    const _typeCheck: readonly RentalActivityEventType[] = ALL_ACTIVITY_EVENT_TYPES;
    assert.ok(_typeCheck.length === 48);
  });
});

describe("auto-verified vs unverified classification", () => {
  it("only agent.note is unverified", () => {
    assert.strictEqual(UNVERIFIED_EVENT_TYPES.size, 1);
    assert.ok(UNVERIFIED_EVENT_TYPES.has(AGENT_NOTE));
  });

  it("agent.note is not in the auto-verified set", () => {
    assert.ok(!AUTO_VERIFIED_EVENT_TYPES.has(AGENT_NOTE));
  });

  it("all other events are auto-verified", () => {
    // Every event except agent.note should be in AUTO_VERIFIED
    for (const eventType of ALL_ACTIVITY_EVENT_TYPES) {
      if (eventType === AGENT_NOTE) continue;
      assert.ok(
        AUTO_VERIFIED_EVENT_TYPES.has(eventType),
        `${eventType} should be auto-verified`
      );
    }
  });

  it("auto-verified + unverified covers all events", () => {
    const total = AUTO_VERIFIED_EVENT_TYPES.size + UNVERIFIED_EVENT_TYPES.size;
    assert.strictEqual(total, ALL_ACTIVITY_EVENT_TYPES.length);
  });
});

describe("default visibility per event type", () => {
  it("agent.heartbeat is internal", () => {
    assert.strictEqual(getDefaultVisibility(AGENT_HEARTBEAT), "internal");
  });

  it("budget.meter_stale is internal", () => {
    assert.strictEqual(getDefaultVisibility(BUDGET_METER_STALE), "internal");
  });

  it("budget.meter_recovered is internal", () => {
    assert.strictEqual(getDefaultVisibility(BUDGET_METER_RECOVERED), "internal");
  });

  it("budget.external_usage_suspected is internal", () => {
    assert.strictEqual(
      getDefaultVisibility(BUDGET_EXTERNAL_USAGE_SUSPECTED),
      "internal"
    );
  });

  it("agent.note is provider_only", () => {
    assert.strictEqual(getDefaultVisibility(AGENT_NOTE), "provider_only");
  });

  it("session.silence_nudge_sent is renter_only", () => {
    assert.strictEqual(
      getDefaultVisibility(SESSION_SILENCE_NUDGE_SENT),
      "renter_only"
    );
  });

  it("session.started defaults to rental_visible", () => {
    assert.strictEqual(getDefaultVisibility(SESSION_STARTED), "rental_visible");
  });

  it("budget.extension_requested defaults to rental_visible", () => {
    assert.strictEqual(getDefaultVisibility(BUDGET_EXTENSION_REQUESTED), "rental_visible");
  });

  it("command.run defaults to rental_visible", () => {
    assert.strictEqual(getDefaultVisibility(COMMAND_RUN), "rental_visible");
  });

  it("patch_gate.timed_out defaults to rental_visible", () => {
    assert.strictEqual(getDefaultVisibility(PATCH_GATE_TIMED_OUT), "rental_visible");
  });
});
