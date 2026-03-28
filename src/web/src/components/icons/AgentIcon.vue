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
    <circle cx="12" cy="12" r="10"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
  cssClass?: string
}>(), {
  size: 24,
  label: 'Agent',
  cssClass: 'ide-icon',
})
</script>
