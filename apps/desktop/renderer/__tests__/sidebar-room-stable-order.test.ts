import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopAccountRoomEntry, DesktopGitRoomInfo } from "../../electron/ipc-types";
import type { RoomEntry } from "../src/components/desktop/types";
import { buildSidebarProjectGroups } from "../src/domain/sidebar-rooms";

// A room in the sidebar keeps its place when rooms are opened. Before, the
// open room moved to the top at once, and the rest followed the server's
// "last opened" order at the next refresh of the list.

function accountRoom(roomIdentifier: string, overrides: Partial<DesktopAccountRoomEntry> = {}): DesktopAccountRoomEntry {
  return {
    roomIdentifier, displayName: roomIdentifier, name: roomIdentifier, kind: "main", parentRoomId: null, focusKey: null,
    sourceTaskId: null, focusStatus: null, role: "participant", source: "join", pinned: false, archived: false, canLeave: true,
    canDelete: false, deleteReason: null, firstOpenedAt: null, lastOpenedAt: null, latestMessageId: null, latestMessageAt: null,
    gitRoom: null, focusRooms: [], ...overrides,
  };
}
function currentRoom(roomIdentifier: string, gitRoom: DesktopGitRoomInfo | null = null): RoomEntry {
  return {
    id: `room:parent:${roomIdentifier}`, type: "room", kind: "parent", roomIdentifier, title: roomIdentifier, meta: "", sectionLabel: "",
    headline: "", description: "", gitRoom, latestMessageId: null, latestMessageAt: null, hasUnread: false, pinned: false, source: "current",
  };
}
function gitRoom(repository: string, branch: string | null): DesktopGitRoomInfo {
  const info = { id: repository, owner: "acme", name: repository, fullName: `acme/${repository}` };
  return {
    provider: "github", host: "github.com", repository: info as DesktopGitRoomInfo["repository"],
    ref: { type: branch ? "branch" : "default_branch", name: branch, defaultBranch: "main", baseRef: null, headRef: null, headRepository: null },
    visibility: "private", accessMode: "private", isDefault: !branch, source: "test",
  };
}
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")} 09:00:00.000+00`;
const titles = (current: RoomEntry, accountRooms: DesktopAccountRoomEntry[]) =>
  buildSidebarProjectGroups({ currentParentRoom: current, focusRooms: [], accountRooms }).map((group) => group.parent.roomIdentifier);

test("the room opened last is not moved to the top; rooms keep their first-opened order", () => {
  const rooms = [accountRoom("alpha", { firstOpenedAt: day(1) }), accountRoom("bravo", { firstOpenedAt: day(3) }), accountRoom("charlie", { firstOpenedAt: day(2) })];
  const expected = ["bravo", "charlie", "alpha"];
  for (const open of ["alpha", "bravo", "charlie"]) assert.deepEqual(titles(currentRoom(open), rooms), expected, `${open} is open`);
  // The server lists rooms by "last opened"; that order changes on every open.
  for (const order of [[2, 0, 1], [1, 2, 0], [0, 1, 2]]) {
    assert.deepEqual(titles(currentRoom("alpha"), order.map((index) => rooms[index]!)), expected);
  }
});

test("pinned rooms stay in front, in the same fixed order", () => {
  const rooms = [
    accountRoom("alpha", { firstOpenedAt: day(1), pinned: true }), accountRoom("bravo", { firstOpenedAt: day(3) }),
    accountRoom("charlie", { firstOpenedAt: day(2), pinned: true }), accountRoom("delta", { firstOpenedAt: day(4) }),
  ];
  assert.deepEqual(titles(currentRoom("bravo"), rooms), ["charlie", "alpha", "delta", "bravo"]);
});

test("a repository keeps the place of its first room when a branch room is added or opened", () => {
  const rooms = [
    accountRoom("plain", { firstOpenedAt: day(5) }),
    accountRoom("github.com/acme/app", { firstOpenedAt: day(2), gitRoom: gitRoom("app", null) }),
    accountRoom("old", { firstOpenedAt: day(1) }),
  ];
  const branch = accountRoom("github.com/acme/app/tree/fix", { firstOpenedAt: day(9), gitRoom: gitRoom("app", "fix") });
  const order = (current: RoomEntry, list: DesktopAccountRoomEntry[]) =>
    buildSidebarProjectGroups({ currentParentRoom: current, focusRooms: [], accountRooms: list }).map((group) => group.roomName);
  const before = order(currentRoom("plain"), rooms);
  assert.deepEqual(before, ["plain", "app", "old"]);
  assert.deepEqual(order(currentRoom("plain"), [branch, ...rooms]), before);
  assert.deepEqual(order(currentRoom(branch.roomIdentifier, branch.gitRoom), [branch, ...rooms]), before);
});

test("a room the list does not have yet, or a room with no time, stays in front", () => {
  const rooms = [accountRoom("alpha", { firstOpenedAt: day(1) }), accountRoom("no-time"), accountRoom("bravo", { firstOpenedAt: day(3) })];
  assert.deepEqual(titles(currentRoom("just-opened"), rooms), ["just-opened", "no-time", "bravo", "alpha"]);
  // Once the list has it, it is the newest room: first of the rooms that have a time.
  assert.deepEqual(titles(currentRoom("just-opened"), [accountRoom("just-opened", { firstOpenedAt: day(8) }), ...rooms]),
    ["no-time", "just-opened", "bravo", "alpha"]);
});
