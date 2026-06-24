import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopAccountRoomEntry } from "../ipc-types.js";
import { mergeDesktopAccountRoomEntries } from "../main/rooms/account-room-list.js";

test("archived cloud rooms suppress linked local mirrors in the visible room list", () => {
  const rooms = mergeDesktopAccountRoomEntries(
    [
      room("room_archived", "Archived cloud", { archived: true }),
      room("room_active", "Active cloud"),
    ],
    [
      room("room_archived", "Archived cloud local mirror", { source: "local" }),
      room("room_local", "Local only", { source: "local" }),
    ],
  );

  assert.deepEqual(
    rooms.map((entry) => entry.roomIdentifier),
    ["room_local", "room_active"],
  );
});

test("includeArchived shows archived cloud rooms without duplicating linked local mirrors", () => {
  const rooms = mergeDesktopAccountRoomEntries(
    [
      room("room_archived", "Archived cloud", { archived: true }),
      room("room_active", "Active cloud"),
    ],
    [
      room("room_archived", "Archived cloud local mirror", { source: "local" }),
    ],
    { includeArchived: true },
  );

  assert.deepEqual(
    rooms.map((entry) => entry.roomIdentifier),
    ["room_archived", "room_active"],
  );
});

test("archived local-only rooms are hidden from the visible room list", () => {
  const rooms = mergeDesktopAccountRoomEntries(
    [
      room("room_active", "Active cloud"),
    ],
    [
      room("room_local_archived", "Archived local", {
        source: "local",
        archived: true,
      }),
      room("room_local_active", "Active local", { source: "local" }),
    ],
  );

  assert.deepEqual(
    rooms.map((entry) => entry.roomIdentifier),
    ["room_local_active", "room_active"],
  );
});

function room(
  roomIdentifier: string,
  displayName: string,
  options: { archived?: boolean; source?: string | null } = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier,
    displayName,
    name: roomIdentifier,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "admin",
    source: options.source || null,
    pinned: false,
    archived: options.archived || false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    focusRooms: [],
  };
}
