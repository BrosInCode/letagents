import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RoomEntry } from "../src/components/desktop/types";
import {
  canHideSidebarRoom,
  isSidebarRoomSelectable,
  resolveSidebarRoomBatchAction,
} from "../src/domain/sidebar-room-selection";

function roomEntry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    id: "room:parent:one",
    type: "room",
    kind: "parent",
    roomIdentifier: "ROOM-ONE",
    title: "Room one",
    meta: "Room",
    sectionLabel: "Account room",
    headline: "Room one",
    description: "Description",
    latestMessageId: "msg_1",
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    pinTargetRoomIdentifier: "ROOM-ONE",
    pinnedAccountRoomIdentifiers: [],
    source: "account",
    ...overrides,
  };
}

describe("sidebar room multi-selection", () => {
  it("keeps real rooms and synthetic pinnable parents selectable", () => {
    assert.equal(isSidebarRoomSelectable(roomEntry()), true);
    assert.equal(isSidebarRoomSelectable(roomEntry({
      roomIdentifier: null,
      pinTargetRoomIdentifier: "git-room:branch:one",
    })), true);
    assert.equal(isSidebarRoomSelectable(roomEntry({
      roomIdentifier: null,
      pinTargetRoomIdentifier: null,
    })), false);
  });

  it("targets only unread rooms for the read action", () => {
    const unread = roomEntry({ id: "unread", hasUnread: true });
    const read = roomEntry({ id: "read", roomIdentifier: "ROOM-TWO" });
    const result = resolveSidebarRoomBatchAction({
      action: "mark-read",
      entries: [unread, read],
      primaryRoomId: "primary",
    });
    assert.equal(result.label, "Read");
    assert.deepEqual(result.targets.map((entry) => entry.id), ["unread"]);
  });

  it("pins unpinned parents first and unpins when all eligible parents are pinned", () => {
    const unpinned = roomEntry({ id: "unpinned" });
    const pinned = roomEntry({
      id: "pinned",
      roomIdentifier: "ROOM-TWO",
      pinned: true,
      pinnedAccountRoomIdentifiers: ["ROOM-TWO"],
    });
    const mixed = resolveSidebarRoomBatchAction({
      action: "pin",
      entries: [unpinned, pinned],
      primaryRoomId: "primary",
    });
    assert.equal(mixed.pinned, true);
    assert.equal(mixed.label, "Pin");
    assert.deepEqual(mixed.targets.map((entry) => entry.id), ["unpinned"]);

    const allPinned = resolveSidebarRoomBatchAction({
      action: "pin",
      entries: [pinned],
      primaryRoomId: "primary",
    });
    assert.equal(allPinned.pinned, false);
    assert.equal(allPinned.label, "Unpin");
    assert.deepEqual(allPinned.targets.map((entry) => entry.id), ["pinned"]);
  });

  it("concludes only active focus rooms with complete lineage", () => {
    const active = roomEntry({
      id: "active-focus",
      kind: "focus",
      focusStatus: "active",
      focusKey: "task_1",
      parentRoomIdentifier: "ROOM-ONE",
    });
    const concluded = roomEntry({
      id: "closed-focus",
      kind: "focus",
      roomIdentifier: "focus_2",
      focusStatus: "concluded",
      focusKey: "task_2",
      parentRoomIdentifier: "ROOM-ONE",
    });
    const result = resolveSidebarRoomBatchAction({
      action: "conclude",
      entries: [active, concluded, roomEntry()],
      primaryRoomId: "primary",
    });
    assert.deepEqual(result.targets.map((entry) => entry.id), ["active-focus"]);
  });

  it("hides focus rooms and non-primary parents without hiding the current parent", () => {
    const primary = roomEntry({ id: "primary" });
    const other = roomEntry({ id: "other", roomIdentifier: "ROOM-TWO" });
    const focus = roomEntry({
      id: "focus",
      kind: "focus",
      roomIdentifier: "focus_1",
      focusKey: "task_1",
      parentRoomIdentifier: "ROOM-ONE",
    });
    assert.equal(canHideSidebarRoom(primary, "primary"), false);
    assert.equal(canHideSidebarRoom(other, "primary"), true);

    const result = resolveSidebarRoomBatchAction({
      action: "hide",
      entries: [primary, other, focus],
      primaryRoomId: "primary",
    });
    assert.deepEqual(result.targets.map((entry) => entry.id), ["other", "focus"]);
  });
});
