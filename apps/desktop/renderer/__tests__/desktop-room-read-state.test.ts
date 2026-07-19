import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopAccountFocusRoomEntry,
  DesktopAccountRoomEntry,
} from "../../electron/ipc-types";
import {
  deriveSidebarLatestMessages,
  hasUnreadRoomActivity,
  markRoomRead,
  noRoomMessageId,
  readStoredRoomMessageIds,
  seedRoomReadMarker,
} from "../src/domain/desktop-room-read-state";

function accountRoom(
  roomIdentifier: string,
  overrides: Partial<DesktopAccountRoomEntry> = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier,
    displayName: roomIdentifier,
    name: roomIdentifier,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "participant",
    source: null,
    pinned: false,
    archived: false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: null,
    focusRooms: [],
    ...overrides,
  };
}

function focusRoom(
  roomIdentifier: string,
  overrides: Partial<DesktopAccountFocusRoomEntry> = {},
): DesktopAccountFocusRoomEntry {
  return {
    roomIdentifier,
    displayName: roomIdentifier,
    name: roomIdentifier,
    kind: "focus",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "participant",
    source: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: null,
    ...overrides,
  };
}

describe("desktop room read state", () => {
  it("does not show historical unread state before a room has a local baseline", () => {
    assert.equal(
      hasUnreadRoomActivity({
        activeRoomIdentifier: "room_a",
        latestMessageId: "msg_2",
        readMarkers: {},
        roomIdentifier: "room_b",
      }),
      false,
    );
  });

  it("shows unread when a tracked inactive room has a newer latest message", () => {
    assert.equal(
      hasUnreadRoomActivity({
        activeRoomIdentifier: "room_a",
        latestMessageId: "msg_2",
        readMarkers: { room_b: "msg_1" },
        roomIdentifier: "room_b",
      }),
      true,
    );
  });

  it("never shows unread on the active room", () => {
    assert.equal(
      hasUnreadRoomActivity({
        activeRoomIdentifier: "ROOM_B",
        latestMessageId: "msg_2",
        readMarkers: { room_b: "msg_1" },
        roomIdentifier: "room_b",
      }),
      false,
    );
  });

  it("baselines newly discovered rooms without replacing existing read cursors", () => {
    const seeded = seedRoomReadMarker({}, "ROOM_B", "msg_1");
    assert.deepEqual(seeded, {
      changed: true,
      readMarkers: { room_b: "msg_1" },
    });

    const unchanged = seedRoomReadMarker(seeded.readMarkers, "room_b", "msg_2");
    assert.deepEqual(unchanged, {
      changed: false,
      readMarkers: { room_b: "msg_1" },
    });
  });

  it("keeps empty-room baselines so first later activity can be unread", () => {
    const seeded = seedRoomReadMarker({}, "room_b", null);

    assert.deepEqual(seeded.readMarkers, { room_b: noRoomMessageId });
    assert.equal(
      hasUnreadRoomActivity({
        activeRoomIdentifier: "room_a",
        latestMessageId: "msg_1",
        readMarkers: seeded.readMarkers,
        roomIdentifier: "room_b",
      }),
      true,
    );
  });

  it("marks a room read at its latest message id", () => {
    const result = markRoomRead({ room_b: "msg_1" }, "room_b", "msg_2");

    assert.deepEqual(result, {
      changed: true,
      readMarkers: { room_b: "msg_2" },
    });
  });

  it("normalizes stored read marker keys", () => {
    const readMarkers = readStoredRoomMessageIds({
      getItem: () => JSON.stringify({
        " ROOM_B ": " msg_2 ",
        "": "ignored",
        room_c: "",
      }),
    }, "read-state");

    assert.deepEqual(readMarkers, { room_b: "msg_2" });
  });
});

describe("deriveSidebarLatestMessages", () => {
  it("derives latest-message state from account rooms and their focus rooms", () => {
    const result = deriveSidebarLatestMessages({
      accountRooms: [
        accountRoom("room_a", {
          latestMessageId: "msg_a",
          latestMessageAt: "2026-07-19T00:00:00.000Z",
          focusRooms: [
            focusRoom("focus_a1", {
              latestMessageId: "msg_a1",
              latestMessageAt: "2026-07-19T01:00:00.000Z",
            }),
          ],
        }),
      ],
      sidebarRoomIdentifiers: ["ROOM_A", "focus_a1"],
    });

    assert.deepEqual(result.uncoveredRoomIdentifiers, []);
    assert.deepEqual(result.latestMessages, {
      room_a: {
        roomIdentifier: "room_a",
        latestMessageId: "msg_a",
        latestMessageAt: "2026-07-19T00:00:00.000Z",
      },
      focus_a1: {
        roomIdentifier: "focus_a1",
        latestMessageId: "msg_a1",
        latestMessageAt: "2026-07-19T01:00:00.000Z",
      },
    });
  });

  it("reports sidebar rooms missing from the account payload as uncovered", () => {
    const result = deriveSidebarLatestMessages({
      accountRooms: [accountRoom("room_a", { latestMessageId: "msg_a" })],
      sidebarRoomIdentifiers: ["room_a", "local_only"],
    });

    assert.deepEqual(Object.keys(result.latestMessages), ["room_a"]);
    assert.deepEqual(result.uncoveredRoomIdentifiers, ["local_only"]);
  });

  it("treats local-storage entries as uncovered so their local-DB lookup still runs", () => {
    const result = deriveSidebarLatestMessages({
      accountRooms: [
        accountRoom("room_cloud", { latestMessageId: "msg_cloud" }),
        // The main process merges local rooms into the payload with hardcoded
        // null latest fields; their latest message lives in the local DB.
        accountRoom("room_local", {
          source: "local",
          latestMessageId: null,
          latestMessageAt: null,
        }),
      ],
      sidebarRoomIdentifiers: ["room_cloud", "room_local"],
    });

    assert.deepEqual(Object.keys(result.latestMessages), ["room_cloud"]);
    assert.deepEqual(result.uncoveredRoomIdentifiers, ["room_local"]);
  });

  it("only covers sidebar rooms, not every account room", () => {
    const result = deriveSidebarLatestMessages({
      accountRooms: [
        accountRoom("room_a", { latestMessageId: "msg_a" }),
        accountRoom("room_b", { latestMessageId: "msg_b" }),
      ],
      sidebarRoomIdentifiers: ["room_a"],
    });

    assert.deepEqual(Object.keys(result.latestMessages), ["room_a"]);
    assert.deepEqual(result.uncoveredRoomIdentifiers, []);
  });
});
