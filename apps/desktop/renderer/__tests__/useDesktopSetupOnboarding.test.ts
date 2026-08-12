import assert from "node:assert/strict";
import test from "node:test";
import { computed, ref } from "vue";

import type {
  DesktopAuthStatus,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRepoRoomSelection,
  DesktopRoomAccess,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../electron/ipc-types";
import { useDesktopSetupOnboarding } from "../src/composables/useDesktopSetupOnboarding";
import { setupEntry } from "../src/domain/desktop-navigation";
import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "../src/components/desktop/setup/types";

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
  firstRunStage?: FirstRunWizardStage;
  mcpWizardStep?: DesktopMcpWizardStep;
  initialBootstrapTimeoutMs?: number;
  roomBridge?: {
    getSnapshot?: (roomIdentifier: string | null) => Promise<DesktopRoomSnapshot>;
  };
  authBridge?: {
    getStatus?: () => Promise<DesktopAuthStatus>;
  };
  setupBridge?: {
    getMcpInstallState?: () => Promise<DesktopMcpInstallState>;
    installMcpServers?: (
      targetIds: DesktopMcpInstallTargetId[],
    ) => Promise<DesktopMcpInstallManyResult>;
    completeMcpOnboarding?: () => Promise<DesktopMcpInstallState>;
  };
  workersBridge?: {
    runAgentProviderPreflight?: (
      providerId: DesktopAgentProviderId,
      input?: object,
    ) => Promise<DesktopAgentProviderPreflight>;
    runAgentProviderSetup?: (
      providerId: DesktopAgentProviderId,
      input: DesktopAgentProviderSetupInput,
    ) => Promise<DesktopAgentProviderSetupResult>;
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
  assert.equal(state.authFeedback.value, "Room selected: letagents. Open it when you are ready.");
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

test("first-run setup shows splash while unresolved and gates incomplete MCP", () => {
  const state = makeSetupState();

  assert.equal(state.onboarding.showFirstRunSplash.value, true);
  assert.equal(state.onboarding.showFirstRunGate.value, false);

  state.setupLoadError.value = "Setup could not load yet.";

  assert.equal(state.onboarding.showFirstRunSplash.value, false);
  assert.equal(state.onboarding.showFirstRunGate.value, false);

  state.setupLoadError.value = null;
  state.mcpInstallState.value = mcpInstallStateFixture({ completed: false });

  assert.equal(state.onboarding.showFirstRunSplash.value, true);
  assert.equal(state.onboarding.showFirstRunGate.value, true);

  state.mcpInstallState.value = mcpInstallStateFixture({ completed: true });

  assert.equal(state.onboarding.showFirstRunSplash.value, true);
  assert.equal(state.onboarding.showFirstRunGate.value, false);
});

test("loadFirstRunSetup lands incomplete setup on welcome after setup check", async () => {
  const installState = mcpInstallStateFixture({ completed: false });
  const state = makeSetupState({
    setupBridge: {
      getMcpInstallState: async () => installState,
    },
    authBridge: {
      getStatus: async () => authStatusFixture({ authenticated: false }),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.loadFirstRunSetup());

  assert.equal(state.firstRunStage.value, "welcome");
  assert.equal(state.onboarding.firstRunRoomSelected.value, false);
  assert.equal(state.onboarding.showFirstRunSplash.value, false);
  assert.equal(state.onboarding.showFirstRunGate.value, true);
  assert.deepEqual(state.mcpInstallState.value, installState);
  assert.equal(state.authStatus.value?.authenticated, false);
});

test("loadFirstRunSetup refreshes completed setup even when GitHub is skipped", async () => {
  let refreshCount = 0;
  const installState = mcpInstallStateFixture({ completed: true });
  const state = makeSetupState({
    refresh: async () => {
      refreshCount += 1;
    },
    setupBridge: {
      getMcpInstallState: async () => installState,
    },
    authBridge: {
      getStatus: async () => authStatusFixture({ authenticated: false }),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.loadFirstRunSetup());

  assert.equal(state.firstRunStage.value, "github");
  assert.equal(state.onboarding.showFirstRunGate.value, false);
  assert.equal(refreshCount, 1);
});

test("initial splash remains visible until the first room refresh completes", async () => {
  let finishRefresh: (() => void) | null = null;
  const refreshPending = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const state = makeSetupState({
    refresh: () => refreshPending,
    setupBridge: {
      getMcpInstallState: async () => mcpInstallStateFixture({ completed: true }),
    },
    authBridge: {
      getStatus: async () => authStatusFixture({ authenticated: false }),
    },
  });

  const loadPromise = withDesktopBridge(state.windowBridge, () => state.onboarding.loadFirstRunSetup());
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(state.mcpInstallState.value?.completed, true);
  assert.equal(state.onboarding.showFirstRunSplash.value, true);

  finishRefresh?.();
  await loadPromise;

  assert.equal(state.onboarding.showFirstRunSplash.value, false);
});

test("initial splash yields when the first room refresh stalls", async () => {
  const state = makeSetupState({
    initialBootstrapTimeoutMs: 5,
    refresh: () => new Promise<void>(() => undefined),
    setupBridge: {
      getMcpInstallState: async () => mcpInstallStateFixture({ completed: true }),
    },
    authBridge: {
      getStatus: async () => authStatusFixture({ authenticated: false }),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.loadFirstRunSetup());

  assert.equal(state.onboarding.showFirstRunSplash.value, false);
  assert.equal(state.loading.value, false);
  assert.equal(state.setupLoadError.value, null);
});

test("startFirstRunSetup advances welcome to MCP choose step", () => {
  const state = makeSetupState({
    firstRunStage: "welcome",
    mcpWizardStep: "done",
  });

  state.authFeedback.value = "old auth feedback";
  state.mcpInstallFeedback.value = "old mcp feedback";
  state.setupLoadError.value = "old setup error";

  state.onboarding.startFirstRunSetup();

  assert.equal(state.firstRunStage.value, "mcp");
  assert.equal(state.mcpWizardStep.value, "choose");
  assert.equal(state.authFeedback.value, null);
  assert.equal(state.mcpInstallFeedback.value, null);
  assert.equal(state.setupLoadError.value, null);
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

test("installSelectedMcpTargets installs missing Codex runtime before MCP bridge", async () => {
  const installCalls: Array<[DesktopMcpInstallTargetId[]]> = [];
  const runtimeCalls: Array<[string, DesktopAgentProviderSetupInput]> = [];
  const installState = mcpInstallStateFixture({ completed: false });
  const state = makeSetupState({
    mcpInstallState: installState,
    selectedMcpTargetIds: ["codex"],
    setupBridge: {
      installMcpServers: async (...args: [DesktopMcpInstallTargetId[]]) => {
        installCalls.push(args);
        return {
          success: true,
          targets: installState.targets,
          installState,
          message: "MCP bridge installed.",
        };
      },
    },
    workersBridge: {
      runAgentProviderPreflight: async (providerId) => ({
        providerId,
        status: "missing_runtime",
        canStart: false,
        message: "Codex is not installed.",
        detail: "Install Codex.",
        nextAction: "install_runtime",
        version: null,
        mcpStatus: "not_installed",
      }),
      runAgentProviderSetup: async (providerId, input) => {
        runtimeCalls.push([providerId, input]);
        return {
          providerId,
          action: input.action,
          success: true,
          message: "Codex was installed.",
          detail: null,
        };
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.installSelectedMcpTargets());

  assert.deepEqual(runtimeCalls, [["codex", { action: "install_runtime", confirmed: true }]]);
  assert.deepEqual(installCalls, [[["codex"]]]);
  assert.equal(state.mcpInstallFeedback.value, "Codex was installed. MCP bridge installed.");
});

test("installSelectedMcpTargets skips Codex runtime install when CLI is already present", async () => {
  const installCalls: Array<[DesktopMcpInstallTargetId[]]> = [];
  let runtimeSetupCount = 0;
  const installState = mcpInstallStateFixture({ completed: false });
  const state = makeSetupState({
    mcpInstallState: installState,
    selectedMcpTargetIds: ["codex"],
    setupBridge: {
      installMcpServers: async (...args: [DesktopMcpInstallTargetId[]]) => {
        installCalls.push(args);
        return {
          success: true,
          targets: installState.targets,
          installState,
          message: "MCP bridge installed.",
        };
      },
    },
    workersBridge: {
      runAgentProviderPreflight: async (providerId) => ({
        providerId,
        status: "bridge_required",
        canStart: false,
        message: "Codex needs the LetAgents bridge.",
        detail: "Install MCP.",
        nextAction: "install_mcp_bridge",
        version: "codex 1.0.0",
        mcpStatus: "not_installed",
      }),
      runAgentProviderSetup: async (providerId, input) => {
        runtimeSetupCount += 1;
        return {
          providerId,
          action: input.action,
          success: true,
          message: "Unexpected setup.",
          detail: null,
        };
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.installSelectedMcpTargets());

  assert.equal(runtimeSetupCount, 0);
  assert.deepEqual(installCalls, [[["codex"]]]);
  assert.equal(state.mcpInstallFeedback.value, "Codex CLI is already installed. MCP bridge installed.");
});

test("installSelectedMcpTargets stays on install step when MCP validation still needs attention", async () => {
  const initialState = mcpInstallStateFixture({ completed: false });
  const failedTarget = {
    ...initialState.targets[0],
    status: "needs_attention" as const,
    configIssue:
      "Codex config: Uses local dev backend http://localhost:3001, but no local API is reachable.",
    configPaths: [
      {
        path: "~/.codex/config.toml",
        label: "Codex config",
        status: "needs_attention" as const,
        hasLetAgents: true,
        issue:
          "Uses local dev backend http://localhost:3001, but no local API is reachable.",
      },
    ],
  };
  const failedState = mcpInstallStateFixture({
    completed: false,
    targets: [failedTarget],
  });
  const state = makeSetupState({
    mcpInstallState: initialState,
    mcpWizardStep: "choose",
    selectedMcpTargetIds: ["codex"],
    setupBridge: {
      installMcpServers: async () => ({
        success: true,
        targets: [failedTarget],
        installState: failedState,
        message: "LetAgents could not verify Codex.",
      }),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.installSelectedMcpTargets());

  assert.equal(state.mcpWizardStep.value, "install");
  assert.equal(state.mcpInstallFeedback.value, "LetAgents could not verify Codex.");
  assert.deepEqual(state.mcpInstallState.value, failedState);
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
    roomBridge: {
      getSnapshot: async () => snapshotFixture("ABCD-1234", "ABCD-1234"),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.joinRoomCode("ABCD-1234"));
  await withDesktopBridge(state.windowBridge, () => state.onboarding.finishFirstRunOnboarding());

  assert.deepEqual(installCalls, []);
  assert.deepEqual(state.mcpInstallState.value, completedState);
  assert.equal(state.activeEntry.value.roomIdentifier, "ABCD-1234");
});

test("finishFirstRunOnboarding requires an explicit room choice", async () => {
  let completed = false;
  const state = makeSetupState({
    pinnedRoomIdentifier: "github.com/BrosInCode/letagents",
    setupBridge: {
      completeMcpOnboarding: async () => {
        completed = true;
        return mcpInstallStateFixture({ completed: true });
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.finishFirstRunOnboarding());

  assert.equal(completed, false);
  assert.equal(state.authFeedback.value, "Choose a repo room or join with a room code first.");
});

test("joinRoomCode does not select inaccessible room snapshots", async () => {
  let openCount = 0;
  const state = makeSetupState({
    openRoomSnapshot: () => {
      openCount += 1;
    },
    roomBridge: {
      getSnapshot: async () => snapshotFixture("MISSING", "MISSING", {
        status: "unavailable",
        title: "Room unavailable",
        message: "Room not found.",
      }),
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.joinRoomCode("MISSING"));

  assert.equal(openCount, 0);
  assert.equal(state.onboarding.firstRunRoomSelected.value, false);
  assert.equal(state.authFeedback.value, "Room not found.");
});

test("pickRepoRoom does not select unavailable repo room snapshots", async () => {
  let openCount = 0;
  const state = makeSetupState({
    pickResult: {
      canceled: false,
      repoPath: "/Users/emmy/Projects/private",
      repoStatus: repoStatusFixture(),
      roomIdentifier: "github.com/BrosInCode/private",
      source: "git_remote",
      snapshot: snapshotFixture("github.com/BrosInCode/private", "private", {
        status: "forbidden",
        title: "This account cannot open the room",
        message: "Ask for access to this repository.",
      }),
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
  assert.equal(state.onboarding.firstRunRoomSelected.value, false);
  assert.equal(state.authFeedback.value, "Ask for access to this repository.");
});

test("auth-required room selection requires GitHub before completion", async () => {
  let completed = false;
  const authRequiredSnapshot = snapshotFixture("github.com/BrosInCode/private", "private", {
    status: "auth_required",
    title: "Connect GitHub to open this room",
    message: "Connect GitHub before opening this private room.",
  });
  const state = makeSetupState({
    authStatus: authStatusFixture({ authenticated: false }),
    pinnedRoomIdentifier: "github.com/BrosInCode/private",
    roomBridge: {
      getSnapshot: async () => authRequiredSnapshot,
    },
    setupBridge: {
      completeMcpOnboarding: async () => {
        completed = true;
        return mcpInstallStateFixture({ completed: true });
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.joinRoomCode("github.com/BrosInCode/private"));
  await withDesktopBridge(state.windowBridge, () => state.onboarding.finishFirstRunOnboarding());

  assert.equal(state.onboarding.firstRunRoomSelected.value, true);
  assert.equal(completed, false);
  assert.equal(state.authFeedback.value, "Connect GitHub before opening this private room.");
});

test("failed room-code selection clears any stale first-run room choice", async () => {
  let snapshotCalls = 0;
  const state = makeSetupState({
    roomBridge: {
      getSnapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return snapshotFixture("ABCD-1234", "ABCD-1234");
        throw new Error("Room not found.");
      },
    },
  });

  await withDesktopBridge(state.windowBridge, () => state.onboarding.joinRoomCode("ABCD-1234"));

  assert.equal(state.onboarding.firstRunRoomSelected.value, true);

  await withDesktopBridge(state.windowBridge, () => state.onboarding.joinRoomCode("MISSING"));

  assert.equal(state.onboarding.firstRunRoomSelected.value, false);
  assert.equal(state.authFeedback.value, "Room not found.");
});

function makeSetupState(input: SetupStateInput = {}) {
  const roomIdentifier = input.pinnedRoomIdentifier || "github.com/BrosInCode/letagents";
  const loading = ref(false);
  const authFeedback = ref<string | null>(null);
  const authStatus = ref<DesktopAuthStatus | null>(input.authStatus ?? null);
  const repoStatus = ref<RepoStatus | null>(input.repoStatus ?? null);
  const activeEntry = ref<SidebarEntry>(setupEntry);
  const mcpInstallState = ref<DesktopMcpInstallState | null>(input.mcpInstallState ?? null);
  const firstRunStage = ref<FirstRunWizardStage>(input.firstRunStage ?? "welcome");
  const mcpWizardStep = ref<DesktopMcpWizardStep>(input.mcpWizardStep ?? "choose");
  const mcpInstallFeedback = ref<string | null>(null);
  const setupLoadError = ref<string | null>(null);
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
    authStatus,
    firstRunStage,
    loading,
    mcpInstallBusy: ref(false),
    mcpInstallFeedback,
    mcpInstallState,
    mcpWizardStep,
    openRoomSnapshot: input.openRoomSnapshot ?? (() => undefined),
    pinnedRoom,
    refresh: input.refresh ?? (async () => undefined),
    repoStatus,
    selectedMcpTargetIds: ref(input.selectedMcpTargetIds ?? []),
    setupLoadError,
    initialBootstrapTimeoutMs: input.initialBootstrapTimeoutMs,
  });

  return {
    activeEntry,
    authFeedback,
    authStatus,
    firstRunStage,
    loading,
    mcpInstallFeedback,
    mcpInstallState,
    mcpWizardStep,
    onboarding,
    repoStatus,
    setupLoadError,
    windowBridge: {
      letagentsDesktop: {
        auth: input.authBridge ?? {
          getStatus: async () => authStatus.value ?? authStatusFixture(),
        },
        repos: {
          pickRoom: async () => input.pickResult ?? canceledPickResult(),
        },
        room: input.roomBridge ?? {},
        setup: input.setupBridge ?? {},
        workers: input.workersBridge ?? {},
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
        description: "We'll install Codex CLI if it is missing, then add the MCP bridge.",
        configPath: "~/.codex/config.toml",
        configPaths: [
          {
            path: "~/.codex/config.toml",
            label: "Codex config",
            status: "installed",
            hasLetAgents: true,
            issue: null,
          },
        ],
        configIssue: null,
        status: "installed",
        lastInstalledAt: "2026-06-17T00:00:00.000Z",
        restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
      },
    ],
    ...overrides,
  };
}

function authStatusFixture(overrides: Partial<DesktopAuthStatus> = {}): DesktopAuthStatus {
  return {
    authenticated: true,
    account: {
      id: "acct_1",
      provider: "github",
      providerUserId: "user_1",
      login: "emmy",
      displayName: "Emmy",
      avatarUrl: null,
    },
    pendingDeviceAuth: null,
    apiUrl: "https://letagents.chat",
    tokenStored: true,
    error: null,
    ...overrides,
  };
}

function snapshotFixture(
  identifier: string,
  displayName: string,
  accessOverrides: Partial<DesktopRoomAccess> = {},
): DesktopRoomSnapshot {
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
      ...accessOverrides,
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
    boardSettings: {
      managerMode: "manager_optional",
      activeManager: null,
      pendingIntentCount: 0,
    },
    messages: [],
    githubEvents: null,
  };
}
