import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";

import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
  DesktopGitRoomInfo,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../electron/ipc-types";
import { useDesktopNavigationState } from "../src/composables/useDesktopNavigationState";
import {
  resolveAccountRoomAliasIdentifier,
  type RecentRootRoom,
} from "../src/domain/sidebar-rooms";

describe("useDesktopNavigationState", () => {
  it("does not let temporary rooms inherit the active repo branch label", () => {
    withLocalStorage(() => {
      const recentRootRooms = ref<RecentRootRoom[]>([]);
      const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
      const selectedRootRoomIdentifier = ref<string | null>(null);
      const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus>({
          rootPath: "/Users/emmy/Projects/letagents",
          branch: "codex/ui-polishing",
          worktrees: [],
        }),
        rootRoomSnapshot,
        selectedRootRoomIdentifier,
        selectedSnapshot,
      });

      const snapshot = roomSnapshot("lively-falcon");
      state.openRoomSnapshot(snapshot, {
        kind: "room",
        rootPath: null,
        meta: "Temporary room",
      });

      assert.equal(recentRootRooms.value[0].kind, "room");
      assert.equal(recentRootRooms.value[0].rootPath, null);
      assert.equal(recentRootRooms.value[0].meta, "Temporary room");
      assert.equal(state.currentParentRoom.value.meta, "Temporary room");

      state.rememberRootRoomSnapshot(snapshot);

      assert.equal(recentRootRooms.value[0].rootPath, null);
      assert.equal(recentRootRooms.value[0].meta, "Temporary room");
      assert.equal(state.currentParentRoom.value.meta, "Temporary room");
    });
  });

  it("uses project folder names and live branch subtitles for project-backed rooms", () => {
    withLocalStorage(() => {
      const recentRootRooms = ref<RecentRootRoom[]>([]);
      const repoStatus = ref<RepoStatus>({
        rootPath: "/Users/emmy/Projects/letagents",
        branch: "codex/ui-polishing",
        worktrees: [],
      });
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus,
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const snapshot = roomSnapshot("github.com/BrosInCode/letagents");
      state.openRoomSnapshot(snapshot, {
        displayName: "letagents",
        kind: "project",
        rootPath: "/Users/emmy/Projects/letagents",
        meta: "codex/ui-polishing",
      });

      assert.equal(recentRootRooms.value[0].kind, "project");
      assert.equal(recentRootRooms.value[0].displayName, "letagents");
      assert.equal(state.currentParentRoom.value.title, "letagents");
      assert.equal(state.currentParentRoom.value.meta, "codex/ui-polishing");

      repoStatus.value = {
        ...repoStatus.value,
        branch: "staging",
      };

      assert.equal(state.currentParentRoom.value.meta, "staging");

      state.rememberRootRoomSnapshot(snapshot);

      assert.equal(recentRootRooms.value[0].displayName, "letagents");
      assert.equal(state.currentParentRoom.value.title, "letagents");
    });
  });

  it("replaces stale branch subtitles that were already saved for non-project rooms", () => {
    withLocalStorage(() => {
      const recentRootRooms = ref<RecentRootRoom[]>([{
        identifier: "lively-falcon",
        kind: "room",
        rootPath: null,
        displayName: "lively-falcon",
        meta: "codex/ui-polishing",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }]);
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus>({
          rootPath: "/Users/emmy/Projects/letagents",
          branch: "codex/ui-polishing",
          worktrees: [],
        }),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      state.openRoomSnapshot(roomSnapshot("lively-falcon"));

      assert.equal(recentRootRooms.value[0].meta, "JOIN-1234");
      assert.equal(state.currentParentRoom.value.meta, "JOIN-1234");
    });
  });

  it("replaces stale project aliases when an invite room is reopened by canonical id", () => {
    withLocalStorage(() => {
      const recentRootRooms = ref<RecentRootRoom[]>([{
        identifier: "CEDAR-1234",
        kind: "project",
        rootPath: "/Users/emmy/Projects/letagents",
        displayName: "cedar-vista",
        meta: "codex/ui-polishing",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }]);
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus>({
          rootPath: "/Users/emmy/Projects/letagents",
          branch: "codex/ui-polishing",
          worktrees: [],
        }),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      state.openRoomSnapshot(roomSnapshot("room_cedar", {
        accessCode: "CEDAR-1234",
        roomCode: "CEDAR-1234",
      }), {
        kind: "room",
        rootPath: null,
        meta: "Temporary room",
      });

      assert.equal(recentRootRooms.value.length, 1);
      assert.equal(recentRootRooms.value[0].identifier, "room_cedar");
      assert.equal(recentRootRooms.value[0].kind, "room");
      assert.equal(recentRootRooms.value[0].rootPath, null);
      assert.equal(recentRootRooms.value[0].meta, "Temporary room");
      assert.equal(state.currentParentRoom.value.meta, "Temporary room");
    });
  });

  it("replaces a recovered display-name alias with the canonical room id", () => {
    withLocalStorage(() => {
      const recentRootRooms = ref<RecentRootRoom[]>([{
        identifier: "sky-lake",
        kind: "project",
        rootPath: "/Users/emmy/Projects/letagents",
        displayName: "sky-lake",
        meta: "codex/ui-polishing",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }]);
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus>({
          rootPath: "/Users/emmy/Projects/letagents",
          branch: "staging",
          worktrees: [],
        }),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>("sky-lake"),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      state.openRoomSnapshot(roomSnapshot("github.com/BrosInCode/letagents", {
        displayName: "sky-lake",
      }), {
        aliasIdentifiers: ["sky-lake"],
      });

      assert.equal(recentRootRooms.value.length, 1);
      assert.equal(recentRootRooms.value[0].identifier, "github.com/BrosInCode/letagents");
      assert.equal(recentRootRooms.value[0].displayName, "sky-lake");
      assert.equal(recentRootRooms.value[0].kind, "project");
      assert.equal(recentRootRooms.value[0].rootPath, "/Users/emmy/Projects/letagents");
      assert.equal(state.currentParentRoom.value.roomIdentifier, "github.com/BrosInCode/letagents");
    });
  });

  it("preserves an existing repo room's durable root when reopened with an explicit null rootPath", () => {
    withLocalStorage(() => {
      // Regression (task_60): the account/app-agent reopen path calls
      // openRoomSnapshot with { kind: "room", rootPath: null } for a repo-backed
      // room that already has a durable project root. That explicit null must NOT
      // wipe the stored root — otherwise Add Agent later falls back to HOME and
      // the daemon convergence blocks because HOME is not a Git repo.
      const recentRootRooms = ref<RecentRootRoom[]>([{
        identifier: "github.com/BrosInCode/letagents",
        kind: "project",
        rootPath: "/Users/emmy/Projects/letagents",
        displayName: "sky-lake",
        meta: "staging",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }]);
      const state = useDesktopNavigationState({
        accountRooms: ref([]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms,
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      state.openRoomSnapshot(roomSnapshot("github.com/BrosInCode/letagents", {
        displayName: "sky-lake",
        gitRoom: gitRoom({ isDefault: true, refName: "staging" }),
      }), {
        kind: "room",
        rootPath: null,
        meta: "Admin",
        aliasIdentifiers: ["sky-lake"],
      });

      assert.equal(recentRootRooms.value.length, 1);
      assert.equal(recentRootRooms.value[0].rootPath, "/Users/emmy/Projects/letagents");
    });
  });

  it("resolves unique account room display-name aliases to canonical ids", () => {
    const rooms: DesktopAccountRoomEntry[] = [
      accountRoom("github.com/BrosInCode/letagents", "sky-lake"),
      accountRoom("room_other", "other-room"),
    ];

    assert.equal(
      resolveAccountRoomAliasIdentifier("sky-lake", rooms),
      "github.com/BrosInCode/letagents",
    );
    assert.equal(resolveAccountRoomAliasIdentifier("other-room", rooms), "room_other");
    assert.equal(resolveAccountRoomAliasIdentifier("github.com/BrosInCode/letagents", rooms), null);
  });

  it("does not resolve ambiguous account room display-name aliases", () => {
    const rooms: DesktopAccountRoomEntry[] = [
      accountRoom("room_one", "shared-name"),
      accountRoom("room_two", "shared-name"),
    ];

    assert.equal(resolveAccountRoomAliasIdentifier("shared-name", rooms), null);
  });

  it("keeps exact room identifiers ahead of another room's display alias", () => {
    const rooms: DesktopAccountRoomEntry[] = [
      accountRoom("room_one", "First room"),
      accountRoom("room_two", "room_one"),
    ];

    assert.equal(resolveAccountRoomAliasIdentifier("room_one", rooms), null);
  });

  it("deduplicates a restored room alias before its snapshot loads", () => {
    withLocalStorage(() => {
      const canonicalIdentifier = "github.com/BrosInCode/letagents";
      const defaultGitRoom = gitRoom({
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom(canonicalIdentifier, "sky-lake", { gitRoom: defaultGitRoom }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([{
          identifier: "sky-lake",
          kind: "project",
          rootPath: "/Users/emmy/Projects/letagents",
          displayName: "sky-lake",
          meta: "staging",
          updatedAt: "2026-07-13T00:00:00.000Z",
        }]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>("sky-lake"),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const matchingGroups = state.projectEntries.value.filter(
        (project) => project.parent.title === "sky-lake",
      );

      assert.equal(matchingGroups.length, 1);
      assert.equal(matchingGroups[0]?.parent.roomIdentifier, canonicalIdentifier);
      assert.equal(matchingGroups[0]?.parent.gitRoom?.repository.fullName, "BrosInCode/letagents");
      assert.equal(matchingGroups[0]?.parent.currentWorkspace, true);
    });
  });

  it("marks pinned account rooms and orders them above unpinned sidebar rooms", () => {
    withLocalStorage(() => {
      const accountRooms = ref<DesktopAccountRoomEntry[]>([
        accountRoom("room_unpinned", "Unpinned room"),
        accountRoom("room_pinned", "Pinned room", { pinned: true }),
      ]);
      const state = useDesktopNavigationState({
        accountRooms,
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      assert.equal(state.projectEntries.value[0].parent.title, "Pinned room");
      assert.equal(state.projectEntries.value[0].parent.pinned, true);
      assert.equal(state.projectEntries.value.some((project) => project.parent.title === "Unpinned room"), true);
    });
  });

  it("keeps the account room display name when the active room has a stale recent label", () => {
    withLocalStorage(() => {
      const localRoomId = "local_726155b7-ff5a-43f3-b7f3-dc8da067425f";
      const snapshot = roomSnapshot(localRoomId, { displayName: "HZLocal" });
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom(localRoomId, "HZLocal"),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([{
          identifier: localRoomId,
          kind: "room",
          rootPath: null,
          displayName: "Local room",
          meta: "Local on this device",
          updatedAt: "2026-07-03T00:00:00.000Z",
        }]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(snapshot),
        selectedRootRoomIdentifier: ref<string | null>(localRoomId),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(snapshot),
      });

      const activeGroup = state.projectEntries.value.find(
        (project) => project.parent.roomIdentifier === localRoomId,
      );
      const matchingGroups = state.projectEntries.value.filter(
        (project) => project.parent.roomIdentifier === localRoomId,
      );

      assert.equal(matchingGroups.length, 1);
      assert.equal(activeGroup?.roomName, "HZLocal");
      assert.equal(activeGroup?.parent.title, "HZLocal");
      assert.equal(activeGroup?.parent.meta, "Admin");
    });
  });

  it("labels account Git focus rooms as Git Rooms in the sidebar", () => {
    withLocalStorage(() => {
      const accountRooms = ref<DesktopAccountRoomEntry[]>([
        accountRoom("github.com/BrosInCode/letagents", "sky-lake", {
          focusRooms: [{
            roomIdentifier: "focus_201",
            displayName: "Branch: feature/git-rooms",
            name: "Branch: feature/git-rooms",
            kind: "focus",
            parentRoomId: "github.com/BrosInCode/letagents",
            focusKey: "git:branch:ZmVhdHVyZS9naXQtcm9vbXM",
            sourceTaskId: null,
            focusStatus: "active",
            role: "participant",
            source: "join",
            firstOpenedAt: null,
            lastOpenedAt: null,
            latestMessageId: null,
            latestMessageAt: null,
            gitRoom: gitRoom(),
          }],
        }),
      ]);
      const state = useDesktopNavigationState({
        accountRooms,
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const focusRoom = state.projectEntries.value
        .flatMap((project) => project.branchRooms)
        .find((room) => room.roomIdentifier === "focus_201");
      assert.equal(focusRoom?.sectionLabel, "Git Room");
      assert.equal(focusRoom?.meta, "Branch · feature/git-rooms");
      assert.equal(focusRoom?.headline, "BrosInCode/letagents");
    });
  });

  it("deduplicates the current Git focus room against the nested account focus row", () => {
    withLocalStorage(() => {
      const defaultGitRoom = gitRoom({ refType: "default_branch", refName: "main", isDefault: true });
      const branchGitRoom = gitRoom({ refName: "feature/canonical-sidebar" });
      const branchRoomIdentifier = "focus_207";
      const nestedFocusRoom: DesktopAccountRoomEntry["focusRooms"][number] = {
        roomIdentifier: branchRoomIdentifier,
        displayName: "Branch: feature/canonical-sidebar",
        name: "Branch: feature/canonical-sidebar",
        kind: "focus",
        parentRoomId: "github.com/BrosInCode/letagents",
        focusKey: "git:branch:ZmVhdHVyZS9jYW5vbmljYWwtc2lkZWJhcg",
        sourceTaskId: null,
        focusStatus: "active",
        role: "participant",
        source: "join",
        firstOpenedAt: null,
        lastOpenedAt: null,
        latestMessageId: null,
        latestMessageAt: null,
        gitRoom: branchGitRoom,
      };
      const state = useDesktopNavigationState({
        accountRooms: ref([accountRoom("github.com/BrosInCode/letagents", "sky-lake", {
          gitRoom: defaultGitRoom,
          focusRooms: [nestedFocusRoom],
        })]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref(roomSnapshot(branchRoomIdentifier, {
          displayName: "feature/canonical-sidebar",
          gitRoom: branchGitRoom,
        })),
        selectedRootRoomIdentifier: ref(branchRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );
      assert.deepEqual(group?.branchRooms.map((room) => room.roomIdentifier), [branchRoomIdentifier]);
      assert.equal(group?.focusRooms.length, 0);
      assert.equal(group?.branchRooms[0]?.kind, "focus");
      assert.equal(group?.branchRooms[0]?.parentRoomIdentifier, "github.com/BrosInCode/letagents");
      assert.equal(group?.branchRooms[0]?.focusKey, nestedFocusRoom.focusKey);
      assert.equal(group?.branchRooms[0]?.currentWorkspace, true);
    });
  });

  it("groups Git branch rooms under their repository parent", () => {
    withLocalStorage(() => {
      const defaultGitRoom = gitRoom({
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const branchGitRoom = gitRoom({
        refName: "feature/sidebar-groups",
      });
      const branchRoomIdentifier =
        "focus_202";
      const accountRooms = ref<DesktopAccountRoomEntry[]>([
        accountRoom("github.com/BrosInCode/letagents", "sky-lake", {
          gitRoom: defaultGitRoom,
        }),
        accountRoom(branchRoomIdentifier, "feature/sidebar-groups", {
          gitRoom: branchGitRoom,
        }),
      ]);
      const state = useDesktopNavigationState({
        accountRooms,
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(roomSnapshot(branchRoomIdentifier, {
          displayName: "feature/sidebar-groups",
          gitRoom: branchGitRoom,
        })),
        selectedRootRoomIdentifier: ref<string | null>(branchRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );
      assert.equal(group?.parent.title, "sky-lake");
      assert.equal(group?.parent.meta, "BrosInCode/letagents");
      assert.equal(group?.parent.currentWorkspace, false);

      const branch = group?.branchRooms.find((room) => room.kind === "branch");
      assert.equal(branch?.title, "feature/sidebar-groups");
      assert.equal(branch?.meta, "Branch · Public");
      assert.equal(branch?.suggestedAction, null);
      assert.equal(branch?.currentWorkspace, true);
      assert.equal(group?.focusRooms.length, 0);
    });
  });

  it("keeps a current Git branch child when only the default account room is listed", () => {
    withLocalStorage(() => {
      const defaultGitRoom = gitRoom({
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const branchGitRoom = gitRoom({
        refName: "feature/local-only",
      });
      const branchRoomIdentifier =
        "focus_203";
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom("github.com/BrosInCode/letagents", "sky-lake", {
            gitRoom: defaultGitRoom,
          }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(roomSnapshot(branchRoomIdentifier, {
          displayName: "feature/local-only",
          gitRoom: branchGitRoom,
        })),
        selectedRootRoomIdentifier: ref<string | null>(branchRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );
      assert.equal(group?.parent.roomIdentifier, "github.com/BrosInCode/letagents");
      assert.equal(group?.parent.currentWorkspace, false);
      assert.equal(group?.branchRooms.length, 1);
      assert.equal(group?.branchRooms[0]?.roomIdentifier, branchRoomIdentifier);
      assert.equal(group?.branchRooms[0]?.currentWorkspace, true);
    });
  });

  it("groups the current branch under the named repo room when Git repository ids differ", () => {
    withLocalStorage(() => {
      const defaultGitRoom = gitRoom({
        repositoryId: "repo-default-id",
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const branchGitRoom = gitRoom({
        repositoryId: "repo-branch-id",
        refName: "staging",
      });
      const branchRoomIdentifier =
        "focus_204";
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom("github.com/BrosInCode/letagents", "sky-lake", {
            gitRoom: defaultGitRoom,
          }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(roomSnapshot(branchRoomIdentifier, {
          displayName: "Branch: staging",
          gitRoom: branchGitRoom,
        })),
        selectedRootRoomIdentifier: ref<string | null>(branchRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const repoGroups = state.projectEntries.value.filter((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );

      assert.equal(repoGroups.length, 1);
      assert.equal(repoGroups[0]?.parent.title, "sky-lake");
      assert.equal(repoGroups[0]?.parent.roomIdentifier, "github.com/BrosInCode/letagents");
      assert.deepEqual(repoGroups[0]?.branchRooms.map((room) => room.roomIdentifier), [branchRoomIdentifier]);
      assert.equal(repoGroups[0]?.branchRooms[0]?.currentWorkspace, true);
    });
  });

  it("keeps distinct local Git repositories with the same folder name separate", () => {
    withLocalStorage(() => {
      const firstRepo = gitRoom({
        provider: "git",
        host: "local",
        repositoryId: "local:/Users/emmy/Clients/one/app",
        repositoryFullName: "app",
        repositoryOwner: "",
        repositoryName: "app",
        accessMode: "local",
        visibility: "local",
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const secondRepo = gitRoom({
        provider: "git",
        host: "local",
        repositoryId: "local:/Users/emmy/Clients/two/app",
        repositoryFullName: "app",
        repositoryOwner: "",
        repositoryName: "app",
        accessMode: "local",
        visibility: "local",
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom("local-git-room:one", "app", { gitRoom: firstRepo }),
          accountRoom("local-git-room:two", "app", { gitRoom: secondRepo }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const localGitGroups = state.projectEntries.value.filter((project) =>
        project.parent.gitRoom?.accessMode === "local"
      );
      assert.equal(localGitGroups.length, 2);
      assert.deepEqual(
        localGitGroups.map((project) => project.parent.roomIdentifier).sort(),
        ["local-git-room:one", "local-git-room:two"],
      );
    });
  });

  it("keeps all branch-only Git rooms as branch children", () => {
    withLocalStorage(() => {
      const firstBranch = gitRoom({ refName: "feature/one" });
      const secondBranch = gitRoom({ refName: "feature/two" });
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom("git-room:repo:branch:one", "feature/one", { gitRoom: firstBranch }),
          accountRoom("git-room:repo:branch:two", "feature/two", { gitRoom: secondBranch }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );

      assert.equal(group?.parent.roomIdentifier, null);
      assert.deepEqual(
        group?.branchRooms.map((room) => room.roomIdentifier).sort(),
        ["git-room:repo:branch:one", "git-room:repo:branch:two"],
      );
    });
  });

  it("keeps the current default Git room parent when account rooms only list branches", () => {
    withLocalStorage(() => {
      const defaultGitRoom = gitRoom({
        refType: "default_branch",
        refName: "main",
        isDefault: true,
      });
      const branchGitRoom = gitRoom({ refName: "feature/sidebar-only" });
      const defaultRoomIdentifier = "github.com/BrosInCode/letagents";
      const branchRoomIdentifier =
        "focus_205";
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom(branchRoomIdentifier, "feature/sidebar-only", {
            gitRoom: branchGitRoom,
          }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(roomSnapshot(defaultRoomIdentifier, {
          displayName: "sky-lake",
          gitRoom: defaultGitRoom,
        })),
        selectedRootRoomIdentifier: ref<string | null>(defaultRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );

      assert.equal(group?.parent.roomIdentifier, defaultRoomIdentifier);
      assert.equal(group?.parent.currentWorkspace, true);
      assert.deepEqual(group?.branchRooms.map((room) => room.roomIdentifier), [branchRoomIdentifier]);
    });
  });

  it("uses a repo parent instead of duplicating the current branch as parent and child", () => {
    withLocalStorage(() => {
      const branchGitRoom = gitRoom({ refName: "feature/current-branch" });
      const branchRoomIdentifier =
        "focus_206";
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom(branchRoomIdentifier, "feature/current-branch", {
            gitRoom: branchGitRoom,
          }),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(roomSnapshot(branchRoomIdentifier, {
          displayName: "feature/current-branch",
          gitRoom: branchGitRoom,
        })),
        selectedRootRoomIdentifier: ref<string | null>(branchRoomIdentifier),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const group = state.projectEntries.value.find((project) =>
        project.parent.gitRoom?.repository.fullName === "BrosInCode/letagents"
      );

      assert.equal(group?.parent.roomIdentifier, null);
      assert.deepEqual(group?.branchRooms.map((room) => room.roomIdentifier), [branchRoomIdentifier]);
      assert.equal(group?.branchRooms[0]?.currentWorkspace, true);
    });
  });

  it("does not render cached recent rooms as sidebar room rows", () => {
    withLocalStorage(() => {
      const state = useDesktopNavigationState({
        accountRooms: ref<DesktopAccountRoomEntry[]>([
          accountRoom("room_live", "Live room"),
        ]),
        activeEntryStorageKey: "active-entry",
        appInfo: ref<DesktopAppInfo>({
          appName: "LetAgents Desktop",
          platform: "darwin",
          versions: { electron: "1", chrome: "1", node: "1" },
          workspaceRoot: "/Users/emmy/Projects/letagents",
          apiUrl: "https://letagents.chat",
        }),
        recentRootRooms: ref<RecentRootRoom[]>([{
          identifier: "room_cached",
          kind: "room",
          rootPath: null,
          displayName: "Cached room",
          meta: "Temporary room",
          updatedAt: "2026-06-07T00:00:00.000Z",
        }]),
        recentRootRoomsStorageKey: "recent-root-rooms",
        repoStatus: ref<RepoStatus | null>(null),
        rootRoomSnapshot: ref<DesktopRoomSnapshot | null>(null),
        selectedRootRoomIdentifier: ref<string | null>(null),
        selectedSnapshot: ref<DesktopRoomSnapshot | null>(null),
      });

      const roomNames = state.projectEntries.value.map((project) => project.parent.title);

      assert.equal(roomNames.includes("Live room"), true);
      assert.equal(roomNames.includes("Cached room"), false);
    });
  });
});

function roomSnapshot(
  identifier: string,
  options: {
    accessCode?: string;
    roomCode?: string;
    displayName?: string;
    gitRoom?: DesktopGitRoomInfo | null;
  } = {},
): DesktopRoomSnapshot {
  const displayName = options.displayName || identifier;
  return {
    roomIdentifier: identifier,
    access: {
      status: "ready",
      title: "Room ready",
      message: "",
      roomIdentifier: identifier,
      deviceFlowUrl: null,
      code: options.accessCode || "JOIN-1234",
      httpStatus: null,
    },
    room: {
      identifier,
      code: options.roomCode || "JOIN-1234",
      name: identifier,
      displayName,
      role: "admin",
      authenticated: true,
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
      focusParentVisibility: null,
      focusActivityScope: null,
      focusGitHubEventRouting: null,
      focusSettings: null,
      concludedAt: null,
      conclusionSummary: null,
      conclusionDetails: null,
      gitRoom: options.gitRoom ?? null,
    },
    storage: {
      roomIdentifier: identifier,
      defaultMode: "cloud",
      overrideMode: "inherit",
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
      databasePath: "",
      localFilesPath: "",
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    roomArtifacts: [],
    boardSettings: {
      managerMode: "manager_optional",
      activeManager: null,
      pendingIntentCount: 0,
    },
    messages: [],
    githubEvents: null,
  };
}

function accountRoom(
  roomIdentifier: string,
  displayName: string,
  options: {
    pinned?: boolean;
    focusRooms?: DesktopAccountRoomEntry["focusRooms"];
    gitRoom?: DesktopGitRoomInfo | null;
  } = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier,
    displayName,
    name: roomIdentifier,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "admin",
    source: null,
    pinned: options.pinned || false,
    archived: false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: options.gitRoom ?? null,
    focusRooms: options.focusRooms || [],
  };
}

function gitRoom(options: {
  provider?: string;
  host?: string;
  repositoryId?: string | null;
  repositoryFullName?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  refType?: DesktopGitRoomInfo["ref"]["type"];
  refName?: string;
  accessMode?: DesktopGitRoomInfo["accessMode"];
  visibility?: DesktopGitRoomInfo["visibility"];
  isDefault?: boolean;
} = {}): DesktopGitRoomInfo {
  const refName = options.refName ?? "feature/git-rooms";
  return {
    provider: options.provider ?? "github",
    host: options.host ?? "github.com",
    repository: {
      id: options.repositoryId ?? "1",
      fullName: options.repositoryFullName ?? "BrosInCode/letagents",
      owner: options.repositoryOwner ?? "BrosInCode",
      name: options.repositoryName ?? "letagents",
    },
    ref: {
      type: options.refType ?? "branch",
      name: refName,
      defaultBranch: "main",
      baseRef: "main",
      headRef: refName,
      headRepository: null,
    },
    visibility: options.visibility ?? "public",
    accessMode: options.accessMode ?? "public",
    isDefault: options.isDefault ?? false,
    source: "webhook",
  };
}

function withLocalStorage(callback: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(): string | null {
          return null;
        },
        setItem(): void {},
      },
    },
  });
  try {
    callback();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
      return;
    }
    delete (globalThis as { window?: unknown }).window;
  }
}
