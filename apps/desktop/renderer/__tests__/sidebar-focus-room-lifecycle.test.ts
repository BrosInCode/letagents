import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopRoomSnapshot } from "../../electron/ipc-types";
import type { RoomEntry } from "../src/components/desktop/types";
import { buildSidebarProjectGroups } from "../src/domain/sidebar-rooms";

function parentEntry(): RoomEntry {
  return {
    id: "room:parent:ABCD-1234",
    type: "room",
    kind: "parent",
    roomIdentifier: "ABCD-1234",
    title: "Main room",
    meta: "Room",
    sectionLabel: "Parent room",
    headline: "Headline",
    description: "Description",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "current",
  };
}

function focusRoom(
  roomId: string,
  focusStatus: "active" | "concluded",
): DesktopRoomSnapshot["focusRooms"][number] {
  return {
    roomId,
    identifier: roomId,
    displayName: roomId === "focus_active" ? "Active work" : "Completed work",
    code: null,
    focusKey: `key_${roomId}`,
    focusStatus,
    sourceTaskId: roomId === "focus_active" ? "task_12" : null,
    parentRoomId: "ABCD-1234",
    gitRoom: null,
  } as DesktopRoomSnapshot["focusRooms"][number];
}

describe("sidebar focus room lifecycle", () => {
  it("projects active focus rooms with closeout lineage and omits concluded rooms", () => {
    const groups = buildSidebarProjectGroups({
      currentParentRoom: parentEntry(),
      focusRooms: [focusRoom("focus_active", "active"), focusRoom("focus_done", "concluded")],
      accountRooms: [],
    });

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.focusRooms.map((room) => room.title), ["Active work"]);
    assert.equal(groups[0]?.focusRooms[0]?.focusStatus, "active");
    assert.equal(groups[0]?.focusRooms[0]?.sourceTaskId, "task_12");
    assert.equal(groups[0]?.focusRooms[0]?.focusKey, "key_focus_active");
    assert.equal(groups[0]?.focusRooms[0]?.parentRoomIdentifier, "ABCD-1234");
  });
});
