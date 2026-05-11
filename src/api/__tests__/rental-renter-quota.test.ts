/**
 * Tests for the renter quota-state mirror (p2.6c).
 *
 * Covers:
 *   - RenterQuotaStateStore: declare / get / clear / TTL eviction / size
 *   - serialize() shape (ISO timestamps, expiresAt, inExhaustedState)
 *   - GET /api/rental/renter/quota-status:
 *       empty state, populated state, unauthenticated, rent-disabled
 *   - POST /api/rental/renter/declare-quota-exhausted:
 *       happy path (all required fields), cross-field validation,
 *       clear: true flow, rent-disabled, enum rejection,
 *       unauthenticated
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

const {
  buildInMemoryListingsRateLimiter,
  registerRentalRenterRoutes,
} = await import("../routes/rental-renter.js");

const { RenterQuotaStateStore } = await import("../rental/renter-quota-state.js");

const express = (await import("express")).default;

// ---------------------------------------------------------------------------
// RenterQuotaStateStore (pure)
// ---------------------------------------------------------------------------

describe("RenterQuotaStateStore", () => {
  it("declare → get round-trips the full declaration", () => {
    const baseMs = Date.parse("2026-05-11T10:00:00.000Z");
    const store = new RenterQuotaStateStore({ now: () => baseMs });
    const stored = store.declare("acct_1", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      provider: "antigravity",
      model: "gemini-2.5-pro",
      exhaustedAt: new Date("2026-05-11T09:55:00.000Z"),
      refreshEta: new Date("2026-05-11T18:00:00.000Z"),
      signal: { tokens_remaining: 0 },
    });
    assert.equal(stored.recordedAtMs, baseMs);
    const fetched = store.get("acct_1");
    assert.ok(fetched);
    assert.equal(fetched!.startTrigger, "quota_exhausted");
    assert.equal(fetched!.provider, "antigravity");
    assert.equal(store.size(), 1);
  });

  it("get returns null when no declaration exists", () => {
    const store = new RenterQuotaStateStore();
    assert.equal(store.get("acct_unknown"), null);
  });

  it("expires declarations after ttlMs and evicts on read", () => {
    let nowMs = Date.parse("2026-05-11T10:00:00.000Z");
    const store = new RenterQuotaStateStore({
      ttlMs: 60_000,
      now: () => nowMs,
    });
    store.declare("acct_1", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      provider: "antigravity",
      model: null,
      exhaustedAt: new Date(nowMs - 5_000),
      refreshEta: null,
      signal: null,
    });
    assert.ok(store.get("acct_1"));
    nowMs += 70_000;
    assert.equal(store.get("acct_1"), null);
    assert.equal(store.size(), 0, "expired entries are evicted");
  });

  it("clear removes a declaration", () => {
    const store = new RenterQuotaStateStore();
    store.declare("acct_1", {
      startTrigger: "user_initiated",
      triggerConfidence: "manual",
      provider: "antigravity",
      model: null,
      exhaustedAt: new Date(),
      refreshEta: null,
      signal: null,
    });
    store.clear("acct_1");
    assert.equal(store.get("acct_1"), null);
    assert.equal(store.size(), 0);
  });

  it("serialize() returns inExhaustedState=false for null", () => {
    const store = new RenterQuotaStateStore();
    const out = store.serialize(null);
    assert.equal(out.inExhaustedState, false);
    assert.equal(out.declaration, null);
  });

  it("serialize() converts dates to ISO and computes expiresAt", () => {
    const recordedAtMs = Date.parse("2026-05-11T10:00:00.000Z");
    const store = new RenterQuotaStateStore({
      ttlMs: 60_000,
      now: () => recordedAtMs,
    });
    const decl = store.declare("acct_1", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "inferred",
      provider: "antigravity",
      model: "gemini-2.5-pro",
      exhaustedAt: new Date("2026-05-11T09:55:00.000Z"),
      refreshEta: new Date("2026-05-11T18:00:00.000Z"),
      signal: { failures_in_window: 5 },
    });
    const out = store.serialize(decl);
    assert.equal(out.inExhaustedState, true);
    assert.equal(out.declaration!.exhaustedAt, "2026-05-11T09:55:00.000Z");
    assert.equal(out.declaration!.refreshEta, "2026-05-11T18:00:00.000Z");
    assert.equal(out.declaration!.recordedAt, "2026-05-11T10:00:00.000Z");
    assert.equal(out.declaration!.expiresAt, "2026-05-11T10:01:00.000Z");
    assert.deepEqual(out.declaration!.signal, { failures_in_window: 5 });
  });
});

// ---------------------------------------------------------------------------
// Route-level integration
// ---------------------------------------------------------------------------

function buildApp(opts: { authed?: boolean; store?: import("../rental/renter-quota-state.js").RenterQuotaStateStore } = {}) {
  const app = express();
  app.use(express.json());
  const authed = opts.authed ?? true;
  if (authed) {
    app.use((req, _res, next) => {
      (req as unknown as { sessionAccount: { account_id: string } }).sessionAccount = {
        account_id: "renter_account_123",
      };
      next();
    });
  }
  registerRentalRenterRoutes(app, {
    publicListings: async () => [],
    shouldAllowListingsQuery: buildInMemoryListingsRateLimiter(),
    createSession: async () => ({}) as unknown as Awaited<ReturnType<RentalRenterCreateSession>>,
    getSessionById: async () => null,
    cancelSession: async () => null,
    renterQuotaState: opts.store,
  });
  return app;
}

type RentalRenterCreateSession = Parameters<typeof registerRentalRenterRoutes>[1]["createSession"];

function startServer(app: import("express").Express): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function reqJson(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : "";
    const headers: Record<string, string> = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("GET /api/rental/renter/quota-status", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let store: InstanceType<typeof RenterQuotaStateStore>;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "1";
    store = new RenterQuotaStateStore();
    server = await startServer(buildApp({ store }));
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    delete process.env.LETAGENTS_RENT_ENABLED;
  });

  it("returns inExhaustedState=false when no declaration exists", async () => {
    const res = await reqJson(server!.port, "GET", "/api/rental/renter/quota-status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { inExhaustedState: false, declaration: null });
  });

  it("returns the active declaration for the authenticated renter", async () => {
    store.declare("renter_account_123", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      provider: "antigravity",
      model: "gemini-2.5-pro",
      exhaustedAt: new Date("2026-05-11T09:55:00.000Z"),
      refreshEta: new Date("2026-05-11T18:00:00.000Z"),
      signal: { tokens_remaining: 0 },
    });
    const res = await reqJson(server!.port, "GET", "/api/rental/renter/quota-status");
    assert.equal(res.status, 200);
    const body = res.body as { inExhaustedState: boolean; declaration: { provider: string; signal: Record<string, unknown> } };
    assert.equal(body.inExhaustedState, true);
    assert.equal(body.declaration.provider, "antigravity");
    assert.deepEqual(body.declaration.signal, { tokens_remaining: 0 });
  });

  it("does not leak other renters' declarations", async () => {
    store.declare("renter_account_OTHER", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      provider: "antigravity",
      model: null,
      exhaustedAt: new Date(),
      refreshEta: null,
      signal: null,
    });
    const res = await reqJson(server!.port, "GET", "/api/rental/renter/quota-status");
    assert.deepEqual(res.body, { inExhaustedState: false, declaration: null });
  });
});

describe("POST /api/rental/renter/declare-quota-exhausted", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let store: InstanceType<typeof RenterQuotaStateStore>;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "1";
    store = new RenterQuotaStateStore();
    server = await startServer(buildApp({ store }));
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    delete process.env.LETAGENTS_RENT_ENABLED;
  });

  it("happy path: declares + persists + returns the public shape", async () => {
    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      {
        startTrigger: "quota_exhausted",
        triggerConfidence: "exact",
        renterLaneProvider: "antigravity",
        renterLaneModel: "gemini-2.5-pro",
        renterLaneExhaustedAt: "2026-05-11T09:55:00.000Z",
        renterLaneRefreshEta: "2026-05-11T18:00:00.000Z",
        renterQuotaSignal: { tokens_remaining: 0 },
      },
    );
    assert.equal(res.status, 200);
    const body = res.body as { inExhaustedState: boolean; declaration: { provider: string; model: string } };
    assert.equal(body.inExhaustedState, true);
    assert.equal(body.declaration.provider, "antigravity");
    assert.equal(body.declaration.model, "gemini-2.5-pro");
    assert.equal(store.size(), 1);
  });

  it("rejects missing required fields with 400 (no startTrigger)", async () => {
    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      {
        triggerConfidence: "exact",
        renterLaneProvider: "antigravity",
        renterLaneExhaustedAt: "2026-05-11T09:55:00.000Z",
      },
    );
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /startTrigger/,
    );
  });

  it("rejects missing renterLaneProvider with 400", async () => {
    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      {
        startTrigger: "quota_exhausted",
        triggerConfidence: "exact",
        renterLaneExhaustedAt: "2026-05-11T09:55:00.000Z",
      },
    );
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /renterLaneProvider/,
    );
  });

  it("rejects missing renterLaneExhaustedAt with 400", async () => {
    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      {
        startTrigger: "quota_exhausted",
        triggerConfidence: "exact",
        renterLaneProvider: "antigravity",
      },
    );
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /renterLaneExhaustedAt/,
    );
  });

  it("rejects non-quota_exhausted startTrigger with 400 (semantic match)", async () => {
    // LivelyPeak's PR #384 catch: the endpoint stores an
    // `inExhaustedState: true` mirror, so only the quota_exhausted
    // start_trigger is semantically valid. Other valid enum values
    // (user_initiated / scheduled / task_handoff) describe other
    // intents and shouldn't land here.
    for (const trigger of ["user_initiated", "scheduled", "task_handoff"] as const) {
      const res = await reqJson(
        server!.port,
        "POST",
        "/api/rental/renter/declare-quota-exhausted",
        {
          startTrigger: trigger,
          triggerConfidence: "manual",
          renterLaneProvider: "antigravity",
          renterLaneExhaustedAt: "2026-05-11T09:55:00.000Z",
        },
      );
      assert.equal(res.status, 400);
      assert.match(
        ((res.body as { error?: string })?.error ?? "") as string,
        /quota_exhausted/,
      );
    }
    assert.equal(store.size(), 0, "rejected declarations are not stored");
  });

  it("rejects bad enum value (startTrigger) with 400", async () => {
    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      {
        startTrigger: "bogus_trigger",
        triggerConfidence: "exact",
        renterLaneProvider: "antigravity",
        renterLaneExhaustedAt: "2026-05-11T09:55:00.000Z",
      },
    );
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /startTrigger must be one of/,
    );
  });

  it("clear: true drops a previous declaration", async () => {
    store.declare("renter_account_123", {
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      provider: "antigravity",
      model: null,
      exhaustedAt: new Date(),
      refreshEta: null,
      signal: null,
    });
    assert.equal(store.size(), 1);

    const res = await reqJson(
      server!.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      { clear: true },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { inExhaustedState: false, declaration: null });
    assert.equal(store.size(), 0);
  });
});

describe("rental_renter_quota — feature gate", () => {
  it("GET returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    const server = await startServer(buildApp());
    const res = await reqJson(server.port, "GET", "/api/rental/renter/quota-status");
    assert.equal(res.status, 404);
    assert.equal((res.body as { error?: string })?.error, "rent_disabled");
    await server.close();
  });

  it("POST returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    const server = await startServer(buildApp());
    const res = await reqJson(
      server.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      { startTrigger: "quota_exhausted" },
    );
    assert.equal(res.status, 404);
    await server.close();
  });

  it("GET / POST return 401 when unauthenticated", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "1";
    const server = await startServer(buildApp({ authed: false }));
    const gotGet = await reqJson(server.port, "GET", "/api/rental/renter/quota-status");
    assert.equal(gotGet.status, 401);
    const gotPost = await reqJson(
      server.port,
      "POST",
      "/api/rental/renter/declare-quota-exhausted",
      { startTrigger: "quota_exhausted" },
    );
    assert.equal(gotPost.status, 401);
    await server.close();
    delete process.env.LETAGENTS_RENT_ENABLED;
  });
});
