<template>
  <span class="room-typing-indicator" role="status" aria-live="polite" aria-atomic="true">{{ label }}</span>
</template>
<script setup lang="ts">
defineProps<{ label: string }>();
</script>
<style scoped>
.room-typing-indicator {
  position: absolute;
  top: 0;
  left: 18px;
  right: 18px;
  height: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none;
  color: var(--text-tertiary, var(--muted));
  font-size: 11px;
  line-height: 12px;
}
</style>
