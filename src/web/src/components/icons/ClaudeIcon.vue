<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    :class="cssClass"
    role="img"
    :aria-label="label"
  >
    <!-- Anthropic Claude: simplified starburst/asterisk -->
    <path d="M12 2C12 2 14.5 8.5 17 11c2.5 2.5 5 3 5 3s-4.5.5-7 3c-2.5 2.5-3 6-3 6s-.5-3.5-3-6C6.5 14.5 2 14 2 14s2.5-.5 5-3c2.5-2.5 5-9 5-9z"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
  cssClass?: string
}>(), {
  size: 24,
  label: 'Claude Code',
  cssClass: 'ide-icon',
})
</script>
