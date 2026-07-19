import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, ref, type Ref } from "vue";

import type {
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopFocusRoomInfo,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRepoRoomSelection,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopRoomSnapshot,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import { useDesktopAppData } from "../src/composables/useDesktopAppData";
import type { RecentRootRoom } from "../src/domain/sidebar-rooms";

describe("useDesktopAppData selected focus room snapshots", () => {
  it("shows an optimistic snapshot only for uncached focus room loads", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      const firstSnapshot = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = firstSnapshot.promise;

      const firstRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.equal(harness.state.selectedSnapshotLoading.value, true);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(harness.selectedSnapshot.value?.messages, []);

      firstSnapshot.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Cached focus message")],
      }));
      await firstRefresh;

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1"]);
    });
  });

  it("keeps cached focus messages visible while refreshing in the background", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Cached focus message")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const backgroundSnapshot = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = backgroundSnapshot.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");

      const backgroundRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1"]);
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);

      backgroundSnapshot.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Cached focus message"),
          roomMessage("msg_2", "Fresh focus message"),
        ],
      }));
      await backgroundRefresh;

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_2"]);
    });
  });

  it("keeps independent cached snapshots for multiple focus rooms and updates them after sends", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      harness.state.handleMessageSent(roomMessage("msg_3", "Local send in Focus A"));

      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_b", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_2", "Focus B")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_3"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await pendingFocusA;

      const focusBRefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusBRefresh.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const pendingFocusB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusBRefresh.resolve(roomSnapshot("focus_b", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_2", "Focus B"),
          roomMessage("msg_4", "Fresh Focus B"),
        ],
      }));
      await pendingFocusB;

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2", "msg_4"]);
    });
  });

  it("keeps cache current when selectedSnapshot is updated outside the data composable", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.selectedSnapshot.value = roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Focus A"),
          roomMessage("msg_5", "Live metadata refresh"),
        ],
      });

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_5"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Focus A"),
          roomMessage("msg_5", "Live metadata refresh"),
        ],
      }));
      await pendingFocusA;
    });
  });

  it("drops a cached focus snapshot after an authoritative non-ready refresh", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.nextSelectedSnapshot = Promise.resolve(nonReadySnapshot("focus_a", "forbidden"));
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      assert.equal(harness.selectedSnapshot.value?.access.status, "forbidden");

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.equal(harness.state.selectedSnapshotLoading.value, true);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), []);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_2", "Focus A restored")],
      }));
      await pendingFocusA;
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2"]);
    });
  });
});

function createHarness(): {
  accountRooms: Ref<DesktopAccountRoomEntry[]>;
  activeEntry: Ref<SidebarEntry>;
  getSnapshotRequests: Array<string | null>;
  listAccountRoomsCalls: Array<DesktopAccountRoomListOptions | undefined>;
  nextAccountRooms: DesktopAccountRoomEntry[];
  nextSelectedSnapshot: Promise<DesktopRoomSnapshot>;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  settingsAccountRooms: Ref<DesktopAccountRoomEntry[]>;
  state: ReturnType<typeof useDesktopAppData>;
  windowBridge: object;
} {
  const rootRoomSnapshot = ref(roomSnapshot("room_parent", {
    focusRooms: [
      focusRoomInfo("focus_a", "Focus A"),
      focusRoomInfo("focus_b", "Focus B"),
    ],
  }));
  const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const activeEntry = ref<SidebarEntry>(focusEntry("focus_a", "Focus A"));
  const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
  const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
  const getSnapshotRequests: Array<string | null> = [];
  const listAccountRoomsCalls: Array<DesktopAccountRoomListOptions | undefined> = [];
  const harness = {
    nextSelectedSnapshot: Promise.resolve(roomSnapshot("focus_a", {
      kind: "focus",
      parentRoomId: "room_parent",
    })),
    nextAccountRooms: [] as DesktopAccountRoomEntry[],
  };

  const state = useDesktopAppData({
    accountRooms,
    activeEntry,
    appInfo: ref<DesktopAppInfo | null>(null),
    authStatus: ref<DesktopAuthStatus | null>(null),
    currentParentRoom: computed(() => parentEntry()),
    diagnostics: ref<DiagnosticsSnapshot | null>(null),
    loading: ref(false),
    mcpInstallState: ref<DesktopMcpInstallState | null>(null),
    reconcileActiveEntry: () => undefined,
    rememberRootRoomSnapshot: () => undefined,
    recentRootRooms: ref<RecentRootRoom[]>([]),
    repoStatus: ref<RepoStatus | null>(null),
    resolveSelectedRoomIdentifier: () => activeEntry.value.type === "room" ? activeEntry.value.roomIdentifier : null,
    rootRoomSnapshot,
    scheduleLiveMetadataRefresh: () => undefined,
    selectedMcpTargetIds: ref<DesktopMcpInstallTargetId[]>([]),
    selectedRootRoomIdentifier: ref("room_parent"),
    selectedSnapshot,
    settingsAccountRooms,
    workers: ref<WorkerSnapshot[]>([]),
  });

  return {
    accountRooms,
    activeEntry,
    getSnapshotRequests,
    listAccountRoomsCalls,
    get nextAccountRooms() {
      return harness.nextAccountRooms;
    },
    set nextAccountRooms(value: DesktopAccountRoomEntry[]) {
      harness.nextAccountRooms = value;
    },
    get nextSelectedSnapshot() {
      return harness.nextSelectedSnapshot;
    },
    set nextSelectedSnapshot(value: Promise<DesktopRoomSnapshot>) {
      harness.nextSelectedSnapshot = value;
    },
    rootRoomSnapshot,
    selectedSnapshot,
    settingsAccountRooms,
    state,
    windowBridge: {
      letagentsDesktop: {
        room: {
          getSnapshot: async (roomIdentifier: string | null): Promise<DesktopRoomSnapshot> => {
            getSnapshotRequests.push(roomIdentifier);
            return harness.nextSelectedSnapshot;
          },
          listAccountRooms: async (
            options?: DesktopAccountRoomListOptions,
          ): Promise<DesktopAccountRoomEntry[]> => {
            listAccountRoomsCalls.push(options);
            return harness.nextAccountRooms;
          },
        },
        repos: {
          getStatus: async (): Promise<RepoStatus> => repoStatusFixture(),
          openRoom: async (): Promise<DesktopRepoRoomSelection> => canceledOpenRoom(),
        },
      },
    },
  };
}

async function withDesktopBridge<T>(
  value: object,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  try {
    return await callback();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

describe("useDesktopAppData refreshAccountRooms", () => {
  it("issues a single include-archived fetch and splits archived from visible rooms", async () => {
    const harness = createHarness();
    harness.nextAccountRooms = [
      accountRoomEntry("room_visible", { archived: false }),
      accountRoomEntry("room_archived", { archived: true }),
    ];

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.refreshAccountRooms();
    });

    assert.deepEqual(harness.listAccountRoomsCalls, [
      { includeArchived: true, limit: 100 },
    ]);
    assert.deepEqual(
      harness.accountRooms.value.map((room) => room.roomIdentifier),
      ["room_visible"],
    );
    assert.deepEqual(
      harness.settingsAccountRooms.value.map((room) => room.roomIdentifier),
      ["room_visible", "room_archived"],
    );
  });
});

function accountRoomEntry(
  roomIdentifier: string,
  overrides: Partial<DesktopAccountRoomEntry> = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier,
    displayName: roomIdentifier,
    name: roomIdentifier,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "participant",
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
    gitRoom: null,
    focusRooms: [],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function parentEntry(): RoomEntry {
  return {
    id: "room:parent:room_parent",
    type: "room",
    kind: "parent",
    roomIdentifier: "room_parent",
    title: "Parent Room",
    meta: "Room",
    sectionLabel: "Room",
    headline: "Parent Room",
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "current",
  };
}

function focusEntry(roomIdentifier: string, title = roomIdentifier): RoomEntry {
  return {
    id: `room:focus:${roomIdentifier}`,
    type: "room",
    kind: "focus",
    roomIdentifier,
    title,
    meta: "Focus room",
    sectionLabel: "Focus Room",
    headline: title,
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "current",
  };
}

function roomSnapshot(
  identifier: string,
  options: {
    kind?: DesktopRoomInfo["kind"];
    parentRoomId?: string | null;
    focusRooms?: DesktopFocusRoomInfo[];
    messages?: DesktopRoomMessage[];
  } = {},
): DesktopRoomSnapshot {
  const kind = options.kind || "main";
  return {
    roomIdentifier: identifier,
    access: {
      status: "ready",
      title: "",
      message: "",
      roomIdentifier: identifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier,
      code: "",
      name: identifier,
      displayName: identifier,
      role: "admin",
      authenticated: true,
      kind,
      parentRoomId: options.parentRoomId ?? null,
      focusKey: kind === "focus" ? identifier : null,
      sourceTaskId: null,
      focusStatus: kind === "focus" ? "active" : null,
      focusParentVisibility: null,
      focusActivityScope: null,
      focusGitHubEventRouting: null,
      focusSettings: null,
      focusArchivedAt: null,
      concludedAt: null,
      conclusionSummary: null,
      conclusionDetails: null,
      gitRoom: null,
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
    focusRooms: options.focusRooms || [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    roomArtifacts: [],
    messages: options.messages || [],
    githubEvents: null,
  };
}

function nonReadySnapshot(
  identifier: string,
  status: DesktopRoomSnapshot["access"]["status"],
): DesktopRoomSnapshot {
  const snapshot = roomSnapshot(identifier);
  return {
    ...snapshot,
    access: {
      ...snapshot.access,
      status,
    },
    room: null,
    messages: [],
  };
}

function focusRoomInfo(identifier: string, displayName: string): DesktopFocusRoomInfo {
  return {
    roomId: identifier,
    identifier,
    name: identifier,
    displayName,
    code: null,
    kind: "focus",
    attachmentsEnabled: true,
    parentRoomId: "room_parent",
    focusKey: identifier,
    sourceTaskId: null,
    focusStatus: "active",
    focusParentVisibility: null,
    focusActivityScope: null,
    focusGitHubEventRouting: null,
    focusSettings: null,
    focusArchivedAt: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    gitRoom: null,
    createdAt: "2026-07-02T00:00:00.000Z",
  };
}

function roomMessage(id: string, text: string): DesktopRoomMessage {
  return {
    id,
    sender: "EmmyMay",
    text,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: `2026-07-02T00:00:0${id.replace("msg_", "")}.000Z`,
    actorLabel: null,
    agentIdentity: null,
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

function messageIds(snapshot: DesktopRoomSnapshot | null): string[] {
  return snapshot?.messages.map((message) => message.id) || [];
}

function repoStatusFixture(): RepoStatus {
  return {
    rootPath: "/Users/emmy/Projects/letagents",
    branch: "staging",
    worktrees: [],
  };
}

function canceledOpenRoom(): DesktopRepoRoomSelection {
  return {
    canceled: true,
    repoPath: null,
    repoStatus: null,
    roomIdentifier: null,
    source: null,
    snapshot: null,
    error: null,
    warning: null,
  };
}
