/**
 * Tests for the §19.2 D3 trigger-context plumbing on
 * POST /api/rental/sessions (p1.7).
 *
 * Covers the pure validator `parseTriggerContext` exhaustively and the
 * three trigger combinations from the breakdown:
 *   - quota_exhausted / exact     → writes all D3 fields
 *   - quota_exhausted / inferred  → writes signal but no refresh_eta
 *   - user_initiated / manual     → writes only start_trigger + confidence
 *
 * No DB hits — we wire the route to a fake createSession that captures
 * the input it received and assert on that.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

const {
  parseTriggerContext,
  isRentalStartTrigger,
  isRentalTriggerConfidence,
  RENTAL_START_TRIGGERS,
  RENTAL_TRIGGER_CONFIDENCES,
  buildInMemoryListingsRateLimiter,
  registerRentalRenterRoutes,
} = await import("../routes/rental/renter/index.js");

const express = (await import("express")).default;

// ===========================================================================
// Pure validator
// ===========================================================================

describe("parseTriggerContext — enum validation", () => {
  it("accepts every documented start_trigger value", () => {
    for (const value of RENTAL_START_TRIGGERS) {
      assert.ok(isRentalStartTrigger(value), `${value} should be valid`);
      const out = parseTriggerContext({ startTrigger: value });
      assert.equal(out.ok, true);
      if (out.ok) assert.equal(out.value.startTrigger, value);
    }
  });

  it("rejects unknown start_trigger values", () => {
    const out = parseTriggerContext({ startTrigger: "definitely_not_a_trigger" });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /startTrigger must be one of/);
  });

  it("accepts every documented trigger_confidence value", () => {
    for (const value of RENTAL_TRIGGER_CONFIDENCES) {
      assert.ok(isRentalTriggerConfidence(value), `${value} should be valid`);
      const out = parseTriggerContext({ triggerConfidence: value });
      assert.equal(out.ok, true);
      if (out.ok) assert.equal(out.value.triggerConfidence, value);
    }
  });

  it("rejects unknown trigger_confidence values", () => {
    const out = parseTriggerContext({ triggerConfidence: "bogus" });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /triggerConfidence must be one of/);
  });

  it("rejects non-string startTrigger / triggerConfidence", () => {
    const a = parseTriggerContext({ startTrigger: 42 });
    assert.equal(a.ok, false);
    const b = parseTriggerContext({ triggerConfidence: true });
    assert.equal(b.ok, false);
  });
});

describe("parseTriggerContext — renter lane fields", () => {
  it("trims and stores renter lane provider/model strings", () => {
    const out = parseTriggerContext({
      renterLaneProvider: "  antigravity  ",
      renterLaneModel: "  gemini-2.5-pro  ",
      startTrigger: "user_initiated",
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.renterLaneProvider, "antigravity");
      assert.equal(out.value.renterLaneModel, "gemini-2.5-pro");
    }
  });

  it("rejects empty renterLaneProvider / renterLaneModel", () => {
    assert.equal(
      parseTriggerContext({ renterLaneProvider: "   " }).ok,
      false,
    );
    assert.equal(
      parseTriggerContext({ renterLaneModel: "" }).ok,
      false,
    );
  });

  it("parses renterLaneExhaustedAt / renterLaneRefreshEta as ISO timestamps", () => {
    const out = parseTriggerContext({
      startTrigger: "quota_exhausted",
      renterLaneProvider: "antigravity",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
      renterLaneRefreshEta: "2026-05-11T18:00:00.000Z",
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(
        out.value.renterLaneExhaustedAt?.toISOString(),
        "2026-05-11T10:00:00.000Z",
      );
      assert.equal(
        out.value.renterLaneRefreshEta?.toISOString(),
        "2026-05-11T18:00:00.000Z",
      );
    }
  });

  it("rejects non-ISO-8601 dates with a 400-quality message", () => {
    const out = parseTriggerContext({
      startTrigger: "quota_exhausted",
      renterLaneProvider: "antigravity",
      renterLaneExhaustedAt: "yesterday-ish",
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /ISO-8601/);
  });

  it("requires plain-object renterQuotaSignal", () => {
    const arr = parseTriggerContext({ renterQuotaSignal: [1, 2, 3] });
    assert.equal(arr.ok, false);
    const str = parseTriggerContext({ renterQuotaSignal: "tokens" });
    assert.equal(str.ok, false);
    const obj = parseTriggerContext({ renterQuotaSignal: { tokens_remaining: 0 } });
    assert.equal(obj.ok, true);
  });

  it("requires renterLaneProvider when renterLaneExhaustedAt is set (§19.2 cross-field)", () => {
    const out = parseTriggerContext({
      startTrigger: "quota_exhausted",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /renterLaneProvider is required/);
  });

  it("requires startTrigger when renterLaneExhaustedAt is set", () => {
    const out = parseTriggerContext({
      renterLaneProvider: "antigravity",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /startTrigger is required/);
  });
});

describe("parseTriggerContext — empty/null pass-through", () => {
  it("accepts an empty body (no D3 fields supplied)", () => {
    const out = parseTriggerContext({});
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.startTrigger, undefined);
      assert.equal(out.value.triggerConfidence, undefined);
      assert.equal(out.value.renterLaneProvider, undefined);
      assert.equal(out.value.renterLaneModel, undefined);
    }
  });

  it("treats null as omitted (not invalid)", () => {
    const out = parseTriggerContext({
      startTrigger: null,
      triggerConfidence: null,
      renterLaneExhaustedAt: null,
      renterQuotaSignal: null,
    });
    assert.equal(out.ok, true);
  });
});

// ===========================================================================
// Route-level integration (D3 plumbing reaches createSession)
// ===========================================================================

interface CapturedCreateSessionInput {
  listingId: string;
  renterAccountId: string;
  startTrigger?: string;
  triggerConfidence?: string;
  renterLaneProvider?: string;
  renterLaneModel?: string;
  renterLaneExhaustedAt?: Date;
  renterLaneRefreshEta?: Date;
  renterQuotaSignal?: Record<string, unknown>;
}

function buildApp(): {
  app: import("express").Express;
  captured: CapturedCreateSessionInput[];
} {
  const captured: CapturedCreateSessionInput[] = [];

  const app = express();
  app.use(express.json());
  // Stub an auth middleware so requireAuth() succeeds.
  app.use((req, _res, next) => {
    (req as unknown as { sessionAccount: { account_id: string } }).sessionAccount = {
      account_id: "renter_account_123",
    };
    next();
  });

  registerRentalRenterRoutes(app, {
    publicListings: async () => [],
    shouldAllowListingsQuery: buildInMemoryListingsRateLimiter(),
    async createSession(input) {
      captured.push(input as CapturedCreateSessionInput);
      return {
        id: "rsess_test",
        ...input,
      } as unknown as Awaited<ReturnType<RentalRenterCreateSession>>;
    },
    async getSessionById() {
      return null;
    },
    async cancelSession() {
      return null;
    },
  });

  return { app, captured };
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

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
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
    req.write(payload);
    req.end();
  });
}

const BASE_REQUIRED_FIELDS = {
  listingId: "listing_1",
  repoOwner: "BrosInCode",
  repoName: "letagents",
  baseBranch: "main",
  taskTitle: "Hello",
  taskPrompt: "Do the thing",
};

describe("POST /api/rental/sessions — D3 trigger combinations", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let captured: CapturedCreateSessionInput[] = [];

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "1";
    const built = buildApp();
    captured = built.captured;
    server = await startServer(built.app);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    delete process.env.LETAGENTS_RENT_ENABLED;
  });

  it("quota_exhausted/exact writes all D3 fields", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      renterLaneProvider: "antigravity",
      renterLaneModel: "gemini-2.5-pro",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
      renterLaneRefreshEta: "2026-05-11T18:00:00.000Z",
      renterQuotaSignal: { tokens_remaining: 0 },
    });
    assert.equal(res.status, 201);
    assert.equal(captured.length, 1);
    const c = captured[0]!;
    assert.equal(c.startTrigger, "quota_exhausted");
    assert.equal(c.triggerConfidence, "exact");
    assert.equal(c.renterLaneProvider, "antigravity");
    assert.equal(c.renterLaneModel, "gemini-2.5-pro");
    assert.equal(
      c.renterLaneExhaustedAt?.toISOString(),
      "2026-05-11T10:00:00.000Z",
    );
    assert.equal(
      c.renterLaneRefreshEta?.toISOString(),
      "2026-05-11T18:00:00.000Z",
    );
    assert.deepEqual(c.renterQuotaSignal, { tokens_remaining: 0 });
  });

  it("quota_exhausted/inferred writes signal but no refresh_eta", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "quota_exhausted",
      triggerConfidence: "inferred",
      renterLaneProvider: "antigravity",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
      renterQuotaSignal: { failures_in_window: 5 },
      // intentionally omitting renterLaneRefreshEta + renterLaneModel
    });
    assert.equal(res.status, 201);
    const c = captured[0]!;
    assert.equal(c.startTrigger, "quota_exhausted");
    assert.equal(c.triggerConfidence, "inferred");
    assert.equal(c.renterLaneProvider, "antigravity");
    assert.equal(c.renterLaneRefreshEta, undefined);
    assert.equal(c.renterLaneModel, undefined);
    assert.deepEqual(c.renterQuotaSignal, { failures_in_window: 5 });
  });

  it("user_initiated/manual writes only start_trigger + confidence", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "user_initiated",
      triggerConfidence: "manual",
    });
    assert.equal(res.status, 201);
    const c = captured[0]!;
    assert.equal(c.startTrigger, "user_initiated");
    assert.equal(c.triggerConfidence, "manual");
    assert.equal(c.renterLaneProvider, undefined);
    assert.equal(c.renterLaneModel, undefined);
    assert.equal(c.renterLaneExhaustedAt, undefined);
    assert.equal(c.renterLaneRefreshEta, undefined);
    assert.equal(c.renterQuotaSignal, undefined);
  });

  it("rejects unknown startTrigger with 400 + descriptive error", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "not_a_real_trigger",
    });
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /startTrigger must be one of/,
    );
    assert.equal(captured.length, 0);
  });

  it("rejects unknown triggerConfidence with 400 + descriptive error", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      triggerConfidence: "very_confident",
    });
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /triggerConfidence must be one of/,
    );
    assert.equal(captured.length, 0);
  });

  it("rejects renterLaneExhaustedAt without renterLaneProvider (§19.2 cross-field)", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "quota_exhausted",
      triggerConfidence: "exact",
      renterLaneExhaustedAt: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /renterLaneProvider is required/,
    );
    assert.equal(captured.length, 0);
  });

  it("rejects malformed ISO timestamp with 400", async () => {
    const res = await postJson(server!.port, "/api/rental/sessions", {
      ...BASE_REQUIRED_FIELDS,
      startTrigger: "quota_exhausted",
      renterLaneProvider: "antigravity",
      renterLaneExhaustedAt: "not-a-date",
    });
    assert.equal(res.status, 400);
    assert.match(
      ((res.body as { error?: string })?.error ?? "") as string,
      /ISO-8601/,
    );
    assert.equal(captured.length, 0);
  });
});
