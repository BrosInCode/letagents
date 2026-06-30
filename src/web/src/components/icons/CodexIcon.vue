<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :class="cssClass"
    role="img"
    :aria-label="label"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.8"
  >
    <path d="M7.2 18.4a4.3 4.3 0 0 1-.52-8.56 5.8 5.8 0 0 1 10.65-2.05 4.86 4.86 0 0 1 1.18 9.5 3.2 3.2 0 0 1-2.63 1.11z"/>
    <path d="m8.55 9.6 2.45 2.55-2.45 2.55"/>
    <path d="M13.35 14.7h3.35"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
  cssClass?: string
}>(), {
  size: 24,
  label: 'Codex',
  cssClass: 'ide-icon',
})
</script>
