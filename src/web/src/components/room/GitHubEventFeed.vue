<template>
  <div class="web-room-activity">
    <ActivityFeed :events="events" :room-identifier="roomIdentifier" :available="isAvailable" :has-more="hasMore" :error="errorMessage" :loading="isLoading" :loading-older="isLoading" @refresh="emit('refresh')" @load-older="emit('loadOlder')" @open-task="emit('openTask', $event)" />
  </div>
</template>
<script setup lang="ts">
import ActivityFeed from '../../../../../shared/ui/activity/ActivityFeed.vue'
import type { RoomGitHubEvent } from '@/composables/useRoom'
defineProps<{ events: readonly RoomGitHubEvent[]; roomIdentifier: string; repository?: string | null; isAvailable: boolean; hasMore?: boolean; errorMessage?: string | null; isLoading?: boolean }>()
const emit = defineEmits<{ refresh: []; loadOlder: []; openTask: [id: string] }>()
</script>
<style scoped>
.web-room-activity { height: 100%; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--bg, #0a0a0a); }

/* The shared feed uses a desktop dark palette; the web follows the selected theme. */
.web-room-activity :deep(.room-activity) {
  --activity-muted: var(--text-secondary);
  --activity-line: var(--border-strong);
  color: var(--text);
}
.web-room-activity :deep(:is(
  .activity-copy > strong, .activity-detail h3, .activity-review-copy strong,
  .activity-jobs a, .activity-jobs strong, .activity-empty h3
)) { color: var(--text); }
.web-room-activity :deep(:is(
  .activity-filters button, .activity-search svg, .activity-feed-heading,
  .activity-mark, .activity-meta, .activity-summary, .activity-row > time,
  .activity-caret, .activity-detail h3 small, .activity-reviews li > svg,
  .activity-review-copy > span, .activity-review-copy > small,
  .activity-review-state time, .activity-review-state small, .activity-ci select,
  .activity-run, .activity-run code, .activity-job-mark, .activity-jobs small,
  .activity-jobs li > span, .activity-jobs li > time, .activity-history li,
  .activity-history small, .activity-history time, .activity-detail-links,
  .activity-detail-note, .activity-footer, .activity-footer button, .activity-empty,
  [data-tone="muted"]
)) { color: var(--text-secondary); }
.web-room-activity :deep(.activity-quiet) { color: var(--text-secondary) !important; }
.web-room-activity :deep(.activity-search input::placeholder) { color: var(--text-secondary); }
.web-room-activity :deep(.activity-filters button[aria-pressed="true"]) {
  background: var(--accent-active);
  color: var(--text);
}
.web-room-activity :deep(.activity-search:focus-within input) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
}
.web-room-activity :deep(.activity-feed-heading button) {
  background: var(--blue-dim);
  color: var(--blue-text);
}
.web-room-activity :deep(.activity-ci option) {
  background: var(--bg-elevated);
  color: var(--text);
}
.web-room-activity :deep(:is(
  .activity-detail h3, .activity-reviews li, .activity-jobs li, .activity-history li
)) { border-color: var(--border-strong); }
.web-room-activity :deep(.activity-detail-scroll) { scrollbar-color: var(--scrollbar-thumb) transparent; }
.web-room-activity :deep([data-tone="purple"]) { color: var(--task-assigned); }
.web-room-activity :deep(:is([data-tone="red"], .activity-notice, .activity-jobs [data-state="Failed"] .activity-job-mark)) { color: var(--red-text); }
.web-room-activity :deep(:is([data-tone="blue"], .activity-jobs [data-state="Running"] .activity-job-mark)) { color: var(--blue-text); }
.web-room-activity :deep(:is([data-tone="green"], .activity-jobs [data-state="Passed"] .activity-job-mark)) { color: var(--green-text); }
.web-room-activity :deep(:is(button, a, input, select, .activity-detail-scroll):focus-visible) { outline-color: var(--blue-text); }
@media (hover: hover) and (pointer: fine) {
  .web-room-activity :deep(.activity-row:hover) { background: var(--bg-card); }
  .web-room-activity :deep(:is(.activity-filters button:hover, .activity-quiet:hover)) { background: var(--accent-hover); }
  .web-room-activity :deep(:is(.activity-detail-links a:hover, .activity-jobs a:hover, .activity-run a:hover)) { color: var(--text); }
  .web-room-activity :deep(.activity-feed-heading button:hover) { background: color-mix(in srgb, var(--blue-text) 18%, transparent); }
}
</style>
