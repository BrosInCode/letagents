<template>
  <section class="desktop-room-shell" data-testid="desktop-room-shell">
    <header class="desktop-room-header" data-testid="desktop-room-header">
      <div class="desktop-room-heading">
        <h3>{{ room.displayName }}</h3>
        <p class="desktop-room-subtitle">
          {{ room.kind === "focus" ? "A focused thread linked back to the main room." : "The main place for conversation, tasks, and coordination." }}
        </p>
      </div>

      <div class="desktop-room-header-actions">
        <nav class="desktop-room-tabs" role="tablist" aria-label="Room navigation" data-testid="desktop-room-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="desktop-room-tab"
            :data-active="activeTab === tab.id"
            :data-testid="`desktop-room-tab-${tab.id}`"
            role="tab"
            :aria-selected="activeTab === tab.id"
            type="button"
            @click="selectTab(tab.id)"
          >
            <span>{{ tab.label }}</span>
            <small v-if="tab.count !== null">{{ tab.count }}</small>
          </button>
        </nav>

        <div class="desktop-room-badges">
          <span v-if="room.code" class="desktop-room-badge" data-testid="desktop-room-code">{{ room.code }}</span>
          <span class="desktop-room-badge" data-testid="desktop-room-role">{{ room.role }}</span>
        </div>
      </div>
    </header>

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
        @send-message="sendRoomMessage"
        @discard-attachment="discardAttachment"
        @load-older="loadOlderMessages"
      />

      <RoomBoardView
        v-else-if="activeTab === 'board'"
        key="board"
        :tasks="tasks"
      />

      <RoomActivityTabView
        v-else-if="activeTab === 'activity'"
        key="activity"
        :recent-activity="recentActivity"
        :participants="participants"
      />

      <RoomDetailsView
        v-else
        key="rooms"
        :focus-rooms="focusRooms"
        :tasks="tasks"
      />
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type {
  DesktopActivityEntry,
  DesktopFocusRoomInfo,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import RoomChatView from "./RoomChatView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";

type RoomTabId = "chat" | "board" | "activity" | "rooms";

const props = defineProps<{
  room: DesktopRoomInfo;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}>();

const activeTab = ref<RoomTabId>("chat");
const sendingMessage = ref(false);
const sendError = ref<string | null>(null);
const olderMessages = ref<DesktopRoomMessage[]>([]);
const hasOlderMessages = ref(true);
const loadingOlderMessages = ref(false);
let refreshInterval: number | null = null;

const emit = defineEmits<{
  "message-sent": [];
  "refresh-room": [];
}>();

const tabs = computed<Array<{ id: RoomTabId; label: string; count: number | null }>>(() => [
  { id: "chat", label: "Chat", count: props.messages.length },
  { id: "board", label: "Board", count: props.tasks.length },
  { id: "activity", label: "Activity", count: props.participants.length },
  { id: "rooms", label: "Rooms", count: props.focusRooms.length },
]);
const visibleMessages = computed(() => {
  const seen = new Set<string>();
  return [...olderMessages.value, ...props.messages].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
});

function selectTab(tabId: RoomTabId): void {
  activeTab.value = tabId;
  emit("refresh-room");
}

onMounted(() => {
  refreshInterval = window.setInterval(() => {
    emit("refresh-room");
  }, 10_000);
});

onUnmounted(() => {
  if (refreshInterval) {
    window.clearInterval(refreshInterval);
    refreshInterval = null;
  }
});

async function sendRoomMessage(text: string, replyTo: string | null = null, attachments: Array<{ upload_id: string }> = []): Promise<void> {
  const trimmedText = text.trim();
  if (!trimmedText && attachments.length === 0) return;

  sendingMessage.value = true;
  sendError.value = null;
  try {
    await window.letagentsDesktop.room.sendMessage(props.room.identifier, trimmedText, replyTo, attachments);
    emit("message-sent");
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : "Message could not be sent.";
  } finally {
    sendingMessage.value = false;
  }
}

async function discardAttachment(uploadId: string): Promise<void> {
  await window.letagentsDesktop.room.discardAttachment(props.room.identifier, uploadId);
}

async function loadOlderMessages(): Promise<void> {
  if (loadingOlderMessages.value || !hasOlderMessages.value) return;
  const firstMessageId = visibleMessages.value[0]?.id;
  if (!firstMessageId) {
    hasOlderMessages.value = false;
    return;
  }

  loadingOlderMessages.value = true;
  try {
    const page = await window.letagentsDesktop.room.getMessagesBefore(props.room.identifier, firstMessageId, 24);
    olderMessages.value = [...page.messages, ...olderMessages.value];
    hasOlderMessages.value = page.hasOlder;
  } catch {
    hasOlderMessages.value = false;
  } finally {
    loadingOlderMessages.value = false;
  }
}
</script>
