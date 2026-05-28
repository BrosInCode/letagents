<template>
  <button
    class="reply-preview"
    type="button"
    @click="emit('scrollToReply', messageId)"
  >
    <span class="reply-preview-label">Replying to {{ displayName }}</span>
    <span class="reply-preview-text">{{ previewText }}</span>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  messageId: string
  displayName: string
  previewText: string
}>()

const emit = defineEmits<{
  scrollToReply: [messageId: string]
}>()
</script>

<style scoped>
.reply-preview {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-left: 2px solid color-mix(in srgb, var(--sender-color, #71717a) 50%, transparent);
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  border-radius: 0 8px 8px 0;
  width: 100%;
  text-align: left;
  border-top: none;
  border-right: none;
  border-bottom: none;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.reply-preview-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text, #fafafa);
}

.reply-preview-text {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply-preview:hover,
.reply-preview:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 94%, var(--sender-color, #71717a) 6%);
  border-left-color: var(--sender-color, #71717a);
  outline: none;
}

@media (max-width: 768px) {
  .reply-preview { padding: 6px 8px; margin-bottom: 6px; }
}
</style>
