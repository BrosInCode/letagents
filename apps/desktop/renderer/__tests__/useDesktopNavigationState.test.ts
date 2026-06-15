import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";

import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
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
});

function roomSnapshot(
  identifier: string,
  options: { accessCode?: string; roomCode?: string; displayName?: string } = {},
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
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    messages: [],
    githubEvents: null,
  };
}

function accountRoom(roomIdentifier: string, displayName: string): DesktopAccountRoomEntry {
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
    pinned: false,
    archived: false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    focusRooms: [],
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
