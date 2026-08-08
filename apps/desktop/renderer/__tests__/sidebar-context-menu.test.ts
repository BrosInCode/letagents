import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopGitRoomInfo } from "../../electron/ipc-types";
import type { RoomEntry } from "../src/components/desktop/types";
import {
  buildGitRoomWebUrl,
  buildSidebarBackgroundMenuItems,
  buildSidebarRoomContextMenuItems,
} from "../src/domain/sidebar-context-menu";
import { buildRoomPinMutation } from "../src/domain/sidebar-rooms";

function roomEntry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    id: "room:parent:main",
    type: "room",
    kind: "parent",
    roomIdentifier: "ABCD-1234",
    title: "Main room",
    meta: "Room",
    sectionLabel: "Account room",
    headline: "Headline",
    description: "Description",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    pinTargetRoomIdentifier: "ABCD-1234",
    pinnedAccountRoomIdentifiers: [],
    source: "account",
    ...overrides,
  };
}

function gitRoom(overrides: {
  host?: string;
  fullName?: string;
  refType?: DesktopGitRoomInfo["ref"]["type"];
  refName?: string | null;
  headRepositoryFullName?: string | null;
} = {}): DesktopGitRoomInfo {
  const headRepositoryFullName = overrides.headRepositoryFullName ?? null;
  return {
    provider: "github",
    host: overrides.host ?? "github.com",
    repository: { id: "repo-1", fullName: overrides.fullName ?? "acme/widgets", owner: "acme", name: "widgets" },
    ref: {
      type: overrides.refType ?? "branch",
      name: overrides.refName === undefined ? "feature/login" : overrides.refName,
      defaultBranch: "main",
      baseRef: null,
      headRef: null,
      headRepository: headRepositoryFullName
        ? { id: "repo-2", fullName: headRepositoryFullName, owner: headRepositoryFullName.split("/")[0] || "", name: headRepositoryFullName.split("/")[1] || "" }
        : null,
    },
    visibility: "public",
    accessMode: "public",
    isDefault: false,
    source: "github_repository",
  } as DesktopGitRoomInfo;
}

function menuIds(groups: ReturnType<typeof buildSidebarRoomContextMenuItems>): string[] {
  return groups.flat().map((item) => item.id);
}

describe("sidebar room context menu items", () => {
  it("gives parent account rooms the full management menu", () => {
    const groups = buildSidebarRoomContextMenuItems({
      entry: roomEntry(),
      isPrimaryRoom: false,
      hasProjectChildren: true,
      projectCollapsed: false,
    });
    assert.deepEqual(menuIds(groups), [
      "open-room",
      "select-room",
      "pin-room",
      "rename-room",
      "copy-room-url",
      "toggle-project",
      "archive-room",
    ]);
  });

  it("hides archive and rename affordances on the primary room but keeps pinning", () => {
    const groups = buildSidebarRoomContextMenuItems({
      entry: roomEntry(),
      isPrimaryRoom: true,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const ids = menuIds(groups);
    assert.ok(!ids.includes("archive-room"));
    assert.ok(ids.includes("pin-room"));
    assert.ok(ids.includes("rename-room"));
  });

  it("adds mark-as-read only when the entry has unread activity", () => {
    const unread = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ hasUnread: true }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const read = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ hasUnread: false }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    assert.ok(menuIds(unread).includes("mark-room-read"));
    assert.ok(!menuIds(read).includes("mark-room-read"));
  });

  it("labels pinning from the entry's pinned state", () => {
    const pinned = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ pinned: true, pinnedAccountRoomIdentifiers: ["ABCD-1234"] }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    }).flat().find((item) => item.id === "pin-room");
    assert.equal(pinned?.label, "Unpin room");
  });

  it("keeps pinning off rooms without an account pin target", () => {
    const recent = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ source: "recent", pinTargetRoomIdentifier: null }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const synthetic = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ roomIdentifier: null, pinTargetRoomIdentifier: null }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    assert.ok(!menuIds(recent).includes("pin-room"));
    assert.ok(!menuIds(recent).includes("rename-room"));
    assert.ok(!menuIds(synthetic).includes("pin-room"));
    assert.ok(!menuIds(synthetic).includes("open-room"));
    assert.ok(!menuIds(synthetic).includes("copy-room-url"));
    assert.ok(!menuIds(synthetic).includes("select-room"));
  });

  it("offers pinning when a pin target exists even if the merged source is not account", () => {
    const current = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ source: "current" }),
      isPrimaryRoom: true,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    assert.ok(menuIds(current).includes("pin-room"));
    assert.ok(menuIds(current).includes("select-room"));
  });

  it("offers unpin on a synthetic git parent whose pin state is aggregated from branches", () => {
    const groups = buildSidebarRoomContextMenuItems({
      entry: roomEntry({
        roomIdentifier: null,
        pinned: true,
        pinTargetRoomIdentifier: "git-room:github.com:acme/widgets:branch:abc",
        pinnedAccountRoomIdentifiers: ["git-room:github.com:acme/widgets:branch:abc"],
      }),
      isPrimaryRoom: false,
      hasProjectChildren: true,
      projectCollapsed: false,
    });
    const pin = groups.flat().find((item) => item.id === "pin-room");
    assert.equal(pin?.label, "Unpin room");
  });

  it("offers branch rooms copy-branch and GitHub items", () => {
    const groups = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ kind: "branch", gitRoom: gitRoom() }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const ids = menuIds(groups);
    assert.ok(ids.includes("copy-branch-name"));
    assert.ok(ids.includes("open-on-github"));
    assert.ok(!ids.includes("archive-room"));
    assert.ok(!ids.includes("rename-room"));
  });

  it("offers active focus rooms conclude and hide actions only when lineage is known", () => {
    const withLineage = buildSidebarRoomContextMenuItems({
      entry: roomEntry({
        kind: "focus",
        focusKey: "task_12",
        focusStatus: "active",
        parentRoomIdentifier: "ABCD-1234",
        roomIdentifier: "focus_9",
      }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const withoutLineage = buildSidebarRoomContextMenuItems({
      entry: roomEntry({ kind: "focus", roomIdentifier: "focus_9" }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    const concludeItem = withLineage.flat().find((item) => item.id === "conclude-focus-room");
    const archiveItem = withLineage.flat().find((item) => item.id === "archive-focus-room");
    assert.ok(concludeItem);
    assert.equal(concludeItem.danger, undefined);
    assert.ok(archiveItem);
    assert.equal(archiveItem.danger, true);
    assert.ok(!menuIds(withoutLineage).includes("conclude-focus-room"));
    assert.ok(!menuIds(withoutLineage).includes("archive-focus-room"));
  });

  it("does not offer conclude for an already concluded focus room", () => {
    const groups = buildSidebarRoomContextMenuItems({
      entry: roomEntry({
        kind: "focus",
        focusKey: "task_12",
        focusStatus: "concluded",
        parentRoomIdentifier: "ABCD-1234",
        roomIdentifier: "focus_9",
      }),
      isPrimaryRoom: false,
      hasProjectChildren: false,
      projectCollapsed: false,
    });
    assert.ok(!menuIds(groups).includes("conclude-focus-room"));
    assert.ok(menuIds(groups).includes("archive-focus-room"));
  });

  it("labels the project toggle from the collapsed state", () => {
    const collapsed = buildSidebarRoomContextMenuItems({
      entry: roomEntry(),
      isPrimaryRoom: false,
      hasProjectChildren: true,
      projectCollapsed: true,
    }).flat().find((item) => item.id === "toggle-project");
    assert.equal(collapsed?.label, "Expand rooms");
  });
});

describe("sidebar background context menu items", () => {
  it("always offers new room and toggles the collapse label", () => {
    const expanded = buildSidebarBackgroundMenuItems({ hasProjects: true, allProjectsCollapsed: false });
    const collapsed = buildSidebarBackgroundMenuItems({ hasProjects: true, allProjectsCollapsed: true });
    const empty = buildSidebarBackgroundMenuItems({ hasProjects: false, allProjectsCollapsed: true });
    assert.deepEqual(expanded.flat().map((item) => item.id), ["new-room", "select-rooms", "set-projects-collapsed"]);
    assert.equal(expanded.flat().at(-1)?.label, "Collapse all rooms");
    assert.equal(collapsed.flat().at(-1)?.label, "Expand all rooms");
    assert.deepEqual(empty.flat().map((item) => item.id), ["new-room", "select-rooms"]);
  });
});

describe("room pin mutations", () => {
  it("pins the explicit account pin target", () => {
    assert.deepEqual(
      buildRoomPinMutation(roomEntry()),
      { pinned: true, roomIdentifiers: ["ABCD-1234"] },
    );
  });

  it("unpins every pinned account room in the group, not just the projected parent", () => {
    assert.deepEqual(
      buildRoomPinMutation(roomEntry({
        pinned: true,
        pinnedAccountRoomIdentifiers: [
          "github.com/acme/widgets",
          "git-room:github.com:acme/widgets:branch:abc",
        ],
      })),
      {
        pinned: false,
        roomIdentifiers: [
          "github.com/acme/widgets",
          "git-room:github.com:acme/widgets:branch:abc",
        ],
      },
    );
  });

  it("returns null when there is nothing to pin or unpin", () => {
    assert.equal(buildRoomPinMutation(roomEntry({ pinTargetRoomIdentifier: null })), null);
    assert.equal(
      buildRoomPinMutation(roomEntry({ pinned: true, pinnedAccountRoomIdentifiers: [] })),
      null,
    );
  });
});

describe("git room web urls", () => {
  it("links the repository page for default branch rooms", () => {
    assert.equal(
      buildGitRoomWebUrl(gitRoom({ refType: "default_branch", refName: "main" })),
      "https://github.com/acme/widgets",
    );
  });

  it("links branch tree pages and escapes ref segments", () => {
    assert.equal(
      buildGitRoomWebUrl(gitRoom({ refName: "feature/log in" })),
      "https://github.com/acme/widgets/tree/feature/log%20in",
    );
  });

  it("links fork branches to the head repository", () => {
    assert.equal(
      buildGitRoomWebUrl(gitRoom({ refName: "fix", headRepositoryFullName: "fork-owner/widgets" })),
      "https://github.com/fork-owner/widgets/tree/fix",
    );
  });

  it("links pull request rooms to their head branch, which is what ref.name holds", () => {
    assert.equal(
      buildGitRoomWebUrl(gitRoom({ refType: "pull_request", refName: "fix-login" })),
      "https://github.com/acme/widgets/tree/fix-login",
    );
    assert.equal(
      buildGitRoomWebUrl(gitRoom({
        refType: "pull_request",
        refName: "fix-login",
        headRepositoryFullName: "fork-owner/widgets",
      })),
      "https://github.com/fork-owner/widgets/tree/fix-login",
    );
  });

  it("returns null for non-github hosts and unsafe repository names", () => {
    assert.equal(buildGitRoomWebUrl(null), null);
    assert.equal(buildGitRoomWebUrl(gitRoom({ host: "gitlab.com" })), null);
    assert.equal(buildGitRoomWebUrl(gitRoom({ fullName: "acme/widgets/../evil" })), null);
  });
});
