/**
 * Tests for rental MCP tool handlers (p3.1).
 *
 * Verifies:
 *   - rental_list_requests   → GET /api/rental/provider/requests
 *   - rental_accept          → POST .../sessions/:id/accept + idempotency key
 *   - rental_decline         → POST .../sessions/:id/decline + idempotency key
 *   - input validation rejects missing fields without calling apiCall
 *   - error responses from apiCall surface as { success: false, error }
 *
 * Uses a fake apiCall to introspect the wire shape (path, method, headers,
 * body) without booting a real MCP transport or HTTP server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rentalListRequests,
  rentalAccept,
  rentalDecline,
  type RentalToolDeps,
} from "../rental-tools.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  path: string;
  options?: RequestInit;
}

function makeDeps(response: unknown, captured: CapturedCall[] = []): RentalToolDeps & {
  captured: CapturedCall[];
} {
  return {
    captured,
    async apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
      captured.push({ path, options });
      return response as T;
    },
  };
}

function makeFailingDeps(error: Error, captured: CapturedCall[] = []): RentalToolDeps & {
  captured: CapturedCall[];
} {
  return {
    captured,
    async apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
      captured.push({ path, options });
      throw error;
    },
  };
}

function headerValue(opts: RequestInit | undefined, name: string): string | undefined {
  const h = opts?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === name.toLowerCase()) return h[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// rental_list_requests
// ---------------------------------------------------------------------------

describe("rentalListRequests", () => {
  it("calls GET /api/rental/provider/requests and returns array", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      [{ id: "rsess_1" }, { id: "rsess_2" }],
      captured
    );
    const res = await rentalListRequests(deps);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/provider/requests");
    assert.equal(captured[0].options?.method, "GET");
    assert.equal(res.success, true);
    assert.equal(res.count, 2);
    assert.deepEqual(res.requests, [{ id: "rsess_1" }, { id: "rsess_2" }]);
  });

  it("unwraps { requests: [...] } envelope shape", async () => {
    const deps = makeDeps({ requests: [{ id: "rsess_3" }] });
    const res = await rentalListRequests(deps);
    assert.equal(res.success, true);
    assert.equal(res.count, 1);
    assert.deepEqual(res.requests, [{ id: "rsess_3" }]);
  });

  it("returns empty array when response is neither array nor envelope", async () => {
    const deps = makeDeps({ something: "else" });
    const res = await rentalListRequests(deps);
    assert.equal(res.success, true);
    assert.deepEqual(res.requests, []);
    assert.equal(res.count, 0);
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("rent_disabled"));
    const res = await rentalListRequests(deps);
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /rent_disabled/);
    assert.deepEqual(res.requests, []);
  });
});

// ---------------------------------------------------------------------------
// rental_accept
// ---------------------------------------------------------------------------

describe("rentalAccept", () => {
  it("rejects missing session_id without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalAccept(deps, { session_id: "", idempotency_key: "k1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("rejects missing idempotency_key without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalAccept(deps, { session_id: "rsess_1", idempotency_key: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /idempotency_key/);
    assert.equal(captured.length, 0);
  });

  it("calls POST accept with idempotency-key header + body", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { id: "rsess_1", status: "accepted" },
      captured
    );
    const res = await rentalAccept(deps, {
      session_id: "rsess_1",
      idempotency_key: "key-abc",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/provider/sessions/rsess_1/accept");
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(
      headerValue(captured[0].options, "Idempotency-Key"),
      "key-abc"
    );
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.idempotency_key, "key-abc");
    assert.equal(res.success, true);
    assert.deepEqual(res.session, { id: "rsess_1", status: "accepted" });
    assert.equal(res.idempotency_key, "key-abc");
  });

  it("URL-encodes the session_id path segment", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalAccept(deps, {
      session_id: "rsess/with weird?chars",
      idempotency_key: "k",
    });
    assert.equal(
      captured[0].path,
      "/api/rental/provider/sessions/rsess%2Fwith%20weird%3Fchars/accept"
    );
  });

  it("trims whitespace from inputs before transmission", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalAccept(deps, {
      session_id: "  rsess_1  ",
      idempotency_key: "  key-trim  ",
    });
    assert.equal(captured[0].path, "/api/rental/provider/sessions/rsess_1/accept");
    assert.equal(
      headerValue(captured[0].options, "Idempotency-Key"),
      "key-trim"
    );
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.idempotency_key, "key-trim");
  });

  it("surfaces apiCall errors as success: false with idempotency_key echoed", async () => {
    const deps = makeFailingDeps(new Error("invalid_transition"));
    const res = await rentalAccept(deps, {
      session_id: "rsess_1",
      idempotency_key: "k1",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /invalid_transition/);
    assert.equal(res.idempotency_key, "k1");
  });
});

// ---------------------------------------------------------------------------
// rental_decline
// ---------------------------------------------------------------------------

describe("rentalDecline", () => {
  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalDecline(deps, {
      session_id: "",
      idempotency_key: "k",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("rejects missing idempotency_key", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalDecline(deps, {
      session_id: "rsess_1",
      idempotency_key: "",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /idempotency_key/);
    assert.equal(captured.length, 0);
  });

  it("calls POST decline with idempotency-key header + body", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ id: "rsess_1", status: "cancelled" }, captured);
    const res = await rentalDecline(deps, {
      session_id: "rsess_1",
      idempotency_key: "decline-1",
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/provider/sessions/rsess_1/decline");
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(
      headerValue(captured[0].options, "Idempotency-Key"),
      "decline-1"
    );
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.idempotency_key, "decline-1");
    assert.equal(body.reason, undefined);
    assert.equal(res.success, true);
    assert.deepEqual(res.session, { id: "rsess_1", status: "cancelled" });
  });

  it("includes reason in body when provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalDecline(deps, {
      session_id: "rsess_1",
      idempotency_key: "k",
      reason: "  busy right now  ",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.reason, "busy right now");
  });

  it("omits empty/whitespace reason from body", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalDecline(deps, {
      session_id: "rsess_1",
      idempotency_key: "k",
      reason: "   ",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.reason, undefined);
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("session_not_found"));
    const res = await rentalDecline(deps, {
      session_id: "rsess_1",
      idempotency_key: "k",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_not_found/);
    assert.equal(res.idempotency_key, "k");
  });
});
