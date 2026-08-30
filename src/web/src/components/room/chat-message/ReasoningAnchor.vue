<template>
  <div class="reasoning-anchor">
    <div class="reasoning-anchor-copy">
      <span class="reasoning-anchor-label">Live work</span>
      <strong>{{ title }}</strong>
      <p v-if="summary">{{ summary }}</p>
    </div>
    <button class="reasoning-anchor-button" type="button" @click="emit('open')">
      Open work log
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  summary?: string | null
}>()

const emit = defineEmits<{
  open: []
}>()
</script>

<style scoped>
.reasoning-anchor {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(96, 165, 250, 0.22);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03));
}

.reasoning-anchor-copy {
  min-width: 0;
}

.reasoning-anchor-copy strong {
  display: block;
  margin: 0 0 4px;
  color: var(--text, #fafafa);
  font-size: 0.88rem;
  line-height: 1.35;
}

.reasoning-anchor-copy p {
  margin: 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.76rem;
  line-height: 1.45;
}

.reasoning-anchor-label {
  display: inline-flex;
  margin-bottom: 6px;
  color: #93c5fd;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.reasoning-anchor-button {
  flex-shrink: 0;
  border: 1px solid rgba(147, 197, 253, 0.28);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.7);
  color: #dbeafe;
  cursor: pointer;
  font: inherit;
  font-size: 0.74rem;
  font-weight: 700;
  line-height: 1;
  padding: 10px 12px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.reasoning-anchor-button:hover,
.reasoning-anchor-button:focus-visible {
  background: rgba(30, 41, 59, 0.92);
  border-color: rgba(191, 219, 254, 0.42);
  outline: none;
}

@media (max-width: 768px) {
  .reasoning-anchor {
    flex-direction: column;
  }
  .reasoning-anchor-button {
    width: 100%;
  }
}
</style>
