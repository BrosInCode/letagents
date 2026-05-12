/**
 * Tests for the provider-readiness projector (p2.14).
 *
 * Covers:
 * - Pure `projectProviderReadiness` rollup behavior (empty, all-active,
 *   mixed, all-paused, all-disabled, setup_required mix).
 * - Badge de-duplication across listings.
 * - Per-listing `checks[]` mapping.
 * - Integration through `GET /api/rental/provider/readiness`:
 *   - 404 when rent disabled
 *   - 401 when unauthenticated
 *   - 200 happy path projection
 *   - 500 when the underlying lister throws
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { projectProviderReadiness } from "../rental/provider-readiness.js";
import type { rental_listings } from "../db/schema.js";

type ListingRow = typeof rental_listings.$inferSelect;

function makeListing(overrides: Partial<ListingRow> = {}): ListingRow {
  const base: ListingRow = {
    id: "rlist_test",
    provider_account_id: "acct_test",
    display_name: "Listing",
    status: "active",
    verification_status: "experimental",
    readiness_badges: [],
    ide_kind: "claude_code",
    model_label: null,
    quota_lane_id: null,
    quota_lane_label: null,
    meter_confidence: "unknown",
    native_quota_unit: "unknown",
    last_native_quota_snapshot: null,
    last_lrt_estimate: null,
    last_quota_reset_at: null,
    verified_agent_fingerprint_id: null,
    supported_modes: ["scoped"],
    max_concurrent_sessions: 1,
    default_lrt_limit: null,
    default_time_limit_minutes: null,
    manual_accept_required: true,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
  } as ListingRow;
  return { ...base, ...overrides } as ListingRow;
}

describe("projectProviderReadiness", () => {
  const FROZEN_NOW = new Date("2026-05-12T11:00:00.000Z");

  it("returns 'unknown' with empty checks when there are no listings", () => {
    const out = projectProviderReadiness([], FROZEN_NOW);
    assert.strictEqual(out.status, "unknown");
    assert.deepStrictEqual(out.checks, []);
    assert.deepStrictEqual(out.blockers, []);
    assert.deepStrictEqual(out.warnings, []);
    assert.deepStrictEqual(out.badges, []);
    assert.ok(out.summary?.startsWith("No listings yet"));
    assert.strictEqual(out.last_checked_at, FROZEN_NOW.toISOString());
  });

  it("returns 'ready' when every listing is active", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", status: "active" }),
        makeListing({ id: "b", status: "active" }),
      ],
      FROZEN_NOW,
    );
    assert.strictEqual(out.status, "ready");
    assert.deepStrictEqual(out.blockers, []);
    assert.deepStrictEqual(out.warnings, []);
    assert.strictEqual(out.checks.length, 2);
    assert.ok(out.checks.every((c) => c.status === "passed"));
  });

  it("returns 'degraded' with a warning when some listings need setup", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", status: "active" }),
        makeListing({ id: "b", status: "setup_required" }),
      ],
      FROZEN_NOW,
    );
    assert.strictEqual(out.status, "degraded");
    assert.deepStrictEqual(out.blockers, []);
    assert.ok(
      out.warnings.some((w) => w.includes("need setup")),
      "expected setup_required warning",
    );
  });

  it("returns 'degraded' when only paused listings exist (no active)", () => {
    const out = projectProviderReadiness(
      [makeListing({ id: "a", status: "paused" })],
      FROZEN_NOW,
    );
    assert.strictEqual(out.status, "degraded");
    assert.deepStrictEqual(out.blockers, []);
  });

  it("warns about paused listings even when others are active", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", status: "active" }),
        makeListing({ id: "b", status: "paused" }),
      ],
      FROZEN_NOW,
    );
    assert.strictEqual(out.status, "ready");
    assert.ok(out.warnings.some((w) => /paused/.test(w)));
  });

  it("returns 'blocked' with a blocker when every listing is disabled", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", status: "disabled" }),
        makeListing({ id: "b", status: "disabled" }),
      ],
      FROZEN_NOW,
    );
    assert.strictEqual(out.status, "blocked");
    assert.strictEqual(out.blockers.length, 1);
    assert.match(out.blockers[0]!, /No active listings/);
  });

  it("de-duplicates and sorts readiness badges across listings", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", readiness_badges: ["verified", "fast"] }),
        makeListing({ id: "b", readiness_badges: ["fast", "experimental"] }),
        makeListing({ id: "c", readiness_badges: [] }),
      ],
      FROZEN_NOW,
    );
    assert.deepStrictEqual(out.badges, ["experimental", "fast", "verified"]);
  });

  it("ignores non-string/empty badge entries defensively", () => {
    const out = projectProviderReadiness(
      [
        makeListing({
          id: "a",
          readiness_badges: ["ok", "", "ok"] as unknown as string[],
        }),
      ],
      FROZEN_NOW,
    );
    assert.deepStrictEqual(out.badges, ["ok"]);
  });

  it("includes one check entry per listing with correct status/detail", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", display_name: "Active", status: "active" }),
        makeListing({ id: "b", display_name: "Paused", status: "paused" }),
        makeListing({ id: "c", display_name: "Off", status: "disabled" }),
        makeListing({ id: "d", display_name: "Setup", status: "setup_required" }),
      ],
      FROZEN_NOW,
    );
    assert.strictEqual(out.checks.length, 4);
    const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
    assert.strictEqual(byId["listing:a"]!.status, "passed");
    assert.strictEqual(byId["listing:b"]!.status, "warning");
    assert.strictEqual(byId["listing:c"]!.status, "failed");
    assert.strictEqual(byId["listing:d"]!.status, "warning");
    assert.ok(byId["listing:a"]!.detail?.includes("accepting"));
    assert.ok(byId["listing:c"]!.detail?.includes("disabled"));
    assert.strictEqual(byId["listing:a"]!.label, "Active");
  });

  it("stamps last_checked_at with the supplied clock", () => {
    const fixed = new Date("2026-01-01T01:02:03.456Z");
    const out = projectProviderReadiness([], fixed);
    assert.strictEqual(out.last_checked_at, "2026-01-01T01:02:03.456Z");
  });

  it("summary mentions counts of each non-zero category", () => {
    const out = projectProviderReadiness(
      [
        makeListing({ id: "a", status: "active" }),
        makeListing({ id: "b", status: "paused" }),
        makeListing({ id: "c", status: "setup_required" }),
      ],
      FROZEN_NOW,
    );
    assert.ok(out.summary?.includes("3 listing"));
    assert.ok(out.summary?.includes("1 active"));
    assert.ok(out.summary?.includes("1 paused"));
    assert.ok(out.summary?.includes("1 need setup"));
  });
});

describe("GET /api/rental/provider/readiness route", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let deps: Record<string, (...args: unknown[]) => unknown>;
  const FAKE_ACCOUNT_ID = "acct_readiness";

  const ACTIVE_LISTING = {
    id: "rlist_active",
    provider_account_id: FAKE_ACCOUNT_ID,
    display_name: "Active Agent",
    status: "active",
    verification_status: "verified",
    readiness_badges: ["verified"],
    ide_kind: "claude_code",
    model_label: null,
    quota_lane_id: null,
    quota_lane_label: null,
    meter_confidence: "unknown",
    native_quota_unit: "unknown",
    last_native_quota_snapshot: null,
    last_lrt_estimate: null,
    last_quota_reset_at: null,
    verified_agent_fingerprint_id: null,
    supported_modes: ["scoped"],
    max_concurrent_sessions: 1,
    default_lrt_limit: null,
    default_time_limit_minutes: null,
    manual_accept_required: true,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
  };

  beforeEach(async () => {
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());
    process.env.LETAGENTS_RENT_ENABLED = "true";

    deps = {
      createListing: async () => ACTIVE_LISTING,
      updateListing: async () => ACTIVE_LISTING,
      pauseListing: async () => ACTIVE_LISTING,
      resumeListing: async () => ACTIVE_LISTING,
      listMyListings: async () => [ACTIVE_LISTING],
      acceptSession: async () => null,
      declineSession: async () => null,
      listProviderRequests: async () => [],
    };

    app.use((req: import("express").Request, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = {
        account_id: FAKE_ACCOUNT_ID,
        id: "session_test",
        token_hash: "",
        provider_access_token: null,
        expires_at: "",
        created_at: "",
        provider: "github",
        provider_user_id: "12345",
        login: "testuser",
        display_name: "Test User",
        avatar_url: null,
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

  it("returns 404 when rent is disabled", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await fetch(`${baseUrl}/api/rental/provider/readiness`);
    assert.strictEqual(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.strictEqual(json.error, "rent_disabled");
  });

  it("returns 401 when unauthenticated", async () => {
    const express = (await import("express")).default;
    const unauthedApp = express();
    unauthedApp.use(express.json());
    const { registerRentalProviderRoutes } = await import(
      "../routes/rental-provider.js"
    );
    registerRentalProviderRoutes(unauthedApp, deps as never);
    const srv = await new Promise<http.Server>((resolve) => {
      const s = unauthedApp.listen(0, () => resolve(s));
    });
    try {
      const addr = srv.address() as import("net").AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/rental/provider/readiness`,
      );
      assert.strictEqual(res.status, 401);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("returns a projected readiness payload on the happy path", async () => {
    const res = await fetch(`${baseUrl}/api/rental/provider/readiness`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(body.status, "ready");
    assert.deepStrictEqual(body.badges, ["verified"]);
    assert.ok(Array.isArray(body.checks));
    assert.strictEqual((body.checks as unknown[]).length, 1);
    assert.ok(typeof body.last_checked_at === "string");
  });

  it("returns 500 when listMyListings throws", async () => {
    deps.listMyListings = async () => {
      throw new Error("boom");
    };
    const res = await fetch(`${baseUrl}/api/rental/provider/readiness`);
    assert.strictEqual(res.status, 500);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /readiness/);
  });

  it("passes the authenticated provider account id to listMyListings", async () => {
    let captured: unknown = null;
    deps.listMyListings = async (accountId: unknown) => {
      captured = accountId;
      return [];
    };
    const res = await fetch(`${baseUrl}/api/rental/provider/readiness`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured, FAKE_ACCOUNT_ID);
  });
});
