<template>
  <button
    class="thread-marker"
    type="button"
    :aria-label="actionLabel"
    @click="emit('scrollToReply', latestId)"
  >
    <span class="thread-marker-label">{{ label }}</span>
    <span v-if="latestPreview" class="thread-marker-preview">
      {{ latestDisplayName }}: {{ latestPreview }}
    </span>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  latestId: string
  label: string
  latestDisplayName: string
  latestPreview: string
  actionLabel: string
}>()

const emit = defineEmits<{
  scrollToReply: [messageId: string]
}>()
</script>

<style scoped>
.thread-marker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 780px);
  margin-top: 8px;
  margin-left: 14px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--sender-color, #71717a) 26%, var(--line, #27272a));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 72%, transparent);
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.thread-marker::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--sender-color, #71717a);
}

.thread-marker-label {
  flex: 0 0 auto;
  color: var(--text, #fafafa);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0;
  white-space: nowrap;
}

.thread-marker-preview {
  min-width: 0;
  overflow: hidden;
  color: var(--muted, #a1a1aa);
  font-size: 0.74rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-marker:hover,
.thread-marker:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 90%, var(--sender-color, #71717a) 10%);
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 60%, var(--line, #27272a));
  color: var(--text, #fafafa);
  outline: none;
}

@media (max-width: 768px) {
  .thread-marker {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    margin-left: 12px;
    padding: 6px 8px;
  }
  .thread-marker::before { display: none; }
  .thread-marker-preview {
    width: 100%;
  }
}
</style>
