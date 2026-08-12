import assert from "node:assert/strict";
import test from "node:test";

import { CodexTurnProgressTracker } from "../main/agents/codex-turn-progress.js";

function observe(
  tracker: CodexTurnProgressTracker,
  source: string,
  fingerprint: string,
  observedAt: number,
): boolean {
  return tracker.observeProgress({ source, fingerprint, observedAt });
}

test("continuous Codex tool activity extends the inactivity deadline", () => {
  const tracker = new CodexTurnProgressTracker({
    startedAt: 0,
    inactivityTimeoutMs: 100,
    absoluteTimeoutMs: 1_000,
    waitingAfterMs: 20,
  });

  assert.equal(observe(tracker, "tool", "started", 80), true);
  assert.equal(tracker.timeoutReason(100), null);
  assert.equal(observe(tracker, "tool", "output-1", 160), true);
  assert.equal(observe(tracker, "tool", "output-2", 240), true);
  assert.equal(tracker.timeoutReason(300), null);
  assert.equal(tracker.lastProgressTimestamp(), 240);
});

test("a hung Codex turn with no new events still hits the inactivity timeout", () => {
  const tracker = new CodexTurnProgressTracker({
    startedAt: 0,
    inactivityTimeoutMs: 100,
    absoluteTimeoutMs: 1_000,
  });

  assert.equal(observe(tracker, "snapshot", "same-turn", 10), true);
  assert.equal(observe(tracker, "snapshot", "same-turn", 90), false);
  assert.equal(tracker.timeoutReason(109), null);
  assert.equal(tracker.timeoutReason(110), "inactivity");
});

test("an explicit external wait pauses inactivity but not the absolute ceiling", () => {
  const tracker = new CodexTurnProgressTracker({
    startedAt: 0,
    inactivityTimeoutMs: 100,
    absoluteTimeoutMs: 500,
  });

  tracker.beginExplicitWait("tool:ci", {
    source: "notification:item/started",
    fingerprint: "ci-started",
    observedAt: 50,
  });
  assert.equal(tracker.activityState(200), "waiting");
  assert.equal(tracker.timeoutReason(499), null);
  assert.equal(tracker.timeoutReason(500), "absolute");
});

test("completing an explicit wait restores the inactivity deadline", () => {
  const tracker = new CodexTurnProgressTracker({
    startedAt: 0,
    inactivityTimeoutMs: 100,
    absoluteTimeoutMs: 1_000,
  });

  tracker.beginExplicitWait("tool:ci", {
    source: "notification:item/started",
    fingerprint: "ci-started",
    observedAt: 20,
  });
  tracker.endExplicitWait("tool:ci", {
    source: "notification:item/completed",
    fingerprint: "ci-completed",
    observedAt: 200,
  });
  assert.equal(tracker.hasExplicitWait(), false);
  assert.equal(tracker.timeoutReason(299), null);
  assert.equal(tracker.timeoutReason(300), "inactivity");
});
