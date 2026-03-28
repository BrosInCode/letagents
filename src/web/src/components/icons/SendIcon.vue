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
    <path d="M22 2L11 13"/>
    <path d="M22 2L15 22L11 13L2 9L22 2Z"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
}>(), {
  size: 24,
  label: 'Send',
})
</script>
