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
  rentalHeartbeat,
  rentalReportUsage,
  rentalProposeEdit,
  rentalProposePatch,
  rentalProvision,
  rentalReadFile,
  rentalRunCommand,
  rentalSearch,
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

  it("calls accept without idempotency_key when omitted", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ id: "rsess_1", status: "accepted" }, captured);
    const res = await rentalAccept(deps, { session_id: "rsess_1" });
    assert.equal(res.success, true);
    assert.equal(captured.length, 1);
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.idempotency_key, undefined);
    assert.equal(headerValue(captured[0].options, "Idempotency-Key"), undefined);
    assert.equal(res.idempotency_key, undefined);
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

describe("rentalProvision", () => {
  it("rejects missing ids without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const missingSession = await rentalProvision(deps, {
      session_id: "",
      parent_room_id: "room_1",
    });
    assert.equal(missingSession.success, false);
    assert.match(missingSession.error ?? "", /session_id/);

    const missingParent = await rentalProvision(deps, {
      session_id: "rsess_1",
      parent_room_id: "",
    });
    assert.equal(missingParent.success, false);
    assert.match(missingParent.error ?? "", /parent_room_id/);
    assert.equal(captured.length, 0);
  });

  it("calls POST provision with parent room and display name", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({
      roomId: "rroom_1",
      participantId: "rpart_1",
      session: { id: "rsess_1", status: "provisioning" },
    }, captured);

    const res = await rentalProvision(deps, {
      session_id: "rsess_1",
      parent_room_id: "github.com/BrosInCode/letagents",
      provider_display_name: "Provider Agent",
    });

    assert.equal(res.success, true);
    assert.equal(res.room_id, "rroom_1");
    assert.equal(res.participant_id, "rpart_1");
    assert.deepEqual(res.session, { id: "rsess_1", status: "provisioning" });
    assert.equal(captured[0].path, "/api/rental/provider/sessions/rsess_1/provision");
    assert.equal(captured[0].options?.method, "POST");
    const body = JSON.parse(String(captured[0].options?.body ?? "{}"));
    assert.deepEqual(body, {
      parentRoomId: "github.com/BrosInCode/letagents",
      providerDisplayName: "Provider Agent",
    });
  });

  it("surfaces provision apiCall errors", async () => {
    const deps = makeFailingDeps(new Error("invalid_status"));
    const res = await rentalProvision(deps, {
      session_id: "rsess_1",
      parent_room_id: "room_1",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /invalid_status/);
  });
});

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

  it("calls decline without idempotency_key when omitted", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ id: "rsess_1", status: "cancelled" }, captured);
    const res = await rentalDecline(deps, { session_id: "rsess_1" });
    assert.equal(res.success, true);
    assert.equal(captured.length, 1);
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.equal(body.idempotency_key, undefined);
    assert.equal(headerValue(captured[0].options, "Idempotency-Key"), undefined);
    assert.equal(res.idempotency_key, undefined);
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

// ---------------------------------------------------------------------------
// rental_heartbeat (p3.2)
// ---------------------------------------------------------------------------

describe("rentalHeartbeat", () => {
  it("rejects empty session_id without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalHeartbeat(deps, { session_id: "" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /heartbeat and unwraps recordHeartbeat result", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      {
        ok: true,
        status: "active",
        heartbeatCount: 5,
        transitioned: false,
      },
      captured,
    );
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess_1/heartbeat",
    );
    assert.equal(captured[0].options?.method, "POST");
    assert.equal(res.success, true);
    assert.equal(res.ok, true);
    assert.equal(res.status, "active");
    assert.equal(res.heartbeat_count, 5);
    assert.equal(res.transitioned, false);
  });

  it("URL-encodes the session_id path segment", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ ok: true }, captured);
    await rentalHeartbeat(deps, { session_id: "rsess/with space" });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fwith%20space/heartbeat",
    );
  });

  it("trims whitespace from session_id", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ ok: true }, captured);
    await rentalHeartbeat(deps, { session_id: "  rsess_1  " });
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_1/heartbeat");
  });

  it("propagates transitioned: true when first heartbeat lands", async () => {
    const deps = makeDeps({
      ok: true,
      status: "active",
      heartbeatCount: 1,
      transitioned: true,
    });
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(res.transitioned, true);
    assert.equal(res.status, "active");
  });

  it("surfaces apiCall errors (not_provider 403, session_not_found 404, etc.)", async () => {
    const deps = makeFailingDeps(new Error("not_provider"));
    const res = await rentalHeartbeat(deps, { session_id: "rsess_1" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /not_provider/);
  });
});

// ---------------------------------------------------------------------------
// rental_report_usage (p3.2)
// ---------------------------------------------------------------------------

describe("rentalReportUsage", () => {
  const sampleReport = {
    source: "tool",
    snapshot: {
      provider: "claude_code",
      model: "claude-3.7-sonnet",
      nativeUnit: "tokens",
      nativeUsed: null,
      nativeRemaining: null,
      nativeResetAt: null,
    },
    delta: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      requests: 1,
      credits: 0,
      usd: 0,
      toolCalls: 0,
      commandRuns: 0,
      filesExposed: 0,
      heartbeats: 0,
    },
    lrt: { lrtUsed: 300, confidence: "local_exact" },
    adapterPayload: null,
    idempotencyKey: "mcp-report-abc",
    lastHeartbeatAt: null,
  };

  it("rejects empty session_id without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "",
      report: sampleReport,
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /session_id/);
    assert.equal(captured.length, 0);
  });

  it("rejects non-object report (array / string / null)", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    for (const bad of [[1, 2, 3], "string", null] as unknown[]) {
      const res = await rentalReportUsage(deps, {
        session_id: "rsess_1",
        report: bad as Record<string, unknown>,
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /JSON object/);
    }
    assert.equal(captured.length, 0);
  });

  it("calls POST /usage with the report body verbatim", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ id: "meter_row_1" }, captured);
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: sampleReport,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/api/rental/sessions/rsess_1/usage");
    assert.equal(captured[0].options?.method, "POST");
    const body = JSON.parse(String(captured[0].options?.body ?? "null"));
    assert.deepEqual(body, sampleReport);
    assert.equal(res.success, true);
    assert.deepEqual(res.meter, { id: "meter_row_1" });
  });

  it("URL-encodes the session_id path segment", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    await rentalReportUsage(deps, {
      session_id: "rsess/special?id",
      report: sampleReport,
    });
    assert.equal(
      captured[0].path,
      "/api/rental/sessions/rsess%2Fspecial%3Fid/usage",
    );
  });

  it("surfaces apiCall errors (e.g. 400 invalid_delta) as success: false", async () => {
    const deps = makeFailingDeps(new Error("invalid_delta"));
    const res = await rentalReportUsage(deps, {
      session_id: "rsess_1",
      report: sampleReport,
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /invalid_delta/);
  });
});

// ---------------------------------------------------------------------------
// rental_read_file / rental_search (p4.4)
// ---------------------------------------------------------------------------

describe("rentalReadFile", () => {
  it("rejects empty path without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalReadFile(deps, {
      session_id: "rsess_1",
      path: "",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /path/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /context/read-file with path and maxBytes", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { success: true, path: "src/index.ts", content: "hello" },
      captured,
    );
    const res = await rentalReadFile(deps, {
      session_id: "rsess/context",
      path: " src/index.ts ",
      max_bytes: 4096,
    });

    assert.equal(res.success, true);
    assert.equal(
      captured[0]!.path,
      "/api/rental/sessions/rsess%2Fcontext/context/read-file",
    );
    assert.equal(captured[0]!.options?.method, "POST");
    const body = JSON.parse(String(captured[0]!.options?.body ?? "null"));
    assert.deepEqual(body, { path: "src/index.ts", maxBytes: 4096 });
  });

  it("surfaces apiCall errors as success: false", async () => {
    const deps = makeFailingDeps(new Error("workspace_not_ready"));
    const res = await rentalReadFile(deps, {
      session_id: "rsess_1",
      path: "src/index.ts",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /workspace_not_ready/);
  });
});

describe("rentalSearch", () => {
  it("rejects empty query without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalSearch(deps, {
      session_id: "rsess_1",
      query: " ",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /query/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /context/search with literal search options", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps(
      { success: true, query: "hello", results: [], count: 0 },
      captured,
    );
    const res = await rentalSearch(deps, {
      session_id: "rsess_1",
      query: " hello ",
      max_results: 10,
      case_sensitive: true,
    });

    assert.equal(res.success, true);
    assert.equal(
      captured[0]!.path,
      "/api/rental/sessions/rsess_1/context/search",
    );
    assert.equal(captured[0]!.options?.method, "POST");
    const body = JSON.parse(String(captured[0]!.options?.body ?? "null"));
    assert.deepEqual(body, {
      query: "hello",
      maxResults: 10,
      caseSensitive: true,
    });
  });
});

// ---------------------------------------------------------------------------
// rental_propose_edit / rental_propose_patch / rental_run_command (p5.3)
// ---------------------------------------------------------------------------

describe("rentalProposeEdit", () => {
  it("rejects missing idempotency key without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalProposeEdit(deps, {
      session_id: "rsess_1",
      idempotency_key: "",
      path: "src/index.ts",
      before_content: "old",
      after_content: "new",
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /idempotency/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /patches/propose-edit with whole-file contents", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ success: true, proposalId: "rpatch_1" }, captured);
    const res = await rentalProposeEdit(deps, {
      session_id: "rsess_1",
      idempotency_key: " edit-1 ",
      path: " src/index.ts ",
      before_content: "old\n",
      after_content: "new\n",
      summary: " update ",
    });

    assert.equal(res.success, true);
    assert.equal(captured[0]!.path, "/api/rental/sessions/rsess_1/patches/propose-edit");
    assert.equal(captured[0]!.options?.method, "POST");
    const body = JSON.parse(String(captured[0]!.options?.body ?? "null"));
    assert.deepEqual(body, {
      idempotencyKey: "edit-1",
      path: "src/index.ts",
      beforeContent: "old\n",
      afterContent: "new\n",
      summary: "update",
    });
  });
});

describe("rentalProposePatch", () => {
  it("rejects empty file arrays without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalProposePatch(deps, {
      session_id: "rsess_1",
      idempotency_key: "patch-1",
      files: [],
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /files/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /patches/propose-patch with files and summary", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ success: true, proposalId: "rpatch_2" }, captured);
    const files = [{ path: "src/index.ts", operation: "modify", content: "new" }];
    const res = await rentalProposePatch(deps, {
      session_id: "rsess_1",
      idempotency_key: "patch-1",
      files,
      summary: "Update index",
    });

    assert.equal(res.success, true);
    assert.equal(captured[0]!.path, "/api/rental/sessions/rsess_1/patches/propose-patch");
    assert.equal(captured[0]!.options?.method, "POST");
    const body = JSON.parse(String(captured[0]!.options?.body ?? "null"));
    assert.deepEqual(body, {
      idempotencyKey: "patch-1",
      files,
      summary: "Update index",
    });
  });
});

describe("rentalRunCommand", () => {
  it("rejects empty argv without calling apiCall", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({}, captured);
    const res = await rentalRunCommand(deps, {
      session_id: "rsess_1",
      argv: [],
    });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /argv/);
    assert.equal(captured.length, 0);
  });

  it("calls POST /commands/run with trimmed argv and timeout", async () => {
    const captured: CapturedCall[] = [];
    const deps = makeDeps({ success: true, exitCode: 0 }, captured);
    const res = await rentalRunCommand(deps, {
      session_id: "rsess_1",
      argv: [" node ", "--test", "src/foo.test.ts"],
      timeout_ms: 5000,
    });

    assert.equal(res.success, true);
    assert.equal(captured[0]!.path, "/api/rental/sessions/rsess_1/commands/run");
    assert.equal(captured[0]!.options?.method, "POST");
    const body = JSON.parse(String(captured[0]!.options?.body ?? "null"));
    assert.deepEqual(body, {
      argv: ["node", "--test", "src/foo.test.ts"],
      timeoutMs: 5000,
    });
  });
});
