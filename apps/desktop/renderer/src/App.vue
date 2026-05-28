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

    <DesktopNewRoomModal
      v-if="newRoomModalOpen"
      v-model:join-code="newRoomJoinCode"
      :busy="newRoomBusy"
      :feedback="newRoomFeedback"
      :feedback-state="newRoomFeedbackState"
      @close="closeNewRoomModal"
      @create-invite="createInviteRoom"
      @open-project="openProjectRoomFromModal"
      @join="joinRoomCodeFromModal"
    />
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
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
import DesktopNewRoomModal from "./components/desktop/content/DesktopNewRoomModal.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import McpInstallOnboardingView from "./components/desktop/content/McpInstallOnboardingView.vue";
import DiagnosticsView from "./components/desktop/content/DiagnosticsView.vue";
import RepoStatusView from "./components/desktop/content/RepoStatusView.vue";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import WorkerStatusView from "./components/desktop/content/WorkerStatusView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { ProjectGroup, RoomEntry, SidebarEntry, SidebarMode } from "./components/desktop/types";
import { useDesktopAccountRoomSettings } from "./composables/useDesktopAccountRoomSettings";
import { useDesktopAuthFlow } from "./composables/useDesktopAuthFlow";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import {
  diagnosticsEntry,
  settingsEntry,
  setupEntry,
  systemEntries,
  workersEntry,
} from "./domain/desktop-navigation";
import {
  appendSnapshotMessage,
  mergeRoomSnapshotMessages,
  removeSnapshotReasoningSession,
  roomSnapshotsMatch,
  shouldRefreshMetadataForMessage,
  snapshotMatchesRoom,
  upsertSnapshotReasoningSession,
  upsertSnapshotTask,
} from "./domain/desktop-room-snapshots";
import { readStoredString, rememberStoredString } from "./domain/desktop-storage";
import { defaultMcpTargetSelection, fallbackMcpInstallState } from "./domain/mcp-install";
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
const selectedRootRoomIdentifier = ref<string | null>(readStoredString(selectedRootRoomStorageKey));
const recentRootRooms = ref<RecentRootRoom[]>(readStoredRecentRootRooms(recentRootRoomsStorageKey));
const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
const diagnostics = ref<DiagnosticsSnapshot | null>(null);
const mcpInstallState = ref<DesktopMcpInstallState | null>(null);
const selectedMcpTargetIds = ref<DesktopMcpInstallTargetId[]>([]);
const mcpInstallBusy = ref(false);
const mcpInstallFeedback = ref<string | null>(null);
const setupLoadError = ref<string | null>(null);
const mcpWizardStep = ref<DesktopMcpWizardStep>("choose");
const firstRunStage = ref<FirstRunWizardStage>("mcp");
const {
  authBusy,
  authFeedback,
  authStatus,
  clearAuthPollTimer,
  openVerification,
  pollAuthFlow,
  scheduleAuthPoll,
  signOut,
  startAuthFlow,
} = useDesktopAuthFlow({
  getRoomIdentifier: () => getAuthRoomIdentifier(),
  isFirstRunGate: () => showFirstRunGate.value,
  onFirstRunAuthorized: async () => {
    await loadFirstRunRoomContext();
    firstRunStage.value = "room";
  },
  onAuthorized: () => refresh(),
  onSignedOut: () => refresh(),
});
const {
  closeNewRoomModal,
  createInviteRoom,
  joinRoomCodeFromModal,
  newRoomBusy,
  newRoomFeedback,
  newRoomFeedbackState,
  newRoomJoinCode,
  newRoomModalOpen,
  openProjectRoomFromModal,
  selectNewRoomEntry,
} = useDesktopNewRoomModal({
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
});
let unsubscribeRoomStream: (() => void) | null = null;
let activeEntryRestored = false;

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
const {
  clearLiveMetadataRefreshInterval,
  clearLiveMetadataRefreshTimer,
  scheduleLiveMetadataRefresh,
  syncSelectedRoomStream,
} = useDesktopRoomLiveSync({
  rootRoomSnapshot,
  selectedRoomIdentifier,
  selectedSnapshot,
  workers,
});

const showMcpInstaller = computed(() => {
  if (!mcpInstallState.value) return false;
  return activeEntry.value.id === setupEntry.id;
});

const showFirstRunGate = computed(() => {
  return !mcpInstallState.value || !mcpInstallState.value.completed || !authStatus.value?.authenticated;
});

const visibleMcpInstallState = computed<DesktopMcpInstallState>(() => {
  return mcpInstallState.value || fallbackMcpInstallState;
});

const setupApiAvailable = computed(() => {
  return Boolean(window.letagentsDesktop?.setup);
});

const firstRunFeedback = computed(() => {
  return mcpInstallFeedback.value || authFeedback.value || setupLoadError.value;
});

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
const {
  deleteAccountRoom,
  leaveAccountRoom,
  openAccountRoomFromSettings,
  refreshSettings,
  restoreAccountRoom,
  settingsFeedback,
  settingsRoomActionBusyKey,
  toggleAccountRoomPin,
} = useDesktopAccountRoomSettings({
  accountRooms,
  activeEntry,
  loading,
  recentRootRooms,
  recentRootRoomsStorageKey,
  rootRoomSnapshot,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  settingsEntry,
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  refresh: () => refresh(),
  refreshAccountRooms: () => refreshAccountRooms(),
});

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
  const storedEntryId = readStoredString(activeEntryStorageKey);
  if (!storedEntryId) return false;
  const storedEntry = findSidebarEntryById(storedEntryId);
  if (!storedEntry) return false;
  activeEntry.value = storedEntry;
  return true;
}

function selectSidebarEntry(entry: SidebarEntry): void {
  activeEntry.value = entry;
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

function upsertSelectedTask(task: DesktopTaskSummary): void {
  selectedSnapshot.value = upsertSnapshotTask(selectedSnapshot.value, task);
}

function handleRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  if (!snapshotMatchesRoom(selectedSnapshot.value, event.roomIdentifier)) return;

  if (event.type === "open") {
    scheduleLiveMetadataRefresh(0);
    return;
  }

  if (event.type === "message") {
    selectedSnapshot.value = appendSnapshotMessage(selectedSnapshot.value, event.message);
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
    selectedSnapshot.value = upsertSnapshotReasoningSession(selectedSnapshot.value, event.session);
    scheduleLiveMetadataRefresh();
    return;
  }

  if (event.type === "reasoning_remove") {
    selectedSnapshot.value = removeSnapshotReasoningSession(selectedSnapshot.value, event.sessionId);
    scheduleLiveMetadataRefresh();
    return;
  }

  if (
    event.type === "rental_activity" ||
    event.type === "rental_patch" ||
    event.type === "rental_usage"
  ) {
    scheduleLiveMetadataRefresh(0);
    return;
  }

  if (event.type === "rental_quota_exhausted") {
    scheduleLiveMetadataRefresh(0);
  }
}

function handleRefreshRoom(): void {
  void refreshSelectedSnapshot();
  scheduleLiveMetadataRefresh(0);
}

function handleMessageSent(message: DesktopRoomMessage): void {
  selectedSnapshot.value = appendSnapshotMessage(selectedSnapshot.value, message);
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
    rememberStoredString(activeEntryStorageKey, nextEntry.id);
    if (!rootRoomSnapshot.value) return;
    if (nextEntry.id === previousEntry?.id) return;
    await refreshSelectedSnapshot(rootRoomSnapshot.value);
  }
);

watch(
  () => selectedRootRoomIdentifier.value,
  (roomIdentifier) => {
    rememberStoredString(selectedRootRoomStorageKey, roomIdentifier);
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
  () => selectedSnapshot.value?.messages.at(-1)?.id || null,
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
