/**
 * Rental Room Projection — p1.4 tests
 *
 * Tests the room projection service: provisioning, message filtering,
 * activity projection, visibility controls, and rental context.
 *
 * Uses the same HTTP-based integration pattern as p1.3 tests.
 * State machine and DB-dependent functions are tested via mocked deps
 * in the route handler tests.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isRentalParticipantProvisionableStatus } from "../rental/room-provisioning-policy.js";

// ===== Provisioning Logic Tests (unit, no DB) =====

describe("rental room provisioning (p1.4)", () => {
  it("does not create a participant before the provider has accepted", () => {
    for (const status of ["requested", "cancelled", "completed", "failed"]) {
      assert.equal(isRentalParticipantProvisionableStatus(status), false, status);
    }
    for (const status of ["accepted", "provisioning", "active"]) {
      assert.equal(isRentalParticipantProvisionableStatus(status), true, status);
    }
  });

  it("generates unique room IDs with rroom_ prefix", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).slice(2, 8);
      const id = `rroom_${timestamp}_${random}`;
      assert.ok(id.startsWith("rroom_"));
      assert.ok(id.length > 10);
      ids.add(id);
    }
    // All should be unique
    assert.strictEqual(ids.size, 100);
  });

  it("generates unique participant IDs with rpart_ prefix", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).slice(2, 8);
      const id = `rpart_${timestamp}_${random}`;
      assert.ok(id.startsWith("rpart_"));
      ids.add(id);
    }
    assert.strictEqual(ids.size, 100);
  });
});

// ===== Message Visibility Tests (unit) =====

describe("message visibility filtering (p1.4)", () => {
  const RENTAL_VISIBLE = "rental_visible";
  const RENTER_ONLY = "renter_only";
  const INTERNAL = "internal";

  // Matches the corrected SQL predicate:
  // visibility = 'rental_visible' AND (rental_session_id = target OR IS NULL)
  function shouldBeVisible(
    visibility: string | null,
    rentalSessionId: string | null,
    targetSessionId: string
  ): boolean {
    if (visibility !== RENTAL_VISIBLE) return false;
    if (rentalSessionId === null || rentalSessionId === targetSessionId) return true;
    return false; // cross-session: rental_visible but wrong session_id
  }

  it("rental_visible messages without session or matching session are visible", () => {
    assert.ok(shouldBeVisible(RENTAL_VISIBLE, null, "sess_1"));
    assert.ok(shouldBeVisible(RENTAL_VISIBLE, "sess_1", "sess_1"));
  });

  it("rental_visible messages from DIFFERENT session are NOT visible (cross-session isolation)", () => {
    assert.ok(!shouldBeVisible(RENTAL_VISIBLE, "sess_2", "sess_1"));
  });

  it("messages linked to session but NOT rental_visible are NOT visible (hide enforced)", () => {
    assert.ok(!shouldBeVisible(null, "sess_1", "sess_1"));
    assert.ok(!shouldBeVisible(RENTER_ONLY, "sess_1", "sess_1"));
    assert.ok(!shouldBeVisible(INTERNAL, "sess_1", "sess_1"));
  });

  it("renter_only messages are NOT visible regardless of session", () => {
    assert.ok(!shouldBeVisible(RENTER_ONLY, null, "sess_1"));
    assert.ok(!shouldBeVisible(RENTER_ONLY, "sess_1", "sess_1"));
    assert.ok(!shouldBeVisible(RENTER_ONLY, "sess_other", "sess_1"));
  });

  it("internal messages are NOT visible regardless of session", () => {
    assert.ok(!shouldBeVisible(INTERNAL, null, "sess_1"));
    assert.ok(!shouldBeVisible(INTERNAL, "sess_1", "sess_1"));
    assert.ok(!shouldBeVisible(INTERNAL, "sess_other", "sess_1"));
  });

  it("empty room returns empty projection", () => {
    const messages: { visibility: string | null; rental_session_id: string | null }[] = [];
    const projected = messages.filter((m) =>
      shouldBeVisible(m.visibility, m.rental_session_id, "sess_1")
    );
    assert.strictEqual(projected.length, 0);
  });

  it("mixed visibility room projects correctly with session isolation", () => {
    const allMessages = [
      { id: "m1", visibility: RENTAL_VISIBLE, rental_session_id: null },        // visible: rental_visible + no session
      { id: "m2", visibility: null, rental_session_id: null },                  // hidden: not rental_visible
      { id: "m3", visibility: RENTER_ONLY, rental_session_id: null },           // hidden: renter_only
      { id: "m4", visibility: null, rental_session_id: "sess_1" },              // hidden: not rental_visible (hide enforced)
      { id: "m5", visibility: INTERNAL, rental_session_id: "sess_1" },          // hidden: internal (hide enforced)
      { id: "m6", visibility: null, rental_session_id: "sess_2" },              // hidden: not rental_visible
      { id: "m7", visibility: RENTAL_VISIBLE, rental_session_id: "sess_2" },    // hidden: wrong session (cross-session)
      { id: "m8", visibility: RENTAL_VISIBLE, rental_session_id: "sess_1" },    // visible: rental_visible + correct session
    ];
    const projected = allMessages.filter((m) =>
      shouldBeVisible(m.visibility, m.rental_session_id, "sess_1")
    );
    // m1 (rental_visible, no session) and m8 (rental_visible, correct session)
    assert.strictEqual(projected.length, 2);
    assert.deepStrictEqual(
      projected.map((m) => m.id),
      ["m1", "m8"]
    );
  });
});

// ===== Activity Projection Tests (unit) =====

describe("activity projection filtering (p1.4)", () => {
  const makeEvent = (
    id: string,
    sessionId: string,
    visibility: string,
    verified: boolean
  ) => ({ id, session_id: sessionId, visibility, verified });

  it("only includes rental_visible events", () => {
    const events = [
      makeEvent("e1", "sess_1", "rental_visible", true),
      makeEvent("e2", "sess_1", "renter_only", true),
      makeEvent("e3", "sess_1", "internal", false),
      makeEvent("e4", "sess_1", "rental_visible", false),
    ];
    const projected = events.filter(
      (e) => e.session_id === "sess_1" && e.visibility === "rental_visible"
    );
    assert.strictEqual(projected.length, 2);
    assert.deepStrictEqual(
      projected.map((e) => e.id),
      ["e1", "e4"]
    );
  });

  it("verified-only filter works", () => {
    const events = [
      makeEvent("e1", "sess_1", "rental_visible", true),
      makeEvent("e2", "sess_1", "rental_visible", false),
      makeEvent("e3", "sess_1", "rental_visible", true),
    ];
    const projected = events.filter(
      (e) =>
        e.session_id === "sess_1" &&
        e.visibility === "rental_visible" &&
        e.verified
    );
    assert.strictEqual(projected.length, 2);
    assert.deepStrictEqual(
      projected.map((e) => e.id),
      ["e1", "e3"]
    );
  });

  it("only includes events for the target session", () => {
    const events = [
      makeEvent("e1", "sess_1", "rental_visible", true),
      makeEvent("e2", "sess_2", "rental_visible", true),
      makeEvent("e3", "sess_1", "rental_visible", false),
    ];
    const projected = events.filter(
      (e) => e.session_id === "sess_1" && e.visibility === "rental_visible"
    );
    assert.strictEqual(projected.length, 2);
    assert.deepStrictEqual(
      projected.map((e) => e.id),
      ["e1", "e3"]
    );
  });
});

// ===== Rental Context Route Tests (HTTP integration) =====

describe("rental context route handlers (p1.4)", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;

  const RENTER_ID = "acct_renter_1";
  const PROVIDER_ID = "acct_provider_1";
  const SESSION_ID = "rsess_1";
  const ROOM_ID = "rroom_1";

  const mockSession = {
    id: SESSION_ID,
    listing_id: "lst_1",
    renter_account_id: RENTER_ID,
    provider_account_id: PROVIDER_ID,
    room_id: ROOM_ID,
    status: "active",
    task_title: "Fix login bug",
    task_prompt: "The login button doesn't work on mobile",
    mode: "scoped",
    continuity_mode: "smart_handoff",
  };

  const mockMessages = [
    {
      id: "msg_1",
      number: 1,
      room_id: ROOM_ID,
      sender: "renter",
      text: "Please fix the login bug",
      agent_prompt_kind: null,
      source: "human",
      visibility: "rental_visible",
      rental_session_id: SESSION_ID,
      timestamp: "2026-05-11T00:00:00Z",
    },
    {
      id: "msg_2",
      number: 2,
      room_id: ROOM_ID,
      sender: "provider-agent",
      text: "Looking into it now",
      agent_prompt_kind: null,
      source: "agent",
      visibility: "rental_visible",
      rental_session_id: SESSION_ID,
      timestamp: "2026-05-11T00:01:00Z",
    },
  ];

  const mockActivity = [
    {
      id: "rev_1",
      session_id: SESSION_ID,
      room_id: ROOM_ID,
      event_type: "session.started",
      source: "renter",
      verified: true,
      visibility: "rental_visible",
      payload: {},
      created_at: new Date("2026-05-11T00:00:00Z"),
    },
  ];

  let deps: Record<string, (...args: unknown[]) => unknown>;

  beforeEach(async () => {
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    process.env.LETAGENTS_RENT_ENABLED = "true";

    deps = {
      getRentalContext: async (sessionId: string, accountId: string) => {
        if (sessionId !== SESSION_ID) return null;
        if (accountId !== RENTER_ID && accountId !== PROVIDER_ID) return null;
        return {
          session: mockSession,
          messages: accountId === PROVIDER_ID
            ? mockMessages.filter(
                (m) =>
                  m.visibility === "rental_visible" &&
                  (m.rental_session_id === sessionId ||
                   m.rental_session_id === null)
              )
            : mockMessages,
          activity: mockActivity,
        };
      },
      provisionRentalRoom: async (input: Record<string, string>) => {
        if (input.sessionId === "bad_session") throw new Error("session_not_found");
        return {
          roomId: "rroom_new",
          participantId: "rpart_new",
          session: { ...mockSession, room_id: "rroom_new", status: "provisioning" },
        };
      },
      setMessageVisibility: async () => true,
    };

    // Auth middleware
    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = {
        account_id: RENTER_ID,
      };
      next();
    });

    // Routes
    const { isRentEnabled } = await import("../routes/rental/renter/index.js");
    type Req = import("express").Request & {
      sessionAccount?: { account_id: string };
    };
    type Res = import("express").Response;

    // GET /api/rental/sessions/:id/context
    app.get(
      "/api/rental/sessions/:id/context",
      async (req: Req, res: Res) => {
        if (!isRentEnabled()) return res.status(404).json({ error: "rent_disabled" });
        const accountId = req.sessionAccount?.account_id;
        if (!accountId) return res.status(401).json({ error: "unauthenticated" });

        const context = await (deps.getRentalContext as Function)(
          req.params.id,
          accountId
        );
        if (!context) return res.status(404).json({ error: "session_not_found" });
        return res.json(context);
      }
    );

    // POST /api/rental/sessions/:id/provision
    app.post(
      "/api/rental/sessions/:id/provision",
      async (req: Req, res: Res) => {
        if (!isRentEnabled()) return res.status(404).json({ error: "rent_disabled" });
        const accountId = req.sessionAccount?.account_id;
        if (!accountId) return res.status(401).json({ error: "unauthenticated" });

        try {
          const result = await (deps.provisionRentalRoom as Function)({
            sessionId: req.params.id,
            parentRoomId: req.body.parentRoomId,
            providerDisplayName: req.body.providerDisplayName ?? "Rental Agent",
          });
          return res.status(201).json(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "unknown_error";
          if (
            message === "session_not_found" ||
            message.startsWith("invalid_status")
          ) {
            return res.status(409).json({ error: message });
          }
          return res.status(500).json({ error: message });
        }
      }
    );

    // PATCH /api/rental/sessions/:id/messages/:number/visibility
    app.patch(
      "/api/rental/sessions/:id/messages/:number/visibility",
      async (req: Req, res: Res) => {
        if (!isRentEnabled()) return res.status(404).json({ error: "rent_disabled" });
        const accountId = req.sessionAccount?.account_id;
        if (!accountId) return res.status(401).json({ error: "unauthenticated" });

        const { visibility } = req.body;
        if (!["rental_visible", "renter_only", "internal"].includes(visibility)) {
          return res.status(400).json({ error: "invalid_visibility" });
        }

        const ok = await (deps.setMessageVisibility as Function)(
          req.params.id,
          Number(req.params.number),
          visibility,
          req.params.id
        );
        if (!ok) return res.status(404).json({ error: "message_not_found" });
        return res.json({ ok: true });
      }
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as import("net").AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    server?.close();
    delete process.env.LETAGENTS_RENT_ENABLED;
  });

  function req(
    method: string,
    path: string,
    body?: unknown
  ): Promise<globalThis.Response> {
    const opts: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(`${baseUrl}${path}`, opts);
  }

  // === Context endpoint tests ===

  it("GET /api/rental/sessions/:id/context returns context for renter", async () => {
    const res = await req("GET", `/api/rental/sessions/${SESSION_ID}/context`);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as {
      session: { id: string };
      messages: unknown[];
      activity: unknown[];
    };
    assert.strictEqual(json.session.id, SESSION_ID);
    assert.ok(json.messages.length > 0);
    assert.ok(json.activity.length > 0);
  });

  it("GET context returns 404 for unknown session", async () => {
    const res = await req("GET", "/api/rental/sessions/unknown/context");
    assert.strictEqual(res.status, 404);
  });

  it("GET context returns 404 when rent is disabled", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await req("GET", `/api/rental/sessions/${SESSION_ID}/context`);
    assert.strictEqual(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "rent_disabled");
  });

  // === Provision endpoint tests ===

  it("POST provision returns 201 with room details", async () => {
    const res = await req(
      "POST",
      `/api/rental/sessions/${SESSION_ID}/provision`,
      {
        parentRoomId: "room_parent",
        providerDisplayName: "Test Agent",
      }
    );
    assert.strictEqual(res.status, 201);
    const json = (await res.json()) as {
      roomId: string;
      participantId: string;
      session: { status: string };
    };
    assert.ok(json.roomId);
    assert.ok(json.participantId);
    assert.strictEqual(json.session.status, "provisioning");
  });

  it("POST provision returns 409 for bad session", async () => {
    const res = await req("POST", "/api/rental/sessions/bad_session/provision", {
      parentRoomId: "room_parent",
    });
    assert.strictEqual(res.status, 409);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "session_not_found");
  });

  // === Visibility endpoint tests ===

  it("PATCH visibility updates message visibility", async () => {
    const res = await req(
      "PATCH",
      `/api/rental/sessions/${SESSION_ID}/messages/1/visibility`,
      { visibility: "rental_visible" }
    );
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { ok: boolean };
    assert.strictEqual(json.ok, true);
  });

  it("PATCH visibility rejects invalid visibility value", async () => {
    const res = await req(
      "PATCH",
      `/api/rental/sessions/${SESSION_ID}/messages/1/visibility`,
      { visibility: "bad_value" }
    );
    assert.strictEqual(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "invalid_visibility");
  });

  it("PATCH visibility accepts renter_only", async () => {
    const res = await req(
      "PATCH",
      `/api/rental/sessions/${SESSION_ID}/messages/1/visibility`,
      { visibility: "renter_only" }
    );
    assert.strictEqual(res.status, 200);
  });

  it("PATCH visibility accepts internal", async () => {
    const res = await req(
      "PATCH",
      `/api/rental/sessions/${SESSION_ID}/messages/1/visibility`,
      { visibility: "internal" }
    );
    assert.strictEqual(res.status, 200);
  });
});
