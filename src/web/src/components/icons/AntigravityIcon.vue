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
    <!-- Google Gemini sparkle icon -->
    <path d="M12 2C12 2 12 8.27 8.14 12 12 15.73 12 22 12 22 12 22 12 15.73 15.86 12 12 8.27 12 2 12 2z"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
  cssClass?: string
}>(), {
  size: 24,
  label: 'Antigravity',
  cssClass: 'ide-icon',
})
</script>
