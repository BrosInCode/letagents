<template>
  <div class="drawer-section drawer-panel">
    <div class="drawer-section-title">
      <h2>Room Notes</h2>
    </div>
    <div class="status-line">
      <span class="status-text">{{ statusText }}</span>
    </div>
    <div class="drawer-actions">
      <button @click="$emit('toggleSound')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        {{ soundEnabled ? 'Sounds On' : 'Sounds Off' }}
      </button>
      <button @click="$emit('exportChat')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  soundEnabled: boolean
  statusText: string
}>()

defineEmits<{
  exportChat: []
  toggleSound: []
}>()
</script>
