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
      ref="roomChatView"
      v-show="activeTab === 'chat'"
      :active="activeTab === 'chat'"
      :messages="timelineMessages"
      :thread-messages="visibleMessages"
      :message-namespace="messageNamespace"
      :has-filtered-room-activity="hasFilteredRoomActivity"
      :room-identifier="room.identifier"
      :github-events-visible="githubEventsVisible"
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
      @thread-read="handleThreadRead"
    />

    <Transition name="room-panel" mode="out-in">
      <RoomInboxView
        v-if="activeTab === 'inbox'"
        key="inbox"
        v-model:filter="inboxFilter"
        :items="inboxItems"
        :loading="inboxLoading"
        :loading-older="inboxLoadingOlder"
        :error="inboxError"
        :has-more="inboxHasMore"
        :last-cleared-item="lastClearedInboxItem"
        @refresh="loadInboxThreads"
        @load-older="loadOlderInboxThreads"
        @open-thread="openInboxThread"
        @clear-item="clearInboxItem"
        @restore-item="restoreInboxItem"
        @open-task="openInboxTask"
        @open-github-event="openInboxGitHubEvent"
        @open-reasoning="openReasoningInspector"
      />

      <RoomBoardView
        v-else-if="activeTab === 'board'"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
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
  DesktopRoomThreadInboxPage,
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
import RoomInboxView from "./RoomInboxView.vue";
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
import {
  buildDesktopInboxItems,
  desktopInboxItemFingerprint,
  type DesktopInboxFilter,
  type DesktopInboxItem,
} from "./room-inbox/items";
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
const activeTab = ref<RoomTabId>(readRoomActiveTab(props.room.identifier));
const roomChatView = ref<InstanceType<typeof RoomChatView> | null>(null);
const actionPanelOpen = ref(false);
const addAgentModalOpen = ref(false);
const selectedAgentDetailTarget = ref<AgentModalTarget | null>(null);
const rulesOpen = ref(false);
const roomLinkCopied = ref(false);
const inboxFilter = ref<DesktopInboxFilter>("actionable");
const threadInboxPage = ref<DesktopRoomThreadInboxPage | null>(null);
const inboxLoading = ref(false);
const inboxLoadingOlder = ref(false);
const inboxError = ref<string | null>(null);
const inboxLoadedKey = ref<string | null>(null);
const inboxDismissals = ref<Record<string, string>>({});
const lastClearedInboxItem = ref<DesktopInboxItem | null>(null);
const inboxSeenFingerprints = ref<string[]>([]);
const inboxUnseenCount = ref(0);
const inboxSeenInitialized = ref(false);
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
let inboxRefreshTimer: number | null = null;
let inboxUndoTimer: number | null = null;
let managedAgentSessionsRefreshTimer: number | null = null;
let unsubscribeManagedAgentSessionUpdate: (() => void) | null = null;
let inboxReloadAfterCurrentLoad = false;
let inboxThreadBaselinePending = false;
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
inboxDismissals.value = readInboxDismissals(messageNamespace.value);

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
const rawInboxItems = computed(() =>
  buildDesktopInboxItems({
    filter: inboxFilter.value,
    threadPage: threadInboxPage.value,
    tasks: props.tasks,
    githubEvents: eventsPage.value?.events || [],
    reasoningSessions: props.reasoningSessions,
    fallbackRepository: githubRepository.value,
  })
);
const inboxItems = computed(() =>
  rawInboxItems.value.filter((item) => !isInboxItemDismissed(item))
);
const inboxActionableCount = computed(() =>
  inboxItems.value.filter((item) => item.actionable).length
);
const inboxActionableFingerprints = computed(() =>
  inboxItems.value
    .filter((item) => item.actionable)
    .map(desktopInboxItemFingerprint)
);
const inboxHasMore = computed(() => Boolean(threadInboxPage.value?.hasMore));

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
  activeTab.value = readRoomActiveTab(props.room.identifier);
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

watch(messageNamespace, () => {
  inboxDismissals.value = readInboxDismissals(messageNamespace.value);
  clearInboxUndoState();
  const hasSeenState = hydrateInboxIndicatorState(messageNamespace.value);
  resetInboxState();
  inboxThreadBaselinePending = !hasSeenState;
  if (inboxThreadBaselinePending) {
    acknowledgeInboxItems();
  }
  void loadInboxThreads({ baselineIndicator: inboxThreadBaselinePending }).catch(() => undefined);
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

watch(() => [showEventsTab.value, props.roomLoading] as const, ([visible, loading]) => {
  if (!visible && !loading && activeTab.value === "events") {
    activeTab.value = "chat";
  }
}, { immediate: true });

watch(isLocalRoom, (local) => {
  if (!local) return;
  if (["rooms", "rent"].includes(activeTab.value)) {
    activeTab.value = "chat";
  }
}, { immediate: true });

watch(activeTab, (tab) => {
  rememberRoomActiveTab(props.room.identifier, tab);
  if (tab === "events" && showEventsTab.value && !eventsPage.value && !eventsLoading.value) {
    void refreshGitHubEvents().catch(() => undefined);
  }
  if (tab === "inbox" && inboxLoadedKey.value !== currentInboxLoadKey() && !inboxLoading.value) {
    void loadInboxThreads().catch(() => undefined);
  }
  if (tab === "inbox") {
    acknowledgeInboxItems();
  }
}, { flush: "sync" });

watch(inboxFilter, () => {
  resetInboxState();
  void loadInboxThreads({ baselineIndicator: !inboxSeenInitialized.value }).catch(() => undefined);
});

watch(inboxActionableFingerprints, (fingerprints) => {
  if (activeTab.value === "inbox") {
    acknowledgeInboxItems(fingerprints);
    return;
  }
  if (!inboxSeenInitialized.value) {
    inboxUnseenCount.value = 0;
    return;
  }

  const seen = new Set(inboxSeenFingerprints.value);
  inboxUnseenCount.value = fingerprints.filter((fingerprint) => !seen.has(fingerprint)).length;
}, { immediate: true });

watch(() => props.messages.at(-1)?.id || null, () => {
  const latestMessage = props.messages.at(-1);
  if (!latestMessage) return;
  if (isThreadReplyMessage(latestMessage)) {
    scheduleInboxRefresh(activeTab.value === "inbox" ? 200 : 700);
  }
  if (!showEventsTab.value || !shouldRefreshEventsForMessage(latestMessage)) return;
  scheduleGitHubEventsRefresh(activeTab.value === "events" ? 250 : 900);
});

onBeforeUnmount(() => {
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
    githubEventsRefreshTimer = null;
  }
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = null;
  }
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
    inboxUndoTimer = null;
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
  {
    id: "inbox",
    label: "Inbox",
    count: inboxActionableCount.value || null,
    indicator: inboxUnseenCount.value > 0 && activeTab.value !== "inbox"
      ? {
          label: inboxUnseenCount.value === 1 ? "New inbox item" : "New inbox items",
          count: inboxUnseenCount.value,
          tone: "info",
          pulse: true,
          mode: "dot",
        }
      : null,
  },
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

function roomActiveTabStorageKey(roomIdentifier: string): string {
  return `letagents-desktop:room-active-tab:${roomIdentifier}`;
}

function isRoomTabId(value: string | null): value is RoomTabId {
  return (
    value === "chat"
    || value === "inbox"
    || value === "events"
    || value === "board"
    || value === "activity"
    || value === "rooms"
    || value === "rent"
  );
}

function readRoomActiveTab(roomIdentifier: string): RoomTabId {
  try {
    const stored = window.localStorage.getItem(roomActiveTabStorageKey(roomIdentifier));
    return isRoomTabId(stored) ? stored : "chat";
  } catch {
    return "chat";
  }
}

function rememberRoomActiveTab(roomIdentifier: string, tab: RoomTabId): void {
  try {
    window.localStorage.setItem(roomActiveTabStorageKey(roomIdentifier), tab);
  } catch {
    // Tab memory is only a convenience; navigation should still work when storage is blocked.
  }
}

function currentInboxLoadKey(): string {
  return `${messageNamespace.value}:${inboxFilter.value}`;
}

function resetInboxIndicatorState(): void {
  inboxSeenFingerprints.value = [];
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = false;
}

function acknowledgeInboxItems(fingerprints = inboxActionableFingerprints.value): void {
  inboxSeenFingerprints.value = [...new Set(fingerprints)];
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = true;
  writeInboxSeenFingerprints(messageNamespace.value, inboxSeenFingerprints.value);
}

function inboxSeenStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-seen:${namespace}`;
}

function hydrateInboxIndicatorState(namespace: string): boolean {
  const fingerprints = readInboxSeenFingerprints(namespace);
  if (fingerprints === null) {
    resetInboxIndicatorState();
    return false;
  }
  inboxSeenFingerprints.value = fingerprints;
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = true;
  return true;
}

function readInboxSeenFingerprints(namespace: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(inboxSeenStorageKey(namespace));
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    return [...new Set(parsed)];
  } catch {
    return null;
  }
}

function writeInboxSeenFingerprints(namespace: string, fingerprints: string[]): void {
  try {
    window.localStorage.setItem(inboxSeenStorageKey(namespace), JSON.stringify(fingerprints));
  } catch {
    // The indicator can fall back to the in-memory baseline when storage is unavailable.
  }
}

function inboxDismissalsStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-dismissals:${namespace}`;
}

function readInboxDismissals(namespace: string): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(inboxDismissalsStorageKey(namespace)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function writeInboxDismissals(namespace: string, dismissals: Record<string, string>): void {
  try {
    window.localStorage.setItem(inboxDismissalsStorageKey(namespace), JSON.stringify(dismissals));
  } catch {
    // Clearing the current view should still work even when storage is unavailable.
  }
}

function resetInboxState(): void {
  threadInboxPage.value = null;
  inboxLoading.value = false;
  inboxLoadingOlder.value = false;
  inboxError.value = null;
  inboxLoadedKey.value = null;
  inboxReloadAfterCurrentLoad = false;
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = null;
  }
}

async function loadInboxThreads(options: { append?: boolean; baselineIndicator?: boolean } = {}): Promise<void> {
  const roomApi = window.letagentsDesktop?.room;
  const requestKey = currentInboxLoadKey();
  const append = Boolean(options.append);
  const shouldBaselineIndicator = !append && (options.baselineIndicator || inboxThreadBaselinePending);
  if (!roomApi?.getThreads) {
    threadInboxPage.value = { threads: [], hasMore: false, unreadThreadCount: 0 };
    inboxLoadedKey.value = requestKey;
    if (shouldBaselineIndicator) {
      acknowledgeInboxItems();
      inboxThreadBaselinePending = false;
    }
    return;
  }
  if (append) {
    if (inboxLoadingOlder.value || !threadInboxPage.value?.hasMore) return;
  } else if (inboxLoading.value) {
    inboxReloadAfterCurrentLoad = true;
    return;
  }

  const before = append
    ? threadInboxPage.value?.threads.at(-1)?.summary.latestReply?.id || null
    : null;
  if (append && !before) return;
  if (append) {
    inboxLoadingOlder.value = true;
  } else {
    inboxLoading.value = true;
  }
  inboxError.value = null;

  try {
    const page = await roomApi.getThreads(
      props.room.identifier,
      inboxFilter.value === "actionable" ? "unread" : "all",
      before,
      75,
    );
    if (currentInboxLoadKey() !== requestKey) return;
    threadInboxPage.value = append && threadInboxPage.value
      ? mergeThreadInboxPages(threadInboxPage.value, page)
      : page;
    inboxLoadedKey.value = requestKey;
    if (shouldBaselineIndicator) {
      acknowledgeInboxItems();
      inboxThreadBaselinePending = false;
    }
  } catch (error) {
    if (currentInboxLoadKey() === requestKey) {
      inboxError.value = error instanceof Error ? error.message : "Inbox could not be loaded.";
    }
  } finally {
    const shouldReload = !append && inboxReloadAfterCurrentLoad && currentInboxLoadKey() === requestKey;
    if (currentInboxLoadKey() === requestKey) {
      inboxLoading.value = false;
      inboxLoadingOlder.value = false;
    }
    if (shouldReload) {
      inboxReloadAfterCurrentLoad = false;
      void loadInboxThreads().catch(() => undefined);
    }
  }
}

function loadOlderInboxThreads(): void {
  void loadInboxThreads({ append: true });
}

function mergeThreadInboxPages(
  current: DesktopRoomThreadInboxPage,
  next: DesktopRoomThreadInboxPage,
): DesktopRoomThreadInboxPage {
  const threadsByRoot = new Map(current.threads.map((item) => [item.root.id, item]));
  for (const item of next.threads) {
    threadsByRoot.set(item.root.id, item);
  }
  return {
    threads: [...threadsByRoot.values()],
    hasMore: next.hasMore,
    unreadThreadCount: next.unreadThreadCount,
  };
}

async function openInboxThread(item: Extract<DesktopInboxItem, { kind: "thread" }>): Promise<void> {
  activeTab.value = "chat";
  await nextTick();
  roomChatView.value?.openThread(item.root.id);
}

function clearInboxItem(item: DesktopInboxItem): void {
  dismissInboxItem(item);
  showInboxUndo(item);
}

function dismissInboxItem(item: DesktopInboxItem): void {
  const nextDismissals = {
    ...inboxDismissals.value,
    [item.id]: desktopInboxItemFingerprint(item),
  };
  inboxDismissals.value = nextDismissals;
  writeInboxDismissals(messageNamespace.value, nextDismissals);
}

function restoreInboxItem(item: DesktopInboxItem): void {
  const nextDismissals = { ...inboxDismissals.value };
  delete nextDismissals[item.id];
  inboxDismissals.value = nextDismissals;
  writeInboxDismissals(messageNamespace.value, nextDismissals);
  clearInboxUndoState();
}

function showInboxUndo(item: DesktopInboxItem): void {
  lastClearedInboxItem.value = item;
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
  }
  inboxUndoTimer = window.setTimeout(() => {
    clearInboxUndoState();
  }, 8_000);
}

function clearInboxUndoState(): void {
  lastClearedInboxItem.value = null;
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
    inboxUndoTimer = null;
  }
}

function isInboxItemDismissed(item: DesktopInboxItem): boolean {
  return inboxDismissals.value[item.id] === desktopInboxItemFingerprint(item);
}

function handleThreadRead(threadRootId: string, summary: DesktopRoomThreadInboxPage["threads"][number]["summary"]): void {
  const page = threadInboxPage.value;
  if (!page) return;
  const previous = page.threads.find((item) => item.root.id === threadRootId);
  if (!previous) return;
  const previousUnread = previous.summary.unreadCount > 0 ? 1 : 0;
  const nextUnread = summary.unreadCount > 0 ? 1 : 0;
  threadInboxPage.value = {
    ...page,
    unreadThreadCount: Math.max(0, page.unreadThreadCount - previousUnread + nextUnread),
    threads: page.threads.map((item) =>
      item.root.id === threadRootId
        ? { ...item, root: { ...item.root, thread: summary }, summary }
        : item
    ),
  };
}

function openInboxTask(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  activeTab.value = "board";
}

function openInboxGitHubEvent(eventId: string): void {
  githubEventsVisible.value = true;
  rememberGitHubEventsVisible(props.room.identifier, true);
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = eventId;
  activeTab.value = "events";
}

function scheduleInboxRefresh(delayMs: number): void {
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
  }
  inboxRefreshTimer = window.setTimeout(() => {
    inboxRefreshTimer = null;
    void loadInboxThreads().catch(() => undefined);
  }, delayMs);
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

function isThreadReplyMessage(message: DesktopRoomMessage): boolean {
  return Boolean(message.threadReplyToId || (message.threadRootId && message.threadRootId !== message.id));
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
