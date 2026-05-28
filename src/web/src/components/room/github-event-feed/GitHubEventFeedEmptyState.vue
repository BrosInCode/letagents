<template>
  <div class="event-feed-empty">
    <div class="event-feed-empty-card" :class="variant">
      <h4>{{ title }}</h4>
      <p><slot /></p>
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  variant?: 'error' | 'waiting'
}>(), {
  variant: undefined,
})
</script>

<style scoped>
.event-feed-empty {
  display: grid;
  place-items: center;
  min-height: 320px;
  padding: 24px 0;
}

.event-feed-empty-card {
  max-width: 420px;
  padding: 26px 24px;
  border-radius: 18px;
  border: 1px dashed var(--border-strong, rgba(255, 255, 255, 0.12));
  background: var(--bg-card, #141414);
  text-align: center;
}

.event-feed-empty-card.waiting {
  border-style: solid;
  border-color: var(--blue-dim, rgba(59, 130, 246, 0.1));
}

.event-feed-empty-card.error {
  border-style: solid;
  border-color: var(--red-dim, rgba(239, 68, 68, 0.1));
  background: var(--red-dim, rgba(239, 68, 68, 0.1));
}

.event-feed-empty-card h4 {
  margin: 0 0 8px;
  color: var(--text, #fafafa);
  font-size: 0.98rem;
  font-weight: 700;
}

.event-feed-empty-card p {
  margin: 0;
  color: var(--text-tertiary, #71717a);
  line-height: 1.6;
}
</style>
