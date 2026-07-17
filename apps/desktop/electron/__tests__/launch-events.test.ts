import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLaunchFailure,
  emitLaunchEvent,
  followDurableLaunchEvents,
  getLaunchEvents,
  LaunchBlockedError,
  onLaunchEvent,
  reconcileLaunchEvents,
  resetLaunchEventsForTest,
  supervisedLaunchEverReady,
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

test("durable replay reconciles the local allocator before a same-id retry", () => {
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  reconcileLaunchEvents([
    {
      launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
      sequence: 1, type: "launch.requested", at: "2026-07-17T00:00:00.000Z", detail: null, recovery: null, durable: false,
    },
    {
      launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
      sequence: 9, type: "agent.ready", at: "2026-07-17T00:00:09.000Z", detail: null, recovery: null, durable: true,
    },
  ]);
  const retry = emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  assert.equal(retry.sequence, 10);
});

test("daemon journal subscription streams durable suffixes without manifest polling", async () => {
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  const cursors: number[] = [];
  const suffixes = [
    [{
      launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
      sequence: 2, type: "supervisor.connected" as const, at: "2026-07-17T00:00:02.000Z", detail: null, recovery: null, durable: true,
    }],
    [{
      launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
      sequence: 3, type: "agent.ready" as const, at: "2026-07-17T00:00:03.000Z", detail: null, recovery: null, durable: true,
    }],
  ];
  await followDurableLaunchEvents(
    "a",
    async (cursor) => {
      cursors.push(cursor);
      return suffixes.shift() ?? [];
    },
    async () => assert.fail("a healthy subscription must not back off"),
  );
  assert.deepEqual(cursors, [1, 2]);
  assert.deepEqual(getLaunchEvents("a").map((event) => [event.sequence, event.type, event.durable]), [
    [1, "launch.requested", false],
    [2, "supervisor.connected", true],
    [3, "agent.ready", true],
  ]);
});

test("daemon journal subscription ignores an old terminal when a newer same-id retry is active", async () => {
  emitLaunchEvent({ launchId: "a", roomIdentifier: "r", provider: "codex", type: "launch.requested" });
  const cursors: number[] = [];
  const suffixes = [
    [
      {
        launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
        sequence: 2, type: "launch.failed" as const, at: "2026-07-17T00:00:02.000Z",
        detail: "Try again.", recovery: "retry" as const, durable: true,
      },
      {
        launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
        sequence: 3, type: "launch.requested" as const, at: "2026-07-17T00:00:03.000Z",
        detail: null, recovery: null, durable: true,
      },
      {
        launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
        sequence: 4, type: "supervisor.connected" as const, at: "2026-07-17T00:00:04.000Z",
        detail: null, recovery: null, durable: true,
      },
    ],
    [{
      launchId: "a", entryId: "supervised_a", roomIdentifier: "r", provider: "codex",
      sequence: 5, type: "agent.ready" as const, at: "2026-07-17T00:00:05.000Z",
      detail: null, recovery: null, durable: true,
    }],
  ];

  await followDurableLaunchEvents(
    "a",
    async (cursor) => {
      cursors.push(cursor);
      return suffixes.shift() ?? [];
    },
    async () => assert.fail("a healthy subscription must not back off"),
  );

  assert.deepEqual(cursors, [1, 4]);
  assert.deepEqual(getLaunchEvents("a").map((event) => [event.sequence, event.type]), [
    [1, "launch.requested"],
    [2, "launch.failed"],
    [3, "launch.requested"],
    [4, "supervisor.connected"],
    [5, "agent.ready"],
  ]);
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

test("supervisedLaunchEverReady uses the durable ready stamp, not instantaneous state", () => {
  // Never reached ready → a stop is a cancelled launch, even if it had bound.
  assert.equal(supervisedLaunchEverReady({ readyReachedAt: null }), false);
  assert.equal(supervisedLaunchEverReady({ readyReachedAt: undefined }), false);
  // Reached ready at some point → a later stop (even after degrading) is a
  // lifecycle event, not a cancelled launch (the finding-2 case).
  assert.equal(supervisedLaunchEverReady({ readyReachedAt: "2026-07-17T00:00:00.000Z" }), true);
});
