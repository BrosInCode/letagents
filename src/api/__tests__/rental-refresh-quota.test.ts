process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  buildRefreshQuotaResponse,
  parseProviderHint,
} from "../rental/refresh-quota.js";
import type { rental_sessions } from "../db/schema.js";

type SessionRow = typeof rental_sessions.$inferSelect;

function baseSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "rsess_42",
    listing_id: "listing_1",
    renter_account_id: "acct_renter",
    provider_account_id: "acct_provider",
    room_id: "room_1",
    repo_provider: "github",
    repo_owner: "owner",
    repo_name: "repo",
    base_branch: "main",
    work_branch: null,
    task_title: "task",
    task_prompt: "p",
    mode: "scoped",
    continuity_mode: "smart_handoff",
    continuity_pack: null,
    status: "active",
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
    last_heartbeat_at: null,
    started_at: null,
    ended_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as SessionRow;
}

// ---------------------------------------------------------------------------
// parseProviderHint
// ---------------------------------------------------------------------------

test("parseProviderHint returns null for non-object bodies", () => {
  assert.equal(parseProviderHint(null), null);
  assert.equal(parseProviderHint(undefined), null);
  assert.equal(parseProviderHint("string"), null);
  assert.equal(parseProviderHint([]), null);
});

test("parseProviderHint returns null when provider field is absent or non-string", () => {
  assert.equal(parseProviderHint({}), null);
  assert.equal(parseProviderHint({ provider: 123 }), null);
  assert.equal(parseProviderHint({ provider: null }), null);
});

test("parseProviderHint trims and returns the value", () => {
  assert.equal(parseProviderHint({ provider: "  antigravity  " }), "antigravity");
});

test("parseProviderHint returns null on blank-only strings", () => {
  assert.equal(parseProviderHint({ provider: "   " }), null);
});

test("parseProviderHint caps length at 64", () => {
  const ok = "a".repeat(64);
  const tooLong = "a".repeat(65);
  assert.equal(parseProviderHint({ provider: ok }), "a".repeat(64));
  assert.equal(parseProviderHint({ provider: tooLong }), null);
});

test("parseProviderHint rejects non-ASCII", () => {
  assert.equal(parseProviderHint({ provider: "antigrávity" }), null);
});

// ---------------------------------------------------------------------------
// buildRefreshQuotaResponse
// ---------------------------------------------------------------------------

test("buildRefreshQuotaResponse returns null snapshot + provider_match=null when no data", () => {
  const out = buildRefreshQuotaResponse(baseSession(), null);
  assert.equal(out.snapshot, null);
  assert.equal(out.refreshed, false);
  assert.equal(out.provider_match, null);
});

test("buildRefreshQuotaResponse passes through the cached snapshot when present", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({
      native_quota_latest_snapshot: {
        provider: "antigravity",
        nativeRemaining: 0.42,
      },
    }),
    null,
  );
  assert.deepEqual(out.snapshot, {
    provider: "antigravity",
    nativeRemaining: 0.42,
  });
  assert.equal(out.refreshed, false);
});

test("buildRefreshQuotaResponse rejects non-object cached values defensively", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({
      native_quota_latest_snapshot: ["arr", "is", "not", "obj"] as unknown as Record<
        string,
        unknown
      >,
    }),
    null,
  );
  assert.equal(out.snapshot, null);
});

test("buildRefreshQuotaResponse sets provider_match=true when the hint matches the lane provider", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({ renter_lane_provider: "antigravity" }),
    "antigravity",
  );
  assert.equal(out.provider_match, true);
});

test("buildRefreshQuotaResponse is case-insensitive on the provider hint match", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({ renter_lane_provider: "Antigravity" }),
    "antigravity",
  );
  assert.equal(out.provider_match, true);
});

test("buildRefreshQuotaResponse sets provider_match=false when the hint differs", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({ renter_lane_provider: "cursor" }),
    "antigravity",
  );
  assert.equal(out.provider_match, false);
});

test("buildRefreshQuotaResponse sets provider_match=false when the lane has no provider but a hint is given", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({ renter_lane_provider: null }),
    "antigravity",
  );
  assert.equal(out.provider_match, false);
});

test("buildRefreshQuotaResponse sets provider_match=null when no hint is given", () => {
  const out = buildRefreshQuotaResponse(
    baseSession({ renter_lane_provider: "antigravity" }),
    null,
  );
  assert.equal(out.provider_match, null);
});

// ---------------------------------------------------------------------------
// Route wiring (integration with the in-process Express app)
// ---------------------------------------------------------------------------

describe("POST /api/rental/sessions/:id/refresh-quota", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let access: "renter" | "provider" | null;
  let sessionRow: ReturnType<typeof baseSession> | null;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    access = "renter";
    sessionRow = baseSession({
      native_quota_latest_snapshot: {
        provider: "antigravity",
        nativeRemaining: 0.42,
      },
      renter_lane_provider: "antigravity",
    });

    const { registerRentalInternalRoutes } = await import(
      "../routes/rental/internal/index.js"
    );
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_1" };
      next();
    });
    registerRentalInternalRoutes(app, {
      ingestUsage: async () => ({} as never),
      reserveBudget: async () => ({} as never),
      reconcileBudget: async () => ({} as never),
      resolveSessionAccess: async () => access,
      heartbeatDeps: async () => ({} as never),
      getSessionForLiveness: async () => null,
      getSessionForRefreshQuota: async () => sessionRow,
      getSessionLifecycle: async () => null,
      updateSessionLifecycle: async () => null,
      emitActivityEvent: async () => ({} as never),
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as import("net").AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : "{}",
    });
  }

  test("returns the cached snapshot with refreshed=false", async () => {
    const res = await post("/api/rental/sessions/rsess_42/refresh-quota");
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      snapshot: Record<string, unknown> | null;
      refreshed: boolean;
      provider_match: boolean | null;
    };
    assert.deepEqual(json.snapshot, {
      provider: "antigravity",
      nativeRemaining: 0.42,
    });
    assert.equal(json.refreshed, false);
    assert.equal(json.provider_match, null);
  });

  test("audits the optional provider hint", async () => {
    const res = await post("/api/rental/sessions/rsess_42/refresh-quota", {
      provider: "antigravity",
    });
    const json = (await res.json()) as { provider_match: boolean };
    assert.equal(json.provider_match, true);
  });

  test("returns 404 when the caller is not on the session", async () => {
    access = null;
    const res = await post("/api/rental/sessions/rsess_42/refresh-quota");
    assert.equal(res.status, 404);
  });

  test("returns 404 when the session row is missing", async () => {
    sessionRow = null;
    const res = await post("/api/rental/sessions/rsess_missing/refresh-quota");
    assert.equal(res.status, 404);
  });

  test("returns 404 when LETAGENTS_RENT_ENABLED is off", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await post("/api/rental/sessions/rsess_42/refresh-quota");
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "rent_disabled");
  });
});
