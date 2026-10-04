<template>
  <SharedGitHubEventCard
    :event="event"
    :compact="compact"
    :room="room"
    :task-link-enabled="taskLinkEnabled"
    @open-task="emit('openTask', $event)"
  />
</template>

<script setup lang="ts">
import SharedGitHubEventCard from '../../../../../shared/ui/GitHubEventCard.vue'
import type { GitHubEventPresentation } from './githubEventMessage'

defineProps<{
  event: GitHubEventPresentation
  taskLinkEnabled?: boolean
  room?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  openTask: [taskId: string]
}>()
</script>
