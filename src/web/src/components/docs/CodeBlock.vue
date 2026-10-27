<template>
  <div class="code-block">
    <div class="code-block-header">
      <span>{{ label }}</span>
      <button type="button" class="copy-btn" @click="copy">{{ copied ? 'Copied!' : 'Copy' }}</button>
    </div>
    <pre><code ref="codeEl"><slot /></code></pre>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ label: string }>()

const codeEl = ref<HTMLElement | null>(null)
const copied = ref(false)

async function copy() {
  if (!codeEl.value) return
  try {
    await navigator.clipboard.writeText(codeEl.value.textContent || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* silent */ }
}
</script>

<style scoped>
.code-block {
  position: relative;
  background: var(--code-bg, var(--bg-subtle));
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 8px;
  margin-bottom: 20px;
  overflow: hidden;
}

.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  background: var(--code-header-bg, var(--bg-elevated));
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  font-size: 0.72rem;
  color: var(--text-secondary, #a1a1aa);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.copy-btn {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-secondary, #a1a1aa);
  font-size: 0.7rem;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
  transition: background-color 150ms, color 150ms;
  font-family: inherit;
  min-height: 44px;
}
.copy-btn:hover { background: var(--accent-hover); color: var(--text, #fafafa); }

.code-block pre {
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  line-height: 1.65;
  overflow-x: auto;
  color: var(--code-text, var(--text));
  margin: 0;
}

.code-block code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
