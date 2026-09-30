<template>
  <span v-if="label" class="sidebar-room-activity" :title="label">
    <svg class="sidebar-room-activity-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
    <span v-if="count > 1" class="sidebar-room-activity-count" aria-hidden="true">{{ count }}</span>
    <span class="sr-only">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { describeSidebarRoomActivity, type SidebarRoomActivity } from "../../../domain/sidebar-room-display";

const props = defineProps<{ activity: SidebarRoomActivity | null | undefined }>();

const label = computed(() => describeSidebarRoomActivity(props.activity));
const count = computed(() => props.activity?.working.length ?? 0);
</script>

<style scoped>
/* Work in progress: a slow quarter-arc. It sits in peripheral vision all
   day, so it turns slowly and in the text's own grey, never in a colour. */
.sidebar-room-activity {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  color: var(--text-secondary);
}

.sidebar-room-activity-ring {
  width: 13px;
  height: 13px;
  fill: none;
  stroke-width: 1.75;
  stroke-linecap: round;
  animation: sidebar-room-activity-turn 1.1s linear infinite;
}

.sidebar-room-activity-ring circle {
  stroke: color-mix(in srgb, currentColor 25%, transparent);
}

.sidebar-room-activity-ring path {
  stroke: currentColor;
}

.sidebar-room-activity-count {
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  line-height: 1;
}

@keyframes sidebar-room-activity-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-room-activity-ring {
    animation: none;
  }
}
</style>
