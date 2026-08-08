import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RoomEntry } from "../src/components/desktop/types";
import {
  SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT,
  previewSidebarProjectRooms,
} from "../src/domain/sidebar-project-room-preview";

function room(index: number): RoomEntry {
  return {
    id: `room:${index}`,
    type: "room",
    kind: "focus",
    roomIdentifier: `focus-${index}`,
    title: `Room ${index}`,
    meta: "Focus room",
    sectionLabel: "Focus room",
    headline: "",
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
}

describe("sidebar project room preview", () => {
  const rooms = Array.from({ length: 20 }, (_, index) => room(index + 1));

  it("caps a large project at a scannable first set", () => {
    const preview = previewSidebarProjectRooms({ rooms, activeEntryId: "room:1", expanded: false });
    assert.equal(preview.length, SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT);
    assert.deepEqual(preview.map((entry) => entry.id), rooms.slice(0, 8).map((entry) => entry.id));
  });

  it("keeps an active room visible even when it falls outside the first set", () => {
    const preview = previewSidebarProjectRooms({ rooms, activeEntryId: "room:18", expanded: false });
    assert.equal(preview.length, SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT);
    assert.equal(preview.at(-1)?.id, "room:18");
  });

  it("returns the full project after an explicit expansion", () => {
    const preview = previewSidebarProjectRooms({ rooms, activeEntryId: "room:18", expanded: true });
    assert.equal(preview, rooms);
  });
});
