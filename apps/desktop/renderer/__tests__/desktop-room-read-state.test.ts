import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopAccountFocusRoomEntry,
  DesktopAccountRoomEntry,
  DesktopRoomMessage,
} from "../../electron/ipc-types";
import {
  deriveSidebarLatestMessages,
  countUnreadRoomMessages,
  isRoomBeingRead,
  markRoomRead,
  noRoomMessageId,
  readStoredRoomMessageIds,
  roomReadMarkerKey,
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

function unreadMessage(number: number, overrides: Partial<DesktopRoomMessage> = {}): DesktopRoomMessage {
  return { id: `msg_${number}`, sender: "Agent", source: "agent", text: "New reply", agentPromptKind: null, ...overrides } as DesktopRoomMessage;
}

describe("unread message counts", () => {
  it("counts actual messages across pages, including replies, excluding own messages and hidden prompts", async () => {
    const cursors: Array<string | null> = [];
    const result = await countUnreadRoomMessages({
      readMessageId: "msg_10", latestMessageId: "msg_30", ownSenderNames: ["Emmy"], isCurrent: () => true,
      loadPage: async (after) => {
        cursors.push(after);
        return after === "msg_10"
          ? { messages: [unreadMessage(12), unreadMessage(15, { source: "browser", sender: "Emmy" }), unreadMessage(18, { agentPromptKind: "auto", text: "" })], hasMore: true }
          : { messages: [unreadMessage(22, { threadRootId: "msg_1" }), unreadMessage(30), unreadMessage(31)], hasMore: false };
      },
    });
    assert.equal(result?.count, 3);
    assert.deepEqual(cursors, ["msg_10", "msg_18"]);
  });

  it("catches up incrementally without recounting already observed messages", async () => {
    const result = await countUnreadRoomMessages({
      readMessageId: "msg_1", latestMessageId: "msg_50", previous: { readMessageId: "msg_1", latestMessageId: "msg_40", count: 12 },
      ownSenderNames: [], isCurrent: () => true,
      loadPage: async (after) => {
        assert.equal(after, "msg_40");
        return { messages: [unreadMessage(42), unreadMessage(42), unreadMessage(50)], hasMore: false };
      },
    });
    assert.equal(result?.count, 14);
  });

  it("clears read rooms without fetching and handles first messages after an empty baseline", async () => {
    const cleared = await countUnreadRoomMessages({
      readMessageId: "msg_50", latestMessageId: "msg_50", ownSenderNames: [], isCurrent: () => true,
      loadPage: async () => { throw new Error("must not fetch read history"); },
    });
    assert.equal(cleared?.count, 0);
    const first = await countUnreadRoomMessages({
      readMessageId: noRoomMessageId, latestMessageId: "msg_4", ownSenderNames: [], isCurrent: () => true,
      loadPage: async (after) => { assert.equal(after, null); return { messages: [unreadMessage(4)], hasMore: false }; },
    });
    assert.equal(first?.count, 1);
  });

  it("drops stale history and rejects a non-advancing page", async () => {
    let current = true;
    assert.equal(await countUnreadRoomMessages({
      readMessageId: "msg_1", latestMessageId: "msg_3", ownSenderNames: [], isCurrent: () => current,
      loadPage: async () => { current = false; return { messages: [unreadMessage(3)], hasMore: false }; },
    }), null);
    await assert.rejects(countUnreadRoomMessages({
      readMessageId: "msg_1", latestMessageId: "msg_3", ownSenderNames: [], isCurrent: () => true,
      loadPage: async () => ({ messages: [unreadMessage(1)], hasMore: true }),
    }), /did not advance/);
  });

  it("only treats a loaded, focused and visible room as being read", () => {
    const reading = { hidden: false, focused: true, activeRoomIdentifier: "ROOM_A", snapshotRoomIdentifier: "room_a" };
    assert.equal(isRoomBeingRead(reading), true);
    assert.equal(isRoomBeingRead({ ...reading, hidden: true }), false);
    assert.equal(isRoomBeingRead({ ...reading, focused: false }), false);
    assert.equal(isRoomBeingRead({ ...reading, activeRoomIdentifier: null }), false);
    assert.equal(isRoomBeingRead({ ...reading, snapshotRoomIdentifier: "room_b" }), false);
  });
});

describe("independent local and cloud unread histories", () => {
  it("does not reuse cloud latest IDs or cursors for a room stored locally", () => {
    const result = deriveSidebarLatestMessages({
      accountRooms: [accountRoom("room_a", { latestMessageId: "msg_100" })],
      sidebarRoomIdentifiers: ["room_a"], localRoomIdentifiers: ["ROOM_A"],
    });
    assert.deepEqual(result.latestMessages, {});
    assert.deepEqual(result.uncoveredRoomIdentifiers, ["room_a"]);
    const cloudKey = roomReadMarkerKey("ROOM_A", "cloud")!;
    const localKey = roomReadMarkerKey("ROOM_A", "local")!;
    const markers = markRoomRead({ [cloudKey]: "msg_100" }, localKey, "msg_5").readMarkers;
    assert.equal(markers[cloudKey], "msg_100");
    assert.equal(markers[localKey], "msg_5");
  });

  it("a stale loaded snapshot cannot undo explicit mark-as-read", () => {
    const markers = { room_a: "msg_100" };
    assert.deepEqual(markRoomRead(markers, "room_a", "msg_80"), { changed: false, readMarkers: markers });
    assert.deepEqual(markRoomRead(markers, "room_a", null), { changed: false, readMarkers: markers });
    assert.equal(markRoomRead(markers, "room_a", "msg_101").readMarkers.room_a, "msg_101");
  });
});
