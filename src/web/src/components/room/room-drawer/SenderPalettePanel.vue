<template>
  <div class="drawer-section drawer-panel">
    <div class="drawer-section-title">
      <h2>Sender Palette</h2>
      <span>identity</span>
    </div>
    <div class="legend">
      <span
        v-for="s in visibleOwners"
        :key="s.label"
        class="legend-chip"
        :style="{ '--chip-color': s.color }"
        :title="s.label"
      >
        <span class="legend-chip-label">{{ s.label }}</span>
      </span>
      <span
        v-if="overflowCount > 0"
        class="legend-chip overflow-chip"
        :title="overflowNames"
      >+{{ overflowCount }} more</span>
      <span class="legend-chip" style="--chip-color: var(--muted, #71717a)" title="System messages">
        <span class="legend-chip-label">system</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DrawerOwnerChip } from './types'

defineProps<{
  overflowCount: number
  overflowNames: string
  visibleOwners: DrawerOwnerChip[]
}>()
</script>
