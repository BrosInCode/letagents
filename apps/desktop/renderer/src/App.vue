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
      :primary-room="currentParentRoom"
      :project-entries="projectEntries"
      :system-entries="systemEntries"
      :workers-entry="workersEntry"
      :settings-entry="settingsEntry"
      :diagnostics-entry="diagnosticsEntry"
      :collapsed-sections="collapsedSections"
      :collapsed-projects="collapsedProjects"
      @cycle-sidebar="cycleSidebar"
      @new-room="selectNewRoomEntry"
      @select-entry="selectSidebarEntry"
      @toggle-section="toggleSection"
      @toggle-project="toggleProject"
    />

    <section class="app-main" :data-room-entry="activeEntry.type === 'room'" data-testid="desktop-main">
      <DesktopTopbar
        v-if="activeEntry.type !== 'room'"
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="activeEntry = settingsEntry"
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
          :participant-hidden-count="selectedSnapshot?.participantHiddenCount || 0"
          :presence="selectedSnapshot?.presence || []"
          :reasoning-sessions="selectedSnapshot?.reasoningSessions || []"
          :recent-activity="selectedSnapshot?.recentActivity || []"
          :messages="selectedSnapshot?.messages || []"
          :workers="workers"
          @message-sent="handleMessageSent"
          @room-renamed="handleRoomRenamed"
          @task-updated="upsertSelectedTask"
          @refresh-room="handleRefreshRoom"
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

      <SettingsView
        v-else-if="activeEntry.id === 'system:settings'"
        :account-rooms="settingsAccountRooms"
        :app-info="appInfo"
        :auth-status="authStatus"
        :busy="loading || authBusy"
        :feedback="settingsFeedback"
        :mcp-install-state="mcpInstallState"
        :room-action-busy-key="settingsRoomActionBusyKey"
        @delete-room="deleteAccountRoom"
        @leave-room="leaveAccountRoom"
        @open-room="openAccountRoomFromSettings"
        @open-setup="activeEntry = setupEntry"
        @restore-room="restoreAccountRoom"
        @toggle-pin-room="toggleAccountRoomPin"
        @refresh="refreshSettings"
        @sign-out="signOut"
        @start-auth="startAuthFlow"
      />

      <DiagnosticsView
        v-else
        :notes="diagnostics?.notes || []"
      />
    </section>

    <div
      v-if="newRoomModalOpen"
      class="desktop-modal-backdrop"
      data-testid="new-room-modal"
      @click.self="closeNewRoomModal"
    >
      <section class="desktop-new-room-modal" role="dialog" aria-modal="true" aria-labelledby="new-room-title">
        <header class="desktop-new-room-header">
          <div>
            <p class="sidebar-label">New room</p>
            <h2 id="new-room-title">Choose how to open a room</h2>
          </div>
          <button class="desktop-modal-close" type="button" aria-label="Close new room dialog" @click="closeNewRoomModal">
            ×
          </button>
        </header>

        <div class="desktop-new-room-grid">
          <button
            class="desktop-new-room-option"
            type="button"
            :disabled="newRoomBusy"
            data-testid="new-room-create-invite"
            @click="createInviteRoom"
          >
            <span class="desktop-new-room-icon">#</span>
            <strong>Invite room</strong>
            <small>Create a room with a random join code for ad-hoc collaboration.</small>
          </button>

          <button
            class="desktop-new-room-option"
            type="button"
            :disabled="newRoomBusy"
            data-testid="new-room-open-project"
            @click="openProjectRoomFromModal"
          >
            <span class="desktop-new-room-icon">⌂</span>
            <strong>Project folder</strong>
            <small>Open a folder and use its .letagents.json, git remote, or local room fallback.</small>
          </button>
        </div>

        <form class="desktop-new-room-join" @submit.prevent="joinRoomCodeFromModal">
          <label>
            <span>Join with code</span>
            <input
              v-model="newRoomJoinCode"
              type="text"
              placeholder="ABCD-1234"
              :disabled="newRoomBusy"
            />
          </label>
          <button type="submit" :disabled="newRoomBusy || !newRoomJoinCode.trim()">Join</button>
        </form>

        <p v-if="newRoomFeedback" class="desktop-new-room-feedback" :data-state="newRoomFeedbackState">
          {{ newRoomFeedback }}
        </p>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopReasoningSession,
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
import SettingsView from "./components/desktop/content/SettingsView.vue";
import WorkerStatusView from "./components/desktop/content/WorkerStatusView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { ProjectGroup, RoomEntry, SidebarEntry, SidebarMode, SystemEntry } from "./components/desktop/types";
import {
  buildSidebarProjectGroups,
  normalizeRoomIdentifier,
  readStoredRecentRootRooms,
  rememberRecentRootRooms,
  rootPathLabel,
  rootRoomEntryId,
  type RecentRootRoom,
  upsertRecentRootRoomSnapshot,
} from "./domain/sidebar-rooms";

const loading = ref(false);
const sidebarMode = ref<SidebarMode>("expanded");
const appInfo = ref<DesktopAppInfo | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedRootRoomStorageKey = "letagents-desktop:selected-root-room";
const activeEntryStorageKey = "letagents-desktop:active-entry";
const recentRootRoomsStorageKey = "letagents-desktop:recent-root-rooms";
const selectedRootRoomIdentifier = ref<string | null>(readStoredSelectedRootRoomIdentifier());
const recentRootRooms = ref<RecentRootRoom[]>(readStoredRecentRootRooms(recentRootRoomsStorageKey));
const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
const diagnostics = ref<DiagnosticsSnapshot | null>(null);
const authStatus = ref<DesktopAuthStatus | null>(null);
const authBusy = ref(false);
const authFeedback = ref<string | null>(null);
const mcpInstallState = ref<DesktopMcpInstallState | null>(null);
const selectedMcpTargetIds = ref<DesktopMcpInstallTargetId[]>([]);
const mcpInstallBusy = ref(false);
const mcpInstallFeedback = ref<string | null>(null);
const newRoomModalOpen = ref(false);
const newRoomBusy = ref(false);
const newRoomFeedback = ref<string | null>(null);
const newRoomFeedbackState = ref<"info" | "error" | "success">("info");
const newRoomJoinCode = ref("");
const settingsFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
const settingsRoomActionBusyKey = ref<string | null>(null);
const setupLoadError = ref<string | null>(null);
const mcpWizardStep = ref<DesktopMcpWizardStep>("choose");
const firstRunStage = ref<FirstRunWizardStage>("mcp");
let authPollTimer: number | null = null;
let unsubscribeRoomStream: (() => void) | null = null;
let liveMetadataRefreshTimer: number | null = null;
let liveMetadataRefreshInterval: number | null = null;
let liveMetadataRefreshSequence = 0;
let activeEntryRestored = false;

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

const settingsEntry: SystemEntry = {
  id: "system:settings",
  type: "system",
  title: "Settings",
  description: "Account and rooms",
  sectionLabel: "System",
};

const diagnosticsEntry: SystemEntry = {
  id: "system:diagnostics",
  type: "system",
  title: "Diagnostics",
  description: "Local truth and recovery",
  sectionLabel: "System",
};

const systemEntries: SystemEntry[] = [setupEntry, repositoryEntry, workersEntry, settingsEntry, diagnosticsEntry];

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
const latestSelectedMessageId = computed(() => selectedSnapshot.value?.messages.at(-1)?.id || null);

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

function readStoredSelectedRootRoomIdentifier(): string | null {
  try {
    return window.localStorage.getItem(selectedRootRoomStorageKey)?.trim() || null;
  } catch {
    return null;
  }
}

function rememberSelectedRootRoomIdentifier(roomIdentifier: string | null): void {
  try {
    const trimmed = roomIdentifier?.trim();
    if (trimmed) {
      window.localStorage.setItem(selectedRootRoomStorageKey, trimmed);
      return;
    }
    window.localStorage.removeItem(selectedRootRoomStorageKey);
  } catch {
    // Local persistence should never block the room UI.
  }
}

function readStoredActiveEntryId(): string | null {
  try {
    return window.localStorage.getItem(activeEntryStorageKey)?.trim() || null;
  } catch {
    return null;
  }
}

function rememberActiveEntryId(entryId: string): void {
  try {
    window.localStorage.setItem(activeEntryStorageKey, entryId);
  } catch {
    // Local persistence should never block navigation.
  }
}

function rememberRootRoomSnapshot(
  snapshot: DesktopRoomSnapshot,
  options: { rootPath?: string | null; meta?: string | null } = {}
): void {
  const rootPath = options.rootPath || repoStatus.value?.rootPath || appInfo.value?.workspaceRoot || null;
  const nextRooms = upsertRecentRootRoomSnapshot({
    snapshot,
    recentRootRooms: recentRootRooms.value,
    rootPath,
    meta: options.meta || repoStatus.value?.branch || snapshot.room?.code || rootPathLabel(rootPath) || "Room",
  });
  recentRootRooms.value = nextRooms;
  rememberRecentRootRooms(recentRootRoomsStorageKey, nextRooms);
}

const currentParentRoom = computed<RoomEntry>(() => ({
  id: rootRoomEntryId(rootRoomSnapshot.value?.roomIdentifier || selectedRootRoomIdentifier.value || repoName.value),
  type: "room",
  kind: "parent",
  roomIdentifier: rootRoomSnapshot.value?.roomIdentifier || selectedRootRoomIdentifier.value || null,
  title: repoName.value,
  meta: repoStatus.value?.branch || "Parent room",
  sectionLabel: "Parent room",
  headline: "Start here, then branch work into focused rooms when it needs space.",
  description:
    "The main room should feel like home base: familiar, recent, and connected to the focused work happening around it.",
}));

const projectEntries = computed<ProjectGroup[]>(() => buildSidebarProjectGroups({
  currentParentRoom: currentParentRoom.value,
  focusRooms: focusRooms.value,
  accountRooms: accountRooms.value,
  recentRootRooms: recentRootRooms.value,
}));

const pinnedRoom = computed<RoomEntry>(() => ({
  id: currentParentRoom.value.id,
  type: "room",
  kind: "parent",
  roomIdentifier: currentParentRoom.value.roomIdentifier,
  title: currentParentRoom.value.title,
  meta: currentParentRoom.value.meta,
  sectionLabel: currentParentRoom.value.sectionLabel,
  headline: currentParentRoom.value.headline,
  description: currentParentRoom.value.description,
}));

const activeEntry = ref<SidebarEntry>(pinnedRoom.value);
const collapsedSections = ref({
  pinned: false,
  projects: false,
  system: false,
});
const collapsedProjects = ref<Record<string, boolean>>({});

function findSidebarEntryById(entryId: string): SidebarEntry | null {
  if (entryId === pinnedRoom.value.id) return pinnedRoom.value;
  if (entryId === currentParentRoom.value.id) return currentParentRoom.value;

  for (const group of projectEntries.value) {
    if (group.parent.id === entryId) return group.parent;
    const focusRoom = group.focusRooms.find((room) => room.id === entryId);
    if (focusRoom) return focusRoom;
  }

  return systemEntries.find((entry) => entry.id === entryId) || null;
}

function restoreActiveEntryFromStorage(): boolean {
  const storedEntryId = readStoredActiveEntryId();
  if (!storedEntryId) return false;
  const storedEntry = findSidebarEntryById(storedEntryId);
  if (!storedEntry) return false;
  activeEntry.value = storedEntry;
  return true;
}

function selectSidebarEntry(entry: SidebarEntry): void {
  activeEntry.value = entry;
}

function selectNewRoomEntry() {
  newRoomModalOpen.value = true;
  newRoomFeedback.value = null;
  newRoomFeedbackState.value = "info";
}

function closeNewRoomModal(): void {
  if (newRoomBusy.value) return;
  newRoomModalOpen.value = false;
  newRoomFeedback.value = null;
  newRoomJoinCode.value = "";
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
      nextAccountRooms,
      nextSettingsAccountRooms,
    ] = await Promise.all([
      window.letagentsDesktop.app.getInfo(),
      window.letagentsDesktop.repos.getStatus(),
      window.letagentsDesktop.workers.list(),
      window.letagentsDesktop.room.getSnapshot(selectedRootRoomIdentifier.value),
      window.letagentsDesktop.diagnostics.getSnapshot(),
      window.letagentsDesktop.auth.getStatus(),
      window.letagentsDesktop.setup.getMcpInstallState(),
      window.letagentsDesktop.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
      window.letagentsDesktop.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
    ]);
    appInfo.value = nextAppInfo;
    repoStatus.value = nextRepoStatus;
    workers.value = nextWorkers;
    rootRoomSnapshot.value = nextRootRoomSnapshot;
    selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
    rememberRootRoomSnapshot(nextRootRoomSnapshot);
    diagnostics.value = nextDiagnostics;
    authStatus.value = nextAuthStatus;
    mcpInstallState.value = nextMcpInstallState;
    accountRooms.value = nextAccountRooms || [];
    settingsAccountRooms.value = nextSettingsAccountRooms || nextAccountRooms || [];
    selectedMcpTargetIds.value = selectedMcpTargetIds.value.length
      ? selectedMcpTargetIds.value
      : defaultMcpTargetSelection(nextMcpInstallState);
    reconcileActiveEntry();
    await refreshSelectedSnapshot(nextRootRoomSnapshot);
  } finally {
    loading.value = false;
  }
}

async function refreshAccountRooms(): Promise<void> {
  const [nextAccountRooms, nextSettingsAccountRooms] = await Promise.all([
    window.letagentsDesktop.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
    window.letagentsDesktop.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
  ]);
  accountRooms.value = nextAccountRooms || [];
  settingsAccountRooms.value = nextSettingsAccountRooms || nextAccountRooms || [];
}

async function refreshSettings(): Promise<void> {
  settingsFeedback.value = { message: "Refreshing account rooms...", state: "info" };
  try {
    await refresh();
    settingsFeedback.value = { message: "Settings refreshed.", state: "success" };
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : "Settings could not refresh.",
      state: "error",
    };
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
    selectedSnapshot.value = mergeRoomSnapshotMessages(selectedSnapshot.value, baseRootSnapshot);
    return;
  }

  const selectedRoomEntry = activeEntry.value;
  const roomIdentifier = resolveSelectedRoomIdentifier(baseRootSnapshot);
  if (
    selectedRoomEntry.kind === "parent"
    && roomIdentifier
    && normalizeRoomIdentifier(roomIdentifier) !== normalizeRoomIdentifier(baseRootSnapshot.roomIdentifier)
  ) {
    const nextRootSnapshot = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
    rootRoomSnapshot.value = nextRootSnapshot;
    selectedSnapshot.value = mergeRoomSnapshotMessages(selectedSnapshot.value, nextRootSnapshot);
    selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
    rememberRootRoomSnapshot(nextRootSnapshot);
    activeEntry.value = currentParentRoom.value;
    return;
  }
  if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
    selectedSnapshot.value = mergeRoomSnapshotMessages(selectedSnapshot.value, baseRootSnapshot);
    return;
  }

  selectedSnapshot.value = mergeRoomSnapshotMessages(
    selectedSnapshot.value,
    await window.letagentsDesktop.room.getSnapshot(roomIdentifier)
  );
}

async function refreshSelectedRoomSnapshotFromServer(): Promise<void> {
  const roomIdentifier = selectedRoomIdentifier.value;
  if (!roomIdentifier) return;
  const refreshSequence = ++liveMetadataRefreshSequence;
  const [snapshot, nextWorkers] = await Promise.all([
    window.letagentsDesktop.room.getSnapshot(roomIdentifier),
    window.letagentsDesktop.workers.list().catch(() => workers.value),
  ]);
  if (
    refreshSequence !== liveMetadataRefreshSequence
    || normalizeRoomIdentifier(selectedRoomIdentifier.value) !== normalizeRoomIdentifier(roomIdentifier)
  ) {
    return;
  }
  workers.value = nextWorkers;
  selectedSnapshot.value = mergeRoomSnapshotMessages(selectedSnapshot.value, snapshot);
  if (rootRoomSnapshot.value && roomSnapshotsMatch(rootRoomSnapshot.value, snapshot)) {
    rootRoomSnapshot.value = mergeRoomSnapshotMessages(rootRoomSnapshot.value, snapshot);
  }
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

function upsertSelectedReasoningSession(session: DesktopReasoningSession): void {
  if (!selectedSnapshot.value) return;
  const existingIndex = selectedSnapshot.value.reasoningSessions.findIndex((existing) => existing.id === session.id);
  const reasoningSessions = [...selectedSnapshot.value.reasoningSessions];
  if (existingIndex >= 0) {
    reasoningSessions.splice(existingIndex, 1, { ...reasoningSessions[existingIndex], ...session });
  } else {
    reasoningSessions.unshift(session);
  }
  reasoningSessions.sort(compareDesktopReasoningSessions);
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    reasoningSessions,
  };
}

function removeSelectedReasoningSession(sessionId: string): void {
  if (!selectedSnapshot.value) return;
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    reasoningSessions: selectedSnapshot.value.reasoningSessions.filter((session) => session.id !== sessionId),
  };
}

function appendSelectedMessage(message: DesktopRoomMessage): void {
  if (!selectedSnapshot.value) return;
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    messages: mergeDesktopRoomMessages(selectedSnapshot.value.messages || [], [message]),
  };
}

function mergeRoomSnapshotMessages(
  current: DesktopRoomSnapshot | null,
  incoming: DesktopRoomSnapshot
): DesktopRoomSnapshot {
  if (!current || !roomSnapshotsMatch(current, incoming)) return incoming;
  if (shouldPreserveCurrentRoomSnapshot(current, incoming)) {
    return {
      ...current,
      messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
    };
  }
  return {
    ...incoming,
    messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
  };
}

function shouldPreserveCurrentRoomSnapshot(
  current: DesktopRoomSnapshot,
  incoming: DesktopRoomSnapshot
): boolean {
  if (current.access.status !== "ready" || incoming.access.status !== "unavailable") return false;
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  return incoming.access.httpStatus === null || transientStatuses.has(incoming.access.httpStatus);
}

function roomSnapshotsMatch(left: DesktopRoomSnapshot, right: DesktopRoomSnapshot): boolean {
  const leftIdentifiers = [
    left.roomIdentifier,
    left.room?.identifier,
    left.room?.name,
    left.room?.code,
  ].map(normalizeRoomIdentifier).filter(Boolean);
  const rightIdentifiers = [
    right.roomIdentifier,
    right.room?.identifier,
    right.room?.name,
    right.room?.code,
  ].map(normalizeRoomIdentifier).filter(Boolean);
  return leftIdentifiers.some((identifier) => rightIdentifiers.includes(identifier));
}

function mergeDesktopRoomMessages(
  current: readonly DesktopRoomMessage[],
  incoming: readonly DesktopRoomMessage[]
): DesktopRoomMessage[] {
  const byId = new Map<string, DesktopRoomMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) {
    if (!isPromptOnlyDesktopMessage(message)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(compareDesktopRoomMessages);
}

function compareDesktopReasoningSessions(left: DesktopReasoningSession, right: DesktopReasoningSession): number {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
  return (Number.isFinite(rightTime) ? rightTime : -1) - (Number.isFinite(leftTime) ? leftTime : -1);
}

function isPromptOnlyDesktopMessage(message: DesktopRoomMessage): boolean {
  return message.agentPromptKind === "auto" && !message.text.trim();
}

function compareDesktopRoomMessages(left: DesktopRoomMessage, right: DesktopRoomMessage): number {
  const leftNumber = desktopMessageNumber(left.id);
  const rightNumber = desktopMessageNumber(right.id);
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  const leftTime = Date.parse(left.timestamp || "");
  const rightTime = Date.parse(right.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (leftNumber && !rightNumber) return -1;
  if (!leftNumber && rightNumber) return 1;
  return left.id.localeCompare(right.id);
}

function desktopMessageNumber(messageId: string): number {
  return Number(/^msg_(\d+)$/.exec(messageId)?.[1] || 0);
}

function handleRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  if (!selectedSnapshotMatchesRoom(event.roomIdentifier)) return;

  if (event.type === "open") {
    scheduleLiveMetadataRefresh(0);
    return;
  }

  if (event.type === "message") {
    appendSelectedMessage(event.message);
    if (shouldRefreshMetadataForMessage(event.message)) {
      scheduleLiveMetadataRefresh();
    }
    return;
  }

  if (event.type === "task_update") {
    upsertSelectedTask(event.task);
    scheduleLiveMetadataRefresh();
    return;
  }

  if (event.type === "reasoning_update") {
    upsertSelectedReasoningSession(event.session);
    scheduleLiveMetadataRefresh();
    return;
  }

  if (event.type === "reasoning_remove") {
    removeSelectedReasoningSession(event.sessionId);
    scheduleLiveMetadataRefresh();
  }
}

function shouldRefreshMetadataForMessage(message: DesktopRoomMessage): boolean {
  const source = (message.source || "").toLowerCase();
  const sender = (message.sender || "").toLowerCase();
  return source === "agent" || source === "browser" || source === "github" || sender === "letagents" || sender === "github";
}

function scheduleLiveMetadataRefresh(delayMs = 800): void {
  if (liveMetadataRefreshTimer) {
    window.clearTimeout(liveMetadataRefreshTimer);
  }
  liveMetadataRefreshTimer = window.setTimeout(() => {
    liveMetadataRefreshTimer = null;
    void refreshSelectedRoomSnapshotFromServer().catch(() => undefined);
  }, delayMs);
}

function clearLiveMetadataRefreshTimer(): void {
  if (!liveMetadataRefreshTimer) return;
  window.clearTimeout(liveMetadataRefreshTimer);
  liveMetadataRefreshTimer = null;
}

function startLiveMetadataRefreshInterval(): void {
  clearLiveMetadataRefreshInterval();
  liveMetadataRefreshInterval = window.setInterval(() => {
    void refreshSelectedRoomSnapshotFromServer().catch(() => undefined);
  }, 5_000);
}

function clearLiveMetadataRefreshInterval(): void {
  if (!liveMetadataRefreshInterval) return;
  window.clearInterval(liveMetadataRefreshInterval);
  liveMetadataRefreshInterval = null;
}

function handleRefreshRoom(): void {
  void refreshSelectedSnapshot();
  scheduleLiveMetadataRefresh(0);
}

function handleMessageSent(message: DesktopRoomMessage): void {
  appendSelectedMessage(message);
  scheduleLiveMetadataRefresh();
}

function handleRoomRenamed(room: DesktopRoomInfo): void {
  if (!selectedSnapshot.value) return;
  selectedSnapshot.value = {
    ...selectedSnapshot.value,
    room,
    roomIdentifier: room.identifier,
  };
  if (rootRoomSnapshot.value && roomSnapshotsMatch(rootRoomSnapshot.value, selectedSnapshot.value)) {
    rootRoomSnapshot.value = {
      ...rootRoomSnapshot.value,
      room,
      roomIdentifier: room.identifier,
    };
  }
}

async function syncSelectedRoomStream(roomIdentifier: string | null): Promise<void> {
  if (!window.letagentsDesktop?.room?.startStream) return;
  if (!roomIdentifier) {
    clearLiveMetadataRefreshInterval();
    await window.letagentsDesktop.room.stopStream();
    return;
  }
  const latestMessageId = selectedSnapshot.value?.messages.at(-1)?.id || null;
  await window.letagentsDesktop.room.startStream(roomIdentifier, latestMessageId);
  startLiveMetadataRefreshInterval();
}

async function loadFirstRunRoomContext(): Promise<void> {
  try {
    const [nextAppInfo, nextRepoStatus, nextRootRoomSnapshot] = await Promise.all([
      window.letagentsDesktop.app.getInfo(),
      window.letagentsDesktop.repos.getStatus(),
      window.letagentsDesktop.room.getSnapshot(selectedRootRoomIdentifier.value),
    ]);
    appInfo.value = nextAppInfo;
    repoStatus.value = nextRepoStatus;
    rootRoomSnapshot.value = nextRootRoomSnapshot;
    selectedSnapshot.value = nextRootRoomSnapshot;
    selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
    rememberRootRoomSnapshot(nextRootRoomSnapshot);
    reconcileActiveEntry();
  } catch {
    // First-run should still be usable if room preview is unavailable before auth.
  }
}

function resolveSelectedRoomIdentifier(baseRootSnapshot: DesktopRoomSnapshot | null): string | null {
  if (!baseRootSnapshot) return null;
  if (activeEntry.value.type !== "room") return baseRootSnapshot.roomIdentifier;
  if (activeEntry.value.kind !== "focus") return activeEntry.value.roomIdentifier || baseRootSnapshot.roomIdentifier;
  const focusRoom = baseRootSnapshot.focusRooms.find((room) => `room:focus:${room.roomId}` === activeEntry.value.id);
  return activeEntry.value.roomIdentifier || focusRoom?.identifier || null;
}

function reconcileActiveEntry(): void {
  if (!activeEntryRestored) {
    activeEntryRestored = true;
    if (restoreActiveEntryFromStorage()) return;
  }

  if (activeEntry.value.type !== "room") return;

  if (activeEntry.value.kind === "focus") {
    const nextFocus = projectEntries.value
      .flatMap((project) => project.focusRooms)
      .find((room) => room.id === activeEntry.value.id);
    activeEntry.value = nextFocus || currentParentRoom.value;
    return;
  }

  const nextParent = projectEntries.value.find((project) => project.parent.id === activeEntry.value.id)?.parent;
  activeEntry.value = nextParent || currentParentRoom.value;
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

function openRoomSnapshot(
  snapshot: DesktopRoomSnapshot,
  options: { rootPath?: string | null; meta?: string | null } = {}
): void {
  rootRoomSnapshot.value = snapshot;
  selectedSnapshot.value = snapshot;
  selectedRootRoomIdentifier.value = snapshot.roomIdentifier;
  rememberRootRoomSnapshot(snapshot, options);
  activeEntry.value = currentParentRoom.value;
}

function settingsRoomActionKey(action: "delete" | "leave" | "pin" | "restore", room: DesktopAccountRoomEntry): string {
  return `${action}:${room.roomIdentifier}`;
}

function forgetRecentRootRoom(roomIdentifier: string): void {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedRoomIdentifier) return;
  const nextRecentRooms = recentRootRooms.value.filter(
    (room) => normalizeRoomIdentifier(room.identifier) !== normalizedRoomIdentifier
  );
  recentRootRooms.value = nextRecentRooms;
  rememberRecentRootRooms(recentRootRoomsStorageKey, nextRecentRooms);
}

async function openAccountRoomFromSettings(room: DesktopAccountRoomEntry): Promise<void> {
  settingsFeedback.value = { message: `Opening ${room.displayName}...`, state: "info" };
  loading.value = true;
  try {
    const snapshot = await window.letagentsDesktop.room.getSnapshot(room.roomIdentifier);
    openRoomSnapshot(snapshot, { meta: room.role === "admin" ? "Admin" : "Account room" });
    settingsFeedback.value = null;
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : `Could not open ${room.displayName}.`,
      state: "error",
    };
  } finally {
    loading.value = false;
  }
}

async function leaveAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
  if (!window.confirm(`Leave ${room.displayName}? It will be removed from your account room list.`)) {
    return;
  }

  settingsRoomActionBusyKey.value = settingsRoomActionKey("leave", room);
  settingsFeedback.value = { message: `Leaving ${room.displayName}...`, state: "info" };
  try {
    await window.letagentsDesktop.room.leaveAccountRoom(room.roomIdentifier);
    forgetRecentRootRoom(room.roomIdentifier);
    await refreshAccountRooms();
    settingsFeedback.value = { message: `Left ${room.displayName}.`, state: "success" };
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : `Could not leave ${room.displayName}.`,
      state: "error",
    };
  } finally {
    settingsRoomActionBusyKey.value = null;
  }
}

async function toggleAccountRoomPin(room: DesktopAccountRoomEntry): Promise<void> {
  const nextPinned = !room.pinned;
  settingsRoomActionBusyKey.value = settingsRoomActionKey("pin", room);
  settingsFeedback.value = { message: nextPinned ? `Pinning ${room.displayName}...` : `Unpinning ${room.displayName}...`, state: "info" };
  try {
    await window.letagentsDesktop.room.updateAccountRoom(room.roomIdentifier, { pinned: nextPinned });
    await refreshAccountRooms();
    settingsFeedback.value = {
      message: nextPinned ? `${room.displayName} pinned.` : `${room.displayName} unpinned.`,
      state: "success",
    };
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : `Could not update ${room.displayName}.`,
      state: "error",
    };
  } finally {
    settingsRoomActionBusyKey.value = null;
  }
}

async function restoreAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
  settingsRoomActionBusyKey.value = settingsRoomActionKey("restore", room);
  settingsFeedback.value = { message: `Restoring ${room.displayName}...`, state: "info" };
  try {
    await window.letagentsDesktop.room.updateAccountRoom(room.roomIdentifier, { archived: false });
    await refreshAccountRooms();
    settingsFeedback.value = { message: `${room.displayName} restored to your sidebar.`, state: "success" };
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : `Could not restore ${room.displayName}.`,
      state: "error",
    };
  } finally {
    settingsRoomActionBusyKey.value = null;
  }
}

async function deleteAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
  const confirmation = window.prompt(
    `Delete ${room.displayName}? This removes the room and its focus rooms for everyone.\n\nType the room identifier to confirm:`,
    ""
  );
  if (confirmation !== room.roomIdentifier) {
    return;
  }

  settingsRoomActionBusyKey.value = settingsRoomActionKey("delete", room);
  settingsFeedback.value = { message: `Deleting ${room.displayName}...`, state: "info" };
  try {
    await window.letagentsDesktop.room.deleteAccountRoom(room.roomIdentifier);
    forgetRecentRootRoom(room.roomIdentifier);
    accountRooms.value = accountRooms.value.filter(
      (entry) => normalizeRoomIdentifier(entry.roomIdentifier) !== normalizeRoomIdentifier(room.roomIdentifier)
    );
    settingsAccountRooms.value = settingsAccountRooms.value.filter(
      (entry) => normalizeRoomIdentifier(entry.roomIdentifier) !== normalizeRoomIdentifier(room.roomIdentifier)
    );

    if (normalizeRoomIdentifier(selectedRootRoomIdentifier.value) === normalizeRoomIdentifier(room.roomIdentifier)) {
      selectedRootRoomIdentifier.value = null;
      rootRoomSnapshot.value = null;
      selectedSnapshot.value = null;
      activeEntry.value = settingsEntry;
    }

    await refreshAccountRooms();
    settingsFeedback.value = { message: `Deleted ${room.displayName}.`, state: "success" };
  } catch (error) {
    settingsFeedback.value = {
      message: error instanceof Error ? error.message : `Could not delete ${room.displayName}.`,
      state: "error",
    };
  } finally {
    settingsRoomActionBusyKey.value = null;
  }
}

async function createInviteRoom(): Promise<void> {
  newRoomBusy.value = true;
  newRoomFeedback.value = "Creating invite room...";
  newRoomFeedbackState.value = "info";
  try {
    const result = await window.letagentsDesktop.room.createInviteRoom();
    openRoomSnapshot(result.snapshot);
    newRoomFeedback.value = `Invite room created. Join code: ${result.code}.`;
    newRoomFeedbackState.value = "success";
    newRoomJoinCode.value = "";
  } catch (error) {
    newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not create an invite room.";
    newRoomFeedbackState.value = "error";
  } finally {
    newRoomBusy.value = false;
  }
}

async function openProjectRoomFromModal(): Promise<void> {
  newRoomBusy.value = true;
  newRoomFeedback.value = "Opening the project picker...";
  newRoomFeedbackState.value = "info";
  try {
    const result = await window.letagentsDesktop.repos.pickRoom();
    if (result.canceled) {
      newRoomFeedback.value = null;
      return;
    }
    if (result.error || !result.snapshot) {
      newRoomFeedback.value = result.error || "LetAgents could not open a room from that folder.";
      newRoomFeedbackState.value = "error";
      return;
    }
    openRoomSnapshot(result.snapshot, {
      rootPath: result.repoPath,
      meta: rootPathLabel(result.repoPath) || result.source || null,
    });
    newRoomFeedback.value = result.warning
      ? `${result.warning} Room selected.`
      : "Project room selected.";
    newRoomFeedbackState.value = "success";
    newRoomModalOpen.value = false;
    newRoomJoinCode.value = "";
  } catch (error) {
    newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the project picker.";
    newRoomFeedbackState.value = "error";
  } finally {
    newRoomBusy.value = false;
  }
}

async function joinRoomCodeFromModal(): Promise<void> {
  const roomCode = newRoomJoinCode.value.trim();
  if (!roomCode) return;
  newRoomBusy.value = true;
  newRoomFeedback.value = "Joining room...";
  newRoomFeedbackState.value = "info";
  try {
    const snapshot = await window.letagentsDesktop.room.getSnapshot(roomCode);
    openRoomSnapshot(snapshot, { meta: snapshot.room?.code || "Joined room" });
    newRoomFeedback.value = snapshot.access.status === "ready"
      ? "Room selected."
      : snapshot.access.message;
    newRoomFeedbackState.value = snapshot.access.status === "ready" ? "success" : "error";
    if (snapshot.access.status === "ready") {
      newRoomModalOpen.value = false;
      newRoomJoinCode.value = "";
    }
  } catch (error) {
    newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
    newRoomFeedbackState.value = "error";
  } finally {
    newRoomBusy.value = false;
  }
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
    openRoomSnapshot(result.snapshot, {
      rootPath: result.repoPath,
      meta: rootPathLabel(result.repoPath) || result.source || null,
    });
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
    openRoomSnapshot(snapshot, { meta: snapshot.room?.code || "Joined room" });
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
    rememberActiveEntryId(nextEntry.id);
    if (!rootRoomSnapshot.value) return;
    if (nextEntry.id === previousEntry?.id) return;
    await refreshSelectedSnapshot(rootRoomSnapshot.value);
  }
);

watch(
  () => selectedRootRoomIdentifier.value,
  (roomIdentifier) => {
    rememberSelectedRootRoomIdentifier(roomIdentifier);
  },
  { immediate: true }
);

watch(
  () => selectedRoomIdentifier.value,
  (roomIdentifier) => {
    void syncSelectedRoomStream(roomIdentifier);
  }
);

watch(
  () => latestSelectedMessageId.value,
  () => {
    if (!selectedRoomIdentifier.value) return;
    void syncSelectedRoomStream(selectedRoomIdentifier.value);
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
  clearLiveMetadataRefreshTimer();
  clearLiveMetadataRefreshInterval();
  unsubscribeRoomStream?.();
  unsubscribeRoomStream = null;
  void window.letagentsDesktop.room.stopStream();
});
</script>
