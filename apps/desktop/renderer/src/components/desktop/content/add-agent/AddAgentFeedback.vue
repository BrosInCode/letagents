<template>
  <p
    class="desktop-add-agent-feedback"
    :data-tone="tone"
    :role="tone === 'error' ? 'alert' : 'status'"
    :aria-live="tone === 'error' ? 'assertive' : 'polite'"
    aria-atomic="true"
  >
    <span>{{ message }}</span>
    <button v-if="actionLabel" type="button" @click="emit('action')">{{ actionLabel }}</button>
  </p>
</template>

<script setup lang="ts">
import type { AddAgentFeedbackTone } from "./add-agent-errors";

withDefaults(defineProps<{
  message: string;
  tone?: AddAgentFeedbackTone;
  actionLabel?: string | null;
}>(), { tone: "status", actionLabel: null });
const emit = defineEmits<{ action: [] }>();
</script>

<style scoped>
.desktop-add-agent-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 11px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.035);
}

.desktop-add-agent-feedback[data-tone="error"] {
  border-color: color-mix(in srgb, var(--danger, #ef6666) 34%, transparent);
  background: color-mix(in srgb, var(--danger, #ef6666) 8%, transparent);
  color: color-mix(in srgb, var(--danger, #ef6666) 72%, white);
}

.desktop-add-agent-feedback[data-tone="warning"] {
  border-color: rgba(245, 184, 73, 0.22);
  background: rgba(245, 184, 73, 0.055);
}

.desktop-add-agent-feedback button {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-weight: 750;
}
</style>
