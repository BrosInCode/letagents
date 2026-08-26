import assert from "node:assert/strict";
import test from "node:test";

import { DaemonStateWatch } from "../daemon-state-watch.js";
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
