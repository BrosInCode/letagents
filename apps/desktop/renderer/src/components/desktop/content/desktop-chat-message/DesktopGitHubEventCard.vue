<template>
  <GitHubEventCard
    class="desktop-github-event"
    :event="event"
    :compact="compact"
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
  compact?: boolean;
}>();

defineEmits<{
  "open-event": [url: string];
  "open-task": [taskId: string];
}>();
</script>
