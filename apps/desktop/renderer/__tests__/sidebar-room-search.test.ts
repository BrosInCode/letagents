import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectGroup, RoomEntry } from "../src/components/desktop/types";
import { searchSidebarRooms } from "../src/domain/sidebar-room-search";

function room(id: string, title: string, overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    id,
    type: "room",
    kind: "parent",
    roomIdentifier: id,
    title,
    meta: "Room",
    sectionLabel: "Rooms",
    headline: "",
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
    ...overrides,
  };
}

const projects: ProjectGroup[] = [{
  id: "project:sky-lake",
  roomName: "sky-lake",
  parent: room("room:sky-lake", "sky-lake", { pinned: true }),
  branchRooms: [room("room:branch:search", "Sidebar search", {
    kind: "branch",
    meta: "feature/sidebar-search",
  })],
  focusRooms: [room("room:focus:142", "Attachment Work", {
    kind: "focus",
    focusKey: "task_142",
    meta: "Focus room",
  })],
}];

describe("sidebar room search", () => {
  it("matches room titles, project names, branch metadata, and task keys", () => {
    assert.deepEqual(searchSidebarRooms(projects, "attachment").map((result) => result.entry.id), ["room:focus:142"]);
    assert.deepEqual(searchSidebarRooms(projects, "sidebar search").map((result) => result.entry.id), ["room:branch:search"]);
    assert.deepEqual(searchSidebarRooms(projects, "task_142").map((result) => result.entry.id), ["room:focus:142"]);
    assert.equal(searchSidebarRooms(projects, "sky-lake").length, 3);
  });

  it("excludes synthetic parents that cannot be opened and respects the result limit", () => {
    const syntheticProjects = [{
      ...projects[0]!,
      parent: room("room:synthetic", "Synthetic", { roomIdentifier: null }),
    }];
    assert.deepEqual(searchSidebarRooms(syntheticProjects, "synthetic"), []);
    assert.equal(searchSidebarRooms(projects, "sky-lake", 1).length, 1);
  });

  it("returns no results before a query is entered", () => {
    assert.deepEqual(searchSidebarRooms(projects, "  "), []);
  });
});
