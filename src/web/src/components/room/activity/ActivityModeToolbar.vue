<template>
  <div class="activity-toolbar-row">
    <div class="activity-view-switcher">
      <button
        class="activity-view-button"
        type="button"
        :data-active="activeView === 'live'"
        @click="activeView = 'live'"
      >
        Live
      </button>
      <button
        class="activity-view-button"
        type="button"
        :data-active="activeView === 'history'"
        @click="activeView = 'history'"
      >
        History
      </button>
    </div>

    <p v-if="activeView === 'live' && clearedLiveCount > 0" class="activity-toolbar-note">
      {{ clearedLiveCount }} cleared from the live roster.
    </p>
  </div>
</template>

<script setup lang="ts">
import type { ActivityViewMode } from './types'

defineProps<{
  clearedLiveCount: number
}>()

const activeView = defineModel<ActivityViewMode>('activeView', { required: true })
</script>
