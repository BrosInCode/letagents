<template>
  <article class="surface-intro">
    <div>
      <p v-if="kicker" class="sidebar-label">{{ kicker }}</p>
      <h3>{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="surface-intro-actions">
      <slot name="actions" />
    </div>
  </article>
</template>

<script setup lang="ts">
defineProps<{
  description?: string;
  kicker?: string;
  title: string;
}>();
</script>
