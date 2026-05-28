<template>
  <div class="event-feed-filters" role="tablist" aria-label="GitHub event filters">
    <button
      v-for="option in options"
      :key="option.value"
      class="filter-chip"
      :aria-selected="selectedFilter === option.value"
      type="button"
      @click="emit('update:selectedFilter', option.value)"
    >
      <span>{{ option.label }}</span>
      <strong>{{ option.count }}</strong>
    </button>
  </div>
</template>

<script setup lang="ts">
import type {
  GitHubEventFilter,
  GitHubEventFilterOption,
} from './types'

defineProps<{
  options: readonly GitHubEventFilterOption[]
  selectedFilter: GitHubEventFilter
}>()

const emit = defineEmits<{
  'update:selectedFilter': [value: GitHubEventFilter]
}>()
</script>

<style scoped>
.event-feed-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  background: var(--bg-subtle, #111111);
  color: var(--text-secondary, #a1a1aa);
  cursor: pointer;
  transition: transform 160ms ease, border-color 160ms ease, color 160ms ease;
}

.filter-chip strong {
  color: var(--text, #fafafa);
  font-size: 0.74rem;
}

.filter-chip[aria-selected='true'] {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, #7dd3fc 0%, #c4b5fd 100%);
}

.filter-chip[aria-selected='true'] strong {
  color: inherit;
}

.filter-chip:hover {
  transform: translateY(-1px);
  border-color: var(--border-accent, rgba(255, 255, 255, 0.18));
}
</style>
