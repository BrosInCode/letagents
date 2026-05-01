<template>
  <section class="surface-list" data-testid="room-recent-activity">
    <article class="surface-row single-line">
      <div>
        <p class="surface-title">Recent activity</p>
        <p class="surface-subtitle">The latest signals from people and agents in this room.</p>
      </div>
    </article>

    <article
      v-for="entry in entries"
      :key="entry.id"
      class="surface-row"
      :data-testid="`recent-activity-${entry.id}`"
    >
      <div>
        <p class="surface-title">{{ entry.participantDisplayName }}</p>
        <p class="surface-subtitle">
          {{ entry.currentTasks[0]?.title || entry.completedTasks[0]?.title || "Active in room" }}
        </p>
      </div>
      <div class="surface-meta">
        <span class="state-pill" :data-state="entry.activityState || 'offline'">
          {{ entry.activityState || "offline" }}
        </span>
        <code>{{ entry.lastRoomActivityAt }}</code>
      </div>
    </article>

    <article v-if="!entries.length" class="surface-row single-line" data-testid="recent-activity-empty">
      <p class="surface-title">No room activity yet.</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { DesktopActivityEntry } from "../../../../../electron/ipc-types";

defineProps<{
  entries: DesktopActivityEntry[];
}>();
</script>
