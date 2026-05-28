<template>
  <span class="ide-icon" :class="badgeClass" :title="label">
    <svg v-if="normalized === 'codex'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M6 6l2 2-2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="9.5" y1="10" x2="11" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <svg v-else-if="normalized === 'antigravity'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2L13 14H3L8 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
      <line x1="5.5" y1="10" x2="10.5" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
    <svg v-else-if="normalized === 'claude'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4" fill="none"/>
      <circle cx="8" cy="8" r="2" fill="currentColor"/>
    </svg>
    <svg v-else-if="normalized === 'cursor'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 3l8 5-8 5V3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
    </svg>
    <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/>
      <circle cx="8" cy="5.5" r="1" fill="currentColor"/>
      <line x1="8" y1="7.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
}>()

const normalized = computed(() => props.label.toLowerCase())
const badgeClass = computed(() => {
  const known = ['codex', 'antigravity', 'claude', 'cursor']
  return known.includes(normalized.value) ? `ide-${normalized.value}` : 'ide-default'
})
</script>

<style scoped>
.ide-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3px;
  transition: opacity 0.15s ease;
}
.ide-icon svg {
  width: 12px;
  height: 12px;
}
.ide-icon:hover { opacity: 0.8; }

.ide-icon.ide-codex { color: #22c55e; }
.ide-icon.ide-antigravity { color: #60a5fa; }
.ide-icon.ide-claude { color: #fb923c; }
.ide-icon.ide-cursor { color: #a855f7; }
.ide-icon.ide-default { color: var(--muted, #71717a); }
</style>
