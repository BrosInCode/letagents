import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapApiProviderReadiness,
  mapApiUsageSnapshot,
  toApiDeclareQuotaBody,
} from "../../rental/api-mapper.js";

// ---------------------------------------------------------------------------
// mapApiUsageSnapshot (p2.11a)
// ---------------------------------------------------------------------------

describe("mapApiUsageSnapshot", () => {
  it("round-trips snake_case fields into the desktop snapshot shape", () => {
    const snap = mapApiUsageSnapshot(
      {
        session_id: "rsess_1",
        lrt_limit: 10_000,
        lrt_reserved: 250,
        lrt_used: 2_500,
        lrt_remaining: 7_250,
        budget_stop_threshold: 0.95,
        time_limit_minutes: 60,
        started_at: "2026-05-12T10:00:00.000Z",
        ends_at: "2026-05-12T11:00:00.000Z",
        quota_snapshot: {
          provider: "antigravity",
          native_unit: "percent_window",
          native_remaining: 0.2,
          observed_at: "2026-05-12T10:25:00.000Z",
        },
        updated_at: "2026-05-12T10:30:00.000Z",
      },
      "fallback_id",
    );
    assert.equal(snap.sessionId, "rsess_1");
    assert.equal(snap.lrtLimit, 10_000);
    assert.equal(snap.lrtReserved, 250);
    assert.equal(snap.lrtUsed, 2_500);
    assert.equal(snap.lrtRemaining, 7_250);
    assert.equal(snap.budgetStopThreshold, 0.95);
    assert.equal(snap.timeLimitMinutes, 60);
    assert.equal(snap.startedAt, "2026-05-12T10:00:00.000Z");
    assert.equal(snap.endsAt, "2026-05-12T11:00:00.000Z");
    assert.equal(snap.updatedAt, "2026-05-12T10:30:00.000Z");
    assert.ok(snap.quotaSnapshot);
    assert.equal(snap.quotaSnapshot!.provider, "antigravity");
    assert.equal(snap.quotaSnapshot!.nativeRemaining, 0.2);
  });

  it("falls back to the provided sessionId when the body omits one", () => {
    const snap = mapApiUsageSnapshot({}, "fallback_id");
    assert.equal(snap.sessionId, "fallback_id");
    assert.equal(snap.lrtLimit, null);
    assert.equal(snap.lrtReserved, 0);
    assert.equal(snap.lrtUsed, 0);
    assert.equal(snap.lrtRemaining, null);
    assert.equal(snap.budgetStopThreshold, null);
    assert.equal(snap.timeLimitMinutes, null);
    assert.equal(snap.startedAt, null);
    assert.equal(snap.endsAt, null);
    assert.equal(snap.quotaSnapshot, null);
    assert.equal(snap.updatedAt, null);
  });

  it("accepts non-object input by treating it as an empty body", () => {
    const snap = mapApiUsageSnapshot("oops", "fallback");
    assert.equal(snap.sessionId, "fallback");
    assert.equal(snap.lrtReserved, 0);
    assert.equal(snap.lrtUsed, 0);
  });

  it("accepts camelCase keys as alternates", () => {
    const snap = mapApiUsageSnapshot(
      {
        sessionId: "rsess_2",
        lrtLimit: 5_000,
        lrtUsed: 1_000,
        lrtReserved: 100,
        startedAt: "2026-05-12T09:00:00.000Z",
        endsAt: "2026-05-12T10:00:00.000Z",
        updatedAt: "2026-05-12T09:30:00.000Z",
      },
      "fallback",
    );
    assert.equal(snap.sessionId, "rsess_2");
    assert.equal(snap.lrtLimit, 5_000);
    assert.equal(snap.lrtUsed, 1_000);
    assert.equal(snap.lrtReserved, 100);
    assert.equal(snap.startedAt, "2026-05-12T09:00:00.000Z");
  });

  it("treats a non-object quota_snapshot as null", () => {
    const snap = mapApiUsageSnapshot(
      {
        session_id: "rsess_3",
        quota_snapshot: ["arr", "is", "not", "obj"],
      },
      "fallback",
    );
    assert.equal(snap.quotaSnapshot, null);
  });
});

// ---------------------------------------------------------------------------
// toApiDeclareQuotaBody (p2.12 — renter quota declaration sync)
// ---------------------------------------------------------------------------

describe("toApiDeclareQuotaBody", () => {
  it("builds the canonical body from a populated signal", () => {
    const body = toApiDeclareQuotaBody({
      provider: "cursor",
      model: "claude-3.7-sonnet",
      confidence: "manual",
      observedAt: "2026-05-12T10:00:00.000Z",
      rawSignal: { manual: true, note: "out of quota" },
    });
    assert.ok(body);
    assert.equal(body!.startTrigger, "quota_exhausted");
    assert.equal(body!.triggerConfidence, "manual");
    assert.equal(body!.renterLaneProvider, "cursor");
    assert.equal(body!.renterLaneModel, "claude-3.7-sonnet");
    assert.equal(body!.renterLaneExhaustedAt, "2026-05-12T10:00:00.000Z");
    assert.deepEqual(body!.renterQuotaSignal, {
      manual: true,
      note: "out of quota",
    });
  });

  it("returns null when the signal lacks a provider", () => {
    assert.equal(
      toApiDeclareQuotaBody({
        provider: null,
        model: "claude-3.7-sonnet",
        confidence: "manual",
        observedAt: "2026-05-12T10:00:00.000Z",
        rawSignal: null,
      }),
      null,
    );
  });

  it("returns null on whitespace-only provider", () => {
    assert.equal(
      toApiDeclareQuotaBody({
        provider: "   ",
        model: null,
        confidence: "manual",
        observedAt: null,
        rawSignal: null,
      }),
      null,
    );
  });

  it("omits renterLaneModel when missing or blank", () => {
    const body = toApiDeclareQuotaBody({
      provider: "cursor",
      model: null,
      confidence: "manual",
      observedAt: "2026-05-12T10:00:00.000Z",
      rawSignal: null,
    });
    assert.ok(body);
    assert.equal("renterLaneModel" in body!, false);
  });

  it("falls back to current time when observedAt is null", () => {
    const before = Date.now();
    const body = toApiDeclareQuotaBody({
      provider: "cursor",
      model: "claude-3.7-sonnet",
      confidence: "manual",
      observedAt: null,
      rawSignal: null,
    });
    const after = Date.now();
    assert.ok(body);
    const exhausted = Date.parse(body!.renterLaneExhaustedAt as string);
    assert.ok(exhausted >= before && exhausted <= after);
  });

  it("defaults confidence to manual when null", () => {
    const body = toApiDeclareQuotaBody({
      provider: "cursor",
      model: null,
      confidence: null,
      observedAt: "2026-05-12T10:00:00.000Z",
      rawSignal: null,
    });
    assert.ok(body);
    assert.equal(body!.triggerConfidence, "manual");
  });

  it("trims the provider before sending", () => {
    const body = toApiDeclareQuotaBody({
      provider: "  cursor  ",
      model: null,
      confidence: "manual",
      observedAt: "2026-05-12T10:00:00.000Z",
      rawSignal: null,
    });
    assert.ok(body);
    assert.equal(body!.renterLaneProvider, "cursor");
  });

  it("omits renterQuotaSignal when rawSignal is null or non-object", () => {
    const body = toApiDeclareQuotaBody({
      provider: "cursor",
      model: null,
      confidence: "manual",
      observedAt: "2026-05-12T10:00:00.000Z",
      rawSignal: null,
    });
    assert.ok(body);
    assert.equal("renterQuotaSignal" in body!, false);
  });
});

// ---------------------------------------------------------------------------
// mapApiProviderReadiness (p2.15)
// ---------------------------------------------------------------------------

describe("mapApiProviderReadiness", () => {
  it("round-trips the documented snake_case wire shape", () => {
    const readiness = mapApiProviderReadiness({
      status: "ready",
      summary: "2 listings: 2 active.",
      blockers: [],
      warnings: [],
      badges: ["verified", "fast"],
      checks: [
        {
          id: "listing:a",
          label: "Active Agent",
          status: "passed",
          detail: "Listing is accepting rental requests.",
        },
      ],
      last_checked_at: "2026-05-12T11:00:00.000Z",
    });
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.summary, "2 listings: 2 active.");
    assert.deepEqual(readiness.badges, ["verified", "fast"]);
    assert.equal(readiness.checks.length, 1);
    assert.equal(readiness.checks[0]!.id, "listing:a");
    assert.equal(readiness.checks[0]!.status, "passed");
    assert.equal(readiness.checks[0]!.detail, "Listing is accepting rental requests.");
    assert.equal(readiness.lastCheckedAt, "2026-05-12T11:00:00.000Z");
  });

  it("falls back to a safe unknown shape when given a non-object", () => {
    for (const bad of [null, undefined, "", 0, [], "string"] as unknown[]) {
      const out = mapApiProviderReadiness(bad);
      assert.equal(out.status, "unknown");
      assert.equal(out.summary, null);
      assert.deepEqual(out.blockers, []);
      assert.deepEqual(out.warnings, []);
      assert.deepEqual(out.badges, []);
      assert.deepEqual(out.checks, []);
      assert.equal(out.lastCheckedAt, null);
    }
  });

  it("clamps unknown status strings to 'unknown'", () => {
    const out = mapApiProviderReadiness({
      status: "wat",
      last_checked_at: "2026-05-12T11:00:00.000Z",
    });
    assert.equal(out.status, "unknown");
  });

  it("accepts both snake_case and camelCase last_checked_at", () => {
    const a = mapApiProviderReadiness({
      status: "ready",
      last_checked_at: "2026-05-12T11:00:00.000Z",
    });
    const b = mapApiProviderReadiness({
      status: "ready",
      lastCheckedAt: "2026-05-12T11:00:00.000Z",
    });
    assert.equal(a.lastCheckedAt, "2026-05-12T11:00:00.000Z");
    assert.equal(b.lastCheckedAt, "2026-05-12T11:00:00.000Z");
  });

  it("drops checks with missing id/label and clamps unknown check statuses", () => {
    const out = mapApiProviderReadiness({
      status: "degraded",
      checks: [
        { id: "listing:a", label: "A", status: "passed", detail: null },
        { id: "listing:b", label: "B", status: "wat", detail: "??" },
        { label: "no id", status: "passed" },
        { id: "no label", status: "passed" },
        null,
        "not an object",
      ],
    });
    assert.equal(out.checks.length, 2);
    assert.equal(out.checks[0]!.id, "listing:a");
    assert.equal(out.checks[0]!.status, "passed");
    assert.equal(out.checks[1]!.id, "listing:b");
    assert.equal(out.checks[1]!.status, "unknown");
  });

  it("filters non-string entries from blockers/warnings/badges defensively", () => {
    const out = mapApiProviderReadiness({
      status: "blocked",
      blockers: ["a", 42, null, "b"],
      warnings: ["w"],
      badges: ["verified", "", "fast", false],
    });
    assert.deepEqual(out.blockers, ["a", "b"]);
    assert.deepEqual(out.warnings, ["w"]);
    assert.deepEqual(out.badges, ["verified", "", "fast"]);
  });

  it("treats non-array checks as an empty list rather than throwing", () => {
    const out = mapApiProviderReadiness({
      status: "ready",
      checks: "not-an-array",
    });
    assert.deepEqual(out.checks, []);
  });
});
