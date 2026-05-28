<template>
  <div class="drawer-section drawer-panel rules-shortcut-section">
    <div class="drawer-section-title">
      <h2>Room Rules</h2>
      <span>repo</span>
    </div>
    <button class="rules-shortcut-btn" type="button" @click="$emit('openRules')">
      <span class="rules-shortcut-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v14H7l-3 3V4z"/><path d="M8 8h8"/><path d="M8 12h6"/></svg>
      </span>
      <span>
        <strong>Rules</strong>
        <small>Open the pinned operating contract.</small>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
defineEmits<{ openRules: [] }>()
</script>
