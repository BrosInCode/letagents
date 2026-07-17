import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLaunchFailure,
  emitLaunchEvent,
  getLaunchEvents,
  LaunchBlockedError,
  onLaunchEvent,
  resetLaunchEventsForTest,
} from "../main/launch-events.js";

test.beforeEach(() => resetLaunchEventsForTest());

test("assigns a monotonically increasing per-launch sequence", () => {
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "supervisor.connected" });
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "agent.saved" });
  const events = getLaunchEvents("a");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.type), ["launch.requested", "supervisor.connected", "agent.saved"]);
});

test("sequences are independent per launch", () => {
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  emitLaunchEvent({ launchId: "b", roomIdentifier: "r", provider: "claude-code", type: "launch.requested" });
  assert.equal(getLaunchEvents("a")[0]!.sequence, 1);
  assert.equal(getLaunchEvents("b")[0]!.sequence, 1);
});

test("getLaunchEvents replays only after the cursor (at-least-once catch-up)", () => {
  for (const type of ["launch.requested", "supervisor.connected", "agent.saved", "launch.activated"] as const) {
    emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type });
  }
  assert.deepEqual(getLaunchEvents("a", 2).map((event) => event.sequence), [3, 4]);
  assert.deepEqual(getLaunchEvents("a", 4).map((event) => event.sequence), []);
  // A negative / non-finite cursor replays everything.
  assert.equal(getLaunchEvents("a", Number.NaN).length, 4);
});

test("unknown launches replay nothing (e.g. after an app restart)", () => {
  assert.deepEqual(getLaunchEvents("does-not-exist"), []);
});

test("onLaunchEvent receives live facts and can unsubscribe", () => {
  const received: string[] = [];
  const off = onLaunchEvent((event) => received.push(event.type));
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  off();
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "supervisor.connected" });
  assert.deepEqual(received, ["launch.requested"]);
});

test("carries entryId, recovery, and durable flags through", () => {
  const event = emitLaunchEvent({
    launchId: "a",
    roomIdentifier: "r",
    provider: "codex",
    type: "agent.saved",
    entryId: "supervised_a",
    durable: true,
  });
  assert.equal(event.entryId, "supervised_a");
  assert.equal(event.durable, true);
  assert.equal(event.recovery, null);
});

test("each launch buffer is bounded", () => {
  for (let index = 0; index < 200; index += 1) {
    emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "supervisor.connected" });
  }
  const events = getLaunchEvents("a");
  assert.ok(events.length <= 64, `expected bounded buffer, got ${events.length}`);
  // The retained window keeps the newest facts with the highest sequences.
  assert.equal(events.at(-1)!.sequence, 200);
});

test("tracked launches are bounded and evict the oldest first", () => {
  for (let index = 0; index < 200; index += 1) {
    emitLaunchEvent({ launchId: `launch-${index}`, roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  }
  // The very first launches must have been evicted; a recent one is retained.
  assert.deepEqual(getLaunchEvents("launch-0"), []);
  assert.equal(getLaunchEvents("launch-199").length, 1);
});

test("classifyLaunchFailure maps blocked errors to a product recovery", () => {
  const blocked = classifyLaunchFailure(new LaunchBlockedError("Choose a cloud room.", "choose_project"));
  assert.equal(blocked.type, "launch.blocked");
  assert.equal(blocked.recovery, "choose_project");
  assert.equal(blocked.detail, "Choose a cloud room.");
});

test("classifyLaunchFailure maps unexpected errors to a safe generic failure", () => {
  const failure = classifyLaunchFailure(new Error("EACCES: /Users/secret/path exploded"));
  assert.equal(failure.type, "launch.failed");
  assert.equal(failure.recovery, "retry");
  assert.doesNotMatch(failure.detail, /secret|EACCES/);
});
