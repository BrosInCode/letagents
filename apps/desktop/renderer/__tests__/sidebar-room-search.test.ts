import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectGroup, RoomEntry } from "../src/components/desktop/types";
import { sidebarProjectForEntry, sidebarRoomSwitchOptions } from "../src/domain/sidebar-zen-mode";
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


describe("Zen Mode room scope and switcher", () => {
  it("resolves parent, branch and focus selections to the same sidebar group", () => {
    for (const entry of [projects[0].parent, ...projects[0].branchRooms, ...projects[0].focusRooms]) {
      assert.equal(sidebarProjectForEntry(projects, entry.id), projects[0]);
    }
    assert.equal(sidebarProjectForEntry(projects, "system:settings"), null);
    assert.equal(sidebarProjectForEntry([], "missing"), null);
  });

  it("lists every parent in existing order before searching", () => {
    const other = { ...projects[0], id: "other", roomName: "Other", parent: room("other", "Other"), branchRooms: [], focusRooms: [] };
    assert.deepEqual(sidebarRoomSwitchOptions([other, ...projects], " ").map(({entry}) => entry.id), ["other", "room:sky-lake"]);
    assert.equal(sidebarRoomSwitchOptions(projects, "")[0].title, "sky-lake");
  });

  it("offers real children when a repository heading cannot be opened", () => {
    const synthetic = { ...projects[0], parent: room("synthetic", "Repo", { roomIdentifier: null }) };
    const options = sidebarRoomSwitchOptions([synthetic], "");
    assert.deepEqual(options.map(({entry}) => entry.id), ["room:branch:search", "room:focus:142"]);
    assert.ok(options.every(({entry, projectId}) => entry.roomIdentifier && projectId === synthetic.id));
    assert.deepEqual(sidebarRoomSwitchOptions([{ ...synthetic, branchRooms: [], focusRooms: [] }], ""), []);
  });

  it("searches focus rooms and branches across the full room list", () => {
    const options = sidebarRoomSwitchOptions(projects, "task_142");
    assert.equal(options.length, 1);
    assert.equal(options[0].entry, projects[0].focusRooms[0]);
    assert.equal(options[0].projectId, projects[0].id);
    assert.deepEqual(sidebarRoomSwitchOptions(projects, "no such room"), []);
  });
});
