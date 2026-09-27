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
  assert.equal(asserted, 4, "each request checks authority before and after its read");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeClock() {
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
  return {
    timers,
    setTimeout: ((callback: () => void, delay?: number) => {
      const token = {} as ReturnType<typeof setTimeout>;
      timers.set(token, { callback, delay: delay ?? 0 });
      return token;
    }) as typeof setTimeout,
    clearTimeout: ((token: ReturnType<typeof setTimeout>) => { timers.delete(token); }) as typeof clearTimeout,
    fire(delay: number) {
      const match = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `expected a ${delay} ms timer`);
      timers.delete(match[0]);
      match[1].callback();
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("concurrent subscribers share an in-flight projection but check their own fences", async () => {
  const read = deferred<DaemonManifestEntryView[]>();
  let builds = 0;
  let assertions = 0;
  const watch = new DaemonStateWatch({
    currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => { assertions += 1; },
    entries: () => { builds += 1; return read.promise; },
  });
  const requests = Array.from({ length: 5 }, () => watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 }));
  await flush();
  assert.equal(builds, 1);
  assert.equal(assertions, 5);
  read.resolve([]);
  assert.deepEqual((await Promise.all(requests)).map((snapshot) => snapshot.sequence), [1, 1, 1, 1, 1]);
  assert.equal(assertions, 10);
});

test("invalidation during projection preserves its cursor and coalesces a shared successor", async () => {
  const clock = fakeClock();
  const firstRead = deferred<DaemonManifestEntryView[]>();
  let builds = 0;
  const watch = new DaemonStateWatch({
    ...clock, coalesceMs: 150, currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => {},
    entries: async () => { builds += 1; return builds === 1 ? firstRead.promise : []; },
  });
  const first = watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 25_000 });
  await flush();
  watch.notify();
  watch.notify();
  firstRead.resolve([]);
  assert.equal((await first).sequence, 1, "a read cannot claim mutations that arrived after it began");
  const next = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 25_000 });
  const other = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 25_000 });
  await flush();
  assert.equal(builds, 1, "a stale cursor does not bypass the production window");
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.delay), [150]);
  clock.fire(150);
  assert.deepEqual((await Promise.all([next, other])).map((snapshot) => snapshot.sequence), [3, 3]);
  assert.equal(builds, 2);
});

test("zero-wait reads and expired long polls bypass a pending production window", async () => {
  const clock = fakeClock();
  let builds = 0;
  const watch = new DaemonStateWatch({
    ...clock, coalesceMs: 150, currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => {}, entries: async () => { builds += 1; return []; },
  });
  const deadline = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 10 });
  watch.notify();
  assert.equal((await watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 0 })).sequence, 2);
  assert.equal(builds, 1);
  clock.fire(10);
  assert.equal((await deadline).sequence, 2);
  assert.equal(builds, 2, "the deadline produces a fresh projection without waiting for coalescing");
  watch.close();
  assert.equal(clock.timers.size, 0);
});

test("a long-poll timeout refreshes time-derived liveness without a state mutation", async () => {
  const clock = fakeClock();
  let stale = false;
  let builds = 0;
  const watch = new DaemonStateWatch({
    ...clock, coalesceMs: 150, currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => {},
    entries: async () => {
      builds += 1;
      return [{ id: "agent", native_liveness: { state: stale ? "stale" : "active" } }] as DaemonManifestEntryView[];
    },
  });
  const initial = await watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 });
  const pending = watch.watch({ afterDaemonGeneration: 1, afterSequence: initial.sequence, waitMs: 25_000 });
  stale = true;
  clock.fire(25_000);
  const refreshed = await pending;
  assert.equal(refreshed.sequence, initial.sequence);
  assert.equal(refreshed.entries[0]!.native_liveness?.state, "stale");
  assert.equal(builds, 2, "completed results are never cached by sequence");
});

test("generation changes cannot reuse an old in-flight projection or delay on its coalescing window", async () => {
  const clock = fakeClock();
  const read = deferred<DaemonManifestEntryView[]>();
  let generation = 1;
  let builds = 0;
  const watch = new DaemonStateWatch({
    ...clock, coalesceMs: 150, currentGeneration: () => generation, isHandoffScheduled: () => false,
    assertCurrent: async () => {},
    entries: async () => { builds += 1; return builds === 1 ? read.promise : []; },
  });
  const old = watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 25_000 });
  await flush();
  generation = 2;
  watch.notify();
  const fresh = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 25_000 });
  read.resolve([]);
  assert.deepEqual((await Promise.all([old, fresh])).map((snapshot) => snapshot.daemon_generation), [2, 2]);
  assert.equal(builds, 2);
  watch.close();
});

test("close and handoff release subscribers waiting for snapshot production", async () => {
  for (const mode of ["close", "handoff"] as const) {
    const clock = fakeClock();
    const read = deferred<DaemonManifestEntryView[]>();
    let handoff = false;
    let builds = 0;
    const watch = new DaemonStateWatch({
      ...clock, coalesceMs: 150, currentGeneration: () => 1, isHandoffScheduled: () => handoff,
      assertCurrent: async () => {},
      entries: async () => { builds += 1; return builds === 1 ? read.promise : []; },
    });
    const first = watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 25_000 });
    await flush();
    watch.notify();
    read.resolve([]);
    await first;
    const pending = watch.watch({ afterDaemonGeneration: 1, afterSequence: 1, waitMs: 25_000 });
    await flush();
    assert.equal(builds, 1);
    if (mode === "close") watch.close();
    else { handoff = true; watch.notify(); }
    assert.equal((await pending).sequence, mode === "close" ? 2 : 3);
    assert.equal(builds, 2);
    assert.equal(clock.timers.size, 0);
  }
});

test("failed shared reads release their slot and post-read fence loss rejects every subscriber", async () => {
  const read = deferred<DaemonManifestEntryView[]>();
  let builds = 0;
  let fenced = false;
  const watch = new DaemonStateWatch({
    currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => { if (fenced) throw new Error("fence lost"); },
    entries: async () => { builds += 1; return builds === 1 ? read.promise : []; },
  });
  const requests = Array.from({ length: 2 }, () => watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 }));
  const rejected = Promise.all(requests.map((request) => assert.rejects(request, /read failed/)));
  await flush();
  read.reject(new Error("read failed"));
  await rejected;
  assert.equal((await watch.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 })).sequence, 1);
  assert.equal(builds, 2);

  const heldRead = deferred<DaemonManifestEntryView[]>();
  const other = new DaemonStateWatch({
    currentGeneration: () => 1, isHandoffScheduled: () => false,
    assertCurrent: async () => { if (fenced) throw new Error("fence lost"); },
    entries: () => heldRead.promise,
  });
  const held = Array.from({ length: 2 }, () => other.watch({ afterDaemonGeneration: 1, afterSequence: 0, waitMs: 0 }));
  const lost = Promise.all(held.map((request) => assert.rejects(request, /fence lost/)));
  await flush();
  fenced = true;
  heldRead.resolve([]);
  await lost;
});
