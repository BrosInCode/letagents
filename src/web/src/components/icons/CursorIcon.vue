<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :class="cssClass"
    role="img"
    :aria-label="label"
  >
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
  cssClass?: string
}>(), {
  size: 24,
  label: 'Cursor',
  cssClass: 'ide-icon',
})
</script>
