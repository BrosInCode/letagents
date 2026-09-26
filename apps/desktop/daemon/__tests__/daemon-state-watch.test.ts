import assert from "node:assert/strict";
import test from "node:test";

import { DaemonStateWatch } from "../daemon-state-watch.js";
import { STATE_WATCH_ACTIVITY_SUMMARY_LIMIT } from "../state-watch-projection.js";
import type { DaemonManifestEntryView } from "../types.js";

test("state watch returns immediately for a new generation and wakes on notification", async () => {
  let generation = 7;
  let asserted = 0;
  const entries: DaemonManifestEntryView[] = [];
  const watch = new DaemonStateWatch({
    currentGeneration: () => generation,
    isHandoffScheduled: () => false,
    assertCurrent: async () => { asserted += 1; },
    entries: async () => entries,
  });

  assert.deepEqual(await watch.watch({ afterDaemonGeneration: 6, afterSequence: 1, waitMs: 30_000 }), {
    daemon_generation: 7,
    sequence: 1,
    entries,
  });

  const pending = watch.watch({ afterDaemonGeneration: 7, afterSequence: 1, waitMs: 30_000 });
  await Promise.resolve();
  watch.notify();
  assert.deepEqual(await pending, { daemon_generation: 7, sequence: 2, entries });
  assert.equal(asserted, 2);

  generation = 8;
  assert.equal((await watch.watch({ afterDaemonGeneration: 7, afterSequence: 2, waitMs: 30_000 })).daemon_generation, 8);
});

test("state watch close settles outstanding waiters without inventing a state change", async () => {
  const watch = new DaemonStateWatch({
    currentGeneration: () => 3,
    isHandoffScheduled: () => false,
    assertCurrent: async () => {},
    entries: async () => [],
  });
  const pending = watch.watch({ afterDaemonGeneration: 3, afterSequence: 1, waitMs: 30_000 });
  await Promise.resolve();
  watch.close();
  assert.deepEqual(await pending, { daemon_generation: 3, sequence: 1, entries: [] });
});

test("state watch defaults and caps its long-poll timeout", async () => {
  let scheduled: { callback: () => void; delay: number } | null = null;
  const setFakeTimeout = ((callback: () => void, delay?: number) => {
    scheduled = { callback, delay: delay ?? 0 };
    return { fake: true } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const watch = new DaemonStateWatch({
    currentGeneration: () => 1,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => [],
    setTimeout: setFakeTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });

  const defaulted = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: Number.NaN });
  assert.equal(scheduled === null ? null : scheduled.delay, 25_000);
  const defaultCallback = scheduled === null ? null : scheduled.callback;
  assert.ok(defaultCallback);
  defaultCallback();
  await defaulted;

  scheduled = null;
  const capped = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 90_000 });
  assert.equal(scheduled === null ? null : scheduled.delay, 30_000);
  const cappedCallback = scheduled === null ? null : scheduled.callback;
  assert.ok(cappedCallback);
  cappedCallback();
  await capped;
});

test("handoff suppresses new waits and notification wakes an already-pending wait", async () => {
  let handoff = true;
  let timerRegistrations = 0;
  const entries: DaemonManifestEntryView[] = [];
  const watch = new DaemonStateWatch({
    currentGeneration: () => 4,
    isHandoffScheduled: () => handoff,
    assertCurrent: async () => undefined,
    entries: async () => entries,
    setTimeout: ((callback: () => void) => {
      timerRegistrations += 1;
      return setTimeout(callback, 30_000);
    }) as typeof setTimeout,
  });

  assert.deepEqual(await watch.watch({ afterDaemonGeneration: 4, afterSequence: 1, waitMs: 1_000 }), {
    daemon_generation: 4,
    sequence: 1,
    entries,
  });
  assert.equal(timerRegistrations, 0, "handoff does not register a new long poll");

  handoff = false;
  const pending = watch.watch({ afterDaemonGeneration: 4, afterSequence: 1, waitMs: 30_000 });
  await Promise.resolve();
  assert.equal(timerRegistrations, 1);
  handoff = true;
  watch.notify();
  assert.deepEqual(await pending, {
    daemon_generation: 4,
    sequence: 2,
    entries,
  });
});

test("state watch publishes activity summaries, never history", async () => {
  const entries = [{
    id: "agent_1",
    room_id: "room_1",
    activity: Array.from({ length: 200 }, (_unused, index) => ({
      observed_at: new Date(1_700_000_000_000 + index).toISOString(),
      sequence: index + 1,
      provider: "claude",
      kind: "provider_stream",
      method: "item/tool_call",
      summary: `step ${index + 1}`,
      status: "working" as const,
      payload: { text: "x".repeat(1_000) },
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    })),
  }] as unknown as DaemonManifestEntryView[];
  const watch = new DaemonStateWatch({
    currentGeneration: () => 2,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => entries,
  });

  const snapshot = await watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 });
  const activity = snapshot.entries[0]!.activity!;
  assert.equal(activity.length, STATE_WATCH_ACTIVITY_SUMMARY_LIMIT);
  assert.equal(activity.at(-1)!.sequence, 200);
  assert.ok(activity.every((event) => event.payload === null));
  assert.equal(snapshot.entries[0]!.id, "agent_1");
  // The read model is never mutated in place; manifest.list still sees history.
  assert.equal(entries[0]!.activity!.length, 200);
  assert.notEqual(entries[0]!.activity![199]!.payload, null);
});

test("a burst of state changes wakes one waiter once, and the sequence still advances per change", async () => {
  let fire: (() => void) | null = null;
  let scheduledDelays: number[] = [];
  const watch = new DaemonStateWatch({
    currentGeneration: () => 5,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => [],
    coalesceMs: 150,
    setTimeout: ((callback: () => void, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      if ((delay ?? 0) === 150) fire = callback;
      return { fake: true } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });

  const pending = watch.watch({ afterDaemonGeneration: 5, afterSequence: 1, waitMs: 25_000 });
  await Promise.resolve();
  assert.deepEqual(scheduledDelays, [25_000], "the long poll registers its own deadline first");

  watch.notify();
  watch.notify();
  watch.notify();
  assert.equal(
    scheduledDelays.filter((delay) => delay === 150).length,
    1,
    "a burst schedules exactly one coalescing wake",
  );
  assert.ok(fire);
  fire!();

  // One snapshot for the whole burst, and its sequence reflects every change.
  assert.deepEqual(await pending, { daemon_generation: 5, sequence: 4, entries: [] });

  // A subscriber that arrives after the bump never waits.
  scheduledDelays = [];
  assert.equal((await watch.watch({ afterDaemonGeneration: 5, afterSequence: 1, waitMs: 25_000 })).sequence, 4);
  assert.deepEqual(scheduledDelays, [], "a stale cursor is answered without registering a wait");
});

test("coalescing never delays a handoff close", async () => {
  const watch = new DaemonStateWatch({
    currentGeneration: () => 9,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => [],
    coalesceMs: 150,
    setTimeout: ((callback: () => void, delay?: number) =>
      setTimeout(callback, delay === 150 ? 30_000 : delay)) as typeof setTimeout,
  });
  const pending = watch.watch({ afterDaemonGeneration: 9, afterSequence: 1, waitMs: 30_000 });
  await Promise.resolve();
  watch.notify();
  watch.close();
  assert.deepEqual(await pending, { daemon_generation: 9, sequence: 2, entries: [] });
});
