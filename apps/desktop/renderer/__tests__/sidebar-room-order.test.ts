import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectGroup, RoomEntry } from "../src/components/desktop/types";
import { previewSidebarProjectRooms } from "../src/domain/sidebar-project-room-preview";
import {
  applySidebarRoomOrder,
  isSidebarRoomReorderEnabled,
  orderedSidebarChildRooms,
  readStoredSidebarRoomOrder,
  rememberSidebarRoomOrder,
  reorderSidebarChildRooms,
  reorderSidebarParentRooms,
  resolveSidebarKeyboardRoomReorder,
  type SidebarRoomOrder,
} from "../src/domain/sidebar-room-order";

function room(id: string, kind: RoomEntry["kind"] = "parent", pinned = false): RoomEntry {
  return {
    id,
    type: "room",
    kind,
    roomIdentifier: id,
    title: id,
    meta: "Room",
    sectionLabel: "Room",
    headline: "",
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned,
    source: "account",
  };
}

function project(
  id: string,
  options: { pinned?: boolean; branches?: string[]; focuses?: string[] } = {},
): ProjectGroup {
  return {
    id,
    roomName: id,
    parent: room(`${id}:parent`, "parent", options.pinned),
    branchRooms: (options.branches || []).map((entryId) => room(entryId, "branch")),
    focusRooms: (options.focuses || []).map((entryId) => room(entryId, "focus")),
  };
}

describe("sidebar room order", () => {
  it("reads only valid persisted room ids and tolerates broken storage", () => {
    const parsed = readStoredSidebarRoomOrder({
      getItem: () => JSON.stringify({
        pinnedParentIds: ["pinned-b", "pinned-b", 42, ""],
        roomParentIds: "not-an-array",
        childIdsByProject: {
          project: ["focus-b", null, "focus-a"],
          invalid: "not-an-array",
        },
      }),
    }, "room-order");

    assert.deepEqual(parsed, {
      pinnedParentIds: ["pinned-b"],
      roomParentIds: [],
      childIdsByProject: {
        project: ["focus-b", "focus-a"],
        invalid: [],
      },
    });
    assert.deepEqual(readStoredSidebarRoomOrder({ getItem: () => "{" }, "room-order"), {
      pinnedParentIds: [],
      roomParentIds: [],
      childIdsByProject: {},
    });
  });

  it("persists without making unavailable storage a navigation failure", () => {
    const stored: string[] = [];
    const order: SidebarRoomOrder = {
      pinnedParentIds: ["pinned"],
      roomParentIds: ["room"],
      childIdsByProject: {},
    };
    rememberSidebarRoomOrder({ setItem: (_key, value) => stored.push(value) }, "room-order", order);
    assert.deepEqual(JSON.parse(stored[0] || "{}"), order);
    assert.doesNotThrow(() => rememberSidebarRoomOrder({
      setItem: () => { throw new Error("unavailable"); },
    }, "room-order", order));
  });

  it("applies remembered parent and mixed child order while appending new rooms", () => {
    const projects = [
      project("pinned-a", { pinned: true }),
      project("pinned-b", { pinned: true }),
      project("room-a", { branches: ["branch-a", "branch-new"], focuses: ["focus-a"] }),
      project("room-new"),
    ];
    const applied = applySidebarRoomOrder(projects, {
      pinnedParentIds: ["pinned-b", "pinned-a", "stale-parent"],
      roomParentIds: ["room-a", "stale-room"],
      childIdsByProject: {
        "room-a": ["focus-a", "branch-a", "stale-child"],
      },
    });

    assert.deepEqual(applied.map((entry) => entry.id), ["pinned-b", "pinned-a", "room-a", "room-new"]);
    assert.deepEqual(orderedSidebarChildRooms(applied[2]).map((entry) => entry.id), [
      "focus-a",
      "branch-a",
      "branch-new",
    ]);
  });

  it("reorders parent rooms only inside their pinned or unpinned section", () => {
    const projects = [
      project("pinned-a", { pinned: true }),
      project("pinned-b", { pinned: true }),
      project("room-a"),
      project("room-b"),
    ];
    const reordered = reorderSidebarParentRooms(projects, {
      sourceProjectId: "room-b",
      targetProjectId: "room-a",
      placement: "before",
    });
    assert.deepEqual(reordered?.roomParentIds, ["room-b", "room-a"]);
    assert.deepEqual(reordered?.pinnedParentIds, ["pinned-a", "pinned-b"]);

    assert.equal(reorderSidebarParentRooms(projects, {
      sourceProjectId: "room-a",
      targetProjectId: "pinned-a",
      placement: "before",
    }), null);
  });

  it("reorders subrooms inside one parent and rejects cross-parent moves", () => {
    const projects = [
      project("room-a", { branches: ["branch-a"], focuses: ["focus-a", "focus-b"] }),
      project("room-b", { focuses: ["focus-c"] }),
    ];
    const reordered = reorderSidebarChildRooms(projects, {
      projectId: "room-a",
      sourceEntryId: "focus-b",
      targetEntryId: "branch-a",
      placement: "before",
    });
    assert.deepEqual(reordered?.childIdsByProject["room-a"], ["focus-b", "branch-a", "focus-a"]);

    assert.equal(reorderSidebarChildRooms(projects, {
      projectId: "room-a",
      sourceEntryId: "focus-a",
      targetEntryId: "focus-c",
      placement: "after",
    }), null);
  });

  it("keeps keyboard focus in the rendered preview at the overflow boundary", () => {
    const allChildren = Array.from({ length: 12 }, (_, index) => room(`child-${index + 1}`, "focus"));
    const visibleChildren = previewSidebarProjectRooms({
      rooms: allChildren,
      activeEntryId: "parent-room",
      expanded: false,
    });
    assert.equal(visibleChildren.length, 8);
    const lastVisible = visibleChildren.at(-1);
    assert.ok(lastVisible);

    assert.equal(resolveSidebarKeyboardRoomReorder(
      visibleChildren,
      lastVisible.id,
      1,
    ), null);
    assert.deepEqual(resolveSidebarKeyboardRoomReorder(
      visibleChildren,
      lastVisible.id,
      -1,
    ), {
      target: visibleChildren[6],
      placement: "before",
    });
  });

  it("disables every reorder gesture while selection or a batch action is active", () => {
    assert.equal(isSidebarRoomReorderEnabled(false, false), true);
    assert.equal(isSidebarRoomReorderEnabled(true, false), false);
    assert.equal(isSidebarRoomReorderEnabled(false, true), false);
  });
});
