/**
 * Tests for p3.4 budget extension requests.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BudgetExtensionDeps } from "../../api/rental/budget-extension.js";
import type { RentalToolDeps } from "../rental-tools.js";

const {
  approveBudgetExtension,
  BudgetExtensionError,
  denyBudgetExtension,
  requestBudgetExtension,
} = await import("../../api/rental/budget-extension.js");
const {
  BUDGET_EXTENSION_APPROVED,
  BUDGET_EXTENSION_DENIED,
  BUDGET_EXTENSION_REQUESTED,
} = await import("../../api/rental/activity-event-types.js");
const { registerRentalRenterRoutes } = await import("../../api/routes/rental/renter/index.js");
const { rentalRequestBudgetExtension } = await import("../rental-tools.js");

function makeMcpDeps(result: unknown, captured: Array<{ path: string; options?: RequestInit }>): RentalToolDeps {
  return {
    async apiCall(path, options) {
      captured.push({ path, options });
      return result;
    },
  };
}

describe("rentalRequestBudgetExtension MCP handler", () => {
  it("calls POST /api/rental/sessions/:id/budget-extension-requests", async () => {
    const captured: Array<{ path: string; options?: RequestInit }> = [];
    const deps = makeMcpDeps(
      { request: { id: "rev_1" }, session: { id: "rsess_1" } },
      captured,
    );

    const result = await rentalRequestBudgetExtension(deps, {
      session_id: "rsess_1",
      requested_additional_lrt: 750,
      reason: "Need enough LRT to finish tests",
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.request, { id: "rev_1" });
    assert.equal(captured[0]?.path, "/api/rental/sessions/rsess_1/budget-extension-requests");
    assert.equal(captured[0]?.options?.method, "POST");
    assert.equal(
      (captured[0]?.options?.headers as Record<string, string>)["content-type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(captured[0]?.options?.body as string), {
      requestedAdditionalLrt: 750,
      reason: "Need enough LRT to finish tests",
    });
  });

  it("validates session_id and requested_additional_lrt before calling API", async () => {
    const captured: Array<{ path: string; options?: RequestInit }> = [];
    const deps = makeMcpDeps({}, captured);

    assert.deepEqual(
      await rentalRequestBudgetExtension(deps, {
        session_id: " ",
        requested_additional_lrt: 100,
      }),
      { success: false, error: "session_id is required" },
    );
    assert.deepEqual(
      await rentalRequestBudgetExtension(deps, {
        session_id: "rsess_1",
        requested_additional_lrt: 0,
      }),
      {
        success: false,
        error: "requested_additional_lrt must be a finite positive integer",
      },
    );
    assert.equal(captured.length, 0);
  });
});

describe("budget extension service", () => {
  const baseSession = {
    id: "rsess_1",
    renter_account_id: "acct_renter",
    provider_account_id: "acct_provider",
    room_id: "room_1",
    status: "budget_exhausted",
    lrt_limit: 1_000,
  };

  function makeDeps(overrides: Partial<BudgetExtensionDeps> = {}): {
    deps: BudgetExtensionDeps;
    events: Array<Parameters<BudgetExtensionDeps["emitActivityEvent"]>[0]>;
    updates: Array<{ additionalLrt: number; status: string }>;
  } {
    const events: Array<Parameters<BudgetExtensionDeps["emitActivityEvent"]>[0]> = [];
    const updates: Array<{ additionalLrt: number; status: string }> = [];
    const deps: BudgetExtensionDeps = {
      now: () => new Date("2026-05-11T22:00:00Z"),
      getSession: async () => baseSession as never,
      getRequestEvent: async () => ({
        id: "rev_req",
        session_id: "rsess_1",
        room_id: "room_1",
        event_type: BUDGET_EXTENSION_REQUESTED,
        source: "agent",
        verified: false,
        visibility: "rental_visible",
        payload: {
          request_status: "pending",
          requested_additional_lrt: 500,
        },
        created_at: new Date("2026-05-11T22:00:00Z"),
      }) as never,
      hasDecision: async () => false,
      incrementSessionBudget: async (_sessionId, update) => {
        updates.push(update);
        const newLrtLimit = (baseSession.lrt_limit ?? 0) + update.additionalLrt;
        return {
          session: {
            ...baseSession,
            lrt_limit: newLrtLimit,
            status: update.status,
          },
          previousLrtLimit: baseSession.lrt_limit,
          newLrtLimit,
        } as never;
      },
      emitActivityEvent: async (input) => {
        events.push(input);
        return {
          id: `rev_${events.length}`,
          session_id: input.sessionId,
          room_id: input.roomId,
          event_type: input.eventType,
          source: input.source,
          verified: input.verified ?? true,
          visibility: input.visibility ?? "rental_visible",
          payload: input.payload,
          created_at: new Date("2026-05-11T22:00:00Z"),
        };
      },
      ...overrides,
    };
    return { deps, events, updates };
  }

  it("model request creates a pending extension event without granting LRT", async () => {
    const { deps, events, updates } = makeDeps();

    const result = await requestBudgetExtension(
      "rsess_1",
      "acct_provider",
      { requestedAdditionalLrt: 500, reason: "need more test budget" },
      deps,
    );

    assert.equal(result.request.event_type, BUDGET_EXTENSION_REQUESTED);
    assert.equal(events[0]?.source, "agent");
    assert.equal(events[0]?.verified, false);
    assert.deepEqual(events[0]?.payload, {
      request_status: "pending",
      requested_additional_lrt: 500,
      reason: "need more test budget",
      requested_by_account_id: "acct_provider",
      requested_by_role: "provider",
      requested_at: "2026-05-11T22:00:00.000Z",
    });
    assert.equal(updates.length, 0, "requesting must not grant budget");
  });

  it("renter approval grants additional LRT and reactivates budget_exhausted sessions", async () => {
    const { deps, events, updates } = makeDeps();

    const result = await approveBudgetExtension(
      "rsess_1",
      "acct_renter",
      "rev_req",
      {},
      deps,
    );

    assert.equal(updates[0]?.additionalLrt, 500);
    assert.equal(updates[0]?.status, "active");
    assert.equal(result.session.lrt_limit, 1_500);
    assert.equal(result.decision.event_type, BUDGET_EXTENSION_APPROVED);
    assert.equal(events[0]?.payload.request_id, "rev_req");
    assert.equal(events[0]?.payload.previous_lrt_limit, 1_000);
    assert.equal(events[0]?.payload.new_lrt_limit, 1_500);
  });

  it("model cannot grant its own extension", async () => {
    const { deps } = makeDeps();

    await assert.rejects(
      approveBudgetExtension("rsess_1", "acct_provider", "rev_req", {}, deps),
      (err) => err instanceof BudgetExtensionError
        && err.code === "not_renter"
        && err.status === 403,
    );
  });

  it("renter denial records a decision without changing LRT", async () => {
    const { deps, events, updates } = makeDeps();

    const result = await denyBudgetExtension(
      "rsess_1",
      "acct_renter",
      "rev_req",
      { reason: "scope unchanged" },
      deps,
    );

    assert.equal(result.decision.event_type, BUDGET_EXTENSION_DENIED);
    assert.equal(events[0]?.payload.reason, "scope unchanged");
    assert.equal(updates.length, 0);
  });
});

describe("budget extension renter routes", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let calls: Array<{ name: string; args: unknown[] }>;
  const accountId = "acct_renter";

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    calls = [];
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());
    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: accountId };
      next();
    });

    registerRentalRenterRoutes(app, {
      publicListings: async () => [],
      shouldAllowListingsQuery: () => true,
      createSession: async () => ({ id: "rsess_1" }) as never,
      getSessionById: async () => ({ id: "rsess_1" }) as never,
      cancelSession: async () => ({ id: "rsess_1", status: "cancelled" }) as never,
      requestBudgetExtension: async (...args) => {
        calls.push({ name: "request", args });
        return {
          session: { id: "rsess_1" },
          request: { id: "rev_req", event_type: BUDGET_EXTENSION_REQUESTED },
        } as never;
      },
      approveBudgetExtension: async (...args) => {
        calls.push({ name: "approve", args });
        return {
          session: { id: "rsess_1", lrt_limit: 1_500 },
          request: { id: "rev_req" },
          decision: { id: "rev_approved", event_type: BUDGET_EXTENSION_APPROVED },
          previousLrtLimit: 1_000,
          newLrtLimit: 1_500,
        } as never;
      },
      denyBudgetExtension: async (...args) => {
        calls.push({ name: "deny", args });
        return {
          session: { id: "rsess_1", lrt_limit: 1_000 },
          request: { id: "rev_req" },
          decision: { id: "rev_denied", event_type: BUDGET_EXTENSION_DENIED },
          previousLrtLimit: 1_000,
          newLrtLimit: 1_000,
        } as never;
      },
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as import("net").AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function post(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("POST /budget-extension-requests validates and dispatches", async () => {
    const res = await post("/api/rental/sessions/rsess_1/budget-extension-requests", {
      requestedAdditionalLrt: 250,
      reason: "finish",
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { request: { id: string } };
    assert.equal(json.request.id, "rev_req");
    assert.equal(calls[0]?.name, "request");
    assert.deepEqual(calls[0]?.args, [
      "rsess_1",
      accountId,
      { requestedAdditionalLrt: 250, reason: "finish" },
    ]);
  });

  it("approve and deny routes call renter-side handlers", async () => {
    const approved = await post(
      "/api/rental/sessions/rsess_1/budget-extension-requests/rev_req/approve",
      { approvedAdditionalLrt: 500, note: "ok" },
    );
    assert.equal(approved.status, 200);
    assert.equal(calls[0]?.name, "approve");
    assert.deepEqual(calls[0]?.args, [
      "rsess_1",
      accountId,
      "rev_req",
      { approvedAdditionalLrt: 500, note: "ok" },
    ]);

    const denied = await post(
      "/api/rental/sessions/rsess_1/budget-extension-requests/rev_req/deny",
      { reason: "too broad" },
    );
    assert.equal(denied.status, 200);
    assert.equal(calls[1]?.name, "deny");
  });

  it("maps validation and service errors", async () => {
    const invalid = await post("/api/rental/sessions/rsess_1/budget-extension-requests", {
      requestedAdditionalLrt: 0,
    });
    assert.equal(invalid.status, 400);

    const express = (await import("express")).default;
    const errApp = express();
    errApp.use(express.json());
    errApp.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_provider" };
      next();
    });
    registerRentalRenterRoutes(errApp, {
      publicListings: async () => [],
      shouldAllowListingsQuery: () => true,
      createSession: async () => ({ id: "rsess_1" }) as never,
      getSessionById: async () => ({ id: "rsess_1" }) as never,
      cancelSession: async () => null,
      approveBudgetExtension: async () => {
        throw new BudgetExtensionError("not_renter", 403);
      },
    });
    const errServer = await new Promise<http.Server>((resolve) => {
      const s = errApp.listen(0, () => resolve(s));
    });
    try {
      const addr = errServer.address() as import("net").AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/rental/sessions/rsess_1/budget-extension-requests/rev_req/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "not_renter", code: "not_renter" });
    } finally {
      await new Promise<void>((resolve) => errServer.close(() => resolve()));
    }
  });
});
