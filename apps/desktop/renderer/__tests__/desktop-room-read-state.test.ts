import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasUnreadRoomActivity,
  markRoomRead,
  noRoomMessageId,
  readStoredRoomMessageIds,
  seedRoomReadMarker,
} from "../src/domain/desktop-room-read-state";

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
