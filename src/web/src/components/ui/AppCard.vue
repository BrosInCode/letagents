<template>
  <div :class="['card', { 'card--hoverable': hoverable, 'card--bordered': bordered }]">
    <div v-if="$slots.header" class="card__header">
      <slot name="header" />
    </div>
    <div class="card__body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="card__footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  hoverable?: boolean
  bordered?: boolean
}>(), {
  hoverable: false,
  bordered: true,
})
</script>

<style scoped>
.card {
  background: var(--card-bg, var(--bg-elevated));
  border-radius: var(--radius-lg, 16px);
  overflow: hidden;
  transition: border-color 150ms ease-out;
}

.card--bordered {
  border: 1px solid var(--card-border, rgba(255, 255, 255, 0.06));
}

@media (hover: hover) and (pointer: fine) {
  .card--hoverable:hover {
    border-color: var(--border-strong);
  }
}

.card__header {
  padding: 20px 24px 0;
}

.card__body {
  padding: 20px 24px;
}

.card__footer {
  padding: 0 24px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  padding-top: 16px;
}
</style>
