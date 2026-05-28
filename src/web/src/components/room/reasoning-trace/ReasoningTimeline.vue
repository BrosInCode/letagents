<template>
  <section class="reasoning-timeline-section">
    <div class="reasoning-section-header">
      <h3>Timeline</h3>
      <span>{{ entries.length }}</span>
    </div>

    <p v-if="loading" class="reasoning-empty">
      Loading the latest reasoning details...
    </p>

    <p v-else-if="entries.length === 0" class="reasoning-empty">
      No detailed reasoning updates have been exposed for this session yet.
    </p>

    <ol v-else class="reasoning-timeline">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="reasoning-entry"
        :data-current="entry.current"
        :data-updating="entry.current && recentlyUpdated"
      >
        <div class="reasoning-entry-meta">
          <span>{{ entryLabel(entry) }}</span>
          <time>{{ formatTimestamp(entry.timestamp) }}</time>
        </div>
        <p>{{ entry.text }}</p>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import {
  entryLabel,
  formatTimestamp,
  type ReasoningTimelineEntry,
} from './reasoningTrace'

defineProps<{
  entries: ReasoningTimelineEntry[]
  loading: boolean
  recentlyUpdated: boolean
}>()
</script>
