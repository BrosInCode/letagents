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
      :rooms-collapsed="roomsCollapsed"
      :collapsed-projects="collapsedProjects"
      @cycle-sidebar="cycleSidebar"
      @new-room="selectNewRoomEntry"
      @archive-room="archiveSidebarRoom"
      @select-entry="handleSidebarEntrySelected"
      @toggle-project="toggleProject"
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
          :rooms-collapsed="roomsCollapsed"
          :collapsed-projects="collapsedProjects"
          @cycle-sidebar="closeSidebarPeek"
          @new-room="selectNewRoomEntry"
          @archive-room="archiveSidebarRoom"
          @select-entry="handleSidebarEntrySelected"
          @toggle-project="toggleProject"
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
          :room="selectedRoomInfo"
          :storage="selectedRoomStorage"
          :focus-rooms="selectedFocusRooms"
          :tasks="selectedSnapshot?.tasks || []"
          :participants="selectedSnapshot?.participants || []"
          :participant-hidden-count="selectedSnapshot?.participantHiddenCount || 0"
          :presence="selectedSnapshot?.presence || []"
          :reasoning-sessions="selectedSnapshot?.reasoningSessions || []"
          :recent-activity="selectedSnapshot?.recentActivity || []"
          :messages="selectedSnapshot?.messages || []"
          :github-events="selectedSnapshot?.githubEvents || null"
          :repo-status="repoStatusValue"
          :workers="workers"
          :open-add-agent-requested="openAddAgentAfterRepoPick"
          :initial-chat-scroll-top="chatScrollTopByRoom[selectedRoomInfo.identifier] ?? null"
          @chat-scroll-position="rememberChatScrollPosition"
          @message-sent="handleOwnMessageSent"
          @room-renamed="handleRoomRenamed"
          @task-updated="upsertSelectedTask"
          @refresh-room="handleRoomShellRefresh"
          @open-focus-room="openFocusRoomFromRoomsTab"
          @cycle-sidebar="cycleSidebar"
          @choose-repo="pickRepoRoomForAgent"
          @add-agent-open-request-consumed="openAddAgentAfterRepoPick = false"
        />
      </KeepAlive>

      <SettingsView
        v-if="activeEntry.type !== 'room'"
        :account-rooms="settingsAccountRooms"
        :app-info="appInfo"
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
        @set-chat-storage-mode="setChatStorageMode"
        @sync-local-chat="syncLocalChat"
        @toggle-pin-room="toggleAccountRoomPin"
        @refresh="refreshSettings"
        @sign-out="signOut"
        @start-auth="startAuthFlow"
      />

    </section>

    <DesktopNewRoomModal
      v-if="newRoomModalOpen"
      v-model:join-code="newRoomJoinCode"
      :busy="newRoomBusy"
      :feedback="newRoomFeedback"
      :feedback-state="newRoomFeedbackState"
      :project-selection="newRoomProjectSelection"
      @close="closeNewRoomModal"
      @confirm-project="confirmProjectRoomFromModal"
      @create-invite="createInviteRoom"
      @create-local="createLocalRoomFromModal"
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
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import type { RoomEntry, SidebarEntry } from "./components/desktop/types";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./components/desktop/setup/types";
import type { SettingsPaneId } from "./components/desktop/settings/types";
import { useDesktopAccountRoomSettings } from "./composables/useDesktopAccountRoomSettings";
import { useDesktopAppData } from "./composables/useDesktopAppData";
import { useDesktopAuthFlow } from "./composables/useDesktopAuthFlow";
import { useDesktopNavigationState } from "./composables/useDesktopNavigationState";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import { useDesktopSetupOnboarding } from "./composables/useDesktopSetupOnboarding";
import { settingsEntry } from "./domain/desktop-navigation";
import { readStoredString, rememberStoredString } from "./domain/desktop-storage";
import {
  hasUnreadRoomActivity,
  markRoomRead,
  readStoredRoomMessageIds,
  roomReadKey,
  seedRoomReadMarker,
} from "./domain/desktop-room-read-state";
import {
  normalizeRoomIdentifier,
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
const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
const openAddAgentAfterRepoPick = ref(false);
const chatStorageSettings = ref<DesktopChatStorageSettings | null>(null);
const chatStorageAvailable = ref(true);
const chatStorageBusy = ref(false);
const chatStorageFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
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
  roomsCollapsed,
  selectSidebarEntry,
  selectedAccess,
  selectedFocusRooms,
  selectedNeedsAccess,
  selectedRoomIdentifier,
  selectedRoomInfo,
  sidebarMode,
  toggleProject,
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
let accountRoomsRefreshInterval: number | null = null;
let sidebarMetadataRefreshInFlight = false;
let repoStatusRefreshInFlight = false;
let repoStatusRefreshTimer: number | null = null;

const isSettingsSurface = computed(() => activeEntry.value.type === "system");
const sidebarPeekOpen = ref(false);
const showSidebarPeek = computed(() => !isSettingsSurface.value && sidebarMode.value === "hidden");
const showSidebarResizeHandle = computed(() => !isSettingsSurface.value && sidebarMode.value === "expanded");
const desktopShellStyle = computed(() => ({
  "--sidebar-width": `${sidebarWidth.value}px`,
  "--sidebar-min-width": `${sidebarMinWidth}px`,
  "--sidebar-max-width": `${sidebarMaxWidth}px`,
}));
const sidebarProjectEntries = computed(() =>
  projectEntries.value.map((project) => ({
    ...project,
    parent: withRoomUnreadState(project.parent),
    focusRooms: project.focusRooms.map(withRoomUnreadState),
  }))
);
const selectedRoomRenderKey = computed(() =>
  selectedSnapshot.value?.room?.identifier
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
  sidebarPeekOpen.value = true;
}

function closeSidebarPeek(): void {
  sidebarPeekOpen.value = false;
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
    const nextRepoStatus = await window.letagentsDesktop.repos.getStatus(rootPath).catch(() => null);
    if (nextRepoStatus) repoStatus.value = nextRepoStatus;
  } finally {
    repoStatusRefreshInFlight = false;
  }
}

function activeProjectRootPath(): string | null {
  const identifier = normalizeRoomIdentifier(selectedRootRoomIdentifier.value || rootRoomSnapshot.value?.roomIdentifier);
  if (!identifier) return null;
  return recentRootRooms.value.find(
    (room) => normalizeRoomIdentifier(room.identifier) === identifier
  )?.rootPath || null;
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
  void refreshSidebarRoomMetadata();
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
  if (!roomIdentifiers.length || !window.letagentsDesktop.room.getLatestMessages) {
    sidebarLatestMessages.value = {};
    return;
  }

  const latestMessages = await window.letagentsDesktop.room.getLatestMessages(roomIdentifiers).catch(() => []);
  const nextLatestMessages: Record<string, DesktopRoomLatestMessage> = {};
  for (const latestMessage of latestMessages) {
    const key = roomReadKey(latestMessage.roomIdentifier);
    if (!key) continue;
    nextLatestMessages[key] = latestMessage;
  }
  sidebarLatestMessages.value = nextLatestMessages;
  seedReadMarkersForKnownRooms();
  markActiveRoomRead();
}

function sidebarRoomIdentifiers(): string[] {
  const identifiers = new Set<string>();
  for (const project of projectEntries.value) {
    for (const entry of [project.parent, ...project.focusRooms]) {
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
    .flatMap((project) => project.focusRooms)
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
  };
  handleSidebarEntrySelected(fallbackEntry);
}

function seedReadMarkersForKnownRooms(): void {
  let nextMarkers = readRoomMessageIds.value;
  let changed = false;
  for (const project of projectEntries.value) {
    for (const entry of [project.parent, ...project.focusRooms]) {
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
  handleMessageSent,
  handleRefreshRoom,
  handleRoomRenamed,
  handleRoomStreamEvent,
  loadFirstRunRoomContext,
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
  confirmProjectRoomFromModal,
  createInviteRoom,
  createLocalRoomFromModal,
  joinRoomCodeFromModal,
  newRoomBusy,
  newRoomFeedback,
  newRoomFeedbackState,
  newRoomJoinCode,
  newRoomModalOpen,
  newRoomProjectSelection,
  openProjectRoomFromModal,
  selectNewRoomEntry,
} = useDesktopNewRoomModal({
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  setRepoStatus: (status) => {
    if (status) repoStatus.value = status;
  },
});
const {
  archiveSidebarRoom,
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
  repoStatus,
  selectedMcpTargetIds,
  setupLoadError,
});

async function pickRepoRoomForAgent(): Promise<void> {
  openAddAgentAfterRepoPick.value = false;
  const openedRoom = await pickRepoRoom();
  if (openedRoom) {
    openAddAgentAfterRepoPick.value = true;
  }
}

function getChatStorageBridge(): typeof window.letagentsDesktop.chatStorage | null {
  const bridge = window.letagentsDesktop?.chatStorage;
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

async function refreshActiveRoomAfterChatStorageChange(): Promise<void> {
  await window.letagentsDesktop.room.stopStream();
  await refreshActiveRepoStatus();
  selectedSnapshot.value = null;
  const rootRoomIdentifier = selectedRootRoomIdentifier.value || rootRoomSnapshot.value?.roomIdentifier || null;
  if (rootRoomIdentifier) {
    const nextRootSnapshot = await window.letagentsDesktop.room.getSnapshot(rootRoomIdentifier);
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
          : "Cloud chat storage is on. Local history remains local until you sync it.",
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
      message: "Open a room before syncing local chat.",
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
          : "Local chat could not be synced.",
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
  chatScrollTopByRoom.value = {
    ...chatScrollTopByRoom.value,
    [roomIdentifier]: scrollTop,
  };
}

watch(
  () => activeEntry.value,
  async (nextEntry, previousEntry) => {
    const selectedEntryId = nextEntry.id;
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
  unsubscribeRoomStream = window.letagentsDesktop?.room?.onStreamEvent?.(handleRoomStreamEvent) || null;
  unsubscribeOpenSettings = window.letagentsDesktop?.ui?.onOpenSettings(openSettingsSurface) || null;
  accountRoomsRefreshInterval = window.setInterval(() => {
    void refreshSidebarRoomMetadata();
  }, 5_000);
  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void loadChatStorageSettings();
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
  void window.letagentsDesktop?.room?.stopStream?.();
});
</script>
