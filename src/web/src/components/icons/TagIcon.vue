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
    role="img"
    :aria-label="label"
  >
    <path d="M20.5 13.5 13.5 20.5a2.1 2.1 0 0 1-3 0L3.5 13.5V4.5h9l8 8a2.1 2.1 0 0 1 0 3Z"/>
    <circle cx="8" cy="8" r="1.5"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
}>(), {
  size: 16,
  label: 'Tag',
})
</script>
