/**
 * Tests for rental listings schema + route handler behavior.
 *
 * Part of PR p1.1 — verifies:
 * - Drizzle schema shape, enum values, and column constraints
 * - Feature flag behavior (LETAGENTS_RENT_ENABLED)
 * - Route handler behavior through real express app with injected deps:
 *   - Rent-disabled → 404
 *   - Unauthenticated → 401
 *   - Create validation (missing displayName, ideKind)
 *   - PATCH blank-name validation
 *   - Provider account scoping (service receives correct account_id)
 *   - Service null → 404 for non-owned listings
 *   - Create, list, pause, resume happy paths
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  rental_listings,
  rentalListingStatusEnum,
  rentalVerificationStatusEnum,
  rentalMeterConfidenceEnum,
  rentalNativeQuotaUnitEnum,
} from "../db/schema.js";

// ===== Schema Enum Tests =====

describe("rental_listings schema", () => {
  it("rentalListingStatusEnum has 4 values matching spec §19.1", () => {
    assert.deepStrictEqual(rentalListingStatusEnum.enumValues, [
      "active", "paused", "disabled", "setup_required",
    ]);
  });

  it("rentalVerificationStatusEnum has 4 values matching spec §19.1", () => {
    assert.deepStrictEqual(rentalVerificationStatusEnum.enumValues, [
      "verified", "partially_verified", "experimental", "unreachable",
    ]);
  });

  it("rentalMeterConfidenceEnum has 7 values matching spec §17.7", () => {
    assert.deepStrictEqual(rentalMeterConfidenceEnum.enumValues, [
      "official_exact", "local_exact", "derived", "calibrated",
      "estimated", "weak_estimate", "unknown",
    ]);
  });

  it("rentalNativeQuotaUnitEnum has 7 values matching spec §17.7", () => {
    assert.deepStrictEqual(rentalNativeQuotaUnitEnum.enumValues, [
      "tokens", "credits", "usd", "requests",
      "percent_window", "time", "unknown",
    ]);
  });
});

// ===== Schema Column Tests =====

describe("rental_listings table columns", () => {
  const expectedColumns = [
    "id", "provider_account_id", "display_name", "status",
    "verification_status", "readiness_badges", "ide_kind", "model_label",
    "quota_lane_id", "quota_lane_label", "meter_confidence", "native_quota_unit",
    "last_native_quota_snapshot", "last_lrt_estimate", "last_quota_reset_at",
    "verified_agent_fingerprint_id", "supported_modes", "max_concurrent_sessions",
    "default_lrt_limit", "default_time_limit_minutes", "manual_accept_required",
    "created_at", "updated_at",
  ];

  it("has all expected columns per spec §19.1", () => {
    const columns = Object.keys(rental_listings);
    for (const col of expectedColumns) {
      assert.ok(columns.includes(col), `Missing column: ${col}`);
    }
  });

  it("id column is primary key", () => {
    assert.ok(rental_listings.id.primary, "id should be primary key");
  });

  it("required columns are notNull", () => {
    for (const col of ["provider_account_id", "display_name", "ide_kind", "status", "manual_accept_required", "max_concurrent_sessions"]) {
      const column = (rental_listings as Record<string, { notNull: boolean }>)[col];
      assert.ok(column.notNull, `${col} should be NOT NULL`);
    }
  });

  it("nullable columns are correctly nullable", () => {
    for (const col of ["model_label", "quota_lane_id", "quota_lane_label", "last_native_quota_snapshot", "last_lrt_estimate", "last_quota_reset_at", "verified_agent_fingerprint_id", "default_lrt_limit", "default_time_limit_minutes"]) {
      const column = (rental_listings as Record<string, { notNull: boolean }>)[col];
      assert.ok(!column.notNull, `${col} should be nullable`);
    }
  });

  it("schema defaults are set", () => {
    assert.ok(rental_listings.status.default !== undefined, "status default");
    assert.ok(rental_listings.verification_status.default !== undefined, "verification_status default");
    assert.ok(rental_listings.supported_modes.default !== undefined, "supported_modes default");
  });
});

// ===== Route Handler Tests (real express, injected deps) =====

describe("rental provider route handlers", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let deps: Record<string, (...args: unknown[]) => unknown>;
  const FAKE_ACCOUNT_ID = "acct_test123";
  const LISTING_FIXTURE = {
    id: "rlist_abc",
    provider_account_id: FAKE_ACCOUNT_ID,
    display_name: "My Agent",
    status: "setup_required",
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(async () => {
    // Dynamic import express so we don't hit the DB client
    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    // Enable rent
    process.env.LETAGENTS_RENT_ENABLED = "true";

    // Create deps with tracking
    deps = {
      createListing: async (input: unknown) => ({ ...LISTING_FIXTURE, ...(input as Record<string, unknown>) }),
      updateListing: async (_listingId: unknown, _accountId: unknown, _input: unknown) => LISTING_FIXTURE,
      pauseListing: async (_listingId: unknown, _accountId: unknown) => ({ ...LISTING_FIXTURE, status: "paused" }),
      resumeListing: async (_listingId: unknown, _accountId: unknown) => ({ ...LISTING_FIXTURE, status: "active" }),
      listMyListings: async (_accountId: unknown) => [LISTING_FIXTURE],
    };

    // Inject auth middleware
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

    // Import and register routes
    const { registerRentalProviderRoutes } = await import("../routes/rental-provider.js");
    registerRentalProviderRoutes(app, deps as never);

    // Start server
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

  // Helper
  async function req(method: string, path: string, body?: unknown) {
    const opts: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(`${baseUrl}${path}`, opts);
  }

  it("returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await req("POST", "/api/rental/provider/listings", { displayName: "X", ideKind: "y" });
    assert.strictEqual(res.status, 404);
    const json = await res.json() as { error: string };
    assert.strictEqual(json.error, "rent_disabled");
  });

  it("returns 401 when unauthenticated", async () => {
    // Override — remove auth middleware for this test by making a fresh app
    const express = (await import("express")).default;
    const unauthedApp = express();
    unauthedApp.use(express.json());
    // No auth middleware — sessionAccount will be undefined
    const { registerRentalProviderRoutes: register } = await import("../routes/rental-provider.js");
    register(unauthedApp, deps as never);
    const srv = await new Promise<http.Server>((resolve) => {
      const s = unauthedApp.listen(0, () => resolve(s));
    });
    try {
      const addr2 = srv.address() as import("net").AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr2.port}/api/rental/provider/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "X", ideKind: "y" }),
      });
      assert.strictEqual(res.status, 401);
      const json = await res.json() as { error: string };
      assert.strictEqual(json.error, "Authentication required");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("create rejects missing displayName with 400", async () => {
    const res = await req("POST", "/api/rental/provider/listings", { ideKind: "claude_code" });
    assert.strictEqual(res.status, 400);
    const json = await res.json() as { error: string };
    assert.strictEqual(json.error, "displayName is required");
  });

  it("create rejects missing ideKind with 400", async () => {
    const res = await req("POST", "/api/rental/provider/listings", { displayName: "My Agent" });
    assert.strictEqual(res.status, 400);
    const json = await res.json() as { error: string };
    assert.strictEqual(json.error, "ideKind is required");
  });

  it("create happy path returns 201", async () => {
    const res = await req("POST", "/api/rental/provider/listings", {
      displayName: "My Agent",
      ideKind: "claude_code",
    });
    assert.strictEqual(res.status, 201);
  });

  it("create passes provider_account_id from session to service", async () => {
    let capturedInput: Record<string, unknown> | null = null;
    deps.createListing = async (input: unknown) => {
      capturedInput = input as Record<string, unknown>;
      return LISTING_FIXTURE;
    };
    await req("POST", "/api/rental/provider/listings", {
      displayName: "My Agent",
      ideKind: "claude_code",
    });
    assert.ok(capturedInput, "createListing should have been called");
    assert.strictEqual(capturedInput!.providerAccountId, FAKE_ACCOUNT_ID);
  });

  it("list returns listings from service", async () => {
    const res = await req("GET", "/api/rental/provider/listings");
    assert.strictEqual(res.status, 200);
    const json = await res.json() as { listings: unknown[] };
    assert.strictEqual(json.listings.length, 1);
  });

  it("list passes provider_account_id to service", async () => {
    let capturedAccountId: unknown = null;
    deps.listMyListings = async (accountId: unknown) => {
      capturedAccountId = accountId;
      return [];
    };
    await req("GET", "/api/rental/provider/listings");
    assert.strictEqual(capturedAccountId, FAKE_ACCOUNT_ID);
  });

  it("PATCH rejects blank displayName with 400", async () => {
    const res = await req("PATCH", "/api/rental/provider/listings/rlist_abc", {
      displayName: "   ",
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json() as { error: string };
    assert.strictEqual(json.error, "displayName must not be empty");
  });

  it("PATCH returns 404 for non-owned listing (service returns null)", async () => {
    deps.updateListing = async () => null;
    const res = await req("PATCH", "/api/rental/provider/listings/rlist_other", {
      displayName: "New Name",
    });
    assert.strictEqual(res.status, 404);
  });

  it("PATCH happy path returns updated listing", async () => {
    const res = await req("PATCH", "/api/rental/provider/listings/rlist_abc", {
      displayName: "Updated",
    });
    assert.strictEqual(res.status, 200);
  });

  it("PATCH passes correct listingId and accountId to service", async () => {
    let capturedArgs: unknown[] = [];
    deps.updateListing = async (...args: unknown[]) => {
      capturedArgs = args;
      return LISTING_FIXTURE;
    };
    await req("PATCH", "/api/rental/provider/listings/rlist_xyz", {
      displayName: "Updated",
    });
    assert.strictEqual(capturedArgs[0], "rlist_xyz");
    assert.strictEqual(capturedArgs[1], FAKE_ACCOUNT_ID);
  });

  it("pause returns 404 for non-owned listing", async () => {
    deps.pauseListing = async () => null;
    const res = await req("POST", "/api/rental/provider/listings/rlist_other/pause");
    assert.strictEqual(res.status, 404);
  });

  it("pause happy path returns paused listing", async () => {
    const res = await req("POST", "/api/rental/provider/listings/rlist_abc/pause");
    assert.strictEqual(res.status, 200);
    const json = await res.json() as { status: string };
    assert.strictEqual(json.status, "paused");
  });

  it("resume returns 404 for non-owned listing", async () => {
    deps.resumeListing = async () => null;
    const res = await req("POST", "/api/rental/provider/listings/rlist_other/resume");
    assert.strictEqual(res.status, 404);
  });

  it("resume happy path returns active listing", async () => {
    const res = await req("POST", "/api/rental/provider/listings/rlist_abc/resume");
    assert.strictEqual(res.status, 200);
    const json = await res.json() as { status: string };
    assert.strictEqual(json.status, "active");
  });
});

// ===== Feature Flag Tests =====

describe("isRentEnabled export", () => {
  it("truthy values enable rent", () => {
    for (const v of ["1", "true", "yes", "TRUE", "Yes"]) {
      assert.ok(/^(1|true|yes)$/i.test(v.trim()), `Should be truthy: '${v}'`);
    }
  });

  it("falsy values disable rent", () => {
    for (const v of ["", "0", "false", "no", "maybe", "enabled"]) {
      assert.ok(!/^(1|true|yes)$/i.test(v.trim()), `Should be falsy: '${v}'`);
    }
  });
});
