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
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/>
    <circle cx="9" cy="13" r="1.6"/>
    <circle cx="15" cy="10.5" r="1.6"/>
    <circle cx="15" cy="15.5" r="1.6"/>
    <path d="M10.5 12.4 13.6 11"/>
    <path d="M10.5 13.7 13.6 15"/>
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
}>(), {
  size: 16,
  label: 'Repository',
})
</script>
