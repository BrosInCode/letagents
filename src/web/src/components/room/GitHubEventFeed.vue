<template>
  <div class="event-feed-shell">
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
.event-feed-shell { height: 100%; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--bg, #0a0a0a); }
</style>
