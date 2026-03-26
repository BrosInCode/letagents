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
    <!-- Cursor's custom cursor pointer shape -->
    <path d="M5.5 3.21V20.8c0 .45.54.67.86.35l4.86-4.86h5.47c.43 0 .65-.52.35-.86L6.36 2.85a.5.5 0 0 0-.86.36z"/>
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
