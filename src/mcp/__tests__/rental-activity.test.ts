/**
 * Tests for p3.3 rental MCP tool handlers — activity lifecycle.
 *
 * Verifies:
 *   - rental_emit_activity → POST /api/rental/sessions/:id/activity
 *   - rental_complete      → POST /api/rental/sessions/:id/complete
 *   - rental_cancel        → POST /api/rental/sessions/:id/cancel
 *   - input validation rejects missing fields without calling apiCall
 *   - error responses from apiCall surface as { success: false, error }
 *
 * Uses a fake apiCall to introspect the wire shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rentalEmitActivity,
  rentalComplete,
  rentalCancel,
  type RentalToolDeps,
} from "../rental-tools.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  path: string;
  options?: RequestInit;
}

function makeDeps(
  response: unknown,
  captured: CapturedCall[] = [],
): RentalToolDeps & { captured: CapturedCall[] } {
  return {
    captured,
    async apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
      captured.push({ path, options });
      return response as T;
    },
  };
}

function makeFailingDeps(
  error: Error,
  captured: CapturedCall[] = [],
): RentalToolDeps & { captured: CapturedCall[] } {
  return {
    captured,
    async apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
      captured.push({ path, options });
      throw error;
    },
  };
}

// ---------------------------------------------------------------------------
// rental_emit_activity
// ---------------------------------------------------------------------------

describe("rentalEmitActivity", () => {
  it("calls POST /api/rental/sessions/:id/activity with event_type and payload", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ id: "rev_xyz", event_type: "agent.note" }, captured);
    const res = await rentalEmitActivity(deps, {
      session_id: "rsess_10",
      event_type: "agent.note",
      payload: { message: "working on fix" },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_10/activity");
    assert.equal(captured[0].options?.method, "POST");
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.event_type, "agent.note");
    assert.equal(body.source, "agent"); // default
    assert.deepEqual(body.payload, { message: "working on fix" });
    assert.equal(body.verified, undefined); // not set → server resolves
    assert.equal(res.success, true);
  });

  it("defaults source to 'agent' when omitted", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "agent.note",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.source, "agent");
  });

  it("uses provided source when specified", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "command.run",
      source: "tool",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.source, "tool");
  });

  it("defaults payload to {} when omitted", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "agent.note",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.deepEqual(body.payload, {});
  });

  it("forwards verified override when provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "agent.note",
      verified: true,
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.verified, true);
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalEmitActivity(deps, {
      session_id: "",
      event_type: "agent.note",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("rejects missing event_type", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /event_type/);
    assert.equal(captured.length, 0);
  });

  it("URL-encodes session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalEmitActivity(deps, {
      session_id: "rsess/special",
      event_type: "agent.note",
    });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fspecial/activity",
    );
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("session_not_found"));
    const res = await rentalEmitActivity(deps, {
      session_id: "rsess_1",
      event_type: "agent.note",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_not_found/);
  });
});

// ---------------------------------------------------------------------------
// rental_complete
// ---------------------------------------------------------------------------

describe("rentalComplete", () => {
  it("calls POST /api/rental/sessions/:id/complete", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { id: "rsess_1", status: "completed" },
      captured,
    );
    const res = await rentalComplete(deps, { session_id: "rsess_1" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_1/complete");
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(res.success, true);
    assert.deepEqual(res.session, { id: "rsess_1", status: "completed" });
  });

  it("includes summary in body when provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalComplete(deps, {
      session_id: "rsess_1",
      summary: "  Fixed the auth bug  ",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.summary, "Fixed the auth bug");
  });

  it("omits summary from body when not provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalComplete(deps, { session_id: "rsess_1" });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.summary, undefined);
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalComplete(deps, { session_id: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("surfaces apiCall errors (e.g. invalid_transition)", async () => {
    const deps = makeFailingDeps(new Error("invalid_transition"));
    const res = await rentalComplete(deps, { session_id: "rsess_1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /invalid_transition/);
  });
});

// ---------------------------------------------------------------------------
// rental_cancel
// ---------------------------------------------------------------------------

describe("rentalCancel", () => {
  it("calls POST /api/rental/sessions/:id/cancel", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { id: "rsess_1", status: "cancelled" },
      captured,
    );
    const res = await rentalCancel(deps, { session_id: "rsess_1" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_1/cancel");
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(res.success, true);
    assert.deepEqual(res.session, { id: "rsess_1", status: "cancelled" });
  });

  it("includes reason in body when provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalCancel(deps, {
      session_id: "rsess_1",
      reason: "  budget_exhausted  ",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.reason, "budget_exhausted");
  });

  it("omits reason from body when not provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalCancel(deps, { session_id: "rsess_1" });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.reason, undefined);
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalCancel(deps, { session_id: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("URL-encodes session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalCancel(deps, { session_id: "rsess/with spaces" });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fwith%20spaces/cancel",
    );
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("session_not_found"));
    const res = await rentalCancel(deps, { session_id: "rsess_1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_not_found/);
  });
});
