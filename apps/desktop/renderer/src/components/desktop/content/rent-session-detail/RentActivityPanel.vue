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
