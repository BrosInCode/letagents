<template>
  <article :class="{ 'single-line': singleLine }" class="surface-row">
    <slot />
    <div v-if="$slots.meta" class="surface-meta">
      <slot name="meta" />
    </div>
  </article>
</template>

<script setup lang="ts">
defineProps<{
  singleLine?: boolean;
}>();
</script>
