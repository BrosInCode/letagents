import assert from "node:assert/strict";
import test from "node:test";

import { startupRoomNeedsProjectBindings } from "../src/composables/app/useAppProjectRepo";
import { rootRoomEntryId, type RecentRootRoom } from "../src/domain/sidebar-rooms";

function recent(identifier: string, kind: RecentRootRoom["kind"], rootPath: string | null = null): RecentRootRoom {
  return { identifier, kind, rootPath, displayName: identifier, meta: "", updatedAt: "2026-11-10T00:00:00.000Z" };
}

const recentRooms = [
  recent("plain-room", "room"),
  recent("old-room", "room"),
  recent("github.com/acme/widgets", "project", "/Users/me/widgets"),
];

test("a plain cloud root room does not wait for the project bindings", () => {
  for (const activeEntryId of [null, rootRoomEntryId("plain-room"), "messages"]) {
    assert.equal(startupRoomNeedsProjectBindings({
      rootRoomIdentifier: "plain-room",
      activeEntryId,
      recentRootRooms: recentRooms,
      legacyRootBindings: { "github.com/acme/widgets": "/Users/me/widgets" },
    }), false, String(activeEntryId));
  }
});

test("a room that can be a project room waits for the project bindings", () => {
  const cases: Array<[string | null, string | null]> = [
    // The project room itself, by its remembered folder.
    ["github.com/acme/widgets", null],
    // Any Git Room, also one not remembered with a folder.
    ["github.com/acme/gadgets", null],
    ["git-room:local:abc123", null],
    ["local-widgets-0123456789", null],
    // A room that a legacy binding names, or one never seen before.
    ["old-room", null],
    ["unknown-room", null],
    [null, null],
    // A plain root, but the restored view is a project or a focus room.
    ["plain-room", rootRoomEntryId("github.com/acme/widgets")],
    ["plain-room", "room:focus:1234"],
    ["plain-room", "project:git:github:github.com:acme/widgets"],
  ];
  for (const [rootRoomIdentifier, activeEntryId] of cases) {
    assert.equal(startupRoomNeedsProjectBindings({
      rootRoomIdentifier,
      activeEntryId,
      recentRootRooms: recentRooms,
      legacyRootBindings: { "github.com/acme/widgets": "/Users/me/widgets", "old-room": "/Users/me/old" },
    }), true, `${rootRoomIdentifier} / ${activeEntryId}`);
  }
});
