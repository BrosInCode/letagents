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
  background: var(--card-bg, rgba(255, 255, 255, 0.03));
  border-radius: var(--radius-lg, 16px);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow: hidden;
  transition: all 300ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
}

.card--bordered {
  border: 1px solid var(--card-border, rgba(255, 255, 255, 0.06));
}

.card--hoverable:hover {
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.2));
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
