/**
 * Tests for the context access request service + routes.
 *
 * Service tests use injected deps (no live DB). Route tests spin up an
 * express app with fake deps, matching rental-patch-tools-routes.test.ts.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type http from "node:http";

import {
  ContextRequestError,
  createContextRequest,
  decideContextRequest,
  normalizeRequestPath,
  type ContextRequestRecord,
  type ContextRequestsDeps,
} from "../rental/context-requests.js";

// ===== Helpers =====

function makeRecord(overrides: Partial<ContextRequestRecord> = {}): ContextRequestRecord {
  const now = new Date();
  return {
    id: "rctxr_1",
    session_id: "rsess_1",
    path: "docs/spec.md",
    request_type: "read_file",
    status: "pending",
    reason: null,
    requested_by: "acct_provider",
    decided_by: null,
    decided_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

interface FakeState {
  rows: ContextRequestRecord[];
  materializeCalls: Array<{ sessionId: string; path: string }>;
  events: Array<{ eventType: string; source: string; payload: Record<string, unknown> }>;
  materializeResult: { materialized: boolean; reason?: string };
  roomId: string | null;
}

function makeDeps(state: FakeState): ContextRequestsDeps {
  return {
    async findPendingByPath(sessionId, path) {
      return (
        state.rows.find(
          (r) => r.session_id === sessionId && r.path === path && r.status === "pending",
        ) ?? null
      );
    },
    async findApprovedByPath(sessionId, path) {
      return (
        state.rows.find(
          (r) => r.session_id === sessionId && r.path === path && r.status === "approved",
        ) ?? null
      );
    },
    async getById(sessionId, requestId) {
      return (
        state.rows.find((r) => r.id === requestId && r.session_id === sessionId) ?? null
      );
    },
    async insert(row) {
      state.rows.push(row);
      return row;
    },
    async list(sessionId) {
      return state.rows.filter((r) => r.session_id === sessionId);
    },
    async updateDecision(requestId, fields) {
      // Conditional on pending, matching the drizzle default deps.
      const row = state.rows.find((r) => r.id === requestId && r.status === "pending");
      if (!row) return null;
      Object.assign(row, fields, { updated_at: new Date() });
      return row;
    },
    generateId: () => `rctxr_${state.rows.length + 1}`,
    async materializeApprovedPath(sessionId, path) {
      state.materializeCalls.push({ sessionId, path });
      return state.materializeResult;
    },
    async getSessionRoomId() {
      return state.roomId;
    },
    async emitActivityEvent(input) {
      state.events.push({
        eventType: input.eventType,
        source: input.source,
        payload: input.payload,
      });
      return {} as never;
    },
  };
}

function makeState(): FakeState {
  return {
    rows: [],
    materializeCalls: [],
    events: [],
    materializeResult: { materialized: true },
    roomId: "room_1",
  };
}

// ===== normalizeRequestPath =====

describe("normalizeRequestPath", () => {
  it("normalizes separators and redundant segments", () => {
    assert.strictEqual(normalizeRequestPath("src\\api\\./sessions.ts"), "src/api/sessions.ts");
    assert.strictEqual(normalizeRequestPath("a/b/../c.txt"), "a/c.txt");
  });
  it("rejects absolute, traversal, and null-byte paths", () => {
    assert.strictEqual(normalizeRequestPath("/etc/passwd"), null);
    assert.strictEqual(normalizeRequestPath("C:\\secrets.txt"), null);
    assert.strictEqual(normalizeRequestPath("../outside.txt"), null);
    assert.strictEqual(normalizeRequestPath("a/\0b"), null);
    assert.strictEqual(normalizeRequestPath("   "), null);
  });
});

// ===== createContextRequest =====

describe("createContextRequest", () => {
  it("creates a pending request and emits context.access_requested", async () => {
    const state = makeState();
    const record = await createContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      path: "docs/spec.md",
      reason: "need the spec",
      requestedBy: "acct_provider",
    });
    assert.strictEqual(record.status, "pending");
    assert.strictEqual(record.path, "docs/spec.md");
    assert.strictEqual(state.events.length, 1);
    assert.strictEqual(state.events[0]!.eventType, "context.access_requested");
    assert.strictEqual(state.events[0]!.source, "provider");
  });

  it("is idempotent per (session, path) while pending", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const first = await createContextRequest(deps, { sessionId: "rsess_1", path: "a.txt" });
    const second = await createContextRequest(deps, { sessionId: "rsess_1", path: "./a.txt" });
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(state.rows.length, 1);
  });

  it("rejects traversal paths with invalid_input", async () => {
    const state = makeState();
    await assert.rejects(
      () => createContextRequest(makeDeps(state), { sessionId: "rsess_1", path: "../../etc/passwd" }),
      (err: unknown) =>
        err instanceof ContextRequestError && err.code === "invalid_input" && err.status === 400,
    );
  });

  it("truncates overlong reasons to 500 chars", async () => {
    const state = makeState();
    const record = await createContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      path: "a.txt",
      reason: "x".repeat(600),
    });
    assert.strictEqual(record.reason?.length, 500);
  });

  it("re-requesting an approved path retries delivery instead of filing a new request", async () => {
    const state = makeState();
    state.rows.push(makeRecord({ status: "approved", decided_by: "acct_renter" }));
    const record = await createContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      path: "docs/spec.md",
    });
    assert.strictEqual(record.id, "rctxr_1");
    assert.strictEqual(record.status, "approved");
    assert.strictEqual(state.rows.length, 1, "no new pending row created");
    assert.deepStrictEqual(state.materializeCalls, [
      { sessionId: "rsess_1", path: "docs/spec.md" },
    ]);
  });
});

// ===== decideContextRequest =====

describe("decideContextRequest", () => {
  it("approves a pending request and materializes the file", async () => {
    const state = makeState();
    state.rows.push(makeRecord());
    const result = await decideContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      requestId: "rctxr_1",
      decision: "approved",
      decidedBy: "acct_renter",
    });
    assert.strictEqual(result.request.status, "approved");
    assert.strictEqual(result.request.decided_by, "acct_renter");
    assert.strictEqual(result.materialized, true);
    assert.deepStrictEqual(state.materializeCalls, [
      { sessionId: "rsess_1", path: "docs/spec.md" },
    ]);
    assert.strictEqual(state.events.at(-1)!.eventType, "context.access_approved");
    assert.strictEqual(state.events.at(-1)!.source, "renter");
  });

  it("records approval even when materialization fails", async () => {
    const state = makeState();
    state.materializeResult = { materialized: false, reason: "bare_clone_missing" };
    state.rows.push(makeRecord());
    const result = await decideContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      requestId: "rctxr_1",
      decision: "approved",
      decidedBy: "acct_renter",
    });
    assert.strictEqual(result.request.status, "approved");
    assert.strictEqual(result.materialized, false);
    assert.strictEqual(result.materializeReason, "bare_clone_missing");
  });

  it("denies without materializing", async () => {
    const state = makeState();
    state.rows.push(makeRecord());
    const result = await decideContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      requestId: "rctxr_1",
      decision: "denied",
      decidedBy: "acct_renter",
    });
    assert.strictEqual(result.request.status, "denied");
    assert.strictEqual(state.materializeCalls.length, 0);
    assert.strictEqual(state.events.at(-1)!.eventType, "context.access_denied");
  });

  it("re-deciding with the same decision is idempotent", async () => {
    const state = makeState();
    state.rows.push(makeRecord({ status: "denied", decided_by: "acct_renter" }));
    const result = await decideContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      requestId: "rctxr_1",
      decision: "denied",
      decidedBy: "acct_renter",
    });
    assert.strictEqual(result.request.status, "denied");
  });

  it("re-approving retries delivery for a previously unmaterialized approval", async () => {
    const state = makeState();
    state.rows.push(makeRecord({ status: "approved", decided_by: "acct_renter" }));
    const result = await decideContextRequest(makeDeps(state), {
      sessionId: "rsess_1",
      requestId: "rctxr_1",
      decision: "approved",
      decidedBy: "acct_renter",
    });
    assert.strictEqual(result.request.status, "approved");
    assert.strictEqual(result.materialized, true);
    assert.deepStrictEqual(state.materializeCalls, [
      { sessionId: "rsess_1", path: "docs/spec.md" },
    ]);
  });

  it("flipping a decided request is a 409", async () => {
    const state = makeState();
    state.rows.push(makeRecord({ status: "denied" }));
    await assert.rejects(
      () =>
        decideContextRequest(makeDeps(state), {
          sessionId: "rsess_1",
          requestId: "rctxr_1",
          decision: "approved",
          decidedBy: "acct_renter",
        }),
      (err: unknown) =>
        err instanceof ContextRequestError && err.code === "already_decided" && err.status === 409,
    );
  });

  it("resolves a lost decide race via the conditional update", async () => {
    const state = makeState();
    state.rows.push(makeRecord());
    const deps = makeDeps(state);
    // Simulate a concurrent denial landing between getById and update.
    const originalGetById = deps.getById.bind(deps);
    deps.getById = async (sessionId, requestId) => {
      const row = await originalGetById(sessionId, requestId);
      if (row && row.status === "pending") {
        // First read sees pending; then the rival decision commits.
        const snapshot = { ...row };
        row.status = "denied";
        row.decided_by = "acct_rival";
        return snapshot;
      }
      return row;
    };
    await assert.rejects(
      () =>
        decideContextRequest(deps, {
          sessionId: "rsess_1",
          requestId: "rctxr_1",
          decision: "approved",
          decidedBy: "acct_renter",
        }),
      (err: unknown) =>
        err instanceof ContextRequestError && err.code === "already_decided",
    );
    // The rival's decision was not overwritten.
    assert.strictEqual(state.rows[0]!.decided_by, "acct_rival");
  });

  it("resolves a lost create race to the winner's pending row", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const winner = makeRecord({ id: "rctxr_winner", path: "a.txt" });
    deps.insert = async () => {
      // Simulate the unique pending index rejecting the loser.
      state.rows.push(winner);
      throw new Error("duplicate key value violates unique constraint");
    };
    const record = await createContextRequest(deps, {
      sessionId: "rsess_1",
      path: "a.txt",
    });
    assert.strictEqual(record.id, "rctxr_winner");
  });

  it("404s for a request on another session", async () => {
    const state = makeState();
    state.rows.push(makeRecord({ session_id: "rsess_other" }));
    await assert.rejects(
      () =>
        decideContextRequest(makeDeps(state), {
          sessionId: "rsess_1",
          requestId: "rctxr_1",
          decision: "approved",
          decidedBy: "acct_renter",
        }),
      (err: unknown) =>
        err instanceof ContextRequestError && err.code === "request_not_found" && err.status === 404,
    );
  });
});

// ===== Routes =====

describe("context request + exposure routes", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let role: "renter" | "provider" | null;
  let state: FakeState;
  let exposures: unknown[];

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    role = "renter";
    state = makeState();
    exposures = [{ id: "rexpo_1", path: "a.txt" }];

    const express = (await import("express")).default;
    const { registerContextRequestRoutes } = await import(
      "../routes/rental/internal/context-request-routes.js"
    );
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_1" };
      next();
    });

    const serviceDeps = makeDeps(state);
    registerContextRequestRoutes(app, {
      resolveSessionAccess: async () => role,
      createContextRequest: (sessionId, input) =>
        createContextRequest(serviceDeps, { sessionId, ...input }),
      listContextRequests: (sessionId) => serviceDeps.list(sessionId),
      decideContextRequest: (sessionId, input) =>
        decideContextRequest(serviceDeps, { sessionId, ...input }),
      listSessionExposures: async () => exposures as never,
    } as never);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(() => {
    server?.close();
  });

  async function req(method: string, path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("POST creates a request as the provider (201)", async () => {
    role = "provider";
    const res = await req("POST", "/api/rental/sessions/rsess_1/context-requests", {
      path: "docs/spec.md",
      reason: "need it",
    });
    assert.strictEqual(res.status, 201);
    const json = (await res.json()) as { status: string; path: string };
    assert.strictEqual(json.status, "pending");
    assert.strictEqual(json.path, "docs/spec.md");
  });

  it("POST create is provider-only (403 for renter)", async () => {
    role = "renter";
    const res = await req("POST", "/api/rental/sessions/rsess_1/context-requests", {
      path: "docs/spec.md",
    });
    assert.strictEqual(res.status, 403);
  });

  it("POST rejects traversal path (400)", async () => {
    role = "provider";
    const res = await req("POST", "/api/rental/sessions/rsess_1/context-requests", {
      path: "../../etc/passwd",
    });
    assert.strictEqual(res.status, 400);
  });

  it("GET lists requests for the session", async () => {
    state.rows.push(makeRecord());
    const res = await req("GET", "/api/rental/sessions/rsess_1/context-requests");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as unknown[];
    assert.strictEqual(json.length, 1);
  });

  it("approve is renter-only (403 for provider)", async () => {
    role = "provider";
    state.rows.push(makeRecord());
    const res = await req(
      "POST",
      "/api/rental/sessions/rsess_1/context-requests/rctxr_1/approve",
    );
    assert.strictEqual(res.status, 403);
  });

  it("renter approve returns decision with materialized flag", async () => {
    state.rows.push(makeRecord());
    const res = await req(
      "POST",
      "/api/rental/sessions/rsess_1/context-requests/rctxr_1/approve",
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as {
      request: { status: string };
      materialized: boolean;
    };
    assert.strictEqual(json.request.status, "approved");
    assert.strictEqual(json.materialized, true);
  });

  it("deny after approve is a 409", async () => {
    state.rows.push(makeRecord({ status: "approved" }));
    const res = await req(
      "POST",
      "/api/rental/sessions/rsess_1/context-requests/rctxr_1/deny",
    );
    assert.strictEqual(res.status, 409);
  });

  it("GET exposures returns the ledger for either role", async () => {
    role = "provider";
    const res = await req("GET", "/api/rental/sessions/rsess_1/exposures");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as unknown[];
    assert.strictEqual(json.length, 1);
  });

  it("404s when the caller has no session access", async () => {
    role = null;
    const res = await req("GET", "/api/rental/sessions/rsess_1/context-requests");
    assert.strictEqual(res.status, 404);
  });
});
