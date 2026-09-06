<template>
  <FirstRunSplashView v-if="showFirstRunSplash" />

  <main v-else-if="showFirstRunGate" class="desktop-onboarding-shell" data-testid="desktop-first-run-onboarding">
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
      :room-selected="firstRunRoomSelected"
      :created-invite-code="firstRunInviteCode"
      :selected-room-name="firstRunRoomSelected ? (rootRoomSnapshot?.room?.displayName || repoName) : null"
      :selected-room-identifier="firstRunRoomSelected ? (rootRoomSnapshot?.roomIdentifier || null) : null"
      :selected-room-access-status="firstRunRoomSelected ? (rootRoomSnapshot?.access.status || null) : null"
      :room-needs-github-access="firstRunRoomSelected && rootRoomSnapshot?.access.status === 'auth_required' && !authStatus?.authenticated"
      @select-target="selectMcpTarget"
      @select-all-targets="selectAllMcpTargets"
      @clear-target-selection="clearMcpTargetSelection"
      @continue-mcp="continueMcpOnboarding"
      @start-setup="startFirstRunSetup"
      @install-targets="installSelectedMcpTargets"
      @continue-to-github="completeMcpOnboarding"
      @start-auth="startAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
      @cancel-auth="cancelAuthFlow"
      @sign-out="signOut"
      @continue-to-room="continueToRoomConfirmation"
      @connect-room-auth="startFirstRunRoomAuth"
      @pick-repo="pickRepoRoom"
      @create-room="createFirstRunInviteRoom"
      @join-room-code="joinRoomCode"
      @back="goBackFirstRun"
      @finish="finishFirstRunOnboarding"
    />
  </main>

  <main
    v-else-if="showSignedOutGate"
    class="desktop-onboarding-shell desktop-signed-out-shell"
    data-testid="desktop-signed-out-gate"
  >
    <DesktopSignedOutView
      :auth-status="authStatus"
      :busy="authBusy || loading"
      :feedback="authFeedback"
      @start-auth="startSignedOutAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
    />
  </main>

  <main
    v-else
    class="desktop-shell"
    :data-sidebar-mode="isSettingsSurface ? 'hidden' : sidebarMode"
    :data-sidebar-resizing="isSidebarResizing"
    :style="desktopShellStyle"
    data-testid="desktop-shell"
  >
    <Transition name="desktop-sidebar">
      <div
        v-show="!isSettingsSurface && sidebarMode !== 'hidden'"
        class="desktop-sidebar-frame"
        :aria-hidden="isSettingsSurface || sidebarMode === 'hidden'"
        :inert="isSettingsSurface || sidebarMode === 'hidden'"
      >
        <DesktopSidebar
          :active-entry="activeEntry"
          :primary-room="currentParentRoom"
          :project-entries="sidebarProjectEntries"
          :settings-entry="settingsEntry"
          :rental-request-count="rentalRequestCount"
          :pinned-collapsed="pinnedCollapsed"
          :rooms-collapsed="roomsCollapsed"
          :collapsed-projects="collapsedProjects"
          :selection-active="sidebarSelectionActive"
          :selected-entry-ids="sidebarSelectedEntryIds"
          :batch-action-busy="sidebarBatchActionBusy"
          :update-status="updateStatus"
          :auth-status="authStatus"
          :auth-busy="authBusy || loading"
          @cycle-sidebar="cycleSidebar"
          @new-room="selectNewRoomEntry"
          @open-rent="openRentMarketplace"
          @open-updates="openUpdatesSurface"
          @open-settings="openSettingsSurface"
          @connect-account="openAccountAuthFlow"
          @sign-out="signOut"
          @archive-room="archiveSidebarRoom"
          @archive-focus-room="archiveSidebarFocusRoom"
          @conclude-focus-room="openSidebarFocusRoomConclusion"
          @mark-room-read="markRoomEntryRead"
          @pin-room="togglePinSidebarRoom"
          @rename-room="renameSidebarRoom"
          @start-selection="startSidebarRoomSelection"
          @cancel-selection="cancelSidebarRoomSelection"
          @toggle-entry-selection="toggleSidebarRoomSelection"
          @set-entry-selection="setSidebarRoomSelection"
          @batch-action="handleSidebarBatchAction"
          @select-entry="handleSidebarEntrySelected"
          @set-projects-collapsed="setAllProjectsCollapsed"
          @reorder-parent-room="handleSidebarParentRoomReorder"
          @reorder-child-room="handleSidebarChildRoomReorder"
          @toggle-project="toggleProject"
          @toggle-pinned-collapsed="togglePinnedCollapsed"
          @toggle-rooms-collapsed="toggleRoomsCollapsed"
        />
      </div>
    </Transition>
    <div
      v-if="showSidebarResizeHandle"
      class="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      :aria-valuemin="sidebarMinWidth"
      :aria-valuemax="sidebarMaxWidth"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      data-testid="sidebar-resize-handle"
      @pointerdown="startSidebarResize"
      @keydown="handleSidebarResizeKeydown"
    ></div>
    <section class="app-main" :data-room-entry="activeEntry.type === 'room'" data-testid="desktop-main">
      <DesktopTopbar
        v-if="activeEntry.type !== 'room' && activeEntry.type !== 'marketplace' && !isSettingsSurface"
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="openSettingsSurface"
        @refresh="refresh"
      />

      <AuthOnboardingView
        v-if="activeEntry.type === 'room' && selectedNeedsAccess"
        :sidebar-mode="sidebarMode"
        :access="selectedAccess"
        :auth-status="authStatus"
        :busy="authBusy || loading"
        :feedback="authFeedback"
        :snapshot-pending="authSnapshotPending"
        :room-label="selectedRoomInfo.displayName || selectedRoomInfo.name"
        @start-auth="startAuthFlow"
        @open-verification="openVerification"
        @poll-auth="pollAuthFlow"
        @refresh-room="refresh"
        @sign-out="signOut"
        @cycle-sidebar="cycleSidebar"
      />

      <KeepAlive :max="1">
        <DesktopRoomShell
          v-if="activeEntry.type === 'room' && !selectedNeedsAccess"
          :key="selectedRoomRenderKey"
          :sidebar-mode="sidebarMode"
          :room-loading="selectedSnapshotLoading"
          :room="selectedRoomWithProjectContext"
          :storage="selectedRoomStorage"
          :focus-rooms="selectedFocusRooms"
          :tasks="selectedSnapshot?.tasks || []"
          :participants="selectedSnapshot?.participants || []"
          :participant-hidden-count="selectedSnapshot?.participantHiddenCount || 0"
          :presence="selectedSnapshot?.presence || []"
          :reasoning-sessions="selectedSnapshot?.reasoningSessions || []"
          :recent-activity="selectedSnapshot?.recentActivity || []"
          :room-artifacts="selectedSnapshot?.roomArtifacts || []"
          :room-agent-work="roomAgentWork"
          :room-agent-work-status="roomAgentWorkStatus"
          :room-agent-work-truncated="roomAgentWorkTruncated"
          :board-settings="selectedSnapshot?.boardSettings || null"
          :messages="selectedSnapshot?.messages || []"
          :github-events="selectedSnapshot?.githubEvents || null"
          :source-states="selectedSnapshot?.sourceStates || null"
          :repo-status="repoStatusValue"
          :git-room-matches-active-repo="selectedGitRoomMatchesActiveRepo"
          :durable-project-root-path="selectedRoomProjectRootPath"
          :project-room="selectedRoomIsProject"
          :workers="workers"
          :open-add-agent-requested="openAddAgentAfterRepoPick"
          :notification-reveal-message-id="notificationRevealMessageId"
          :notification-reveal-nonce="notificationRevealNonce"
          :initial-chat-scroll-top="chatScrollTopForRoom(selectedRoomInfo.identifier)"
          :on-focus-room-concluded="handleRoomDetailsFocusRoomConcluded"
          @chat-scroll-position="rememberChatScrollPosition"
          @message-sent="handleOwnMessageSent"
          @room-renamed="handleRoomRenamed"
          @task-updated="upsertSelectedTask"
          @refresh-room="handleRoomShellRefresh"
          @message-reveal-unavailable="handleRoomMessageRevealUnavailable"
          @open-rental-request="openRentalRequestInbox"
          @open-focus-room="openFocusRoomFromRoomsTab"
          @request-focus-room-conclusion="openRoomDetailsFocusRoomConclusion"
          @cycle-sidebar="cycleSidebar"
          @connect-project="connectActiveRoomProject"
          @choose-worktree="openWorktreeForAgent"
          @open-repo-root="openWorkspaceGitRoom"
          @add-agent-open-request-consumed="openAddAgentAfterRepoPick = false"
        />
      </KeepAlive>

      <SettingsView
        v-if="activeEntry.type === 'system'"
        :account-rooms="settingsAccountRooms"
        :app-info="appInfo"
        :app-agent-actions="appAgentActions"
        :app-agent-busy="appAgentBusy"
        :app-agent-feedback="appAgentFeedback"
        :app-agent-settings="appAgentSettingsStatus"
        :auth-status="authStatus"
        :busy="loading || authBusy"
        :chat-storage-busy="chatStorageBusy"
        :chat-storage-feedback="chatStorageFeedback"
        :chat-storage-settings="chatStorageSettings"
        :chat-storage-available="chatStorageAvailable"
        :diagnostics-notes="diagnostics?.notes || []"
        :feedback="settingsFeedback"
        :initial-pane="settingsPaneForActiveEntry"
        :mcp-install-busy="mcpInstallBusy || loading"
        :mcp-install-feedback="mcpInstallFeedback"
        :mcp-install-state="visibleMcpInstallState"
        :mcp-wizard-step="mcpWizardStep"
        :repo-status="repoStatusValue"
        :room-action-busy-key="settingsRoomActionBusyKey"
        :selected-mcp-target-ids="selectedMcpTargetIds"
        :selected-room-identifier="selectedRoomIdentifier"
        :setup-api-available="setupApiAvailable"
        :workers="workers"
        :update-status="updateStatus"
        @back-mcp="goBackMcpOnboarding"
        @back-to-app="activeEntry = currentParentRoom"
        @clear-mcp-target-selection="clearMcpTargetSelection"
        @continue-mcp="continueMcpOnboarding"
        @delete-room="deleteAccountRoom"
        @finish-mcp="completeMcpOnboarding"
        @install-mcp-targets="installSelectedMcpTargets"
        @check-update="checkDesktopUpdate"
        @install-update="installDesktopUpdate"
        @leave-room="leaveAccountRoom"
        @open-room="openAccountRoomFromSettings"
        @restore-room="restoreAccountRoom"
        @select-all-mcp-targets="selectAllMcpTargets"
        @select-mcp-target="selectMcpTarget"
        @save-app-agent-settings="saveAppAgentSettings"
        @set-chat-storage-mode="setChatStorageMode"
        @sync-local-chat="syncLocalChat"
        @toggle-pin-room="toggleAccountRoomPin"
        @refresh="refreshSettingsSurface"
        @sign-out="signOut"
        @start-auth="openAccountAuthFlow"
      />

      <RentMarketplaceView
        v-else-if="activeEntry.type === 'marketplace'"
        :rooms="settingsAccountRooms"
        :initial-role="rentMarketplaceRole"
      />

    </section>

    <DesktopAppAgent
      v-if="appAgentSettingsStatus?.enabled === true"
      :active-room-display-name="selectedRoomInfo.displayName || activeEntry.title"
      :active-room-identifier="selectedRoomIdentifier || selectedRootRoomIdentifier"
      :active-room-pinned="activeEntry.type === 'room' && activeEntry.pinned"
      :active-room-git-room="selectedRoomInfo.gitRoom"
      :busy="appAgentBusy"
      :result="appAgentResult"
      :settings-status="appAgentSettingsStatus"
      @clear-result="appAgentResult = null"
      @open-settings="openAppAgentSettings"
      @run="runAppAgent"
    />

    <Transition name="new-room-modal">
      <DesktopNewRoomModal
        v-if="newRoomModalOpen"
        v-model:join-code="newRoomJoinCode"
        v-model:room-name="newRoomName"
        v-model:storage="newRoomStorage"
        :step="newRoomStep"
        :busy="newRoomBusy"
        :active-action="newRoomActiveAction"
        :feedback="newRoomFeedback"
        :feedback-state="newRoomFeedbackState"
        :project-selection="newRoomProjectSelection"
        :success="newRoomSuccess"
        :status-message="newRoomStatusMessage"
        :join-error="newRoomJoinError"
        :can-submit-join="canSubmitJoin"
        :can-submit-standalone="canSubmitStandalone"
        @back="backFromSubstep"
        @choose-join="chooseJoinIntent"
        @choose-project="chooseProjectIntent"
        @choose-standalone="chooseStandaloneIntent"
        @close="closeNewRoomModal"
        @confirm-project="confirmProjectRoomFromModal"
        @copy-code="copyInviteCode"
        @create-standalone="createStandaloneRoom"
        @dismiss-success="dismissSuccess"
        @open-project="openProjectRoomFromModal"
        @open-success="openSuccessRoom"
        @join="joinRoomCodeFromModal"
        @retry="retryLastAction"
      />
    </Transition>

    <SidebarFocusRoomConclusionDialog
      :open="Boolean(sidebarFocusRoomConclusionTarget)"
      :entry="sidebarFocusRoomConclusionTarget"
      :busy="sidebarFocusRoomConclusionBusy"
      :error="sidebarFocusRoomConclusionError"
      :fallback-focus-entry-id="sidebarFocusRoomConclusionReturnFocusId"
      @close="closeSidebarFocusRoomConclusion"
      @submit="submitSidebarFocusRoomConclusion"
      @after-leave="handleSidebarFocusRoomConclusionAfterLeave"
    />

    <SidebarRoomBatchActionDialog
      :open="Boolean(sidebarBatchDialogAction)"
      :action="sidebarBatchDialogAction"
      :entries="sidebarBatchDialogTargets"
      :busy="Boolean(sidebarBatchActionBusy)"
      :error="sidebarBatchDialogError"
      @close="closeSidebarBatchDialog"
      @confirm="confirmSidebarBatchAction"
      @after-leave="handleSidebarBatchDialogAfterLeave"
    />

    <DesktopDeviceAuthDialog
      :open="authDialogOpen"
      :auth-status="authStatus"
      :busy="authBusy"
      :feedback="authFeedback"
      @close="authDialogOpen = false"
      @start-auth="startAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
    />

    <div
      class="desktop-action-toasts"
      role="status"
      :aria-live="actionToasts.some((toast) => toast.state === 'error') ? 'assertive' : 'polite'"
      data-testid="desktop-action-toasts"
    >
      <button
        v-for="toast in actionToasts"
        :key="toast.id"
        type="button"
        class="desktop-action-toast"
        :data-state="toast.state"
        @click="dismissActionToast(toast.id)"
      >
        {{ toast.message }}
      </button>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopChatStorageSettings,
  DesktopFocusRoomInfo,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopUpdateStatus,
  DesktopNotificationTarget,
  DesktopProjectBinding,
  DesktopRoomLatestMessage,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import SidebarFocusRoomConclusionDialog from "./components/desktop/sidebar/SidebarFocusRoomConclusionDialog.vue";
import SidebarRoomBatchActionDialog from "./components/desktop/sidebar/SidebarRoomBatchActionDialog.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import DesktopNewRoomModal from "./components/desktop/content/DesktopNewRoomModal.vue";
import DesktopDeviceAuthDialog from "./components/desktop/content/DesktopDeviceAuthDialog.vue";
import DesktopAppAgent from "./components/desktop/app-agent/DesktopAppAgent.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import DesktopSignedOutView from "./components/desktop/content/DesktopSignedOutView.vue";
import { isAuthSnapshotPending } from "./components/desktop/content/auth-onboarding";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import FirstRunSplashView from "./components/desktop/setup/FirstRunSplashView.vue";
import type { ProjectGroup, RoomEntry, SidebarEntry } from "./components/desktop/types";
import {
  activeRepoRoomContext,
  readRepositoryRootBindings,
  resolveActiveProjectRootPath,
  roomWithInheritedProjectContext,
} from "./domain/room-project-context";
import type {
  FocusRoomConcludedEvent,
  FocusRoomConclusionInput,
} from "./domain/focus-room-conclusion";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { SettingsPaneId } from "./components/desktop/settings/types";
import {
  useDesktopAccountRoomSettings,
  type SidebarRoomBatchMutationResult,
} from "./composables/useDesktopAccountRoomSettings";
import { useDesktopActionToasts } from "./composables/useDesktopActionToasts";
import { useDesktopAppData } from "./composables/useDesktopAppData";
import { useDesktopAuthFlow } from "./composables/useDesktopAuthFlow";
import { useDesktopNavigationState } from "./composables/useDesktopNavigationState";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import { useDesktopSetupOnboarding } from "./composables/useDesktopSetupOnboarding";
import { loadRentalProviderDashboard, useRentalProviderEvents } from "./composables/useRentalProviderEvents";
import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "./domain/chat-scroll";
import { appAgentEntry, rentMarketplaceEntry, settingsEntry } from "./domain/desktop-navigation";
import { readStoredString, rememberStoredString } from "./domain/desktop-storage";
import {
  deriveSidebarLatestMessages,
  hasUnreadRoomActivity,
  markRoomRead,
  readStoredRoomMessageIds,
  roomReadKey,
  seedRoomReadMarker,
} from "./domain/desktop-room-read-state";
import {
  normalizeRoomIdentifier,
  findSidebarRoomEntryByIdentifier,
  readStoredRecentRootRooms,
  rememberRecentRootRooms,
} from "./domain/sidebar-rooms";
import {
  flattenSidebarRoomEntries,
  isSidebarRoomSelectable,
  resolveSidebarRoomBatchAction,
  type SidebarRoomBatchActionId,
} from "./domain/sidebar-room-selection";
import {
  applySidebarRoomOrder,
  orderedSidebarChildRooms,
  readStoredSidebarRoomOrder,
  rememberSidebarRoomOrder,
  reorderSidebarChildRooms,
  reorderSidebarParentRooms,
  type SidebarChildRoomReorder,
  type SidebarParentRoomReorder,
} from "./domain/sidebar-room-order";
import {
  appAgentArchivedRoomIdentifiers,
  appAgentRefreshTargets,
} from "./domain/app-agent";
import { openManagedAgentWorktree } from "./domain/managed-agent-worktrees";
import { APP_IDLE_ATTRIBUTE, isAppIdle } from "./domain/app-idle";
import { shouldSkipPollTick } from "./domain/visibility-polling";
import { desktopIpc } from "./ipc/index.js";

const RentMarketplaceView = defineAsyncComponent(
  () => import("./components/desktop/content/RentMarketplaceView.vue"),
);

const loading = ref(false);
const appInfo = ref<DesktopAppInfo | null>(null);
const updateStatus = ref<DesktopUpdateStatus | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const authStatus = ref<DesktopAuthStatus | null>(null);
const sessionGeneration = ref(0);
const authDialogOpen = ref(false);
const selectedRootRoomStorageKey = "letagents-desktop:selected-root-room";
const activeEntryStorageKey = "letagents-desktop:active-entry";
const recentRootRoomsStorageKey = "letagents-desktop:recent-root-rooms";
const legacyRepositoryRootBindingsStorageKey = "letagents-desktop:repository-root-bindings";
const readRoomMessagesStorageKey = "letagents-desktop:read-room-message-ids";
const sidebarWidthStorageKey = "letagents-desktop:sidebar-width";
const sidebarRoomOrderStorageKey = "letagents-desktop:sidebar-room-order";
const sidebarMinWidth = 260;
const sidebarMaxWidth = 440;
const sidebarDefaultWidth = 296;
// Sidebar room metadata poll cadence. Since PR #820 this is one light
// `/account/rooms` request per tick, and `refreshForegroundData` already fires
// the same work on focus/visibility, so a 15s steady-state interval is plenty —
// an aggressive 5s cadence was redundant against the foreground-return refresh.
const SIDEBAR_METADATA_REFRESH_INTERVAL_MS = 15_000;
const selectedRootRoomIdentifier = ref<string | null>(readStoredString(selectedRootRoomStorageKey));
const recentRootRooms = ref(readStoredRecentRootRooms(recentRootRoomsStorageKey));
const legacyRepositoryRootBindings = readRepositoryRootBindings(
  window.localStorage,
  legacyRepositoryRootBindingsStorageKey,
  recentRootRooms.value,
);
const projectBindings = ref<DesktopProjectBinding[]>([]);
const readRoomMessageIds = ref(readStoredRoomMessageIds(window.localStorage, readRoomMessagesStorageKey));
const sidebarWidth = ref(readStoredSidebarWidth());
const sidebarRoomOrder = ref(readStoredSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey));
const isSidebarResizing = ref(false);
const sidebarLatestMessages = ref<Record<string, DesktopRoomLatestMessage>>({});
const chatScrollTopByRoom = ref<Record<string, number>>({});
const loadingChatScrollRoomIdentifiers = ref<Set<string>>(new Set());
const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
const rentalRequestCount = ref(0);
const rentMarketplaceRole = ref<"renter" | "provider">("renter");
const openAddAgentAfterRepoPick = ref(false);
const notificationRevealMessageId = ref<string | null>(null);
const notificationRevealNonce = ref(0);
const chatStorageSettings = ref<DesktopChatStorageSettings | null>(null);
const chatStorageAvailable = ref(true);
const chatStorageBusy = ref(false);
const chatStorageFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
const appAgentSettingsStatus = ref<DesktopAppAgentSettingsStatus | null>(null);
const appAgentActions = ref<DesktopAppAgentActionMetadata[]>([]);
const appAgentBusy = ref(false);
const appAgentResult = ref<DesktopAppAgentRunResult | null>(null);
const appAgentFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
const diagnostics = ref<DiagnosticsSnapshot | null>(null);
const mcpInstallState = ref<DesktopMcpInstallState | null>(null);
const selectedMcpTargetIds = ref<DesktopMcpInstallTargetId[]>([]);
const mcpInstallBusy = ref(false);
const mcpInstallFeedback = ref<string | null>(null);
const setupLoadError = ref<string | null>(null);
const mcpWizardStep = ref<DesktopMcpWizardStep>("choose");
const firstRunStage = ref<FirstRunWizardStage>("welcome");
const {
  activeEntry,
  collapsedProjects,
  currentParentRoom,
  cycleSidebar: toggleSidebarMode,
  focusRooms,
  getAuthRoomIdentifier,
  openRoomSnapshot,
  pinnedCollapsed,
  pinnedRoom,
  projectEntries,
  reconcileActiveEntry,
  rememberRootRoomSnapshot,
  repoName,
  resolveSelectedRoomIdentifier,
  roomsCollapsed,
  selectSidebarEntry,
  selectedAccess,
  selectedFocusRooms,
  selectedNeedsAccess,
  selectedRoomIdentifier,
  selectedRoomInfo,
  sidebarMode,
  toggleProject,
  togglePinnedCollapsed,
  toggleRoomsCollapsed,
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
let unsubscribeOpenSettings: (() => void) | null = null;
let unsubscribeOpenUpdates: (() => void) | null = null;
let unsubscribeUpdateStatus: (() => void) | null = null;
let unsubscribeNotificationActivation: (() => void) | null = null;
let unsubscribeRepoStatusChanged: (() => void) | null = null;
let accountRoomsRefreshInterval: number | null = null;
let sidebarMetadataRefreshInFlight = false;
let repoStatusRefreshInFlight = false;
let repoStatusWatchRootPath: string | null = null;
let repoStatusWatchRequestId = 0;

const { actionToasts, dismissActionToast, pushActionToast } = useDesktopActionToasts();
const sidebarFocusRoomConclusionTarget = ref<RoomEntry | null>(null);
const sidebarFocusRoomConclusionParent = ref<RoomEntry | null>(null);
const sidebarFocusRoomConclusionReturnFocusId = ref<string | null>(null);
const sidebarFocusRoomConclusionError = ref<string | null>(null);
const sidebarFocusRoomConclusionPendingToast = ref<{
  message: string;
  state: "error" | "success";
} | null>(null);
const sidebarSelectionActive = ref(false);
const sidebarSelectedEntryIds = ref<string[]>([]);
const sidebarBatchActionBusy = ref<SidebarRoomBatchActionId | null>(null);
const sidebarBatchDialogAction = ref<"conclude" | "hide" | null>(null);
const sidebarBatchDialogTargets = ref<RoomEntry[]>([]);
const sidebarBatchDialogError = ref<string | null>(null);
const sidebarBatchPendingToast = ref<{
  message: string;
  state: "error" | "success";
} | null>(null);

const isSettingsSurface = computed(() => activeEntry.value.type === "system");
const showSidebarResizeHandle = computed(() => !isSettingsSurface.value && sidebarMode.value === "expanded");
const desktopShellStyle = computed(() => ({
  "--sidebar-width": `${sidebarWidth.value}px`,
  "--sidebar-min-width": `${sidebarMinWidth}px`,
  "--sidebar-max-width": `${sidebarMaxWidth}px`,
}));

async function cycleSidebar(): Promise<void> {
  const hidingSidebar = sidebarMode.value !== "hidden";
  if (hidingSidebar && sidebarBatchActionBusy.value) return;
  if (hidingSidebar && sidebarSelectionActive.value) cancelSidebarRoomSelection();
  toggleSidebarMode();
  if (!hidingSidebar) return;

  await nextTick();
  document.querySelector<HTMLElement>(
    '[data-testid="room-sidebar-reveal-button"], [data-testid="auth-sidebar-reveal-button"], [data-testid="sidebar-reveal-button"]',
  )?.focus({ preventScroll: true });
}

const selectedRoomWithProjectContext = computed(() => {
  const room = selectedRoomInfo.value;
  const parentRoom = rootRoomSnapshot.value?.room || null;
  const isListedChild = Boolean(
    rootRoomSnapshot.value?.focusRooms.some((focusRoom) =>
      normalizeRoomIdentifier(focusRoom.identifier) === normalizeRoomIdentifier(room.identifier)
    )
  );
  return roomWithInheritedProjectContext(room, parentRoom, isListedChild);
});

const selectedGitRoomMatchesActiveRepo = computed(() => {
  const gitRoom = selectedRoomWithProjectContext.value.gitRoom;
  if (!gitRoom || !repoStatus.value?.isGitRepo) return false;
  const activeRoomIdentifier = normalizeRoomIdentifier(repoStatus.value.roomIdentifier);
  if (
    activeRoomIdentifier &&
    activeRoomIdentifier === normalizeRoomIdentifier(selectedRoomWithProjectContext.value.identifier)
  ) return true;
  const rootGitRoom = rootRoomSnapshot.value?.room?.gitRoom || null;
  if (rootGitRoom) return gitRoomsShareRepo(rootGitRoom, gitRoom);
  return normalizeRoomIdentifier(selectedRoomWithProjectContext.value.identifier)
    === normalizeRoomIdentifier(rootRoomSnapshot.value?.roomIdentifier);
});

const selectedRoomProjectRootPath = computed(() => activeProjectRootPath());
const selectedRoomIsProject = computed(() => {
  if (selectedRoomWithProjectContext.value.gitRoom || selectedRoomProjectRootPath.value) return true;
  const context = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
  const identifier = normalizeRoomIdentifier(
    context?.roomIdentifier
      ?? selectedRootRoomIdentifier.value
      ?? rootRoomSnapshot.value?.roomIdentifier,
  );
  if (!identifier) return false;
  return recentRootRooms.value.some((room) =>
    room.kind === "project" && normalizeRoomIdentifier(room.identifier) === identifier
  );
});

function gitRoomsShareRepo(
  left: NonNullable<DesktopRoomSnapshot["room"]>["gitRoom"],
  right: NonNullable<DesktopRoomSnapshot["room"]>["gitRoom"],
): boolean {
  if (!left || !right) return false;
  const leftRepo = left.repository.id || `${left.host}:${left.repository.fullName}`.toLowerCase();
  const rightRepo = right.repository.id || `${right.host}:${right.repository.fullName}`.toLowerCase();
  return left.provider === right.provider && left.host === right.host && leftRepo === rightRepo;
}
const sidebarProjectEntries = computed(() =>
  applySidebarRoomOrder(projectEntries.value.map((project) => ({
    ...project,
    parent: withRoomUnreadState(project.parent),
    branchRooms: project.branchRooms.map(withRoomUnreadState),
    focusRooms: project.focusRooms.map(withRoomUnreadState),
  })), sidebarRoomOrder.value)
);
const sidebarSelectedEntries = computed(() => {
  const selectedIds = new Set(sidebarSelectedEntryIds.value);
  return flattenSidebarRoomEntries(sidebarProjectEntries.value)
    .filter((entry, index, entries) =>
      selectedIds.has(entry.id)
      && entries.findIndex((candidate) => candidate.id === entry.id) === index
    );
});
watch(sidebarProjectEntries, (projects) => {
  if (!sidebarSelectionActive.value || !sidebarSelectedEntryIds.value.length) return;
  const availableIds = new Set(flattenSidebarRoomEntries(projects).map((entry) => entry.id));
  const nextSelection = sidebarSelectedEntryIds.value.filter((entryId) => availableIds.has(entryId));
  if (nextSelection.length !== sidebarSelectedEntryIds.value.length) {
    sidebarSelectedEntryIds.value = nextSelection;
  }
});
const selectedRoomRenderKey = computed(() =>
  selectedRoomIdentifier.value
  || selectedSnapshot.value?.room?.identifier
  || selectedSnapshot.value?.roomIdentifier
  || selectedRoomInfo.value.identifier
  || activeEntry.value.id
);
const selectedRoomStorage = computed<DesktopRoomStorageState>(() =>
  selectedSnapshot.value?.storage || {
    roomIdentifier: selectedRoomInfo.value.identifier || null,
    defaultMode: chatStorageSettings.value?.defaultMode || chatStorageSettings.value?.mode || "cloud",
    overrideMode: "inherit",
    effectiveMode: chatStorageSettings.value?.mode || "cloud",
    isLocalRoom: false,
    localRoom: null,
    databasePath: chatStorageSettings.value?.databasePath || "",
    localFilesPath: chatStorageSettings.value?.localFilesPath || "",
  }
);

const requestedSettingsPane = ref<SettingsPaneId | null>(null);

const settingsPaneForActiveEntry = computed<SettingsPaneId>(() => {
  if (requestedSettingsPane.value) return requestedSettingsPane.value;
  if (activeEntry.value.type !== "system") return "storage:chat";
  if (activeEntry.value.id === "system:setup") return "system:setup";
  if (activeEntry.value.id === "system:app-agent") return "system:app-agent";
  if (activeEntry.value.id === "system:repos") return "system:runtime";
  if (activeEntry.value.id === "system:workers") return "system:agents";
  if (activeEntry.value.id === "system:diagnostics") return "system:diagnostics";
  return "storage:chat";
});

function openSettingsSurface(): void {
  requestedSettingsPane.value = null;
  activeEntry.value = settingsEntry;
}

function openUpdatesSurface(): void {
  requestedSettingsPane.value = "system:updates";
  activeEntry.value = settingsEntry;
}

function readStoredSidebarWidth(): number {
  const parsed = Number(readStoredString(sidebarWidthStorageKey));
  return clampSidebarWidth(Number.isFinite(parsed) ? parsed : sidebarDefaultWidth);
}

function clampSidebarWidth(value: number): number {
  return Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, Math.round(value)));
}

function startSidebarResize(event: PointerEvent): void {
  if (!showSidebarResizeHandle.value) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;
  isSidebarResizing.value = true;
  document.documentElement.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function handlePointerMove(moveEvent: PointerEvent): void {
    sidebarWidth.value = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
  }

  function handlePointerUp(): void {
    isSidebarResizing.value = false;
    rememberStoredString(sidebarWidthStorageKey, String(sidebarWidth.value));
    document.documentElement.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
}

function handleSidebarResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 32 : 12;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setSidebarWidth(sidebarWidth.value - step);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setSidebarWidth(sidebarWidth.value + step);
  } else if (event.key === "Home") {
    event.preventDefault();
    setSidebarWidth(sidebarMinWidth);
  } else if (event.key === "End") {
    event.preventDefault();
    setSidebarWidth(sidebarMaxWidth);
  }
}

function setSidebarWidth(value: number): void {
  sidebarWidth.value = clampSidebarWidth(value);
  rememberStoredString(sidebarWidthStorageKey, String(sidebarWidth.value));
}

async function refreshSidebarRoomMetadata(): Promise<void> {
  if (showFirstRunGate.value || !authStatus.value?.authenticated || sidebarMetadataRefreshInFlight) return;
  sidebarMetadataRefreshInFlight = true;
  try {
    await refreshAccountRooms().catch(() => undefined);
    await refreshSidebarLatestMessages();
  } finally {
    sidebarMetadataRefreshInFlight = false;
  }
}

async function refreshActiveRepoStatus(): Promise<void> {
  if (showFirstRunGate.value || !authStatus.value?.authenticated || repoStatusRefreshInFlight) return;
  const rootPath = activeProjectRootPath();
  if (!rootPath) return;
  repoStatusRefreshInFlight = true;
  const generation = sessionGeneration.value;
  try {
    const nextRepoStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
    if (generation === sessionGeneration.value && authStatus.value?.authenticated && nextRepoStatus) {
      repoStatus.value = nextRepoStatus;
    }
  } finally {
    repoStatusRefreshInFlight = false;
  }
}

function activeProjectRootPath(): string | null {
  // Derive the project context from the sidebar group that actually contains the
  // active room, NOT the last-opened global root snapshot (which can be a stale,
  // unrelated non-repo room). This is what keeps a focus room attached to its
  // real repo project. Fall back to the global root only when the active entry is
  // in no repo-backed group.
  const context = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
  // Presence-based, not nullish: if the active room IS in a group, that group is
  // authoritative even when it's a non-repo group (null identifier/gitRoom) — a
  // grouped non-repo room must not inherit a stale repo snapshot. Fall back to the
  // global root only when the active entry is in no group at all.
  return resolveActiveProjectRootPath({
    activeRootIdentifier: context
      ? context.roomIdentifier
      : selectedRootRoomIdentifier.value ?? rootRoomSnapshot.value?.roomIdentifier,
    activeRootGitRoom: context
      ? context.gitRoom
      : rootRoomSnapshot.value?.room?.gitRoom ?? null,
    projectBindings: projectBindings.value,
  });
}

async function refreshProjectBindings(): Promise<void> {
  if (!desktopIpc.repos?.listProjectBindings) return;
  const generation = sessionGeneration.value;
  const nextBindings = await desktopIpc.repos.listProjectBindings().catch(() => projectBindings.value);
  if (generation !== sessionGeneration.value) return;
  projectBindings.value = nextBindings;
}

async function initializeProjectBindings(): Promise<void> {
  const generation = sessionGeneration.value;
  if (!desktopIpc.repos?.migrateProjectBindings) {
    await refreshProjectBindings();
    return;
  }
  const candidates = [
    ...Object.entries(legacyRepositoryRootBindings).map(([roomIdentifier, rootPath]) => ({
      legacyKey: roomIdentifier,
      context: { roomIdentifier },
      rootPath,
    })),
    ...recentRootRooms.value.flatMap((room) => room.rootPath ? [{
      context: { roomIdentifier: room.identifier },
      rootPath: room.rootPath,
    }] : []),
  ];
  try {
    const migration = await desktopIpc.repos.migrateProjectBindings(candidates);
    if (generation !== sessionGeneration.value) return;
    projectBindings.value = migration.bindings;
    const retryBindings = Object.fromEntries(
      migration.retryLegacyKeys.flatMap((key) => {
        const rootPath = legacyRepositoryRootBindings[key];
        return rootPath ? [[key, rootPath]] : [];
      }),
    );
    if (Object.keys(retryBindings).length) {
      window.localStorage.setItem(
        legacyRepositoryRootBindingsStorageKey,
        JSON.stringify(retryBindings),
      );
    } else {
      window.localStorage.removeItem(legacyRepositoryRootBindingsStorageKey);
    }
  } catch {
    if (generation !== sessionGeneration.value) return;
    await refreshProjectBindings();
  }
}

async function restartRepoStatusWatch(rootPath: string | null): Promise<void> {
  if (!desktopIpc.repos?.startStatusWatch) return;
  const nextRootPath = rootPath?.trim() || null;
  if (repoStatusWatchRootPath === nextRootPath) return;
  const requestId = ++repoStatusWatchRequestId;
  repoStatusWatchRootPath = nextRootPath;
  await desktopIpc.repos.stopStatusWatch?.().catch(() => undefined);
  if (requestId !== repoStatusWatchRequestId || repoStatusWatchRootPath !== nextRootPath) return;
  if (!nextRootPath) return;
  const nextStatus = await desktopIpc.repos.startStatusWatch(nextRootPath).catch(() => null);
  if (requestId === repoStatusWatchRequestId && nextStatus && activeProjectRootPath() === nextRootPath) {
    repoStatus.value = nextStatus;
  }
}

function handleRepoStatusChanged(nextStatus: RepoStatus): void {
  const rootPath = activeProjectRootPath();
  if (rootPath && nextStatus.rootPath !== rootPath) return;
  repoStatus.value = nextStatus;
}

function refreshForegroundData(): void {
  if (!authStatus.value?.authenticated || authSessionLocked.value) return;
  // The main-process Git watcher retains invalidations while hidden and drains
  // them on BrowserWindow focus/show. Avoid racing it with a second full status
  // reconstruction from the renderer.
  void refreshProjectBindings();
  void refreshSidebarRoomMetadata();
  // Poll-only metadata catch-up: the periodic tick early-returns while hidden,
  // so refresh once on foreground return. Metadata-only, NOT the full snapshot —
  // SSE kept running while hidden, so event-fed sections are already current.
  void refreshSelectedRoomLiveMetadata().catch(() => undefined);
  void refreshRentalRequestCount();
}

function openRentMarketplace(): void {
  rentMarketplaceRole.value = "renter";
  activeEntry.value = rentMarketplaceEntry;
}

function openRentalRequestInbox(): void {
  rentMarketplaceRole.value = "provider";
  activeEntry.value = rentMarketplaceEntry;
}

async function refreshRentalRequestCount(): Promise<void> {
  if (!authStatus.value?.authenticated || authSessionLocked.value) {
    rentalRequestCount.value = 0;
    return;
  }
  if (!desktopIpc.rental?.getProviderDashboard) return;
  const generation = sessionGeneration.value;
  try {
    const dashboard = await loadRentalProviderDashboard();
    if (generation !== sessionGeneration.value || !authStatus.value?.authenticated) return;
    rentalRequestCount.value = Array.isArray(dashboard.pendingRequests) ? dashboard.pendingRequests.length : 0;
  } catch {
    rentalRequestCount.value = 0;
  }
}

useRentalProviderEvents(() => {
  void refreshRentalRequestCount();
});

async function openWorkspaceGitRoom(rootPathOverride?: string): Promise<boolean> {
  const rootPath = rootPathOverride || repoStatus.value?.rootPath || activeProjectRootPath();
  if (!rootPath) return false;
  loading.value = true;
  try {
    const selection = await desktopIpc.repos.openRoom(rootPath);
    if (selection.error || !selection.snapshot) {
      return false;
    }
    if (selection.repoStatus) {
      repoStatus.value = selection.repoStatus;
    }
    openRoomSnapshot(selection.snapshot, {
      aliasIdentifiers: [selection.roomIdentifier],
      rootPath: selection.repoPath || rootPath,
      kind: "project",
      meta: selection.repoStatus?.branch || null,
    });
    return true;
  } catch (error) {
    console.warn("Could not open the matching Git Room.", error);
    return false;
  } finally {
    loading.value = false;
  }
}

function handleVisibilityChange(): void {
  syncAppIdleAttribute();
  if (document.visibilityState !== "visible") return;
  refreshForegroundData();
}

function handleWindowFocus(): void {
  syncAppIdleAttribute();
  refreshForegroundData();
}

function handleWindowBlur(): void {
  syncAppIdleAttribute();
}

// Pause the launcher orb's decorative ink animations while the window is hidden
// or blurred (see domain/app-idle + styles/app-agent.css). Toggling one
// attribute on the document root keeps the choreography in one place and lets
// CSS scope the paused state to the launcher ink animations.
function syncAppIdleAttribute(): void {
  document.documentElement.toggleAttribute(
    APP_IDLE_ATTRIBUTE,
    isAppIdle({ hidden: document.hidden, focused: document.hasFocus() }),
  );
}

async function refreshSidebarLatestMessages(): Promise<void> {
  const generation = sessionGeneration.value;
  const roomIdentifiers = sidebarRoomIdentifiers();
  if (!roomIdentifiers.length) {
    sidebarLatestMessages.value = {};
    return;
  }

  // The `/account/rooms` payload (already refreshed before this call) carries
  // `latestMessageId` / `latestMessageAt` for every cloud room and focus room,
  // so we derive sidebar latest-message state from it instead of fanning out one
  // `/rooms/:id/messages` request per sidebar room. Local-storage entries are
  // delegated to the fallback lookup: they appear in the payload with null
  // latest fields because their latest message lives in the local DB (that
  // fallback is a local read, not HTTP). Rooms absent from the payload fall
  // back the same way.
  const { latestMessages, uncoveredRoomIdentifiers } = deriveSidebarLatestMessages({
    accountRooms: accountRooms.value,
    sidebarRoomIdentifiers: roomIdentifiers,
  });
  const nextLatestMessages: Record<string, DesktopRoomLatestMessage> = { ...latestMessages };

  if (uncoveredRoomIdentifiers.length && desktopIpc.room.getLatestMessages) {
    const fallbackMessages = await desktopIpc.room
      .getLatestMessages(uncoveredRoomIdentifiers)
      .catch(() => []);
    for (const latestMessage of fallbackMessages) {
      const key = roomReadKey(latestMessage.roomIdentifier);
      if (!key) continue;
      nextLatestMessages[key] = latestMessage;
    }
  }

  if (generation !== sessionGeneration.value || !authStatus.value?.authenticated) return;
  sidebarLatestMessages.value = nextLatestMessages;
  seedReadMarkersForKnownRooms();
  markActiveRoomRead();
}

function sidebarRoomIdentifiers(): string[] {
  const identifiers = new Set<string>();
  for (const project of projectEntries.value) {
    for (const entry of [project.parent, ...projectChildRooms(project)]) {
      const identifier = entry.roomIdentifier?.trim();
      if (identifier) identifiers.add(identifier);
    }
  }
  return [...identifiers];
}

function withRoomUnreadState(entry: RoomEntry): RoomEntry {
  const latestMessageId = latestMessageIdForEntry(entry);
  return {
    ...entry,
    latestMessageId,
    latestMessageAt: latestMessageAtForEntry(entry),
    hasUnread: hasUnreadRoomActivity({
      activeRoomIdentifier: selectedRoomIdentifier.value,
      latestMessageId,
      readMarkers: readRoomMessageIds.value,
      roomIdentifier: entry.roomIdentifier,
    }),
  };
}

function latestMessageIdForEntry(entry: RoomEntry): string | null {
  if (selectedSnapshotMatchesEntry(entry)) {
    return selectedSnapshot.value?.messages.at(-1)?.id || entry.latestMessageId;
  }
  return latestMessageForEntry(entry)?.latestMessageId || entry.latestMessageId;
}

function latestMessageAtForEntry(entry: RoomEntry): string | null {
  if (selectedSnapshotMatchesEntry(entry)) {
    return selectedSnapshot.value?.messages.at(-1)?.timestamp || entry.latestMessageAt;
  }
  return latestMessageForEntry(entry)?.latestMessageAt || entry.latestMessageAt;
}

function latestMessageForEntry(entry: RoomEntry): DesktopRoomLatestMessage | null {
  const key = roomReadKey(entry.roomIdentifier);
  return key ? sidebarLatestMessages.value[key] || null : null;
}

function selectedSnapshotMatchesEntry(entry: RoomEntry): boolean {
  const entryIdentifier = normalizeRoomIdentifier(entry.roomIdentifier);
  const snapshotIdentifier = normalizeRoomIdentifier(
    selectedSnapshot.value?.room?.identifier || selectedSnapshot.value?.roomIdentifier
  );
  return Boolean(entryIdentifier && snapshotIdentifier && entryIdentifier === snapshotIdentifier);
}

function handleSidebarEntrySelected(entry: SidebarEntry): void {
  if (sidebarSelectionActive.value) cancelSidebarRoomSelection();
  if (entry.type === "room") {
    markRoomEntryRead(entry);
  }
  selectSidebarEntry(entry);
}

function startSidebarRoomSelection(entry?: RoomEntry): void {
  sidebarSelectionActive.value = true;
  sidebarBatchDialogError.value = null;
  if (!entry || !isSidebarRoomSelectable(entry)) return;
  if (!sidebarSelectedEntryIds.value.includes(entry.id)) {
    sidebarSelectedEntryIds.value = [...sidebarSelectedEntryIds.value, entry.id];
  }
}

function cancelSidebarRoomSelection(): void {
  if (sidebarBatchActionBusy.value) return;
  sidebarSelectionActive.value = false;
  sidebarSelectedEntryIds.value = [];
  closeSidebarBatchDialog();
}

function toggleSidebarRoomSelection(entryId: string): void {
  const selected = new Set(sidebarSelectedEntryIds.value);
  if (selected.has(entryId)) selected.delete(entryId);
  else selected.add(entryId);
  sidebarSelectedEntryIds.value = [...selected];
}

function setSidebarRoomSelection(entryIds: string[], selected: boolean): void {
  const next = new Set(sidebarSelectedEntryIds.value);
  for (const entryId of entryIds) {
    if (selected) next.add(entryId);
    else next.delete(entryId);
  }
  sidebarSelectedEntryIds.value = [...next];
}

function openFocusRoomFromRoomsTab(roomIdentifier: string): void {
  const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedIdentifier) return;
  const existingFocusRoom = projectEntries.value
    .flatMap(projectChildRooms)
    .find((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === normalizedIdentifier);
  if (existingFocusRoom) {
    handleSidebarEntrySelected(existingFocusRoom);
    return;
  }

  const fallbackEntry: RoomEntry = {
    id: `room:focus:${normalizedIdentifier}`,
    type: "room",
    kind: "focus",
    roomIdentifier,
    title: roomIdentifier,
    meta: "Focus room",
    sectionLabel: "Focus room",
    headline: "Focused work",
    description: "Open this focus room.",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
  handleSidebarEntrySelected(fallbackEntry);
}

async function handleRoomDetailsFocusRoomConcluded(event: FocusRoomConcludedEvent): Promise<void> {
  const focusRoomIdentifier = normalizeRoomIdentifier(event.focusRoomIdentifier);
  const parentRoomIdentifier = normalizeRoomIdentifier(event.parentRoomIdentifier);
  const targetWasActive = activeEntry.value.type === "room"
    && normalizeRoomIdentifier(activeEntry.value.roomIdentifier) === focusRoomIdentifier;
  const parentBeforeRefresh = findSidebarRoomEntryByIdentifier(
    projectEntries.value,
    parentRoomIdentifier,
  );

  let refreshError: unknown = null;
  try {
    await refresh();
  } catch (error) {
    refreshError = error;
  }

  if (targetWasActive) {
    const parentAfterRefresh = findSidebarRoomEntryByIdentifier(
      projectEntries.value,
      parentRoomIdentifier,
    ) || parentBeforeRefresh;
    if (parentAfterRefresh) handleSidebarEntrySelected(parentAfterRefresh);
  }

  if (refreshError) {
    pushActionToast(
      `${event.displayName} concluded, but the room list could not be refreshed.`,
      "error",
    );
    return;
  }
  pushActionToast(`${event.displayName} concluded.`, "success");
}

function seedReadMarkersForKnownRooms(): void {
  let nextMarkers = readRoomMessageIds.value;
  let changed = false;
  for (const project of projectEntries.value) {
    for (const entry of [project.parent, ...projectChildRooms(project)]) {
      const result = seedRoomReadMarker(nextMarkers, entry.roomIdentifier, latestMessageIdForEntry(entry));
      nextMarkers = result.readMarkers;
      changed = changed || result.changed;
    }
  }
  if (changed) {
    readRoomMessageIds.value = nextMarkers;
    rememberRoomMessageIds();
  }
}

function projectChildRooms(project: ProjectGroup): RoomEntry[] {
  return orderedSidebarChildRooms(project);
}

function markActiveRoomRead(): void {
  if (activeEntry.value.type !== "room") return;
  markRoomEntryRead(activeEntry.value);
}

function markRoomEntryRead(entry: RoomEntry): void {
  const result = markRoomRead(readRoomMessageIds.value, entry.roomIdentifier, latestMessageIdForEntry(entry));
  if (!result.changed) return;
  readRoomMessageIds.value = result.readMarkers;
  rememberRoomMessageIds();
}

function setAllProjectsCollapsed(collapsed: boolean): void {
  collapsedProjects.value = Object.fromEntries(
    projectEntries.value.map((project) => [project.id, collapsed]),
  );
}

function handleSidebarParentRoomReorder(input: SidebarParentRoomReorder): void {
  const next = reorderSidebarParentRooms(sidebarProjectEntries.value, input);
  if (!next) return;
  sidebarRoomOrder.value = next;
  rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, next);
}

function handleSidebarChildRoomReorder(input: SidebarChildRoomReorder): void {
  const next = reorderSidebarChildRooms(sidebarProjectEntries.value, input);
  if (!next) return;
  sidebarRoomOrder.value = next;
  rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, next);
}

function rememberRoomMessageIds(): void {
  try {
    window.localStorage.setItem(readRoomMessagesStorageKey, JSON.stringify(readRoomMessageIds.value));
  } catch {
    // Local persistence should never block message navigation.
  }
}

const {
  clearLiveMetadataRefreshInterval,
  clearLiveMetadataRefreshTimer,
  clearSelectedRoomAgentWork,
  invalidateSelectedRoomAgentWork,
  refreshSelectedRoomLiveMetadata,
  roomAgentWork,
  roomAgentWorkStatus,
  roomAgentWorkTruncated,
  scheduleLiveMetadataRefresh,
  syncSelectedRoomStream: syncDesktopRoomStream,
} = useDesktopRoomLiveSync({
  accountId: computed(() => authStatus.value?.account?.id || null),
  rootRoomSnapshot,
  selectedRoomIdentifier,
  selectedSnapshot,
  sessionGeneration,
  workers,
});

const {
  clearSelectedSnapshotCache,
  handleMessageSent,
  handleRefreshRoom,
  handleRoomRenamed,
  handleRoomStreamEvent,
  invalidateSession,
  refresh,
  refreshAccountRooms,
  refreshSelectedSnapshot,
  repoStatusValue,
  selectedSnapshotLoading,
  syncSelectedRoomStream,
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
  recentRootRooms,
  repoStatus,
  resolveSelectedRoomIdentifier,
  rootRoomSnapshot,
  scheduleLiveMetadataRefresh,
  sessionGeneration,
  selectedMcpTargetIds,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  syncRoomStream: syncDesktopRoomStream,
  workers,
});

function handleDesktopRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  if (event.type === "resource_invalidation") {
    invalidateSelectedRoomAgentWork(event.roomIdentifier);
    return;
  }
  handleRoomStreamEvent(event);
}

const authSnapshotPending = computed(() =>
  isAuthSnapshotPending({
    rootLoading: loading.value,
    selectedLoading: selectedSnapshotLoading.value,
    hasSnapshot: Boolean(selectedSnapshot.value),
  }),
);

const {
  authBusy,
  authFeedback,
  authSessionLocked,
  cancelAuthFlow,
  clearAuthPollTimer,
  openVerification,
  pollAuthFlow,
  scheduleAuthPoll,
  signOut,
  startAuthFlow,
} = useDesktopAuthFlow({
  authStatus,
  getRoomIdentifier: () => getAuthRoomIdentifier(),
  isFirstRunGate: () => Boolean(mcpInstallState.value && !mcpInstallState.value.completed),
  onFirstRunAuthorized: async () => {
    firstRunStage.value = "room";
  },
  onAuthorized: () => refresh(),
  onSigningOut: clearDesktopSessionState,
  onSignedOut: async () => undefined,
});

const showSignedOutGate = computed(() => (
  authSessionLocked.value || !authStatus.value?.authenticated
));

function startSignedOutAuthFlow(): Promise<void> {
  return startAuthFlow(null);
}

function clearDesktopSessionState(): void {
  invalidateSession();
  clearLiveMetadataRefreshTimer();
  clearLiveMetadataRefreshInterval();
  clearSelectedRoomAgentWork();
  rootRoomSnapshot.value = null;
  selectedSnapshot.value = null;
  workers.value = [];
  accountRooms.value = [];
  settingsAccountRooms.value = [];
  sidebarLatestMessages.value = {};
  rentalRequestCount.value = 0;
  repoStatus.value = null;
  authDialogOpen.value = false;
  void syncSelectedRoomStream(null).catch(() => undefined);
  void restartRepoStatusWatch(null);
}

async function openAccountAuthFlow(): Promise<void> {
  authDialogOpen.value = true;
  if (authStatus.value?.pendingDeviceAuth) {
    scheduleAuthPoll();
    return;
  }
  await startAuthFlow();
}

const {
  backFromSubstep,
  canSubmitJoin,
  canSubmitStandalone,
  chooseJoinIntent,
  chooseProjectIntent,
  chooseStandaloneIntent,
  closeNewRoomModal,
  confirmProjectRoomFromModal,
  copyInviteCode,
  createStandaloneRoom,
  dismissSuccess,
  joinRoomCodeFromModal,
  newRoomActiveAction,
  newRoomBusy,
  newRoomFeedback,
  newRoomFeedbackState,
  newRoomJoinCode,
  newRoomJoinError,
  newRoomModalOpen,
  newRoomName,
  newRoomProjectSelection,
  newRoomStatusMessage,
  newRoomStep,
  newRoomStorage,
  newRoomSuccess,
  openProjectRoomFromModal,
  openSuccessRoom,
  retryLastAction,
  selectNewRoomEntry,
} = useDesktopNewRoomModal({
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  setRepoStatus: (status) => {
    if (status) repoStatus.value = status;
  },
  getDefaultStorageMode: () =>
    chatStorageSettings.value?.defaultMode === "local" || chatStorageSettings.value?.mode === "local"
      ? "local"
      : "cloud",
});
const {
  batchConcludeSidebarFocusRooms,
  batchHideSidebarRooms,
  batchSetSidebarRoomsPinned,
  archiveSidebarFocusRoom,
  archiveSidebarRoom,
  concludeSidebarFocusRoom,
  deleteAccountRoom,
  leaveAccountRoom,
  openAccountRoomFromSettings,
  refreshSettings,
  renameSidebarRoom,
  restoreAccountRoom,
  settingsFeedback,
  settingsRoomActionBusyKey,
  toggleAccountRoomPin,
  togglePinSidebarRoom,
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
  onRoomArchived: async (roomIdentifier, displayName) => {
    await leaveArchivedRoomIfActive(roomIdentifier, displayName);
  },
  onRoomRenamed: (room) => {
    if (normalizeRoomIdentifier(room.identifier) === normalizeRoomIdentifier(selectedRoomIdentifier.value)) {
      handleRoomRenamed(room);
    }
  },
  notify: (message, state) => pushActionToast(message, state),
});

async function handleSidebarBatchAction(action: SidebarRoomBatchActionId): Promise<void> {
  if (sidebarBatchActionBusy.value) return;
  if (action !== "mark-read" && !authStatus.value?.authenticated) {
    pushActionToast("Connect GitHub from the account menu to manage rooms.", "info");
    return;
  }
  const resolution = resolveSidebarRoomBatchAction({
    action,
    entries: sidebarSelectedEntries.value,
    primaryRoomId: currentParentRoom.value.id,
  });
  if (!resolution.targets.length) return;

  if (action === "mark-read") {
    resolution.targets.forEach(markRoomEntryRead);
    pushActionToast(
      `${resolution.targets.length} ${resolution.targets.length === 1 ? "room" : "rooms"} marked as read.`,
      "success",
    );
    return;
  }

  if (action === "pin") {
    sidebarBatchActionBusy.value = action;
    const result = await batchSetSidebarRoomsPinned(
      resolution.targets,
      resolution.pinned === true,
    );
    sidebarBatchActionBusy.value = null;
    if (result.refreshError) {
      const succeededIds = new Set(result.succeededEntryIds);
      sidebarSelectedEntryIds.value = sidebarSelectedEntryIds.value.filter(
        (entryId) => !succeededIds.has(entryId),
      );
      if (!sidebarSelectedEntryIds.value.length) sidebarSelectionActive.value = false;
    }
    reportSidebarBatchMutation(
      result,
      resolution.targets.length,
      resolution.pinned ? "pinned" : "unpinned",
    );
    return;
  }

  sidebarBatchDialogAction.value = action;
  sidebarBatchDialogTargets.value = resolution.targets;
  sidebarBatchDialogError.value = null;
}

function closeSidebarBatchDialog(): void {
  if (sidebarBatchActionBusy.value) return;
  sidebarBatchDialogAction.value = null;
  sidebarBatchDialogTargets.value = [];
  sidebarBatchDialogError.value = null;
  sidebarBatchPendingToast.value = null;
}

async function confirmSidebarBatchAction(): Promise<void> {
  const action = sidebarBatchDialogAction.value;
  const targets = [...sidebarBatchDialogTargets.value];
  if (!action || sidebarBatchActionBusy.value || !targets.length) return;

  const activeTarget = targets.find((entry) =>
    activeEntry.value.id === entry.id
    || (
      activeEntry.value.type === "room"
      && normalizeRoomIdentifier(activeEntry.value.roomIdentifier)
        === normalizeRoomIdentifier(entry.roomIdentifier)
    )
  ) || null;
  const parentBeforeRefresh = activeTarget?.parentRoomIdentifier
    ? findSidebarRoomEntryByIdentifier(projectEntries.value, activeTarget.parentRoomIdentifier)
    : null;

  sidebarBatchActionBusy.value = action;
  sidebarBatchDialogError.value = null;
  let result: SidebarRoomBatchMutationResult;
  try {
    result = action === "conclude"
      ? await batchConcludeSidebarFocusRooms(targets)
      : await batchHideSidebarRooms(targets);
  } catch (caught) {
    sidebarBatchActionBusy.value = null;
    sidebarBatchDialogError.value = caught instanceof Error
      ? caught.message
      : `The selected rooms could not be ${action === "conclude" ? "concluded" : "hidden"}.`;
    return;
  }
  sidebarBatchActionBusy.value = null;
  sidebarBatchDialogAction.value = null;
  sidebarBatchDialogTargets.value = [];

  const succeededIds = new Set(result.succeededEntryIds);
  if (activeTarget && succeededIds.has(activeTarget.id)) {
    if (activeTarget.kind === "focus") {
      const parent = activeTarget.parentRoomIdentifier
        ? findSidebarRoomEntryByIdentifier(projectEntries.value, activeTarget.parentRoomIdentifier)
          || parentBeforeRefresh
        : parentBeforeRefresh;
      if (parent) {
        markRoomEntryRead(parent);
        selectSidebarEntry(parent);
      }
    } else if (action === "hide" && activeTarget.roomIdentifier) {
      await leaveArchivedRoomIfActive(activeTarget.roomIdentifier, activeTarget.title);
    }
  }

  sidebarSelectedEntryIds.value = sidebarSelectedEntryIds.value.filter(
    (entryId) => !succeededIds.has(entryId),
  );
  if (!sidebarSelectedEntryIds.value.length) sidebarSelectionActive.value = false;
  reportSidebarBatchMutation(
    result,
    targets.length,
    action === "conclude" ? "concluded" : "hidden",
    true,
  );
}

function reportSidebarBatchMutation(
  result: SidebarRoomBatchMutationResult,
  targetCount: number,
  completedVerb: string,
  deferUntilDialogLeaves = false,
): void {
  const completed = result.succeededEntryIds.length;
  const partiallyCompleted = result.partiallySucceededEntryIds.length;
  const roomNoun = targetCount === 1 ? "room" : "rooms";
  if (!result.failures.length && !result.refreshError) {
    deliverSidebarBatchToast(
      `${completed} ${completed === 1 ? "room" : "rooms"} ${completedVerb}.`,
      "success",
      deferUntilDialogLeaves,
    );
    return;
  }

  const parts = [`${completed} of ${targetCount} ${roomNoun} ${completedVerb}.`];
  if (partiallyCompleted) {
    parts.push(
      `${partiallyCompleted} ${partiallyCompleted === 1 ? "room was" : "rooms were"} partially updated.`,
    );
  }
  if (result.failures.length) {
    parts.push(`${result.failures.length} failed: ${result.failures[0]?.message || "Unknown error"}`);
  }
  if (result.refreshError) {
    parts.push(`The sidebar could not refresh: ${result.refreshError}`);
  }
  deliverSidebarBatchToast(parts.join(" "), "error", deferUntilDialogLeaves);
}

function deliverSidebarBatchToast(
  message: string,
  state: "error" | "success",
  deferUntilDialogLeaves: boolean,
): void {
  if (deferUntilDialogLeaves) {
    sidebarBatchPendingToast.value = { message, state };
    return;
  }
  pushActionToast(message, state);
}

function handleSidebarBatchDialogAfterLeave(): void {
  const toast = sidebarBatchPendingToast.value;
  sidebarBatchPendingToast.value = null;
  if (toast) pushActionToast(toast.message, toast.state);
}

const sidebarFocusRoomConclusionBusy = computed(() => {
  const target = sidebarFocusRoomConclusionTarget.value;
  if (!target) return false;
  return settingsRoomActionBusyKey.value
    === `conclude-focus:${target.roomIdentifier || target.focusKey}`;
});

function openSidebarFocusRoomConclusion(entry: RoomEntry): void {
  if (!authStatus.value?.authenticated) {
    pushActionToast("Connect GitHub from the account menu to conclude this Focus Room.", "info");
    return;
  }
  if (
    entry.kind !== "focus"
    || entry.focusStatus === "concluded"
    || !entry.focusKey
    || !entry.parentRoomIdentifier
  ) return;

  sidebarFocusRoomConclusionTarget.value = entry;
  sidebarFocusRoomConclusionParent.value = findSidebarRoomEntryByIdentifier(
    projectEntries.value,
    entry.parentRoomIdentifier,
  );
  sidebarFocusRoomConclusionReturnFocusId.value = entry.id;
  sidebarFocusRoomConclusionError.value = null;
  sidebarFocusRoomConclusionPendingToast.value = null;
}

function openRoomDetailsFocusRoomConclusion(focusRoom: DesktopFocusRoomInfo): void {
  const focusRoomIdentifier = normalizeRoomIdentifier(focusRoom.identifier || focusRoom.roomId);
  const parentRoomIdentifier = normalizeRoomIdentifier(focusRoom.parentRoomId);
  const entry = projectEntries.value
    .flatMap((project) => project.focusRooms)
    .find((candidate) => {
      if (
        focusRoomIdentifier
        && normalizeRoomIdentifier(candidate.roomIdentifier) === focusRoomIdentifier
      ) return true;
      return Boolean(
        focusRoom.focusKey
        && candidate.focusKey === focusRoom.focusKey
        && normalizeRoomIdentifier(candidate.parentRoomIdentifier) === parentRoomIdentifier
      );
    });
  if (!entry) {
    pushActionToast("This focus room is no longer available to conclude.", "error");
    return;
  }
  openSidebarFocusRoomConclusion(entry);
}

function closeSidebarFocusRoomConclusion(): void {
  if (sidebarFocusRoomConclusionBusy.value) return;
  sidebarFocusRoomConclusionTarget.value = null;
  sidebarFocusRoomConclusionError.value = null;
  sidebarFocusRoomConclusionPendingToast.value = null;
}

async function submitSidebarFocusRoomConclusion(input: FocusRoomConclusionInput): Promise<void> {
  const target = sidebarFocusRoomConclusionTarget.value;
  if (!target || sidebarFocusRoomConclusionBusy.value) return;

  const parent = sidebarFocusRoomConclusionParent.value;
  const targetWasActive = activeEntry.value.id === target.id;
  sidebarFocusRoomConclusionError.value = null;
  const result = await concludeSidebarFocusRoom(target, input);
  if (!result.ok) {
    sidebarFocusRoomConclusionError.value = result.error;
    return;
  }

  sidebarFocusRoomConclusionReturnFocusId.value = parent?.id || null;
  const displayName = target.title || "Focus room";
  sidebarFocusRoomConclusionPendingToast.value = result.refreshError
    ? {
        message: `${displayName} concluded, but the room list could not be refreshed: ${result.refreshError}`,
        state: "error",
      }
    : { message: `${displayName} concluded.`, state: "success" };
  sidebarFocusRoomConclusionTarget.value = null;
  if (targetWasActive && parent) {
    handleSidebarEntrySelected(parent);
  }
}

function handleSidebarFocusRoomConclusionAfterLeave(): void {
  const toast = sidebarFocusRoomConclusionPendingToast.value;
  sidebarFocusRoomConclusionPendingToast.value = null;
  if (toast) pushActionToast(toast.message, toast.state);
}

const {
  clearMcpTargetSelection,
  completeMcpOnboarding,
  continueMcpOnboarding,
  continueToRoomConfirmation,
  createFirstRunInviteRoom,
  finishFirstRunOnboarding,
  firstRunInviteCode,
  firstRunRoomSelected,
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
  showFirstRunSplash,
  visibleMcpInstallState,
  startFirstRunSetup,
} = useDesktopSetupOnboarding({
  activeEntry,
  authFeedback,
  authStatus,
  firstRunStage,
  loading,
  mcpInstallBusy,
  mcpInstallFeedback,
  mcpInstallState,
  mcpWizardStep,
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  pinnedRoom,
  refresh: () => refresh(),
  repoStatus,
  selectedMcpTargetIds,
  setupLoadError,
});

async function startFirstRunRoomAuth(): Promise<void> {
  firstRunStage.value = "github";
  await startAuthFlow();
}

async function connectActiveRoomProject(): Promise<void> {
  const groupedContext = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
  const context = groupedContext || {
    roomIdentifier: selectedRoomWithProjectContext.value.identifier,
    gitRoom: selectedRoomWithProjectContext.value.gitRoom,
  };
  if (!desktopIpc.repos?.connectProject) {
    pushActionToast("Restart LetAgents Desktop to connect this project.", "error");
    return;
  }
  const result = await desktopIpc.repos.connectProject(context).catch((error) => ({
    canceled: false,
    binding: null,
    repoStatus: null,
    error: error instanceof Error ? error.message : "LetAgents could not connect that project.",
  }));
  if (result.canceled) return;
  if (result.error || !result.binding) {
    pushActionToast(result.error || "LetAgents could not connect that project.", "error", 6_000);
    return;
  }
  await refreshProjectBindings();
  if (result.repoStatus) repoStatus.value = result.repoStatus;
  pushActionToast("This room is now connected to its local project.", "success");
}

async function openWorktreeForAgent(rootPath: string): Promise<void> {
  await openManagedAgentWorktree({
    rootPath,
    openWorkspaceGitRoom,
    setReopenAddAgent: (value) => {
      openAddAgentAfterRepoPick.value = value;
    },
  });
}

function getChatStorageBridge(): typeof desktopIpc.chatStorage | null {
  const bridge = desktopIpc.chatStorage;
  if (!bridge) {
    chatStorageAvailable.value = false;
    chatStorageFeedback.value = {
      state: "error",
      message: "Restart LetAgents Desktop to enable chat storage controls.",
    };
    return null;
  }
  chatStorageAvailable.value = true;
  return bridge;
}

async function loadChatStorageSettings(): Promise<void> {
  const bridge = getChatStorageBridge();
  if (!bridge) return;
  try {
    chatStorageSettings.value = await bridge.getSettings();
  } catch (error) {
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Chat storage settings could not be loaded.",
    };
  }
}

async function loadAppAgentSettingsStatus(): Promise<void> {
  try {
    appAgentSettingsStatus.value = await desktopIpc.appAgent.getSettingsStatus();
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent settings could not be loaded.",
    };
  }
}

async function loadAppAgentActions(): Promise<void> {
  try {
    appAgentActions.value = await desktopIpc.appAgent.listActions();
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent actions could not be loaded.",
    };
  }
}

async function saveAppAgentSettings(input: DesktopAppAgentSaveSettingsInput): Promise<void> {
  appAgentBusy.value = true;
  appAgentFeedback.value = null;
  try {
    appAgentSettingsStatus.value = await desktopIpc.appAgent.saveSettings(input);
    appAgentFeedback.value = {
      state: "success",
      message: "App Agent settings saved.",
    };
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent settings could not be saved.",
    };
  } finally {
    appAgentBusy.value = false;
  }
}

async function refreshSettingsSurface(): Promise<void> {
  await Promise.all([
    refreshSettings(),
    loadAppAgentSettingsStatus(),
    loadAppAgentActions(),
    refreshDesktopUpdateStatus(),
  ]);
}

async function refreshDesktopUpdateStatus(): Promise<void> {
  if (!desktopIpc.updates?.getStatus) return;
  updateStatus.value = await desktopIpc.updates.getStatus();
}

async function checkDesktopUpdate(): Promise<void> {
  if (!desktopIpc.updates?.check) return;
  updateStatus.value = await desktopIpc.updates.check();
}

async function installDesktopUpdate(): Promise<void> {
  if (!desktopIpc.updates?.install) return;
  updateStatus.value = await desktopIpc.updates.install();
}

function openAppAgentSettings(): void {
  activeEntry.value = appAgentEntry;
}

async function runAppAgent(input: DesktopAppAgentRunInput): Promise<void> {
  appAgentBusy.value = true;
  appAgentResult.value = null;
  try {
    const runInput: DesktopAppAgentRunInput = {
      ...input,
      activeRoomDisplayName:
        input.activeRoomDisplayName || selectedRoomInfo.value.displayName || activeEntry.value.title,
      activeRoomIdentifier:
        input.activeRoomIdentifier || selectedRoomIdentifier.value || selectedRootRoomIdentifier.value,
      activeRoomPinned:
        input.activeRoomPinned === true || (activeEntry.value.type === "room" && activeEntry.value.pinned),
      activeRoomGitRoom:
        input.activeRoomGitRoom || selectedRoomInfo.value.gitRoom || null,
    };
    const result = await desktopIpc.appAgent.run(runInput);
    appAgentResult.value = result;
    if (result.settingsStatus) {
      appAgentSettingsStatus.value = result.settingsStatus;
    }
    const refreshTargets = appAgentRefreshTargets(result);
    if (refreshTargets.includes("rooms")) {
      await refreshAccountRooms();
    }
    const archivedActiveRoom =
      await leaveArchivedActiveRoomAfterAppAgent(result, runInput, {
        deferNavigation: Boolean(result.openRoomIdentifier),
      }) ||
      await leaveArchivedSelectedRoomFromSettingsList();
    if (result.openRoomIdentifier) {
      await openRoomFromAppAgent(result.openRoomIdentifier);
    }
    if (refreshTargets.includes("settings")) {
      await Promise.all([
        refreshSettingsSurface(),
        loadChatStorageSettings(),
      ]);
    }
    if (refreshTargets.includes("active_room") && !archivedActiveRoom) {
      await refreshSelectedSnapshot(rootRoomSnapshot.value);
    }
    if (refreshTargets.includes("foreground")) {
      refreshForegroundData();
    }
  } catch (error) {
    appAgentResult.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "The App Agent could not complete that request.",
    };
  } finally {
    appAgentBusy.value = false;
  }
}

async function leaveArchivedActiveRoomAfterAppAgent(
  result: DesktopAppAgentRunResult,
  input: DesktopAppAgentRunInput,
  options: { deferNavigation?: boolean } = {},
): Promise<boolean> {
  const archivedAliases = new Set(appAgentArchivedRoomIdentifiers(result));
  if (!archivedAliases.size) return false;
  forgetRecentRootRoomAliases(archivedAliases);

  const activeAliases = currentActiveRoomAliases(input);
  if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
    return false;
  }

  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  if (options.deferNavigation) {
    rootRoomSnapshot.value = null;
    clearSelectedSnapshotCache();
    selectedSnapshot.value = null;
    selectedRootRoomIdentifier.value = null;
    return true;
  }
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedRoomIfActive(
  roomIdentifier: string,
  displayName?: string | null,
): Promise<boolean> {
  const archivedAliases = roomAliasSet([roomIdentifier, displayName]);
  if (!archivedAliases.size) return false;
  forgetRecentRootRoomAliases(archivedAliases);
  const activeAliases = currentActiveRoomAliases();
  if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
    return false;
  }
  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedSelectedRoomFromSettingsList(): Promise<boolean> {
  if (activeEntry.value.type !== "room") return false;
  const activeAliases = currentActiveRoomAliases();
  const archivedRoom = settingsAccountRooms.value.find(
    (room) => room.archived && roomMatchesAliases(room, activeAliases),
  ) || null;
  if (!archivedRoom) return false;

  const archivedAliases = roomAliasSet([
    archivedRoom.roomIdentifier,
    archivedRoom.displayName,
    archivedRoom.name,
  ]);
  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedActiveRoom(archivedAliases: Set<string>): Promise<void> {
  const nextRoom = accountRooms.value.find(
    (room) => !room.archived && !roomMatchesAliases(room, archivedAliases),
  ) || null;
  if (nextRoom) {
    await openRoomFromAppAgent(nextRoom.roomIdentifier);
    return;
  }

  rootRoomSnapshot.value = null;
  clearSelectedSnapshotCache();
  selectedSnapshot.value = null;
  selectedRootRoomIdentifier.value = null;
  activeEntry.value = settingsEntry;
}

function currentActiveRoomAliases(input?: Partial<DesktopAppAgentRunInput>): Set<string> {
  return roomAliasSet([
    input?.activeRoomIdentifier,
    input?.activeRoomDisplayName,
    selectedRoomIdentifier.value,
    selectedRootRoomIdentifier.value,
    selectedRoomInfo.value.identifier,
    selectedRoomInfo.value.displayName,
    selectedRoomInfo.value.name,
    selectedRoomInfo.value.code,
    selectedSnapshot.value?.roomIdentifier,
    selectedSnapshot.value?.access.roomIdentifier,
    selectedSnapshot.value?.access.code,
    selectedSnapshot.value?.room?.identifier,
    selectedSnapshot.value?.room?.displayName,
    selectedSnapshot.value?.room?.name,
    selectedSnapshot.value?.room?.code,
    rootRoomSnapshot.value?.roomIdentifier,
    rootRoomSnapshot.value?.access.roomIdentifier,
    rootRoomSnapshot.value?.access.code,
    rootRoomSnapshot.value?.room?.identifier,
    rootRoomSnapshot.value?.room?.displayName,
    rootRoomSnapshot.value?.room?.name,
    rootRoomSnapshot.value?.room?.code,
    activeEntry.value.type === "room" ? activeEntry.value.roomIdentifier : null,
    activeEntry.value.title,
  ]);
}

function roomAliasSet(values: readonly (string | null | undefined)[]): Set<string> {
  return new Set(
    values
      .map(normalizeRoomIdentifier)
      .filter((value): value is string => Boolean(value)),
  );
}

function roomMatchesAliases(room: DesktopAccountRoomEntry, aliases: Set<string>): boolean {
  return [
    room.roomIdentifier,
    room.displayName,
    room.name,
  ].some((value) => aliases.has(normalizeRoomIdentifier(value) || ""));
}

function forgetRecentRootRoomAliases(aliases: Set<string>): void {
  if (!aliases.size) return;
  const nextRecentRooms = recentRootRooms.value.filter(
    (room) =>
      !aliases.has(normalizeRoomIdentifier(room.identifier) || "") &&
      !aliases.has(normalizeRoomIdentifier(room.displayName) || ""),
  );
  if (nextRecentRooms.length === recentRootRooms.value.length) return;
  recentRootRooms.value = nextRecentRooms;
  rememberRecentRootRooms(recentRootRoomsStorageKey, nextRecentRooms);
}

async function openRoomFromAppAgent(roomIdentifier: string): Promise<void> {
  const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedIdentifier) return;
  const knownRoom = [...accountRooms.value, ...settingsAccountRooms.value]
    .find((room) => normalizeRoomIdentifier(room.roomIdentifier) === normalizedIdentifier);
  loading.value = true;
  try {
    const snapshot = await desktopIpc.room.getSnapshot(normalizedIdentifier);
    openRoomSnapshot(snapshot, {
      kind: "room",
      rootPath: null,
      meta: knownRoom?.role === "admin" ? "Admin" : "Account room",
    });
  } finally {
    loading.value = false;
  }
}

async function handleNotificationActivation(target: DesktopNotificationTarget): Promise<void> {
  try {
    await openRoomFromAppAgent(target.roomIdentifier);
    notificationRevealMessageId.value = target.messageId;
    notificationRevealNonce.value += 1;
  } catch (error) {
    console.warn("Could not open the room for this notification.", error);
  }
}

async function refreshActiveRoomAfterChatStorageChange(): Promise<void> {
  await desktopIpc.room.stopStream();
  await refreshActiveRepoStatus();
  clearSelectedSnapshotCache();
  selectedSnapshot.value = null;
  const rootRoomIdentifier = selectedRootRoomIdentifier.value || rootRoomSnapshot.value?.roomIdentifier || null;
  if (rootRoomIdentifier) {
    const nextRootSnapshot = await desktopIpc.room.getSnapshot(rootRoomIdentifier);
    rootRoomSnapshot.value = nextRootSnapshot;
    selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
    rememberRootRoomSnapshot(nextRootSnapshot);
    await refreshSelectedSnapshot(nextRootSnapshot);
  }
  if (selectedRoomIdentifier.value) {
    await syncSelectedRoomStream(selectedRoomIdentifier.value);
  }
}

async function setChatStorageMode(mode: DesktopChatStorageSettings["mode"]): Promise<void> {
  chatStorageBusy.value = true;
  chatStorageFeedback.value = null;
  try {
    const bridge = getChatStorageBridge();
    if (!bridge) return;
    chatStorageSettings.value = await bridge.setMode(mode);
    chatStorageFeedback.value = {
      state: "success",
      message:
        mode === "local"
          ? "Local chat storage is on. New messages stay on this computer."
          : "Cloud chat storage is on. Local history remains local until you publish it.",
    };
    await refreshActiveRoomAfterChatStorageChange();
  } catch (error) {
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Chat storage mode could not be updated.",
    };
  } finally {
    chatStorageBusy.value = false;
  }
}

async function syncLocalChat(): Promise<void> {
  const roomIdentifier = selectedRoomIdentifier.value || selectedRootRoomIdentifier.value;
  if (!roomIdentifier) {
    chatStorageFeedback.value = {
      state: "error",
      message: "Open a room before publishing local chat.",
    };
    return;
  }
  chatStorageBusy.value = true;
  chatStorageFeedback.value = null;
  try {
    const bridge = getChatStorageBridge();
    if (!bridge) return;
    const result = await bridge.syncLocalRoom(roomIdentifier);
    chatStorageFeedback.value = {
      state: result.skippedCount > 0 || result.skippedTaskCount > 0 ? "info" : "success",
      message:
        result.skippedCount > 0 || result.skippedTaskCount > 0
          ? `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks. ${result.skippedCount + result.skippedTaskCount} items were skipped.`
          : `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks.`,
    };
  } catch (error) {
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Local chat could not be published.",
    };
  } finally {
    chatStorageBusy.value = false;
  }
}

function handleOwnMessageSent(message: Parameters<typeof handleMessageSent>[0]): void {
  handleMessageSent(message);
  markActiveRoomRead();
}

function handleRoomShellRefresh(snapshot?: DesktopRoomSnapshot): void {
  handleRefreshRoom(snapshot);
  if (!snapshot?.roomIdentifier) return;
  void syncSelectedRoomStream(snapshot.roomIdentifier);
}

function handleRoomMessageRevealUnavailable(_messageId: string): void {
  pushActionToast("That earlier message is not available in the loaded room history.", "info");
}

function rememberChatScrollPosition(roomIdentifier: string, scrollTop: number): void {
  const storageKey = chatScrollPositionKey(roomIdentifier) || roomIdentifier;
  if (!shouldRememberChatScrollPosition({
    roomIdentifier,
    selectedRoomIdentifier: selectedRoomInfo.value.identifier,
    selectedSnapshotLoading: selectedSnapshotLoading.value,
    suppressedRoomIdentifiers: loadingChatScrollRoomIdentifiers.value,
  })) {
    return;
  }
  chatScrollTopByRoom.value = {
    ...chatScrollTopByRoom.value,
    [storageKey]: scrollTop,
  };
}

function chatScrollTopForRoom(roomIdentifier: string): number | null {
  const storageKey = chatScrollPositionKey(roomIdentifier);
  if (storageKey && chatScrollTopByRoom.value[storageKey] !== undefined) {
    return chatScrollTopByRoom.value[storageKey];
  }
  return chatScrollTopByRoom.value[roomIdentifier] ?? null;
}

function rememberLoadingChatScrollRoom(roomIdentifier: string | null | undefined): void {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedRoomIdentifier || loadingChatScrollRoomIdentifiers.value.has(normalizedRoomIdentifier)) return;
  loadingChatScrollRoomIdentifiers.value = new Set([
    ...loadingChatScrollRoomIdentifiers.value,
    normalizedRoomIdentifier,
  ]);
}

function forgetLoadingChatScrollRooms(roomIdentifiers: Array<string | null | undefined>): void {
  const normalizedRoomIdentifiers = roomIdentifiers
    .map(normalizeRoomIdentifier)
    .filter((roomIdentifier): roomIdentifier is string => Boolean(roomIdentifier));
  if (!normalizedRoomIdentifiers.length) return;
  const nextRoomIdentifiers = new Set(loadingChatScrollRoomIdentifiers.value);
  for (const roomIdentifier of normalizedRoomIdentifiers) {
    nextRoomIdentifiers.delete(roomIdentifier);
  }
  if (nextRoomIdentifiers.size === loadingChatScrollRoomIdentifiers.value.size) return;
  loadingChatScrollRoomIdentifiers.value = nextRoomIdentifiers;
}

watch(
  [() => selectedSnapshotLoading.value, () => activeChatScrollRoomIdentifier()] as const,
  ([loading, roomIdentifier]) => {
    if (loading) rememberLoadingChatScrollRoom(roomIdentifier);
  },
  { flush: "sync" }
);

watch(
  [
    () => selectedSnapshotLoading.value,
    () => selectedSnapshot.value?.roomIdentifier || null,
    () => selectedSnapshot.value?.room?.identifier || null,
  ] as const,
  ([loading, roomIdentifier, roomInfoIdentifier]) => {
    if (loading) return;
    forgetLoadingChatScrollRooms([roomIdentifier, roomInfoIdentifier]);
  },
  { flush: "sync" }
);

function activeChatScrollRoomIdentifier(): string | null {
  if (activeEntry.value.type === "room") {
    return activeEntry.value.roomIdentifier || selectedRoomInfo.value.identifier || null;
  }
  return selectedRoomInfo.value.identifier || null;
}

watch(
  () => activeEntry.value,
  async (nextEntry, previousEntry) => {
    const selectedEntryId = nextEntry.id;
    const previousRoomIdentifier = previousEntry?.type === "room" ? previousEntry.roomIdentifier : null;
    forgetLoadingChatScrollRooms([activeChatScrollRoomIdentifier()]);
    if (previousRoomIdentifier) {
      void nextTick(() => {
        forgetLoadingChatScrollRooms([previousRoomIdentifier]);
      });
    }
    rememberStoredString(activeEntryStorageKey, nextEntry.id);
    if (!rootRoomSnapshot.value) return;
    if (nextEntry.id === previousEntry?.id) return;
    await refreshSelectedSnapshot(rootRoomSnapshot.value);
    if (activeEntry.value.id !== selectedEntryId) return;
    markActiveRoomRead();
  }
);

watch(
  [() => projectEntries.value, () => loading.value],
  () => {
    if (loading.value || !rootRoomSnapshot.value) return;
    if (!sidebarMetadataRefreshInFlight) {
      void refreshSidebarLatestMessages();
    }
  },
  { deep: true, immediate: true }
);

watch(
  () => selectedRootRoomIdentifier.value,
  (roomIdentifier) => {
    rememberStoredString(selectedRootRoomStorageKey, roomIdentifier);
  },
  { immediate: true }
);

watch(
  () => activeProjectRootPath(),
  (rootPath) => {
    void restartRepoStatusWatch(rootPath);
  },
  { immediate: true }
);

watch(recentRootRooms, () => {
  void refreshProjectBindings();
}, { deep: true });

watch(
  [
    () => settingsAccountRooms.value,
    () => selectedRootRoomIdentifier.value,
    () => rootRoomSnapshot.value?.roomIdentifier || null,
  ],
  () => {
    void leaveArchivedSelectedRoomFromSettingsList();
  },
  { deep: true, immediate: true }
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
    markActiveRoomRead();
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

watch(
  () => authStatus.value?.authenticated,
  (authenticated) => {
    if (authenticated) authDialogOpen.value = false;
  },
);

onMounted(() => {
  unsubscribeRoomStream = desktopIpc.room?.onStreamEvent?.(handleDesktopRoomStreamEvent) || null;
  unsubscribeOpenSettings = desktopIpc.ui?.onOpenSettings(openSettingsSurface) || null;
  unsubscribeOpenUpdates = desktopIpc.ui?.onOpenUpdates?.(openUpdatesSurface) || null;
  unsubscribeUpdateStatus = desktopIpc.updates?.onStatusChanged?.((status) => {
    updateStatus.value = status;
  }) || null;
  unsubscribeNotificationActivation = desktopIpc.notifications?.onActivated?.((target) => {
    void handleNotificationActivation(target);
  }) || null;
  void desktopIpc.notifications?.takePendingActivation?.().then((target) => {
    if (target) void handleNotificationActivation(target);
  });
  unsubscribeRepoStatusChanged = desktopIpc.repos?.onStatusChanged?.(handleRepoStatusChanged) || null;
  accountRoomsRefreshInterval = window.setInterval(() => {
    if (shouldSkipPollTick({ hidden: document.hidden })) return;
    void refreshSidebarRoomMetadata();
  }, SIDEBAR_METADATA_REFRESH_INTERVAL_MS);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  syncAppIdleAttribute();
  void loadChatStorageSettings();
  void loadAppAgentSettingsStatus();
  void loadAppAgentActions();
  void loadFirstRunSetup(initializeProjectBindings());
  void refreshRentalRequestCount();
  void refreshDesktopUpdateStatus();
});

onBeforeUnmount(() => {
  clearAuthPollTimer();
  clearLiveMetadataRefreshTimer();
  clearLiveMetadataRefreshInterval();
  if (accountRoomsRefreshInterval) {
    window.clearInterval(accountRoomsRefreshInterval);
    accountRoomsRefreshInterval = null;
  }
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("blur", handleWindowBlur);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.documentElement.removeAttribute(APP_IDLE_ATTRIBUTE);
  unsubscribeRoomStream?.();
  unsubscribeRoomStream = null;
  unsubscribeOpenSettings?.();
  unsubscribeOpenSettings = null;
  unsubscribeOpenUpdates?.();
  unsubscribeOpenUpdates = null;
  unsubscribeUpdateStatus?.();
  unsubscribeUpdateStatus = null;
  unsubscribeNotificationActivation?.();
  unsubscribeNotificationActivation = null;
  unsubscribeRepoStatusChanged?.();
  unsubscribeRepoStatusChanged = null;
  void desktopIpc.repos?.stopStatusWatch?.();
  void desktopIpc.room?.stopStream?.();
});
</script>
