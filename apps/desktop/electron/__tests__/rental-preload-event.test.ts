import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { EventEmitter } from "node:events";
import type { DesktopApi } from "../ipc-types.js";
import type { DesktopSupervisorManifestEntry, DesktopSupervisorStateSnapshot } from "../ipc-types/agents.js";

type Listener = (event: unknown, payload: unknown) => void;
const listeners = new EventEmitter();
const removed: Array<{ channel: string; listener: Listener }> = [];
let exposed: Record<string, unknown> | null = null;

mock.module("electron", {
  namedExports: {
    contextBridge: {
      exposeInMainWorld(_name: string, api: Record<string, unknown>) { exposed = api; },
    },
    ipcRenderer: {
      invoke: async () => null,
      on(channel: string, listener: Listener) { listeners.on(channel, listener); },
      off(channel: string, listener: Listener) { removed.push({ channel, listener }); listeners.off(channel, listener); },
    },
  },
});

await import("../preload.js");

function listenerFor(channel: string): Listener {
  const listener = listeners.listeners(channel)[0];
  assert.ok(listener);
  return listener as Listener;
}

test("provider event subscription forwards payload and cleanup removes the exact listener", () => {
  assert.ok(exposed);
  const rental = exposed.rental as {
    onProviderEvent(callback: (event: unknown) => void): () => void;
  };
  const received: unknown[] = [];
  const unsubscribe = rental.onProviderEvent((event) => received.push(event));
  const listener = listenerFor("desktop:rental:provider-event");
  assert.ok(listener);
  const payload = { kind: "request.created", sessionId: "rsess_1" };
  listener({}, payload);
  assert.deepEqual(received, [payload]);

  unsubscribe();
  assert.equal(listeners.listenerCount("desktop:rental:provider-event"), 0);
  assert.deepEqual(removed, [{ channel: "desktop:rental:provider-event", listener }]);
});

function supervisorSnapshot(sequence: number, roomIds: string[]): DesktopSupervisorStateSnapshot {
  return {
    daemonGeneration: 7,
    sequence,
    entries: roomIds.map((roomId, index) => ({
      id: `entry-${index}`,
      roomId,
      activity: [{ sequence: index, summary: `activity-${index}` }],
    } as DesktopSupervisorManifestEntry)),
  };
}

test("supervisor state filters exact room entries before the bridge callback without changing the envelope", () => {
  const supervisor = (exposed as unknown as DesktopApi).supervisor;
  const received: DesktopSupervisorStateSnapshot[] = [];
  const unsubscribe = supervisor.onState((snapshot) => received.push(snapshot), "room-a");
  const listener = listenerFor("desktop:supervisor:state");
  const snapshot = supervisorSnapshot(12, ["room-a", "room-b", "room-a/child", "Room-A", "room-a"]);
  const original = structuredClone(snapshot);
  listener({}, snapshot);
  assert.deepEqual(received, [{ ...snapshot, entries: [snapshot.entries[0], snapshot.entries[4]] }]);
  assert.deepEqual(snapshot, original, "projection does not modify the shared IPC payload");
  assert.equal(received[0]!.entries[0], snapshot.entries[0], "only selected entries reach the callback");

  const removal = supervisorSnapshot(13, ["room-b"]);
  listener({}, removal);
  const newGeneration = { ...supervisorSnapshot(1, []), daemonGeneration: 8 };
  listener({}, newGeneration);
  assert.deepEqual(received.slice(1), [
    { ...removal, entries: [] },
    newGeneration,
  ], "empty removals and generation/sequence heartbeats must still cross the bridge");
  unsubscribe();
});

test("supervisor state retains global subscription compatibility and ignores callbacks after cleanup", () => {
  const supervisor = (exposed as unknown as DesktopApi).supervisor;
  const received: DesktopSupervisorStateSnapshot[] = [];
  const unsubscribe = supervisor.onState((snapshot) => received.push(snapshot));
  const listener = listenerFor("desktop:supervisor:state");
  const snapshot = supervisorSnapshot(12, ["room-a", "room-b"]);
  listener({}, snapshot);
  assert.equal(received[0], snapshot);
  unsubscribe();
  assert.equal(listeners.listenerCount("desktop:supervisor:state"), 0);
  assert.deepEqual(removed.at(-1), { channel: "desktop:supervisor:state", listener });
  listener({}, supervisorSnapshot(13, ["room-a"]));
  assert.equal(received.length, 1, "an already-queued old listener cannot cross contextBridge after unsubscribe");
});

test("room-scoped supervisor state only sends the selected population from a global update", () => {
  const supervisor = (exposed as unknown as DesktopApi).supervisor;
  const received: DesktopSupervisorStateSnapshot[] = [];
  const unsubscribe = supervisor.onState((snapshot) => received.push(snapshot), "room-a");
  const snapshot = supervisorSnapshot(20, Array.from({ length: 173 }, (_, index) => index < 3 ? "room-a" : `other-${index % 30}`));
  listeners.emit("desktop:supervisor:state", {}, snapshot);
  assert.equal(snapshot.entries.length, 173);
  assert.equal(received[0]!.entries.length, 3);
  assert.deepEqual(received[0], { ...snapshot, entries: snapshot.entries.filter((entry) => entry.roomId === "room-a") });
  unsubscribe();
});

test("an empty room filter stays exact instead of becoming a global subscription", () => {
  const received: DesktopSupervisorStateSnapshot[] = [];
  const unsubscribe = (exposed as unknown as DesktopApi).supervisor.onState((snapshot) => received.push(snapshot), "");
  const snapshot = supervisorSnapshot(25, ["room-a", ""]);
  listeners.emit("desktop:supervisor:state", {}, snapshot);
  assert.deepEqual(received, [{ ...snapshot, entries: [snapshot.entries[1]] }]);
  unsubscribe();
});

test("simultaneous scoped and global supervisor listeners retain independent cleanup", () => {
  const supervisor = (exposed as unknown as DesktopApi).supervisor;
  const roomA: DesktopSupervisorStateSnapshot[] = [];
  const roomB: DesktopSupervisorStateSnapshot[] = [];
  const global: DesktopSupervisorStateSnapshot[] = [];
  const stopA = supervisor.onState((snapshot) => roomA.push(snapshot), "room-a");
  const stopB = supervisor.onState((snapshot) => roomB.push(snapshot), "room-b");
  const stopGlobal = supervisor.onState((snapshot) => global.push(snapshot));
  assert.equal(listeners.listenerCount("desktop:supervisor:state"), 3);
  const snapshot = supervisorSnapshot(30, ["room-a", "room-b"]);
  listeners.emit("desktop:supervisor:state", {}, snapshot);
  assert.deepEqual(roomA[0]!.entries, [snapshot.entries[0]]);
  assert.deepEqual(roomB[0]!.entries, [snapshot.entries[1]]);
  assert.equal(global[0], snapshot);
  stopA();
  stopA();
  assert.equal(listeners.listenerCount("desktop:supervisor:state"), 2);
  const removal = supervisorSnapshot(31, ["room-a"]);
  listeners.emit("desktop:supervisor:state", {}, removal);
  assert.equal(roomA.length, 1);
  assert.deepEqual(roomB[1], { ...removal, entries: [] });
  assert.equal(global[1], removal);
  stopB();
  stopGlobal();
  assert.equal(listeners.listenerCount("desktop:supervisor:state"), 0);
});
