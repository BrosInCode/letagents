import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reactive } from "vue";

import type { DesktopGitHubRoomEvent, DesktopRoomMessage, DesktopRoomSnapshot } from "../../electron/ipc-types";
import { SelectedRoomSnapshotCache, withoutCachedPaint } from "../src/composables/selected-room-snapshot-cache";

describe("SelectedRoomSnapshotCache", () => {
  it("evicts the least recently used room and its aliases", () => {
    const cache = new SelectedRoomSnapshotCache(2, 200);
    cache.remember(snapshot("room_a"), ["Alias-A"]);
    cache.remember(snapshot("room_b"));
    assert.ok(cache.read("alias-a"));
    cache.remember(snapshot("room_c"));
    assert.equal(cache.read("room_b"), null);
    assert.ok(cache.read("room_a"));
    assert.ok(cache.read("room_c"));
    cache.forget(["alias-a"]);
    assert.equal(cache.read("room_a"), null);
    assert.equal(cache.size, 1);
  });

  it("keeps only the newest page of messages", () => {
    const cache = new SelectedRoomSnapshotCache(8, 3);
    cache.remember(snapshot("room_a", { messages: ["m1", "m2", "m3", "m4", "m5"].map(message) }));
    assert.deepEqual(cache.read("room_a")?.messages.map((entry) => entry.id), ["m3", "m4", "m5"]);
  });

  it("does not keep a room whose last fresh read was not ready, until a ready read", () => {
    const cache = new SelectedRoomSnapshotCache(8, 200);
    cache.remember(snapshot("room_a"));
    cache.noteFreshAccess({ ...snapshot("room_a"), access: { ...snapshot("room_a").access, status: "forbidden" } });
    assert.equal(cache.read("room_a"), null);
    cache.remember(snapshot("room_a"));
    assert.equal(cache.read("room_a"), null);
    cache.noteFreshAccess(snapshot("room_a"));
    cache.remember(snapshot("room_a"));
    assert.ok(cache.read("room_a"));
  });

  it("keeps cloud rooms and local focus rooms, not other local rooms", () => {
    const cache = new SelectedRoomSnapshotCache(8, 200);
    const local = snapshot("room_local");
    local.storage = { ...local.storage, effectiveMode: "local" };
    cache.remember(local);
    assert.equal(cache.read("room_local"), null);
    const localFocus = snapshot("focus_local");
    localFocus.storage = { ...localFocus.storage, effectiveMode: "local" };
    localFocus.room = { ...localFocus.room!, kind: "focus" };
    cache.remember(localFocus);
    assert.ok(cache.read("focus_local"));
  });
});

describe("withoutCachedPaint", () => {
  it("removes only what came from the cache, also through reactive proxies", () => {
    const painted = snapshot("room_a", {
      messages: [message("m1"), message("m2")],
      events: [githubEvent("e1")],
    });
    // The app holds the selected snapshot in a ref, so values are read through proxies.
    const shown = reactive(painted) as DesktopRoomSnapshot;
    const current: DesktopRoomSnapshot = {
      ...shown,
      messages: [...shown.messages, message("m3")],
      githubEvents: { ...shown.githubEvents!, events: [...shown.githubEvents!.events, githubEvent("e2")] },
    };
    const placeholder = snapshot("room_a");
    const result = withoutCachedPaint(current, painted, placeholder);
    assert.deepEqual(result.messages.map((entry) => entry.id), ["m3"]);
    assert.deepEqual(result.githubEvents?.events.map((event) => event.id), ["e2"]);
    assert.equal(result.tasks, placeholder.tasks);
    assert.equal(result.room, placeholder.room);
  });
});

function snapshot(
  identifier: string,
  options: { messages?: DesktopRoomMessage[]; events?: DesktopGitHubRoomEvent[] } = {},
): DesktopRoomSnapshot {
  return {
    roomIdentifier: identifier,
    access: {
      status: "ready", title: "", message: "", roomIdentifier: identifier,
      deviceFlowUrl: null, code: null, httpStatus: null,
    },
    room: { identifier, kind: "main" } as DesktopRoomSnapshot["room"],
    storage: { roomIdentifier: identifier, effectiveMode: "cloud" } as DesktopRoomSnapshot["storage"],
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    liveActivitySessions: [],
    recentActivity: [],
    roomArtifacts: [],
    messages: options.messages || [],
    githubEvents: options.events
      ? { roomIdentifier: identifier, githubRoomIdentifier: null, events: options.events, hasMore: false }
      : null,
  } as unknown as DesktopRoomSnapshot;
}

function message(id: string): DesktopRoomMessage {
  return { id, text: id, timestamp: "2026-07-02T00:00:00.000Z" } as DesktopRoomMessage;
}

function githubEvent(id: string): DesktopGitHubRoomEvent {
  return { id, createdAt: "2026-07-02T00:00:00.000Z" } as DesktopGitHubRoomEvent;
}
