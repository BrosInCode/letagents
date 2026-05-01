<template>
  <section class="room-tab-page room-activity-page" data-testid="room-activity-tab-view">
    <div class="room-activity-grid">
      <RoomRecentActivity :entries="recentActivity" />
      <AgentsView :participants="participants" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DesktopActivityEntry, DesktopParticipantSummary } from "../../../../../electron/ipc-types";
import AgentsView from "./AgentsView.vue";
import RoomRecentActivity from "./RoomRecentActivity.vue";

defineProps<{
  recentActivity: DesktopActivityEntry[];
  participants: DesktopParticipantSummary[];
}>();
</script>
