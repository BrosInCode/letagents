<template>
  <article class="thinking-card" :data-phase="card.phase" :data-compact="compact ? 'true' : 'false'">
    <div class="thinking-card-header">
      <span v-if="kicker" class="thinking-card-kicker">{{ kicker }}</span>
      <span v-if="timestampLabel" class="thinking-card-timestamp">{{ timestampLabel }}</span>
      <span class="thinking-card-phase">{{ card.phaseLabel }}</span>
    </div>

    <p class="thinking-card-summary">{{ card.summary }}</p>

    <div v-if="visibleFields.length" class="thinking-card-fields">
      <div
        v-for="field in visibleFields"
        :key="`${field.key}-${field.value}`"
        class="thinking-card-field"
      >
        <span>{{ field.label }}</span>
        <strong>{{ field.value }}</strong>
      </div>
    </div>

    <ul v-if="visibleDetails.length" class="thinking-card-details">
      <li v-for="detail in visibleDetails" :key="detail">{{ detail }}</li>
    </ul>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentThinkingCardData } from './agentThinking'

const props = withDefaults(defineProps<{
  card: AgentThinkingCardData
  compact?: boolean
  kicker?: string | null
  timestampLabel?: string | null
}>(), {
  compact: false,
  kicker: null,
  timestampLabel: null,
})

const visibleFields = computed(() => props.card.fields.slice(0, props.compact ? 2 : 4))
const visibleDetails = computed(() => props.card.details.slice(0, props.compact ? 2 : 3))
</script>

<style scoped>
.thinking-card {
  --thinking-border: color-mix(in srgb, var(--line, #27272a) 84%, transparent);
  --thinking-surface: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  --thinking-surface-strong: color-mix(in srgb, var(--surface, #18181b) 96%, transparent);
  --thinking-text-muted: var(--muted, #a1a1aa);
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--thinking-border);
  background:
    radial-gradient(circle at top right, color-mix(in srgb, currentColor 12%, transparent), transparent 46%),
    var(--thinking-surface);
  color: var(--text, #fafafa);
}

.thinking-card[data-phase='working'] {
  color: #93c5fd;
}

.thinking-card[data-phase='reviewing'] {
  color: #fbbf24;
}

.thinking-card[data-phase='blocked'] {
  color: #fca5a5;
}

.thinking-card[data-phase='idle'] {
  color: #cbd5f5;
}

.thinking-card[data-phase='note'] {
  color: #a5b4fc;
}

.thinking-card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.thinking-card-kicker,
.thinking-card-timestamp {
  font-size: 0.68rem;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--thinking-text-muted);
}

.thinking-card-timestamp {
  margin-left: auto;
}

.thinking-card-phase {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  background: color-mix(in srgb, currentColor 14%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
}

.thinking-card[data-compact='true'] .thinking-card-timestamp,
.thinking-card[data-compact='true'] .thinking-card-phase {
  margin-left: 0;
}

.thinking-card-summary {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.45;
  color: var(--text, #fafafa);
}

.thinking-card-fields {
  display: grid;
  gap: 8px;
}

.thinking-card-field {
  display: grid;
  gap: 3px;
  padding: 10px;
  border-radius: 10px;
  background: var(--thinking-surface-strong);
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
}

.thinking-card-field span {
  font-size: 0.68rem;
  text-transform: uppercase;
  color: var(--thinking-text-muted);
}

.thinking-card-field strong {
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--text, #fafafa);
}

.thinking-card-details {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
  color: var(--thinking-text-muted);
  font-size: 0.78rem;
  line-height: 1.45;
}

.thinking-card[data-compact='true'] {
  gap: 8px;
  padding: 11px 12px;
}

.thinking-card[data-compact='true'] .thinking-card-summary {
  font-size: 0.86rem;
}

.thinking-card[data-compact='true'] .thinking-card-field {
  padding: 8px 10px;
}

.thinking-card[data-compact='true'] .thinking-card-details {
  font-size: 0.74rem;
}

@media (max-width: 768px) {
  .thinking-card {
    padding: 11px 12px;
    border-radius: 12px;
  }

  .thinking-card-summary {
    font-size: 0.88rem;
  }
}
</style>
