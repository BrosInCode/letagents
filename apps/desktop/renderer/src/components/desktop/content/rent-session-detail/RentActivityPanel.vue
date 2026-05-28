<template>
  <section>
    <p v-if="loading" class="rent-detail-empty">Loading activity...</p>
    <p v-else-if="activity.length === 0" class="rent-detail-empty">No activity yet.</p>
    <ol v-else class="rent-detail-events">
      <li
        v-for="event in activity"
        :key="event.id"
        :data-testid="`rent-detail-event-${event.id}`"
      >
        <div>
          <strong>{{ event.eventType }}</strong>
          <span class="rent-detail-event-meta">
            · {{ event.source }} · {{ event.visibility }}
            <span v-if="!event.verified" class="state-pill" data-state="failed">unverified</span>
          </span>
        </div>
        <time>{{ formatTime(event.createdAt) }}</time>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRentalActivityEvent } from "../../../../../../electron/ipc-types";
import { formatTime } from "./presentation";

defineProps<{
  activity: DesktopRentalActivityEvent[];
  loading: boolean;
}>();
</script>

<style scoped>
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-detail-events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rent-detail-events li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
}
.rent-detail-event-meta {
  opacity: 0.65;
  font-size: 0.8rem;
}
.rent-detail-events time {
  font-size: 0.8rem;
  opacity: 0.65;
}
</style>
