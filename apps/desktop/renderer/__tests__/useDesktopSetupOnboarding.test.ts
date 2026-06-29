import assert from "node:assert/strict";
import test from "node:test";
import { computed, ref } from "vue";

import type {
  DesktopAuthStatus,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRepoRoomSelection,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../electron/ipc-types";
import { useDesktopSetupOnboarding } from "../src/composables/useDesktopSetupOnboarding";
import { setupEntry } from "../src/domain/desktop-navigation";
import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";

type OpenRoomSnapshot = (
  snapshot: DesktopRoomSnapshot,
  options?: { displayName?: string | null; kind?: string | null; rootPath?: string | null; meta?: string | null },
) => void;

interface SetupStateInput {
  authStatus?: DesktopAuthStatus | null;
  mcpInstallState?: DesktopMcpInstallState | null;
  pickResult?: DesktopRepoRoomSelection;
  pinnedRoomIdentifier?: string;
  repoStatus?: RepoStatus | null;
  openRoomSnapshot?: OpenRoomSnapshot;
  refresh?: () => Promise<void>;
  selectedMcpTargetIds?: DesktopMcpInstallTargetId[];
  setupBridge?: {
    installMcpServers?: (
      targetIds: DesktopMcpInstallTargetId[],
    ) => Promise<DesktopMcpInstallManyResult>;
    completeMcpOnboarding?: () => Promise<DesktopMcpInstallState>;
  };
}

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
  assert.equal(state.authFeedback.value, "Repo room selected: letagents. Open it when you are ready.");
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

test("first-run gate only depends on MCP completion", () => {
  const state = makeSetupState({
    mcpInstallState: mcpInstallStateFixture({ completed: false }),
  });

  assert.equal(state.onboarding.showFirstRunGate.value, true);

  state.mcpInstallState.value = mcpInstallStateFixture({ completed: true });

  assert.equal(state.onboarding.showFirstRunGate.value, false);
});

test("installSelectedMcpTargets does not pass repo cwd to global MCP install", async () => {
  const installCalls: Array<[DesktopMcpInstallTargetId[]]> = [];
  const installState = mcpInstallStateFixture({ completed: false });
  const state = makeSetupState({
    mcpInstallState: installState,
    repoStatus: repoStatusFixture(),
    selectedMcpTargetIds: ["codex"],
    setupBridge: {
      installMcpServers: async (...args: [DesktopMcpInstallTargetId[]]) => {
        installCalls.push(args);
        return {
          success: true,
          targets: installState.targets,
          installState,
          message: "installed",
        };
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.installSelectedMcpTargets());

  assert.deepEqual(installCalls, [[["codex"]]]);
});

test("finishFirstRunOnboarding completes room-code setup without reinstalling with stale cwd", async () => {
  const installCalls: DesktopMcpInstallTargetId[][] = [];
  const completedState = mcpInstallStateFixture({ completed: true });
  const state = makeSetupState({
    mcpInstallState: mcpInstallStateFixture({ completed: false }),
    pinnedRoomIdentifier: "ABCD-1234",
    repoStatus: null,
    selectedMcpTargetIds: ["codex"],
    setupBridge: {
      installMcpServers: async (targetIds) => {
        installCalls.push(targetIds);
        return {
          success: true,
          targets: [],
          installState: mcpInstallStateFixture({ completed: false }),
          message: "installed",
        };
      },
      completeMcpOnboarding: async () => completedState,
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.finishFirstRunOnboarding());

  assert.deepEqual(installCalls, []);
  assert.deepEqual(state.mcpInstallState.value, completedState);
  assert.equal(state.activeEntry.value.roomIdentifier, "ABCD-1234");
});

function makeSetupState(input: SetupStateInput = {}) {
  const roomIdentifier = input.pinnedRoomIdentifier || "github.com/BrosInCode/letagents";
  const loading = ref(false);
  const authFeedback = ref<string | null>(null);
  const repoStatus = ref<RepoStatus | null>(input.repoStatus ?? null);
  const activeEntry = ref<SidebarEntry>(setupEntry);
  const mcpInstallState = ref<DesktopMcpInstallState | null>(input.mcpInstallState ?? null);
  const pinnedRoom = computed<RoomEntry>(() => ({
    id: `room:main:${roomIdentifier}`,
    type: "room",
    kind: "parent",
    roomIdentifier,
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
    activeEntry,
    authFeedback,
    authStatus: ref(input.authStatus ?? null),
    firstRunStage: ref("room"),
    loading,
    loadFirstRunRoomContext: async () => undefined,
    mcpInstallBusy: ref(false),
    mcpInstallFeedback: ref(null),
    mcpInstallState,
    mcpWizardStep: ref("choose"),
    openRoomSnapshot: input.openRoomSnapshot ?? (() => undefined),
    pinnedRoom,
    refresh: input.refresh ?? (async () => undefined),
    repoStatus,
    selectedMcpTargetIds: ref(input.selectedMcpTargetIds ?? []),
    setupLoadError: ref(null),
  });

  return {
    activeEntry,
    authFeedback,
    loading,
    mcpInstallState,
    onboarding,
    repoStatus,
    windowBridge: {
      letagentsDesktop: {
        repos: {
          pickRoom: async () => input.pickResult ?? canceledPickResult(),
        },
        setup: input.setupBridge ?? {},
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

function canceledPickResult(): DesktopRepoRoomSelection {
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

function mcpInstallStateFixture(
  overrides: Partial<DesktopMcpInstallState> = {},
): DesktopMcpInstallState {
  return {
    completed: false,
    completedAt: null,
    selectedTargetId: "codex",
    targets: [
      {
        id: "codex",
        name: "Codex",
        description: "Add the MCP connection Codex needs to join rooms.",
        configPath: "~/.codex/config.toml",
        status: "installed",
        lastInstalledAt: "2026-06-17T00:00:00.000Z",
        restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
      },
    ],
    ...overrides,
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
