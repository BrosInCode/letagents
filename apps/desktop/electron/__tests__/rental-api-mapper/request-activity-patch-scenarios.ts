import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapApiActivityEvent,
  mapApiActivityEventArray,
  mapApiListingArray,
  mapApiPatch,
  mapApiPatchArray,
  mapApiRequest,
  mapApiRequestArray,
} from "../../rental/api-mapper.js";

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
// mapApiPatch
// ---------------------------------------------------------------------------

describe("mapApiPatch", () => {
  it("maps a rental_patch_proposals row into the desktop patch review shape", () => {
    const patch = mapApiPatch({
      id: "rpatch_1",
      session_id: "rsess_1",
      source: "explicit_patch",
      summary: "Fix auth",
      diff_ref: "sha256:abc",
      diff_preview: "diff --git a/src/a.ts b/src/a.ts\n",
      gate_status: "passed_with_warnings",
      risk_score: 3,
      warnings: [{ message: "Sensitive path" }, "Check warning"],
      check_results: {
        warnings: ["Gate warning"],
        review: { pr_url: "https://github.com/BrosInCode/letagents/pull/1" },
        checks: [
          {
            file: "src/a.ts",
            operation: "modify",
            passed: true,
            warnings: ["needs renter approval"],
          },
        ],
      },
      created_at: "2026-05-11T10:00:00.000Z",
      updated_at: "2026-05-11T10:05:00.000Z",
    });
    assert.ok(patch);
    assert.equal(patch!.id, "rpatch_1");
    assert.equal(patch!.sessionId, "rsess_1");
    assert.equal(patch!.gateStatus, "passed_with_warnings");
    assert.equal(patch!.diffPreview, "diff --git a/src/a.ts b/src/a.ts\n");
    assert.equal(patch!.warnings.length, 3);
    assert.equal(patch!.checkResults[0]!.status, "warning");
    assert.equal(patch!.prUrl, "https://github.com/BrosInCode/letagents/pull/1");
  });

  it("accepts approve/request-changes envelopes and clamps malformed values", () => {
    const patch = mapApiPatch({
      patch: {
        id: "rpatch_2",
        sessionId: "rsess_1",
        source: "unknown",
        gateStatus: "bogus",
        checkResults: [
          {
            id: "lint",
            label: "Lint",
            status: "passed",
            completedAt: "2026-05-11T10:05:00.000Z",
          },
        ],
      },
    });
    assert.ok(patch);
    assert.equal(patch!.source, "explicit_patch");
    assert.equal(patch!.gateStatus, "pending");
    assert.equal(patch!.checkResults[0]!.id, "lint");
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

  it("mapApiPatchArray accepts the { patches: [] } envelope", () => {
    const patches = mapApiPatchArray({
      patches: [{ id: "rpatch_1", updated_at: "2026-05-11T10:00:00.000Z" }],
    });
    assert.equal(patches.length, 1);
    assert.equal(patches[0]!.id, "rpatch_1");
  });
});
