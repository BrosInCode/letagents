<template>
  <div class="composer-mention-panel" role="listbox" aria-label="Mention suggestions">
    <button
      v-for="(candidate, index) in candidates"
      :key="candidate.key"
      class="composer-mention-option"
      type="button"
      :data-active="index === activeIndex"
      :aria-selected="index === activeIndex"
      @mousedown.prevent="emit('select', candidate)"
    >
      <span class="composer-mention-copy">
        <strong>{{ candidate.label }}</strong>
        <span>{{ candidate.meta }}</span>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { MentionCandidate } from '../reachability'

defineProps<{
  candidates: readonly MentionCandidate[]
  activeIndex: number
}>()

const emit = defineEmits<{
  select: [candidate: MentionCandidate]
}>()
</script>

<style scoped>
.composer-mention-panel {
  display: grid;
  gap: 4px;
  padding: 0 8px 8px;
}
.composer-mention-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
  font-family: inherit;
}
.composer-mention-option[data-active="true"],
.composer-mention-option:hover {
  border-color: color-mix(in srgb, var(--line-strong, #3f3f46) 75%, #7dd3fc 25%);
  background: color-mix(in srgb, var(--surface, #18181b) 92%, #7dd3fc 8%);
}
.composer-mention-copy {
  display: grid;
  gap: 3px;
}
.composer-mention-copy strong {
  font-size: 0.8rem;
  color: var(--text, #fafafa);
}
.composer-mention-copy span {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
}

@media (max-width: 768px) {
  .composer-mention-panel { padding: 0 6px 6px; }
  .composer-mention-option { padding: 8px 10px; }
}
</style>
