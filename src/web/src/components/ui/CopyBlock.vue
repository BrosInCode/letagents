<template>
  <div class="copy-block">
    <div v-if="label" class="copy-block__label">{{ label }}</div>
    <div class="copy-block__content">
      <pre class="copy-block__code"><code><slot>{{ code }}</slot></code></pre>
      <button
        class="copy-block__btn"
        :disabled="copied"
        @click="copyToClipboard"
        :aria-label="copied ? 'Copied' : 'Copy to clipboard'"
      >
        {{ copied ? '✓ Copied' : 'Copy' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  code?: string
  label?: string
  copyText?: string
}>(), {
  code: '',
  label: '',
  copyText: '',
})

const emit = defineEmits<{
  copied: [text: string]
}>()

const copied = ref(false)

async function copyToClipboard() {
  const text = props.copyText || props.code
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    emit('copied', text)
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    copied.value = true
    emit('copied', text)
    setTimeout(() => { copied.value = false }, 2000)
  }
}
</script>

<style scoped>
.copy-block {
  border-radius: var(--radius-md, 10px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--copy-block-bg, rgba(0, 0, 0, 0.3));
}

.copy-block__label {
  padding: 8px 16px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted, #a1a1aa);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  background: rgba(255, 255, 255, 0.02);
}

.copy-block__content {
  position: relative;
  display: flex;
  align-items: flex-start;
}

.copy-block__code {
  flex: 1;
  margin: 0;
  padding: 14px 16px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--text-primary, #e4e4e7);
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}

.copy-block__code code {
  font-family: inherit;
}

.copy-block__btn {
  flex-shrink: 0;
  margin: 8px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-sm, 6px);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted, #a1a1aa);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 150ms ease;
  user-select: none;
}

.copy-block__btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary, #e4e4e7);
}

.copy-block__btn:disabled {
  color: var(--green-text, #4ade80);
  border-color: rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.1);
}
</style>
