<template>
  <button
    class="thread-marker"
    type="button"
    :aria-label="actionLabel"
    :aria-expanded="expanded"
    :aria-controls="controls"
    @click="emit('toggle')"
  >
    <span class="thread-marker-label">{{ label }}</span>
    <svg class="thread-marker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  expanded?: boolean
  controls?: string
  label: string
  actionLabel: string
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<style scoped>
.thread-marker { display: flex; align-items: center; gap: 7px; margin-top: 12px; padding: 4px 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted, #a1a1aa); font: inherit; font-size: .75rem; cursor: pointer; }
.thread-marker::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--sender-color, #71717a); }
.thread-marker-chevron { display: block; flex: 0 0 14px; width: 14px; height: 14px; margin-left: 3px; }
.thread-marker[aria-expanded="true"] > .thread-marker-chevron { transform: rotate(180deg); }
.thread-marker:hover { color: var(--text, #fafafa); }
.thread-marker:focus-visible { outline: 2px solid #60a5fa; outline-offset: 4px; }
</style>
