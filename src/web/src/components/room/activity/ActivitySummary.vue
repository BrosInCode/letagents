<template>
  <div class="activity-summary">
    <template v-if="activeView === 'live'">
      <article class="summary-card">
        <strong>{{ connectedAgentsCount }}</strong>
        <span>Connected agents</span>
      </article>
      <article class="summary-card">
        <strong>{{ workingAgentsCount }}</strong>
        <span>Work signals</span>
      </article>
      <article class="summary-card">
        <strong>{{ recentlyDisconnectedAgentsCount }}</strong>
        <span>Recently disconnected</span>
      </article>
      <article class="summary-card">
        <strong>{{ humansCount }}</strong>
        <span>Humans seen</span>
      </article>
      <article class="summary-card">
        <strong>{{ activeReasoningSessionsCount }}</strong>
        <span>Active reasoning</span>
      </article>
    </template>
    <template v-else>
      <article
        v-for="card in historyCards"
        :key="card.label"
        class="summary-card"
      >
        <strong>{{ card.value }}</strong>
        <span>{{ card.label }}</span>
      </article>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { ActivitySummaryCard, ActivityViewMode } from './types'

defineProps<{
  activeView: ActivityViewMode
  connectedAgentsCount: number
  workingAgentsCount: number
  recentlyDisconnectedAgentsCount: number
  humansCount: number
  activeReasoningSessionsCount: number
  historyCards: readonly ActivitySummaryCard[]
}>()
</script>
