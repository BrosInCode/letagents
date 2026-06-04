<template>
  <article class="settings-control-row" :data-emphasis="emphasis">
    <div class="settings-control-main">
      <div class="settings-control-title-line">
        <p class="settings-control-title">{{ title }}</p>
        <span v-if="badge" class="state-pill" :data-state="badgeState">{{ badge }}</span>
      </div>
      <p v-if="description" class="settings-control-description">{{ description }}</p>
      <slot />
    </div>
    <div v-if="$slots.action" class="settings-control-action">
      <slot name="action" />
    </div>
  </article>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  badge?: string;
  badgeState?: string;
  emphasis?: "normal" | "warning" | "danger";
}>();
</script>
