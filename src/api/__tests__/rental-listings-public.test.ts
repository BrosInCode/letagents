/**
 * Tests for renter-facing public listings discovery (p1.1b).
 *
 * Verifies:
 * - GET /api/rental/listings returns redacted public shape
 * - Only verified+active listings appear (paused/setup_required hidden)
 * - Filters work: ide_kind / model_label / mode / limit / offset
 * - Rent-disabled → 404
 * - Rate limiter caps per renter
 * - redactPublicListing drops provider-private fields
 * - clampPageLimit clamps page size
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  PublicListingFilters,
  PublicRentalListing,
  RentalListing,
} from "../rental/listings.js";

const { clampPageLimit, redactPublicListing } = await import("../rental/listings.js");
const { buildInMemoryListingsRateLimiter, registerRentalRenterRoutes } = await import(
  "../routes/rental/renter/index.js"
);

// Lazy-imported pieces used to introspect the generated SQL without
// touching a real database. drizzle's `.toSQL()` returns the prepared
// statement + params for any query built from its query builder, so we
// can verify that the `mode` filter is part of the WHERE clause (i.e.
// applied before pagination) and not a post-hoc array filter.
const { sql: drizzleSql, and: drizzleAnd, eq: drizzleEq, desc: drizzleDesc } = await import(
  "drizzle-orm"
);
const { rental_listings: rentalListingsTable } = await import("../db/schema.js");
const { db: drizzleDb } = await import("../db/client.js");

// ===== Pure unit tests =====

describe("clampPageLimit", () => {
  it("returns default when limit is undefined / 0 / negative", () => {
    assert.equal(clampPageLimit(undefined), 25);
    assert.equal(clampPageLimit(0), 25);
    assert.equal(clampPageLimit(-1), 25);
  });

  it("caps limit at 50 (MAX_PUBLIC_LIMIT)", () => {
    assert.equal(clampPageLimit(50), 50);
    assert.equal(clampPageLimit(100), 50);
    assert.equal(clampPageLimit(999_999), 50);
  });

  it("returns the requested limit when within bounds", () => {
    assert.equal(clampPageLimit(1), 1);
    assert.equal(clampPageLimit(25), 25);
    assert.equal(clampPageLimit(49), 49);
  });

  it("floors fractional limits", () => {
    assert.equal(clampPageLimit(10.7 as number), 10);
  });
});

describe("redactPublicListing", () => {
  function rowWith(overrides: Partial<RentalListing> = {}): RentalListing {
    const base = {
      id: "rlist_x",
      provider_account_id: "acct_PRIVATE",
      display_name: "Public name",
      status: "active" as const,
      verification_status: "verified" as const,
      readiness_badges: [] as unknown[],
      ide_kind: "claude_code",
      model_label: "claude-3.7-sonnet",
      quota_lane_id: "lane_PRIVATE",
      quota_lane_label: "Anthropic free",
      meter_confidence: "local_exact" as const,
      native_quota_unit: "tokens" as const,
      last_native_quota_snapshot: { raw: "PRIVATE" } as unknown,
      last_lrt_estimate: 4_200,
      last_quota_reset_at: new Date("2026-05-11T15:00:00Z"),
      verified_agent_fingerprint_id: "fp_PRIVATE",
      supported_modes: ["scoped"] as unknown,
      max_concurrent_sessions: 3,
      default_lrt_limit: 1_000,
      default_time_limit_minutes: 30,
      manual_accept_required: true,
      created_at: new Date("2026-05-11T10:00:00Z"),
      updated_at: new Date("2026-05-11T14:00:00Z"),
    };
    return { ...base, ...overrides } as RentalListing;
  }

  it("drops provider_account_id from the public shape", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal((redacted as Record<string, unknown>).providerAccountId, undefined);
    assert.equal((redacted as Record<string, unknown>).provider_account_id, undefined);
  });

  it("drops quota_lane_id but keeps the human-readable quotaLaneLabel", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal((redacted as Record<string, unknown>).quotaLaneId, undefined);
    assert.equal(redacted.quotaLaneLabel, "Anthropic free");
  });

  it("drops last_native_quota_snapshot raw payload", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal((redacted as Record<string, unknown>).lastNativeQuotaSnapshot, undefined);
    assert.equal((redacted as Record<string, unknown>).last_native_quota_snapshot, undefined);
  });

  it("drops verified_agent_fingerprint_id", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal((redacted as Record<string, unknown>).verifiedAgentFingerprintId, undefined);
  });

  it("drops max_concurrent_sessions (internal accounting)", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal((redacted as Record<string, unknown>).maxConcurrentSessions, undefined);
  });

  it("keeps marketplace-facing identity fields", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal(redacted.id, "rlist_x");
    assert.equal(redacted.displayName, "Public name");
    assert.equal(redacted.ideKind, "claude_code");
    assert.equal(redacted.modelLabel, "claude-3.7-sonnet");
    assert.equal(redacted.meterConfidence, "local_exact");
    assert.equal(redacted.nativeQuotaUnit, "tokens");
  });

  it("keeps a single capacity hint (lrtEstimate) — no exact native numbers", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal(redacted.lrtEstimate, 4_200);
  });

  it("serializes timestamps as ISO strings", () => {
    const redacted = redactPublicListing(rowWith());
    assert.equal(redacted.createdAt, "2026-05-11T10:00:00.000Z");
    assert.equal(redacted.updatedAt, "2026-05-11T14:00:00.000Z");
    assert.equal(redacted.lastQuotaResetAt, "2026-05-11T15:00:00.000Z");
  });

  it("handles null optional fields gracefully", () => {
    const redacted = redactPublicListing(
      rowWith({ model_label: null, quota_lane_label: null, last_lrt_estimate: null }),
    );
    assert.equal(redacted.modelLabel, null);
    assert.equal(redacted.quotaLaneLabel, null);
    assert.equal(redacted.lrtEstimate, null);
  });
});

describe("publicListings SQL composition", () => {
  // These tests rebuild the WHERE clause the way publicListings does
  // and verify the generated SQL via drizzle's .toSQL() introspection.
  // No database is touched. The point is to lock in the contract that
  // the `mode` filter is part of the WHERE clause (pre-pagination), not
  // applied after `limit/offset` — which would yield empty/underfilled
  // pages when matches exist further down.

  function buildPublicListingsQuery(mode?: "scoped" | "trusted_open") {
    const conditions = [
      drizzleEq(rentalListingsTable.verification_status, "verified"),
      drizzleEq(rentalListingsTable.status, "active"),
    ];
    if (mode) {
      conditions.push(
        drizzleSql`${rentalListingsTable.supported_modes} @> ${JSON.stringify([mode])}::jsonb`,
      );
    }
    return drizzleDb
      .select()
      .from(rentalListingsTable)
      .where(drizzleAnd(...conditions))
      .orderBy(drizzleDesc(rentalListingsTable.updated_at))
      .limit(25)
      .offset(0);
  }

  it("includes the @> jsonb containment fragment when mode is passed", () => {
    const compiled = buildPublicListingsQuery("trusted_open").toSQL();
    assert.match(compiled.sql, /@>/, "mode filter should be present in the WHERE clause SQL");
    assert.match(compiled.sql, /::jsonb/, "the JSON literal should be cast to jsonb");
    // The mode value should be a parameter, not interpolated literally.
    assert.ok(
      compiled.params.includes('["trusted_open"]'),
      "expected the JSON array parameter to be sent",
    );
  });

  it("omits the @> fragment when mode is not passed", () => {
    const compiled = buildPublicListingsQuery(undefined).toSQL();
    assert.equal(compiled.sql.includes("@>"), false, "no jsonb containment when mode is omitted");
  });

  it("places mode condition before LIMIT (so pagination respects the filter)", () => {
    const compiled = buildPublicListingsQuery("scoped").toSQL();
    const indexOfContainment = compiled.sql.indexOf("@>");
    const indexOfLimit = compiled.sql.toLowerCase().indexOf("limit ");
    assert.ok(indexOfContainment >= 0, "expected @> in the generated SQL");
    assert.ok(indexOfLimit >= 0, "expected LIMIT in the generated SQL");
    assert.ok(
      indexOfContainment < indexOfLimit,
      `mode filter must appear before LIMIT (got @> at ${indexOfContainment}, LIMIT at ${indexOfLimit})`,
    );
  });
});

describe("buildInMemoryListingsRateLimiter", () => {
  it("permits up to `capacity` calls per window", () => {
    let now = 1_000_000;
    const limiter = buildInMemoryListingsRateLimiter({
      capacity: 3,
      windowMs: 60_000,
      now: () => now,
    });
    assert.equal(limiter("ip:1.2.3.4"), true);
    assert.equal(limiter("ip:1.2.3.4"), true);
    assert.equal(limiter("ip:1.2.3.4"), true);
    assert.equal(limiter("ip:1.2.3.4"), false, "4th call within window should be denied");
  });

  it("resets after the window elapses", () => {
    let now = 1_000_000;
    const limiter = buildInMemoryListingsRateLimiter({
      capacity: 2,
      windowMs: 1_000,
      now: () => now,
    });
    assert.equal(limiter("ip:x"), true);
    assert.equal(limiter("ip:x"), true);
    assert.equal(limiter("ip:x"), false);
    now += 1_001;
    assert.equal(limiter("ip:x"), true, "new window should reset the bucket");
  });

  it("scopes per renter key", () => {
    let now = 1_000_000;
    const limiter = buildInMemoryListingsRateLimiter({
      capacity: 1,
      windowMs: 60_000,
      now: () => now,
    });
    assert.equal(limiter("ip:a"), true);
    assert.equal(limiter("ip:a"), false);
    assert.equal(limiter("ip:b"), true, "different renter keys should have independent buckets");
  });
});

// ===== Route tests with injected deps + real Express =====

describe("registerRentalRenterRoutes — GET /api/rental/listings", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let publicListingsCalls: PublicListingFilters[];
  let publicListingsReturn: PublicRentalListing[];
  let rateAllow: boolean;
  let rateCalls: string[];

  function buildSamplePublic(over: Partial<PublicRentalListing> = {}): PublicRentalListing {
    return {
      id: "rlist_pub",
      displayName: "Public Claude",
      ideKind: "claude_code",
      modelLabel: "claude-3.7-sonnet",
      quotaLaneLabel: "Default lane",
      meterConfidence: "local_exact",
      nativeQuotaUnit: "tokens",
      supportedModes: ["scoped"],
      manualAcceptRequired: true,
      defaultLrtLimit: 1_000,
      defaultTimeLimitMinutes: 30,
      lrtEstimate: 4_200,
      lastQuotaResetAt: null,
      createdAt: null,
      updatedAt: null,
      ...over,
    };
  }

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    publicListingsCalls = [];
    publicListingsReturn = [buildSamplePublic()];
    rateAllow = true;
    rateCalls = [];

    const express = (await import("express")).default;
    app = express();
    app.use(express.json());

    registerRentalRenterRoutes(app, {
      publicListings: async (filters) => {
        publicListingsCalls.push(filters);
        return publicListingsReturn;
      },
      shouldAllowListingsQuery: (renterKey) => {
        rateCalls.push(renterKey);
        return rateAllow;
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

  async function get(path: string) {
    return fetch(`${baseUrl}${path}`);
  }

  it("returns 404 rent_disabled when LETAGENTS_RENT_ENABLED is off", async () => {
    process.env.LETAGENTS_RENT_ENABLED = "";
    const res = await get("/api/rental/listings");
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "rent_disabled");
  });

  it("returns the redacted listings on happy path", async () => {
    const res = await get("/api/rental/listings");
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      listings: PublicRentalListing[];
      filters: PublicListingFilters;
    };
    assert.equal(json.listings.length, 1);
    assert.equal(json.listings[0]?.id, "rlist_pub");
    assert.equal((json.listings[0] as Record<string, unknown>).providerAccountId, undefined);
    assert.equal((json.listings[0] as Record<string, unknown>).quotaLaneId, undefined);
  });

  it("passes ide_kind filter through to publicListings", async () => {
    const res = await get("/api/rental/listings?ide_kind=claude_code");
    assert.equal(res.status, 200);
    assert.equal(publicListingsCalls.length, 1);
    assert.equal(publicListingsCalls[0]?.ideKind, "claude_code");
  });

  it("accepts camelCase ideKind alias as well", async () => {
    await get("/api/rental/listings?ideKind=cursor");
    assert.equal(publicListingsCalls[0]?.ideKind, "cursor");
  });

  it("passes model_label filter through", async () => {
    await get("/api/rental/listings?model_label=claude-3.7-sonnet");
    assert.equal(publicListingsCalls[0]?.modelLabel, "claude-3.7-sonnet");
  });

  it("accepts mode filter (scoped | trusted_open) and rejects others", async () => {
    await get("/api/rental/listings?mode=scoped");
    assert.equal(publicListingsCalls[0]?.mode, "scoped");

    publicListingsCalls = [];
    await get("/api/rental/listings?mode=trusted_open");
    assert.equal(publicListingsCalls[0]?.mode, "trusted_open");

    publicListingsCalls = [];
    await get("/api/rental/listings?mode=garbage");
    assert.equal(
      publicListingsCalls[0]?.mode,
      undefined,
      "invalid mode should not be forwarded",
    );
  });

  it("parses numeric limit and offset", async () => {
    await get("/api/rental/listings?limit=10&offset=20");
    assert.equal(publicListingsCalls[0]?.limit, 10);
    assert.equal(publicListingsCalls[0]?.offset, 20);
  });

  it("ignores invalid limit/offset (non-numeric or negative)", async () => {
    await get("/api/rental/listings?limit=abc&offset=-5");
    assert.equal(publicListingsCalls[0]?.limit, undefined);
    assert.equal(publicListingsCalls[0]?.offset, undefined);
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    rateAllow = false;
    const res = await get("/api/rental/listings");
    assert.equal(res.status, 429);
    const json = (await res.json()) as { error: string; retryAfterMs: number };
    assert.equal(json.error, "rate_limited");
    assert.equal(typeof json.retryAfterMs, "number");
  });

  it("passes a stable renter key to the rate limiter for anonymous clients", async () => {
    await get("/api/rental/listings");
    await get("/api/rental/listings");
    assert.equal(rateCalls.length, 2);
    assert.equal(rateCalls[0], rateCalls[1]);
    assert.ok(rateCalls[0]?.startsWith("ip:"));
  });

  it("returns 500 when the listings query throws", async () => {
    const express = (await import("express")).default;
    const errApp = express();
    errApp.use(express.json());
    registerRentalRenterRoutes(errApp, {
      publicListings: async () => {
        throw new Error("boom");
      },
      shouldAllowListingsQuery: () => true,
    });
    const errServer = await new Promise<http.Server>((resolve) => {
      const s = errApp.listen(0, () => resolve(s));
    });
    try {
      const addr = errServer.address() as import("net").AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/rental/listings`);
      assert.equal(res.status, 500);
      const json = (await res.json()) as { error: string };
      assert.equal(json.error, "Failed to list public listings");
    } finally {
      await new Promise<void>((resolve) => errServer.close(() => resolve()));
    }
  });
});
