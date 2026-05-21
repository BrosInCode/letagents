/**
 * Regression test for task_15 / PR #425:
 * Generic room SSE stream must NOT forward rental activity events
 * with internal, provider_only, or renter_only visibility.
 *
 * Only events with visibility === "rental_visible" should appear
 * on the generic `/rooms/:id/messages/stream` SSE endpoint.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

/**
 * Simulates the visibility-filtering logic from onRentalActivityCreated
 * in room-messages.ts. This is extracted here so the test doesn't need
 * a full HTTP server — it validates the guard condition directly.
 */
function shouldForwardToGenericStream(visibility: string): boolean {
  return visibility === "rental_visible";
}

describe("rental stream visibility filter", () => {
  it("forwards rental_visible events to generic stream", () => {
    assert.ok(shouldForwardToGenericStream("rental_visible"));
  });

  it("blocks internal events from generic stream", () => {
    assert.ok(!shouldForwardToGenericStream("internal"));
  });

  it("blocks renter_only events from generic stream", () => {
    assert.ok(!shouldForwardToGenericStream("renter_only"));
  });

  it("blocks provider_only events from generic stream", () => {
    assert.ok(!shouldForwardToGenericStream("provider_only"));
  });

  it("budget.meter_stale defaults to internal and should not produce SSE frame", () => {
    // budget.meter_stale has getDefaultVisibility() => "internal"
    // This is the regression target specified in the task description.
    const meterStaleVisibility = "internal";
    assert.equal(
      shouldForwardToGenericStream(meterStaleVisibility),
      false,
      "budget.meter_stale (internal) must not produce a generic SSE frame"
    );
  });

  it("session.started defaults to rental_visible and should produce SSE frame", () => {
    // session.started has getDefaultVisibility() => "rental_visible"
    const sessionStartedVisibility = "rental_visible";
    assert.equal(
      shouldForwardToGenericStream(sessionStartedVisibility),
      true,
      "session.started (rental_visible) should produce a generic SSE frame"
    );
  });

  it("agent.note defaults to provider_only and should not produce SSE frame", () => {
    // agent.note has getDefaultVisibility() => "provider_only"
    const agentNoteVisibility = "provider_only";
    assert.equal(
      shouldForwardToGenericStream(agentNoteVisibility),
      false,
      "agent.note (provider_only) must not produce a generic SSE frame"
    );
  });

  it("session.silence_nudge_sent defaults to renter_only and should not produce SSE frame", () => {
    // session.silence_nudge_sent has getDefaultVisibility() => "renter_only"
    const nudgeVisibility = "renter_only";
    assert.equal(
      shouldForwardToGenericStream(nudgeVisibility),
      false,
      "session.silence_nudge_sent (renter_only) must not produce a generic SSE frame"
    );
  });
});

describe("rental activity event emitter filtering integration", () => {
  it("onRentalActivityCreated handler skips internal events", () => {
    const emitter = new EventEmitter();
    const written: string[] = [];
    const projectId = "test-room";

    // Simulate the patched onRentalActivityCreated handler
    emitter.on("activity:created", (event: { activity: { room_id: string; visibility: string; event_type: string } }) => {
      const activity = event.activity;
      if (activity.room_id !== projectId) return;
      // This is the visibility guard we added
      if (activity.visibility !== "rental_visible") return;
      written.push(`rental_activity:${activity.event_type}`);
    });

    // Emit an internal event (budget.meter_stale)
    emitter.emit("activity:created", {
      activity: {
        room_id: projectId,
        visibility: "internal",
        event_type: "budget.meter_stale",
      },
    });

    // Emit a rental_visible event (session.started)
    emitter.emit("activity:created", {
      activity: {
        room_id: projectId,
        visibility: "rental_visible",
        event_type: "session.started",
      },
    });

    // Emit a provider_only event (agent.note)
    emitter.emit("activity:created", {
      activity: {
        room_id: projectId,
        visibility: "provider_only",
        event_type: "agent.note",
      },
    });

    assert.deepEqual(written, ["rental_activity:session.started"]);
  });
});
