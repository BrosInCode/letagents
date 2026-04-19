<template>
  <span class="task-person-chip">
    <span class="task-person-copy">
      <span class="task-person-role">{{ role }}</span>
      <span class="task-person-name">{{ parsed.displayName }}</span>
      <span v-if="parsed.ownerAttribution && parsed.structured" class="task-person-subtitle">
        {{ parsed.ownerAttribution }}
      </span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { parseAgentIdentity } from '@/composables/useRoom'

const props = defineProps<{
  sender: string
  role: string
}>()

const parsed = computed(() => parseAgentIdentity(props.sender))
</script>

<style scoped>
.task-person-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 4px; border-radius: 6px;
  background: transparent; border: none;
}
.task-person-copy { display: flex; flex-direction: column; gap: 0; }
.task-person-role {
  font-size: 0.55rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--text-tertiary, #a1a1aa);
}
.task-person-name { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary, #d4d4d8); }
.task-person-subtitle { font-size: 0.6rem; color: var(--text-tertiary, #a1a1aa); }
</style>
