/**
 * Tests for the D1 renter trigger classifier (p2.6 desktop slice).
 *
 * Covers:
 *   - structured_event → exact
 *   - percent_window_exhausted (claude-code-style snapshot lookalike +
 *     antigravity percent_window=0) → exact
 *   - consecutive failures → inferred
 *   - rolling window eviction
 *   - manual declare → manual
 *   - graceful no-trigger when nothing fired
 *   - reset() clears state
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import type { AdapterNativeQuotaSnapshot } from "../rental/adapter-types.js";
import {
  RENTER_TRIGGER_REASONS,
  RenterTriggerClassifier,
} from "../rental/trigger-classifier.js";

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<AdapterNativeQuotaSnapshot> = {},
): AdapterNativeQuotaSnapshot {
  return {
    provider: "antigravity",
    model: "gemini-2.5-pro",
    sourceId: "fixture",
    nativeUnit: "percent_window",
    nativeRemaining: 0.42,
    nativeTotal: 1,
    nativeResetAt: "2026-05-11T18:00:00.000Z",
    confidence: "estimated",
    observedAt: "2026-05-11T10:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structured event → exact
// ---------------------------------------------------------------------------

describe("RenterTriggerClassifier — structured event", () => {
  it("classifies raw.exhausted === true as exact", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({
        raw: { exhausted: true, source: "antigravity-quota.json" },
      }),
    );
    assert.equal(result.triggered, true);
    assert.equal(result.confidence, "exact");
    assert.equal(result.reason, RENTER_TRIGGER_REASONS.STRUCTURED_EVENT);
    assert.equal(result.provider, "antigravity");
    assert.equal(result.model, "gemini-2.5-pro");
    assert.equal(result.laneResetAt, "2026-05-11T18:00:00.000Z");
  });

  it("classifies raw.quota_event === 'exhausted' as exact", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({ raw: { quota_event: "exhausted" } }),
    );
    assert.equal(result.confidence, "exact");
  });

  it("classifies raw.exhausted_event === true as exact", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({ raw: { exhausted_event: true } }),
    );
    assert.equal(result.confidence, "exact");
  });
});

// ---------------------------------------------------------------------------
// percent_window → exact (Antigravity fixture lookalike)
// ---------------------------------------------------------------------------

describe("RenterTriggerClassifier — percent_window exhausted", () => {
  it("treats percent_remaining=0 with a reset_at as exact", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({
        nativeUnit: "percent_window",
        nativeRemaining: 0,
        nativeResetAt: "2026-05-11T20:30:00.000Z",
      }),
    );
    assert.equal(result.triggered, true);
    assert.equal(result.confidence, "exact");
    assert.equal(
      result.reason,
      RENTER_TRIGGER_REASONS.PERCENT_WINDOW_EXHAUSTED,
    );
    assert.equal(result.laneResetAt, "2026-05-11T20:30:00.000Z");
  });

  it("does NOT promote percent_remaining=0 to exact when reset_at is null", () => {
    // Without a reset timestamp we cannot tell a transient race
    // condition from real lane exhaustion. The renter also has no
    // actionable ETA. These belong on the failure-burst path
    // (inferred) instead — the classifier returns no_trigger here
    // and a downstream observer can downgrade to a failure pulse.
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({
        nativeUnit: "percent_window",
        nativeRemaining: 0,
        nativeResetAt: null,
      }),
    );
    assert.equal(result.triggered, false);
    assert.equal(result.reason, RENTER_TRIGGER_REASONS.NO_TRIGGER);
  });

  it("does not fire for a healthy percent_remaining=0.42 lane", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(makeSnapshot({ nativeRemaining: 0.42 }));
    assert.equal(result.triggered, false);
    assert.equal(result.reason, RENTER_TRIGGER_REASONS.NO_TRIGGER);
  });
});

// ---------------------------------------------------------------------------
// Token-based adapter (Claude Code-like) — no implicit exhaustion
// ---------------------------------------------------------------------------

describe("RenterTriggerClassifier — token-based snapshot", () => {
  it("does not fire for a claude-code-style snapshot with no structured exhaustion flag", () => {
    // Claude Code adapter exposes nativeUnit=tokens with
    // nativeRemaining=null because the local JSONL only records
    // consumption. The classifier should NOT promote it to exact
    // (we'd need a structured `raw.exhausted` flag).
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({
        provider: "claude_code",
        model: "claude-3.7-sonnet",
        nativeUnit: "tokens",
        nativeRemaining: null,
        nativeTotal: null,
        nativeResetAt: null,
        confidence: "local_exact",
        raw: { turnCount: 4 },
      }),
    );
    assert.equal(result.triggered, false);
    assert.equal(result.reason, RENTER_TRIGGER_REASONS.NO_TRIGGER);
  });

  it("does fire for a token-based snapshot when raw.exhausted=true", () => {
    const c = new RenterTriggerClassifier();
    const result = c.classifySnapshot(
      makeSnapshot({
        provider: "claude_code",
        nativeUnit: "tokens",
        nativeRemaining: null,
        raw: { exhausted: true, reason: "weekly_cap_hit" },
      }),
    );
    assert.equal(result.confidence, "exact");
  });
});

// ---------------------------------------------------------------------------
// Consecutive failures → inferred
// ---------------------------------------------------------------------------

describe("RenterTriggerClassifier — consecutive failures (per-lane)", () => {
  it("requires N failures inside the rolling window to escalate to inferred", () => {
    const c = new RenterTriggerClassifier({
      inferredFailureCount: 3,
      inferredWindowMs: 60_000,
    });
    const nowMs = Date.parse("2026-05-11T10:00:00.000Z");

    // First failure — not enough yet.
    let s = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:00.000Z",
      },
      nowMs,
    );
    assert.equal(s.triggered, false);

    // Second failure — still not enough.
    s = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:10.000Z",
      },
      nowMs + 10_000,
    );
    assert.equal(s.triggered, false);

    // Third failure — escalates.
    s = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:20.000Z",
      },
      nowMs + 20_000,
    );
    assert.equal(s.triggered, true);
    assert.equal(s.confidence, "inferred");
    assert.equal(s.reason, RENTER_TRIGGER_REASONS.CONSECUTIVE_FAILURES);
    const raw = s.rawSignal as { count: number; recent: unknown[]; provider: string; model: string };
    assert.equal(raw.count, 3);
    assert.equal(raw.recent.length, 3);
    assert.equal(raw.provider, "antigravity");
    assert.equal(raw.model, "gemini-2.5-pro");
  });

  it("does NOT escalate when failures are spread across different providers", () => {
    // The bug LivelyPeak caught: a global counter would have
    // promoted 3 mixed failures to inferred for the latest lane.
    // Per-lane counting prevents that.
    const c = new RenterTriggerClassifier({ inferredFailureCount: 3 });
    const nowMs = Date.parse("2026-05-11T10:00:00.000Z");
    c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:00.000Z",
      },
      nowMs,
    );
    c.observe(
      {
        kind: "quota_failure",
        provider: "claude_code",
        model: "claude-3.7-sonnet",
        occurredAt: "2026-05-11T10:00:05.000Z",
      },
      nowMs + 5_000,
    );
    const final = c.observe(
      {
        kind: "quota_failure",
        provider: "cursor",
        model: null,
        occurredAt: "2026-05-11T10:00:10.000Z",
      },
      nowMs + 10_000,
    );
    assert.equal(final.triggered, false);
    // The cursor lane only has 1 failure; classification returns
    // no_trigger but still reports the lane it tried to classify.
    assert.equal(final.provider, "cursor");
  });

  it("does NOT escalate when failures are on the same provider but different models", () => {
    const c = new RenterTriggerClassifier({ inferredFailureCount: 3 });
    const nowMs = Date.parse("2026-05-11T10:00:00.000Z");
    c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:00.000Z",
      },
      nowMs,
    );
    c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-flash",
        occurredAt: "2026-05-11T10:00:05.000Z",
      },
      nowMs + 5_000,
    );
    const third = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: "2026-05-11T10:00:10.000Z",
      },
      nowMs + 10_000,
    );
    // gemini-2.5-pro lane only has 2 failures, threshold is 3.
    assert.equal(third.triggered, false);
    assert.equal(c.failureCount(nowMs + 10_000, "antigravity", "gemini-2.5-pro"), 2);
    assert.equal(c.failureCount(nowMs + 10_000, "antigravity", "gemini-2.5-flash"), 1);
  });

  it("clears the lane's failure buffer when a healthy snapshot arrives", () => {
    // A burst of failures followed by a healthy reading should NOT
    // be classified as inferred — the lane has recovered, so the
    // accumulated failures are stale signal.
    const c = new RenterTriggerClassifier({ inferredFailureCount: 3 });
    const nowMs = Date.parse("2026-05-11T10:00:00.000Z");
    for (let i = 0; i < 2; i++) {
      c.observe(
        {
          kind: "quota_failure",
          provider: "antigravity",
          model: "gemini-2.5-pro",
          occurredAt: new Date(nowMs + i * 1000).toISOString(),
        },
        nowMs + i * 1000,
      );
    }
    assert.equal(c.failureCount(nowMs + 2000, "antigravity", "gemini-2.5-pro"), 2);

    // Healthy snapshot for the same lane.
    c.observe(
      {
        kind: "snapshot",
        snapshot: makeSnapshot({
          provider: "antigravity",
          model: "gemini-2.5-pro",
          nativeRemaining: 0.8,
        }),
      },
      nowMs + 3000,
    );
    assert.equal(c.failureCount(nowMs + 3000, "antigravity", "gemini-2.5-pro"), 0);

    // A third failure now should NOT trigger inferred — the lane's
    // buffer was reset by the healthy snapshot, so we're back to 1.
    const after = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: "gemini-2.5-pro",
        occurredAt: new Date(nowMs + 4000).toISOString(),
      },
      nowMs + 4000,
    );
    assert.equal(after.triggered, false);
  });

  it("evicts failures older than the rolling window", () => {
    const c = new RenterTriggerClassifier({
      inferredFailureCount: 3,
      inferredWindowMs: 60_000,
    });
    const start = Date.parse("2026-05-11T10:00:00.000Z");

    // Two old failures far outside the window.
    c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: null,
        occurredAt: "2026-05-11T09:50:00.000Z",
      },
      start,
    );
    c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: null,
        occurredAt: "2026-05-11T09:50:30.000Z",
      },
      start,
    );

    // Advance time well past the window — old failures get evicted
    // before classification. New failures only.
    const future = Date.parse("2026-05-11T10:30:00.000Z");
    const s = c.observe(
      {
        kind: "quota_failure",
        provider: "antigravity",
        model: null,
        occurredAt: "2026-05-11T10:30:00.000Z",
      },
      future,
    );
    assert.equal(s.triggered, false);
    assert.equal(c.failureCount(future, "antigravity", null), 1);
  });
});

// ---------------------------------------------------------------------------
// Manual declare
// ---------------------------------------------------------------------------

describe("RenterTriggerClassifier — manual declare", () => {
  it("always returns manual confidence", () => {
    const c = new RenterTriggerClassifier();
    const result = c.declareManual({
      provider: "antigravity",
      model: "gemini-2.5-pro",
      note: "I'm cooked",
    });
    assert.equal(result.triggered, true);
    assert.equal(result.confidence, "manual");
    assert.equal(result.reason, RENTER_TRIGGER_REASONS.USER_DECLARED);
    assert.equal(result.provider, "antigravity");
    const raw = result.rawSignal as { note: string };
    assert.equal(raw.note, "I'm cooked");
  });

  it("falls back to nulls when no provider/model context is provided", () => {
    const c = new RenterTriggerClassifier();
    const result = c.declareManual();
    assert.equal(result.confidence, "manual");
    assert.equal(result.provider, null);
    assert.equal(result.model, null);
  });
});

// ---------------------------------------------------------------------------
// reset() clears buffer
// ---------------------------------------------------------------------------

test("reset() clears all lane failure buffers", () => {
  const c = new RenterTriggerClassifier({ inferredFailureCount: 2 });
  const now = Date.parse("2026-05-11T10:00:00.000Z");
  c.observe(
    {
      kind: "quota_failure",
      provider: "antigravity",
      model: null,
      occurredAt: "2026-05-11T10:00:00.000Z",
    },
    now,
  );
  c.observe(
    {
      kind: "quota_failure",
      provider: "cursor",
      model: null,
      occurredAt: "2026-05-11T10:00:00.000Z",
    },
    now,
  );
  assert.equal(c.failureCount(now), 2);
  c.reset();
  assert.equal(c.failureCount(now), 0);
  assert.equal(c.failureCount(now, "antigravity", null), 0);
  assert.equal(c.failureCount(now, "cursor", null), 0);
});
