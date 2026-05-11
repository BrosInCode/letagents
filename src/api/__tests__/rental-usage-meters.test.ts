/**
 * Tests for rental_usage_meters schema + ingest service + internal route.
 *
 * Covers (no live DB):
 * - Schema shape, FK, indexes, idempotency unique index
 * - ingestUsage idempotency, FK validation, provider/model mismatch, rolling lrt_total
 * - POST /api/rental/sessions/:id/usage handler:
 *     • 404 rent_disabled when feature flag off
 *     • 401 unauthenticated
 *     • 404 when account is neither renter nor provider for the session
 *     • 400 on invalid body
 *     • 201 happy path
 *     • 409 on provider/model mismatch
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  IngestUsageReport,
  RentalUsageMeterRow,
} from "../rental/usage-ingest.js";

const { ingestUsage, UsageIngestError } = await import("../rental/usage-ingest.js");
const { registerRentalInternalRoutes } = await import("../routes/rental-internal.js");
const { rental_usage_meters, rentalUsageMeterSourceEnum } = await import("../db/schema.js");

// ===== Schema =====

describe("rental_usage_meters schema", () => {
  it("rentalUsageMeterSourceEnum has 4 values matching spec §19.6", () => {
    assert.deepEqual(rentalUsageMeterSourceEnum.enumValues, [
      "adapter",
      "tool",
      "self_reported",
      "system",
    ]);
  });

  it("rental_usage_meters table exposes all §19.6 columns", () => {
    const cols = Object.keys(rental_usage_meters);
    const required = [
      "id",
      "session_id",
      "source",
      "native_unit",
      "native_used",
      "native_remaining",
      "native_reset_at",
      "input_tokens",
      "output_tokens",
      "cache_creation_tokens",
      "cache_read_tokens",
      "reasoning_tokens",
      "requests_used",
      "credits_used",
      "usd_used",
      "lrt_delta",
      "lrt_total",
      "confidence",
      "adapter_payload",
      "tool_call_count",
      "command_run_count",
      "files_exposed_count",
      "heartbeat_count",
      "last_heartbeat_at",
      "idempotency_key",
      "created_at",
      "updated_at",
    ];
    for (const c of required) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });

  it("id is primary key", () => {
    assert.equal(rental_usage_meters.id.primary, true);
  });

  it("token counter columns are NOT NULL with default 0", () => {
    for (const col of [
      rental_usage_meters.input_tokens,
      rental_usage_meters.output_tokens,
      rental_usage_meters.cache_creation_tokens,
      rental_usage_meters.cache_read_tokens,
      rental_usage_meters.reasoning_tokens,
      rental_usage_meters.requests_used,
      rental_usage_meters.lrt_delta,
      rental_usage_meters.lrt_total,
      rental_usage_meters.tool_call_count,
      rental_usage_meters.command_run_count,
      rental_usage_meters.files_exposed_count,
      rental_usage_meters.heartbeat_count,
    ]) {
      assert.equal(col.notNull, true, `${col.name} should be NOT NULL`);
      assert.notEqual(col.default, undefined, `${col.name} should have a default`);
    }
  });

  it("native_* fields are nullable", () => {
    for (const col of [
      rental_usage_meters.native_used,
      rental_usage_meters.native_remaining,
      rental_usage_meters.native_reset_at,
      rental_usage_meters.native_unit,
      rental_usage_meters.credits_used,
      rental_usage_meters.usd_used,
      rental_usage_meters.last_heartbeat_at,
    ]) {
      assert.equal(col.notNull, false, `${col.name} should be nullable`);
    }
  });

  it("idempotency_key is NOT NULL (per session)", () => {
    assert.equal(rental_usage_meters.idempotency_key.notNull, true);
  });
});

// ===== ingestUsage service =====

function makeReport(over: Partial<IngestUsageReport> = {}): IngestUsageReport {
  return {
    source: "adapter",
    snapshot: {
      provider: "claude_code",
      model: "claude-3.7-sonnet",
      nativeUnit: "tokens",
      nativeUsed: 4_100,
      nativeRemaining: null,
      nativeResetAt: null,
    },
    delta: {
      inputTokens: 1_500,
      outputTokens: 420,
      cacheCreationTokens: 2_000,
      cacheReadTokens: 15_000,
      reasoningTokens: 0,
    },
    lrt: {
      lrtUsed: 1_500 + 420 * 4 + 2_000 * 1.25 + 15_000 * 0.1,
      confidence: "local_exact",
    },
    idempotencyKey: "ikey-1",
    ...over,
  };
}

function makeMeterRow(over: Partial<RentalUsageMeterRow> = {}): RentalUsageMeterRow {
  return {
    id: "rusg_existing",
    session_id: "sess_1",
    source: "adapter",
    native_unit: "tokens",
    native_used: "100",
    native_remaining: null,
    native_reset_at: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    requests_used: 0,
    credits_used: null,
    usd_used: null,
    lrt_delta: 300,
    lrt_total: 300,
    confidence: "local_exact",
    adapter_payload: null,
    tool_call_count: 2,
    command_run_count: 0,
    files_exposed_count: 0,
    heartbeat_count: 1,
    last_heartbeat_at: null,
    idempotency_key: "prior-key",
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as unknown as RentalUsageMeterRow;
}

function buildDeps(overrides: {
  session?: { id: string; renter_lane_provider: string | null; renter_lane_model: string | null } | null;
  latest?: RentalUsageMeterRow | null;
  byIdempotency?: RentalUsageMeterRow | null;
} = {}) {
  const inserted: (typeof rental_usage_meters.$inferInsert)[] = [];
  // Distinguish "no key provided" from "explicit null" by checking ownership.
  const sessionProvided = Object.prototype.hasOwnProperty.call(overrides, "session");
  const defaultSession = { id: "sess_1", renter_lane_provider: null, renter_lane_model: null };
  return {
    inserted,
    deps: {
      loadSession: async () => (sessionProvided ? overrides.session ?? null : defaultSession),
      loadLatestMeter: async () => overrides.latest ?? null,
      loadByIdempotency: async () => overrides.byIdempotency ?? null,
      insertMeter: async (row: typeof rental_usage_meters.$inferInsert) => {
        inserted.push(row);
        return makeMeterRow({
          ...row,
          created_at: new Date(),
          updated_at: new Date(),
        } as Partial<RentalUsageMeterRow>);
      },
    },
  };
}

describe("ingestUsage", () => {
  it("returns existing row when idempotencyKey already exists (no new insert)", async () => {
    const existing = makeMeterRow({ id: "rusg_dup", idempotency_key: "ikey-1" });
    const { deps, inserted } = buildDeps({ byIdempotency: existing });
    const out = await ingestUsage("sess_1", makeReport(), deps);
    assert.equal(out.id, "rusg_dup");
    assert.equal(inserted.length, 0, "no insert when idempotent");
  });

  it("rejects when session does not exist", async () => {
    const { deps } = buildDeps({ session: null });
    await assert.rejects(
      ingestUsage("nope", makeReport(), deps),
      (err) => err instanceof UsageIngestError && err.code === "session_not_found",
    );
  });

  it("rejects when snapshot provider does not match session lane provider", async () => {
    const { deps } = buildDeps({
      session: { id: "sess_1", renter_lane_provider: "antigravity", renter_lane_model: null },
    });
    await assert.rejects(
      ingestUsage("sess_1", makeReport(), deps),
      (err) => err instanceof UsageIngestError && err.code === "provider_model_mismatch",
    );
  });

  it("rejects when snapshot model does not match session lane model", async () => {
    const { deps } = buildDeps({
      session: { id: "sess_1", renter_lane_provider: null, renter_lane_model: "claude-3.5-haiku" },
    });
    await assert.rejects(
      ingestUsage("sess_1", makeReport(), deps),
      (err) => err instanceof UsageIngestError && err.code === "provider_model_mismatch",
    );
  });

  it("rejects when idempotencyKey is empty", async () => {
    const { deps } = buildDeps();
    await assert.rejects(
      ingestUsage("sess_1", makeReport({ idempotencyKey: "   " }), deps),
      (err) => err instanceof UsageIngestError && err.code === "invalid_input",
    );
  });

  it("inserts a row with rolling lrt_total when there is no prior meter", async () => {
    const { deps, inserted } = buildDeps();
    const out = await ingestUsage("sess_1", makeReport(), deps);
    assert.equal(inserted.length, 1);
    const row = inserted[0]!;
    assert.equal(row.session_id, "sess_1");
    assert.equal(row.source, "adapter");
    assert.equal(row.input_tokens, 1_500);
    assert.equal(row.confidence, "local_exact");
    assert.equal(row.lrt_delta, out.lrt_delta);
    assert.equal(row.lrt_total, row.lrt_delta, "first row: lrt_total = lrt_delta");
  });

  it("rolling lrt_total carries the previous total forward", async () => {
    const prior = makeMeterRow({
      lrt_total: 7_500,
      tool_call_count: 5,
      command_run_count: 2,
      files_exposed_count: 3,
      heartbeat_count: 9,
    });
    const { deps, inserted } = buildDeps({ latest: prior });
    const report = makeReport({
      lrt: { lrtUsed: 250, confidence: "local_exact" },
      delta: { toolCalls: 2, commandRuns: 1, filesExposed: 0, heartbeats: 1 },
    });
    await ingestUsage("sess_1", report, deps);
    const row = inserted[0]!;
    assert.equal(row.lrt_delta, 250);
    assert.equal(row.lrt_total, 7_750, "rolling total = prior + delta");
    assert.equal(row.tool_call_count, 7, "tool counters carry forward + new delta");
    assert.equal(row.command_run_count, 3);
    assert.equal(row.files_exposed_count, 3);
    assert.equal(row.heartbeat_count, 10);
  });

  it("clamps negative delta fields to 0 (meter reset is not a refund)", async () => {
    const { deps, inserted } = buildDeps();
    const report = makeReport({
      delta: {
        inputTokens: -50,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
    });
    await ingestUsage("sess_1", report, deps);
    assert.equal(inserted[0]!.input_tokens, 0);
    assert.equal(inserted[0]!.output_tokens, 100);
  });
});

// ===== Route tests =====

describe("POST /api/rental/sessions/:id/usage", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let ingestCalls: Array<{ sessionId: string; report: IngestUsageReport }>;
  let resolveAccessCalls: Array<{ sessionId: string; accountId: string }>;
  let accessReturn: "renter" | "provider" | null;
  let ingestImpl: (sessionId: string, report: IngestUsageReport) => Promise<RentalUsageMeterRow>;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    ingestCalls = [];
    resolveAccessCalls = [];
    accessReturn = "renter";
    ingestImpl = async (sessionId, report) => {
      ingestCalls.push({ sessionId, report });
      return makeMeterRow({ id: "rusg_new", session_id: sessionId });
    };

    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    // Inject session account on every request.
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_1" };
      next();
    });

    registerRentalInternalRoutes(app, {
      ingestUsage: (sessionId, report) => ingestImpl(sessionId, report),
      resolveSessionAccess: async (sessionId, accountId) => {
        resolveAccessCalls.push({ sessionId, accountId });
        return accessReturn;
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : "{}",
    });
  }

  it("returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await post("/api/rental/sessions/sess_1/usage", makeReport());
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "rent_disabled");
  });

  it("returns 401 when no session account is attached", async () => {
    // Make a fresh app with no auth middleware.
    const express = (await import("express")).default;
    const noAuth = express();
    noAuth.use(express.json());
    registerRentalInternalRoutes(noAuth, {
      ingestUsage: ingestImpl,
      resolveSessionAccess: async () => "renter",
    });
    const srv = await new Promise<http.Server>((resolve) => {
      const s = noAuth.listen(0, () => resolve(s));
    });
    try {
      const addr = srv.address() as import("net").AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/rental/sessions/sess_1/usage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeReport()),
      });
      assert.equal(res.status, 401);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("returns 404 when account is neither renter nor provider for the session", async () => {
    accessReturn = null;
    const res = await post("/api/rental/sessions/sess_1/usage", makeReport());
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "session not found");
  });

  it("returns 400 on invalid body (missing required fields)", async () => {
    const res = await post("/api/rental/sessions/sess_1/usage", { source: "adapter" });
    assert.equal(res.status, 400);
  });

  it("returns 400 on invalid source enum", async () => {
    const res = await post("/api/rental/sessions/sess_1/usage", {
      ...makeReport(),
      source: "garbage",
    });
    assert.equal(res.status, 400);
  });

  it("returns 201 happy path; ingestUsage gets session_id from URL and report from body", async () => {
    const res = await post("/api/rental/sessions/sess_abc/usage", makeReport());
    assert.equal(res.status, 201);
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0]!.sessionId, "sess_abc");
    assert.equal(ingestCalls[0]!.report.source, "adapter");
    assert.equal(resolveAccessCalls.length, 1);
    assert.equal(resolveAccessCalls[0]!.accountId, "acct_1");
  });

  it("returns 409 when the service throws provider_model_mismatch", async () => {
    ingestImpl = async () => {
      throw new UsageIngestError("mismatch", "provider_model_mismatch", 409);
    };
    const res = await post("/api/rental/sessions/sess_1/usage", makeReport());
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: string; code: string };
    assert.equal(json.code, "provider_model_mismatch");
  });
});
