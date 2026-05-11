/**
 * Tests for the desktop API mapper (p1.8b).
 *
 * Covers each `mapApi*` function:
 *   - happy path: every documented snake_case key round-trips into the
 *     camelCase `DesktopRental*` shape
 *   - tolerant: missing fields fall back to sensible defaults
 *   - bad input: arrays / strings / numbers return null (or empty array)
 *   - enum coercion: bad enum values clamp to a valid fallback
 *   - alternate keys: both snake_case and camelCase are accepted
 *   - envelope unwrap: `{ listings: [...] }` and bare `[...]`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapApiActivityEvent,
  mapApiActivityEventArray,
  mapApiListing,
  mapApiListingArray,
  mapApiQuotaSnapshot,
  mapApiRequest,
  mapApiRequestArray,
  mapApiSession,
} from "../rental/api-mapper.js";

// ---------------------------------------------------------------------------
// mapApiQuotaSnapshot
// ---------------------------------------------------------------------------

describe("mapApiQuotaSnapshot", () => {
  it("round-trips snake_case fields into the desktop snapshot shape", () => {
    const snap = mapApiQuotaSnapshot({
      id: "snap_1",
      provider: "antigravity",
      model: "gemini-2.5-pro",
      quota_lane_id: "lane-a",
      native_unit: "percent_window",
      native_remaining: 0.42,
      native_limit: 1,
      native_reset_at: "2026-05-11T18:00:00.000Z",
      input_tokens: 100,
      output_tokens: 200,
      confidence: "estimated",
      observed_at: "2026-05-11T10:00:00.000Z",
      source: "antigravity-quota:/path",
    });
    assert.ok(snap);
    assert.equal(snap!.provider, "antigravity");
    assert.equal(snap!.modelLabel, "gemini-2.5-pro");
    assert.equal(snap!.nativeUnit, "percent_window");
    assert.equal(snap!.nativeRemaining, 0.42);
    assert.equal(snap!.nativeLimit, 1);
    assert.equal(snap!.nativeResetAt, "2026-05-11T18:00:00.000Z");
    assert.equal(snap!.confidence, "estimated");
    assert.equal(snap!.source, "antigravity-quota:/path");
  });

  it("falls back to unknown for missing unit / provider / confidence", () => {
    const snap = mapApiQuotaSnapshot({});
    assert.ok(snap);
    assert.equal(snap!.provider, "unknown");
    assert.equal(snap!.nativeUnit, "unknown");
    assert.equal(snap!.confidence, "unknown");
  });

  it("returns null for non-object input", () => {
    assert.equal(mapApiQuotaSnapshot(null), null);
    assert.equal(mapApiQuotaSnapshot("nope"), null);
    assert.equal(mapApiQuotaSnapshot([1, 2, 3]), null);
  });

  it("clamps malformed enum values to safe fallbacks", () => {
    const snap = mapApiQuotaSnapshot({
      native_unit: "rocketfuel",
      confidence: "vibes",
    });
    assert.equal(snap!.nativeUnit, "unknown");
    assert.equal(snap!.confidence, "unknown");
  });
});

// ---------------------------------------------------------------------------
// mapApiListing
// ---------------------------------------------------------------------------

describe("mapApiListing", () => {
  it("maps a server listing row into DesktopRentalListing", () => {
    const listing = mapApiListing({
      id: "listing_1",
      provider_account_id: "acct_1",
      provider_display_name: "kd",
      display_name: "My Antigravity agent",
      status: "active",
      verification_status: "verified",
      readiness_badges: ["calibrated", "exact"],
      ide_kind: "antigravity",
      model_label: "gemini-2.5-pro",
      quota_lane_id: "lane-a",
      meter_confidence: "calibrated",
      native_quota_unit: "percent_window",
      supported_modes: ["scoped", "trusted_open", "bogus"],
      max_concurrent_sessions: 2,
      active_session_count: 1,
      default_lrt_limit: 50_000,
      manual_accept_required: false,
      created_at: "2026-05-11T09:00:00.000Z",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    assert.ok(listing);
    assert.equal(listing!.id, "listing_1");
    assert.equal(listing!.providerAccountId, "acct_1");
    assert.equal(listing!.providerDisplayName, "kd");
    assert.equal(listing!.displayName, "My Antigravity agent");
    assert.equal(listing!.status, "active");
    assert.equal(listing!.verificationStatus, "verified");
    assert.deepEqual(listing!.readinessBadges, ["calibrated", "exact"]);
    assert.equal(listing!.ideKind, "antigravity");
    assert.equal(listing!.modelLabel, "gemini-2.5-pro");
    assert.deepEqual(listing!.supportedModes, ["scoped", "trusted_open"]);
    assert.equal(listing!.maxConcurrentSessions, 2);
    assert.equal(listing!.activeSessionCount, 1);
    assert.equal(listing!.defaultLrtLimit, 50_000);
    assert.equal(listing!.manualAcceptRequired, false);
    assert.equal(listing!.createdAt, "2026-05-11T09:00:00.000Z");
    assert.equal(listing!.updatedAt, "2026-05-11T10:00:00.000Z");
  });

  it("defaults missing fields safely (no throw)", () => {
    const listing = mapApiListing({ id: "listing_x", updated_at: "2026-05-11T10:00:00.000Z" });
    assert.ok(listing);
    assert.equal(listing!.displayName, "Rental listing");
    assert.equal(listing!.status, "setup_required");
    assert.equal(listing!.verificationStatus, "experimental");
    assert.equal(listing!.ideKind, "unknown");
    assert.equal(listing!.maxConcurrentSessions, 1);
    assert.equal(listing!.activeSessionCount, 0);
    assert.equal(listing!.manualAcceptRequired, true);
    assert.deepEqual(listing!.supportedModes, []);
    assert.equal(listing!.lastNativeQuotaSnapshot, null);
  });

  it("returns null when there's no id (server row malformed)", () => {
    assert.equal(mapApiListing({}), null);
    assert.equal(mapApiListing(null), null);
    assert.equal(mapApiListing("string"), null);
  });

  it("accepts both snake_case and camelCase keys", () => {
    const listing = mapApiListing({
      id: "listing_1",
      displayName: "Camel",
      ideKind: "claude_code",
      defaultLrtLimit: 1000,
      updatedAt: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(listing!.displayName, "Camel");
    assert.equal(listing!.ideKind, "claude_code");
    assert.equal(listing!.defaultLrtLimit, 1000);
  });
});

// ---------------------------------------------------------------------------
// mapApiSession
// ---------------------------------------------------------------------------

describe("mapApiSession", () => {
  it("maps a server session row including D3 trigger context + quota lease", () => {
    const session = mapApiSession({
      id: "rsess_1",
      listing_id: "listing_1",
      renter_account_id: "acct_renter",
      provider_account_id: "acct_provider",
      room_id: "room_1",
      repo_provider: "github",
      repo_owner: "BrosInCode",
      repo_name: "letagents",
      base_branch: "main",
      task_title: "Fix auth",
      task_prompt: "Refresh fails on stale token",
      mode: "scoped",
      continuity_mode: "smart_handoff",
      status: "accepted",
      approved_scope: { include_paths: ["src/auth/**"], protected_paths: [".env"] },
      policy: { max_lrt: 50_000, require_patch_gate: true },
      quota_lease: {
        sessionId: "rsess_1",
        lane: { provider: "antigravity", quota_lane_id: "lane-a" },
        lockedAt: "2026-05-11T10:00:00.000Z",
        last_refreshed_at: "2026-05-11T10:05:00.000Z",
        lrt_limit: 50_000,
        lrt_reserved: 1_200,
        lrt_used: 4_000,
      },
      meter_confidence: "estimated",
      lrt_limit: 50_000,
      lrt_reserved: 1_200,
      lrt_used: 4_000,
      lrt_remaining: 44_800,
      start_trigger: "quota_exhausted",
      trigger_confidence: "exact",
      renter_lane_provider: "antigravity",
      renter_lane_model: "gemini-2.5-pro",
      renter_lane_exhausted_at: "2026-05-11T09:55:00.000Z",
      renter_quota_signal: { tokens_remaining: 0 },
      continuity_pack: { packId: "cpack_abc123" },
      updated_at: "2026-05-11T10:05:00.000Z",
    });
    assert.ok(session);
    assert.equal(session!.id, "rsess_1");
    assert.equal(session!.listingId, "listing_1");
    assert.equal(session!.roomIdentifier, "room_1");
    assert.equal(session!.status, "accepted");
    assert.equal(session!.mode, "scoped");
    assert.deepEqual(session!.approvedScope.includePaths, ["src/auth/**"]);
    assert.deepEqual(session!.approvedScope.protectedPaths, [".env"]);
    assert.equal(session!.policy.maxLrt, 50_000);
    assert.equal(session!.policy.requirePatchGate, true);
    assert.equal(session!.quotaLease?.lrtLimit, 50_000);
    assert.equal(session!.quotaLease?.laneId, "lane-a");
    assert.equal(session!.quotaLease?.updatedAt, "2026-05-11T10:05:00.000Z");
    assert.equal(session!.startTrigger, "quota_exhausted");
    assert.equal(session!.triggerConfidence, "exact");
    assert.equal(session!.renterLaneProvider, "antigravity");
    assert.equal(session!.renterLaneExhaustedAt, "2026-05-11T09:55:00.000Z");
    assert.deepEqual(session!.renterQuotaSignal, { tokens_remaining: 0 });
    assert.equal(session!.continuityPackId, "cpack_abc123");
  });

  it("defaults missing scope/policy/continuity to safe shapes", () => {
    const session = mapApiSession({
      id: "rsess_1",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    assert.ok(session);
    assert.deepEqual(session!.approvedScope, {
      includePaths: [],
      excludePaths: [],
      protectedPaths: [],
      notes: null,
    });
    assert.equal(session!.policy.requirePatchGate, true);
    assert.equal(session!.policy.allowCommands, false);
    assert.equal(session!.continuityMode, "smart_handoff");
    assert.equal(session!.continuityIngestDepth, "tier_1");
    assert.equal(session!.startTrigger, null);
    assert.equal(session!.triggerConfidence, null);
    assert.equal(session!.quotaLease, null);
  });

  it("clamps malformed enums to a safe fallback", () => {
    const session = mapApiSession({
      id: "rsess_1",
      status: "rocketship",
      mode: "yolo",
      start_trigger: "bad",
      trigger_confidence: "bad",
      meter_confidence: "very-confident",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(session!.status, "requested");
    assert.equal(session!.mode, "scoped");
    assert.equal(session!.startTrigger, null);
    assert.equal(session!.triggerConfidence, null);
    assert.equal(session!.meterConfidence, "unknown");
  });
});

// ---------------------------------------------------------------------------
// mapApiRequest
// ---------------------------------------------------------------------------

describe("mapApiRequest", () => {
  it("maps the rental_sessions row server-side into the desktop request shape", () => {
    const req = mapApiRequest({
      id: "rsess_1",
      listing_id: "listing_1",
      status: "requested",
      task_title: "Fix auth",
      task_prompt: "...",
      mode: "scoped",
      continuity_mode: "smart_handoff",
      lrt_limit: 50_000,
      time_limit_minutes: 60,
      created_at: "2026-05-11T09:00:00.000Z",
      updated_at: "2026-05-11T09:30:00.000Z",
    });
    assert.ok(req);
    assert.equal(req!.sessionId, "rsess_1");
    assert.equal(req!.listingId, "listing_1");
    assert.equal(req!.status, "pending");
    assert.equal(req!.requestedLrtLimit, 50_000);
    assert.equal(req!.requestedTimeLimitMinutes, 60);
  });

  it("translates the 'requested' status to 'pending' for the desktop ledger", () => {
    const req = mapApiRequest({ id: "rsess_2", status: "requested", updated_at: "2026-05-11T10:00:00.000Z" });
    assert.equal(req!.status, "pending");
  });
});

// ---------------------------------------------------------------------------
// mapApiActivityEvent
// ---------------------------------------------------------------------------

describe("mapApiActivityEvent", () => {
  it("maps a rental_activity_events row", () => {
    const ev = mapApiActivityEvent({
      id: "rev_1",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "session.accepted",
      source: "provider",
      verified: true,
      visibility: "rental_visible",
      payload: { provider_account_id: "acct_provider" },
      created_at: "2026-05-11T10:00:00.000Z",
    });
    assert.ok(ev);
    assert.equal(ev!.sessionId, "rsess_1");
    assert.equal(ev!.eventType, "session.accepted");
    assert.equal(ev!.source, "provider");
    assert.equal(ev!.verified, true);
    assert.equal(ev!.visibility, "rental_visible");
    assert.deepEqual(ev!.payload, { provider_account_id: "acct_provider" });
  });

  it("defaults bad source/visibility/payload to safe values", () => {
    const ev = mapApiActivityEvent({
      id: "rev_1",
      session_id: "rsess_1",
      event_type: "foo.bar",
      source: "bogus",
      visibility: "bogus",
      payload: "not-an-object",
      created_at: "2026-05-11T10:00:00.000Z",
    });
    assert.equal(ev!.source, "system");
    assert.equal(ev!.visibility, "rental_visible");
    assert.deepEqual(ev!.payload, {});
  });
});

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

describe("array unwrap helpers", () => {
  it("mapApiListingArray accepts both bare arrays and { listings: [] } envelopes", () => {
    const bare = mapApiListingArray([{ id: "listing_1", updated_at: "x" }]);
    assert.equal(bare.length, 1);
    const envelope = mapApiListingArray({
      listings: [{ id: "listing_2", updated_at: "x" }],
    });
    assert.equal(envelope.length, 1);
    assert.equal(envelope[0]!.id, "listing_2");
    assert.deepEqual(mapApiListingArray(null), []);
    assert.deepEqual(mapApiListingArray("string"), []);
  });

  it("mapApiRequestArray accepts both shapes + filters malformed rows", () => {
    const arr = mapApiRequestArray({
      requests: [
        { id: "rsess_1", updated_at: "x" },
        null,
        { task_title: "no id" }, // bad: no id
        { id: "rsess_2", updated_at: "x" },
      ],
    });
    assert.equal(arr.length, 2);
  });

  it("mapApiActivityEventArray supports the `activity` and `events` envelope keys", () => {
    const a = mapApiActivityEventArray({ events: [{ id: "rev_1", created_at: "x" }] });
    assert.equal(a.length, 1);
    const b = mapApiActivityEventArray({ activity: [{ id: "rev_2", created_at: "x" }] });
    assert.equal(b.length, 1);
  });
});
