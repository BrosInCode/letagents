<template>
  <section class="desktop-room-shell" :data-liquid-glass="liquidGlassEnabled" data-testid="desktop-room-shell">
    <DesktopRoomHeader
      :sidebar-mode="sidebarMode"
      :room="room"
      :tabs="tabs"
      :active-tab="activeTab"
      :search-open="searchOpen"
      :action-panel-open="actionPanelOpen"
      @cycle-sidebar="emit('cycle-sidebar')"
      @toggle-search="toggleSearch"
      @toggle-action-panel="actionPanelOpen = !actionPanelOpen"
      @select-tab="selectTab"
    />

    <DesktopRoomControlRail
      v-model:search-query="searchQuery"
      :action-panel-open="actionPanelOpen"
      :search-open="searchOpen"
      :room="room"
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
      :search-summary="searchSummary"
      :search-results-count="searchResults.length"
      @copy-room-link="copyRoomLink"
      @open-rules="openRules"
      @toggle-sound="toggleSound"
      @toggle-notifications="toggleNotifications"
      @toggle-liquid-glass="toggleLiquidGlass"
      @rename-room="renameRoom"
      @refresh-github="refreshGitHubIntegration"
      @install-github="installGitHubIntegration"
      @export-chat="exportChat"
      @move-search="moveSearch"
      @close-search="closeSearch"
    />

    <Transition name="room-panel" mode="out-in">
      <RoomChatView
        v-if="activeTab === 'chat'"
        key="chat"
        :messages="visibleMessages"
        :room-identifier="room.identifier"
        :sending="sendingMessage"
        :send-error="sendError"
        :has-older-messages="hasOlderMessages"
        :loading-older-messages="loadingOlderMessages"
        :participants="participants"
        :presence="presence"
        :reasoning-sessions="reasoningSessions"
        :tasks="tasks"
        :search-query="searchQuery"
        :active-search-message-id="activeSearchMessageId"
        :initial-scroll-top="chatScrollTop"
        :initial-draft="chatDraftText"
        @send-message="sendRoomMessage"
        @discard-attachment="discardAttachment"
        @load-older="loadOlderMessages"
        @open-reasoning="openReasoningInspector"
        @open-agent-reasoning-fallback="openAgentReasoningFallback"
        @scroll-position="chatScrollTop = $event"
        @draft-change="chatDraftText = $event"
      />

      <RoomBoardView
        v-else-if="activeTab === 'board'"
        key="board"
        :room-identifier="room.identifier"
        :tasks="tasks"
        :presence="presence"
        :workers="workers"
        @task-updated="emit('task-updated', $event)"
        @refresh-room="emit('refresh-room')"
      />

      <RoomActivityTabView
        v-else-if="activeTab === 'activity'"
        key="activity"
        :recent-activity="recentActivity"
        :participants="participants"
        :live-cleared-count="participantHiddenCount"
        :presence="presence"
        :reasoning-sessions="reasoningSessions"
        :tasks="tasks"
        :messages="visibleMessages"
        :workers="workers"
        @open-reasoning="openReasoningInspector"
      />

      <RoomDetailsView
        v-else-if="activeTab === 'rooms'"
        key="rooms"
        :focus-rooms="focusRooms"
        :tasks="tasks"
      />

      <RentAnAgentView
        v-else
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
  </section>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopFocusRoomInfo,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopReasoningSession,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import type { SidebarMode } from "../types";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import RentAnAgentView from "./RentAnAgentView.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import RoomChatView from "./RoomChatView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import { encodeRoomPathIdentifier } from "./room-shell/messages";
import { exportRoomChat } from "./room-shell/roomExport";
import type { RoomTab, RoomTabId } from "./room-shell/types";
import { useDesktopReasoningInspector } from "./room-shell/useDesktopReasoningInspector";
import { useDesktopRoomGitHub } from "./room-shell/useDesktopRoomGitHub";
import { useDesktopRoomMessages } from "./room-shell/useDesktopRoomMessages";
import {
  useDesktopRoomPreferences,
  watchRoomNotifications,
} from "./room-shell/useDesktopRoomPreferences";
import { useDesktopRoomSearch } from "./room-shell/useDesktopRoomSearch";

const props = defineProps<{
  sidebarMode: SidebarMode;
  room: DesktopRoomInfo;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "cycle-sidebar": [];
  "message-sent": [message: DesktopRoomMessage];
  "room-renamed": [room: DesktopRoomInfo];
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
}>();

const roomRef = toRef(props, "room");
const messagesRef = toRef(props, "messages");
const reasoningSessionsRef = toRef(props, "reasoningSessions");
const activeTab = ref<RoomTabId>("chat");
const actionPanelOpen = ref(false);
const rulesOpen = ref(false);
const roomLinkCopied = ref(false);
const visibleParticipantCount = computed(() =>
  props.participants.filter((participant) => !participant.hiddenAt).length
);
const roomUrl = computed(() => `https://letagents.chat/in/${encodeRoomPathIdentifier(props.room.identifier)}`);

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
  chatScrollTop,
  chatDraftText,
  ownMessageIds,
  visibleMessages,
  roomMessagesForAgentInsight,
  sendRoomMessage,
  discardAttachment,
  loadOlderMessages,
} = useDesktopRoomMessages({
  room: roomRef,
  messages: messagesRef,
  playRoomSound,
  onMessageSent: (message) => emit("message-sent", message),
});

const {
  searchOpen,
  searchQuery,
  searchResults,
  activeSearchMessageId,
  searchSummary,
  toggleSearch,
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

watchRoomNotifications({
  visibleMessages,
  ownMessageIds,
  playRoomSound,
  showRoomNotification: (message) => showRoomNotification(message, props.room.displayName),
});

const tabs = computed<RoomTab[]>(() => [
  { id: "chat", label: "Chat", count: visibleMessages.value.length },
  { id: "board", label: "Board", count: props.tasks.length },
  { id: "activity", label: "Activity", count: visibleParticipantCount.value + props.participantHiddenCount },
  { id: "rooms", label: "Rooms", count: props.focusRooms.length },
  { id: "rent", label: "Rent an Agent", count: null },
]);

function selectTab(tabId: RoomTabId): void {
  activeTab.value = tabId;
  emit("refresh-room");
}

function openRules(): void {
  rulesOpen.value = true;
  actionPanelOpen.value = false;
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
