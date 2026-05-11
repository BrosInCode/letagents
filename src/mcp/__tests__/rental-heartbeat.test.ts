/**
 * Tests for p3.2 rental MCP tool handlers.
 *
 * Verifies:
 *   - rental_heartbeat        → POST /api/rental/sessions/:id/heartbeat
 *   - rental_refresh_quota    → POST /api/rental/sessions/:id/refresh-quota
 *   - rental_report_usage     → POST /api/rental/sessions/:id/usage
 *   - input validation rejects missing/malformed fields without calling apiCall
 *   - error responses from apiCall surface as { success: false, error }
 *
 * Uses a fake apiCall to introspect the wire shape (path, method, headers,
 * body) without booting a real MCP transport or HTTP server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rentalHeartbeat,
  rentalRefreshQuota,
  rentalReportUsage,
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
// rental_heartbeat
// ---------------------------------------------------------------------------

describe("rentalHeartbeat", () => {
  it("calls POST /api/rental/sessions/:id/heartbeat", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { ok: true, status: "active", heartbeatCount: 5, transitioned: false },
      captured,
    );
    const res = await rentalHeartbeat(deps, { session_id: "rsess_42" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_42/heartbeat");
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(res.success, true);
    assert.equal(res.ok, true);
    assert.equal(res.status, "active");
    assert.equal(res.heartbeat_count, 5);
    assert.equal(res.transitioned, false);
  });

  it("defaults ok=true and transitioned=false for minimal response", async () => {
    const deps = makeDeps({});
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(res.success, true);
    assert.equal(res.ok, true);
    assert.equal(res.transitioned, false);
  });

  it("detects provisioning → active transition", async () => {
    const deps = makeDeps({
      ok: true,
      status: "active",
      heartbeatCount: 1,
      transitioned: true,
    });
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(res.transitioned, true);
    assert.equal(res.status, "active");
    assert.equal(res.heartbeat_count, 1);
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalHeartbeat(deps, { session_id: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("URL-encodes session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalHeartbeat(deps, { session_id: "rsess/special?id" });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fspecial%3Fid/heartbeat",
    );
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("not_provider"));
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /not_provider/);
  });
});

// ---------------------------------------------------------------------------
// rental_refresh_quota
// ---------------------------------------------------------------------------

describe("rentalRefreshQuota", () => {
  it("calls POST /api/rental/sessions/:id/refresh-quota", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { snapshot: { percentRemaining: 0.75 }, refreshed: true },
      captured,
    );
    const res = await rentalRefreshQuota(deps, { session_id: "rsess_10" });

    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess_10/refresh-quota",
    );
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(res.success, true);
    assert.deepEqual(res.snapshot, { percentRemaining: 0.75 });
    assert.equal(res.refreshed, true);
  });

  it("includes provider in body when provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ snapshot: null, refreshed: false }, captured);
    await rentalRefreshQuota(deps, {
      session_id: "rsess_10",
      provider: "  antigravity  ",
    });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.provider, "antigravity");
  });

  it("omits provider from body when not provided", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ snapshot: null }, captured);
    await rentalRefreshQuota(deps, { session_id: "rsess_10" });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.provider, undefined);
  });

  it("omits empty/whitespace provider from body", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalRefreshQuota(deps, { session_id: "rsess_10", provider: "   " });
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.provider, undefined);
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalRefreshQuota(deps, { session_id: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("defaults refreshed=true when server omits field", async () => {
    const deps = makeDeps({ snapshot: { percentRemaining: 0.5 } });
    const res = await rentalRefreshQuota(deps, { session_id: "rsess_1" });
    assert.equal(res.refreshed, true);
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("adapter_unavailable"));
    const res = await rentalRefreshQuota(deps, { session_id: "rsess_1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /adapter_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// rental_report_usage
// ---------------------------------------------------------------------------

describe("rentalReportUsage", () => {
  it("calls POST /api/rental/sessions/:id/usage with report body", async () => {
    const captured: CapturedCall[] = [];
    const report = {
      source: "agent",
      snapshot: { lrtUsed: 100 },
      delta: { lrtDelta: 50 },
      lrt: { lrtUsed: 100, lrtRemaining: 900 },
      idempotencyKey: "usage-k1",
    };
    const deps = makeDeps({ id: "meter_1", accepted: true }, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_5",
      report,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_5/usage");
    assert.equal(captured[0].options?.method, "POST");
    const sentBody = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.deepEqual(sentBody, report);
    assert.equal(res.success, true);
    assert.deepEqual(res.meter, { id: "meter_1", accepted: true });
  });

  it("rejects missing session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "",
      report: { source: "agent" },
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("rejects null report", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: null as unknown as Record<string, unknown>,
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /report must be a JSON object/);
    assert.equal(captured.length, 0);
  });

  it("rejects array report", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: [1, 2, 3] as unknown as Record<string, unknown>,
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /report must be a JSON object/);
    assert.equal(captured.length, 0);
  });

  it("URL-encodes session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalReportUsage(deps, {
      session_id: "rsess/weird",
      report: { source: "agent" },
    });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fweird/usage",
    );
  });

  it("sets content-type header to application/json", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: { source: "agent" },
    });
    const h = captured[0].options?.headers as Record<string, string>;
    assert.equal(h["content-type"], "application/json");
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("malformed_report"));
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: { source: "agent" },
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /malformed_report/);
  });
});
