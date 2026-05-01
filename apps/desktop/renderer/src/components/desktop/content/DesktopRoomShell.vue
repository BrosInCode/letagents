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
            @click="activeTab = tab.id"
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

    <RoomChatView
      v-if="activeTab === 'chat'"
      :messages="messages"
    />

    <RoomBoardView
      v-else-if="activeTab === 'board'"
      :tasks="tasks"
    />

    <RoomActivityTabView
      v-else-if="activeTab === 'activity'"
      :recent-activity="recentActivity"
      :participants="participants"
    />

    <RoomDetailsView
      v-else
      :focus-rooms="focusRooms"
      :tasks="tasks"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
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

const tabs = computed<Array<{ id: RoomTabId; label: string; count: number | null }>>(() => [
  { id: "chat", label: "Chat", count: props.messages.length },
  { id: "board", label: "Board", count: props.tasks.length },
  { id: "activity", label: "Activity", count: props.participants.length },
  { id: "rooms", label: "Rooms", count: props.focusRooms.length },
]);
</script>
