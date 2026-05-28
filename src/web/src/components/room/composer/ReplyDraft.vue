<template>
  <div class="reply-draft">
    <div class="reply-draft-copy">
      <strong>Replying to {{ displayName }}</strong>
      <span>{{ previewText }}</span>
    </div>
    <button class="reply-draft-clear" type="button" @click="emit('clear')">Cancel</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  displayName: string
  previewText: string
}>()

const emit = defineEmits<{
  clear: []
}>()
</script>

<style scoped>
.reply-draft {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border, #27272a);
  background: color-mix(in srgb, var(--surface, #18181b) 72%, transparent);
}
.reply-draft-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.reply-draft-copy strong {
  font-size: 0.74rem;
  color: var(--text, #fafafa);
}
.reply-draft-copy span {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply-draft-clear {
  border: none;
  background: transparent;
  color: var(--muted, #71717a);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.reply-draft-clear:hover {
  color: var(--text, #fafafa);
}

@media (max-width: 768px) {
  .reply-draft { padding: 8px 10px 6px; }
}
</style>
