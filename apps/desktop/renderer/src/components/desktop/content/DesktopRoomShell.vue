<template>
  <section class="desktop-room-shell" :data-liquid-glass="liquidGlassEnabled" data-testid="desktop-room-shell">
    <DesktopRoomHeader
      :sidebar-mode="sidebarMode"
      :room="room"
      :storage="storage"
      :tabs="tabs"
      :active-tab="activeTab"
      :search-open="searchOpen"
      :action-panel-open="actionPanelOpen"
      @cycle-sidebar="emit('cycle-sidebar')"
      @toggle-search="toggleSearchTool"
      @toggle-action-panel="toggleActionPanel"
      @select-tab="selectTab"
    />

    <DesktopRoomControlRail
      v-model:search-query="searchQuery"
      :action-panel-open="actionPanelOpen"
      :search-open="searchOpen"
      :room="room"
      :storage="storage"
      :room-url="roomUrl"
      :copied="roomLinkCopied"
      :sound-enabled="soundEnabled"
      :notifications-enabled="notificationsEnabled"
      :notification-permission="notificationPermission"
      :liquid-glass-enabled="liquidGlassEnabled"
      :rename-busy="renameBusy"
      :rename-error="renameError"
      :github-status="githubStatus"
      :github-loading="githubLoading"
      :github-busy="githubBusy"
      :github-error="githubError"
      :github-events-available="githubEventsAvailable"
      :github-events-visible="githubEventsVisible"
      :storage-busy="storageBusy"
      :search-summary="searchSummary"
      :search-results-count="searchResults.length"
      @copy-room-link="copyRoomLink"
      @open-rules="openRules"
      @toggle-sound="toggleSound"
      @toggle-notifications="toggleNotifications"
      @toggle-liquid-glass="toggleLiquidGlass"
      @toggle-github-events-visible="toggleGitHubEventsVisible"
      @set-room-storage-mode="setRoomStorageMode"
      @fork-room-to-local="forkRoomToLocal"
      @publish-local-room="publishLocalRoom"
      @rename-room="renameRoom"
      @refresh-github="refreshGitHubIntegration"
      @install-github="installGitHubIntegration"
      @export-chat="exportChat"
      @move-search="moveSearch"
      @close-search="closeSearch"
      @close-action-panel="closeActionPanel"
    />

    <RoomChatView
      v-show="activeTab === 'chat'"
      :active="activeTab === 'chat'"
      :messages="timelineMessages"
      :thread-messages="visibleMessages"
      :message-namespace="messageNamespace"
      :has-filtered-room-activity="hasFilteredRoomActivity"
      :room-identifier="room.identifier"
      :room-loading="roomLoading"
      :sending="sendingMessage"
      :send-error="sendError"
      :has-older-messages="hasOlderMessages"
      :loading-older-messages="loadingOlderMessages"
      :participants="roomParticipants"
      :presence="roomPresence"
      :local-agent-work="localAgentWork"
      :reasoning-sessions="reasoningSessions"
      :tasks="tasks"
      :search-query="searchQuery"
      :active-search-message-id="activeSearchMessageId"
      :initial-draft="chatDraftText"
      :initial-scroll-top="initialChatScrollTop ?? null"
      @send-message="sendRoomMessage"
      @discard-attachment="discardAttachment"
      @load-older="loadOlderMessages"
      @open-reasoning="openReasoningInspector"
      @open-agent-reasoning-fallback="openAgentReasoningFallback"
      @open-agent-detail="openAgentDetail"
      @open-add-agent="openAddAgentModal"
      @draft-change="chatDraftText = $event"
      @open-github-event="openGitHubEventFromChat"
      @scroll-position="rememberChatScrollPosition"
    />

    <Transition name="room-panel" mode="out-in">
      <RoomBoardView
        v-if="activeTab === 'board'"
        key="board"
        :room-identifier="room.identifier"
        :tasks="tasks"
        :presence="roomPresence"
        :workers="workers"
        :selected-task-id="boardSelectedTaskId"
        @task-updated="emit('task-updated', $event)"
        @refresh-room="emit('refresh-room')"
        @update:selected-task-id="boardSelectedTaskId = $event"
        @view-events="openEventsForTask"
      />

      <RoomEventsView
        v-else-if="activeTab === 'events'"
        key="events"
        :room-identifier="room.identifier"
        :events-page="eventsPage"
        :repository="githubRepository"
        :current-branch="repoStatus.branch"
        :github-connected="Boolean(githubStatus?.connected)"
        :github-loading="githubLoading"
        :github-busy="githubBusy"
        :github-error="githubError"
        :loading="eventsLoading"
        :loading-older="eventsLoadingOlder"
        :error="eventsError"
        :linked-task-id="eventsTaskFilterId"
        :selected-event-id="eventsSelectedEventId"
        :loaded-older-without-matches="eventsLoadedOlderWithoutMatches"
        @refresh="refreshGitHubEvents"
        @load-older="loadOlderGitHubEvents"
        @install-github="installGitHubIntegration"
        @clear-task-filter="eventsTaskFilterId = null"
        @open-task="openBoardTaskFromEvents"
        @close-selected-event="eventsSelectedEventId = null"
      />

      <RoomActivityTabView
        v-else-if="activeTab === 'activity'"
        key="activity"
        :recent-activity="recentActivity"
        :participants="roomParticipants"
        :live-cleared-count="participantHiddenCount"
        :presence="roomPresence"
        :reasoning-sessions="reasoningSessions"
        :tasks="tasks"
        :messages="visibleMessages"
        :workers="workers"
        @open-reasoning="openReasoningInspector"
        @open-add-agent="openAddAgentModal"
        @open-agent-detail="openAgentDetail"
        @refresh-room="emit('refresh-room')"
      />

      <RoomDetailsView
        v-else-if="activeTab === 'rooms'"
        key="rooms"
        :room="room"
        :focus-rooms="focusRooms"
        :tasks="tasks"
        @open-focus-room="emit('open-focus-room', $event)"
        @refresh-room="emit('refresh-room')"
      />

      <RentAnAgentView
        v-else-if="activeTab === 'rent'"
        key="rent"
        :room-identifier="room.identifier"
      />
    </Transition>

    <DesktopRoomRulesModal
      :open="rulesOpen"
      @close="rulesOpen = false"
    />

    <DesktopReasoningInspector
      :open="Boolean(selectedReasoningSessionId && selectedReasoningSessionForInspector)"
      :room-identifier="room.identifier"
      :session="selectedReasoningSessionForInspector"
      @close="closeReasoningInspector"
    />

    <DesktopAgentDetailModal
      :open="Boolean(selectedAgentDetailTarget)"
      :room-identifier="room.identifier"
      :target="selectedAgentDetailTarget"
      :reasoning-sessions="reasoningSessions"
      @close="selectedAgentDetailTarget = null"
      @open-add-agent="openAddAgentModalFromDetail"
      @open-reasoning="openReasoningFromAgentDetail"
    />

    <AddAgentModal
      :open="addAgentModalOpen"
      :room-identifier="room.identifier"
      :room-display-name="room.displayName"
      :repo-root-path="managedAgentRepoRootPath"
      :managed-sessions="managedAgentSessions"
      @close="addAgentModalOpen = false"
      @choose-repo="openAgentRepoPicker"
      @managed-sessions-updated="replaceManagedAgentSessions"
      @managed-session-started="upsertManagedAgentSession"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopFocusRoomInfo,
  DesktopGitHubEventsPage,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopRoomMessage,
  DesktopReasoningSession,
  DesktopTaskSummary,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import { mergeDesktopGitHubEventsPage } from "../../../domain/desktop-room-snapshots";
import {
  activeManagedAgentWorkIndicators,
  managedAgentSessionMatchesRoom,
  mergeDesktopManagedAgentParticipants,
  mergeDesktopManagedAgentPresence,
  preferredManagedAgentRepoRootPath,
} from "../../../domain/managed-agents";
import type { SidebarMode } from "../types";
import AddAgentModal from "./AddAgentModal.vue";
import DesktopAgentDetailModal from "./DesktopAgentDetailModal.vue";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import RentAnAgentView from "./RentAnAgentView.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import RoomChatView from "./RoomChatView.vue";
import RoomEventsView from "./RoomEventsView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import { encodeRoomPathIdentifier } from "./room-shell/messages";
import {
  readGitHubEventsVisible,
  rememberGitHubEventsVisible,
} from "./room-shell/preferences";
import { exportRoomChat } from "./room-shell/roomExport";
import type { RoomTab, RoomTabId } from "./room-shell/types";
import { useDesktopReasoningInspector } from "./room-shell/useDesktopReasoningInspector";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import { useDesktopRoomGitHub } from "./room-shell/useDesktopRoomGitHub";
import { useDesktopRoomMessages } from "./room-shell/useDesktopRoomMessages";
import {
  useDesktopRoomPreferences,
  watchRoomNotifications,
} from "./room-shell/useDesktopRoomPreferences";
import { useDesktopRoomSearch } from "./room-shell/useDesktopRoomSearch";

const props = defineProps<{
  sidebarMode: SidebarMode;
  roomLoading: boolean;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
  repoStatus: RepoStatus;
  workers: WorkerSnapshot[];
  openAddAgentRequested?: boolean;
  initialChatScrollTop?: number | null;
}>();

const emit = defineEmits<{
  "cycle-sidebar": [];
  "message-sent": [message: DesktopRoomMessage];
  "room-renamed": [room: DesktopRoomInfo];
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [snapshot?: DesktopRoomSnapshot];
  "open-focus-room": [roomIdentifier: string];
  "chat-scroll-position": [roomIdentifier: string, scrollTop: number];
  "choose-repo": [];
  "add-agent-open-request-consumed": [];
}>();

const roomRef = toRef(props, "room");
const messagesRef = toRef(props, "messages");
const reasoningSessionsRef = toRef(props, "reasoningSessions");
const activeTab = ref<RoomTabId>("chat");
const actionPanelOpen = ref(false);
const addAgentModalOpen = ref(false);
const selectedAgentDetailTarget = ref<AgentModalTarget | null>(null);
const rulesOpen = ref(false);
const roomLinkCopied = ref(false);
const eventsPage = ref<DesktopGitHubEventsPage | null>(props.githubEvents);
const eventsLoading = ref(false);
const eventsLoadingOlder = ref(false);
const eventsError = ref<string | null>(null);
const eventsTaskFilterId = ref<string | null>(null);
const eventsSelectedEventId = ref<string | null>(null);
const eventsLoadedOlderWithoutMatches = ref(false);
const boardSelectedTaskId = ref<string | null>(null);
const storageBusy = ref(false);
const githubEventsVisible = ref(readGitHubEventsVisible(props.room.identifier));
const managedAgentSessions = ref<DesktopManagedAgentSession[]>([]);
let githubEventsRefreshTimer: number | null = null;
let managedAgentSessionsRefreshTimer: number | null = null;
let unsubscribeManagedAgentSessionUpdate: (() => void) | null = null;
const roomUrl = computed(() => `https://letagents.chat/in/${encodeRoomPathIdentifier(props.room.identifier)}`);
const isRepoBackedRoom = computed(() =>
  [props.room.identifier, props.room.name, props.room.displayName]
    .some((value) => value.toLowerCase().startsWith("github.com/"))
);
const isLocalRoom = computed(() => props.storage.effectiveMode === "local");
const messageNamespace = computed(() =>
  [
    props.room.identifier,
    props.storage.effectiveMode,
    props.storage.localRoom?.roomIdentifier || "cloud",
  ].join(":")
);

const {
  soundEnabled,
  notificationsEnabled,
  liquidGlassEnabled,
  notificationPermission,
  toggleSound,
  toggleNotifications,
  toggleLiquidGlass,
  playRoomSound,
  showRoomNotification,
} = useDesktopRoomPreferences();

const {
  sendingMessage,
  sendError,
  hasOlderMessages,
  loadingOlderMessages,
  chatDraftText,
  ownMessageIds,
  hasFilteredRoomActivity,
  visibleMessages,
  timelineMessages,
  roomMessagesForAgentInsight,
  sendRoomMessage,
  discardAttachment,
  loadOlderMessages,
} = useDesktopRoomMessages({
  room: roomRef,
  messages: messagesRef,
  githubEventsVisible,
  playRoomSound,
  onMessageSent: (message) => emit("message-sent", message),
});

const {
  searchOpen,
  searchQuery,
  searchResults,
  activeSearchMessageId,
  searchSummary,
  toggleSearch: toggleSearchOpen,
  closeSearch,
  moveSearch,
} = useDesktopRoomSearch(visibleMessages);

const {
  selectedReasoningSessionId,
  selectedReasoningSessionForInspector,
  openReasoningInspector,
  openAgentReasoningFallback,
  closeReasoningInspector,
} = useDesktopReasoningInspector({
  roomIdentifier: computed(() => props.room.identifier),
  reasoningSessions: reasoningSessionsRef,
  roomMessagesForAgentInsight,
});

const {
  renameBusy,
  renameError,
  githubStatus,
  githubLoading,
  githubBusy,
  githubError,
  renameRoom,
  refreshGitHubIntegration,
  installGitHubIntegration,
} = useDesktopRoomGitHub({
  room: roomRef,
  onRoomRenamed: (room) => emit("room-renamed", room),
  refreshRoom: () => emit("refresh-room"),
});

const githubRepository = computed(() =>
  githubStatus.value?.repository?.fullName
  || repoRepositoryFromRoomIdentifier(props.room.identifier)
  || eventsPage.value?.githubRoomIdentifier
  || null
);

const githubEventsAvailable = computed(() =>
  isRepoBackedRoom.value
  || Boolean(githubStatus.value?.connected)
  || Boolean(eventsPage.value?.events.length)
  || props.messages.some(shouldRefreshEventsForMessage)
);

const showEventsTab = computed(() => githubEventsVisible.value && githubEventsAvailable.value);
const roomManagedAgentSessions = computed(() =>
  managedAgentSessions.value.filter((session) =>
    managedAgentSessionMatchesRoom(session, props.room.identifier)
  )
);
const managedAgentRepoRootPath = computed(() => preferredManagedAgentRepoRootPath(props.repoStatus));
const roomParticipants = computed(() =>
  mergeDesktopManagedAgentParticipants(props.participants, roomManagedAgentSessions.value, props.room.identifier)
);
const roomPresence = computed(() =>
  mergeDesktopManagedAgentPresence(props.presence, roomManagedAgentSessions.value, props.room.identifier)
);
const localAgentWork = computed(() =>
  activeManagedAgentWorkIndicators(roomManagedAgentSessions.value, props.room.identifier)
);

watch(() => props.githubEvents, (nextPage) => {
  if (!nextPage) {
    if (!eventsPage.value || eventsPage.value.roomIdentifier !== props.room.identifier) {
      eventsPage.value = null;
    }
    return;
  }
  eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
}, { immediate: true });

watch(() => props.room.identifier, () => {
  eventsPage.value = props.githubEvents;
  managedAgentSessions.value = [];
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = null;
  boardSelectedTaskId.value = null;
  eventsError.value = null;
  eventsLoadedOlderWithoutMatches.value = false;
  githubEventsVisible.value = readGitHubEventsVisible(props.room.identifier);
  void refreshManagedAgentSessions();
  restartManagedAgentSessionsRefreshTimer();
}, { immediate: true });

watch(addAgentModalOpen, (open) => {
  if (open) {
    void refreshManagedAgentSessions();
  }
});

watch(() => props.openAddAgentRequested, (requested) => {
  if (!requested) return;
  addAgentModalOpen.value = true;
  emit("add-agent-open-request-consumed");
}, { immediate: true });

watch(showEventsTab, (visible) => {
  if (!visible && activeTab.value === "events") {
    activeTab.value = "chat";
  }
});

watch(isLocalRoom, (local) => {
  if (!local) return;
  if (["rooms", "rent"].includes(activeTab.value)) {
    activeTab.value = "chat";
  }
});

watch(activeTab, (tab) => {
  if (tab === "events" && showEventsTab.value && !eventsPage.value && !eventsLoading.value) {
    void refreshGitHubEvents().catch(() => undefined);
  }
});

watch(() => props.messages.at(-1)?.id || null, () => {
  const latestMessage = props.messages.at(-1);
  if (!showEventsTab.value) return;
  if (!latestMessage || !shouldRefreshEventsForMessage(latestMessage)) return;
  scheduleGitHubEventsRefresh(activeTab.value === "events" ? 250 : 900);
});

onBeforeUnmount(() => {
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
    githubEventsRefreshTimer = null;
  }
  stopManagedAgentSessionsRefreshTimer();
  unsubscribeManagedAgentSessionUpdate?.();
  unsubscribeManagedAgentSessionUpdate = null;
});

onMounted(() => {
  unsubscribeManagedAgentSessionUpdate = window.letagentsDesktop?.workers?.onManagedAgentSessionUpdate?.((session) => {
    if (!managedAgentSessionMatchesRoom(session, props.room.identifier)) {
      return;
    }
    upsertManagedAgentSession(session);
  }) || null;
});

function rememberChatScrollPosition(scrollTop: number): void {
  emit("chat-scroll-position", props.room.identifier, scrollTop);
}

watchRoomNotifications({
  visibleMessages,
  ownMessageIds,
  playRoomSound,
  showRoomNotification: (message) => showRoomNotification(message, props.room.displayName),
});

const tabs = computed<RoomTab[]>(() => [
  { id: "chat", label: "Chat", count: null },
  ...(showEventsTab.value ? [{
    id: "events" as const,
    label: "Events",
    count: null,
  }] : []),
  { id: "board", label: "Board", count: null },
  { id: "activity" as const, label: "Activity", count: null },
  ...(!isLocalRoom.value ? [
    { id: "rooms" as const, label: "Rooms", count: props.roomLoading ? null : props.focusRooms.length },
    { id: "rent" as const, label: "Rent an Agent", count: null },
  ] : []),
]);

function selectTab(tabId: RoomTabId): void {
  if (activeTab.value === tabId) return;
  if (tabId === "events" && !showEventsTab.value) return;
  if (isLocalRoom.value && ["rooms", "rent"].includes(tabId)) return;
  activeTab.value = tabId;
}

async function refreshGitHubEvents(): Promise<void> {
  if (!showEventsTab.value || !window.letagentsDesktop?.room?.getGitHubEvents) return;
  eventsLoading.value = true;
  eventsError.value = null;
  try {
    const nextPage = await window.letagentsDesktop.room.getGitHubEvents(props.room.identifier, { limit: 100 });
    eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
  } catch (error) {
    eventsError.value = error instanceof Error ? error.message : "GitHub events could not be loaded.";
  } finally {
    eventsLoading.value = false;
  }
}

async function loadOlderGitHubEvents(): Promise<void> {
  if (!showEventsTab.value || !window.letagentsDesktop?.room?.getGitHubEvents || eventsLoadingOlder.value) return;
  const after = eventsPage.value?.events.at(-1)?.id || null;
  if (!after) return;
  eventsLoadingOlder.value = true;
  eventsError.value = null;
  eventsLoadedOlderWithoutMatches.value = false;
  const beforeCount = eventsPage.value?.events.length || 0;
  try {
    const nextPage = await window.letagentsDesktop.room.getGitHubEvents(props.room.identifier, {
      limit: 100,
      after,
    });
    eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
    eventsLoadedOlderWithoutMatches.value = Boolean(nextPage.events.length && (eventsPage.value?.events.length || 0) === beforeCount);
  } catch (error) {
    eventsError.value = error instanceof Error ? error.message : "Older GitHub events could not be loaded.";
  } finally {
    eventsLoadingOlder.value = false;
  }
}

function openEventsForTask(taskId: string): void {
  if (!showEventsTab.value) return;
  eventsTaskFilterId.value = taskId;
  eventsSelectedEventId.value = null;
  activeTab.value = "events";
}

function openBoardTaskFromEvents(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  activeTab.value = "board";
}

async function openGitHubEventFromChat(url: string): Promise<void> {
  if (!showEventsTab.value) return;
  eventsTaskFilterId.value = null;
  activeTab.value = "events";
  const firstMatch = findEventByUrl(url);
  if (firstMatch) {
    eventsSelectedEventId.value = firstMatch.id;
    return;
  }
  await refreshGitHubEvents();
  eventsSelectedEventId.value = findEventByUrl(url)?.id || null;
}

function scheduleGitHubEventsRefresh(delayMs: number): void {
  if (!showEventsTab.value) return;
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
  }
  githubEventsRefreshTimer = window.setTimeout(() => {
    githubEventsRefreshTimer = null;
    void refreshGitHubEvents().catch(() => undefined);
  }, delayMs);
}

function toggleGitHubEventsVisible(): void {
  githubEventsVisible.value = !githubEventsVisible.value;
  rememberGitHubEventsVisible(props.room.identifier, githubEventsVisible.value);
  if (githubEventsVisible.value) return;
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = null;
  eventsLoadedOlderWithoutMatches.value = false;
  if (activeTab.value === "events") {
    activeTab.value = "chat";
  }
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
    githubEventsRefreshTimer = null;
  }
}

async function setRoomStorageMode(mode: DesktopRoomStorageState["overrideMode"]): Promise<void> {
  const bridge = window.letagentsDesktop?.chatStorage;
  if (!bridge?.setRoomMode || storageBusy.value) return;
  if (mode === "local" && !props.storage.localRoom) {
    await forkRoomToLocal();
    return;
  }
  storageBusy.value = true;
  try {
    await bridge.setRoomMode(props.room.identifier, mode);
    const snapshot = await window.letagentsDesktop?.room?.getSnapshot?.(props.room.identifier);
    emit("refresh-room", snapshot);
  } finally {
    storageBusy.value = false;
  }
}

async function forkRoomToLocal(): Promise<void> {
  const bridge = window.letagentsDesktop?.chatStorage;
  if (!bridge?.forkRoomToLocal || storageBusy.value) return;
  const confirmed = window.confirm(
    "Switch this room to Local on this device? Desktop will import the current chat and board into local storage, keep this same room visible, and keep new updates on this device until you publish.",
  );
  if (!confirmed) return;
  storageBusy.value = true;
  try {
    const result = await bridge.forkRoomToLocal(props.room.identifier);
    await window.letagentsDesktop?.room?.stopStream?.(props.room.identifier);
    actionPanelOpen.value = false;
    emit("refresh-room", result.snapshot);
  } finally {
    storageBusy.value = false;
  }
}

async function publishLocalRoom(): Promise<void> {
  const bridge = window.letagentsDesktop?.chatStorage;
  if (!bridge?.publishLocalRoom || storageBusy.value) return;
  storageBusy.value = true;
  try {
    await bridge.publishLocalRoom(props.room.identifier);
    const snapshot = await window.letagentsDesktop?.room?.getSnapshot?.(props.room.identifier);
    emit("refresh-room", snapshot);
  } finally {
    storageBusy.value = false;
  }
}

function shouldRefreshEventsForMessage(message: DesktopRoomMessage): boolean {
  const source = (message.source || "").toLowerCase();
  const sender = (message.sender || "").toLowerCase();
  return source === "github" || sender === "github";
}

function repoRepositoryFromRoomIdentifier(identifier: string): string | null {
  const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(identifier.trim());
  return match ? match[1] : null;
}

function findEventByUrl(url: string): NonNullable<DesktopGitHubEventsPage["events"][number]> | null {
  const exactUrl = normalizeExactGitHubUrl(url);
  if (!exactUrl) return null;
  const events = eventsPage.value?.events || [];
  const exactMatch = events.find((event) =>
    normalizeExactGitHubUrl(event.githubObjectUrl) === exactUrl
  );
  if (exactMatch) return exactMatch;

  const normalizedUrl = normalizeGitHubObjectUrl(url);
  if (!normalizedUrl) return null;
  return events.find((event) =>
    normalizeGitHubObjectUrl(event.githubObjectUrl) === normalizedUrl
  ) || null;
}

function normalizeExactGitHubUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "").toLowerCase();
}

function normalizeGitHubObjectUrl(url: string | null | undefined): string | null {
  const trimmed = normalizeExactGitHubUrl(url);
  if (!trimmed) return null;
  return trimmed.replace(/[#?].*$/, "");
}

function toggleSearchTool(): void {
  if (!searchOpen.value) {
    actionPanelOpen.value = false;
  }
  toggleSearchOpen();
}

function toggleActionPanel(): void {
  const nextOpen = !actionPanelOpen.value;
  actionPanelOpen.value = nextOpen;
  if (nextOpen) {
    closeSearch();
  }
}

function closeActionPanel(): void {
  actionPanelOpen.value = false;
}

function openRules(): void {
  rulesOpen.value = true;
  actionPanelOpen.value = false;
}

function openAddAgentModal(): void {
  addAgentModalOpen.value = true;
}

async function refreshManagedAgentSessions(): Promise<void> {
  if (!window.letagentsDesktop?.workers?.listManagedAgentSessions || !props.room.identifier) return;
  const roomIdentifier = props.room.identifier;
  try {
    const sessions = await window.letagentsDesktop.workers.listManagedAgentSessions(roomIdentifier);
    if (props.room.identifier !== roomIdentifier) return;
    managedAgentSessions.value = sessions;
  } catch {
    if (props.room.identifier === roomIdentifier) {
      managedAgentSessions.value = managedAgentSessions.value.filter((session) =>
        managedAgentSessionMatchesRoom(session, roomIdentifier)
      );
    }
  }
}

function replaceManagedAgentSessions(sessions: DesktopManagedAgentSession[]): void {
  const otherRoomSessions = managedAgentSessions.value.filter((session) =>
    !managedAgentSessionMatchesRoom(session, props.room.identifier)
  );
  managedAgentSessions.value = [...otherRoomSessions, ...sessions];
}

function upsertManagedAgentSession(session: DesktopManagedAgentSession): void {
  managedAgentSessions.value = [
    session,
    ...managedAgentSessions.value.filter((entry) => entry.id !== session.id),
  ];
}

function restartManagedAgentSessionsRefreshTimer(): void {
  stopManagedAgentSessionsRefreshTimer();
  if (!props.room.identifier || !window.letagentsDesktop?.workers?.listManagedAgentSessions) return;
  managedAgentSessionsRefreshTimer = window.setInterval(() => {
    void refreshManagedAgentSessions();
  }, 4_000);
}

function stopManagedAgentSessionsRefreshTimer(): void {
  if (managedAgentSessionsRefreshTimer !== null) {
    window.clearInterval(managedAgentSessionsRefreshTimer);
    managedAgentSessionsRefreshTimer = null;
  }
}

function openAgentDetail(target: AgentModalTarget): void {
  selectedAgentDetailTarget.value = target;
}

function openAddAgentModalFromDetail(): void {
  selectedAgentDetailTarget.value = null;
  addAgentModalOpen.value = true;
}

function openReasoningFromAgentDetail(sessionId: string): void {
  selectedAgentDetailTarget.value = null;
  openReasoningInspector(sessionId);
}

function openAgentRepoPicker(): void {
  addAgentModalOpen.value = false;
  emit("choose-repo");
}

async function copyRoomLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(roomUrl.value);
    roomLinkCopied.value = true;
    window.setTimeout(() => {
      roomLinkCopied.value = false;
    }, 1400);
  } catch {
    roomLinkCopied.value = false;
  }
}

function exportChat(): void {
  exportRoomChat(props.room, visibleMessages.value);
}
</script>
