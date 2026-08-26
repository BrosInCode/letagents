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
