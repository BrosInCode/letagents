<template>
  <main v-if="showFirstRunGate" class="desktop-onboarding-shell" data-testid="desktop-first-run-onboarding">
    <FirstRunOnboardingView
      :stage="firstRunStage"
      :mcp-state="visibleMcpInstallState"
      :selected-mcp-target-ids="selectedMcpTargetIds"
      :mcp-wizard-step="mcpWizardStep"
      :auth-status="authStatus"
      :busy="mcpInstallBusy || authBusy || loading"
      :auth-busy="authBusy || loading"
      :can-install="setupApiAvailable"
      :feedback="firstRunFeedback"
      :room-name="repoName"
      :room-identifier="rootRoomSnapshot?.roomIdentifier || null"
      @select-target="selectMcpTarget"
      @select-all-targets="selectAllMcpTargets"
      @clear-target-selection="clearMcpTargetSelection"
      @continue-mcp="continueMcpOnboarding"
      @install-targets="installSelectedMcpTargets"
      @continue-to-github="completeMcpOnboarding"
      @start-auth="startAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
      @sign-out="signOut"
      @continue-to-room="continueToRoomConfirmation"
      @pick-repo="pickRepoRoom"
      @join-room-code="joinRoomCode"
      @back="goBackFirstRun"
      @finish="finishFirstRunOnboarding"
    />
  </main>

  <main v-else class="desktop-shell" :data-sidebar-mode="sidebarMode" data-testid="desktop-shell">
    <DesktopSidebar
      :sidebar-mode="sidebarMode"
      :active-entry="activeEntry"
      :pinned-room="pinnedRoom"
      :project-entries="projectEntries"
      :system-entries="systemEntries"
      :workers-entry="workersEntry"
      :diagnostics-entry="diagnosticsEntry"
      :collapsed-sections="collapsedSections"
      :collapsed-projects="collapsedProjects"
      @cycle-sidebar="cycleSidebar"
      @new-room="selectNewRoomEntry"
      @select-entry="activeEntry = $event"
      @toggle-section="toggleSection"
      @toggle-project="toggleProject"
    />

    <section class="app-main" data-testid="desktop-main">
      <DesktopTopbar
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="activeEntry = diagnosticsEntry"
        @refresh="refresh"
      />

      <McpInstallOnboardingView
        v-if="showMcpInstaller"
        :state="mcpInstallState!"
        :selected-target-ids="selectedMcpTargetIds"
        :wizard-step="mcpWizardStep"
        :busy="mcpInstallBusy || loading"
        :feedback="mcpInstallFeedback"
        :can-install="setupApiAvailable"
        @select-target="selectMcpTarget"
        @select-all-targets="selectAllMcpTargets"
        @clear-target-selection="clearMcpTargetSelection"
        @continue="continueMcpOnboarding"
        @back="goBackMcpOnboarding"
        @install-targets="installSelectedMcpTargets"
        @finish="completeMcpOnboarding"
      />

      <template v-else-if="activeEntry.type === 'room'">
        <AuthOnboardingView
          v-if="selectedNeedsAccess"
          :access="selectedAccess"
          :auth-status="authStatus"
          :busy="authBusy || loading"
          :feedback="authFeedback"
          @start-auth="startAuthFlow"
          @open-verification="openVerification"
          @poll-auth="pollAuthFlow"
          @refresh-room="refresh"
          @sign-out="signOut"
        />

        <DesktopRoomShell
          v-else
          :key="activeEntry.id"
          :room="selectedRoomInfo"
          :focus-rooms="selectedFocusRooms"
          :tasks="selectedSnapshot?.tasks || []"
          :participants="selectedSnapshot?.participants || []"
          :recent-activity="selectedSnapshot?.recentActivity || []"
          :messages="selectedSnapshot?.messages || []"
          @message-sent="handleMessageSent"
          @refresh-room="refreshSelectedSnapshot()"
        />
      </template>

      <RepoStatusView
        v-else-if="activeEntry.id === 'system:repos'"
        :repo-status="repoStatusValue"
      />

      <WorkerStatusView
        v-else-if="activeEntry.id === 'system:workers'"
        :workers="workers"
      />

      <DiagnosticsView
        v-else
        :notes="diagnostics?.notes || []"
      />
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomAccess,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopRoomSnapshot,
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import McpInstallOnboardingView from "./components/desktop/content/McpInstallOnboardingView.vue";
import DiagnosticsView from "./components/desktop/content/DiagnosticsView.vue";
import RepoStatusView from "./components/desktop/content/RepoStatusView.vue";
import WorkerStatusView from "./components/desktop/content/WorkerStatusView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { ProjectGroup, RoomEntry, SidebarEntry, SidebarMode, SystemEntry } from "./components/desktop/types";

const loading = ref(false);
const sidebarMode = ref<SidebarMode>("expanded");
const appInfo = ref<DesktopAppInfo | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedRootRoomIdentifier = ref<string | null>(null);
const diagnostics = ref<DiagnosticsSnapshot | null>(null);
const authStatus = ref<DesktopAuthStatus | null>(null);
const authBusy = ref(false);
const authFeedback = ref<string | null>(null);
const mcpInstallState = ref<DesktopMcpInstallState | null>(null);
const selectedMcpTargetIds = ref<DesktopMcpInstallTargetId[]>([]);
const mcpInstallBusy = ref(false);
const mcpInstallFeedback = ref<string | null>(null);
const setupLoadError = ref<string | null>(null);
const mcpWizardStep = ref<DesktopMcpWizardStep>("choose");
const firstRunStage = ref<FirstRunWizardStage>("mcp");
let authPollTimer: number | null = null;
let unsubscribeRoomStream: (() => void) | null = null;

const setupEntry: SystemEntry = {
  id: "system:setup",
  type: "system",
  title: "Setup",
  description: "Install LetAgents",
  sectionLabel: "System",
};

const repositoryEntry: SystemEntry = {
  id: "system:repos",
  type: "system",
  title: "Room details",
  description: "Branches and related rooms",
  sectionLabel: "System",
};

const workersEntry: SystemEntry = {
  id: "system:workers",
  type: "system",
  title: "Agents",
  description: "Status and availability",
  sectionLabel: "System",
};

const diagnosticsEntry: SystemEntry = {
  id: "system:diagnostics",
  type: "system",
  title: "Diagnostics",
  description: "Local truth and recovery",
  sectionLabel: "System",
};

const systemEntries: SystemEntry[] = [setupEntry, repositoryEntry, workersEntry, diagnosticsEntry];

const repoName = computed(() => {
  return rootRoomSnapshot.value?.room?.displayName
    || rootRoomSnapshot.value?.roomIdentifier
    || repoStatus.value?.rootPath?.split("/").filter(Boolean).pop()
    || appInfo.value?.workspaceRoot?.split("/").filter(Boolean).pop()
    || "Room";
});

const focusRooms = computed(() => {
  return rootRoomSnapshot.value?.focusRooms || [];
});

const selectedRoomInfo = computed<DesktopRoomInfo>(() => {
  if (!selectedSnapshot.value?.room) {
    return {
      identifier: selectedSnapshot.value?.roomIdentifier || repoName.value,
      code: "",
      name: repoName.value,
      displayName: repoName.value,
      role: "participant",
      authenticated: false,
      kind: activeEntry.value.type === "room" && activeEntry.value.kind === "focus" ? "focus" : "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
    };
  }
  return selectedSnapshot.value.room;
});

const selectedFocusRooms = computed(() => {
  return activeEntry.value.type === "room" && activeEntry.value.kind === "focus"
    ? []
    : selectedSnapshot.value?.focusRooms || [];
});

const selectedAccess = computed<DesktopRoomAccess>(() => {
  return selectedSnapshot.value?.access || {
    status: "unavailable",
    title: "Room unavailable",
    message: "LetAgents could not load this room yet.",
    roomIdentifier: selectedSnapshot.value?.roomIdentifier || null,
    deviceFlowUrl: null,
    code: null,
    httpStatus: null,
  };
});

const selectedNeedsAccess = computed(() => {
  return selectedAccess.value.status !== "ready";
});

const selectedRoomIdentifier = computed(() => {
  if (selectedNeedsAccess.value) return null;
  return selectedRoomInfo.value.identifier || selectedSnapshot.value?.roomIdentifier || null;
});

const showMcpInstaller = computed(() => {
  if (!mcpInstallState.value) return false;
  return activeEntry.value.id === setupEntry.id;
});

const showFirstRunGate = computed(() => {
  return !mcpInstallState.value || !mcpInstallState.value.completed || !authStatus.value?.authenticated;
});

const fallbackMcpInstallState: DesktopMcpInstallState = {
  completed: false,
  completedAt: null,
  selectedTargetId: null,
  targets: [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "Add the MCP connection Claude Code needs to join rooms.",
      configPath: "~/.claude/settings.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Claude Code or reload its MCP servers after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the MCP connection Antigravity needs to join rooms.",
      configPath: "~/.gemini/settings.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Antigravity so it picks up the updated MCP settings.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the MCP connection Cursor needs to join rooms.",
      configPath: "~/.cursor/mcp.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Reload Cursor or restart its MCP server after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "Add the MCP connection Codex needs to join rooms.",
      configPath: "~/.codex/mcp.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
    },
  ],
};

const visibleMcpInstallState = computed<DesktopMcpInstallState>(() => {
  return mcpInstallState.value || fallbackMcpInstallState;
});

function defaultMcpTargetSelection(state: DesktopMcpInstallState): DesktopMcpInstallTargetId[] {
  const installedTargets = state.targets.filter((target) => target.status === "installed").map((target) => target.id);
  if (installedTargets.length) return installedTargets;
  if (state.selectedTargetId) return [state.selectedTargetId];
  return state.targets[0]?.id ? [state.targets[0].id] : [];
}

const setupApiAvailable = computed(() => {
  return Boolean(window.letagentsDesktop?.setup);
});

const firstRunFeedback = computed(() => {
  return mcpInstallFeedback.value || authFeedback.value || setupLoadError.value;
});

const currentParentRoom = computed<RoomEntry>(() => ({
  id: "room:parent:main",
  type: "room",
  kind: "parent",
  title: repoName.value,
  meta: repoStatus.value?.branch || "Parent room",
  sectionLabel: "Parent room",
  headline: "Start here, then branch work into focused rooms when it needs space.",
  description:
    "The main room should feel like home base: familiar, recent, and connected to the focused work happening around it.",
}));

const projectEntries = computed<ProjectGroup[]>(() => {
  const parent = currentParentRoom.value;
  return [
    {
      id: `project:${repoName.value}`,
      roomName: repoName.value,
      parent,
      focusRooms: focusRooms.value.map(focusRoom => ({
        id: `room:focus:${focusRoom.roomId}`,
        type: "room",
        kind: "focus",
        title: focusRoom.displayName,
        meta: focusRoom.code || focusRoom.sourceTaskId || "Focus room",
        sectionLabel: "Focus room",
        headline: "Focused work should stay close to the room it came from.",
        description:
          "A focus room gives one thread of work more space, without losing the connection back to the main room.",
      })),
    },
  ];
});

const pinnedRoom = computed<RoomEntry>(() => ({
  id: "room:pinned:current",
  type: "room",
  kind: "parent",
  title: `${repoName.value} - current`,
  meta: "now",
  sectionLabel: "Pinned room",
  headline: "Come back to the room you were just in without thinking about it.",
  description:
    "Pinned rooms keep the places you return to most close by, so getting back into the flow feels instant.",
}));

const activeEntry = ref<SidebarEntry>(pinnedRoom.value);
const collapsedSections = ref({
  pinned: false,
  projects: false,
  system: false,
});
const collapsedProjects = ref<Record<string, boolean>>({});

function selectNewRoomEntry() {
  activeEntry.value = pinnedRoom.value;
}

function cycleSidebar() {
  sidebarMode.value =
    sidebarMode.value === "expanded"
      ? "rail"
      : sidebarMode.value === "rail"
        ? "hidden"
        : "expanded";
}

function toggleSection(section: "pinned" | "projects" | "system") {
  collapsedSections.value = {
    ...collapsedSections.value,
    [section]: !collapsedSections.value[section],
  };
}

function toggleProject(projectId: string) {
  collapsedProjects.value = {
    ...collapsedProjects.value,
    [projectId]: !collapsedProjects.value[projectId],
  };
}

async function refresh(): Promise<void> {
  if (mcpInstallState.value && !mcpInstallState.value.completed) {
    return;
  }

  loading.value = true;
  try {
    const [
      nextAppInfo,
      nextRepoStatus,
      nextWorkers,
      nextRootRoomSnapshot,
      nextDiagnostics,
      nextAuthStatus,
      nextMcpInstallState,
    ] = await Promise.all([
      window.letagentsDesktop.app.getInfo(),
      window.letagentsDesktop.repos.getStatus(),
      window.letagentsDesktop.workers.list(),
      window.letagentsDesktop.room.getSnapshot(selectedRootRoomIdentifier.value),
      window.letagentsDesktop.diagnostics.getSnapshot(),
      window.letagentsDesktop.auth.getStatus(),
      window.letagentsDesktop.setup.getMcpInstallState(),
    ]);
    appInfo.value = nextAppInfo;
    repoStatus.value = nextRepoStatus;
    workers.value = nextWorkers;
    rootRoomSnapshot.value = nextRootRoomSnapshot;
    selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
    diagnostics.value = nextDiagnostics;
    authStatus.value = nextAuthStatus;
    mcpInstallState.value = nextMcpInstallState;
    selectedMcpTargetIds.value = selectedMcpTargetIds.value.length
      ? selectedMcpTargetIds.value
      : defaultMcpTargetSelection(nextMcpInstallState);
    reconcileActiveEntry();
    await refreshSelectedSnapshot(nextRootRoomSnapshot);
  } finally {
    loading.value = false;
  }
}

async function loadFirstRunSetup(): Promise<void> {
  loading.value = true;
  setupLoadError.value = null;
  try {
    if (!window.letagentsDesktop?.setup) {
      throw new Error("The desktop bridge is stale. Restart LetAgents Desktop so setup can install MCP automatically.");
    }
    const [nextMcpInstallState, nextAuthStatus] = await Promise.all([
      window.letagentsDesktop.setup.getMcpInstallState(),
      window.letagentsDesktop.auth.getStatus(),
    ]);
    mcpInstallState.value = nextMcpInstallState;
    authStatus.value = nextAuthStatus;
    await loadFirstRunRoomContext();
    selectedMcpTargetIds.value = selectedMcpTargetIds.value.length
      ? selectedMcpTargetIds.value
      : defaultMcpTargetSelection(nextMcpInstallState);
    firstRunStage.value = nextMcpInstallState.completed ? "github" : "mcp";

    if (nextMcpInstallState.completed && nextAuthStatus.authenticated) {
      await refresh();
    }
  } catch (error) {
    setupLoadError.value = error instanceof Error
      ? `Setup could not load yet: ${error.message}. Restart the desktop window if this keeps happening.`
      : "Setup could not load yet. Restart the desktop window if this keeps happening.";
    mcpInstallState.value = fallbackMcpInstallState;
    selectedMcpTargetIds.value = selectedMcpTargetIds.value.length
      ? selectedMcpTargetIds.value
      : defaultMcpTargetSelection(fallbackMcpInstallState);
    firstRunStage.value = "mcp";
  } finally {
    loading.value = false;
  }
}

async function refreshSelectedSnapshot(baseRootSnapshot: DesktopRoomSnapshot | null = rootRoomSnapshot.value): Promise<void> {
  if (!baseRootSnapshot) {
    selectedSnapshot.value = null;
    return;
  }

  if (activeEntry.value.type !== "room") {
    selectedSnapshot.value = baseRootSnapshot;
    return;
  }

  const roomIdentifier = resolveSelectedRoomIdentifier(baseRootSnapshot);
  if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
    selectedSnapshot.value = baseRootSnapshot;
    return;
  }

  selectedSnapshot.value = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
}

function selectedSnapshotMatchesRoom(roomIdentifier: string | null): boolean {
  if (!roomIdentifier || !selectedSnapshot.value) return false;
  const eventRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  return [
    selectedSnapshot.value.roomIdentifier,
    selectedSnapshot.value.room?.identifier,
    selectedSnapshot.value.room?.name,
    selectedSnapshot.value.room?.code,
  ].some((candidate) => normalizeRoomIdentifier(candidate) === eventRoomIdentifier);
}

function upsertSelectedTask(task: DesktopTaskSummary): void {
  if (!selectedSnapshot.value) return;
  const existingIndex = selectedSnapshot.value.tasks.findIndex((existing) => existing.id === task.id);
  const tasks = [...selectedSnapshot.value.tasks];
  if (existingIndex >= 0) {
    tasks.splice(existingIndex, 1, { ...tasks[existingIndex], ...task });
  } else {
    tasks.unshift(task);
  }
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    tasks,
  };
}

function appendSelectedMessage(message: DesktopRoomMessage): void {
  if (!selectedSnapshot.value) return;
  const messages = selectedSnapshot.value.messages || [];
  if (messages.some((existing) => existing.id === message.id)) return;
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    messages: [...messages, message],
  };
}

function normalizeRoomIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function handleRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  if (!selectedSnapshotMatchesRoom(event.roomIdentifier)) return;

  if (event.type === "message") {
    appendSelectedMessage(event.message);
    return;
  }

  if (event.type === "task_update") {
    upsertSelectedTask(event.task);
  }
}

function handleMessageSent(message: DesktopRoomMessage): void {
  appendSelectedMessage(message);
  void refreshSelectedSnapshot();
}

async function syncSelectedRoomStream(roomIdentifier: string | null): Promise<void> {
  if (!window.letagentsDesktop?.room?.startStream) return;
  if (!roomIdentifier) {
    await window.letagentsDesktop.room.stopStream();
    return;
  }
  await window.letagentsDesktop.room.startStream(roomIdentifier);
}

async function loadFirstRunRoomContext(): Promise<void> {
  try {
    const [nextAppInfo, nextRepoStatus, nextRootRoomSnapshot] = await Promise.all([
      window.letagentsDesktop.app.getInfo(),
      window.letagentsDesktop.repos.getStatus(),
      window.letagentsDesktop.room.getSnapshot(),
    ]);
    appInfo.value = nextAppInfo;
    repoStatus.value = nextRepoStatus;
    rootRoomSnapshot.value = nextRootRoomSnapshot;
    selectedSnapshot.value = nextRootRoomSnapshot;
    selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
  } catch {
    // First-run should still be usable if room preview is unavailable before auth.
  }
}

function resolveSelectedRoomIdentifier(baseRootSnapshot: DesktopRoomSnapshot | null): string | null {
  if (!baseRootSnapshot) return null;
  if (activeEntry.value.type !== "room") return baseRootSnapshot.roomIdentifier;
  if (activeEntry.value.kind !== "focus") return baseRootSnapshot.roomIdentifier;
  const focusRoom = baseRootSnapshot.focusRooms.find((room) => `room:focus:${room.roomId}` === activeEntry.value.id);
  return focusRoom?.identifier || null;
}

function reconcileActiveEntry(): void {
  if (activeEntry.value.type !== "room") return;

  if (activeEntry.value.kind === "focus") {
    const nextFocus = projectEntries.value[0]?.focusRooms.find((room) => room.id === activeEntry.value.id);
    activeEntry.value = nextFocus || currentParentRoom.value;
    return;
  }

  activeEntry.value = activeEntry.value.id === pinnedRoom.value.id ? pinnedRoom.value : currentParentRoom.value;
}

function getAuthRoomIdentifier(): string | null {
  return selectedAccess.value.roomIdentifier
    || selectedSnapshot.value?.roomIdentifier
    || rootRoomSnapshot.value?.roomIdentifier
    || null;
}

function clearAuthPollTimer(): void {
  if (!authPollTimer) return;
  window.clearTimeout(authPollTimer);
  authPollTimer = null;
}

function scheduleAuthPoll(): void {
  clearAuthPollTimer();
  const pending = authStatus.value?.pendingDeviceAuth;
  if (!pending) return;

  const waitMs = Math.max(2, pending.intervalSeconds) * 1000 + 350;
  authPollTimer = window.setTimeout(() => {
    void pollAuthFlow({ automatic: true });
  }, waitMs);
}

async function startAuthFlow(): Promise<void> {
  authBusy.value = true;
  authFeedback.value = null;
  try {
    const result = await window.letagentsDesktop.auth.startDeviceFlow(getAuthRoomIdentifier());
    authStatus.value = result.authStatus;
    authFeedback.value = "GitHub is open. Enter the code here, then come back to LetAgents. This app will keep checking.";
    await window.letagentsDesktop.auth.openVerification(result.pendingDeviceAuth.verificationUri);
    scheduleAuthPoll();
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "Could not start GitHub approval.";
  } finally {
    authBusy.value = false;
  }
}

async function openVerification(url: string): Promise<void> {
  authBusy.value = true;
  authFeedback.value = null;
  try {
    await window.letagentsDesktop.auth.openVerification(url);
    authFeedback.value = "Use the code shown here in GitHub, then return and approve the room.";
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "Could not open GitHub.";
  } finally {
    authBusy.value = false;
  }
}

async function pollAuthFlow(options: { automatic?: boolean } = {}): Promise<void> {
  if (!options.automatic) {
    authBusy.value = true;
  }
  authFeedback.value = null;
  try {
    const result = await window.letagentsDesktop.auth.pollDeviceFlow();
    authStatus.value = result.authStatus;

    if (result.status === "authorized") {
      authFeedback.value = "Connected. Confirm the room and you are ready.";
      if (showFirstRunGate.value) {
        await loadFirstRunRoomContext();
        firstRunStage.value = "room";
        return;
      }
      await refresh();
      return;
    }

    if (result.status === "pending" || result.status === "slow_down") {
      authFeedback.value = result.status === "slow_down"
        ? "GitHub asked us to slow down. LetAgents will check again shortly."
        : "Waiting for GitHub approval.";
      scheduleAuthPoll();
      return;
    }

    authFeedback.value = result.error || "GitHub approval did not complete. Start again when you are ready.";
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "Could not check GitHub approval.";
  } finally {
    if (!options.automatic) {
      authBusy.value = false;
    }
  }
}

async function signOut(): Promise<void> {
  clearAuthPollTimer();
  authBusy.value = true;
  authFeedback.value = null;
  try {
    authStatus.value = await window.letagentsDesktop.auth.signOut();
    authFeedback.value = "Signed out locally. Connect a GitHub account to try again.";
    await refresh();
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "Could not sign out.";
  } finally {
    authBusy.value = false;
  }
}

function selectMcpTarget(targetId: DesktopMcpInstallTargetId): void {
  selectedMcpTargetIds.value = selectedMcpTargetIds.value.includes(targetId)
    ? selectedMcpTargetIds.value.filter((id) => id !== targetId)
    : [...selectedMcpTargetIds.value, targetId];
  mcpInstallFeedback.value = null;
}

function selectAllMcpTargets(): void {
  selectedMcpTargetIds.value = visibleMcpInstallState.value.targets.map((target) => target.id);
  mcpInstallFeedback.value = null;
}

function clearMcpTargetSelection(): void {
  selectedMcpTargetIds.value = [];
  mcpInstallFeedback.value = null;
}

function continueMcpOnboarding(): void {
  mcpInstallFeedback.value = null;
  mcpWizardStep.value = "install";
}

function goBackMcpOnboarding(): void {
  mcpInstallFeedback.value = null;
  mcpWizardStep.value = mcpWizardStep.value === "done" ? "install" : "choose";
}

async function pickRepoRoom(): Promise<void> {
  loading.value = true;
  mcpInstallFeedback.value = null;
  authFeedback.value = "Opening the repo picker...";
  setupLoadError.value = null;
  try {
    if (!window.letagentsDesktop?.repos?.pickRoom) {
      throw new Error("Restart LetAgents Desktop so the repo picker can open.");
    }
    const result = await window.letagentsDesktop.repos.pickRoom();
    if (result.canceled) return;
    if (result.error || !result.snapshot) {
      authFeedback.value = result.error || "LetAgents could not open a room from that folder.";
      return;
    }
    rootRoomSnapshot.value = result.snapshot;
    selectedSnapshot.value = result.snapshot;
    selectedRootRoomIdentifier.value = result.snapshot.roomIdentifier;
    const roomLabel = result.snapshot.room?.displayName || result.roomIdentifier;
    authFeedback.value = result.warning
      ? `${result.warning} Room selected: ${roomLabel}.`
      : `Repo room selected: ${roomLabel}. Open it when you are ready.`;
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the repo picker.";
  } finally {
    loading.value = false;
  }
}

async function joinRoomCode(roomCode: string): Promise<void> {
  const roomIdentifier = roomCode.trim();
  if (!roomIdentifier) return;

  loading.value = true;
  mcpInstallFeedback.value = null;
  authFeedback.value = null;
  setupLoadError.value = null;
  try {
    const snapshot = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
    rootRoomSnapshot.value = snapshot;
    selectedSnapshot.value = snapshot;
    selectedRootRoomIdentifier.value = snapshot.roomIdentifier;
    authFeedback.value = snapshot.access.status === "ready"
      ? "Room selected. Open it when you are ready."
      : snapshot.access.message;
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
  } finally {
    loading.value = false;
  }
}

function goBackFirstRun(): void {
  mcpInstallFeedback.value = null;
  authFeedback.value = null;
  setupLoadError.value = null;

  if (firstRunStage.value === "room") {
    firstRunStage.value = "github";
    return;
  }

  if (firstRunStage.value === "github") {
    firstRunStage.value = "mcp";
    mcpWizardStep.value = "done";
    return;
  }

  goBackMcpOnboarding();
}

async function installSelectedMcpTargets(): Promise<void> {
  const targetIds = [...selectedMcpTargetIds.value];
  if (!targetIds.length) {
    mcpInstallFeedback.value = "Choose at least one app.";
    return;
  }

  mcpInstallBusy.value = true;
  mcpInstallFeedback.value = null;
  setupLoadError.value = null;
  try {
    if (!window.letagentsDesktop?.setup) {
      throw new Error("Restart LetAgents Desktop so setup can install MCP automatically.");
    }
    const result = await window.letagentsDesktop.setup.installMcpServers(targetIds);
    mcpInstallState.value = result.installState;
    selectedMcpTargetIds.value = result.targets.map((target) => target.id);
    mcpInstallFeedback.value = result.message;
    mcpWizardStep.value = "done";
  } catch (error) {
    mcpInstallFeedback.value = error instanceof Error
      ? error.message
      : "LetAgents could not update these apps' MCP settings.";
  } finally {
    mcpInstallBusy.value = false;
  }
}

async function completeMcpOnboarding(): Promise<void> {
  mcpInstallFeedback.value = null;
  setupLoadError.value = null;
  firstRunStage.value = "github";
}

function continueToRoomConfirmation(): void {
  authFeedback.value = null;
  void loadFirstRunRoomContext();
  firstRunStage.value = "room";
}

async function finishFirstRunOnboarding(): Promise<void> {
  mcpInstallBusy.value = true;
  mcpInstallFeedback.value = null;
  setupLoadError.value = null;
  try {
    if (!window.letagentsDesktop?.setup) {
      throw new Error("Restart LetAgents Desktop so setup can finish.");
    }
    mcpInstallState.value = await window.letagentsDesktop.setup.completeMcpOnboarding();
    activeEntry.value = pinnedRoom.value;
    await refresh();
  } catch (error) {
    authFeedback.value = error instanceof Error ? error.message : "Could not close setup.";
  } finally {
    mcpInstallBusy.value = false;
  }
}

const repoStatusValue = computed<RepoStatus>(() => repoStatus.value || {
  rootPath: appInfo.value?.workspaceRoot || "",
  branch: null,
  worktrees: [],
});

watch(
  () => activeEntry.value,
  async (nextEntry, previousEntry) => {
    if (!rootRoomSnapshot.value) return;
    if (nextEntry.id === previousEntry?.id) return;
    await refreshSelectedSnapshot(rootRoomSnapshot.value);
  }
);

watch(
  () => selectedRoomIdentifier.value,
  (roomIdentifier) => {
    void syncSelectedRoomStream(roomIdentifier);
  }
);

watch(
  () => authStatus.value?.pendingDeviceAuth?.requestId,
  (requestId) => {
    if (requestId) {
      scheduleAuthPoll();
      return;
    }
    clearAuthPollTimer();
  }
);

onMounted(() => {
  unsubscribeRoomStream = window.letagentsDesktop.room.onStreamEvent(handleRoomStreamEvent);
  void loadFirstRunSetup();
});

onBeforeUnmount(() => {
  clearAuthPollTimer();
  unsubscribeRoomStream?.();
  unsubscribeRoomStream = null;
  void window.letagentsDesktop.room.stopStream();
});
</script>
