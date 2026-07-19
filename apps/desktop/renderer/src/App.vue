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
      @sign-out="signOut"
      @continue-to-room="continueToRoomConfirmation"
      @connect-room-auth="startFirstRunRoomAuth"
      @pick-repo="pickRepoRoom"
      @join-room-code="joinRoomCode"
      @back="goBackFirstRun"
      @finish="finishFirstRunOnboarding"
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
    <DesktopSidebar
      v-if="!isSettingsSurface && sidebarMode !== 'hidden'"
      :sidebar-mode="sidebarMode"
      :active-entry="activeEntry"
      :primary-room="currentParentRoom"
      :project-entries="sidebarProjectEntries"
      :settings-entry="settingsEntry"
      :pinned-collapsed="pinnedCollapsed"
      :rooms-collapsed="roomsCollapsed"
      :collapsed-projects="collapsedProjects"
      @cycle-sidebar="cycleSidebar"
      @new-room="selectNewRoomEntry"
      @archive-room="archiveSidebarRoom"
      @archive-focus-room="archiveSidebarFocusRoom"
      @mark-room-read="markRoomEntryRead"
      @pin-room="togglePinSidebarRoom"
      @rename-room="renameSidebarRoom"
      @select-entry="handleSidebarEntrySelected"
      @set-projects-collapsed="setAllProjectsCollapsed"
      @toggle-project="toggleProject"
      @toggle-pinned-collapsed="togglePinnedCollapsed"
      @toggle-rooms-collapsed="toggleRoomsCollapsed"
    />
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
    <div
      v-if="showSidebarPeek"
      class="sidebar-peek-zone"
      data-testid="sidebar-peek-zone"
      @pointerenter="openSidebarPeek"
    ></div>
    <Transition name="sidebar-peek">
      <div
        v-if="sidebarPeekOpen"
        class="sidebar-peek-panel"
        data-testid="sidebar-peek-panel"
        @pointerleave="closeSidebarPeek"
      >
        <DesktopSidebar
          sidebar-mode="expanded"
          :active-entry="activeEntry"
          :primary-room="currentParentRoom"
          :project-entries="sidebarProjectEntries"
          :settings-entry="settingsEntry"
          :pinned-collapsed="pinnedCollapsed"
          :rooms-collapsed="roomsCollapsed"
          :collapsed-projects="collapsedProjects"
          @context-menu-open="handleSidebarPeekMenuOpen"
          @cycle-sidebar="closeSidebarPeek"
          @new-room="selectNewRoomEntry"
          @archive-room="archiveSidebarRoom"
          @archive-focus-room="archiveSidebarFocusRoom"
          @mark-room-read="markRoomEntryRead"
          @pin-room="togglePinSidebarRoom"
          @rename-room="renameSidebarRoom"
          @select-entry="handleSidebarEntrySelected"
          @set-projects-collapsed="setAllProjectsCollapsed"
          @toggle-project="toggleProject"
          @toggle-pinned-collapsed="togglePinnedCollapsed"
          @toggle-rooms-collapsed="toggleRoomsCollapsed"
        />
      </div>
    </Transition>

    <section class="app-main" :data-room-entry="activeEntry.type === 'room'" data-testid="desktop-main">
      <DesktopTopbar
        v-if="activeEntry.type !== 'room' && !isSettingsSurface"
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="openSettingsSurface"
        @refresh="refresh"
      />

      <AuthOnboardingView
        v-if="activeEntry.type === 'room' && selectedNeedsAccess"
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
          :board-settings="selectedSnapshot?.boardSettings || null"
          :messages="selectedSnapshot?.messages || []"
          :github-events="selectedSnapshot?.githubEvents || null"
          :source-states="selectedSnapshot?.sourceStates || null"
          :repo-status="repoStatusValue"
          :git-room-matches-active-repo="selectedGitRoomMatchesActiveRepo"
          :durable-project-root-path="selectedRoomProjectRootPath"
          :home-path="appInfo?.homePath || null"
          :workers="workers"
          :open-add-agent-requested="openAddAgentAfterRepoPick"
          :initial-chat-scroll-top="chatScrollTopForRoom(selectedRoomInfo.identifier)"
          @chat-scroll-position="rememberChatScrollPosition"
          @message-sent="handleOwnMessageSent"
          @room-renamed="handleRoomRenamed"
          @task-updated="upsertSelectedTask"
          @refresh-room="handleRoomShellRefresh"
          @open-focus-room="openFocusRoomFromRoomsTab"
          @cycle-sidebar="cycleSidebar"
          @choose-repo="pickRepoRoomForAgent"
          @choose-worktree="openWorktreeForAgent"
          @open-repo-root="openWorkspaceGitRoom"
          @add-agent-open-request-consumed="openAddAgentAfterRepoPick = false"
        />
      </KeepAlive>

      <SettingsView
        v-if="activeEntry.type !== 'room'"
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
        @back-mcp="goBackMcpOnboarding"
        @back-to-app="activeEntry = currentParentRoom"
        @clear-mcp-target-selection="clearMcpTargetSelection"
        @continue-mcp="continueMcpOnboarding"
        @delete-room="deleteAccountRoom"
        @finish-mcp="completeMcpOnboarding"
        @install-mcp-targets="installSelectedMcpTargets"
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
        @start-auth="startAuthFlow"
      />

    </section>

    <DesktopAppAgent
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomLatestMessage,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import DesktopNewRoomModal from "./components/desktop/content/DesktopNewRoomModal.vue";
import DesktopAppAgent from "./components/desktop/app-agent/DesktopAppAgent.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import { isAuthSnapshotPending } from "./components/desktop/content/auth-onboarding";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import FirstRunSplashView from "./components/desktop/setup/FirstRunSplashView.vue";
import type { ProjectGroup, RoomEntry, SidebarEntry } from "./components/desktop/types";
import { activeRepoRoomContext, resolveActiveProjectRootPath, roomWithInheritedProjectContext } from "./domain/room-project-context";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { SettingsPaneId } from "./components/desktop/settings/types";
import { useDesktopAccountRoomSettings } from "./composables/useDesktopAccountRoomSettings";
import { useDesktopActionToasts } from "./composables/useDesktopActionToasts";
import { useDesktopAppData } from "./composables/useDesktopAppData";
import { useDesktopAuthFlow } from "./composables/useDesktopAuthFlow";
import { useDesktopNavigationState } from "./composables/useDesktopNavigationState";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import { useDesktopSetupOnboarding } from "./composables/useDesktopSetupOnboarding";
import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "./domain/chat-scroll";
import { appAgentEntry, settingsEntry } from "./domain/desktop-navigation";
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
  readStoredRecentRootRooms,
  rememberRecentRootRooms,
} from "./domain/sidebar-rooms";
import {
  appAgentArchivedRoomIdentifiers,
  appAgentRefreshTargets,
} from "./domain/app-agent";
import { openManagedAgentWorktree } from "./domain/managed-agent-worktrees";
import { desktopIpc } from "./ipc/index.js";

const loading = ref(false);
const appInfo = ref<DesktopAppInfo | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
// Canonical status of the launched desktop workspace, used only to identity-match
// a repo-backed room's self-heal target so it never inherits an unrelated repo.
const workspaceRepoStatus = ref<RepoStatus | null>(null);
let workspaceRepoStatusRootPath: string | null = null;
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const authStatus = ref<DesktopAuthStatus | null>(null);
const selectedRootRoomStorageKey = "letagents-desktop:selected-root-room";
const activeEntryStorageKey = "letagents-desktop:active-entry";
const recentRootRoomsStorageKey = "letagents-desktop:recent-root-rooms";
const readRoomMessagesStorageKey = "letagents-desktop:read-room-message-ids";
const sidebarWidthStorageKey = "letagents-desktop:sidebar-width";
const sidebarMinWidth = 260;
const sidebarMaxWidth = 440;
const sidebarDefaultWidth = 296;
const selectedRootRoomIdentifier = ref<string | null>(readStoredString(selectedRootRoomStorageKey));
const recentRootRooms = ref(readStoredRecentRootRooms(recentRootRoomsStorageKey));
const readRoomMessageIds = ref(readStoredRoomMessageIds(window.localStorage, readRoomMessagesStorageKey));
const sidebarWidth = ref(readStoredSidebarWidth());
const isSidebarResizing = ref(false);
const sidebarLatestMessages = ref<Record<string, DesktopRoomLatestMessage>>({});
const chatScrollTopByRoom = ref<Record<string, number>>({});
const loadingChatScrollRoomIdentifiers = ref<Set<string>>(new Set());
const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
const openAddAgentAfterRepoPick = ref(false);
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
  cycleSidebar,
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
let unsubscribeRepoStatusChanged: (() => void) | null = null;
let accountRoomsRefreshInterval: number | null = null;
let sidebarMetadataRefreshInFlight = false;
let repoStatusRefreshInFlight = false;
let repoStatusRefreshTimer: number | null = null;
let repoStatusWatchRootPath: string | null = null;
let repoStatusWatchRequestId = 0;

const { actionToasts, dismissActionToast, pushActionToast } = useDesktopActionToasts();

const isSettingsSurface = computed(() => activeEntry.value.type === "system");
const sidebarPeekOpen = ref(false);
const sidebarPeekMenuOpen = ref(false);
const sidebarPeekCloseSuppressed = ref(false);
const showSidebarPeek = computed(() => !isSettingsSurface.value && sidebarMode.value === "hidden");
const showSidebarResizeHandle = computed(() => !isSettingsSurface.value && sidebarMode.value === "expanded");
const desktopShellStyle = computed(() => ({
  "--sidebar-width": `${sidebarWidth.value}px`,
  "--sidebar-min-width": `${sidebarMinWidth}px`,
  "--sidebar-max-width": `${sidebarMaxWidth}px`,
}));

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
  projectEntries.value.map((project) => ({
    ...project,
    parent: withRoomUnreadState(project.parent),
    branchRooms: project.branchRooms.map(withRoomUnreadState),
    focusRooms: project.focusRooms.map(withRoomUnreadState),
  }))
);
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

const settingsPaneForActiveEntry = computed<SettingsPaneId>(() => {
  if (activeEntry.value.type !== "system") return "storage:chat";
  if (activeEntry.value.id === "system:setup") return "system:setup";
  if (activeEntry.value.id === "system:app-agent") return "system:app-agent";
  if (activeEntry.value.id === "system:repos") return "system:runtime";
  if (activeEntry.value.id === "system:workers") return "system:agents";
  if (activeEntry.value.id === "system:diagnostics") return "system:diagnostics";
  return "storage:chat";
});

function openSettingsSurface(): void {
  activeEntry.value = settingsEntry;
}

function openSidebarPeek(): void {
  if (!showSidebarPeek.value) return;
  sidebarPeekMenuOpen.value = false;
  sidebarPeekCloseSuppressed.value = false;
  sidebarPeekOpen.value = true;
}

function closeSidebarPeek(): void {
  // A context menu teleports outside the peek panel; leaving the panel to use
  // it must not unmount the menu. Defer the close until the menu settles.
  if (sidebarPeekMenuOpen.value) {
    sidebarPeekCloseSuppressed.value = true;
    return;
  }
  sidebarPeekOpen.value = false;
}

function handleSidebarPeekMenuOpen(open: boolean): void {
  sidebarPeekMenuOpen.value = open;
  if (!open && sidebarPeekCloseSuppressed.value) {
    sidebarPeekCloseSuppressed.value = false;
    sidebarPeekOpen.value = false;
  }
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
  if (showFirstRunGate.value || sidebarMetadataRefreshInFlight) return;
  sidebarMetadataRefreshInFlight = true;
  try {
    await refreshAccountRooms().catch(() => undefined);
    await refreshSidebarLatestMessages();
  } finally {
    sidebarMetadataRefreshInFlight = false;
  }
}

async function refreshActiveRepoStatus(): Promise<void> {
  if (showFirstRunGate.value || repoStatusRefreshInFlight) return;
  const rootPath = activeProjectRootPath();
  if (!rootPath) return;
  repoStatusRefreshInFlight = true;
  try {
    const nextRepoStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
    if (nextRepoStatus) repoStatus.value = nextRepoStatus;
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
    // A repo-backed room whose durable root was lost self-heals from the
    // workspace ONLY when their canonical Git identity matches; otherwise it
    // fails closed so a focus room never launches in an unrelated repo.
    activeRootGitRoom: context
      ? context.gitRoom
      : rootRoomSnapshot.value?.room?.gitRoom ?? null,
    recentRootRooms: recentRootRooms.value,
    workspaceRepoStatus: workspaceRepoStatus.value,
  });
}

async function refreshWorkspaceRepoStatus(force = false): Promise<void> {
  const workspaceRoot = appInfo.value?.workspaceRoot?.trim() || null;
  if (!workspaceRoot) return;
  // Re-probe on force (e.g. window focus) so a branch/worktree switch can't leave
  // a stale identity authorizing the wrong ref; otherwise load once per workspace.
  if (!force && workspaceRepoStatusRootPath === workspaceRoot && workspaceRepoStatus.value) return;
  workspaceRepoStatusRootPath = workspaceRoot;
  const status = await desktopIpc.repos.getStatus(workspaceRoot).catch(() => null);
  if (workspaceRepoStatusRootPath === workspaceRoot) workspaceRepoStatus.value = status;
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

function scheduleFocusedRepoStatusRefresh(delayMs = 150): void {
  if (repoStatusRefreshTimer !== null) {
    window.clearTimeout(repoStatusRefreshTimer);
  }
  repoStatusRefreshTimer = window.setTimeout(() => {
    repoStatusRefreshTimer = null;
    void refreshActiveRepoStatus();
  }, delayMs);
}

function refreshForegroundData(): void {
  scheduleFocusedRepoStatusRefresh();
  void refreshWorkspaceRepoStatus(true);
  void refreshSidebarRoomMetadata();
}

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
  if (document.visibilityState !== "visible") return;
  refreshForegroundData();
}

function handleWindowFocus(): void {
  refreshForegroundData();
}

async function refreshSidebarLatestMessages(): Promise<void> {
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
  if (entry.type === "room") {
    markRoomEntryRead(entry);
  }
  selectSidebarEntry(entry);
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
  return [...project.branchRooms, ...project.focusRooms];
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
  scheduleLiveMetadataRefresh,
  syncSelectedRoomStream,
} = useDesktopRoomLiveSync({
  rootRoomSnapshot,
  selectedRoomIdentifier,
  selectedSnapshot,
  workers,
});

const {
  clearSelectedSnapshotCache,
  handleMessageSent,
  handleRefreshRoom,
  handleRoomRenamed,
  handleRoomStreamEvent,
  refresh,
  refreshAccountRooms,
  refreshSelectedSnapshot,
  repoStatusValue,
  selectedSnapshotLoading,
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
  selectedMcpTargetIds,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  workers,
});

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
  onSignedOut: () => refresh(),
});

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
  archiveSidebarFocusRoom,
  archiveSidebarRoom,
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

const {
  clearMcpTargetSelection,
  completeMcpOnboarding,
  continueMcpOnboarding,
  continueToRoomConfirmation,
  finishFirstRunOnboarding,
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

async function pickRepoRoomForAgent(): Promise<void> {
  openAddAgentAfterRepoPick.value = false;
  const openedRoom = await pickRepoRoom();
  if (openedRoom) {
    openAddAgentAfterRepoPick.value = true;
  }
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
  ]);
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

watch(showSidebarPeek, (enabled) => {
  if (!enabled) {
    closeSidebarPeek();
  }
});

watch(
  () => selectedRootRoomIdentifier.value,
  (roomIdentifier) => {
    rememberStoredString(selectedRootRoomStorageKey, roomIdentifier);
  },
  { immediate: true }
);

watch(
  () => appInfo.value?.workspaceRoot || null,
  () => {
    void refreshWorkspaceRepoStatus();
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

onMounted(() => {
  unsubscribeRoomStream = desktopIpc.room?.onStreamEvent?.(handleRoomStreamEvent) || null;
  unsubscribeOpenSettings = desktopIpc.ui?.onOpenSettings(openSettingsSurface) || null;
  unsubscribeRepoStatusChanged = desktopIpc.repos?.onStatusChanged?.(handleRepoStatusChanged) || null;
  accountRoomsRefreshInterval = window.setInterval(() => {
    void refreshSidebarRoomMetadata();
  }, 5_000);
  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void loadChatStorageSettings();
  void loadAppAgentSettingsStatus();
  void loadAppAgentActions();
  void loadFirstRunSetup();
});

onBeforeUnmount(() => {
  clearAuthPollTimer();
  clearLiveMetadataRefreshTimer();
  clearLiveMetadataRefreshInterval();
  if (accountRoomsRefreshInterval) {
    window.clearInterval(accountRoomsRefreshInterval);
    accountRoomsRefreshInterval = null;
  }
  if (repoStatusRefreshTimer !== null) {
    window.clearTimeout(repoStatusRefreshTimer);
    repoStatusRefreshTimer = null;
  }
  window.removeEventListener("focus", handleWindowFocus);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  unsubscribeRoomStream?.();
  unsubscribeRoomStream = null;
  unsubscribeOpenSettings?.();
  unsubscribeOpenSettings = null;
  unsubscribeRepoStatusChanged?.();
  unsubscribeRepoStatusChanged = null;
  void desktopIpc.repos?.stopStatusWatch?.();
  void desktopIpc.room?.stopStream?.();
});
</script>
