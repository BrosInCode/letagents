import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomStreamEvent } from "../ipc-types.js";
import type { AdapterNativeQuotaSnapshot } from "../rental/adapter-types.js";
import { RenterTriggerRuntime } from "../rental/renter-trigger.js";

function snapshot(
  overrides: Partial<AdapterNativeQuotaSnapshot> = {},
): AdapterNativeQuotaSnapshot {
  return {
    provider: "antigravity",
    model: "gemini-2.5-pro",
    sourceId: "lane_1",
    nativeUnit: "percent_window",
    nativeRemaining: 0.75,
    nativeTotal: 1,
    nativeResetAt: "2026-05-11T18:00:00.000Z",
    confidence: "estimated",
    observedAt: "2026-05-11T10:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

function runtime(nowIso = "2026-05-11T10:00:00.000Z") {
  const events: DesktopRoomStreamEvent[] = [];
  return {
    events,
    runtime: new RenterTriggerRuntime({
      now: () => new Date(nowIso),
      getRoomIdentifier: () => "room_1",
      emitRoomStreamEvent: (event) => events.push(event),
    }),
  };
}

test("runtime emits one rental_quota_exhausted event for exact adapter snapshots", () => {
  const harness = runtime();
  const signal = harness.runtime.observeSnapshot(
    snapshot({
      nativeRemaining: 0,
      nativeResetAt: "2026-05-11T11:00:00.000Z",
    }),
  );
  assert.equal(signal.triggered, true);
  assert.equal(signal.confidence, "exact");
  assert.equal(harness.events.length, 1);
  const event = harness.events[0]!;
  assert.equal(event.type, "rental_quota_exhausted");
  assert.equal(event.roomIdentifier, "room_1");
  if (event.type === "rental_quota_exhausted") {
    assert.equal(event.signal.reason, "percent_window_exhausted");
    assert.equal(event.status.lastSnapshot?.nativeRemaining, 0);
  }

  harness.runtime.observeSnapshot(
    snapshot({
      nativeRemaining: 0,
      nativeResetAt: "2026-05-11T11:00:00.000Z",
    }),
  );
  assert.equal(harness.events.length, 1, "same exhausted lane should not spam events");
});

test("affirmatively healthy snapshot re-arms quota exhausted event emission", () => {
  const harness = runtime();
  harness.runtime.observeSnapshot(snapshot({ nativeRemaining: 0, nativeResetAt: "2026-05-11T11:00:00.000Z" }));
  assert.equal(harness.events.length, 1);

  harness.runtime.observeSnapshot(snapshot({ nativeRemaining: 0.8 }));
  assert.equal(harness.runtime.getOwnQuotaStatus().triggered, false);

  harness.runtime.observeSnapshot(snapshot({ nativeRemaining: 0, nativeResetAt: "2026-05-11T12:00:00.000Z" }));
  assert.equal(harness.events.length, 2);
});

test("inconclusive snapshots do not clear an active quota trigger", () => {
  const harness = runtime();
  harness.runtime.observeSnapshot(snapshot({ nativeRemaining: 0, nativeResetAt: "2026-05-11T11:00:00.000Z" }));
  assert.equal(harness.runtime.getOwnQuotaStatus().triggered, true);

  harness.runtime.observeSnapshot(snapshot({ nativeRemaining: 0, nativeResetAt: null }));
  const status = harness.runtime.getOwnQuotaStatus();
  assert.equal(status.triggered, true);
  assert.equal(status.lastSignal?.reason, "percent_window_exhausted");
  assert.equal(harness.events.length, 1);
});

test("quota failures escalate to inferred and emit once per exhausted lane", () => {
  const harness = runtime();
  for (let i = 0; i < 2; i++) {
    const signal = harness.runtime.recordQuotaFailure({
      provider: "claude_code",
      model: "sonnet",
      occurredAt: new Date(Date.parse("2026-05-11T10:00:00.000Z") + i * 1000).toISOString(),
    });
    assert.equal(signal.triggered, false);
  }

  const signal = harness.runtime.recordQuotaFailure({
    provider: "claude_code",
    model: "sonnet",
    occurredAt: "2026-05-11T10:00:02.000Z",
  });
  assert.equal(signal.triggered, true);
  assert.equal(signal.confidence, "inferred");
  assert.equal(harness.events.length, 1);
  assert.equal(harness.runtime.getOwnQuotaStatus().failureCount, 3);

  harness.runtime.recordQuotaFailure({
    provider: "claude_code",
    model: "sonnet",
    occurredAt: "2026-05-11T10:00:03.000Z",
  });
  assert.equal(harness.events.length, 1, "active lane should remain deduped");
});

test("manual declaration emits manual trigger and updates status", () => {
  const harness = runtime();
  const signal = harness.runtime.declareManual({
    provider: "codex",
    model: "gpt-5.2",
    note: "quota modal",
  });
  assert.equal(signal.triggered, true);
  assert.equal(signal.confidence, "manual");
  assert.equal(signal.provider, "codex");
  assert.equal(harness.events.length, 1);
  const status = harness.runtime.getOwnQuotaStatus();
  assert.equal(status.triggered, true);
  assert.equal(status.provider, "codex");
  assert.equal(status.lastSignal?.reason, "user_declared");
});

test("observeAdapterTick ignores empty snapshot results", () => {
  const harness = runtime();
  const signal = harness.runtime.observeAdapterTick({
    source: { id: "s1", label: "S1", kind: "json", pathHint: null, lastSeenAt: null },
    snapshot: null,
    reported: null,
    error: null,
  });
  assert.equal(signal, null);
  assert.equal(harness.events.length, 0);
});
