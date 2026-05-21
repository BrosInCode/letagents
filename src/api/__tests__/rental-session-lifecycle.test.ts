/**
 * Tests for rental session lifecycle — p1.3.
 *
 * Tests the state machine (§18.2), renter route handlers, and provider
 * session routes (accept/decline/list requests).
 * Uses dependency injection (no live DB), same pattern as rental-listings.test.ts.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import { isValidTransition } from "../rental/session-state-machine.js";

// ===== State Machine Tests =====

describe("isValidTransition (§18.2 state machine)", () => {
  // Valid transitions
  it("requested → accepted is valid", () => {
    assert.ok(isValidTransition("requested", "accepted"));
  });
  it("requested → cancelled is valid", () => {
    assert.ok(isValidTransition("requested", "cancelled"));
  });
  it("accepted → provisioning is valid", () => {
    assert.ok(isValidTransition("accepted", "provisioning"));
  });
  it("provisioning → active is valid", () => {
    assert.ok(isValidTransition("provisioning", "active"));
  });
  it("provisioning → failed is valid", () => {
    assert.ok(isValidTransition("provisioning", "failed"));
  });
  it("active → blocked is valid", () => {
    assert.ok(isValidTransition("active", "blocked"));
  });
  it("active → cancelled is valid", () => {
    assert.ok(isValidTransition("active", "cancelled"));
  });
  it("active → patch_review is valid", () => {
    assert.ok(isValidTransition("active", "patch_review"));
  });
  it("active → budget_exhausted is valid", () => {
    assert.ok(isValidTransition("active", "budget_exhausted"));
  });
  it("active → expired is valid", () => {
    assert.ok(isValidTransition("active", "expired"));
  });
  it("budget_exhausted → active is valid (extend budget)", () => {
    assert.ok(isValidTransition("budget_exhausted", "active"));
  });
  it("budget_exhausted → completed is valid", () => {
    assert.ok(isValidTransition("budget_exhausted", "completed"));
  });
  it("budget_exhausted → cancelled is valid", () => {
    assert.ok(isValidTransition("budget_exhausted", "cancelled"));
  });

  // Invalid transitions
  it("requested → active is invalid (must go through accepted)", () => {
    assert.ok(!isValidTransition("requested", "active"));
  });
  it("completed → active is invalid (terminal state)", () => {
    assert.ok(!isValidTransition("completed", "active"));
  });
  it("cancelled → active is invalid (terminal state)", () => {
    assert.ok(!isValidTransition("cancelled", "active"));
  });
  it("failed → active is invalid (terminal state)", () => {
    assert.ok(!isValidTransition("failed", "active"));
  });
  it("expired → active is invalid (terminal state)", () => {
    assert.ok(!isValidTransition("expired", "active"));
  });
  it("requested → completed is invalid (skip states)", () => {
    assert.ok(!isValidTransition("requested", "completed"));
  });
});

// ===== Renter Route Handler Tests =====

describe("renter session route handlers", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let deps: Record<string, (...args: unknown[]) => unknown>;
  const FAKE_ACCOUNT_ID = "acct_renter_123";

  beforeEach(async () => {
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    process.env.LETAGENTS_RENT_ENABLED = "true";

    deps = {
      // p1.1b public listings deps
      publicListings: async () => [],
      shouldAllowListingsQuery: () => true,
      // p1.3 session deps
      createSession: async (input: unknown) => ({
        id: "rsess_1",
        status: "requested",
        ...(input as Record<string, unknown>),
      }),
      getSessionById: async () => ({
        id: "rsess_1",
        status: "active",
        renter_account_id: FAKE_ACCOUNT_ID,
      }),
      cancelSession: async () => ({
        id: "rsess_1",
        status: "cancelled",
      }),
    };

    // Inject auth
    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = {
        account_id: FAKE_ACCOUNT_ID,
      };
      next();
    });

    const { registerRentalRenterRoutes } = await import(
      "../routes/rental-renter.js"
    );
    registerRentalRenterRoutes(app, deps as never);

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

  async function req(method: string, path: string, body?: unknown) {
    const opts: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(`${baseUrl}${path}`, opts);
  }

  it("returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await req("POST", "/api/rental/sessions", {
      listingId: "l1",
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskTitle: "t",
      taskPrompt: "p",
    });
    assert.strictEqual(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "rent_disabled");
  });

  it("returns 401 when unauthenticated", async () => {
    // Make a fresh app with no auth middleware
    const express = (await import("express")).default;
    const unauthedApp = express();
    unauthedApp.use(express.json());
    const { registerRentalRenterRoutes: register } = await import(
      "../routes/rental-renter.js"
    );
    register(unauthedApp, deps as never);
    const srv = await new Promise<http.Server>((resolve) => {
      const s = unauthedApp.listen(0, () => resolve(s));
    });
    try {
      const addr2 = srv.address() as import("net").AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr2.port}/api/rental/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            listingId: "l1",
            repoOwner: "o",
            repoName: "r",
            baseBranch: "main",
            taskTitle: "t",
            taskPrompt: "p",
          }),
        }
      );
      assert.strictEqual(res.status, 401);
      const json = (await res.json()) as { error: string };
      assert.strictEqual(json.error, "unauthenticated");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("create rejects missing listingId with 400", async () => {
    const res = await req("POST", "/api/rental/sessions", {
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskTitle: "t",
      taskPrompt: "p",
    });
    assert.strictEqual(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /listingId/i);
  });

  it("create rejects missing taskTitle with 400", async () => {
    const res = await req("POST", "/api/rental/sessions", {
      listingId: "l1",
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskPrompt: "p",
    });
    assert.strictEqual(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /taskTitle/i);
  });

  it("create happy path returns 201", async () => {
    const res = await req("POST", "/api/rental/sessions", {
      listingId: "l1",
      repoOwner: "owner",
      repoName: "repo",
      baseBranch: "main",
      taskTitle: "Fix tests",
      taskPrompt: "Please fix failing tests",
    });
    assert.strictEqual(res.status, 201);
    const json = (await res.json()) as { id: string; status: string };
    assert.strictEqual(json.status, "requested");
  });

  it("returns 404 when listing not found", async () => {
    deps.createSession = async () => {
      throw new Error("listing_not_found");
    };
    const res = await req("POST", "/api/rental/sessions", {
      listingId: "missing",
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskTitle: "t",
      taskPrompt: "p",
    });
    assert.strictEqual(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "listing_not_found");
  });

  it("returns 400 when mode not supported", async () => {
    deps.createSession = async () => {
      throw new Error("mode_not_supported");
    };
    const res = await req("POST", "/api/rental/sessions", {
      listingId: "l1",
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskTitle: "t",
      taskPrompt: "p",
      mode: "trusted_open",
    });
    assert.strictEqual(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "mode_not_supported");
  });

  it("passes D3 trigger fields to service", async () => {
    let captured: Record<string, unknown> | null = null;
    deps.createSession = async (input: unknown) => {
      captured = input as Record<string, unknown>;
      return { id: "rsess_2", status: "requested" };
    };
    await req("POST", "/api/rental/sessions", {
      listingId: "l1",
      repoOwner: "o",
      repoName: "r",
      baseBranch: "main",
      taskTitle: "t",
      taskPrompt: "p",
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      renterLaneProvider: "cursor",
      renterLaneModel: "claude-3.7-sonnet",
    });
    assert.ok(captured, "createSession should have been called");
    assert.strictEqual(captured!.startTrigger, "quota_exhausted");
    assert.strictEqual(captured!.triggerConfidence, "exact");
    assert.strictEqual(captured!.renterLaneProvider, "cursor");
  });

  it("GET /api/rental/sessions/:id returns session when found", async () => {
    const res = await req("GET", "/api/rental/sessions/rsess_1");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { id: string };
    assert.strictEqual(json.id, "rsess_1");
  });

  it("GET /api/rental/sessions/:id returns 404 when not found", async () => {
    deps.getSessionById = async () => null;
    const res = await req("GET", "/api/rental/sessions/missing");
    assert.strictEqual(res.status, 404);
  });

  it("POST cancel returns cancelled session", async () => {
    const res = await req("POST", "/api/rental/sessions/rsess_1/cancel");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { status: string };
    assert.strictEqual(json.status, "cancelled");
  });

  it("POST cancel returns 409 for invalid transition", async () => {
    deps.cancelSession = async () => {
      throw new Error(
        "invalid_transition: cannot move from completed to cancelled"
      );
    };
    const res = await req("POST", "/api/rental/sessions/rsess_1/cancel");
    assert.strictEqual(res.status, 409);
  });

  // ===== p2.10a session-activity route =====

  it("GET /api/rental/sessions/:id/activity returns events as renter", async () => {
    deps.getSessionById = async () => ({
      id: "rsess_1",
      status: "active",
      renter_account_id: FAKE_ACCOUNT_ID,
      provider_account_id: "acct_provider_zzz",
    });
    let captured: { role?: string; limit?: number; verifiedOnly?: boolean } | null = null;
    deps.listSessionActivity = async (
      _sessionId: unknown,
      opts: unknown,
    ) => {
      captured = opts as typeof captured extends infer T ? T : never;
      return [
        {
          id: "evt_1",
          session_id: "rsess_1",
          room_id: "room_1",
          event_type: "session.started",
          source: "system",
          verified: true,
          visibility: "rental_visible",
          payload: { hello: "world" },
          created_at: new Date("2026-05-12T10:00:00Z"),
        },
      ];
    };

    const res = await req(
      "GET",
      "/api/rental/sessions/rsess_1/activity?limit=42&verified_only=true",
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { events: Array<{ id: string }> };
    assert.strictEqual(json.events.length, 1);
    assert.strictEqual(json.events[0]?.id, "evt_1");
    assert.strictEqual(captured!.role, "renter");
    assert.strictEqual(captured!.limit, 42);
    assert.strictEqual(captured!.verifiedOnly, true);
  });

  it("GET /api/rental/sessions/:id/activity uses provider role when caller is provider", async () => {
    deps.getSessionById = async () => ({
      id: "rsess_1",
      status: "active",
      renter_account_id: "acct_renter_zzz",
      provider_account_id: FAKE_ACCOUNT_ID,
    });
    let captured: { role?: string } | null = null;
    deps.listSessionActivity = async (
      _sessionId: unknown,
      opts: unknown,
    ) => {
      captured = opts as typeof captured extends infer T ? T : never;
      return [];
    };

    const res = await req("GET", "/api/rental/sessions/rsess_1/activity");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured!.role, "provider");
  });

  it("GET /api/rental/sessions/:id/activity returns 404 when session is hidden from caller", async () => {
    deps.getSessionById = async () => null;
    const res = await req("GET", "/api/rental/sessions/secret/activity");
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/rental/sessions/:id/activity defaults limit to 200 and verifiedOnly to false", async () => {
    deps.getSessionById = async () => ({
      id: "rsess_1",
      status: "active",
      renter_account_id: FAKE_ACCOUNT_ID,
    });
    let captured: { limit?: number; verifiedOnly?: boolean } | null = null;
    deps.listSessionActivity = async (
      _sessionId: unknown,
      opts: unknown,
    ) => {
      captured = opts as typeof captured extends infer T ? T : never;
      return [];
    };
    const res = await req("GET", "/api/rental/sessions/rsess_1/activity");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured!.limit, 200);
    assert.strictEqual(captured!.verifiedOnly, false);
  });

  // ===== p2.11a session-usage route =====

  it("GET /api/rental/sessions/:id/usage projects the row into snapshot shape", async () => {
    deps.getSessionById = async () => ({
      id: "rsess_1",
      status: "active",
      renter_account_id: FAKE_ACCOUNT_ID,
      provider_account_id: "acct_provider",
      lrt_limit: 10_000,
      lrt_reserved: 250,
      lrt_used: 2_500,
      budget_stop_threshold: "0.95",
      time_limit_minutes: 60,
      started_at: new Date("2026-05-12T10:00:00.000Z"),
      ended_at: null,
      native_quota_latest_snapshot: { provider: "antigravity" },
      updated_at: new Date("2026-05-12T10:30:00.000Z"),
    });
    const res = await req("GET", "/api/rental/sessions/rsess_1/usage");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as {
      session_id: string;
      lrt_limit: number;
      lrt_reserved: number;
      lrt_used: number;
      lrt_remaining: number;
      budget_stop_threshold: number;
      time_limit_minutes: number;
      started_at: string;
      ends_at: string;
      quota_snapshot: Record<string, unknown>;
      updated_at: string;
    };
    assert.strictEqual(json.session_id, "rsess_1");
    assert.strictEqual(json.lrt_limit, 10_000);
    assert.strictEqual(json.lrt_reserved, 250);
    assert.strictEqual(json.lrt_used, 2_500);
    assert.strictEqual(json.lrt_remaining, 7_250);
    assert.strictEqual(json.budget_stop_threshold, 0.95);
    assert.strictEqual(json.time_limit_minutes, 60);
    assert.strictEqual(json.started_at, "2026-05-12T10:00:00.000Z");
    assert.strictEqual(json.ends_at, "2026-05-12T11:00:00.000Z");
    assert.deepStrictEqual(json.quota_snapshot, { provider: "antigravity" });
  });

  it("GET /api/rental/sessions/:id/usage returns 404 when session hidden", async () => {
    deps.getSessionById = async () => null;
    const res = await req("GET", "/api/rental/sessions/secret/usage");
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/rental/sessions/:id/usage works for unbounded budget rows", async () => {
    deps.getSessionById = async () => ({
      id: "rsess_2",
      status: "active",
      renter_account_id: FAKE_ACCOUNT_ID,
      provider_account_id: "acct_p",
      lrt_limit: null,
      lrt_reserved: 0,
      lrt_used: 1_234,
      budget_stop_threshold: null,
      time_limit_minutes: null,
      started_at: null,
      ended_at: null,
      native_quota_latest_snapshot: null,
      updated_at: new Date("2026-05-12T10:00:00.000Z"),
    });
    const res = await req("GET", "/api/rental/sessions/rsess_2/usage");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as {
      lrt_limit: number | null;
      lrt_remaining: number | null;
      time_limit_minutes: number | null;
      started_at: string | null;
      ends_at: string | null;
      quota_snapshot: unknown;
    };
    assert.strictEqual(json.lrt_limit, null);
    assert.strictEqual(json.lrt_remaining, null);
    assert.strictEqual(json.time_limit_minutes, null);
    assert.strictEqual(json.started_at, null);
    assert.strictEqual(json.ends_at, null);
    assert.strictEqual(json.quota_snapshot, null);
  });

  it("GET /api/rental/sessions/:id/usage returns 401 when unauthenticated", async () => {
    const express = (await import("express")).default;
    const unauthedApp = express();
    unauthedApp.use(express.json());
    const { registerRentalRenterRoutes: register } = await import(
      "../routes/rental-renter.js"
    );
    register(unauthedApp, deps as never);
    const srv = await new Promise<http.Server>((resolve) => {
      const s = unauthedApp.listen(0, () => resolve(s));
    });
    try {
      const addr = srv.address() as import("net").AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/rental/sessions/rsess_1/usage`,
      );
      assert.strictEqual(res.status, 401);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

// ===== Provider Session Route Tests =====

describe("provider session route handlers (p1.3 additions)", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let deps: Record<string, (...args: unknown[]) => unknown>;
  const FAKE_PROVIDER_ID = "acct_prov_123";

  beforeEach(async () => {
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    process.env.LETAGENTS_RENT_ENABLED = "true";

    deps = {
      createListing: async () => ({}),
      updateListing: async () => null,
      pauseListing: async () => null,
      resumeListing: async () => null,
      listMyListings: async () => [],
      acceptSession: async () => ({ id: "rsess_1", status: "accepted" }),
      declineSession: async () => ({ id: "rsess_1", status: "cancelled" }),
      provisionSession: async (input: Record<string, unknown>) => ({
        roomId: "rroom_1",
        participantId: "rpart_1",
        session: {
          id: input.sessionId,
          room_id: "rroom_1",
          status: "provisioning",
        },
      }),
      listProviderRequests: async () => [
        { id: "rsess_1", status: "requested" },
      ],
    };

    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = {
        account_id: FAKE_PROVIDER_ID,
        login: "provider-login",
        display_name: "Provider Login",
        provider_user_id: "12345",
      };
      next();
    });

    const { registerRentalProviderRoutes } = await import(
      "../routes/rental-provider.js"
    );
    registerRentalProviderRoutes(app, deps as never);

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

  async function req(method: string, path: string, body?: unknown) {
    const opts: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(`${baseUrl}${path}`, opts);
  }

  it("GET /api/rental/provider/requests returns incoming requests", async () => {
    const res = await req("GET", "/api/rental/provider/requests");
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as unknown[];
    assert.strictEqual(json.length, 1);
  });

  it("POST accept returns accepted session", async () => {
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/accept"
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { status: string };
    assert.strictEqual(json.status, "accepted");
  });

  it("POST accept returns 404 for non-owned session", async () => {
    deps.acceptSession = async () => null;
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_missing/accept"
    );
    assert.strictEqual(res.status, 404);
  });

  it("POST accept returns 409 for invalid transition", async () => {
    deps.acceptSession = async () => {
      throw new Error(
        "invalid_transition: cannot move from active to accepted"
      );
    };
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/accept"
    );
    assert.strictEqual(res.status, 409);
  });

  it("POST accept returns 409 for quota lease conflicts", async () => {
    deps.acceptSession = async () => {
      throw new Error("quota_lease_lane_locked held_by=rsess_other");
    };
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/accept"
    );
    assert.strictEqual(res.status, 409);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "quota_lease_lane_locked held_by=rsess_other");
  });

  it("POST provision returns a rental room and provisioning session", async () => {
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/provision",
      { parentRoomId: "github.com/BrosInCode/letagents" },
    );
    assert.strictEqual(res.status, 201);
    const json = (await res.json()) as {
      roomId: string;
      participantId: string;
      session: { status: string };
    };
    assert.strictEqual(json.roomId, "rroom_1");
    assert.strictEqual(json.participantId, "rpart_1");
    assert.strictEqual(json.session.status, "provisioning");
  });

  it("POST provision returns an existing rental room on idempotent retry", async () => {
    deps.provisionSession = async (input: Record<string, unknown>) => ({
      roomId: "rroom_existing",
      participantId: "rpart_existing",
      session: {
        id: input.sessionId,
        room_id: "rroom_existing",
        status: "active",
      },
    });

    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/provision",
      { parentRoomId: "github.com/BrosInCode/letagents" },
    );
    assert.strictEqual(res.status, 201);
    const json = (await res.json()) as {
      roomId: string;
      participantId: string;
      session: { status: string };
    };
    assert.strictEqual(json.roomId, "rroom_existing");
    assert.strictEqual(json.participantId, "rpart_existing");
    assert.strictEqual(json.session.status, "active");
  });

  it("POST provision validates parent room and maps invalid status", async () => {
    const missingParent = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/provision",
      {},
    );
    assert.strictEqual(missingParent.status, 400);

    deps.provisionSession = async () => {
      throw new Error("invalid_status: session must be accepted to provision");
    };
    const badStatus = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/provision",
      { parentRoomId: "room_1" },
    );
    assert.strictEqual(badStatus.status, 409);
  });

  it("POST decline returns cancelled session", async () => {
    const res = await req(
      "POST",
      "/api/rental/provider/sessions/rsess_1/decline"
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { status: string };
    assert.strictEqual(json.status, "cancelled");
  });
});
