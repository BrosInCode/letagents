<template>
  <div class="stale-prompt-actions">
    <button
      class="stale-prompt-toggle"
      type="button"
      @click="emit('toggle')"
    >
      {{ muted ? 'Unmute reminders' : 'Mute reminders' }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  muted: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<style scoped>
.stale-prompt-actions {
  margin-top: 10px;
}
.stale-prompt-toggle {
  border: 1px solid color-mix(in srgb, var(--sender-color, #71717a) 24%, var(--line, #27272a));
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface, #18181b) 92%, transparent);
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 5px 10px;
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.stale-prompt-toggle:hover,
.stale-prompt-toggle:focus-visible {
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 48%, var(--line-strong, #3f3f46));
  color: var(--text, #fafafa);
  background: color-mix(in srgb, var(--surface, #18181b) 86%, var(--sender-color, #71717a) 14%);
  outline: none;
}
</style>
