import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopSupervisorManifestEntry, DesktopSupervisorStateSnapshot } from "../ipc-types.js";
import { applySupervisorStateChanges } from "../main/supervisor-daemon/state-watch-changes.js";

const entry = (id: string, displayName = id): DesktopSupervisorManifestEntry => ({ id, displayName } as unknown as DesktopSupervisorManifestEntry);
const held: DesktopSupervisorStateSnapshot = { daemonGeneration: 3, sequence: 10, entries: [entry("a"), entry("b"), entry("c")] };

test("changes replace, add and remove entries in the daemon's order", () => {
  const next = applySupervisorStateChanges(held, {
    complete: false, daemonGeneration: 3, sequence: 12,
    changedEntries: [entry("b", "B renamed"), entry("d")], removedEntryIds: ["a"], entryOrder: ["d", "c", "b"],
  });
  assert.deepEqual(next, { daemonGeneration: 3, sequence: 12, entries: [entry("d"), entry("c"), entry("b", "B renamed")] });
  assert.deepEqual(held.entries.map((item) => item.id), ["a", "b", "c"], "the held state is not edited in place");
});

test("an empty change keeps the state and moves its sequence", () => {
  assert.deepEqual(applySupervisorStateChanges(held, { complete: false, daemonGeneration: 3, sequence: 11, changedEntries: [], removedEntryIds: [], entryOrder: ["a", "b", "c"] }),
    { ...held, sequence: 11 });
});

test("changes that do not fit the state held are refused, so the holder reads the whole state again", () => {
  const base = { complete: false as const, daemonGeneration: 3, sequence: 11, changedEntries: [], removedEntryIds: [] };
  assert.equal(applySupervisorStateChanges(held, { ...base, daemonGeneration: 4, entryOrder: ["a", "b", "c"] }), null, "another generation");
  assert.equal(applySupervisorStateChanges(held, { ...base, sequence: 9, entryOrder: ["a", "b", "c"] }), null, "an older sequence");
  assert.equal(applySupervisorStateChanges(held, { ...base, entryOrder: ["a", "b", "c", "x"] }), null, "an entry neither side has");
  assert.equal(applySupervisorStateChanges(held, { ...base, entryOrder: ["a", "b"] }), null, "a held entry the order drops without a removal");
  assert.equal(applySupervisorStateChanges(held, { ...base, entryOrder: ["a", "b", "c", "c"] }), null, "an entry named twice");
});
