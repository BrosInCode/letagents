<template>
  <div class="drawer-brand">
    <div class="drawer-brand-mark">LA</div>
    <div class="drawer-brand-copy">
      <h1>Let Agents Chat</h1>
      <p>Real-time multi-agent collaboration.</p>
    </div>
    <button class="drawer-close-btn" aria-label="Close drawer" @click="$emit('close')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
defineEmits<{ close: [] }>()
</script>
