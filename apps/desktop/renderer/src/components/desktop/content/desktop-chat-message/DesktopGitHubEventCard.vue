<template>
  <GitHubEventCard
    class="desktop-github-event"
    :event="event"
    :compact="compact"
    :history="history"
    :timestamp="timestamp"
    :room="room"
    :task-link-enabled="taskLinkEnabled"
    show-event-link
    @open-task="$emit('open-task', $event)"
    @open-event="$emit('open-event', $event)"
  >
    <template #actions>
      <PullRequestChangesButton v-if="event.kind === 'pull-request'" :url="event.url" />
    </template>
  </GitHubEventCard>
</template>

<script setup lang="ts">
import GitHubEventCard from "../../../../../../../../shared/ui/GitHubEventCard.vue";
import type { GitHubEventPresentation } from "./types";
import PullRequestChangesButton from "../room-events/PullRequestChangesButton.vue";

defineProps<{
  event: GitHubEventPresentation;
  taskLinkEnabled?: boolean;
  room?: boolean
  timestamp?: string
  history?: boolean
  compact?: boolean;
}>();

defineEmits<{
  "open-event": [url: string];
  "open-task": [taskId: string];
}>();
</script>

<style scoped>
.desktop-github-event.is-preview {
  --attachment-ink: var(--chat-foreground, var(--text));
  --attachment-status: var(--event-accent);
  grid-template-columns: 28px minmax(0, 1fr) auto;
  column-gap: 11px;
  row-gap: 4px;
  width: calc(100% + 2 * var(--bubble-padding-inline, 0px));
  max-width: none;
  margin: 12px calc(0px - var(--bubble-padding-inline, 0px)) 0;
  padding: 13px var(--bubble-padding-inline, 10px) 8px;
  border: 0;
  border-block-start: 1px solid color-mix(in srgb, var(--attachment-ink) 12%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--attachment-ink) 3%, transparent);
  color: var(--attachment-ink);
}
.desktop-github-event.is-preview + .desktop-github-event.is-preview { margin-block-start: 0; }
.desktop-github-event.is-preview:last-child {
  margin-block-end: calc(0px - var(--bubble-padding-bottom, 0px));
  border-radius: 0 0 var(--bubble-radius, 8px) var(--bubble-radius, 8px);
}
.desktop-github-event.is-preview[data-status="open"] { --attachment-status: var(--green-text); }
.desktop-github-event.is-preview[data-status="merged"] { --attachment-status: var(--task-assigned); }
.desktop-github-event.is-preview[data-status="closed"] { --attachment-status: var(--red-text); }
.desktop-github-event.is-preview[data-status="draft"] { --attachment-status: var(--text-secondary); }
.desktop-github-event.is-preview :deep(.github-event-header) { display: contents; }
.desktop-github-event.is-preview :deep(.github-event-icon) {
  grid-area: 1 / 1 / span 2;
  width: 28px;
  height: 28px;
  padding: 6px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--attachment-status) 12%, transparent);
  color: color-mix(in srgb, var(--attachment-status) 76%, var(--attachment-ink));
}
.desktop-github-event.is-preview :deep(.github-event-kind) { grid-area: 1 / 2; }
.desktop-github-event.is-preview :deep(:is(.github-event-kind, .github-event-context)) {
  color: color-mix(in srgb, var(--attachment-ink) 86%, transparent);
}
.desktop-github-event.is-preview :deep(.github-event-content),
.desktop-github-event.is-preview :deep(.github-event-context) {
  grid-column: 2 / -1;
}
.desktop-github-event.is-preview :deep(.github-event-title) {
  color: var(--attachment-ink);
  font-size: 13px;
  font-weight: 580;
  line-height: 1.4;
  text-wrap: pretty;
}
.desktop-github-event.is-preview :deep(.github-event-status) {
  grid-area: 1 / 3;
  padding: 0;
  background: transparent;
  color: color-mix(in srgb, var(--attachment-status) 76%, var(--attachment-ink));
}
.desktop-github-event.is-preview :deep(.github-event-actions) {
  grid-column: 2 / -1;
  gap: 6px;
  margin-inline-start: -6px;
  padding-top: 0;
  border-top: 0;
}
.desktop-github-event.is-preview :deep(.github-event-actions :is(.github-event-action, .pull-request-changes-button)) {
  padding-inline: 6px;
  font-weight: 500;
  color: var(--attachment-ink);
}
.desktop-github-event.is-preview :deep(.github-event-actions :is(.github-event-action, .pull-request-changes-button):not(:hover, :active)) {
  border-color: transparent;
  background: transparent;
}
</style>
