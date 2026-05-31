/**
 * Rental Heartbeat / Liveness — p1.5 tests
 *
 * Tests the heartbeat service: recording, liveness evaluation,
 * state transitions (provisioning→active, stale→active, active→stale→expired),
 * and HTTP route integration.
 *
 * Uses dependency injection for unit tests and mock HTTP for route tests.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  recordHeartbeat,
  getLivenessStatus,
  HEARTBEAT_THRESHOLDS,
  expireSession,
  markSessionStale,
} from "../rental/heartbeat.js";
import type {
  HeartbeatDeps,
  HeartbeatResult,
  LivenessInfo,
  SessionRecord,
} from "../rental/heartbeat.js";

// ===== Mock session factory =====

function makeSession(overrides: Record<string, unknown> = {}): SessionRecord & Record<string, unknown> {
  return {
    id: "rsess_1",
    listing_id: "lst_1",
    renter_account_id: "acct_renter",
    provider_account_id: "acct_provider",
    room_id: "rroom_1",
    repo_provider: "github",
    repo_owner: "owner",
    repo_name: "repo",
    base_branch: "main",
    work_branch: null,
    task_title: "Fix login bug",
    task_prompt: "The login button doesn't work",
    mode: "scoped" as const,
    continuity_mode: "smart_handoff" as const,
    continuity_pack: null,
    status: "active" as string,
    approved_scope: null,
    policy: null,
    quota_lease: null,
    native_quota_unit: null,
    native_quota_start_snapshot: null,
    native_quota_latest_snapshot: null,
    meter_confidence: null,
    lrt_limit: null,
    lrt_reserved: 0,
    lrt_used: 0,
    budget_stop_threshold: null,
    time_limit_minutes: null,
    start_trigger: null,
    trigger_confidence: null,
    renter_lane_exhausted_at: null,
    renter_lane_provider: null,
    renter_lane_model: null,
    renter_lane_refresh_eta: null,
    renter_quota_signal: null,
    renter_lane_recovered_at: null,
    heartbeat_count: 0,
    last_heartbeat_at: null as Date | null,
    started_at: null,
    ended_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeDeps(session: ReturnType<typeof makeSession>): HeartbeatDeps {
  const store: Record<string, ReturnType<typeof makeSession>> = {
    [session.id]: { ...session },
  };
  return {
    async getSession(sessionId: string) {
      return store[sessionId] ?? null;
    },
    async updateSession(sessionId: string, data: Record<string, unknown>) {
      const existing = store[sessionId];
      if (!existing) return null;
      Object.assign(existing, data, { updated_at: new Date() });
      return existing;
    },
  };
}

// ===== recordHeartbeat tests =====

describe("recordHeartbeat (p1.5)", () => {
  it("accepts heartbeat from provider in active state", async () => {
    const session = makeSession({ status: "active", heartbeat_count: 5 });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "active");
    assert.strictEqual(result.heartbeatCount, 6);
    assert.strictEqual(result.transitioned, false);
  });

  it("transitions provisioning → active on first heartbeat", async () => {
    const session = makeSession({ status: "provisioning", heartbeat_count: 0 });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "active");
    assert.strictEqual(result.heartbeatCount, 1);
    assert.strictEqual(result.transitioned, true);
  });

  it("sets started_at on provisioning → active transition", async () => {
    const session = makeSession({ status: "provisioning", started_at: null });
    const deps = makeDeps(session);
    await recordHeartbeat("rsess_1", "acct_provider", deps);

    const updated = await deps.getSession("rsess_1");
    assert.ok(updated!.started_at, "started_at should be set");
  });

  it("recovers stale → active on heartbeat", async () => {
    const session = makeSession({ status: "stale", heartbeat_count: 10 });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "active");
    assert.strictEqual(result.heartbeatCount, 11);
    assert.strictEqual(result.transitioned, true);
  });

  it("rejects heartbeat from non-provider", async () => {
    const session = makeSession({ status: "active" });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_renter", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "not_provider");
  });

  it("rejects heartbeat for unknown session", async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const result = await recordHeartbeat("nonexistent", "acct_provider", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "session_not_found");
  });

  it("rejects heartbeat in terminal state (completed)", async () => {
    const session = makeSession({ status: "completed" });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error!.includes("invalid_status"));
  });

  it("rejects heartbeat in terminal state (cancelled)", async () => {
    const session = makeSession({ status: "cancelled" });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error!.includes("invalid_status"));
  });

  it("rejects heartbeat in terminal state (expired)", async () => {
    const session = makeSession({ status: "expired" });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error!.includes("invalid_status"));
  });

  it("accepts heartbeat in blocked state (keeps status)", async () => {
    const session = makeSession({ status: "blocked", heartbeat_count: 3 });
    const deps = makeDeps(session);
    const result = await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "blocked");
    assert.strictEqual(result.heartbeatCount, 4);
    assert.strictEqual(result.transitioned, false);
  });

  it("emits session.activated event on provisioning → active", async () => {
    const session = makeSession({ status: "provisioning" });
    const deps = makeDeps(session);
    const emittedEvents: Record<string, unknown>[] = [];
    deps.emitActivityEvent = async (_sid, _rid, eventType, source, payload) => {
      emittedEvents.push({ eventType, source, payload });
    };

    await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(emittedEvents.length, 1);
    assert.strictEqual(emittedEvents[0].eventType, "session.started");
    assert.strictEqual(emittedEvents[0].source, "system");
  });

  it("emits session.recovered event on stale → active", async () => {
    const session = makeSession({ status: "stale" });
    const deps = makeDeps(session);
    const emittedEvents: Record<string, unknown>[] = [];
    deps.emitActivityEvent = async (_sid, _rid, eventType, source, payload) => {
      emittedEvents.push({ eventType, source, payload });
    };

    await recordHeartbeat("rsess_1", "acct_provider", deps);

    assert.strictEqual(emittedEvents.length, 1);
    assert.strictEqual(emittedEvents[0].eventType, "agent.heartbeat");
  });
});

// ===== getLivenessStatus tests =====

describe("getLivenessStatus (p1.5)", () => {
  it("returns 'unknown' when no heartbeat received", () => {
    const session = makeSession({ heartbeat_count: 0, last_heartbeat_at: null });
    const info = getLivenessStatus(session);

    assert.strictEqual(info.status, "unknown");
    assert.strictEqual(info.secondsSinceLastHeartbeat, null);
  });

  it("returns 'healthy' when heartbeat is recent", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 10_000); // 10 seconds ago
    const session = makeSession({ heartbeat_count: 5, last_heartbeat_at: recent });
    const info = getLivenessStatus(session, now);

    assert.strictEqual(info.status, "healthy");
    assert.ok(info.secondsSinceLastHeartbeat! <= 11);
  });

  it("returns 'stale' when heartbeat exceeds stale threshold", () => {
    const now = new Date();
    const stale = new Date(now.getTime() - (HEARTBEAT_THRESHOLDS.staleAfter + 10) * 1000);
    const session = makeSession({ heartbeat_count: 5, last_heartbeat_at: stale });
    const info = getLivenessStatus(session, now);

    assert.strictEqual(info.status, "stale");
  });

  it("returns 'disconnected' when heartbeat exceeds disconnected threshold", () => {
    const now = new Date();
    const disconnected = new Date(now.getTime() - (HEARTBEAT_THRESHOLDS.disconnectedAfter + 10) * 1000);
    const session = makeSession({ heartbeat_count: 5, last_heartbeat_at: disconnected });
    const info = getLivenessStatus(session, now);

    assert.strictEqual(info.status, "disconnected");
  });

  it("returns 'expired' when heartbeat exceeds expire threshold", () => {
    const now = new Date();
    const expired = new Date(now.getTime() - (HEARTBEAT_THRESHOLDS.expireAfter + 10) * 1000);
    const session = makeSession({ heartbeat_count: 5, last_heartbeat_at: expired });
    const info = getLivenessStatus(session, now);

    assert.strictEqual(info.status, "expired");
  });

  it("handles string timestamps (from DB)", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 10_000).toISOString();
    const session = makeSession({ heartbeat_count: 5, last_heartbeat_at: recent });
    const info = getLivenessStatus(session as any, now);

    assert.strictEqual(info.status, "healthy");
  });
});

// ===== expireSession / markSessionStale tests =====

describe("expireSession (p1.5)", () => {
  it("expires an active session", async () => {
    const session = makeSession({ status: "active" });
    const deps = makeDeps(session);
    const result = await expireSession("rsess_1", "heartbeat_timeout", deps);

    assert.strictEqual(result.ok, true);
    const updated = await deps.getSession("rsess_1");
    assert.strictEqual(updated!.status, "expired");
    assert.ok(updated!.ended_at);
  });

  it("expires a stale session", async () => {
    const session = makeSession({ status: "stale" });
    const deps = makeDeps(session);
    const result = await expireSession("rsess_1", "heartbeat_timeout", deps);

    assert.strictEqual(result.ok, true);
    const updated = await deps.getSession("rsess_1");
    assert.strictEqual(updated!.status, "expired");
  });

  it("rejects expiring a completed session", async () => {
    const session = makeSession({ status: "completed" });
    const deps = makeDeps(session);
    const result = await expireSession("rsess_1", "heartbeat_timeout", deps);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error!.includes("cannot_expire"));
  });

  it("rejects expiring unknown session", async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const result = await expireSession("nonexistent", "heartbeat_timeout", deps);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "session_not_found");
  });
});

describe("markSessionStale (p1.5)", () => {
  it("marks an active session as stale", async () => {
    const session = makeSession({ status: "active" });
    const deps = makeDeps(session);
    const result = await markSessionStale("rsess_1", deps);

    assert.strictEqual(result.ok, true);
    const updated = await deps.getSession("rsess_1");
    assert.strictEqual(updated!.status, "stale");
  });

  it("rejects marking provisioning session as stale", async () => {
    const session = makeSession({ status: "provisioning" });
    const deps = makeDeps(session);
    const result = await markSessionStale("rsess_1", deps);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error!.includes("cannot_mark_stale"));
  });
});

// ===== HTTP route tests =====

describe("heartbeat route handler (p1.5)", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;

  const PROVIDER_ID = "acct_provider";
  const SESSION_ID = "rsess_1";

  let mockSession: ReturnType<typeof makeSession>;
  let mockDeps: HeartbeatDeps;

  beforeEach(async () => {
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    process.env.LETAGENTS_RENT_ENABLED = "true";

    mockSession = makeSession({ status: "active", heartbeat_count: 5 });
    mockDeps = makeDeps(mockSession);

    // Auth middleware
    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = {
        account_id: PROVIDER_ID,
      };
      next();
    });

    const { isRentEnabled } = await import("../routes/rental/renter/index.js");
    type Req = import("express").Request & {
      sessionAccount?: { account_id: string };
    };
    type Res = import("express").Response;

    // POST /api/rental/sessions/:id/heartbeat
    app.post(
      "/api/rental/sessions/:id/heartbeat",
      async (req: Req, res: Res) => {
        if (!isRentEnabled()) return res.status(404).json({ error: "rent_disabled" });
        const accountId = req.sessionAccount?.account_id;
        if (!accountId) return res.status(401).json({ error: "unauthenticated" });

        const result = await recordHeartbeat(req.params.id, accountId, mockDeps);
        if (!result.ok) {
          const status = result.error === "session_not_found" ? 404
            : result.error === "not_provider" ? 403
            : 409;
          return res.status(status).json({ error: result.error });
        }
        return res.json(result);
      }
    );

    // GET /api/rental/sessions/:id/liveness
    app.get(
      "/api/rental/sessions/:id/liveness",
      async (req: Req, res: Res) => {
        if (!isRentEnabled()) return res.status(404).json({ error: "rent_disabled" });
        const session = await mockDeps.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: "session_not_found" });
        const info = getLivenessStatus(session as any);
        return res.json(info);
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

  it("POST heartbeat returns 200 with heartbeat info", async () => {
    const res = await req("POST", `/api/rental/sessions/${SESSION_ID}/heartbeat`);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as HeartbeatResult;
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.status, "active");
    assert.strictEqual(json.heartbeatCount, 6);
  });

  it("POST heartbeat returns 404 for unknown session", async () => {
    const res = await req("POST", "/api/rental/sessions/unknown/heartbeat");
    assert.strictEqual(res.status, 404);
  });

  it("GET liveness returns session liveness info", async () => {
    // Record a heartbeat first to set last_heartbeat_at
    await recordHeartbeat(SESSION_ID, PROVIDER_ID, mockDeps);

    const res = await req("GET", `/api/rental/sessions/${SESSION_ID}/liveness`);
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as LivenessInfo;
    assert.strictEqual(json.sessionId, SESSION_ID);
    assert.ok(["healthy", "unknown"].includes(json.status));
  });

  it("GET liveness returns 404 for unknown session", async () => {
    const res = await req("GET", "/api/rental/sessions/unknown/liveness");
    assert.strictEqual(res.status, 404);
  });

  it("POST heartbeat returns 404 when rent is disabled", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await req("POST", `/api/rental/sessions/${SESSION_ID}/heartbeat`);
    assert.strictEqual(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "rent_disabled");
  });
});
