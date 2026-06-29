import assert from "node:assert/strict";
import test from "node:test";
import { computed, ref } from "vue";

import type {
  DesktopRepoRoomSelection,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../electron/ipc-types";
import { useDesktopSetupOnboarding } from "../src/composables/useDesktopSetupOnboarding";
import { setupEntry } from "../src/domain/desktop-navigation";
import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";

test("pickRepoRoom reports success and opens the selected repo room", async () => {
  const opened: Array<{
    snapshot: DesktopRoomSnapshot;
    options: { displayName?: string | null; kind?: string | null; rootPath?: string | null; meta?: string | null } | undefined;
  }> = [];
  const repoStatus = repoStatusFixture();
  const state = makeSetupState({
    pickResult: {
      canceled: false,
      repoPath: "/Users/emmy/Projects/letagents",
      repoStatus,
      roomIdentifier: "github.com/BrosInCode/letagents",
      source: "git_remote",
      snapshot: snapshotFixture("github.com/BrosInCode/letagents", "letagents"),
      error: null,
      warning: null,
    },
    openRoomSnapshot: (snapshot, options) => opened.push({ snapshot, options }),
  });

  const didOpen = await withDesktopBridge(state.windowBridge, () => state.onboarding.pickRepoRoom());

  assert.equal(didOpen, true);
  assert.equal(state.loading.value, false);
  assert.deepEqual(state.repoStatus.value, repoStatus);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.snapshot.roomIdentifier, "github.com/BrosInCode/letagents");
  assert.deepEqual(opened[0]?.options, {
    displayName: "letagents",
    kind: "project",
    rootPath: "/Users/emmy/Projects/letagents",
    meta: "codex/desktop-codex-room-agents",
  });
  assert.equal(state.authFeedback.value, "Project room selected: letagents. Open it when you are ready.");
});

test("pickRepoRoom reports false when the picker is canceled", async () => {
  let openCount = 0;
  const state = makeSetupState({
    pickResult: {
      canceled: true,
      repoPath: null,
      repoStatus: null,
      roomIdentifier: null,
      source: null,
      snapshot: null,
      error: null,
      warning: null,
    },
    openRoomSnapshot: () => {
      openCount += 1;
    },
  });

  const didOpen = await withDesktopBridge(state.windowBridge, () => state.onboarding.pickRepoRoom());

  assert.equal(didOpen, false);
  assert.equal(openCount, 0);
  assert.equal(state.loading.value, false);
  assert.equal(state.repoStatus.value, null);
});

function makeSetupState(input: {
  pickResult: DesktopRepoRoomSelection;
  openRoomSnapshot: (
    snapshot: DesktopRoomSnapshot,
    options?: { displayName?: string | null; kind?: string | null; rootPath?: string | null; meta?: string | null },
  ) => void;
}) {
  const loading = ref(false);
  const authFeedback = ref<string | null>(null);
  const repoStatus = ref<RepoStatus | null>(null);
  const pinnedRoom = computed<RoomEntry>(() => ({
    id: "room:main:github.com/BrosInCode/letagents",
    type: "room",
    kind: "parent",
    roomIdentifier: "github.com/BrosInCode/letagents",
    title: "letagents",
    meta: null,
    sectionLabel: "Project",
    headline: "Room",
    description: "Room",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
  }));
  const onboarding = useDesktopSetupOnboarding({
    activeEntry: ref<SidebarEntry>(setupEntry),
    authFeedback,
    authStatus: ref(null),
    firstRunStage: ref("room"),
    loading,
    loadFirstRunRoomContext: async () => undefined,
    mcpInstallBusy: ref(false),
    mcpInstallFeedback: ref(null),
    mcpInstallState: ref(null),
    mcpWizardStep: ref("choose"),
    openRoomSnapshot: input.openRoomSnapshot,
    pinnedRoom,
    refresh: async () => undefined,
    repoStatus,
    selectedMcpTargetIds: ref([]),
    setupLoadError: ref(null),
  });

  return {
    authFeedback,
    loading,
    onboarding,
    repoStatus,
    windowBridge: {
      letagentsDesktop: {
        repos: {
          pickRoom: async () => input.pickResult,
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

function repoStatusFixture(): RepoStatus {
  return {
    rootPath: "/Users/emmy/Projects/letagents",
    branch: "codex/desktop-codex-room-agents",
    worktrees: [],
  };
}

function snapshotFixture(identifier: string, displayName: string): DesktopRoomSnapshot {
  return {
    roomIdentifier: identifier,
    access: {
      status: "ready",
      title: "Ready",
      message: "Room ready",
      roomIdentifier: identifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier,
      code: identifier,
      name: displayName,
      displayName,
      role: "member",
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
      focusArchivedAt: null,
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
    roomArtifacts: [],
    messages: [],
    githubEvents: null,
  };
}
