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
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomSnapshot,
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
import { useDesktopAccountRoomSettings } from "./composables/useDesktopAccountRoomSettings";
import { useDesktopAppData } from "./composables/useDesktopAppData";
import { useDesktopAuthFlow } from "./composables/useDesktopAuthFlow";
import { useDesktopNavigationState } from "./composables/useDesktopNavigationState";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import { useDesktopSetupOnboarding } from "./composables/useDesktopSetupOnboarding";
import {
  diagnosticsEntry,
  settingsEntry,
  setupEntry,
  systemEntries,
  workersEntry,
} from "./domain/desktop-navigation";
import { readStoredString, rememberStoredString } from "./domain/desktop-storage";
import {
  readStoredRecentRootRooms,
} from "./domain/sidebar-rooms";

const loading = ref(false);
const appInfo = ref<DesktopAppInfo | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const authStatus = ref<DesktopAuthStatus | null>(null);
const selectedRootRoomStorageKey = "letagents-desktop:selected-root-room";
const activeEntryStorageKey = "letagents-desktop:active-entry";
const recentRootRoomsStorageKey = "letagents-desktop:recent-root-rooms";
const selectedRootRoomIdentifier = ref<string | null>(readStoredString(selectedRootRoomStorageKey));
const recentRootRooms = ref(readStoredRecentRootRooms(recentRootRoomsStorageKey));
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
  activeEntry,
  collapsedProjects,
  collapsedSections,
  currentParentRoom,
  cycleSidebar,
  focusRooms,
  getAuthRoomIdentifier,
  openRoomSnapshot,
  pinnedRoom,
  projectEntries,
  reconcileActiveEntry,
  rememberRootRoomSnapshot,
  repoName,
  resolveSelectedRoomIdentifier,
  selectSidebarEntry,
  selectedAccess,
  selectedFocusRooms,
  selectedNeedsAccess,
  selectedRoomIdentifier,
  selectedRoomInfo,
  sidebarMode,
  toggleProject,
  toggleSection,
} = useDesktopNavigationState({
  accountRooms,
  activeEntryStorageKey,
  appInfo,
  recentRootRooms,
  recentRootRoomsStorageKey,
  repoStatus,
  rootRoomSnapshot,
  selectedRootRoomIdentifier,
  selectedSnapshot,
});

let unsubscribeRoomStream: (() => void) | null = null;

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

const {
  handleMessageSent,
  handleRefreshRoom,
  handleRoomRenamed,
  handleRoomStreamEvent,
  loadFirstRunRoomContext,
  refresh,
  refreshAccountRooms,
  refreshSelectedSnapshot,
  repoStatusValue,
  upsertSelectedTask,
} = useDesktopAppData({
  accountRooms,
  activeEntry,
  appInfo,
  authStatus,
  currentParentRoom,
  diagnostics,
  loading,
  mcpInstallState,
  reconcileActiveEntry,
  rememberRootRoomSnapshot,
  repoStatus,
  resolveSelectedRoomIdentifier,
  rootRoomSnapshot,
  scheduleLiveMetadataRefresh,
  selectedMcpTargetIds,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  workers,
});

const {
  authBusy,
  authFeedback,
  clearAuthPollTimer,
  openVerification,
  pollAuthFlow,
  scheduleAuthPoll,
  signOut,
  startAuthFlow,
} = useDesktopAuthFlow({
  authStatus,
  getRoomIdentifier: () => getAuthRoomIdentifier(),
  isFirstRunGate: () => !mcpInstallState.value || !mcpInstallState.value.completed || !authStatus.value?.authenticated,
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

const {
  clearMcpTargetSelection,
  completeMcpOnboarding,
  continueMcpOnboarding,
  continueToRoomConfirmation,
  finishFirstRunOnboarding,
  firstRunFeedback,
  goBackFirstRun,
  goBackMcpOnboarding,
  installSelectedMcpTargets,
  joinRoomCode,
  loadFirstRunSetup,
  pickRepoRoom,
  selectAllMcpTargets,
  selectMcpTarget,
  setupApiAvailable,
  showFirstRunGate,
  showMcpInstaller,
  visibleMcpInstallState,
} = useDesktopSetupOnboarding({
  activeEntry,
  authFeedback,
  authStatus,
  firstRunStage,
  loading,
  loadFirstRunRoomContext,
  mcpInstallBusy,
  mcpInstallFeedback,
  mcpInstallState,
  mcpWizardStep,
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  pinnedRoom,
  refresh: () => refresh(),
  selectedMcpTargetIds,
  setupLoadError,
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
