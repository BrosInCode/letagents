import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "../src/domain/chat-scroll";

describe("desktop chat scroll memory", () => {
  it("ignores loading-time scroll reports from the selected room", () => {
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "ROOM_FOCUS",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: true,
    }), false);
  });

  it("keeps real scroll reports and previous-room reports during a room switch", () => {
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "room_focus",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: false,
    }), true);
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "room_previous",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: true,
    }), true);
  });

  it("uses normalized storage keys and suppresses rooms with pending loading scroll", () => {
    assert.equal(chatScrollPositionKey(" ROOM_FOCUS "), "room_focus");
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "ROOM_FOCUS",
      selectedRoomIdentifier: "room_parent",
      selectedSnapshotLoading: false,
      suppressedRoomIdentifiers: new Set(["room_focus"]),
    }), false);
  });
});
