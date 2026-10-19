import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopLaunchEvent } from "../../electron/ipc-types";
import { ref } from "vue";
import { useSupervisedAgentLaunch } from "../src/components/desktop/content/add-agent/useSupervisedAgentLaunch";
import { useSupervisedLaunchEventStream } from "../src/components/desktop/content/add-agent/useSupervisedLaunchEventStream";

function launchEvent(launchId: string, sequence: number): DesktopLaunchEvent {
  return {
    launchId,
    entryId: `supervised_${launchId}`,
    roomIdentifier: "room-1",
    provider: "codex",
    sequence,
    type: "launch.requested",
    at: "2026-10-16T00:00:00.000Z",
  } as DesktopLaunchEvent;
}

function installBridge(history: Record<string, DesktopLaunchEvent[]>): { replays: string[]; listeners: number } {
  const counters = { replays: [] as string[], listeners: 0 };
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        supervisor: {
          onLaunchEvent: () => {
            counters.listeners += 1;
            return () => { counters.listeners -= 1; };
          },
          getLaunchEvents: async (launchId: string) => {
            counters.replays.push(launchId);
            return history[launchId] ?? [];
          },
        },
      },
    },
  });
  return counters;
}

test("a launch that is about to be requested attaches its listener without replaying history", async () => {
  const counters = installBridge({});
  const stream = useSupervisedLaunchEventStream();
  stream.subscribe("fresh-launch", { replay: false });
  assert.equal(stream.activeLaunchId.value, "fresh-launch");
  assert.equal(counters.listeners, 1, "live events are listened for before createAgent runs");
  assert.deepEqual(counters.replays, [], "a launch with no history is not read back");
  stream.clear();
  assert.equal(counters.listeners, 0);
});

test("re-attaching to an existing launch replays its history", async () => {
  const counters = installBridge({ "old-launch": [launchEvent("old-launch", 1), launchEvent("old-launch", 2)] });
  const stream = useSupervisedLaunchEventStream();
  stream.subscribe("old-launch");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(counters.replays, ["old-launch"]);
  assert.deepEqual(stream.events.value.map((event) => event.sequence), [1, 2]);
  stream.clear();
});

test("begin() attaches the launch listener without reading history back", () => {
  const counters = installBridge({});
  Object.assign(globalThis.window as object, {
    crypto: { randomUUID: () => "launch-fresh" },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
  // The minimum a begin() needs; nothing here starts the entry watch.
  const launch = useSupervisedAgentLaunch({
    open: ref(true),
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    entries: () => [],
    entriesState: () => "ready",
    entriesError: () => null,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  } as Parameters<typeof useSupervisedAgentLaunch>[0]);
  assert.equal(launch.begin(), "launch-fresh");
  assert.equal(counters.listeners, 1);
  assert.deepEqual(counters.replays, [], "a launch this click requests has no history to read");
  launch.cleanup();
});
